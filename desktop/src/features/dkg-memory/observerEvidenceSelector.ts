import {
  getAgentObserverSnapshot,
  getAgentTranscript,
} from "@/features/agents/observerRelayStore";
import type {
  ObserverEvent,
  TranscriptItem,
} from "@/features/agents/ui/agentSessionTypes";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type AgentMemoryEvidence = {
  completedTurnIds: ReadonlySet<string>;
  transcript: readonly TranscriptItem[];
};

export type AgentMemoryEvidenceMap = ReadonlyMap<string, AgentMemoryEvidence>;

type AgentEvidenceCache = {
  channelEvents: readonly ObserverEvent[];
  channelTranscript: readonly TranscriptItem[];
  evidence: AgentMemoryEvidence;
  sourceEvents: readonly ObserverEvent[];
  sourceTranscript: readonly TranscriptItem[];
};

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function completedTurnIds(
  events: readonly ObserverEvent[],
): ReadonlySet<string> {
  return new Set(
    events
      .filter(
        (event) =>
          event.turnId &&
          ["turn_completed", "turn_error", "agent_panic"].includes(event.kind),
      )
      .map((event) => event.turnId as string),
  );
}

/**
 * Create a reference-stable selector owned by one DKG message-status hook.
 * The observer store remains the canonical raw source; unrelated agents and
 * channels reuse the previous evidence map instead of invalidating the view.
 */
export function createChannelMemoryEvidenceSelector(
  channelId: string | null,
  agentPubkeys: readonly string[],
): () => AgentMemoryEvidenceMap {
  const keys = [...new Set(agentPubkeys.map(normalizePubkey))].sort();
  const empty: AgentMemoryEvidenceMap = new Map();
  let previous:
    | {
        entries: ReadonlyMap<string, AgentEvidenceCache>;
        snapshot: AgentMemoryEvidenceMap;
      }
    | undefined;

  return () => {
    if (!channelId || keys.length === 0) return empty;
    const entries = new Map<string, AgentEvidenceCache>();
    let changed = !previous || previous.entries.size !== keys.length;

    for (const key of keys) {
      const sourceEvents = getAgentObserverSnapshot(key).events;
      const sourceTranscript = getAgentTranscript(key);
      const cached = previous?.entries.get(key);
      if (
        cached &&
        cached.sourceEvents === sourceEvents &&
        cached.sourceTranscript === sourceTranscript
      ) {
        entries.set(key, cached);
        continue;
      }

      const channelEvents = sourceEvents.filter(
        (event) => event.channelId === channelId,
      );
      const channelTranscript = sourceTranscript.filter(
        (item) => item.channelId === channelId,
      );
      const evidence =
        cached &&
        sameItems(cached.channelEvents, channelEvents) &&
        sameItems(cached.channelTranscript, channelTranscript)
          ? cached.evidence
          : {
              completedTurnIds: completedTurnIds(channelEvents),
              transcript: channelTranscript,
            };
      if (evidence !== cached?.evidence) changed = true;
      entries.set(key, {
        channelEvents,
        channelTranscript,
        evidence,
        sourceEvents,
        sourceTranscript,
      });
    }

    if (!changed && previous) {
      previous = { entries, snapshot: previous.snapshot };
      return previous.snapshot;
    }
    const snapshot = new Map<string, AgentMemoryEvidence>();
    for (const key of keys) {
      const entry = entries.get(key);
      if (entry) snapshot.set(key, entry.evidence);
    }
    previous = { entries, snapshot };
    return snapshot;
  };
}
