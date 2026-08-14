// Entity accounting for the memory panel (issue OriginTrail/buzz-dkg-beta#13).
//
// The model: each count describes a typed or attributed slice of the channel's
// Context Graph. The typed slices are not assumed to be a partition: an entity
// may have multiple listed types or only types outside this list. "Entity"
// follows the DKG node UI's own semantics (`packages/node-ui` buildEntities):
// all sorts of entities, not decisions.
//
// Everything here must stay inside the relay's semantic-query budget: exact
// type/predicate IRIs only, one aggregate per query, no GROUP BY, no GRAPH
// clauses, LIMIT on every SELECT. Aggregate LIMITs satisfy the relay policy but
// do not bound scan work, so contributor queries are validated and capped.
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const BUZZ = "https://w3id.org/buzz-dkg/buzz#";
const NOSTR = "https://w3id.org/buzz-dkg/nostr#";
const PROV = "http://www.w3.org/ns/prov#";

/** Maximum participant-specific aggregates in one panel refresh. */
export const MAX_CONTRIBUTOR_COUNT_QUERIES = 16;

export const ENTITY_KINDS = [
  { key: "decisions", label: "decisions", type: `${BUZZ}DecisionCluster` },
  { key: "evidence", label: "evidence", type: `${NOSTR}Event` },
  { key: "agents", label: "people & agents", type: `${PROV}Agent` },
  { key: "activities", label: "capture runs", type: `${BUZZ}Distillation` },
  { key: "claims", label: "claims", type: `${BUZZ}Claim` },
  { key: "code", label: "commits", type: `${BUZZ}Commit` },
] as const;

export type EntityKindKey = (typeof ENTITY_KINDS)[number]["key"];

export interface CountQuery {
  key: string;
  sparql: string;
  view: "both" | "shared";
}

function countByType(typeIri: string): string {
  return `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s <${RDF}type> <${typeIri}> } LIMIT 25`;
}

/** Return canonical contributor keys that are safe to interpolate into IRIs. */
export function boundedContributorPubkeys(
  contributorPubkeys: string[],
): string[] {
  return [...new Set(contributorPubkeys)]
    .filter((pubkey) => /^[0-9a-f]{64}$/.test(pubkey))
    .sort()
    .slice(0, MAX_CONTRIBUTOR_COUNT_QUERIES);
}

/** Build the bounded aggregate battery for types and contributor slices. */
export function countQueries(contributorPubkeys: string[]): CountQuery[] {
  const queries: CountQuery[] = [
    {
      key: "typedTotal",
      sparql: `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s <${RDF}type> ?t } LIMIT 25`,
      view: "both",
    },
    ...ENTITY_KINDS.map((kind) => ({
      key: kind.key,
      sparql: countByType(kind.type),
      view: "both" as const,
    })),
  ];
  for (const pubkey of boundedContributorPubkeys(contributorPubkeys)) {
    queries.push({
      key: `agent:${pubkey}`,
      sparql: `SELECT (COUNT(DISTINCT ?e) AS ?n) WHERE { ?e <${PROV}wasAttributedTo> <urn:nostr:pubkey:${pubkey}> } LIMIT 25`,
      // Contributor chips describe shared channel memory. Avoid an unused VM
      // traversal for every participant.
      view: "shared",
    });
  }
  return queries;
}

/** Extract a non-negative safe integer from a SPARQL aggregate binding. */
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
  const match = text.trim().match(/^(?:"([0-9]+)"(?:\^\^<[^>]+>)?|([0-9]+))$/);
  const digits = match?.[1] ?? match?.[2];
  if (!digits) return null;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : null;
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
 * Compare distinct typed entities with assignments to the listed types.
 * `delta` is only a net difference; it cannot distinguish unlisted types from
 * overlapping listed types, which can offset one another.
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

/** Human line that does not claim the listed types form an exact partition. */
export function reconciliationLine(layer: LayerEntityCounts): string | null {
  if (layer.typedTotal === null) return null;
  if (
    !ENTITY_KINDS.every((kind) => typeof layer.kinds[kind.key] === "number")
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const kind of ENTITY_KINDS) {
    const count = layer.kinds[kind.key];
    if (typeof count === "number" && count > 0) {
      parts.push(`${count} ${kind.label}`);
    }
  }
  const { sum } = reconcile(layer);
  const breakdown = parts.length > 0 ? `: ${parts.join(" · ")}` : "";
  return `${layer.typedTotal} typed entities · ${sum} listed type assignments${breakdown}`;
}
