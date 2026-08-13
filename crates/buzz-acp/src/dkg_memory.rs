//! Runtime-owned post-turn DKG memory finalization.
//!
//! The normal ACP turn remains responsible for the human-facing Buzz reply.
//! Once that succeeds, this module asks the same model for a structured,
//! evidence-bound semantic side output. The harness—not the model—signs and
//! submits the proposal. Signed proposals are persisted before the HTTP call so
//! a crash or transient network failure can be retried safely.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use nostr::{Event, EventBuilder, Kind, Tag, Timestamp};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::acp::AcpError;
use crate::pool::{OwnedAgent, PromptContext};
use crate::relay::{RelayError, RestClient};

const KIND_DKG_MEMORY_PROPOSAL: u16 = 40009;
const RESPONSE_QUERY_TIMEOUT: Duration = Duration::from_secs(3);
const MEMORY_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const MEMORY_HARD_TIMEOUT: Duration = Duration::from_secs(120);
const MEMORY_CANCEL_GRACE: Duration = Duration::from_secs(5);
const OUTBOX_RETRY_INTERVAL: Duration = Duration::from_secs(60);
const MAX_PROPOSAL_BYTES: usize = 64 * 1024;
const MAX_OUTBOX_DRAIN: usize = 64;

/// Result of the post-turn memory phase. Failures never retract a response the
/// user has already received, but they remain observable and retryable.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PostTurnMemoryOutcome {
    Stored { proposal_event_id: String },
    SkippedNoResponse,
    Failed(String),
}

fn h_tag(event: &Event, channel_id: Uuid) -> bool {
    let expected = channel_id.to_string();
    event.tags.iter().any(|tag| {
        let parts = tag.as_slice();
        parts.first().map(String::as_str) == Some("h")
            && parts.get(1).map(String::as_str) == Some(expected.as_str())
    })
}

fn response_kind(kind: Kind) -> bool {
    response_kinds().contains(&kind)
}

fn response_kinds() -> [Kind; 3] {
    [Kind::Custom(9), Kind::Custom(45001), Kind::Custom(45003)]
}

async fn query_response_events(
    rest: &RestClient,
    channel_id: Uuid,
    turn_started_at: u64,
) -> Result<Vec<Event>, RelayError> {
    use nostr::{Alphabet, SingleLetterTag};

    let channel = channel_id.to_string();
    let h = SingleLetterTag::lowercase(Alphabet::H);
    let filter = nostr::Filter::new()
        .kinds(response_kinds())
        .author(rest.keys.public_key())
        .custom_tags(h, [channel])
        .since(Timestamp::from(turn_started_at.saturating_sub(1)))
        .limit(32);
    let raw = tokio::time::timeout(RESPONSE_QUERY_TIMEOUT, rest.query(&[filter]))
        .await
        .map_err(|_| RelayError::Timeout)??;
    let mut events = raw
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<Event>(value.clone()).ok())
        .filter(|event| {
            event.pubkey == rest.keys.public_key()
                && event.created_at.as_secs() >= turn_started_at.saturating_sub(1)
                && response_kind(event.kind)
                && h_tag(event, channel_id)
        })
        .collect::<Vec<_>>();
    events.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.to_hex().cmp(&right.id.to_hex()))
    });
    events.dedup_by_key(|event| event.id);
    Ok(events)
}

async fn discover_response_events(
    rest: &RestClient,
    channel_id: Uuid,
    turn_started_at: u64,
) -> Result<Vec<Event>, RelayError> {
    for delay in [
        Duration::ZERO,
        Duration::from_millis(250),
        Duration::from_millis(750),
        Duration::from_millis(1_500),
    ] {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let events = query_response_events(rest, channel_id, turn_started_at).await?;
        if !events.is_empty() {
            return Ok(events);
        }
    }
    // Bound read-after-write retries: a missing response must never fabricate
    // evidence or block the already-published human-facing response forever.
    Ok(Vec::new())
}

fn extraction_prompt(schema: u8, channel_id: Uuid, sources: &[String]) -> String {
    let sources = sources.join(", ");
    match schema {
        2 => format!(
            r#"[System: automatic DKG memory finalization]
The human-facing Buzz response for this turn was already published. Do not send another Buzz message and do not call any tool. Return exactly one JSON object, with no Markdown fence or surrounding prose, that captures the externally communicable semantics supported by the signed turn evidence.

Channel: {channel_id}
Evidence event IDs: {sources}

Use this schema:
{{"schemaVersion":2,"profiles":["dkg-memory@1"],"summary":"...","entities":[{{"id":"claim-1","type":"memory:Claim","name":"...","description":"..."}}],"relations":[],"model":"...","promptVersion":"agent-memory-post-turn-v1"}}

Always include dkg-memory@1. Add dkg-software@1 only for code, repositories, commits, reviews, tests, builds, deployments, or software components. Use only the ontology terms and canonical locator rules from your standing DKG instructions. Record decisions, claims, tasks, questions, people, projects, software entities, and their useful relationships. Even a short conversational answer should produce one concise evidence-backed claim. Never include hidden reasoning, chain-of-thought, credentials, secrets, private keys, tool traces, or facts not supported by this turn."#
        ),
        _ => format!(
            r#"[System: automatic DKG memory finalization]
The human-facing Buzz response for this turn was already published. Do not send another Buzz message and do not call any tool. Return exactly one JSON object, with no Markdown fence or surrounding prose, that captures the externally communicable semantics supported by the signed turn evidence.

Channel: {channel_id}
Evidence event IDs: {sources}

Use this schema:
{{"schemaVersion":1,"summary":"...","items":[{{"kind":"decision|claim|question|task|relationship","text":"..."}}],"model":"...","promptVersion":"agent-memory-post-turn-v1"}}

Even a short conversational answer should produce one concise evidence-backed item. Never include hidden reasoning, chain-of-thought, credentials, secrets, private keys, tool traces, or facts not supported by this turn."#
        ),
    }
}

fn json_object_slice(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, character) in text[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match character {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&text[start..start + offset + character.len_utf8()]);
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_proposal_output(text: &str, schema: u8) -> Result<String, String> {
    let candidate =
        json_object_slice(text).ok_or_else(|| "agent returned no JSON object".to_string())?;
    if candidate.len() > MAX_PROPOSAL_BYTES {
        return Err("agent memory proposal exceeds 64 KiB".into());
    }
    let value: Value = serde_json::from_str(candidate)
        .map_err(|error| format!("agent returned invalid proposal JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "agent memory proposal is not an object".to_string())?;
    if object.get("schemaVersion").and_then(Value::as_u64) != Some(u64::from(schema)) {
        return Err(format!(
            "agent memory proposal did not use schemaVersion {schema}"
        ));
    }
    let summary_ok = object
        .get("summary")
        .and_then(Value::as_str)
        .is_some_and(|summary| !summary.trim().is_empty() && summary.len() <= 1_000);
    if !summary_ok {
        return Err("agent memory proposal has an invalid summary".into());
    }
    let shape_ok = if schema == 2 {
        object
            .get("profiles")
            .and_then(Value::as_array)
            .is_some_and(|profiles| profiles.iter().any(|value| value == "dkg-memory@1"))
            && object
                .get("entities")
                .and_then(Value::as_array)
                .is_some_and(|entities| !entities.is_empty())
            && object.get("relations").and_then(Value::as_array).is_some()
    } else {
        object
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    };
    if !shape_ok {
        return Err("agent memory proposal is missing required semantic fields".into());
    }
    let lowered = candidate.to_ascii_lowercase();
    if ["nsec1", "private_key", "privatekey", "secret_key"]
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return Err("agent memory proposal appears to contain private key material".into());
    }
    serde_json::to_string(&value)
        .map_err(|error| format!("could not normalize agent memory proposal: {error}"))
}

fn outbox_dir(rest: &RestClient) -> PathBuf {
    if let Some(path) = std::env::var_os("BUZZ_DKG_MEMORY_OUTBOX_DIR") {
        return PathBuf::from(path);
    }
    let mut namespace = Sha256::new();
    namespace.update(rest.base_url.as_bytes());
    namespace.update(rest.keys.public_key().to_bytes());
    let namespace = hex::encode(namespace.finalize());
    platform_data_dir()
        .join("buzz")
        .join("dkg-memory-outbox")
        .join(&namespace[..24])
}

fn platform_data_dir() -> PathBuf {
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(path);
    }
    if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(path);
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        if cfg!(target_os = "macos") {
            return home.join("Library").join("Application Support");
        }
        return home.join(".local").join("share");
    }
    std::env::temp_dir()
}

fn persist_event(path: &Path, event: &Event) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "memory outbox path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| format!("create memory outbox: {error}"))?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let body = serde_json::to_vec(event)
        .map_err(|error| format!("serialize memory outbox event: {error}"))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("open memory outbox event: {error}"))?;
    use std::io::Write;
    if let Err(error) = file.write_all(&body).and_then(|_| file.sync_all()) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("persist memory outbox event: {error}"));
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        if !path.exists() {
            return Err(format!("commit memory outbox event: {error}"));
        }
    }
    Ok(())
}

async fn submit_persisted(rest: &RestClient, path: &Path, event: &Event) -> Result<(), String> {
    rest.submit_dkg_memory(event)
        .await
        .map_err(|error| error.to_string())?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove accepted memory outbox event: {error}")),
    }
}

/// Retry signed proposals left behind by a prior crash or transient outage.
pub(crate) async fn flush_outbox(rest: &RestClient) {
    let directory = outbox_dir(rest);
    let Ok(entries) = std::fs::read_dir(&directory) else {
        return;
    };
    let mut paths = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    for path in paths.into_iter().take(MAX_OUTBOX_DRAIN) {
        let event = match std::fs::read(&path)
            .map_err(|error| error.to_string())
            .and_then(|body| {
                serde_json::from_slice::<Event>(&body).map_err(|error| error.to_string())
            }) {
            Ok(event) if event.verify_id() && event.verify_signature() => event,
            Ok(_) | Err(_) => {
                tracing::error!(path = %path.display(), "invalid signed event in DKG memory outbox; leaving it for operator inspection");
                continue;
            }
        };
        match submit_persisted(rest, &path, &event).await {
            Ok(()) => {
                tracing::info!(proposal_event_id = %event.id, "retried DKG memory proposal from outbox")
            }
            Err(error) => {
                tracing::warn!(proposal_event_id = %event.id, %error, "DKG memory outbox retry remains pending");
                break;
            }
        }
    }
}

/// Retry pending proposals at startup and on a bounded cadence. The same
/// already-signed event is reused, so retries cannot create new graph writes.
pub(crate) async fn run_outbox_retry(rest: RestClient) {
    let mut interval = tokio::time::interval(OUTBOX_RETRY_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        flush_outbox(&rest).await;
    }
}

/// Finalize one successful channel response into signed semantic memory.
pub(crate) async fn finalize_turn(
    agent: &mut OwnedAgent,
    session_id: &str,
    ctx: &PromptContext,
    channel_id: Uuid,
    trigger_event_ids: &[String],
    turn_started_at: u64,
    schema: u8,
) -> PostTurnMemoryOutcome {
    if !matches!(schema, 1 | 2) {
        return PostTurnMemoryOutcome::Failed(format!(
            "relay advertised unsupported DKG memory schema {schema}"
        ));
    }
    let responses =
        match discover_response_events(&ctx.rest_client, channel_id, turn_started_at).await {
            Ok(events) => events,
            Err(error) => {
                return PostTurnMemoryOutcome::Failed(format!(
                    "could not discover the published agent response: {error}"
                ))
            }
        };
    if responses.is_empty() {
        return PostTurnMemoryOutcome::SkippedNoResponse;
    }
    let mut seen = HashSet::new();
    let sources = trigger_event_ids
        .iter()
        .cloned()
        .chain(responses.iter().map(|event| event.id.to_hex()))
        .filter(|event_id| seen.insert(event_id.clone()))
        .collect::<Vec<_>>();
    let prompt = extraction_prompt(schema, channel_id, &sources);
    let prompt_result = agent
        .acp
        .session_prompt_with_idle_timeout(
            session_id,
            &prompt,
            MEMORY_IDLE_TIMEOUT,
            MEMORY_HARD_TIMEOUT,
        )
        .await;
    if let Err(error) = prompt_result {
        if matches!(
            error,
            AcpError::IdleTimeout(_) | AcpError::HardTimeout { .. }
        ) {
            let _ = agent
                .acp
                .cancel_with_cleanup_grace(session_id, MEMORY_CANCEL_GRACE)
                .await;
            agent.state.invalidate_channel(&channel_id);
        }
        return PostTurnMemoryOutcome::Failed(format!("semantic extraction failed: {error}"));
    }
    let output = agent.acp.take_agent_message_text();
    let content = match parse_proposal_output(&output, schema) {
        Ok(content) => content,
        Err(error) => return PostTurnMemoryOutcome::Failed(error),
    };
    let mut tags = Vec::with_capacity(sources.len() + 2);
    let channel = channel_id.to_string();
    let channel_tag = match Tag::parse(["h", channel.as_str()]) {
        Ok(tag) => tag,
        Err(error) => {
            return PostTurnMemoryOutcome::Failed(format!("invalid channel tag: {error}"))
        }
    };
    tags.push(channel_tag);
    let proposal_tag = match Tag::parse(["t", "dkg-memory-proposal"]) {
        Ok(tag) => tag,
        Err(error) => {
            return PostTurnMemoryOutcome::Failed(format!("invalid proposal tag: {error}"))
        }
    };
    tags.push(proposal_tag);
    for source in &sources {
        let source_tag = match Tag::parse(["e", source, "", "source"]) {
            Ok(tag) => tag,
            Err(error) => {
                return PostTurnMemoryOutcome::Failed(format!("invalid source tag: {error}"))
            }
        };
        tags.push(source_tag);
    }
    let event = match EventBuilder::new(Kind::Custom(KIND_DKG_MEMORY_PROPOSAL), content)
        .tags(tags)
        .sign_with_keys(&ctx.agent_keys)
    {
        Ok(event) => event,
        Err(error) => {
            return PostTurnMemoryOutcome::Failed(format!("sign memory proposal: {error}"))
        }
    };
    let path = outbox_dir(&ctx.rest_client).join(format!("{}.json", event.id.to_hex()));
    if let Err(error) = persist_event(&path, &event) {
        return PostTurnMemoryOutcome::Failed(error);
    }
    match submit_persisted(&ctx.rest_client, &path, &event).await {
        Ok(()) => PostTurnMemoryOutcome::Stored {
            proposal_event_id: event.id.to_hex(),
        },
        Err(error) => PostTurnMemoryOutcome::Failed(format!(
            "proposal remains queued in the durable outbox: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_one_json_object_from_plain_or_fenced_output() {
        let plain = r#"{"schemaVersion":1,"summary":"x","items":[{"kind":"claim","text":"x"}]}"#;
        let expected: Value = serde_json::from_str(plain).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&parse_proposal_output(plain, 1).unwrap()).unwrap(),
            expected
        );
        let fenced = format!("```json\n{plain}\n```\n");
        assert_eq!(
            serde_json::from_str::<Value>(&parse_proposal_output(&fenced, 1).unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn response_query_uses_only_supported_buzz_message_kinds() {
        let kinds = response_kinds()
            .into_iter()
            .map(|kind| kind.as_u16())
            .collect::<Vec<_>>();
        assert_eq!(kinds, vec![9, 45001, 45003]);
        assert!(kinds
            .into_iter()
            .all(|kind| response_kind(Kind::Custom(kind))));
    }

    #[test]
    fn rejects_wrong_schema_missing_semantics_and_key_material() {
        assert!(parse_proposal_output(
            r#"{"schemaVersion":1,"summary":"x","items":[{"kind":"claim","text":"x"}]}"#,
            2,
        )
        .is_err());
        assert!(parse_proposal_output(
            r#"{"schemaVersion":2,"profiles":["dkg-memory@1"],"summary":"x","entities":[],"relations":[]}"#,
            2,
        )
        .is_err());
        assert!(parse_proposal_output(
            r#"{"schemaVersion":1,"summary":"private_key leaked","items":[{"kind":"claim","text":"x"}]}"#,
            1,
        )
        .is_err());
    }

    #[test]
    fn prompt_forbids_tools_and_second_chat_message() {
        let prompt = extraction_prompt(
            2,
            Uuid::parse_str("8e8cd542-e5d0-4f81-a060-e9980b20599d").unwrap(),
            &["a".repeat(64), "b".repeat(64)],
        );
        assert!(prompt.contains("Do not send another Buzz message"));
        assert!(prompt.contains("do not call any tool"));
        assert!(prompt.contains("schemaVersion\":2"));
    }
}
