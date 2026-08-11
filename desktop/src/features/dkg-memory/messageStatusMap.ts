import * as React from "react";

import {
  ensureRelayObserverSubscription,
  getAgentObserverChannelSnapshot,
  subscribeAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import type { TranscriptItem } from "@/features/agents/ui/agentSessionTypes";
import type { TimelineMessage } from "@/features/messages/types";
import { getRelayHttpUrl } from "@/shared/api/tauri";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { readDkgMemoryCapabilities } from "./capabilities";
import {
  memoryStatusForMessage,
  type MessageMemoryStatus,
} from "./messageStatus";

export type AgentMessageMemoryStatus = {
  agentName: string;
  agentPubkey: string;
  status: MessageMemoryStatus;
};

async function relayAdvertisesDkgMemory(): Promise<boolean> {
  const relay = (await getRelayHttpUrl()).replace(/\/+$/, "");
  return (await readDkgMemoryCapabilities(relay)).memory;
}

function useDkgMemoryExpectation(channelId: string | null): boolean {
  const [expected, setExpected] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setExpected(false);
    if (!channelId) return () => undefined;
    void relayAdvertisesDkgMemory()
      .then((advertised) => {
        if (!cancelled) setExpected(advertised);
      })
      .catch(() => {
        if (!cancelled) setExpected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  return expected;
}

export type AgentMemoryEvidence = {
  completedTurnIds: ReadonlySet<string>;
  transcript: readonly TranscriptItem[];
};

export type AgentMemoryEvidenceMap = ReadonlyMap<string, AgentMemoryEvidence>;

/**
 * Derive every visible agent-message badge in one channel-level pass. A relay
 * that does not advertise DKG memory produces no badges, so a normal agent
 * response is never misreported as a failed graph write.
 */
export function buildMessageMemoryStatusMap(
  channelId: string | null,
  messages: readonly TimelineMessage[],
  memoryExpected: boolean,
  evidenceByAgent: AgentMemoryEvidenceMap,
): ReadonlyMap<string, AgentMessageMemoryStatus> {
  if (!channelId || !memoryExpected) return new Map();
  const result = new Map<string, AgentMessageMemoryStatus>();

  for (const message of messages) {
    if (!message.isAgent || !message.signerPubkey) continue;
    const agentPubkey = message.signerPubkey;
    const evidence = evidenceByAgent.get(normalizePubkey(agentPubkey));
    if (!evidence) continue;
    const status = memoryStatusForMessage(
      evidence.transcript,
      channelId,
      message.id,
      evidence.completedTurnIds,
    );
    if (status) {
      result.set(message.id, {
        agentName: message.author,
        agentPubkey,
        status,
      });
    }
  }

  return result;
}

export function useMessageMemoryStatusMap(
  channelId: string | null | undefined,
  messages: readonly TimelineMessage[],
): ReadonlyMap<string, AgentMessageMemoryStatus> {
  const resolvedChannelId = channelId ?? null;
  const memoryExpected = useDkgMemoryExpectation(resolvedChannelId);
  const agentPubkeysKey = React.useMemo(
    () =>
      [
        ...new Set(
          messages
            .filter((message) => message.isAgent && message.signerPubkey)
            .map((message) => normalizePubkey(message.signerPubkey as string)),
        ),
      ]
        .sort()
        .join("\u0000"),
    [messages],
  );
  const agentPubkeys = React.useMemo(
    () => (agentPubkeysKey ? agentPubkeysKey.split("\u0000") : []),
    [agentPubkeysKey],
  );
  const readObserverSnapshot = React.useCallback(
    () => getAgentObserverChannelSnapshot(resolvedChannelId, agentPubkeys),
    [agentPubkeys, resolvedChannelId],
  );
  const observerSnapshot = React.useSyncExternalStore(
    subscribeAgentObserverStore,
    readObserverSnapshot,
  );
  const hasAgentMessages = agentPubkeys.length > 0;
  const evidenceByAgent = React.useMemo<AgentMemoryEvidenceMap>(() => {
    const result = new Map<string, AgentMemoryEvidence>();
    for (const [pubkey, snapshot] of observerSnapshot) {
      result.set(pubkey, {
        completedTurnIds: new Set(
          snapshot.events
            .filter(
              (event) =>
                event.turnId &&
                ["turn_completed", "turn_error", "agent_panic"].includes(
                  event.kind,
                ),
            )
            .map((event) => event.turnId as string),
        ),
        transcript: snapshot.transcript,
      });
    }
    return result;
  }, [observerSnapshot]);

  React.useEffect(() => {
    if (memoryExpected && hasAgentMessages) {
      void ensureRelayObserverSubscription();
    }
  }, [hasAgentMessages, memoryExpected]);

  return React.useMemo(() => {
    return buildMessageMemoryStatusMap(
      resolvedChannelId,
      messages,
      memoryExpected,
      evidenceByAgent,
    );
  }, [evidenceByAgent, memoryExpected, messages, resolvedChannelId]);
}
