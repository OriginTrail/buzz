import { useQuery } from "@tanstack/react-query";
import { getRelayHttpUrl } from "@/shared/api/tauri";
import {
  deriveContextGraphId,
  fetchChannelMemory,
  fetchContributorTrail,
} from "./api";
import { fetchDkgMemoryCapabilities } from "./capabilities";

const CAPABILITY_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;

function useRelayHttpUrl({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ["dkg-memory", "relay-http"],
    queryFn: getRelayHttpUrl,
    enabled,
    select: (relay) => relay.replace(/\/+$/, ""),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

async function fetchRelayCapabilities(relay: string | null) {
  if (!relay) throw new Error("Relay URL is unavailable.");
  return fetchDkgMemoryCapabilities(relay);
}

export function useDkgMemoryCapabilities({ enabled }: { enabled: boolean }) {
  const relayQuery = useRelayHttpUrl({ enabled });
  const relay = relayQuery.data ?? null;

  return useQuery({
    queryKey: ["dkg-memory", "capabilities", relay],
    queryFn: () => fetchRelayCapabilities(relay),
    enabled: Boolean(enabled && relay),
    retry: CAPABILITY_RETRY_DELAYS_MS.length,
    retryDelay: (attempt) =>
      CAPABILITY_RETRY_DELAYS_MS[
        Math.min(attempt, CAPABILITY_RETRY_DELAYS_MS.length - 1)
      ],
    staleTime: 5 * 60 * 1_000,
  });
}

export function useChannelContextGraph(channelId: string | null) {
  return useQuery({
    queryKey: ["dkg-memory", "cg", channelId],
    queryFn: () => deriveContextGraphId(channelId as string),
    enabled: Boolean(channelId),
    staleTime: 5 * 60 * 1000,
  });
}

export function useChannelMemory(
  channelId: string | null,
  cg: string | null | undefined,
  bindingResolved: boolean,
) {
  return useQuery({
    queryKey: ["dkg-memory", "memory", channelId, cg],
    queryFn: () => fetchChannelMemory(channelId as string, cg ?? null),
    enabled: Boolean(channelId) && bindingResolved,
    refetchInterval: 30 * 1000,
  });
}

export function useContributorTrail(
  channelId: string | null,
  cg: string | null | undefined,
  pubkey: string | null,
) {
  return useQuery({
    queryKey: ["dkg-memory", "trail", channelId, cg, pubkey],
    queryFn: () =>
      fetchContributorTrail(channelId as string, cg ?? null, pubkey as string),
    enabled: Boolean(channelId && pubkey),
  });
}

import {
  fetchDiscoveryFromReceipts,
  fetchEvidence,
  fetchProfileNames,
  fetchSubgraphGraph,
} from "./api";

export function useEvidence(
  channelId: string | null,
  cg: string | null | undefined,
  uri: string | null,
) {
  return useQuery({
    queryKey: ["dkg-memory", "evidence", channelId, cg, uri],
    queryFn: () =>
      fetchEvidence(channelId as string, cg ?? null, uri as string),
    enabled: Boolean(channelId && uri),
    staleTime: 60 * 1000,
  });
}

export function useProfileNames(pubkeys: string[]) {
  return useQuery({
    queryKey: ["dkg-memory", "profiles", pubkeys.join(",")],
    queryFn: () => fetchProfileNames(pubkeys),
    enabled: pubkeys.length > 0,
    staleTime: 10 * 60 * 1000,
  });
}

export function useSubgraphGraph(
  channelId: string | null,
  cg: string | null | undefined,
  name: string | null,
) {
  return useQuery({
    queryKey: ["dkg-memory", "graph", channelId, cg, name],
    queryFn: () =>
      fetchSubgraphGraph(channelId as string, cg ?? null, name as string),
    enabled: Boolean(channelId && name),
    staleTime: 30 * 1000,
  });
}

export function useDiscoveryFallback(
  channelId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["dkg-memory", "discovery", channelId],
    queryFn: () => fetchDiscoveryFromReceipts(channelId as string),
    enabled: Boolean(channelId) && enabled,
    staleTime: 60 * 1000,
  });
}
