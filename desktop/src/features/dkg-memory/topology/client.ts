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
`;

const NODE_QUERY = `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate { rdf:type schema:name schema:description }
    ?subject ?predicate ?object .
  }
}
LIMIT 100`;

const RELATION_QUERY = `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate {
      prov:wasDerivedFrom
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
LIMIT 100`;

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
  const [nodes, relations] = await Promise.all([
    semanticQuery(channelId, NODE_QUERY),
    semanticQuery(channelId, RELATION_QUERY),
  ]);
  const all = [...triplesFrom(nodes), ...triplesFrom(relations)];
  const seen = new Set<string>();
  const triples = all.filter((triple) => {
    const key = `${triple.layer}|${triple.subject}|${triple.predicate}|${triple.object}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    gate: "ok",
    cg: nodes.cg ?? relations.cg,
    subgraph: CHANNEL_GRAPH_SCOPE,
    triples,
  };
}
