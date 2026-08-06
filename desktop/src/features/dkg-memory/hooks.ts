import { useQuery } from "@tanstack/react-query";
import {
  deriveContextGraphId,
  fetchChannelMemory,
  fetchContributorTrail,
} from "./api";

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
