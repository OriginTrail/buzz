//! Canonical bounded query builders used by ACP DKG consumers.

use std::collections::HashSet;

use serde_json::Value;

use crate::queue::FlushBatch;

const AUTOMATIC_RECALL_TERM_LIMIT: usize = 2;
pub(crate) const AUTOMATIC_RECALL_ROW_LIMIT: usize = 6;

pub(crate) struct AutomaticRecallQuery {
    pub(crate) terms: Vec<String>,
    pub(crate) request: Value,
}

fn is_stop_word(word: &str) -> bool {
    matches!(
        word,
        "about"
            | "after"
            | "again"
            | "also"
            | "and"
            | "are"
            | "can"
            | "channel"
            | "check"
            | "could"
            | "did"
            | "does"
            | "doing"
            | "for"
            | "from"
            | "have"
            | "help"
            | "hello"
            | "hey"
            | "how"
            | "into"
            | "just"
            | "like"
            | "make"
            | "need"
            | "now"
            | "okay"
            | "please"
            | "should"
            | "some"
            | "sure"
            | "that"
            | "thank"
            | "thanks"
            | "the"
            | "their"
            | "then"
            | "there"
            | "they"
            | "this"
            | "use"
            | "want"
            | "what"
            | "when"
            | "where"
            | "which"
            | "will"
            | "with"
            | "would"
            | "yeah"
            | "yes"
            | "you"
            | "your"
    )
}

fn recall_terms(batch: &FlushBatch) -> Vec<String> {
    let mut terms = Vec::new();
    let mut seen = HashSet::new();
    for event in batch
        .events
        .iter()
        .rev()
        .chain(batch.cancelled_events.iter().rev())
    {
        for raw in event.event.content.split(|character: char| {
            !(character.is_alphanumeric()
                || matches!(character, '_' | '-' | '.' | '/' | ':' | '#' | '@'))
        }) {
            let word = raw
                .trim_matches(|character: char| matches!(character, '.' | '/' | ':' | '#'))
                .to_lowercase();
            if word.len() < 3
                || word.len() > 80
                || word.starts_with('@')
                || word.chars().all(|character| character.is_ascii_digit())
                || is_stop_word(&word)
                || !seen.insert(word.clone())
            {
                continue;
            }
            terms.push(word);
            if terms.len() == AUTOMATIC_RECALL_TERM_LIMIT {
                return terms;
            }
        }
    }
    terms
}

fn entity_search_sparql(terms: &[String]) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    let filters = terms
        .iter()
        .map(|term| {
            let literal = serde_json::to_string(term).unwrap_or_else(|_| "\"\"".to_string());
            format!(
                "(CONTAINS(LCASE(STR(?name)), {literal}) || CONTAINS(LCASE(COALESCE(STR(?description), \"\")), {literal}))"
            )
        })
        .collect::<Vec<_>>()
        .join(" || ");
    Some(format!(
        "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n\
         PREFIX schema: <http://schema.org/>\n\
         SELECT DISTINCT ?entity ?name ?description ?type WHERE {{\n\
           GRAPH ?g {{\n\
             ?entity schema:name ?name .\n\
             OPTIONAL {{ ?entity schema:description ?description . }}\n\
             OPTIONAL {{ ?entity rdf:type ?type . }}\n\
             FILTER({filters})\n\
           }}\n\
         }}\n\
         LIMIT {AUTOMATIC_RECALL_ROW_LIMIT}"
    ))
}

pub(crate) fn automatic_recall_query(batch: &FlushBatch) -> Option<AutomaticRecallQuery> {
    let terms = recall_terms(batch);
    let sparql = entity_search_sparql(&terms)?;
    Some(AutomaticRecallQuery {
        terms,
        request: serde_json::json!({
            "channelId": batch.channel_id.to_string(),
            "operation": "semantic_query",
            "scope": { "type": "current_channel" },
            "arguments": { "sparql": sparql, "view": "shared" }
        }),
    })
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, Keys, Kind};
    use uuid::Uuid;

    use super::*;
    use crate::queue::BatchEvent;

    fn batch(content: &str) -> FlushBatch {
        let event = EventBuilder::new(Kind::Custom(9), content)
            .sign_with_keys(&Keys::generate())
            .expect("signed event");
        FlushBatch {
            channel_id: Uuid::new_v4(),
            events: vec![BatchEvent {
                event,
                prompt_tag: "mention".to_string(),
                received_at: std::time::Instant::now(),
            }],
            cancelled_events: vec![],
            cancel_reason: None,
        }
    }

    #[test]
    fn automatic_recall_is_bounded_and_current_channel_scoped() {
        let batch = batch(
            "@Fizz please check the x402 payment decision and verifyToken implementation now",
        );
        let query = automatic_recall_query(&batch).expect("query");
        assert_eq!(query.terms, vec!["x402", "payment"]);
        assert_eq!(query.request["channelId"], batch.channel_id.to_string());
        assert_eq!(query.request["operation"], "semantic_query");
        assert_eq!(query.request["scope"]["type"], "current_channel");
        let sparql = query.request["arguments"]["sparql"]
            .as_str()
            .expect("sparql");
        assert!(sparql.contains("schema:name"));
        assert!(sparql.contains("\"x402\""));
        assert!(sparql.ends_with("LIMIT 6"));
        assert!(!sparql.contains(&batch.channel_id.to_string()));
    }
}
