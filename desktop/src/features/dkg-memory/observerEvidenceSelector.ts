import {
  createAgentObserverStoreSelector,
  getAgentObserverSnapshot,
  getAgentTranscript,
} from "@/features/agents/observerRelayStore";
import type { TranscriptItem } from "@/features/agents/ui/agentSessionTypes";
import { normalizePubkey } from "@/shared/lib/pubkey";

export type AgentMemoryEvidence = {
  completedTurnIds: ReadonlySet<string>;
  transcript: readonly TranscriptItem[];
};

export type AgentMemoryEvidenceMap = ReadonlyMap<string, AgentMemoryEvidence>;

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function sameEvidence(
  left: AgentMemoryEvidenceMap,
  right: AgentMemoryEvidenceMap,
): boolean {
  if (left.size !== right.size) return false;
  for (const [pubkey, leftEvidence] of left) {
    const rightEvidence = right.get(pubkey);
    if (
      !rightEvidence ||
      !sameSet(leftEvidence.completedTurnIds, rightEvidence.completedTurnIds) ||
      !sameItems(leftEvidence.transcript, rightEvidence.transcript)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Project DKG-specific evidence through the observer store's canonical
 * reference-stable selector helper. No caller-shaped state is kept globally.
 */
export function createChannelMemoryEvidenceSelector(
  channelId: string | null,
  agentPubkeys: readonly string[],
): () => AgentMemoryEvidenceMap {
  const keys = [...new Set(agentPubkeys.map(normalizePubkey))].sort();
  const empty: AgentMemoryEvidenceMap = new Map();
  if (!channelId || keys.length === 0) return () => empty;

  return createAgentObserverStoreSelector(() => {
    const snapshot = new Map<string, AgentMemoryEvidence>();
    for (const key of keys) {
      const completedTurnIds = new Set<string>();
      for (const event of getAgentObserverSnapshot(key).events) {
        if (
          event.channelId === channelId &&
          event.turnId &&
          ["turn_completed", "turn_error", "agent_panic"].includes(event.kind)
        ) {
          completedTurnIds.add(event.turnId);
        }
      }
      snapshot.set(key, {
        completedTurnIds,
        transcript: getAgentTranscript(key).filter(
          (item) => item.channelId === channelId,
        ),
      });
    }
    return snapshot;
  }, sameEvidence);
}
