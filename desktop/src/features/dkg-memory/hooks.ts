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

export function useChannelMemory(cg: string | null | undefined) {
  return useQuery({
    queryKey: ["dkg-memory", "memory", cg],
    queryFn: () => fetchChannelMemory(cg as string),
    enabled: Boolean(cg),
    refetchInterval: 30 * 1000,
  });
}

export function useContributorTrail(
  cg: string | null | undefined,
  pubkey: string | null,
) {
  return useQuery({
    queryKey: ["dkg-memory", "trail", cg, pubkey],
    queryFn: () => fetchContributorTrail(cg as string, pubkey as string),
    enabled: Boolean(cg && pubkey),
  });
}

import {
  fetchDiscoveryFromReceipts,
  fetchEvidence,
  fetchProfileNames,
  fetchSubgraphGraph,
} from "./api";

export function useEvidence(cg: string | null | undefined, uri: string | null) {
  return useQuery({
    queryKey: ["dkg-memory", "evidence", cg, uri],
    queryFn: () => fetchEvidence(cg as string, uri as string),
    enabled: Boolean(cg && uri),
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
  cg: string | null | undefined,
  name: string | null,
) {
  return useQuery({
    queryKey: ["dkg-memory", "graph", cg, name],
    queryFn: () => fetchSubgraphGraph(cg as string, name as string),
    enabled: Boolean(cg && name),
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
