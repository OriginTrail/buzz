//! Agent-native DKG memory proposals.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use nostr::{EventBuilder, Kind, Tag};

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::validate::{read_file_or_stdin, validate_hex64, validate_uuid};
use crate::{MemoryCmd, MemoryQueryView};

const KIND_DKG_MEMORY_PROPOSAL: u16 = 40009;
const MAX_SOURCES: usize = 16;
const MAX_SPARQL_BYTES: usize = 8 * 1024;
const PROPOSAL_POLL_INTERVAL: Duration = Duration::from_secs(2);

fn bounded_json_string<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    field: &str,
    label: &str,
    max: usize,
) -> Result<&'a str, CliError> {
    let value = object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(CliError::Usage(format!(
            "memory proposal {label} must contain 1..={max} non-control bytes"
        )));
    }
    Ok(value)
}

fn validate_v2_content(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), CliError> {
    let profiles = object
        .get("profiles")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| CliError::Usage("memory proposal profiles must be an array".into()))?;
    if profiles.is_empty() || profiles.len() > 3 {
        return Err(CliError::Usage(
            "memory proposal profiles must contain 1..=3 entries".into(),
        ));
    }
    let mut profile_ids = HashSet::new();
    for profile in profiles {
        let profile = profile.as_str().unwrap_or("");
        if !matches!(profile, "dkg-memory@1" | "dkg-software@1") || !profile_ids.insert(profile) {
            return Err(CliError::Usage(
                "memory proposal contains an unsupported or duplicate profile".into(),
            ));
        }
    }
    if !profile_ids.contains("dkg-memory@1") {
        return Err(CliError::Usage(
            "memory proposal profiles must include dkg-memory@1".into(),
        ));
    }
    let entities = object
        .get("entities")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| CliError::Usage("memory proposal entities must be an array".into()))?;
    if entities.is_empty() || entities.len() > 100 {
        return Err(CliError::Usage(
            "memory proposal entities must contain 1..=100 entries".into(),
        ));
    }
    let mut entity_ids = HashSet::new();
    for (index, entity) in entities.iter().enumerate() {
        let entity = entity.as_object().ok_or_else(|| {
            CliError::Usage(format!(
                "memory proposal entities[{index}] must be an object"
            ))
        })?;
        let id = bounded_json_string(entity, "id", &format!("entities[{index}].id"), 64)?;
        if !id.chars().enumerate().all(|(position, character)| {
            (position == 0 && character.is_ascii_lowercase())
                || (position > 0
                    && (character.is_ascii_lowercase()
                        || character.is_ascii_digit()
                        || character == '-'))
        }) || !entity_ids.insert(id)
        {
            return Err(CliError::Usage(format!(
                "memory proposal entities[{index}].id is invalid or duplicate"
            )));
        }
        bounded_json_string(entity, "type", &format!("entities[{index}].type"), 100)?;
        bounded_json_string(entity, "name", &format!("entities[{index}].name"), 500)?;
        let entity_type = entity
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let locator = entity.get("locator").and_then(serde_json::Value::as_object);
        let locator_kind = locator
            .and_then(|value| value.get("kind"))
            .and_then(serde_json::Value::as_str);
        if matches!(
            entity_type,
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
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if locator_kind != Some("code") || !repository.starts_with("https://") {
                return Err(CliError::Usage(format!(
                    "memory proposal entities[{index}] code identity requires a canonical HTTPS repository locator"
                )));
            }
        }
        if matches!(
            entity_type,
            "github:Repository" | "github:PullRequest" | "github:Issue" | "github:Commit"
        ) && locator_kind != Some("github")
        {
            return Err(CliError::Usage(format!(
                "memory proposal entities[{index}] GitHub identity requires a github locator"
            )));
        }
        if entity_type == "schema:Project" && locator_kind != Some("uri") {
            return Err(CliError::Usage(format!(
                "memory proposal entities[{index}] project identity requires a URI locator"
            )));
        }
        if entity
            .get("attributes")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|attributes| attributes.len() > 20)
        {
            return Err(CliError::Usage(format!(
                "memory proposal entities[{index}].attributes exceeds 20 entries"
            )));
        }
    }
    let relations = object
        .get("relations")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| CliError::Usage("memory proposal relations must be an array".into()))?;
    if relations.len() > 200 {
        return Err(CliError::Usage(
            "memory proposal relations exceeds 200 entries".into(),
        ));
    }
    for (index, relation) in relations.iter().enumerate() {
        let relation = relation.as_object().ok_or_else(|| {
            CliError::Usage(format!(
                "memory proposal relations[{index}] must be an object"
            ))
        })?;
        let subject = bounded_json_string(
            relation,
            "subject",
            &format!("relations[{index}].subject"),
            64,
        )?;
        let object = bounded_json_string(
            relation,
            "object",
            &format!("relations[{index}].object"),
            64,
        )?;
        bounded_json_string(
            relation,
            "predicate",
            &format!("relations[{index}].predicate"),
            100,
        )?;
        if !entity_ids.contains(subject) || !entity_ids.contains(object) {
            return Err(CliError::Usage(format!(
                "memory proposal relations[{index}] references an unknown entity"
            )));
        }
    }
    Ok(())
}

pub async fn dispatch(command: MemoryCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        MemoryCmd::Propose {
            channel,
            source,
            input,
            wait_seconds,
        } => propose(client, &channel, &source, &input, wait_seconds).await,
        MemoryCmd::Query {
            channel,
            input,
            view,
        } => query(client, &channel, &input, view).await,
    }
}

fn validate_sparql(sparql: &str) -> Result<&str, CliError> {
    let sparql = sparql.trim();
    if sparql.is_empty()
        || sparql.len() > MAX_SPARQL_BYTES
        || sparql
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(CliError::Usage(
            "SPARQL must contain 1..=8192 UTF-8 bytes and no binary control characters".into(),
        ));
    }
    Ok(sparql)
}

async fn query(
    client: &BuzzClient,
    channel: &str,
    input: &str,
    view: MemoryQueryView,
) -> Result<(), CliError> {
    validate_uuid(channel)?;
    let source = read_file_or_stdin(input)?;
    let sparql = validate_sparql(&source)?;
    let request = serde_json::json!({
        "channelId": channel,
        "operation": "semantic_query",
        "scope": { "type": "current_channel" },
        "arguments": { "sparql": sparql, "view": view.to_string() }
    });
    let response = client.post_authed_json("/api/dkg/query", &request).await?;
    println!("{response}");
    Ok(())
}

fn validate_proposal_content(content: &str) -> Result<(), CliError> {
    if content.len() > 64 * 1024 {
        return Err(CliError::Usage(
            "memory proposal JSON exceeds the 65536-byte limit".into(),
        ));
    }
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|error| CliError::Usage(format!("memory proposal is not valid JSON: {error}")))?;
    let object = value
        .as_object()
        .ok_or_else(|| CliError::Usage("memory proposal must be a JSON object".into()))?;
    bounded_json_string(object, "summary", "summary", 1_000)?;
    match object
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
    {
        Some(1) => {
            let items = object
                .get("items")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| CliError::Usage("memory proposal items must be an array".into()))?;
            if items.is_empty() || items.len() > 50 {
                return Err(CliError::Usage(
                    "memory proposal items must contain 1..=50 entries".into(),
                ));
            }
        }
        Some(2) => validate_v2_content(object)?,
        _ => {
            return Err(CliError::Usage(
                "memory proposal schemaVersion must be 1 or 2".into(),
            ))
        }
    }
    Ok(())
}

async fn propose(
    client: &BuzzClient,
    channel: &str,
    sources: &[String],
    input: &str,
    wait_seconds: u64,
) -> Result<(), CliError> {
    validate_uuid(channel)?;
    if sources.is_empty() || sources.len() > MAX_SOURCES {
        return Err(CliError::Usage(
            "--source must be supplied 1..=16 times".into(),
        ));
    }
    let mut unique = HashSet::new();
    for source in sources {
        validate_hex64(source)?;
        if !unique.insert(source.to_ascii_lowercase()) {
            return Err(CliError::Usage("duplicate --source event id".into()));
        }
    }
    let content = read_file_or_stdin(input)?;
    validate_proposal_content(&content)?;
    let mut tags = vec![
        Tag::parse(["h", channel])
            .map_err(|error| CliError::Other(format!("invalid channel tag: {error}")))?,
        Tag::parse(["t", "dkg-memory-proposal"])
            .map_err(|error| CliError::Other(format!("invalid proposal tag: {error}")))?,
    ];
    for source in sources {
        tags.push(
            Tag::parse(["e", source, "", "source"])
                .map_err(|error| CliError::Other(format!("invalid source tag: {error}")))?,
        );
    }
    let event = client.sign_event(
        EventBuilder::new(Kind::Custom(KIND_DKG_MEMORY_PROPOSAL), content).tags(tags),
    )?;
    let value = serde_json::to_value(event)
        .map_err(|error| CliError::Other(format!("proposal serialization failed: {error}")))?;
    let mut response = client.post_authed_json("/api/dkg/memory", &value).await?;
    let wait = Duration::from_secs(wait_seconds);
    let deadline = Instant::now() + wait;
    loop {
        let (normalized, progress) = normalize_proposal_response(&response)?;
        response = normalized;
        match progress {
            ProposalProgress::Stored | ProposalProgress::Unknown => break,
            ProposalProgress::Processing if wait.is_zero() || Instant::now() >= deadline => break,
            ProposalProgress::Processing => {
                tokio::time::sleep(PROPOSAL_POLL_INTERVAL).await;
                match client.post_authed_json("/api/dkg/memory", &value).await {
                    Ok(next) => response = next,
                    Err(error) => {
                        eprintln!(
                            "memory proposal was accepted, but its completion status could not be refreshed: {error}"
                        );
                        break;
                    }
                }
            }
        }
    }
    println!("{response}");
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProposalProgress {
    Processing,
    Stored,
    Unknown,
}

/// Normalize the integration's internal lifecycle phases into the two states
/// an agent can act on. Older beta relays exposed `distilled`/`wm_written`/
/// `finalized`/`shared`; none of those means the graph is queryable yet.
fn normalize_proposal_response(response: &str) -> Result<(String, ProposalProgress), CliError> {
    let mut value: serde_json::Value = serde_json::from_str(response).map_err(|error| {
        CliError::Other(format!("memory proposal returned invalid JSON: {error}"))
    })?;
    let state = value
        .get("state")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let (external, progress) = match state {
        "stored" | "receipted" => (Some("stored"), ProposalProgress::Stored),
        "processing" | "distilled" | "wm_written" | "finalized" | "shared" => {
            (Some("processing"), ProposalProgress::Processing)
        }
        _ => (None, ProposalProgress::Unknown),
    };
    if let (Some(external), Some(object)) = (external, value.as_object_mut()) {
        object.insert(
            "state".to_string(),
            serde_json::Value::String(external.to_string()),
        );
    }
    let normalized = serde_json::to_string(&value).map_err(|error| {
        CliError::Other(format!(
            "memory proposal response serialization failed: {error}"
        ))
    })?;
    Ok((normalized, progress))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proposal_content_requires_version_summary_and_items() {
        assert!(validate_proposal_content(
            r#"{"schemaVersion":1,"summary":"Use Oxigraph","items":[{"kind":"decision","text":"Use Oxigraph"}]}"#
        )
        .is_ok());
        assert!(
            validate_proposal_content(r#"{"schemaVersion":1,"summary":"x","items":[]}"#).is_err()
        );
        assert!(validate_proposal_content("not-json").is_err());
        assert!(validate_proposal_content(
            r#"{"schemaVersion":2,"profiles":["dkg-memory@1","dkg-software@1"],"summary":"JWT implementation","entities":[{"id":"verify-token","type":"code:Function","name":"verifyToken","locator":{"kind":"code","repository":"https://github.com/acme/api","package":"@acme/auth","path":"src/token.ts","symbol":"verifyToken","symbolKind":"function"}},{"id":"commit-one","type":"github:Commit","name":"Implement JWT","locator":{"kind":"github","repository":"acme/api","resource":"commit","id":"a1b2c3d4"}}],"relations":[{"subject":"commit-one","predicate":"github:affects","object":"verify-token"}]}"#
        )
        .is_ok());
        assert!(validate_proposal_content(
            r#"{"schemaVersion":2,"profiles":["dkg-memory@1","dkg-software@1"],"summary":"ambiguous code","entities":[{"id":"verify-token","type":"code:Function","name":"verifyToken","locator":{"kind":"code","package":"@acme/auth","path":"src/token.ts","symbol":"verifyToken","symbolKind":"function"}}],"relations":[]}"#
        )
        .is_err());
        assert!(validate_proposal_content(
            r#"{"schemaVersion":2,"profiles":["dkg-memory@1"],"summary":"x","entities":[{"id":"one","type":"memory:Entity","name":"One"}],"relations":[{"subject":"one","predicate":"memory:about","object":"missing"}]}"#
        )
        .is_err());
    }

    #[test]
    fn proposal_validation_reports_the_exact_relation_field() {
        let error = validate_proposal_content(
            r#"{"schemaVersion":2,"profiles":["dkg-memory@1"],"summary":"x","entities":[{"id":"one","type":"memory:Entity","name":"One"}],"relations":[{"from":"one","predicate":"memory:about","to":"one"}]}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("relations[0].subject"));
    }

    #[test]
    fn proposal_status_hides_internal_phases_until_storage_is_queryable() {
        let (processing, progress) =
            normalize_proposal_response(r#"{"ok":true,"outcome":"accepted","state":"distilled"}"#)
                .unwrap();
        assert_eq!(progress, ProposalProgress::Processing);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&processing).unwrap()["state"],
            "processing"
        );

        let (stored, progress) =
            normalize_proposal_response(r#"{"ok":true,"outcome":"duplicate","state":"receipted"}"#)
                .unwrap();
        assert_eq!(progress, ProposalProgress::Stored);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stored).unwrap()["state"],
            "stored"
        );
    }

    #[test]
    fn semantic_query_allows_formatting_but_rejects_binary_controls_and_oversize_input() {
        assert!(validate_sparql("SELECT ?s WHERE {\n?s <urn:p> ?o\n} LIMIT 25").is_ok());
        assert!(validate_sparql("SELECT ?s WHERE { ?s <urn:p> ?o }\0").is_err());
        assert!(validate_sparql(&"x".repeat(MAX_SPARQL_BYTES + 1)).is_err());
        assert!(validate_sparql("   ").is_err());
    }
}
