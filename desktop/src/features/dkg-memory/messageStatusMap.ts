import * as React from "react";

import {
  ensureRelayObserverSubscription,
  getAgentObserverSnapshot,
  getAgentObserverStoreRevision,
  getAgentTranscript,
  subscribeAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import type {
  ObserverEvent,
  TranscriptItem,
} from "@/features/agents/ui/agentSessionTypes";
import type { TimelineMessage } from "@/features/messages/types";
import { getRelayHttpUrl } from "@/shared/api/tauri";
import {
  memoryStatusForMessage,
  type MessageMemoryStatus,
} from "./messageStatus";

export type AgentMessageMemoryStatus = {
  agentName: string;
  agentPubkey: string;
  status: MessageMemoryStatus;
};

type RelayCapabilityDocument = {
  supported_extensions?: unknown;
};

const capabilityByRelay = new Map<string, Promise<boolean>>();

export function advertisesDkgMemory(document: unknown): boolean {
  if (!document || typeof document !== "object") return false;
  const extensions = (document as RelayCapabilityDocument).supported_extensions;
  return (
    Array.isArray(extensions) &&
    extensions.some((entry) =>
      ["buzz-dkg-memory-v1", "buzz-dkg-memory-v2"].includes(String(entry)),
    )
  );
}

async function relayAdvertisesDkgMemory(): Promise<boolean> {
  const relay = (await getRelayHttpUrl()).replace(/\/+$/, "");
  const cached = capabilityByRelay.get(relay);
  if (cached) return cached;
  const request = fetch(`${relay}/`, {
    headers: { Accept: "application/nostr+json" },
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (response) =>
      response.ok ? advertisesDkgMemory(await response.json()) : false,
    )
    .catch(() => false);
  capabilityByRelay.set(relay, request);
  return request;
}

function useDkgMemoryExpectation(channelId: string | null): boolean {
  const [expected, setExpected] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setExpected(false);
    if (!channelId) return () => undefined;
    void relayAdvertisesDkgMemory().then((advertised) => {
      if (!cancelled) setExpected(advertised);
    });
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  return expected;
}

type StatusReaders = {
  transcriptForAgent?: (pubkey: string) => readonly TranscriptItem[];
  observerEventsForAgent?: (pubkey: string) => readonly ObserverEvent[];
};

/**
 * Derive every visible agent-message badge in one channel-level pass. A relay
 * that does not advertise DKG memory produces no badges, so a normal agent
 * response is never misreported as a failed graph write.
 */
export function buildMessageMemoryStatusMap(
  channelId: string | null,
  messages: readonly TimelineMessage[],
  memoryExpected: boolean,
  readers: StatusReaders = {},
): ReadonlyMap<string, AgentMessageMemoryStatus> {
  if (!channelId || !memoryExpected) return new Map();
  const transcriptForAgent =
    readers.transcriptForAgent ??
    ((pubkey: string) => getAgentTranscript(pubkey));
  const observerEventsForAgent =
    readers.observerEventsForAgent ??
    ((pubkey: string) => getAgentObserverSnapshot(pubkey).events);
  const completedTurnsByAgent = new Map<string, ReadonlySet<string>>();
  const transcriptsByAgent = new Map<string, readonly TranscriptItem[]>();
  const result = new Map<string, AgentMessageMemoryStatus>();

  for (const message of messages) {
    if (!message.isAgent || !message.signerPubkey) continue;
    const agentPubkey = message.signerPubkey;
    let transcript = transcriptsByAgent.get(agentPubkey);
    if (!transcript) {
      transcript = transcriptForAgent(agentPubkey);
      transcriptsByAgent.set(agentPubkey, transcript);
    }
    let completedTurnIds = completedTurnsByAgent.get(agentPubkey);
    if (!completedTurnIds) {
      completedTurnIds = new Set(
        observerEventsForAgent(agentPubkey)
          .filter(
            (event) =>
              event.channelId === channelId &&
              event.turnId &&
              ["turn_completed", "turn_error", "agent_panic"].includes(
                event.kind,
              ),
          )
          .map((event) => event.turnId as string),
      );
      completedTurnsByAgent.set(agentPubkey, completedTurnIds);
    }
    const status = memoryStatusForMessage(
      transcript,
      channelId,
      message.id,
      completedTurnIds,
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
  const revision = React.useSyncExternalStore(
    subscribeAgentObserverStore,
    getAgentObserverStoreRevision,
  );
  const hasAgentMessages = messages.some(
    (message) => message.isAgent && message.signerPubkey,
  );

  React.useEffect(() => {
    if (memoryExpected && hasAgentMessages) {
      void ensureRelayObserverSubscription();
    }
  }, [hasAgentMessages, memoryExpected]);

  return React.useMemo(() => {
    void revision;
    return buildMessageMemoryStatusMap(
      resolvedChannelId,
      messages,
      memoryExpected,
    );
  }, [memoryExpected, messages, resolvedChannelId, revision]);
}
