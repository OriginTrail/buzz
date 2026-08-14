// Entity accounting for the memory panel (issue OriginTrail/buzz-dkg-beta#13).
//
// The model: every chip the panel shows — a decision kind, an agent, code —
// is a SUB-GRAPH of the channel's Context Graph, and the number it carries is
// that sub-graph's entity count. Kind sub-graphs partition the typed-entity
// space, so their counts SUM to the layer's entity total; when the data
// breaks that invariant (multi-typed or unclassified subjects) the delta is
// reported, never hidden. "Entity" follows the DKG node UI's own semantics
// (`packages/node-ui` buildEntities): all sorts of entities, not decisions.
//
// Everything here must stay inside the relay's semantic-query budget: exact
// type/predicate IRIs only, one aggregate per query, no GROUP BY, no GRAPH
// clauses, LIMIT on every SELECT — which is why the battery is many small
// queries instead of one breakdown query.
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const BUZZ = "https://w3id.org/buzz-dkg/buzz#";
const NOSTR = "https://w3id.org/buzz-dkg/nostr#";
const PROV = "http://www.w3.org/ns/prov#";

export const ENTITY_KINDS = [
  { key: "decisions", label: "decisions", type: `${BUZZ}DecisionCluster` },
  { key: "evidence", label: "evidence", type: `${NOSTR}Event` },
  { key: "agents", label: "people & agents", type: `${PROV}Agent` },
  { key: "activities", label: "capture runs", type: `${BUZZ}Distillation` },
  { key: "claims", label: "claims", type: `${BUZZ}Claim` },
  { key: "code", label: "code", type: `${BUZZ}Commit` },
] as const;

export type EntityKindKey = (typeof ENTITY_KINDS)[number]["key"];

export interface CountQuery {
  key: string;
  sparql: string;
}

function countByType(typeIri: string): string {
  return `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s <${RDF}type> <${typeIri}> } LIMIT 25`;
}

/**
 * The bounded query battery: one aggregate per kind, the typed-entity total,
 * and one attribution aggregate per contributor (their sub-graph size).
 */
export function countQueries(contributorPubkeys: string[]): CountQuery[] {
  const queries: CountQuery[] = [
    {
      key: "typedTotal",
      sparql: `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s <${RDF}type> ?t } LIMIT 25`,
    },
    ...ENTITY_KINDS.map((kind) => ({
      key: kind.key,
      sparql: countByType(kind.type),
    })),
  ];
  for (const pubkey of contributorPubkeys) {
    queries.push({
      key: `agent:${pubkey}`,
      sparql: `SELECT (COUNT(DISTINCT ?e) AS ?n) WHERE { ?e <${PROV}wasAttributedTo> <urn:nostr:pubkey:${pubkey}> } LIMIT 25`,
    });
  }
  return queries;
}

/** Extract the integer from a SPARQL aggregate binding in any wire shape. */
export function parseCountBinding(
  bindings: Record<string, unknown>[] | undefined,
): number | null {
  const raw = bindings?.[0]?.n;
  const text =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && "value" in raw
        ? String((raw as { value: unknown }).value)
        : null;
  if (text === null) return null;
  const match = text.match(/-?\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

export interface LayerEntityCounts {
  typedTotal: number | null;
  kinds: Partial<Record<EntityKindKey, number>>;
  perAgent: Record<string, number>;
}

export interface EntityCounts {
  SWM: LayerEntityCounts;
  VM: LayerEntityCounts;
}

export function emptyLayerCounts(): LayerEntityCounts {
  return { typedTotal: null, kinds: {}, perAgent: {} };
}

/**
 * Kind counts vs the layer total. `delta > 0` means subjects no kind claims
 * (unclassified types); `delta < 0` means subjects counted by more than one
 * kind. Either way the caller shows it — the invariant is verified in the
 * UI, not assumed.
 */
export function reconcile(layer: LayerEntityCounts): {
  sum: number;
  delta: number | null;
} {
  const sum = Object.values(layer.kinds).reduce(
    (total, count) => total + (count ?? 0),
    0,
  );
  return {
    sum,
    delta: layer.typedTotal === null ? null : layer.typedTotal - sum,
  };
}

/** Human line for the dashboard: "312 entities = 30 decisions · …". */
export function reconciliationLine(layer: LayerEntityCounts): string | null {
  if (layer.typedTotal === null) return null;
  const parts: string[] = [];
  for (const kind of ENTITY_KINDS) {
    const count = layer.kinds[kind.key];
    if (typeof count === "number" && count > 0) {
      parts.push(`${count} ${kind.label}`);
    }
  }
  if (parts.length === 0) return null;
  const { delta } = reconcile(layer);
  const tail =
    delta === 0
      ? ""
      : delta && delta > 0
        ? ` · ${delta} other`
        : ` · ${-(delta ?? 0)} cross-typed`;
  return `${layer.typedTotal} entities = ${parts.join(" · ")}${tail}`;
}
