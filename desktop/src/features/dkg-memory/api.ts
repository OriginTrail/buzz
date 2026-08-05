// Data access for the Buzz-native DKG memory panel.
//
// All graph reads go through the viewer's OWN local explorer/edge node
// (127.0.0.1:9295 → 127.0.0.1:9200) — the local-first mandate: memory
// resolves only for viewers whose node participates in the channel's
// Context Graph. The relay is used solely to discover the channel→CG
// binding, which the @dkg daemon's receipts carry in-channel.
import { relayClient } from "@/shared/api/relayClient";

// Local-first with community-gateway fallback (RFC deployment profile 2):
// the viewer's own explorer/node wins when present; otherwise the panel
// resolves through the community's gateway node over the tailnet — full
// fidelity, honestly labeled as gateway-resolved rather than self-verified.
const LOCAL_EXPLORER = "http://127.0.0.1:9295";
const GATEWAY_EXPLORER = "https://macbook-pro-8.tailb02f7e.ts.net/wot-explorer";

export type ExplorerSource = "local" | "gateway";

let resolvedExplorer: { url: string; source: ExplorerSource } | null = null;

async function explorer(): Promise<{ url: string; source: ExplorerSource }> {
  if (resolvedExplorer) return resolvedExplorer;
  try {
    const override = localStorage.getItem("dkg-memory-explorer-url");
    if (override) {
      resolvedExplorer = {
        url: override.replace(/\/$/, ""),
        source: override.includes("127.0.0.1") ? "local" : "gateway",
      };
      return resolvedExplorer;
    }
  } catch {
    /* storage unavailable */
  }
  try {
    // Any HTTP response (even an error status) proves a local explorer exists.
    await fetch(`${LOCAL_EXPLORER}/api/channel-memory?cg=probe`, {
      signal: AbortSignal.timeout(1500),
    });
    resolvedExplorer = { url: LOCAL_EXPLORER, source: "local" };
  } catch {
    resolvedExplorer = { url: GATEWAY_EXPLORER, source: "gateway" };
  }
  return resolvedExplorer;
}

/** Which explorer the panel resolved through (null until first fetch). */
export function explorerSource(): ExplorerSource | null {
  return resolvedExplorer?.source ?? null;
}

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

export async function fetchChannelMemory(cg: string): Promise<ChannelMemory> {
  const { url } = await explorer();
  const res = await fetch(
    `${url}/api/channel-memory?cg=${encodeURIComponent(cg)}`,
  );
  if (!res.ok) throw new Error(`channel-memory ${res.status}`);
  return (await res.json()) as ChannelMemory;
}

export async function fetchContributorTrail(
  cg: string,
  pubkey: string,
): Promise<TrailEntry[]> {
  const { url } = await explorer();
  const res = await fetch(
    `${url}/api/contributor-trail?cg=${encodeURIComponent(cg)}&pubkey=${encodeURIComponent(pubkey)}`,
  );
  if (!res.ok) throw new Error(`contributor-trail ${res.status}`);
  return (await res.json()) as TrailEntry[];
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
  cg: string,
  name: string,
): Promise<SubgraphGraphData> {
  const { url } = await explorer();
  const res = await fetch(
    `${url}/api/subgraph-graph?cg=${encodeURIComponent(cg)}&name=${encodeURIComponent(name)}`,
  );
  if (!res.ok) throw new Error(`subgraph-graph ${res.status}`);
  return (await res.json()) as SubgraphGraphData;
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
  cg: string,
  uri: string,
): Promise<EvidenceEnvelope> {
  const { url } = await explorer();
  const res = await fetch(
    `${url}/api/evidence?cg=${encodeURIComponent(cg)}&uri=${encodeURIComponent(uri)}`,
  );
  if (!res.ok) throw new Error(`evidence ${res.status}`);
  return (await res.json()) as EvidenceEnvelope;
}

/** Deep link into the patched edge-node UI, landed on this CG. */
export function nodeUiDeepLink(
  cg: string,
  layer?: "wm" | "swm" | "vm",
): string {
  const base = `http://127.0.0.1:9200/ui/?cg=${encodeURIComponent(cg)}`;
  return layer ? `${base}&layer=${layer}` : base;
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
