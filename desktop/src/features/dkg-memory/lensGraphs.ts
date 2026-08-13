// Pure builders for the lens overlays (all-decisions and per-contributor).
//
// Both lenses assemble the SAME shape the subgraph endpoint returns —
// GraphNode/GraphEdge — from data every community deployment already serves
// (channel_memory + evidence envelopes, contributor_trail), so the Traces
// timeline and the hex Graph work even while capture is flat and the
// gateway advertises no named subgraphs. Client-side assembly is display
// composition only: every node keeps its provider-issued URI and nothing
// here mints identity.
import type {
  DecisionEntry,
  EvidenceEnvelope,
  GraphEdge,
  GraphNode,
  TrailEntry,
} from "./api";

export interface LensGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const CONTRADICTS_REL = /contradict|counter|dispute|refute/i;

function uriTail(uri: string): string {
  const tail = uri.split(/[/:#]/).filter(Boolean).pop();
  return tail && tail.length >= 6 ? tail : uri;
}

function isoToSeconds(at: string | null): number | null {
  if (!at) return null;
  const ms = new Date(at).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Decisions lens: one node per captured decision, enriched with the evidence
 * envelope's sources as ⊕ rows. `envelopes` aligns with `decisions` by index;
 * a null entry (fetch failed / not found) degrades that decision to a bare
 * card instead of dropping it. Sources shared by several decisions become ONE
 * evidence node with edges to each — that shared lineage is the graph.
 */
export function buildDecisionsGraph(
  decisions: DecisionEntry[],
  envelopes: (EvidenceEnvelope | null)[],
): LensGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();
  const contested = new Map<string, number>();

  const addEdge = (edge: GraphEdge) => {
    const key = `${edge.from}|${edge.rel}|${edge.to}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push(edge);
    if (edge.rel === "contradicts") {
      contested.set(edge.to, (contested.get(edge.to) ?? 0) + 1);
    }
  };

  decisions.forEach((decision, index) => {
    if (nodes.has(decision.uri)) return;
    const envelope = envelopes[index] ?? null;
    const sources = envelope?.sources ?? [];
    const sourceTimes = sources
      .map((source) => source.at)
      .filter((at): at is number => typeof at === "number");
    nodes.set(decision.uri, {
      id: decision.uri,
      kind: "decision",
      label: envelope?.name ?? decision.name ?? uriTail(decision.uri),
      at:
        isoToSeconds(decision.at) ??
        (sourceTimes.length > 0 ? Math.max(...sourceTimes) : null),
      layer: envelope?.memoryLayer ?? undefined,
    });

    for (const source of sources) {
      const existing = nodes.get(source.id);
      if (!existing) {
        nodes.set(source.id, {
          id: source.id,
          kind: "claim",
          label: source.span ?? uriTail(source.id),
          at: source.at,
          layer: envelope?.memoryLayer ?? undefined,
        });
      } else if (existing.kind !== "decision" && !existing.at && source.at) {
        existing.at = source.at;
      }
      addEdge({ from: source.id, to: decision.uri, rel: "supports" });
    }

    for (const relation of envelope?.relations ?? []) {
      if (!relation.from || relation.from === decision.uri) continue;
      if (!nodes.has(relation.from)) {
        nodes.set(relation.from, {
          id: relation.from,
          kind: "claim",
          label: uriTail(relation.from),
          at: null,
        });
      }
      addEdge({
        from: relation.from,
        to: decision.uri,
        rel: CONTRADICTS_REL.test(relation.rel) ? "contradicts" : "supports",
      });
    }
  });

  for (const [id, count] of contested) {
    const node = nodes.get(id);
    if (node) node.contested = count;
  }
  return { nodes: [...nodes.values()], edges };
}

/**
 * Contributor lens: this participant's trail as decisions plus the signed
 * events that fed them. Events without a linked decision stay visible as
 * "evidence not yet feeding a decision" — the trail never silently shrinks.
 */
export function buildContributorGraph(trail: TrailEntry[]): LensGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeSeen = new Set<string>();

  for (const entry of trail) {
    if (entry.decision) {
      const existing = nodes.get(entry.decision);
      if (!existing) {
        nodes.set(entry.decision, {
          id: entry.decision,
          kind: "decision",
          label: entry.decisionName ?? uriTail(entry.decision),
          at: entry.at,
          layer: entry.layer ?? undefined,
        });
      } else if (entry.at && (!existing.at || entry.at > existing.at)) {
        existing.at = entry.at;
      }
    }
    if (!nodes.has(entry.event)) {
      nodes.set(entry.event, {
        id: entry.event,
        kind: "claim",
        label: entry.content ?? uriTail(entry.event),
        at: entry.at,
        layer: entry.layer ?? undefined,
      });
    }
    if (entry.decision) {
      const key = `${entry.event}|supports|${entry.decision}`;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        edges.push({
          from: entry.event,
          to: entry.decision,
          rel: "supports",
        });
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
}

// ── Hex-graph projection ────────────────────────────────────────────────────
// The node-UI renderer consumes raw triples; project the lens graph into the
// buzz-dkg ontology so entity-type colors match the DKG node's own idiom.
const BUZZ_NS = "https://w3id.org/buzz-dkg/buzz#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SCHEMA_NAME = "http://schema.org/name";
const KIND_CLASS = {
  decision: `${BUZZ_NS}DecisionCluster`,
  claim: `${BUZZ_NS}Claim`,
  commit: `${BUZZ_NS}Commit`,
} as const;
const MAX_LITERAL_LENGTH = 160;

function literal(value: string): string {
  const clipped =
    value.length > MAX_LITERAL_LENGTH
      ? `${value.slice(0, MAX_LITERAL_LENGTH - 1)}…`
      : value;
  return `"${clipped
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")}"`;
}

export interface LensTriple {
  subject: string;
  predicate: string;
  object: string;
}

export function lensTriples(graph: LensGraph): LensTriple[] {
  const out: LensTriple[] = [];
  for (const node of graph.nodes) {
    out.push({
      subject: node.id,
      predicate: RDF_TYPE,
      object: KIND_CLASS[node.kind],
    });
    out.push({
      subject: node.id,
      predicate: SCHEMA_NAME,
      object: literal(node.label),
    });
  }
  for (const edge of graph.edges) {
    out.push({
      subject: edge.from,
      predicate: `${BUZZ_NS}${edge.rel}`,
      object: edge.to,
    });
  }
  return out;
}

/** Layer tallies for the overlay legend — same rule as the subgraph lens. */
export function lensLayerCounts(
  nodes: GraphNode[],
): Record<"WM" | "SWM" | "VM", number> {
  const counts = { WM: 0, SWM: 0, VM: 0 };
  for (const node of nodes) if (node.layer) counts[node.layer] += 1;
  return counts;
}
