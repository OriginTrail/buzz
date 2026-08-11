// Adapter boundary for the topology view. The shared provider owns local-first
// selection and authenticated community fallback; render code remains transport
// agnostic and remote authorization remains channel-scoped.
import { queryDkgProvider } from "../provider";

export const CHANNEL_GRAPH_SCOPE = "__channel__";

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
  name: string,
): Promise<TopologyData> {
  if (name === CHANNEL_GRAPH_SCOPE) {
    return fetchChannelTopologyTriples(channelId);
  }
  return queryDkgProvider<TopologyData, "subgraph_triples">({
    channelId,
    operation: "subgraph_triples",
    arguments: { name },
    localPath: cg
      ? `/api/subgraph-triples?cg=${encodeURIComponent(cg)}&name=${encodeURIComponent(name)}`
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

const PREFIXES = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX schema: <http://schema.org/>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX memory: <http://dkg.io/ontology/memory/>
PREFIX decisions: <http://dkg.io/ontology/decisions/>
PREFIX tasks: <http://dkg.io/ontology/tasks/>
PREFIX code: <http://dkg.io/ontology/code/>
PREFIX github: <http://dkg.io/ontology/github/>
PREFIX software: <http://dkg.io/ontology/software/>
PREFIX buzz: <https://w3id.org/buzz-dkg/buzz#>
`;

const FALLBACK_NODE_QUERY = `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate { rdf:type schema:name schema:description }
    ?subject ?predicate ?object .
  }
}
LIMIT 100`;

// Keep containment, domain semantics, and provenance in separate bounded
// queries. A single VALUES query over a mature channel used to spend all 100
// rows on prov:wasDerivedFrom, starving memory:contains and domain links and
// leaving the visualizer with an unrelated slice of node labels.
const CONTAINMENT_RELATION_QUERY = `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate { memory:contains }
    ?subject ?predicate ?object .
  }
}
LIMIT 40`;

const DOMAIN_RELATION_QUERY = `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate {
      memory:about memory:supports memory:contradicts memory:resolves
      decisions:affects decisions:recordedIn decisions:implementedBy decisions:supersedes
      tasks:assignee tasks:relatedDecision tasks:dependsOn tasks:touches
      code:contains code:definedIn code:calls code:dependsOn
      github:authoredBy github:reviewedBy github:affects github:inRepo github:containsCommit github:closes
      software:tests software:executedTest software:supports software:deployedCommit
    }
    ?subject ?predicate ?object .
  }
}
LIMIT 60`;

const PROVENANCE_RELATION_QUERY = `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate {
      prov:wasDerivedFrom prov:wasGeneratedBy prov:wasAttributedTo
      buzz:channel buzz:proposalEvent buzz:inThreadOf
    }
    ?subject ?predicate ?object .
  }
}
LIMIT 20`;

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

function bindingString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const nested = (value as { value?: unknown }).value;
    return typeof nested === "string" ? nested : null;
  }
  return null;
}

function triplesFrom(result: SemanticResult): TopologyTriple[] {
  const triples: TopologyTriple[] = [];
  for (const layer of result.layers ?? []) {
    for (const binding of layer.bindings ?? []) {
      const subject = bindingString(binding.subject);
      const predicate = bindingString(binding.predicate);
      const object = bindingString(binding.object);
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

function endpointMetadataQuery(endpoints: string[]): string {
  return `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?subject { ${endpoints.map((iri) => `<${iri}>`).join(" ")} }
    VALUES ?predicate { rdf:type schema:name schema:description }
    ?subject ?predicate ?object .
  }
}
LIMIT 100`;
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
  for (const sparql of [
    CONTAINMENT_RELATION_QUERY,
    DOMAIN_RELATION_QUERY,
    PROVENANCE_RELATION_QUERY,
  ]) {
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
        ? endpointMetadataQuery(endpoints)
        : FALLBACK_NODE_QUERY,
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
    subgraph: CHANNEL_GRAPH_SCOPE,
    triples,
  };
}
