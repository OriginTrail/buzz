import { useQuery } from "@tanstack/react-query";
import { getRelayHttpUrl } from "@/shared/api/tauri";
import {
  deriveContextGraphId,
  fetchChannelMemory,
  fetchContributorTrail,
  fetchReputationSummary,
  fetchTrustNetwork,
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

export function useTrustNetwork(channelId: string | null) {
  return useQuery({
    queryKey: ["dkg-memory", "trust-network", channelId],
    queryFn: () => fetchTrustNetwork(channelId as string),
    enabled: Boolean(channelId),
    refetchInterval: 30 * 1000,
  });
}

export function useReputationSummary(
  channelId: string | null,
  pubkey: string | null,
) {
  return useQuery({
    queryKey: ["dkg-memory", "reputation-summary", channelId, pubkey],
    queryFn: () =>
      fetchReputationSummary(channelId as string, pubkey as string),
    enabled: Boolean(channelId && pubkey),
    staleTime: 30 * 1_000,
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

import type { DecisionEntry } from "./api";
import { fetchDecisionsEvidence } from "./api";
import {
  buildContributorGraph,
  buildDecisionsGraph,
  type LensGraph,
} from "./lensGraphs";

/**
 * Enrich the all-decisions lens with evidence envelopes. Keyed by the decision
 * URI set so a re-render with the same lens does not refetch the fan-out.
 */
export function useDecisionsGraph(
  channelId: string | null,
  cg: string | null | undefined,
  decisions: DecisionEntry[] | null,
) {
  const uriKey = (decisions ?? []).map((decision) => decision.uri).join(",");
  return useQuery<LensGraph>({
    queryKey: ["dkg-memory", "decisions-graph", channelId, cg, uriKey],
    queryFn: async () => {
      const list = decisions as DecisionEntry[];
      const envelopes = await fetchDecisionsEvidence(
        channelId as string,
        cg ?? null,
        list,
      );
      return buildDecisionsGraph(list, envelopes);
    },
    enabled: Boolean(channelId && decisions && decisions.length > 0),
    staleTime: 60 * 1000,
  });
}

/** One participant's trail, shaped for the Traces/Graph overlay. */
export function useContributorGraph(
  channelId: string | null,
  cg: string | null | undefined,
  pubkey: string | null,
) {
  return useQuery<LensGraph>({
    queryKey: ["dkg-memory", "contributor-graph", channelId, cg, pubkey],
    queryFn: async () => {
      const trail = await fetchContributorTrail(
        channelId as string,
        cg ?? null,
        pubkey as string,
      );
      return buildContributorGraph(trail);
    },
    enabled: Boolean(channelId && pubkey),
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

import { fetchEntityCounts } from "./api";

/**
 * Entity counts for the panel's sub-graph chips and layer cards (issue
 * buzz-dkg-beta#13). Keyed by the contributor set so a membership change
 * refreshes the per-agent battery; cached because the counts only move when
 * something is captured.
 */
export function useEntityCounts(
  channelId: string | null,
  contributorPubkeys: string[],
) {
  const pubkeyKey = [...contributorPubkeys].sort().join(",");
  return useQuery({
    queryKey: ["dkg-memory", "entity-counts", channelId, pubkeyKey],
    queryFn: () =>
      fetchEntityCounts(channelId as string, [...contributorPubkeys].sort()),
    enabled: Boolean(channelId),
    staleTime: 60 * 1000,
  });
}
