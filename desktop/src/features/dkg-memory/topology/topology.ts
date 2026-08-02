// Pure topology shaping — no I/O, no React. The two load-bearing helpers are
// ported (semantics kept verbatim) from the DKG node UI,
// packages/node-ui/src/ui/views/project/components/graph.tsx, per the
// node-ui repurpose JOINT RECOMMENDATION:
//  • applyHeaviestSubjectsCap — deterministic bounded topology sample
//    (degree-ranked complete subject clusters; pre-add budget check;
//    smaller-satellite scan; heaviest-subject fallback; final slice).
//  • splitGraphTriplesForShelf — degree-0 subjects move to a "standalone
//    entities" shelf; triples touching shelved entities leave the canvas so
//    the same entity never renders in two places.
import type { TopologyTriple } from "./client";

const RDF_TYPE_URI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const LABEL_PREDICATES = [
  "http://schema.org/name",
  "http://www.w3.org/2000/01/rdf-schema#label",
  "http://schema.org/text",
];
const LABEL_PRIORITY = new Map(LABEL_PREDICATES.map((p, i) => [p, i]));

export function graphNodeKey(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function isResourceNode(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('"')) return false;
  if (trimmed.startsWith("_:")) return true;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return true;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

export function decodeLiteral(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('"')) return t;
  const close = t.lastIndexOf('"');
  return t
    .slice(1, close)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

export interface SingletonShelfItem {
  uri: string;
  label: string;
}

export function splitGraphTriplesForShelf(triples: TopologyTriple[]): {
  canvasTriples: TopologyTriple[];
  singletonItems: SingletonShelfItem[];
} {
  const subjects = new Set<string>();
  const degree = new Map<string, number>();
  const labels = new Map<string, string>();
  const labelPriority = new Map<string, number>();

  for (const triple of triples) {
    const subjectKey = graphNodeKey(triple.subject);
    subjects.add(subjectKey);
    const priority = LABEL_PRIORITY.get(triple.predicate);
    if (priority !== undefined) {
      const label = decodeLiteral(triple.object).trim();
      if (label) {
        const existing = labelPriority.get(subjectKey);
        if (existing === undefined || priority < existing) {
          labels.set(subjectKey, label);
          labelPriority.set(subjectKey, priority);
        }
      }
    }
    if (
      graphNodeKey(triple.predicate) === RDF_TYPE_URI ||
      !isResourceNode(triple.object)
    )
      continue;
    const objectKey = graphNodeKey(triple.object);
    degree.set(subjectKey, (degree.get(subjectKey) ?? 0) + 1);
    degree.set(objectKey, (degree.get(objectKey) ?? 0) + 1);
  }

  const singletonItems = [...subjects]
    .filter((key) => (degree.get(key) ?? 0) === 0)
    .map((key) => ({
      uri: key,
      label: labels.get(key) ?? key.split(/[/#:]/).pop() ?? key,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (singletonItems.length === 0)
    return { canvasTriples: triples, singletonItems };

  const singletonSet = new Set(singletonItems.map((item) => item.uri));
  return {
    canvasTriples: triples.filter(
      (triple) =>
        !singletonSet.has(graphNodeKey(triple.subject)) &&
        !singletonSet.has(graphNodeKey(triple.object)),
    ),
    singletonItems,
  };
}

const MAX_TRIPLES = 2500;
export function applyHeaviestSubjectsCap(
  triples: TopologyTriple[],
  max: number = MAX_TRIPLES,
): TopologyTriple[] {
  if (triples.length <= max) return triples;
  const degree = new Map<string, number>();
  for (const t of triples)
    degree.set(t.subject, (degree.get(t.subject) ?? 0) + 1);
  const order = [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uri]) => uri);
  const keep = new Set<string>();
  let kept = 0;
  for (const uri of order) {
    const subjectDegree = degree.get(uri) ?? 0;
    if (kept + subjectDegree > max) continue;
    keep.add(uri);
    kept += subjectDegree;
  }
  if (keep.size === 0 && order.length > 0) keep.add(order[0]);
  return triples.filter((t) => keep.has(t.subject)).slice(0, max);
}

// ── Attribution palette ──────────────────────────────────────────────────────
// Colors show RECORDED ATTRIBUTION (which participant subgraph wrote a
// subject) — never truth, trustworthiness, or verification (UT Voice's
// vocabulary guard from the wrap). Fixed hues for known participants,
// hashed hue fallback for new ones.
const AGENT_COLORS: Record<string, string> = {
  openclaw: "#e06c75",
  hermes: "#61afef",
  utvoice: "#98c379",
  fizz: "#e5c07b",
  blackbox: "#c678dd",
  ziga: "#56b6c2",
  brana: "#d19a66",
  t: "#abb2bf",
  jurij: "#f28fad",
  forge: "#8a91a0",
  decisions: "#ffd866",
};

export function agentColor(agent: string): string {
  const known = AGENT_COLORS[agent];
  if (known) return known;
  let h = 0;
  for (const c of agent) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 60%)`;
}

/** Per-subject-URI colors for RdfGraph's style.nodeColors (attribution). */
export function attributionNodeColors(
  triples: TopologyTriple[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of triples) {
    const key = graphNodeKey(t.subject);
    if (!(key in out)) out[key] = agentColor(t.agent);
  }
  return out;
}

export function attributionLegend(
  triples: TopologyTriple[],
): { agent: string; color: string; subjects: number }[] {
  const subjectsByAgent = new Map<string, Set<string>>();
  for (const t of triples) {
    if (!subjectsByAgent.has(t.agent)) subjectsByAgent.set(t.agent, new Set());
    subjectsByAgent.get(t.agent)?.add(graphNodeKey(t.subject));
  }
  return [...subjectsByAgent.entries()]
    .map(([agent, subjects]) => ({
      agent,
      color: agentColor(agent),
      subjects: subjects.size,
    }))
    .sort((a, b) => b.subjects - a.subjects);
}
