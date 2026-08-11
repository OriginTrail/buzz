import * as React from "react";

import {
  ensureRelayObserverSubscription,
  subscribeAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import type { TimelineMessage } from "@/features/messages/types";
import { getRelayHttpUrl } from "@/shared/api/tauri";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { readDkgMemoryCapabilities } from "./capabilities";
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

async function relayAdvertisesDkgMemory(): Promise<boolean> {
  const relay = (await getRelayHttpUrl()).replace(/\/+$/, "");
  return (await readDkgMemoryCapabilities(relay)).memory;
}

const CAPABILITY_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;

export function useDkgMemoryExpectation(channelId: string | null): boolean {
  const [expected, setExpected] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setExpected(false);
    if (!channelId) return () => undefined;

    const discover = () => {
      void relayAdvertisesDkgMemory()
        .then((advertised) => {
          if (!cancelled) setExpected(advertised);
        })
        .catch(() => {
          if (cancelled) return;
          const delay =
            CAPABILITY_RETRY_DELAYS_MS[
              Math.min(retryAttempt, CAPABILITY_RETRY_DELAYS_MS.length - 1)
            ];
          retryAttempt += 1;
          retryTimer = setTimeout(discover, delay);
        });
    };
    discover();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [channelId]);

  return expected;
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
