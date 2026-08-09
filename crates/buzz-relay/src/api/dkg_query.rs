//! Authenticated HTTP front for bounded DKG graph reads.
//!
//! This is intentionally HTTP rather than a new persisted Nostr event kind:
//! graph and evidence responses can be large, request/response-shaped, and do
//! not belong in relay history or fan-out. The route still uses the relay's
//! existing host binding, NIP-98, admission, replay, relay-membership, and
//! channel-read gates before a sanitized request reaches the internal
//! integration service.

use std::sync::{Arc, LazyLock};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use buzz_core::TenantContext;

use crate::state::AppState;

use super::{api_error, bridge, internal_error, not_found};

/// Maximum public request body accepted by `/api/dkg/query`.
pub(crate) const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub(super) const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 256;
const MAX_URI_BYTES: usize = 2048;

pub(super) static HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| error.to_string())
});

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryRequest {
    channel_id: Uuid,
    operation: Operation,
    arguments: Value,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Operation {
    ChannelMemory,
    ContributorTrail,
    SoftwareContributors,
    DecisionTrace,
    SubgraphGraph,
    SubgraphTriples,
    Evidence,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EmptyArguments {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PubkeyArguments {
    pubkey: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ComponentType {
    Function,
    Class,
    Interface,
    File,
    Package,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SoftwareContributorArguments {
    component_name: String,
    component_type: Option<ComponentType>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecisionTraceArguments {
    commit_sha: String,
    component_name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NameArguments {
    name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UriArguments {
    uri: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardRequest {
    channel_id: Uuid,
    operation: Operation,
    arguments: Value,
    requester_pubkey: String,
}

fn parse_and_sanitize_request(
    body: &[u8],
    requester: &nostr::PublicKey,
) -> Result<ForwardRequest, (StatusCode, Json<Value>)> {
    let request: QueryRequest = serde_json::from_slice(body).map_err(|error| {
        api_error(
            StatusCode::BAD_REQUEST,
            &format!("invalid request: {error}"),
        )
    })?;

    let arguments = match request.operation {
        Operation::ChannelMemory => {
            let arguments: EmptyArguments = parse_arguments(request.arguments)?;
            serde_json::to_value(arguments)
        }
        Operation::ContributorTrail => {
            let mut arguments: PubkeyArguments = parse_arguments(request.arguments)?;
            arguments.pubkey = nostr::PublicKey::from_hex(&arguments.pubkey)
                .map_err(|_| api_error(StatusCode::BAD_REQUEST, "invalid contributor pubkey"))?
                .to_hex();
            serde_json::to_value(arguments)
        }
        Operation::SoftwareContributors => {
            let mut arguments: SoftwareContributorArguments = parse_arguments(request.arguments)?;
            arguments.component_name =
                bounded_text("componentName", arguments.component_name, MAX_NAME_BYTES)?;
            serde_json::to_value(arguments)
        }
        Operation::DecisionTrace => {
            let mut arguments: DecisionTraceArguments = parse_arguments(request.arguments)?;
            arguments.component_name =
                bounded_text("componentName", arguments.component_name, MAX_NAME_BYTES)?;
            arguments.commit_sha = arguments.commit_sha.to_ascii_lowercase();
            if arguments.commit_sha.len() < 7
                || arguments.commit_sha.len() > 64
                || !arguments
                    .commit_sha
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
            {
                return Err(api_error(StatusCode::BAD_REQUEST, "invalid commitSha"));
            }
            serde_json::to_value(arguments)
        }
        Operation::SubgraphGraph | Operation::SubgraphTriples => {
            let mut arguments: NameArguments = parse_arguments(request.arguments)?;
            arguments.name = bounded_text("name", arguments.name, MAX_NAME_BYTES)?;
            serde_json::to_value(arguments)
        }
        Operation::Evidence => {
            let mut arguments: UriArguments = parse_arguments(request.arguments)?;
            arguments.uri = bounded_text("uri", arguments.uri, MAX_URI_BYTES)?;
            serde_json::to_value(arguments)
        }
    }
    .map_err(|_| internal_error("serializing sanitized DKG query arguments"))?;

    Ok(ForwardRequest {
        channel_id: request.channel_id,
        operation: request.operation,
        arguments,
        requester_pubkey: requester.to_hex(),
    })
}

fn parse_arguments<T>(arguments: Value) -> Result<T, (StatusCode, Json<Value>)>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(arguments).map_err(|error| {
        api_error(
            StatusCode::BAD_REQUEST,
            &format!("invalid arguments: {error}"),
        )
    })
}

fn bounded_text(
    field: &str,
    value: String,
    max_bytes: usize,
) -> Result<String, (StatusCode, Json<Value>)> {
    let value = value.trim();
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            &format!("{field} must contain 1..={max_bytes} non-control UTF-8 bytes"),
        ));
    }
    Ok(value.to_owned())
}

fn channel_is_accessible(accessible_channels: &[Uuid], channel_id: Uuid) -> bool {
    accessible_channels.contains(&channel_id)
}

pub(super) async fn enforce_authoritative_channel_read(
    state: &AppState,
    tenant: &TenantContext,
    channel_id: Uuid,
    pubkey: &[u8],
) -> Result<(), (StatusCode, Json<Value>)> {
    let accessible_channels = state
        .get_accessible_channel_ids_cached(tenant.community(), pubkey)
        .await
        .map_err(|error| internal_error(&format!("channel access lookup: {error}")))?;
    if !channel_is_accessible(&accessible_channels, channel_id) {
        return Err(not_found("channel unavailable"));
    }
    Ok(())
}

/// `POST /api/dkg/query` — authorize and proxy one constrained graph read.
pub async fn query(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let config = state
        .config
        .dkg_query
        .as_ref()
        .ok_or_else(|| not_found("not found"))?;

    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| not_found("relay: no community is configured for this host"))?;

    let expected_url =
        bridge::nip98_expected_url(&state.config.relay_url, &tenant, "/api/dkg/query");
    let (requester, event_id) = bridge::verify_bridge_auth_with_options(
        &headers,
        "POST",
        &expected_url,
        Some(&body),
        true,
        true,
    )?;

    bridge::enforce_http_admission(&state, &tenant, &requester).await?;
    bridge::check_nip98_replay(&state, &tenant, event_id).await?;

    let requester_bytes = requester.to_bytes();
    let auth_tag = headers
        .get("x-auth-tag")
        .and_then(|value| value.to_str().ok());
    super::relay_members::enforce_relay_membership(
        &state,
        tenant.community(),
        &requester_bytes,
        auth_tag,
    )
    .await?;

    let forward = parse_and_sanitize_request(&body, &requester)?;
    enforce_authoritative_channel_read(&state, &tenant, forward.channel_id, &requester_bytes)
        .await?;

    let client = HTTP_CLIENT
        .as_ref()
        .map_err(|_| internal_error("initializing the internal DKG query client"))?;
    let response = client
        .post(config.url.clone())
        .bearer_auth(&config.bearer_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(config.timeout)
        .json(&forward)
        .send()
        .await
        .map_err(upstream_error)?;
    bounded_json_response(response).await
}

pub(super) fn upstream_error(error: reqwest::Error) -> (StatusCode, Json<Value>) {
    if error.is_timeout() {
        api_error(StatusCode::GATEWAY_TIMEOUT, "DKG query gateway timed out")
    } else {
        tracing::warn!(error = %error.without_url(), "internal DKG query gateway request failed");
        api_error(StatusCode::BAD_GATEWAY, "DKG query gateway unavailable")
    }
}

pub(super) async fn bounded_json_response(
    response: reqwest::Response,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(api_error(
            StatusCode::BAD_GATEWAY,
            "DKG query response exceeded the relay limit",
        ));
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(upstream_error)?;
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(api_error(
                StatusCode::BAD_GATEWAY,
                "DKG query response exceeded the relay limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&body).map_err(|_| {
        api_error(
            StatusCode::BAD_GATEWAY,
            "DKG query gateway returned invalid JSON",
        )
    })?;
    Ok((status, Json(value)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requester() -> nostr::PublicKey {
        nostr::Keys::generate().public_key()
    }

    fn request(operation: &str, arguments: Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "channelId": Uuid::new_v4(),
            "operation": operation,
            "arguments": arguments,
        }))
        .expect("serialize test request")
    }

    #[test]
    fn accepts_only_operation_specific_arguments() {
        let requester = requester();
        for (operation, arguments) in [
            ("channel_memory", serde_json::json!({})),
            (
                "contributor_trail",
                serde_json::json!({ "pubkey": nostr::Keys::generate().public_key().to_hex() }),
            ),
            (
                "software_contributors",
                serde_json::json!({ "componentName": "verifyToken", "componentType": "function" }),
            ),
            (
                "decision_trace",
                serde_json::json!({ "commitSha": "A1B2C3D4", "componentName": "Authentication gateway" }),
            ),
            ("subgraph_graph", serde_json::json!({ "name": "decisions" })),
            (
                "subgraph_triples",
                serde_json::json!({ "name": "decisions" }),
            ),
            (
                "evidence",
                serde_json::json!({ "uri": "urn:buzz:evidence:123" }),
            ),
        ] {
            let sanitized = parse_and_sanitize_request(&request(operation, arguments), &requester)
                .expect("allowlisted operation");
            assert_eq!(sanitized.requester_pubkey, requester.to_hex());
        }
    }

    #[test]
    fn rejects_unknown_operation_and_routing_fields() {
        let requester = requester();
        assert!(parse_and_sanitize_request(
            &request(
                "sparql",
                serde_json::json!({ "sparql": "SELECT * WHERE {}" })
            ),
            &requester,
        )
        .is_err());

        for forbidden in ["contextGraphId", "cg", "sparql", "url", "token"] {
            let mut arguments = serde_json::Map::new();
            arguments.insert(
                forbidden.to_string(),
                Value::String("attacker-controlled".to_string()),
            );
            assert!(parse_and_sanitize_request(
                &request("channel_memory", Value::Object(arguments)),
                &requester,
            )
            .is_err());
        }

        let outer = serde_json::json!({
            "channelId": Uuid::new_v4(),
            "operation": "channel_memory",
            "arguments": {},
            "contextGraphId": "attacker-controlled",
        });
        assert!(parse_and_sanitize_request(
            &serde_json::to_vec(&outer).expect("serialize test request"),
            &requester,
        )
        .is_err());
    }

    #[test]
    fn rejects_invalid_payloads() {
        let requester = requester();
        assert!(parse_and_sanitize_request(b"not json", &requester).is_err());
        assert!(parse_and_sanitize_request(
            br#"{"channelId":"not-a-uuid","operation":"channel_memory","arguments":{}}"#,
            &requester,
        )
        .is_err());
        assert!(parse_and_sanitize_request(
            &request("contributor_trail", serde_json::json!({ "pubkey": "bad" })),
            &requester,
        )
        .is_err());
    }

    #[test]
    fn missing_nip98_auth_is_rejected_even_in_dev_mode() {
        let headers = HeaderMap::new();
        let error = bridge::verify_bridge_auth_with_options(
            &headers,
            "POST",
            "https://relay.example/api/dkg/query",
            Some(b"{}"),
            true,
            true,
        )
        .expect_err("NIP-98 is mandatory");
        assert_eq!(error.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn inaccessible_channel_is_rejected_by_authoritative_set() {
        let allowed = Uuid::new_v4();
        let inaccessible = Uuid::new_v4();
        assert!(channel_is_accessible(&[allowed], allowed));
        assert!(!channel_is_accessible(&[allowed], inaccessible));
    }
}
