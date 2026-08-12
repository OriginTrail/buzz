//! Authenticated agent-memory proposal front for the Buzz↔DKG integration.
//!
//! The agent signs the semantic proposal, while the relay proves membership,
//! channel access, and the exact source events before forwarding anything to
//! the loopback integration gateway. DKG credentials never reach clients.

use std::collections::HashSet;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use buzz_core::kind::KIND_DKG_MEMORY_PROPOSAL;

use crate::state::AppState;

use super::{api_error, bridge, dkg_query, internal_error, not_found};

/// Signed proposal bodies are bounded separately from the larger internal evidence envelope.
pub(crate) const MAX_REQUEST_BYTES: usize = 96 * 1024;
const MAX_EVIDENCE_BYTES: usize = 240 * 1024;
const MAX_SOURCES: usize = 16;
const MAX_ITEMS: usize = 50;
const MAX_ENTITIES: usize = 100;
const MAX_RELATIONS: usize = 200;
const MAX_ATTRIBUTES: usize = 20;
type ApiFailure = (StatusCode, Json<Value>);
type ParsedProposal = (nostr::Event, Uuid, Vec<nostr::EventId>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalV1 {
    schema_version: u8,
    summary: String,
    items: Vec<MemoryItem>,
    model: Option<String>,
    prompt_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProposalV2 {
    schema_version: u8,
    profiles: Vec<String>,
    summary: String,
    entities: Vec<MemoryEntity>,
    relations: Vec<MemoryRelation>,
    model: Option<String>,
    prompt_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryEntity {
    id: String,
    #[serde(rename = "type")]
    entity_type: String,
    name: String,
    description: Option<String>,
    locator: Option<Value>,
    attributes: Option<Vec<MemoryAttribute>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryAttribute {
    predicate: String,
    value: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryRelation {
    subject: String,
    predicate: String,
    object: String,
    confidence: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryItem {
    kind: MemoryKind,
    text: String,
    subject: Option<String>,
    predicate: Option<String>,
    object: Option<String>,
    confidence: Option<f64>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MemoryKind {
    Decision,
    Claim,
    Question,
    Task,
    Relationship,
}

fn invalid(message: &str) -> (StatusCode, Json<Value>) {
    api_error(StatusCode::BAD_REQUEST, message)
}

fn bounded(value: &str, field: &str, max: usize) -> Result<(), (StatusCode, Json<Value>)> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(invalid(&format!(
            "{field} must contain 1..={max} non-control UTF-8 bytes"
        )));
    }
    Ok(())
}

fn validate_v1(proposal: ProposalV1) -> Result<(), (StatusCode, Json<Value>)> {
    if proposal.schema_version != 1 {
        return Err(invalid("schemaVersion must be 1"));
    }
    bounded(&proposal.summary, "summary", 1_000)?;
    if proposal.items.is_empty() || proposal.items.len() > MAX_ITEMS {
        return Err(invalid("items must contain 1..=50 entries"));
    }
    if let Some(model) = proposal.model.as_deref() {
        bounded(model, "model", 200)?;
    }
    if let Some(version) = proposal.prompt_version.as_deref() {
        bounded(version, "promptVersion", 200)?;
    }
    for (index, item) in proposal.items.iter().enumerate() {
        bounded(&item.text, &format!("items[{index}].text"), 2_000)?;
        for (name, value, max) in [
            ("subject", item.subject.as_deref(), 500),
            ("predicate", item.predicate.as_deref(), 200),
            ("object", item.object.as_deref(), 500),
        ] {
            if let Some(value) = value {
                bounded(value, &format!("items[{index}].{name}"), max)?;
            }
        }
        if item
            .confidence
            .is_some_and(|confidence| !confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
        {
            return Err(invalid(&format!(
                "items[{index}].confidence must be between 0 and 1"
            )));
        }
        if matches!(item.kind, MemoryKind::Relationship)
            && (item.subject.is_none() || item.predicate.is_none() || item.object.is_none())
        {
            return Err(invalid(&format!(
                "items[{index}] relationships require subject, predicate and object"
            )));
        }
    }
    Ok(())
}

fn valid_local_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().enumerate().all(|(index, character)| {
            (index == 0 && character.is_ascii_lowercase())
                || (index > 0
                    && (character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || character == '-'))
        })
}

fn validate_entity_identity(
    entity: &MemoryEntity,
    index: usize,
) -> Result<(), (StatusCode, Json<Value>)> {
    let locator = entity.locator.as_ref().and_then(Value::as_object);
    let locator_kind = locator
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str);
    if matches!(
        entity.entity_type.as_str(),
        "code:Package"
            | "code:File"
            | "code:Function"
            | "code:Class"
            | "code:Interface"
            | "code:TypeAlias"
            | "code:Enum"
    ) {
        let repository = locator
            .and_then(|value| value.get("repository"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if locator_kind != Some("code") || !repository.starts_with("https://") {
            return Err(invalid(&format!(
                "entities[{index}] code identity requires a canonical HTTPS repository locator"
            )));
        }
    }
    if matches!(
        entity.entity_type.as_str(),
        "github:Repository" | "github:PullRequest" | "github:Issue" | "github:Commit"
    ) && locator_kind != Some("github")
    {
        return Err(invalid(&format!(
            "entities[{index}] GitHub identity requires a github locator"
        )));
    }
    if entity.entity_type == "schema:Project" && locator_kind != Some("uri") {
        return Err(invalid(&format!(
            "entities[{index}] project identity requires a URI locator"
        )));
    }
    Ok(())
}

fn validate_v2(proposal: ProposalV2) -> Result<(), (StatusCode, Json<Value>)> {
    if proposal.schema_version != 2 {
        return Err(invalid("schemaVersion must be 2"));
    }
    bounded(&proposal.summary, "summary", 1_000)?;
    if proposal.profiles.is_empty() || proposal.profiles.len() > 3 {
        return Err(invalid("profiles must contain 1..=3 entries"));
    }
    let mut profiles = HashSet::new();
    for profile in &proposal.profiles {
        if !matches!(
            profile.as_str(),
            "dkg-memory@1" | "dkg-software@1" | "dkg-trust@1"
        ) || !profiles.insert(profile.as_str())
        {
            return Err(invalid(
                "profiles contains an unsupported or duplicate entry",
            ));
        }
    }
    if !profiles.contains("dkg-memory@1") {
        return Err(invalid("profiles must include dkg-memory@1"));
    }
    if proposal.entities.is_empty() || proposal.entities.len() > MAX_ENTITIES {
        return Err(invalid("entities must contain 1..=100 entries"));
    }
    let mut ids = HashSet::new();
    for (index, entity) in proposal.entities.iter().enumerate() {
        if !valid_local_id(&entity.id) || !ids.insert(entity.id.as_str()) {
            return Err(invalid(&format!(
                "entities[{index}].id is invalid or duplicate"
            )));
        }
        bounded(&entity.entity_type, &format!("entities[{index}].type"), 100)?;
        bounded(&entity.name, &format!("entities[{index}].name"), 500)?;
        if let Some(description) = entity.description.as_deref() {
            bounded(
                description,
                &format!("entities[{index}].description"),
                4_000,
            )?;
        }
        if entity
            .locator
            .as_ref()
            .is_some_and(|locator| !locator.is_object())
        {
            return Err(invalid(&format!(
                "entities[{index}].locator must be an object"
            )));
        }
        validate_entity_identity(entity, index)?;
        let attributes = entity.attributes.as_deref().unwrap_or_default();
        if attributes.len() > MAX_ATTRIBUTES {
            return Err(invalid(&format!(
                "entities[{index}].attributes exceeds 20 entries"
            )));
        }
        for (attribute_index, attribute) in attributes.iter().enumerate() {
            bounded(
                &attribute.predicate,
                &format!("entities[{index}].attributes[{attribute_index}].predicate"),
                100,
            )?;
            if !(attribute.value.is_string()
                || attribute.value.is_number()
                || attribute.value.is_boolean())
            {
                return Err(invalid(&format!(
                    "entities[{index}].attributes[{attribute_index}].value must be scalar"
                )));
            }
        }
    }
    if proposal.relations.len() > MAX_RELATIONS {
        return Err(invalid("relations exceeds 200 entries"));
    }
    for (index, relation) in proposal.relations.iter().enumerate() {
        if !ids.contains(relation.subject.as_str()) || !ids.contains(relation.object.as_str()) {
            return Err(invalid(&format!(
                "relations[{index}] references an unknown entity"
            )));
        }
        bounded(
            &relation.predicate,
            &format!("relations[{index}].predicate"),
            100,
        )?;
        if relation
            .confidence
            .is_some_and(|confidence| !confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
        {
            return Err(invalid(&format!(
                "relations[{index}].confidence must be between 0 and 1"
            )));
        }
    }
    if let Some(model) = proposal.model.as_deref() {
        bounded(model, "model", 200)?;
    }
    if let Some(version) = proposal.prompt_version.as_deref() {
        bounded(version, "promptVersion", 200)?;
    }
    Ok(())
}

fn validate_semantics(content: &str) -> Result<(), (StatusCode, Json<Value>)> {
    let value: Value = serde_json::from_str(content)
        .map_err(|error| invalid(&format!("invalid proposal content: {error}")))?;
    match value.get("schemaVersion").and_then(Value::as_u64) {
        Some(1) => validate_v1(
            serde_json::from_value(value)
                .map_err(|error| invalid(&format!("invalid proposal content: {error}")))?,
        ),
        Some(2) => validate_v2(
            serde_json::from_value(value)
                .map_err(|error| invalid(&format!("invalid proposal content: {error}")))?,
        ),
        _ => Err(invalid("schemaVersion must be 1 or 2")),
    }
}

fn event_tag_values<'a>(event: &'a nostr::Event, name: &str) -> Vec<&'a str> {
    event
        .tags
        .iter()
        .filter_map(|tag| {
            let parts = tag.as_slice();
            (parts.first().map(String::as_str) == Some(name))
                .then(|| parts.get(1).map(String::as_str))
                .flatten()
        })
        .collect()
}

fn proposal_uses_profile(event: &nostr::Event, profile: &str) -> bool {
    serde_json::from_str::<Value>(&event.content)
        .ok()
        .and_then(|proposal| proposal.get("profiles").cloned())
        .and_then(|profiles| profiles.as_array().cloned())
        .is_some_and(|profiles| profiles.iter().any(|value| value.as_str() == Some(profile)))
}

fn parse_proposal(body: &[u8], requester: &nostr::PublicKey) -> Result<ParsedProposal, ApiFailure> {
    let event: nostr::Event = serde_json::from_slice(body)
        .map_err(|error| invalid(&format!("invalid signed proposal event: {error}")))?;
    if !event.verify_id() || !event.verify_signature() {
        return Err(invalid("proposal event id or signature is invalid"));
    }
    if event.pubkey != *requester {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "proposal author must match the authenticated requester",
        ));
    }
    if event.kind.as_u16() as u32 != KIND_DKG_MEMORY_PROPOSAL {
        return Err(invalid("proposal event kind must be 40009"));
    }
    let channels = event_tag_values(&event, "h");
    if channels.len() != 1 {
        return Err(invalid("proposal must contain exactly one h tag"));
    }
    let channel_id = Uuid::parse_str(channels[0]).map_err(|_| invalid("h tag is not a UUID"))?;
    if channels[0] != channel_id.to_string() {
        return Err(invalid("h tag must use the canonical lowercase UUID"));
    }
    if !event_tag_values(&event, "t").contains(&"dkg-memory-proposal") {
        return Err(invalid("proposal is missing the dkg-memory-proposal t tag"));
    }
    let mut source_ids = Vec::new();
    for tag in event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().map(String::as_str) == Some("e"))
    {
        let parts = tag.as_slice();
        if parts.get(3).map(String::as_str) != Some("source") {
            return Err(invalid("every e tag must use the source marker"));
        }
        let id = parts
            .get(1)
            .and_then(|value| nostr::EventId::from_hex(value).ok())
            .ok_or_else(|| invalid("proposal contains an invalid source event id"))?;
        source_ids.push(id);
    }
    let unique: HashSet<_> = source_ids.iter().map(nostr::EventId::to_hex).collect();
    if source_ids.is_empty() || source_ids.len() > MAX_SOURCES || unique.len() != source_ids.len() {
        return Err(invalid(
            "proposal must contain 1..=16 unique source event tags",
        ));
    }
    validate_semantics(&event.content)?;
    Ok((event, channel_id, source_ids))
}

fn memory_gateway_url(query_url: &url::Url) -> Result<url::Url, (StatusCode, Json<Value>)> {
    let Some(prefix) = query_url.path().strip_suffix("/v1/query") else {
        tracing::error!(url = %query_url, "DKG query URL cannot derive the memory endpoint");
        return Err(internal_error("invalid internal DKG gateway configuration"));
    };
    let mut url = query_url.clone();
    url.set_path(&format!("{prefix}/v1/memory"));
    Ok(url)
}

/// `POST /api/dkg/memory` — authorize, bind evidence, and forward one signed proposal.
pub async fn propose(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<(StatusCode, Json<Value>), (StatusCode, Json<Value>)> {
    let config = state
        .config
        .dkg_query
        .as_ref()
        .filter(|config| config.agent_memory_enabled)
        .ok_or_else(|| not_found("not found"))?;
    let raw_host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let tenant = crate::tenant::bind_community(&state.db, raw_host)
        .await
        .map_err(|_| not_found("relay: no community is configured for this host"))?;
    let expected_url =
        bridge::nip98_expected_url(&state.config.relay_url, &tenant, "/api/dkg/memory");
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

    let (proposal, channel_id, source_ids) = parse_proposal(&body, &requester)?;
    if !config.trust_enabled && proposal_uses_profile(&proposal, "dkg-trust@1") {
        return Err(not_found("not found"));
    }
    dkg_query::enforce_authoritative_channel_read(&state, &tenant, channel_id, &requester_bytes)
        .await?;

    let mut sources = Vec::with_capacity(source_ids.len());
    for source_id in source_ids {
        let stored = state
            .db
            .get_event_by_id(tenant.community(), source_id.as_bytes())
            .await
            .map_err(|error| internal_error(&format!("source event lookup: {error}")))?
            .ok_or_else(|| not_found("source event unavailable"))?;
        if stored.channel_id != Some(channel_id) {
            return Err(not_found("source event unavailable"));
        }
        sources.push(stored.event);
    }
    if !sources.iter().any(|event| event.pubkey == requester) {
        return Err(invalid(
            "at least one source event must be authored by the proposing agent",
        ));
    }

    let forward = serde_json::json!({
        "channelId": channel_id,
        "requesterPubkey": requester.to_hex(),
        "proposalEvent": proposal,
        "sourceEvents": sources,
    });
    let forward = serde_json::to_vec(&forward)
        .map_err(|error| internal_error(&format!("serializing evidence envelope: {error}")))?;
    if forward.len() > MAX_EVIDENCE_BYTES {
        return Err(api_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "proposal evidence exceeds the 240 KiB beta limit",
        ));
    }
    let client = dkg_query::HTTP_CLIENT
        .as_ref()
        .map_err(|_| internal_error("initializing the internal DKG memory client"))?;
    let response = client
        .post(memory_gateway_url(&config.url)?)
        .bearer_auth(&config.bearer_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(config.timeout)
        .body(forward)
        .send()
        .await
        .map_err(dkg_query::upstream_error)?;
    dkg_query::bounded_json_response(response).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};

    fn proposal(content: Value, sources: &[nostr::EventId]) -> (Keys, nostr::Event, Uuid) {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let mut tags = vec![
            Tag::parse(["h", &channel.to_string()]).unwrap(),
            Tag::parse(["t", "dkg-memory-proposal"]).unwrap(),
        ];
        for source in sources {
            tags.push(Tag::parse(["e", &source.to_hex(), "", "source"]).unwrap());
        }
        let event = EventBuilder::new(
            Kind::Custom(KIND_DKG_MEMORY_PROPOSAL as u16),
            content.to_string(),
        )
        .tags(tags)
        .sign_with_keys(&keys)
        .unwrap();
        (keys, event, channel)
    }

    #[test]
    fn accepts_a_signed_bounded_proposal() {
        let source = nostr::EventId::all_zeros();
        let (keys, event, channel) = proposal(
            serde_json::json!({
                "schemaVersion": 1,
                "summary": "Adopt Oxigraph",
                "items": [{"kind":"decision", "text":"Use Oxigraph"}]
            }),
            &[source],
        );
        let body = serde_json::to_vec(&event).unwrap();
        let (_, parsed_channel, parsed_sources) =
            parse_proposal(&body, &keys.public_key()).unwrap();
        assert_eq!(parsed_channel, channel);
        assert_eq!(parsed_sources, vec![source]);
    }

    #[test]
    fn accepts_v2_profiles_and_rejects_dangling_relations() {
        let source = nostr::EventId::all_zeros();
        let valid = serde_json::json!({
            "schemaVersion": 2,
            "profiles": ["dkg-memory@1", "dkg-software@1"],
            "summary": "Implement token rotation",
            "entities": [
                {"id":"verify-token", "type":"code:Function", "name":"verifyToken", "locator":{"kind":"code","repository":"https://github.com/acme/api","package":"@acme/auth","path":"src/token.ts","symbol":"verifyToken","symbolKind":"function"}},
                {"id":"commit-one", "type":"github:Commit", "name":"Implement JWT", "locator":{"kind":"github","repository":"acme/api","resource":"commit","id":"a1b2c3d4"}}
            ],
            "relations": [
                {"subject":"commit-one", "predicate":"github:affects", "object":"verify-token"}
            ]
        });
        let (keys, event, _) = proposal(valid, &[source]);
        assert!(parse_proposal(&serde_json::to_vec(&event).unwrap(), &keys.public_key()).is_ok());

        let invalid = serde_json::json!({
            "schemaVersion": 2,
            "profiles": ["dkg-memory@1"],
            "summary": "Broken relation",
            "entities": [{"id":"one", "type":"memory:Entity", "name":"One"}],
            "relations": [{"subject":"one", "predicate":"memory:about", "object":"missing"}]
        });
        let (keys, event, _) = proposal(invalid, &[source]);
        assert!(parse_proposal(&serde_json::to_vec(&event).unwrap(), &keys.public_key()).is_err());
    }

    #[test]
    fn detects_the_optional_trust_profile_from_signed_proposal_content() {
        let source = nostr::EventId::all_zeros();
        let content = serde_json::json!({
            "schemaVersion": 2,
            "profiles": ["dkg-memory@1", "dkg-trust@1"],
            "summary": "Vouch",
            "entities": [
                {"id":"vouch", "type":"trust:Vouch", "name":"Vouch", "attributes":[{"predicate":"trust:status","value":"active"},{"predicate":"trust:scope","value":"channel"}]},
                {"id":"issuer", "type":"schema:Person", "name":"Issuer", "locator":{"kind":"uri","uri":format!("urn:nostr:pubkey:{}", "11".repeat(32))}},
                {"id":"subject", "type":"schema:Person", "name":"Subject", "locator":{"kind":"uri","uri":format!("urn:nostr:pubkey:{}", "22".repeat(32))}}
            ],
            "relations": [
                {"subject":"vouch", "predicate":"trust:issuer", "object":"issuer"},
                {"subject":"vouch", "predicate":"trust:subject", "object":"subject"}
            ]
        });
        let (_, event, _) = proposal(content, &[source]);
        assert!(proposal_uses_profile(&event, "dkg-trust@1"));
        assert!(!proposal_uses_profile(&event, "dkg-software@1"));
    }

    #[test]
    fn rejects_empty_items_and_wrong_authors() {
        let source = nostr::EventId::all_zeros();
        let (_, event, _) = proposal(
            serde_json::json!({"schemaVersion":1,"summary":"x","items":[]}),
            &[source],
        );
        assert!(parse_proposal(
            &serde_json::to_vec(&event).unwrap(),
            &Keys::generate().public_key()
        )
        .is_err());
    }

    #[test]
    fn derives_memory_url_without_extra_operator_configuration() {
        let query = url::Url::parse("http://127.0.0.1:9296/v1/query").unwrap();
        assert_eq!(
            memory_gateway_url(&query).unwrap().as_str(),
            "http://127.0.0.1:9296/v1/memory"
        );
    }
}
