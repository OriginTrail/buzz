//! Agent-native DKG memory proposals.

use std::collections::HashSet;

use nostr::{EventBuilder, Kind, Tag};

use crate::client::BuzzClient;
use crate::error::CliError;
use crate::validate::{read_file_or_stdin, validate_hex64, validate_uuid};
use crate::MemoryCmd;

const KIND_DKG_MEMORY_PROPOSAL: u16 = 40009;
const MAX_SOURCES: usize = 16;

pub async fn dispatch(command: MemoryCmd, client: &BuzzClient) -> Result<(), CliError> {
    match command {
        MemoryCmd::Propose {
            channel,
            source,
            input,
        } => propose(client, &channel, &source, &input).await,
    }
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
    if object
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err(CliError::Usage(
            "memory proposal schemaVersion must be 1".into(),
        ));
    }
    let summary = object
        .get("summary")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if summary.trim().is_empty() || summary.len() > 1_000 {
        return Err(CliError::Usage(
            "memory proposal summary must contain 1..=1000 bytes".into(),
        ));
    }
    let items = object
        .get("items")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| CliError::Usage("memory proposal items must be an array".into()))?;
    if items.is_empty() || items.len() > 50 {
        return Err(CliError::Usage(
            "memory proposal items must contain 1..=50 entries".into(),
        ));
    }
    Ok(())
}

async fn propose(
    client: &BuzzClient,
    channel: &str,
    sources: &[String],
    input: &str,
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
    let response = client.post_authed_json("/api/dkg/memory", &value).await?;
    println!("{response}");
    Ok(())
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
    }
}
