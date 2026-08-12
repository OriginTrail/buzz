// Adapter boundary for the topology view. The shared provider owns local-first
// selection and authenticated community fallback; render code remains transport
// agnostic and remote authorization remains channel-scoped.
import { queryDkgProvider } from "../provider";
import {
  buildTopologyEndpointMetadataQuery,
  CHANNEL_TOPOLOGY_FALLBACK_NODE_QUERY,
  CHANNEL_TOPOLOGY_RELATION_QUERIES,
  semanticBindingString,
} from "../semanticQueries";

export type TopologyTarget =
  | { kind: "channel" }
  | { kind: "subgraph"; name: string };

export interface TopologyTriple {
  subject: string;
  predicate: string;
  /** Raw N-Triples-style object — literals keep their quotes. */
  object: string;
  layer: "WM" | "SWM" | "VM";
  /** Participant subgraph the triple's named graph belongs to. */
  agent: string;
}

export interface TopologyData {
  gate: "ok" | "node-missing" | "auth" | "not-subscribed";
  cg?: string;
  subgraph?: string;
  triples?: TopologyTriple[];
}

export async function fetchTopologyTriples(
  channelId: string,
  cg: string | null,
  target: TopologyTarget,
): Promise<TopologyData> {
  if (target.kind === "channel") {
    return fetchChannelTopologyTriples(channelId);
  }
  return queryDkgProvider<TopologyData, "subgraph_triples">({
    channelId,
    operation: "subgraph_triples",
    arguments: { name: target.name },
    localPath: cg
      ? `/api/subgraph-triples?cg=${encodeURIComponent(cg)}&name=${encodeURIComponent(target.name)}`
      : null,
  });
}

type SemanticLayer = {
  layer: "SWM" | "VM";
  bindings: Record<string, unknown>[];
};

type SemanticResult = {
  gate: TopologyData["gate"];
  cg?: string;
  layers: SemanticLayer[];
};

const MAX_TOPOLOGY_NODES = 30;
const MAX_TOPOLOGY_EDGES = 80;

const INVALID_IRI_PUNCTUATION = new Set([
  "<",
  ">",
  '"',
  "{",
  "}",
  "|",
  "\\",
  "^",
  "`",
]);

function hasInvalidIriCharacter(value: string): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) <= 0x20 || INVALID_IRI_PUNCTUATION.has(character),
  );
}

function resourceIri(value: string): string | null {
  const trimmed = value.trim();
  const iri =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1)
      : trimmed;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(iri) || hasInvalidIriCharacter(iri)) {
    return null;
  }
  return iri;
}

function triplesFrom(result: SemanticResult): TopologyTriple[] {
  const triples: TopologyTriple[] = [];
  for (const layer of result.layers ?? []) {
    for (const binding of layer.bindings ?? []) {
      const subject = semanticBindingString(binding.subject);
      const predicate = semanticBindingString(binding.predicate);
      const object = semanticBindingString(binding.object);
      if (!subject || !predicate || !object) continue;
      triples.push({
        subject,
        predicate,
        object,
        layer: layer.layer,
        agent: layer.layer,
      });
    }
  }
  return triples;
}

function uniqueTriples(triples: TopologyTriple[]): TopologyTriple[] {
  const seen = new Set<string>();
  return triples.filter((triple) => {
    const key = `${triple.layer}|${triple.subject}|${triple.predicate}|${triple.object}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Select only relationship triples whose endpoints fit in one small, fully
 * labelable graph. Input order is meaningful: containment establishes memory
 * clusters first, domain edges enrich them, and provenance is last.
 */
function boundedRelationships(triples: TopologyTriple[]): {
  relations: TopologyTriple[];
  endpoints: string[];
} {
  const relations: TopologyTriple[] = [];
  const endpoints = new Set<string>();
  for (const triple of uniqueTriples(triples)) {
    if (relations.length >= MAX_TOPOLOGY_EDGES) break;
    const subject = resourceIri(triple.subject);
    const object = resourceIri(triple.object);
    if (!subject || !object) continue;
    const additions =
      Number(!endpoints.has(subject)) + Number(!endpoints.has(object));
    if (endpoints.size + additions > MAX_TOPOLOGY_NODES) continue;
    endpoints.add(subject);
    endpoints.add(object);
    relations.push(triple);
  }
  return { relations, endpoints: [...endpoints] };
}

async function semanticQuery(
  channelId: string,
  sparql: string,
): Promise<SemanticResult> {
  return queryDkgProvider<SemanticResult, "semantic_query">({
    channelId,
    operation: "semantic_query",
    arguments: { sparql, view: "both" },
    localPath: null,
  });
}

async function fetchChannelTopologyTriples(
  channelId: string,
): Promise<TopologyData> {
  const relationResults: SemanticResult[] = [];
  const relationErrors: unknown[] = [];
  // Blazegraph also serves the DKG node's mainnet workload. Keep this explicit
  // graph action serialized so opening the panel does not create its own burst,
  // and retain successful slices when one upstream read is transiently busy.
  for (const sparql of CHANNEL_TOPOLOGY_RELATION_QUERIES) {
    try {
      relationResults.push(await semanticQuery(channelId, sparql));
    } catch (cause) {
      relationErrors.push(cause);
    }
  }
  if (relationResults.length === 0) throw relationErrors[0];
  const { relations, endpoints } = boundedRelationships(
    relationResults.flatMap(triplesFrom),
  );
  if (relations.length === 0 && relationErrors.length > 0) {
    throw relationErrors[0];
  }

  // A genuinely relation-free channel still gets the old standalone-entity
  // shelf. Otherwise labels and types are fetched only for endpoints that are
  // guaranteed to appear in the connected canvas.
  let metadata: SemanticResult | null = null;
  try {
    metadata = await semanticQuery(
      channelId,
      endpoints.length > 0
        ? buildTopologyEndpointMetadataQuery(endpoints)
        : CHANNEL_TOPOLOGY_FALLBACK_NODE_QUERY,
    );
  } catch (cause) {
    if (relations.length === 0) throw cause;
    // URI-labelled relationships remain useful and truthful while the DKG is
    // busy; a later reopen can enrich them with human labels and types.
  }
  const triples = uniqueTriples([
    ...relations,
    ...(metadata ? triplesFrom(metadata) : []),
  ]);
  return {
    gate: "ok",
    cg:
      metadata?.cg ??
      relationResults.find((result) => typeof result.cg === "string")?.cg,
    triples,
  };
}
