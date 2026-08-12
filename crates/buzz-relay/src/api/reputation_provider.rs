//! Backend-neutral reputation-provider boundary.
//!
//! The first configured provider is the existing OriginTrail DKG query
//! gateway.  The null provider is the default and reports `disabled` instead
//! of manufacturing an empty evidence set.  Provider metadata is added to the
//! existing gateway envelope without changing its `result`, so current DKG
//! clients remain compatible while reputation callers gain explicit
//! resolution semantics.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use async_trait::async_trait;
use axum::{http::StatusCode, response::Json};
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use buzz_core::{CommunityId, StoredEvent};
use buzz_db::{Db, EventQuery};

use crate::config::{DkgQueryConfig, ReputationProviderKind};

use super::{api_error, dkg_query};

type ApiResponse = (StatusCode, Json<Value>);
type ApiResult = Result<ApiResponse, ApiResponse>;

/// Outcome of one bounded reputation-provider resolution attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionState {
    /// No provider is configured. This is not an empty evidence result.
    Disabled,
    /// Every configured source answered within the bounded request.
    Complete,
    /// At least one configured source could not provide a complete page.
    Partial,
    /// The provider could not perform the resolution attempt.
    Unavailable,
}

/// Per-source status carried with every provider result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDiagnostic {
    /// Stable identifier for the contributing source.
    pub source_id: String,
    /// Resolution reached by this source.
    pub resolution: ResolutionState,
    /// Safe, human-readable reason for a non-complete result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Backend-neutral result returned by [`ReputationProvider`].
#[derive(Debug)]
pub struct ReputationBatch {
    /// Aggregate resolution for this request.
    pub resolution: ResolutionState,
    /// Stable provider identifier.
    pub provider_id: &'static str,
    /// Provider contract version.
    pub provider_version: &'static str,
    /// Time at which the resolution was produced.
    pub as_of: DateTime<Utc>,
    /// Per-source outcomes used to produce the aggregate resolution.
    pub source_diagnostics: Vec<SourceDiagnostic>,
    response: Option<ApiResponse>,
}

impl ReputationBatch {
    fn disabled() -> Self {
        Self {
            resolution: ResolutionState::Disabled,
            provider_id: "null",
            provider_version: "1",
            as_of: Utc::now(),
            source_diagnostics: Vec::new(),
            response: None,
        }
    }

    fn dkg(resolution: ResolutionState, response: ApiResponse, detail: Option<String>) -> Self {
        Self {
            resolution,
            provider_id: "origintrail-dkg",
            provider_version: "dkg-trust@1",
            as_of: Utc::now(),
            source_diagnostics: vec![SourceDiagnostic {
                source_id: "origintrail-dkg".to_string(),
                resolution,
                detail,
            }],
            response: Some(response),
        }
    }

    fn local(
        resolution: ResolutionState,
        response: ApiResponse,
        source_diagnostics: Vec<SourceDiagnostic>,
    ) -> Self {
        Self {
            resolution,
            provider_id: "buzz-relay-local",
            provider_version: "buzz-trust-claim@1",
            as_of: Utc::now(),
            source_diagnostics,
            response: Some(response),
        }
    }

    fn metadata(&self) -> Map<String, Value> {
        let mut metadata = Map::new();
        metadata.insert(
            "resolution".to_string(),
            serde_json::to_value(self.resolution).expect("resolution serializes"),
        );
        metadata.insert(
            "providerId".to_string(),
            Value::String(self.provider_id.to_string()),
        );
        metadata.insert(
            "providerVersion".to_string(),
            Value::String(self.provider_version.to_string()),
        );
        metadata.insert("asOf".to_string(), Value::String(self.as_of.to_rfc3339()));
        metadata.insert(
            "sourceDiagnostics".to_string(),
            serde_json::to_value(&self.source_diagnostics).expect("diagnostics serialize"),
        );
        metadata
    }

    /// Convert the provider result back to the relay's existing HTTP shape.
    ///
    /// Successful DKG responses retain `ok`, `channelId`, `cg`, `operation`,
    /// and `result`. The provider fields are additive. Disabled and unavailable
    /// providers use the same fields on an error response, allowing a new
    /// client to distinguish configuration from outage without changing the
    /// legacy route-discovery behavior.
    pub fn into_http_result(mut self) -> ApiResult {
        let response = self.response.take();
        let metadata = self.metadata();
        let (status, Json(mut value)) = response.unwrap_or_else(|| {
            api_error(
                StatusCode::NOT_FOUND,
                "reputation provider is not configured",
            )
        });
        let Some(object) = value.as_object_mut() else {
            let (status, Json(mut error)) = api_error(
                StatusCode::BAD_GATEWAY,
                "reputation provider returned an invalid response envelope",
            );
            error
                .as_object_mut()
                .expect("api errors are objects")
                .extend(metadata);
            return Err((status, Json(error)));
        };
        object.extend(metadata);

        let response = (status, Json(value));
        if status.is_success() && self.resolution != ResolutionState::Unavailable {
            Ok(response)
        } else {
            Err(response)
        }
    }
}

/// Minimal provider seam for evidence-backed reputation resolution.
#[async_trait]
pub trait ReputationProvider: Send + Sync {
    /// Resolve the bounded attestation request without changing its scope.
    async fn attestations(&self, request: &Value) -> ReputationBatch;
}

/// Default provider: reputation is disabled, not empty.
#[derive(Debug, Default)]
pub struct NullProvider;

#[async_trait]
impl ReputationProvider for NullProvider {
    async fn attestations(&self, _request: &Value) -> ReputationBatch {
        ReputationBatch::disabled()
    }
}

const LOCAL_QUERY_DEADLINE: Duration = Duration::from_secs(2);
const LOCAL_EVENT_LIMIT: i64 = 500;
const LOCAL_SOURCE_LIMIT: usize = 32;
const DEFAULT_CLAIM_LIMIT: usize = 100;
const MAX_CLAIM_LIMIT: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRequest {
    operation: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustQueryArguments {
    limit: Option<u16>,
    cursor: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SelectedSource {
    result_tag: String,
    pubkey: String,
    relay: Option<String>,
}

#[derive(Debug)]
struct NormalizedClaim {
    created_at: u64,
    event_id: String,
    issuer: String,
    subject: String,
    claim_type: &'static str,
    value: Value,
}

#[derive(Debug)]
struct LocalTrustResult {
    response: ApiResponse,
    resolution: ResolutionState,
    diagnostics: Vec<SourceDiagnostic>,
}

/// Provider that resolves signed trust evidence from the current community's
/// bounded relay-local event store. It never opens arbitrary relay URLs from a
/// kind:10040 event; an external hint is reported as partial unless the
/// selected assertion has already been replicated into this relay.
#[derive(Debug)]
pub struct LocalProvider<'a> {
    db: &'a Db,
    community: CommunityId,
    channel_id: Uuid,
    requester_pubkey: Vec<u8>,
    relay_url: &'a str,
}

impl<'a> LocalProvider<'a> {
    fn new(
        db: &'a Db,
        community: CommunityId,
        channel_id: Uuid,
        requester_pubkey: Vec<u8>,
        relay_url: &'a str,
    ) -> Self {
        Self {
            db,
            community,
            channel_id,
            requester_pubkey,
            relay_url,
        }
    }

    async fn resolve(&self, request: &Value) -> LocalTrustResult {
        let request = match serde_json::from_value::<LocalRequest>(request.clone()) {
            Ok(request) => request,
            Err(_) => return self.invalid_request("invalid local reputation request"),
        };
        if request.operation != "trust_network" {
            return LocalTrustResult {
                response: api_error(
                    StatusCode::NOT_IMPLEMENTED,
                    "the relay-local provider exposes signed trust evidence but does not compute reputation scores",
                ),
                resolution: ResolutionState::Unavailable,
                diagnostics: vec![SourceDiagnostic {
                    source_id: "relay-local".to_string(),
                    resolution: ResolutionState::Unavailable,
                    detail: Some("operation is not implemented by this provider".to_string()),
                }],
            };
        }
        let arguments = match serde_json::from_value::<TrustQueryArguments>(request.arguments) {
            Ok(arguments) => arguments,
            Err(_) => return self.invalid_request("invalid trust query arguments"),
        };
        if let Err(message) = validate_trust_arguments(&arguments) {
            return self.invalid_request(&message);
        }
        match tokio::time::timeout(LOCAL_QUERY_DEADLINE, self.trust_network(arguments)).await {
            Ok(Ok(result)) => result,
            Ok(Err(detail)) => LocalTrustResult {
                response: api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "relay-local reputation evidence is unavailable",
                ),
                resolution: ResolutionState::Unavailable,
                diagnostics: vec![SourceDiagnostic {
                    source_id: "relay-local".to_string(),
                    resolution: ResolutionState::Unavailable,
                    detail: Some(detail),
                }],
            },
            Err(_) => LocalTrustResult {
                response: api_error(
                    StatusCode::GATEWAY_TIMEOUT,
                    "relay-local reputation query exceeded its deadline",
                ),
                resolution: ResolutionState::Unavailable,
                diagnostics: vec![SourceDiagnostic {
                    source_id: "relay-local".to_string(),
                    resolution: ResolutionState::Unavailable,
                    detail: Some("provider deadline exceeded".to_string()),
                }],
            },
        }
    }

    fn invalid_request(&self, message: &str) -> LocalTrustResult {
        LocalTrustResult {
            response: api_error(StatusCode::BAD_REQUEST, message),
            resolution: ResolutionState::Unavailable,
            diagnostics: vec![SourceDiagnostic {
                source_id: "relay-local".to_string(),
                resolution: ResolutionState::Unavailable,
                detail: Some("request contract validation failed".to_string()),
            }],
        }
    }

    async fn trust_network(
        &self,
        arguments: TrustQueryArguments,
    ) -> Result<LocalTrustResult, String> {
        let limit = usize::from(arguments.limit.unwrap_or(DEFAULT_CLAIM_LIMIT as u16))
            .clamp(1, MAX_CLAIM_LIMIT);
        let since = parse_timestamp(arguments.since, "since")?;
        let until = parse_timestamp(arguments.until, "until")?;
        if since.zip(until).is_some_and(|(since, until)| since > until) {
            return Err("since must not be later than until".to_string());
        }
        let cursor = arguments.cursor.as_deref().map(parse_cursor).transpose()?;

        let mut vouch_query = EventQuery::for_community(self.community);
        vouch_query.channel_id = Some(self.channel_id);
        vouch_query.kinds = Some(vec![1985]);
        vouch_query.since = since;
        vouch_query.until = until;
        vouch_query.limit = Some(LOCAL_EVENT_LIMIT + 1);

        let mut preference_query = EventQuery::for_community(self.community);
        preference_query.global_only = true;
        preference_query.kinds = Some(vec![10040]);
        preference_query.pubkey = Some(self.requester_pubkey.clone());
        preference_query.limit = Some(1);

        let (mut vouch_events, preference_events) = tokio::try_join!(
            self.db.query_events(&vouch_query),
            self.db.query_events(&preference_query)
        )
        .map_err(|_| "relay event-store read failed".to_string())?;

        let preference = preference_events.first();
        let (selected_sources, truncated_sources) = preference
            .map(|event| selected_sources(&event.event))
            .unwrap_or_default();
        let selected_authors = selected_sources
            .iter()
            .filter_map(|source| hex::decode(&source.pubkey).ok())
            .filter(|pubkey| pubkey.len() == 32)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        let vouch_window_truncated = vouch_events.len() > LOCAL_EVENT_LIMIT as usize;
        vouch_events.truncate(LOCAL_EVENT_LIMIT as usize);

        let mut assertion_events = if selected_authors.is_empty() {
            Vec::new()
        } else {
            let mut assertion_query = EventQuery::for_community(self.community);
            assertion_query.global_only = true;
            assertion_query.kinds = Some(vec![30382]);
            assertion_query.authors = Some(selected_authors);
            assertion_query.since = since;
            assertion_query.until = until;
            assertion_query.limit = Some(LOCAL_EVENT_LIMIT + 1);
            self.db
                .query_events(&assertion_query)
                .await
                .map_err(|_| "trusted-assertion read failed".to_string())?
        };

        let assertion_window_truncated = assertion_events.len() > LOCAL_EVENT_LIMIT as usize;
        assertion_events.truncate(LOCAL_EVENT_LIMIT as usize);
        let event_window_truncated = vouch_window_truncated || assertion_window_truncated;

        let mut claims = normalize_vouch_claims(&vouch_events, self.community, self.channel_id);
        let (assertion_claims, matched_sources) =
            normalize_assertion_claims(&assertion_events, &selected_sources, self.community);
        claims.extend(assertion_claims);
        claims.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        if let Some((cursor_time, cursor_id)) = cursor {
            claims.retain(|claim| {
                claim.created_at < cursor_time
                    || (claim.created_at == cursor_time && claim.event_id > cursor_id)
            });
        }
        let has_next_page = claims.len() > limit;
        claims.truncate(limit);
        let next_cursor = has_next_page
            .then(|| {
                claims
                    .last()
                    .map(|claim| format_cursor(claim.created_at, &claim.event_id))
            })
            .flatten();

        let encrypted_preferences =
            preference.is_some_and(|event| !event.event.content.trim().is_empty());
        let unresolved_external = selected_sources.iter().any(|source| {
            source
                .relay
                .as_deref()
                .is_some_and(|relay| !same_relay(relay, self.relay_url))
                && !matched_sources.contains(&(source.pubkey.clone(), source.result_tag.clone()))
        });
        let partial = truncated_sources
            || encrypted_preferences
            || unresolved_external
            || event_window_truncated;
        let resolution = if partial {
            ResolutionState::Partial
        } else {
            ResolutionState::Complete
        };
        let mut diagnostics = vec![SourceDiagnostic {
            source_id: "relay-local".to_string(),
            resolution: ResolutionState::Complete,
            detail: None,
        }];
        if encrypted_preferences {
            diagnostics.push(SourceDiagnostic {
                source_id: "nip85-private-sources".to_string(),
                resolution: ResolutionState::Partial,
                detail: Some(
                    "encrypted kind 10040 source selections cannot be decrypted by the relay"
                        .to_string(),
                ),
            });
        }
        if truncated_sources {
            diagnostics.push(SourceDiagnostic {
                source_id: "nip85-public-sources".to_string(),
                resolution: ResolutionState::Partial,
                detail: Some(format!(
                    "source selection exceeds the bounded limit of {LOCAL_SOURCE_LIMIT}"
                )),
            });
        }
        if unresolved_external {
            diagnostics.push(SourceDiagnostic {
                source_id: "nip85-external-relays".to_string(),
                resolution: ResolutionState::Partial,
                detail: Some(
                    "one or more selected assertions are not replicated locally; external relays were not contacted"
                        .to_string(),
                ),
            });
        }
        if event_window_truncated {
            diagnostics.push(SourceDiagnostic {
                source_id: "relay-local-window".to_string(),
                resolution: ResolutionState::Partial,
                detail: Some(format!(
                    "matching event history exceeds the bounded {LOCAL_EVENT_LIMIT}-event provider window"
                )),
            });
        }

        let people = people_from_claims(&claims);
        let vouches = vouches_from_claims(&claims);
        let values = claims
            .into_iter()
            .map(|claim| claim.value)
            .collect::<Vec<_>>();
        let response = bounded_local_response(json!({
            "ok": true,
            "channelId": self.channel_id,
            "cg": format!("urn:buzz:relay-reputation:{}:{}", self.community, self.channel_id),
            "operation": "trust_network",
            "result": {
                "completeness": if partial { "partial" } else { "complete" },
                "people": people,
                "vouches": vouches,
                "claims": values,
                "nextCursor": next_cursor,
            }
        }))?;
        Ok(LocalTrustResult {
            response,
            resolution,
            diagnostics,
        })
    }
}

#[async_trait]
impl ReputationProvider for LocalProvider<'_> {
    async fn attestations(&self, request: &Value) -> ReputationBatch {
        let result = self.resolve(request).await;
        ReputationBatch::local(result.resolution, result.response, result.diagnostics)
    }
}

fn parse_timestamp(raw: Option<i64>, field: &str) -> Result<Option<DateTime<Utc>>, String> {
    raw.map(|timestamp| {
        Utc.timestamp_opt(timestamp, 0)
            .single()
            .ok_or_else(|| format!("{field} is outside the supported Unix timestamp range"))
    })
    .transpose()
}

fn validate_trust_arguments(arguments: &TrustQueryArguments) -> Result<(), String> {
    let since = parse_timestamp(arguments.since, "since")?;
    let until = parse_timestamp(arguments.until, "until")?;
    if since.zip(until).is_some_and(|(since, until)| since > until) {
        return Err("since must not be later than until".to_string());
    }
    if let Some(cursor) = arguments.cursor.as_deref() {
        parse_cursor(cursor)?;
    }
    Ok(())
}

fn parse_cursor(raw: &str) -> Result<(u64, String), String> {
    let (timestamp, event_id) = raw
        .split_once(':')
        .ok_or_else(|| "cursor must be <unix-seconds>:<event-id>".to_string())?;
    let timestamp = timestamp
        .parse::<u64>()
        .map_err(|_| "cursor timestamp is invalid".to_string())?;
    if event_id.len() != 64 || !event_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("cursor event id is invalid".to_string());
    }
    Ok((timestamp, event_id.to_ascii_lowercase()))
}

fn format_cursor(timestamp: u64, event_id: &str) -> String {
    format!("{timestamp}:{event_id}")
}

fn selected_sources(event: &nostr::Event) -> (Vec<SelectedSource>, bool) {
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    let mut truncated = false;
    for tag in event.tags.iter() {
        let parts = tag.as_slice();
        if parts.len() < 2
            || !parts[0].starts_with("30382:")
            || parts[1].len() != 64
            || !parts[1].bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            continue;
        }
        let result_tag = parts[0]["30382:".len()..].to_string();
        if result_tag.is_empty() {
            continue;
        }
        let source = SelectedSource {
            result_tag,
            pubkey: parts[1].to_ascii_lowercase(),
            relay: parts
                .get(2)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        };
        if !seen.insert(source.clone()) {
            continue;
        }
        if sources.len() == LOCAL_SOURCE_LIMIT {
            truncated = true;
            continue;
        }
        sources.push(source);
    }
    (sources, truncated)
}

fn same_relay(left: &str, right: &str) -> bool {
    fn key(raw: &str) -> Option<(String, String, Option<u16>, String)> {
        let url = url::Url::parse(raw).ok()?;
        let transport = match url.scheme() {
            "ws" | "http" => "plain",
            "wss" | "https" => "tls",
            _ => return None,
        };
        Some((
            transport.to_string(),
            url.host_str()?.to_ascii_lowercase(),
            url.port_or_known_default(),
            url.path().trim_end_matches('/').to_string(),
        ))
    }
    key(left)
        .zip(key(right))
        .is_some_and(|(left, right)| left == right)
}

fn tag_values(event: &nostr::Event, name: &str) -> Vec<Vec<String>> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts.first().map(String::as_str) == Some(name)).then(|| parts.to_vec())
        })
        .collect()
}

fn first_tag_value(event: &nostr::Event, name: &str) -> Option<String> {
    tag_values(event, name)
        .into_iter()
        .find_map(|parts| parts.get(1).cloned())
}

fn label_value(event: &nostr::Event) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 3 && parts[0] == "l" && parts[2] == "buzz.wot").then(|| parts[1].clone())
    })
}

fn source_document(stored: &StoredEvent) -> Value {
    json!({
        "eventId": stored.event.id.to_hex(),
        "kind": stored.event.kind.as_u16(),
        "digest": stored.event.id.to_hex(),
        "author": stored.event.pubkey.to_hex(),
        "signature": stored.event.sig.to_string(),
        "verified": stored.is_verified(),
    })
}

fn bounded_local_response(value: Value) -> Result<ApiResponse, String> {
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| "relay-local reputation response could not be serialized".to_string())?;
    // Reserve headroom for provider metadata that is added by into_http_result.
    let maximum = dkg_query::MAX_RESPONSE_BYTES.saturating_sub(16 * 1024);
    if bytes.len() > maximum {
        return Err(format!(
            "relay-local reputation response exceeds the bounded {maximum}-byte result limit"
        ));
    }
    Ok((StatusCode::OK, Json(value)))
}

fn normalize_vouch_claims(
    events: &[StoredEvent],
    community: CommunityId,
    channel_id: Uuid,
) -> Vec<NormalizedClaim> {
    let mut base = HashMap::<String, (&StoredEvent, String)>::new();
    for stored in events {
        if label_value(&stored.event).as_deref() != Some("vouch") {
            continue;
        }
        if let Some(subject) = first_tag_value(&stored.event, "p") {
            base.insert(
                stored.event.id.to_hex(),
                (stored, subject.to_ascii_lowercase()),
            );
        }
    }

    let mut lifecycle = HashMap::<String, (&StoredEvent, &'static str, Option<String>)>::new();
    for stored in events {
        let Some((status, action)) = (match label_value(&stored.event).as_deref() {
            Some("revoke") => Some(("revoked", "revoke")),
            Some("supersede") => Some(("superseded", "supersede")),
            _ => None,
        }) else {
            continue;
        };
        let Some(subject) = first_tag_value(&stored.event, "p") else {
            continue;
        };
        let target = stored.event.tags.iter().find_map(|tag| {
            let parts = tag.as_slice();
            (parts.len() >= 4 && parts[0] == "e" && parts[3] == "target")
                .then(|| parts[1].to_ascii_lowercase())
        });
        let Some(target) = target else { continue };
        let Some((target_event, target_subject)) = base.get(&target) else {
            continue;
        };
        if target_event.event.pubkey != stored.event.pubkey
            || target_subject != &subject.to_ascii_lowercase()
        {
            continue;
        }
        let replacement = (action == "supersede")
            .then(|| {
                stored.event.tags.iter().find_map(|tag| {
                    let parts = tag.as_slice();
                    (parts.len() >= 4 && parts[0] == "e" && parts[3] == "replacement")
                        .then(|| parts[1].to_ascii_lowercase())
                })
            })
            .flatten();
        if action == "supersede"
            && !replacement.as_ref().is_some_and(|replacement| {
                base.get(replacement)
                    .is_some_and(|(replacement_event, replacement_subject)| {
                        replacement_event.event.pubkey == stored.event.pubkey
                            && replacement_subject == &subject.to_ascii_lowercase()
                    })
            })
        {
            continue;
        }
        lifecycle
            .entry(target)
            .or_insert((stored, status, replacement));
    }

    let now = Utc::now().timestamp().max(0) as u64;
    base.into_iter()
        .map(|(event_id, (stored, subject))| {
            let created_at = stored.event.created_at.as_secs();
            let expiration = first_tag_value(&stored.event, "expiration")
                .and_then(|value| value.parse::<u64>().ok());
            let lifecycle_event = lifecycle.get(&event_id);
            let status = lifecycle_event
                .map(|(_, status, _)| *status)
                .or_else(|| expiration.filter(|expires| *expires <= now).map(|_| "expired"))
                .unwrap_or("active");
            let issuer = stored.event.pubkey.to_hex();
            let evidence = stored
                .event
                .tags
                .iter()
                .filter_map(|tag| {
                    let parts = tag.as_slice();
                    match parts.first().map(String::as_str) {
                        Some("r") => parts.get(1).map(|value| {
                            json!({"type": "uri", "value": value})
                        }),
                        Some("e") if parts.get(3).map(String::as_str) == Some("evidence") => {
                            parts.get(1).map(|value| {
                                json!({"type": "nostr_event", "value": format!("urn:nostr:event:{value}")})
                            })
                        }
                        _ => None,
                    }
                })
                .collect::<Vec<_>>();
            let lifecycle_value = lifecycle_event.map(|(event, _, replacement)| {
                json!({
                    "eventId": event.event.id.to_hex(),
                    "source": source_document(event),
                    "replacementClaim": replacement,
                })
            });
            let value = json!({
                "schemaVersion": "buzz-trust-claim@1",
                "claimId": event_id,
                "subject": subject,
                "issuer": issuer,
                "claimType": "vouch",
                "claimLayer": "observation",
                "scope": {
                    "community": community.to_string(),
                    "channel": channel_id,
                    "visibility": "channel",
                },
                "source": source_document(stored),
                "createdAt": created_at,
                "expiresAt": expiration,
                "status": status,
                "derivedFrom": evidence,
                "lifecycle": lifecycle_value,
                "note": stored.event.content,
            });
            NormalizedClaim {
                created_at,
                event_id: stored.event.id.to_hex(),
                issuer: stored.event.pubkey.to_hex(),
                subject,
                claim_type: "vouch",
                value,
            }
        })
        .collect()
}

fn normalize_assertion_claims(
    events: &[StoredEvent],
    selected: &[SelectedSource],
    community: CommunityId,
) -> (Vec<NormalizedClaim>, HashSet<(String, String)>) {
    let selection = selected
        .iter()
        .map(|source| ((source.pubkey.clone(), source.result_tag.clone()), source))
        .collect::<HashMap<_, _>>();
    let mut matched = HashSet::new();
    let mut claims = Vec::new();
    for stored in events {
        let issuer = stored.event.pubkey.to_hex();
        let Some(subject) = first_tag_value(&stored.event, "d") else {
            continue;
        };
        let mut assertions = BTreeMap::<String, Vec<String>>::new();
        for tag in stored.event.tags.iter() {
            let parts = tag.as_slice();
            let Some(name) = parts.first() else { continue };
            if !selection.contains_key(&(issuer.clone(), name.clone())) {
                continue;
            }
            let values = parts.iter().skip(1).cloned().collect::<Vec<_>>();
            if values.is_empty() {
                continue;
            }
            matched.insert((issuer.clone(), name.clone()));
            assertions.insert(name.clone(), values);
        }
        if assertions.is_empty() {
            continue;
        }
        let created_at = stored.event.created_at.as_secs();
        let expiration = first_tag_value(&stored.event, "expiration")
            .and_then(|value| value.parse::<u64>().ok());
        let status = if expiration.is_some_and(|expires| expires <= Utc::now().timestamp() as u64) {
            "expired"
        } else {
            "active"
        };
        let value = json!({
            "schemaVersion": "buzz-trust-claim@1",
            "claimId": stored.event.id.to_hex(),
            "subject": subject,
            "issuer": issuer,
            "claimType": "nip85_user_assertion",
            "claimLayer": "derived_analysis",
            "scope": {
                "community": community.to_string(),
                "visibility": "community",
            },
            "source": source_document(stored),
            "createdAt": created_at,
            "expiresAt": expiration,
            "status": status,
            "derivedFrom": [],
            "assertions": assertions,
        });
        claims.push(NormalizedClaim {
            created_at,
            event_id: stored.event.id.to_hex(),
            issuer: stored.event.pubkey.to_hex(),
            subject: subject.to_ascii_lowercase(),
            claim_type: "nip85_user_assertion",
            value,
        });
    }
    (claims, matched)
}

fn people_from_claims(claims: &[NormalizedClaim]) -> Vec<Value> {
    #[derive(Default)]
    struct Person {
        latest: u64,
        received: usize,
        given: usize,
    }
    let mut people = BTreeMap::<String, Person>::new();
    for claim in claims {
        people.entry(claim.subject.clone()).or_default().latest = people
            .get(&claim.subject)
            .map_or(claim.created_at, |person| {
                person.latest.max(claim.created_at)
            });
        if claim.claim_type == "vouch" && claim.value["status"] == "active" {
            people.entry(claim.subject.clone()).or_default().received += 1;
            people.entry(claim.issuer.clone()).or_default().given += 1;
            people.entry(claim.issuer.clone()).or_default().latest = people
                .get(&claim.issuer)
                .map_or(claim.created_at, |person| {
                    person.latest.max(claim.created_at)
                });
        }
    }
    people
        .into_iter()
        .map(|(pubkey, person)| {
            json!({
                "pubkey": pubkey,
                "contributions": 0,
                "latest": person.latest,
                "vouchesReceived": person.received,
                "vouchesGiven": person.given,
                "layer": "SWM",
            })
        })
        .collect()
}

fn vouches_from_claims(claims: &[NormalizedClaim]) -> Vec<Value> {
    claims
        .iter()
        .filter(|claim| claim.claim_type == "vouch")
        .map(|claim| {
            let lifecycle = claim
                .value
                .get("lifecycle")
                .filter(|value| !value.is_null());
            let evidence = claim.value["derivedFrom"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item.get("value").cloned())
                .collect::<Vec<_>>();
            json!({
                "uri": format!("urn:buzz-dkg:vouch:{}", claim.event_id),
                "issuer": claim.issuer,
                "subject": claim.subject,
                "note": claim.value["note"],
                "status": claim.value["status"],
                "at": claim.created_at,
                "sourceEvent": format!("urn:nostr:event:{}", claim.event_id),
                "evidence": evidence,
                "lifecycleEvent": lifecycle.and_then(|value| value.get("eventId")),
                "replacementVouch": lifecycle.and_then(|value| value.get("replacementClaim")),
                "layer": "SWM",
            })
        })
        .collect()
}

/// Adapter for the existing bounded OriginTrail DKG trust operations.
#[derive(Debug)]
pub struct DkgProvider<'a> {
    config: &'a DkgQueryConfig,
}

impl<'a> DkgProvider<'a> {
    fn new(config: &'a DkgQueryConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl ReputationProvider for DkgProvider<'_> {
    async fn attestations(&self, request: &Value) -> ReputationBatch {
        let client = match dkg_query::HTTP_CLIENT.as_ref() {
            Ok(client) => client,
            Err(_) => {
                return ReputationBatch::dkg(
                    ResolutionState::Unavailable,
                    api_error(
                        StatusCode::BAD_GATEWAY,
                        "reputation provider is unavailable",
                    ),
                    Some("HTTP client initialization failed".to_string()),
                );
            }
        };
        let response = match client
            .post(self.config.url.clone())
            .bearer_auth(&self.config.bearer_token)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(self.config.timeout)
            .json(request)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let detail = if error.is_timeout() {
                    "provider deadline exceeded"
                } else {
                    "provider transport failed"
                };
                return ReputationBatch::dkg(
                    ResolutionState::Unavailable,
                    dkg_query::upstream_error(error),
                    Some(detail.to_string()),
                );
            }
        };

        match dkg_query::bounded_json_response(response).await {
            Ok((status, Json(value))) if status.is_success() => {
                match validate_gateway_success(request, &value) {
                    Ok(resolution) => ReputationBatch::dkg(resolution, (status, Json(value)), None),
                    Err(detail) => ReputationBatch::dkg(
                        ResolutionState::Unavailable,
                        api_error(
                            StatusCode::BAD_GATEWAY,
                            "reputation provider returned an invalid success envelope",
                        ),
                        Some(detail.to_string()),
                    ),
                }
            }
            Ok(response) => ReputationBatch::dkg(
                ResolutionState::Unavailable,
                response,
                Some("provider rejected the bounded request".to_string()),
            ),
            Err(response) => ReputationBatch::dkg(
                ResolutionState::Unavailable,
                response,
                Some("provider returned an unusable response".to_string()),
            ),
        }
    }
}

fn validate_gateway_success(
    request: &Value,
    response: &Value,
) -> Result<ResolutionState, &'static str> {
    let expected_channel = request
        .get("channelId")
        .and_then(Value::as_str)
        .ok_or("provider request channel is invalid")?;
    let expected_operation = request
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("provider request operation is invalid")?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("provider success envelope did not assert ok=true");
    }
    if response.get("channelId").and_then(Value::as_str) != Some(expected_channel) {
        return Err("provider response channel did not match the authorized request");
    }
    if response.get("operation").and_then(Value::as_str) != Some(expected_operation) {
        return Err("provider response operation did not match the authorized request");
    }
    if response
        .get("cg")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err("provider response omitted the resolved Context Graph");
    }
    let result = response
        .get("result")
        .and_then(Value::as_object)
        .ok_or("provider response result was not an object")?;
    match expected_operation {
        "trust_network"
            if result.get("people").is_some_and(Value::is_array)
                && result.get("vouches").is_some_and(Value::is_array) => {}
        "reputation_summary"
            if result.get("subject").is_some_and(Value::is_string)
                && result.get("perspective").is_some_and(Value::is_string)
                && result.get("score").is_some_and(Value::is_number)
                && result.get("breakdown").is_some_and(Value::is_object)
                && result.get("signals").is_some_and(Value::is_object)
                && result.get("evidence").is_some_and(Value::is_array) => {}
        "trust_network" | "reputation_summary" => {
            return Err("provider response result did not match the requested operation");
        }
        _ => return Err("unsupported operation reached the reputation provider"),
    }
    Ok(resolution_from_gateway(response))
}

/// Runtime provider selection. The null provider is the deterministic default.
#[derive(Debug)]
pub enum ConfiguredReputationProvider<'a> {
    /// Deterministic default when reputation is not configured.
    Null(NullProvider),
    /// Signed NIP-32/NIP-85 evidence resolved from this relay.
    Local(LocalProvider<'a>),
    /// Existing OriginTrail DKG trust-query adapter.
    Dkg(DkgProvider<'a>),
}

impl<'a> ConfiguredReputationProvider<'a> {
    /// Select the configured provider without allowing request input to choose
    /// a backend or tenant scope.
    pub fn from_config(
        kind: ReputationProviderKind,
        dkg_config: Option<&'a DkgQueryConfig>,
        db: &'a Db,
        community: CommunityId,
        channel_id: Uuid,
        requester_pubkey: Vec<u8>,
        relay_url: &'a str,
    ) -> Self {
        match kind {
            ReputationProviderKind::Local => Self::Local(LocalProvider::new(
                db,
                community,
                channel_id,
                requester_pubkey,
                relay_url,
            )),
            ReputationProviderKind::Dkg => match dkg_config.filter(|config| config.trust_enabled) {
                Some(config) => Self::Dkg(DkgProvider::new(config)),
                None => Self::Null(NullProvider),
            },
            ReputationProviderKind::Disabled => Self::Null(NullProvider),
        }
    }

    #[cfg(test)]
    fn disabled() -> Self {
        Self::Null(NullProvider)
    }
}

#[async_trait]
impl ReputationProvider for ConfiguredReputationProvider<'_> {
    async fn attestations(&self, request: &Value) -> ReputationBatch {
        match self {
            Self::Null(provider) => provider.attestations(request).await,
            Self::Local(provider) => provider.attestations(request).await,
            Self::Dkg(provider) => provider.attestations(request).await,
        }
    }
}

fn resolution_from_gateway(value: &Value) -> ResolutionState {
    match value
        .pointer("/result/completeness")
        .and_then(Value::as_str)
    {
        Some("partial") => ResolutionState::Partial,
        Some("complete") => ResolutionState::Complete,
        // Absence or an unknown future value cannot safely be promoted to a
        // complete evidence result. Older adapters remain usable, but callers
        // see the conservative partial state.
        _ => ResolutionState::Partial,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn stored_event(
        keys: &Keys,
        kind: u16,
        content: &str,
        tags: Vec<Tag>,
        channel_id: Option<Uuid>,
    ) -> StoredEvent {
        let event = EventBuilder::new(Kind::Custom(kind), content)
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign fixture event");
        StoredEvent::with_received_at(event, Utc::now(), channel_id, true)
    }

    fn tag(parts: &[&str]) -> Tag {
        Tag::parse(parts.iter().copied()).expect("valid fixture tag")
    }

    #[derive(Debug)]
    struct FixtureProvider {
        state: ResolutionState,
    }

    #[async_trait]
    impl ReputationProvider for FixtureProvider {
        async fn attestations(&self, _request: &Value) -> ReputationBatch {
            ReputationBatch {
                resolution: self.state,
                provider_id: "fixture",
                provider_version: "1",
                as_of: Utc::now(),
                source_diagnostics: vec![SourceDiagnostic {
                    source_id: "fixture-source".to_string(),
                    resolution: self.state,
                    detail: None,
                }],
                response: Some(if self.state == ResolutionState::Unavailable {
                    api_error(StatusCode::SERVICE_UNAVAILABLE, "fixture unavailable")
                } else {
                    (
                        StatusCode::OK,
                        Json(json!({
                            "ok": true,
                            "channelId": Uuid::nil(),
                            "cg": "fixture",
                            "operation": "trust_network",
                            "result": {
                                "completeness": if self.state == ResolutionState::Partial {
                                    "partial"
                                } else {
                                    "complete"
                                },
                                "claims": [],
                            }
                        })),
                    )
                }),
            }
        }
    }

    async fn assert_provider_conformance(
        provider: &dyn ReputationProvider,
        expected: ResolutionState,
    ) {
        let batch = provider.attestations(&json!({})).await;
        assert_eq!(batch.resolution, expected);
        assert!(!batch.provider_id.is_empty());
        assert!(!batch.provider_version.is_empty());
        assert!(batch.as_of <= Utc::now());
        if expected == ResolutionState::Disabled {
            assert!(batch.source_diagnostics.is_empty());
        } else {
            assert!(batch
                .source_diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.source_id.is_empty()));
        }
        let response = batch.into_http_result();
        match expected {
            ResolutionState::Complete | ResolutionState::Partial => {
                let (_, Json(value)) = response.expect("resolved provider succeeds");
                assert_eq!(value["resolution"], json!(expected));
            }
            ResolutionState::Disabled | ResolutionState::Unavailable => {
                let (_, Json(value)) = response.expect_err("unresolved provider fails");
                assert_eq!(value["resolution"], json!(expected));
            }
        }
    }

    #[tokio::test]
    async fn null_provider_is_disabled_not_empty_complete() {
        let provider = ConfiguredReputationProvider::disabled();
        let batch = provider.attestations(&serde_json::json!({})).await;
        assert_eq!(batch.resolution, ResolutionState::Disabled);
        assert_eq!(batch.provider_id, "null");
        assert!(batch.source_diagnostics.is_empty());

        let error = batch
            .into_http_result()
            .expect_err("disabled provider is not an evidence response");
        assert_eq!(error.0, StatusCode::NOT_FOUND);
        assert_eq!(error.1 .0["resolution"], "disabled");
        assert_eq!(error.1 .0["providerId"], "null");
    }

    #[tokio::test]
    async fn providers_share_resolution_and_diagnostic_conformance() {
        assert_provider_conformance(&NullProvider, ResolutionState::Disabled).await;
        for state in [
            ResolutionState::Complete,
            ResolutionState::Partial,
            ResolutionState::Unavailable,
        ] {
            assert_provider_conformance(&FixtureProvider { state }, state).await;
        }
    }

    #[test]
    fn nip85_selection_is_exact_per_result_tag_and_bounded() {
        let provider = Keys::generate().public_key().to_hex();
        let event = stored_event(
            &Keys::generate(),
            10040,
            "",
            vec![
                tag(&["30382:rank", &provider, "wss://relay.example"]),
                tag(&["30382:rank", &provider, "wss://relay.example"]),
                tag(&["30382:followers", &provider]),
                tag(&["30383:rank", &provider]),
            ],
            None,
        );
        let (sources, truncated) = selected_sources(&event.event);
        assert!(!truncated);
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().any(|source| source.result_tag == "rank"));
        assert!(sources
            .iter()
            .any(|source| source.result_tag == "followers"));
    }

    #[test]
    fn local_claims_preserve_signed_evidence_and_lifecycle() {
        let channel = Uuid::new_v4();
        let community = CommunityId::from_uuid(Uuid::new_v4());
        let issuer = Keys::generate();
        let subject = Keys::generate().public_key().to_hex();
        let vouch = stored_event(
            &issuer,
            1985,
            "Built the release pipeline",
            vec![
                tag(&["h", &channel.to_string()]),
                tag(&["L", "buzz.wot"]),
                tag(&["l", "vouch", "buzz.wot"]),
                tag(&["p", &subject]),
                tag(&["r", "https://example.test/evidence/1"]),
            ],
            Some(channel),
        );
        let revoke = stored_event(
            &issuer,
            1985,
            "Evidence was withdrawn",
            vec![
                tag(&["h", &channel.to_string()]),
                tag(&["L", "buzz.wot"]),
                tag(&["l", "revoke", "buzz.wot"]),
                tag(&["p", &subject]),
                tag(&["e", &vouch.event.id.to_hex(), "", "target"]),
            ],
            Some(channel),
        );
        let claims = normalize_vouch_claims(&[revoke, vouch], community, channel);
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].value["status"], "revoked");
        assert_eq!(
            claims[0].value["derivedFrom"][0]["value"],
            "https://example.test/evidence/1"
        );
        assert_eq!(claims[0].value["source"]["verified"], true);
        assert!(claims[0].value["source"]["signature"].is_string());
        assert!(claims[0].value["source"].get("event").is_none());
        assert!(claims[0].value["lifecycle"]["source"]["eventId"].is_string());
    }

    #[test]
    fn local_provider_enforces_the_public_response_byte_bound() {
        let oversized = json!({"claims": ["x".repeat(dkg_query::MAX_RESPONSE_BYTES)]});
        assert!(bounded_local_response(oversized).is_err());
        assert!(bounded_local_response(json!({"claims": []})).is_ok());
    }

    #[test]
    fn trusted_assertions_include_only_viewer_selected_results() {
        let community = CommunityId::from_uuid(Uuid::new_v4());
        let provider = Keys::generate();
        let subject = Keys::generate().public_key().to_hex();
        let assertion = stored_event(
            &provider,
            30382,
            "",
            vec![
                tag(&["d", &subject]),
                tag(&["rank", "89"]),
                tag(&["followers", "123"]),
            ],
            None,
        );
        let selected = vec![SelectedSource {
            result_tag: "rank".to_string(),
            pubkey: provider.public_key().to_hex(),
            relay: None,
        }];
        let (claims, matched) = normalize_assertion_claims(&[assertion], &selected, community);
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].value["assertions"]["rank"], json!(["89"]));
        assert!(claims[0].value["assertions"].get("followers").is_none());
        assert!(matched.contains(&(provider.public_key().to_hex(), "rank".to_string())));
    }

    #[test]
    fn relay_hint_comparison_normalizes_http_and_websocket_schemes() {
        assert!(same_relay("wss://relay.example/", "https://RELAY.example"));
        assert!(!same_relay("wss://relay.example", "wss://other.example"));
    }

    #[test]
    fn gateway_completeness_maps_to_explicit_resolution_states() {
        assert_eq!(
            resolution_from_gateway(&serde_json::json!({
                "result": {"completeness": "complete"}
            })),
            ResolutionState::Complete
        );
        assert_eq!(
            resolution_from_gateway(&serde_json::json!({
                "result": {"completeness": "partial"}
            })),
            ResolutionState::Partial
        );
        assert_eq!(
            resolution_from_gateway(&serde_json::json!({"result": {}})),
            ResolutionState::Partial
        );
    }

    #[test]
    fn gateway_success_is_bound_to_the_authorized_request_and_result_shape() {
        let request = serde_json::json!({
            "channelId": "channel",
            "operation": "trust_network"
        });
        let valid = serde_json::json!({
            "ok": true,
            "channelId": "channel",
            "cg": "did:dkg:context-graph:channel",
            "operation": "trust_network",
            "result": {"completeness": "complete", "people": [], "vouches": []}
        });
        assert_eq!(
            validate_gateway_success(&request, &valid),
            Ok(ResolutionState::Complete)
        );

        for malformed in [
            serde_json::json!({}),
            serde_json::json!({"result": {"completeness": "complete"}}),
            serde_json::json!({
                "ok": true,
                "channelId": "other-channel",
                "cg": "did:dkg:context-graph:channel",
                "operation": "trust_network",
                "result": {"people": [], "vouches": []}
            }),
            serde_json::json!({
                "ok": true,
                "channelId": "channel",
                "cg": "did:dkg:context-graph:channel",
                "operation": "reputation_summary",
                "result": {"people": [], "vouches": []}
            }),
        ] {
            assert!(validate_gateway_success(&request, &malformed).is_err());
        }
    }

    #[test]
    fn provider_metadata_is_additive_to_the_existing_gateway_envelope() {
        let batch = ReputationBatch::dkg(
            ResolutionState::Complete,
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "channelId": "channel",
                    "cg": "cg",
                    "operation": "trust_network",
                    "result": {"completeness": "complete", "people": [], "vouches": []}
                })),
            ),
            None,
        );
        let (_, Json(value)) = batch.into_http_result().expect("successful batch");
        assert_eq!(value["result"]["people"], serde_json::json!([]));
        assert_eq!(value["resolution"], "complete");
        assert_eq!(value["providerId"], "origintrail-dkg");
        assert_eq!(value["providerVersion"], "dkg-trust@1");
        assert!(value["asOf"].is_string());
    }
}
