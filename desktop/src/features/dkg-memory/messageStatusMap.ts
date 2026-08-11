import * as React from "react";

import {
  ensureRelayObserverSubscription,
  subscribeAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import type { TimelineMessage } from "@/features/messages/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { useDkgMemoryCapabilities } from "./hooks";
import {
  memoryStatusForMessage,
  type MessageMemoryStatus,
} from "./messageStatus";
import {
  createChannelMemoryEvidenceSelector,
  type AgentMemoryEvidenceMap,
} from "./observerEvidenceSelector";

export type AgentMessageMemoryStatus = {
  agentName: string;
  agentPubkey: string;
  status: MessageMemoryStatus;
};

export function useDkgMemoryExpectation(channelId: string | null): boolean {
  return useDkgMemoryCapabilities(channelId).data?.memory ?? false;
}

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
  const readEvidence = React.useMemo(
    () => createChannelMemoryEvidenceSelector(resolvedChannelId, agentPubkeys),
    [agentPubkeys, resolvedChannelId],
  );
  const evidenceByAgent = React.useSyncExternalStore(
    subscribeAgentObserverStore,
    readEvidence,
  );
  const hasAgentMessages = agentPubkeys.length > 0;

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
