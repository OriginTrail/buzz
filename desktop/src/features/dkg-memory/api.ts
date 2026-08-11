// Data access for the Buzz-native DKG memory panel.
//
// Reads prefer the viewer's own local explorer/edge node, then use the active
// community relay's authenticated DKG provider. Receipts remain a discovery
// and display fallback; their Context Graph id is never sent as remote
// authorization input.
import { relayClient } from "@/shared/api/relayClient";
import { getRelayHttpUrl, signRelayEvent } from "@/shared/api/tauri";
import { readDkgMemoryCapabilities } from "./capabilities";
import { postAuthenticatedDkgJson, queryDkgProvider } from "./provider";
import {
  memoryProposalProgress,
  normalizedMemoryProposalState,
} from "./proposalState";

export {
  explorerSource,
  resetDkgMemoryProvider,
  type ExplorerSource,
} from "./provider";

export type MemoryGate = "ok" | "node-missing" | "auth" | "not-subscribed";

export interface LayerEntry {
  graph: string;
  label: string;
}

export interface DecisionEntry {
  uri: string;
  name: string | null;
  digest: string | null;
  at: string | null;
}

export interface ContributorEntry {
  pubkey: string;
  events: number;
  latest: number | null;
}

export interface SubGraphEntry {
  name: string;
  uri: string;
  entityCount: number;
  tripleCount: number;
}

export interface ChannelMemory {
  gate: MemoryGate;
  cg?: string;
  /** Layer graph lists are display-bounded; the *Count fields are uncapped. */
  layers?: Record<"WM" | "SWM" | "VM", LayerEntry[] | null> &
    Partial<Record<"WMCount" | "SWMCount" | "VMCount", number>>;
  decisions?: DecisionEntry[];
  contributors?: ContributorEntry[];
  subgraphs?: SubGraphEntry[];
}

export interface TrailEntry {
  event: string;
  content: string | null;
  at: number | null;
  decision: string | null;
  decisionName: string | null;
}

export interface SoftwareContributor {
  contributor: string;
  contributorName: string | null;
  commit: string;
  sha: string;
  at: number | null;
  layer: "SWM" | "VM";
}

export interface SoftwareContributors {
  gate: MemoryGate;
  cg?: string;
  repository: string;
  componentName: string;
  componentType: string | null;
  contributors: SoftwareContributor[];
}

export interface DecisionTraceEntry {
  decision: string;
  decisionName: string | null;
  context: string | null;
  outcome: string | null;
  commit: string;
  sha: string;
  component: string;
  layer: "SWM" | "VM";
}

export interface DecisionTrace {
  gate: MemoryGate;
  cg?: string;
  repository: string;
  commitSha: string;
  componentName: string;
  decisions: DecisionTraceEntry[];
}

export interface SemanticQueryLayer {
  layer: "SWM" | "VM";
  bindings: Record<string, unknown>[];
  quads?: unknown[];
}

export interface SemanticQueryResult {
  gate: MemoryGate;
  cg?: string;
  queryType: "select" | "ask" | "construct";
  scope: { type: "current_channel" };
  cost?: {
    score: number;
    budget: number;
    metrics?: Record<string, number>;
  };
  layers: SemanticQueryLayer[];
}

export type DkgDiagnosticStatus = "pass" | "fail" | "skipped";

export interface DkgDiagnosticCheck {
  id: "relay" | "identity" | "graph" | "query";
  label: string;
  status: DkgDiagnosticStatus;
  detail: string;
  durationMs?: number;
}

export interface DkgDiagnosticReport {
  checkedAt: string;
  relay: string;
  channelId: string;
  checks: DkgDiagnosticCheck[];
}

export async function fetchSemanticQuery(
  channelId: string,
  sparql: string,
  view: "both" | "shared" | "verified" = "both",
): Promise<SemanticQueryResult> {
  return queryDkgProvider<SemanticQueryResult, "semantic_query">({
    channelId,
    operation: "semantic_query",
    arguments: { sparql, view },
    localPath: null,
  });
}

function diagnosticError(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  return "The check did not return a usable response.";
}

async function timedDiagnostic<T>(
  run: () => Promise<T>,
): Promise<{ value?: T; error?: string; durationMs: number }> {
  const started = performance.now();
  try {
    return { value: await run(), durationMs: performance.now() - started };
  } catch (cause) {
    return {
      error: diagnosticError(cause),
      durationMs: performance.now() - started,
    };
  }
}

/**
 * Exercise the same public, authenticated path the desktop and agents use.
 * The report contains no credentials, graph IDs, or Nostr private material and
 * is safe for a community member to copy into a support message.
 */
export async function runDkgDiagnostics(
  channelId: string,
): Promise<DkgDiagnosticReport> {
  const relay = (await getRelayHttpUrl()).replace(/\/+$/, "");
  const checks: DkgDiagnosticCheck[] = [];
  const capability = await timedDiagnostic(async () => {
    const discovered = await readDkgMemoryCapabilities(relay);
    if (!discovered.memory || !discovered.semanticQuery) {
      throw new Error(
        "Relay does not advertise the required DKG memory capabilities.",
      );
    }
  });
  checks.push({
    id: "relay",
    label: "Relay capability",
    status: capability.error ? "fail" : "pass",
    detail:
      capability.error ?? "DKG memory and semantic queries are advertised.",
    durationMs: Math.round(capability.durationMs),
  });

  const channel = await timedDiagnostic(() =>
    fetchChannelMemory(channelId, null),
  );
  const channelReady = channel.value?.gate === "ok";
  checks.push({
    id: "identity",
    label: "Buzz identity",
    status: channel.error ? "fail" : "pass",
    detail:
      channel.error ??
      "The relay accepted this app identity for an authenticated DKG request.",
    durationMs: Math.round(channel.durationMs),
  });
  checks.push({
    id: "graph",
    label: "Channel Context Graph",
    status: channelReady ? "pass" : "fail",
    detail: channelReady
      ? "The relay resolved this channel to an accessible Context Graph."
      : channel.error
        ? "The authenticated channel check could not complete."
        : `The memory provider returned gate: ${channel.value?.gate ?? "unknown"}.`,
    durationMs: Math.round(channel.durationMs),
  });

  if (channelReady) {
    const query = await timedDiagnostic(() =>
      fetchSemanticQuery(
        channelId,
        `PREFIX schema: <http://schema.org/>\nASK WHERE { GRAPH ?g { ?entity schema:name ?name . } }`,
      ),
    );
    checks.push({
      id: "query",
      label: "Semantic query",
      status: query.error ? "fail" : "pass",
      detail:
        query.error ??
        `A bounded SPARQL health query completed${query.value?.cost ? ` (weight ${query.value.cost.score}/${query.value.cost.budget})` : ""}.`,
      durationMs: Math.round(query.durationMs),
    });
  } else {
    checks.push({
      id: "query",
      label: "Semantic query",
      status: "skipped",
      detail: "Skipped until channel access and graph resolution succeed.",
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    relay,
    channelId,
    checks,
  };
}

/**
 * Deliberately start channel memory from a user action. The visible channel
 * message is the proposal's provenance, while the existing integration lazily
 * provisions the deterministic channel Context Graph when it accepts it.
 */
export async function enableChannelMemory(channelId: string): Promise<{
  cg?: string;
  operationId?: string | number;
  state?: string;
}> {
  const source = await relayClient.sendMessage(
    channelId,
    "🧠 DKG memory setup requested for this channel.",
  );
  const proposal = await signRelayEvent({
    kind: 40009,
    content: JSON.stringify({
      schemaVersion: 2,
      profiles: ["dkg-memory@1"],
      summary: "Request DKG memory setup for this Buzz channel.",
      entities: [
        {
          id: "channel-memory",
          type: "memory:Entity",
          name: "Channel DKG memory",
          description: "DKG-backed semantic memory requested for this channel.",
        },
      ],
      relations: [],
      model: "buzz-dkg-beta-ui",
      promptVersion: "channel-memory-enable-v1",
    }),
    tags: [
      ["h", channelId],
      ["t", "dkg-memory-proposal"],
      ["e", source.id, "", "source"],
    ],
  });
  const body = JSON.stringify(proposal);
  const deadline = Date.now() + 120_000;
  let result: MemoryProvisioningResponse | null = null;
  do {
    result = await postMemoryProposal(body);
    const progress = memoryProposalProgress(result.state);
    if (progress !== "processing") {
      return {
        ...result,
        cg: result.cg ?? result.contextGraphId,
      };
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  } while (Date.now() < deadline);

  throw new Error(
    "DKG memory was accepted and is still provisioning. Keep this panel open and refresh shortly.",
  );
}

interface MemoryProvisioningResponse {
  cg?: string;
  contextGraphId?: string;
  operationId?: string | number;
  state?: string;
  internalState?: string;
  error?: unknown;
}

async function postMemoryProposal(
  body: string,
): Promise<MemoryProvisioningResponse> {
  const { result, status } =
    await postAuthenticatedDkgJson<MemoryProvisioningResponse>({
      path: "/api/dkg/memory",
      body,
    });
  const publicState =
    normalizedMemoryProposalState(result.state) ??
    (status === 202 ? "processing" : status === 200 ? "stored" : undefined);
  return {
    ...result,
    internalState:
      result.internalState ??
      (publicState && result.state !== publicState ? result.state : undefined),
    state: publicState,
  };
}

/**
 * Derive the channel's Context Graph id from the latest @dkg receipt in the
 * channel. Receipts are ordinary kind-9 replies whose machine-readable lines
 * include `context-graph: <id>` — so the binding is discoverable by any
 * member with zero extra configuration.
 */
export async function deriveContextGraphId(
  channelId: string,
): Promise<string | null> {
  // Explicit override for channels without receipts yet (also the seam the
  // e2e demo uses): a global or per-channel localStorage key wins.
  try {
    const override =
      localStorage.getItem(`dkg-memory-cg:${channelId}`) ??
      localStorage.getItem("dkg-memory-cg-override");
    if (override) return override;
  } catch {
    /* storage unavailable */
  }
  const events = await relayClient.fetchEvents({
    kinds: [9],
    "#h": [channelId],
    limit: 500,
  });
  const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
  for (const ev of sorted) {
    const m = /^context-graph: (\S+)$/m.exec(ev.content);
    if (m) return m[1];
  }
  return null;
}

export async function fetchChannelMemory(
  channelId: string,
  cg: string | null,
): Promise<ChannelMemory> {
  return queryDkgProvider<ChannelMemory, "channel_memory">({
    channelId,
    operation: "channel_memory",
    arguments: {},
    localPath: cg ? `/api/channel-memory?cg=${encodeURIComponent(cg)}` : null,
  });
}

export async function fetchContributorTrail(
  channelId: string,
  cg: string | null,
  pubkey: string,
): Promise<TrailEntry[]> {
  return queryDkgProvider<TrailEntry[], "contributor_trail">({
    channelId,
    operation: "contributor_trail",
    arguments: { pubkey },
    localPath: cg
      ? `/api/contributor-trail?cg=${encodeURIComponent(cg)}&pubkey=${encodeURIComponent(pubkey)}`
      : null,
  });
}

/** Query who changed a named software component through the authenticated relay. */
export async function fetchSoftwareContributors(
  channelId: string,
  repository: string,
  componentName: string,
  componentType?: "function" | "class" | "interface" | "file" | "package",
): Promise<SoftwareContributors> {
  return queryDkgProvider<SoftwareContributors, "software_contributors">({
    channelId,
    operation: "software_contributors",
    arguments: {
      repository,
      componentName,
      ...(componentType ? { componentType } : {}),
    },
    localPath: null,
  });
}

/** Query the decisions that a commit implemented for a named component. */
export async function fetchDecisionTrace(
  channelId: string,
  repository: string,
  commitSha: string,
  componentName: string,
): Promise<DecisionTrace> {
  return queryDkgProvider<DecisionTrace, "decision_trace">({
    channelId,
    operation: "decision_trace",
    arguments: { repository, commitSha, componentName },
    localPath: null,
  });
}

// ── Graph view (per the graph-view deliberation) ────────────────────────────
// One entry door: "open as graph" on a subgraph row. The endpoint returns the
// decision spine this subgraph's evidence fed plus one hop of evidence; the
// client lays it out deterministically (time-ordered, no physics).
export interface GraphNode {
  id: string;
  kind: "decision" | "claim" | "commit";
  label: string;
  at: number | null;
  contested?: number;
  run?: string | null;
  commit?: string | null;
  /** Memory layer, per the node's own three-view regime (VM > SWM > WM). */
  layer?: "WM" | "SWM" | "VM";
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: "supports" | "contradicts" | "generated";
}

export interface SubgraphGraphData {
  gate: MemoryGate;
  cg?: string;
  subgraph?: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

export async function fetchSubgraphGraph(
  channelId: string,
  cg: string | null,
  name: string,
): Promise<SubgraphGraphData> {
  return queryDkgProvider<SubgraphGraphData, "subgraph_graph">({
    channelId,
    operation: "subgraph_graph",
    arguments: { name },
    localPath: cg
      ? `/api/subgraph-graph?cg=${encodeURIComponent(cg)}&name=${encodeURIComponent(name)}`
      : null,
  });
}

/**
 * Display names for contributor pubkeys from kind-0 profiles — humans see
 * "People & agents" as names, never hex (humanize wrap, Thread 2).
 */
export async function fetchProfileNames(
  pubkeys: string[],
): Promise<Record<string, string>> {
  if (pubkeys.length === 0) return {};
  const events = await relayClient.fetchEvents({
    kinds: [0],
    authors: pubkeys,
    limit: pubkeys.length * 2,
  });
  const out: Record<string, string> = {};
  for (const ev of [...events].sort((a, b) => a.created_at - b.created_at)) {
    try {
      const meta = JSON.parse(ev.content) as {
        name?: string;
        display_name?: string;
      };
      const name = meta.display_name || meta.name;
      if (name) out[ev.pubkey] = name;
    } catch {
      /* malformed profile */
    }
  }
  return out;
}

// ── Evidence Envelope (the agent/human seam, humanize wrap) ─────────────────
// One canonical object; human cards and agent JSON render the SAME shape.
// Fields may be collapsed in the UI but the envelope is never thinned —
// unknown values stay present as null.
export interface EvidenceSource {
  id: string;
  span: string | null;
  author: string | null;
  at: number | null;
}

export interface EvidenceEnvelope {
  gate: MemoryGate;
  found?: boolean;
  claimId: string;
  name?: string | null;
  status?: string;
  trustState?: string;
  memoryLayer?: "WM" | "SWM" | "VM" | null;
  attribution?: string[];
  digest?: string | null;
  asOf?: string | null;
  sources?: EvidenceSource[];
  relations?: { from: string; rel: string }[];
  receiptUal?: string | null;
  replay?: { cg: string; graph: string | null; sparqlEndpoint: string };
}

export async function fetchEvidence(
  channelId: string,
  cg: string | null,
  uri: string,
): Promise<EvidenceEnvelope> {
  return queryDkgProvider<EvidenceEnvelope, "evidence">({
    channelId,
    operation: "evidence",
    arguments: { uri },
    localPath: cg
      ? `/api/evidence?cg=${encodeURIComponent(cg)}&uri=${encodeURIComponent(uri)}`
      : null,
  });
}

/**
 * Deep link into the patched edge-node UI, landed on this CG. With an
 * entity URI the UI opens the single CG tab and focuses that entity inside
 * it (v10:open-entity); with only a layer it opens the layer tab.
 */
export function nodeUiDeepLink(
  cg: string,
  opts?: { layer?: "wm" | "swm" | "vm"; entity?: string },
): string {
  const base = `http://127.0.0.1:9200/ui/?cg=${encodeURIComponent(cg)}`;
  if (opts?.entity) return `${base}&entity=${encodeURIComponent(opts.entity)}`;
  return opts?.layer ? `${base}&layer=${opts.layer}` : base;
}

// ── C-recommendation: relay-backed discovery fallback ────────────────────────
// When the viewer runs no edge node, @dkg receipts already in the channel
// provide a read-only "shown for discovery" listing: KA name, human title,
// digest, layer, and time — signed by the daemon but NOT verified through the
// viewer's own node. Discovery entries never feed confidence and expose no
// actions; a local node upgrades the same items to "verified through your node".
export interface DiscoveryEntry {
  kaName: string;
  title: string | null;
  digest: string | null;
  layer: "SWM" | "VM";
  at: number;
}

export async function fetchDiscoveryFromReceipts(
  channelId: string,
): Promise<DiscoveryEntry[]> {
  const events = await relayClient.fetchEvents({
    kinds: [9],
    "#h": [channelId],
    limit: 500,
  });
  const out: DiscoveryEntry[] = [];
  const seen = new Set<string>();
  for (const ev of [...events].sort((a, b) => b.created_at - a.created_at)) {
    const ka = /^ka: (\S+)$/m.exec(ev.content)?.[1];
    if (!ka || seen.has(ka)) continue;
    const digest = /^source-digest: sha256:([0-9a-f]{64})$/m.exec(
      ev.content,
    )?.[1];
    if (!digest) continue; // not a receipt
    seen.add(ka);
    const title =
      /^🟢? ?(?:🟡 )?(?:Captured|Published) “(.+?)”/mu.exec(ev.content)?.[1] ??
      null;
    out.push({
      kaName: ka,
      title,
      digest,
      layer: /^UAL: /m.test(ev.content) ? "VM" : "SWM",
      at: ev.created_at,
    });
  }
  return out;
}
