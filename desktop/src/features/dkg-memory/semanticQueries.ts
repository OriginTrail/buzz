import type { SemanticQueryResult } from "./api";

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

const STOP_WORDS = new Set([
  "a",
  "about",
  "all",
  "and",
  "are",
  "did",
  "do",
  "find",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "our",
  "show",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
]);

export type MemorySearchRow = {
  entity: string;
  name: string;
  description?: string;
  type?: string;
  layer: "SWM" | "VM";
};

export function semanticBindingString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const nested = (value as { value?: unknown }).value;
    return typeof nested === "string" ? nested : undefined;
  }
  return undefined;
}

function displayLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^"([\s\S]*)"(?:\^\^<[^>]+>|@[a-z-]+)?$/i.exec(value);
  return (match?.[1] ?? value).replaceAll('\\"', '"').replaceAll("\\n", "\n");
}

function compactType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/^<|>$/g, "");
  return clean.split(/[/#]/).pop() || clean;
}

export function memorySearchRows(
  result: SemanticQueryResult,
): MemorySearchRow[] {
  const rows: MemorySearchRow[] = [];
  const seen = new Set<string>();
  for (const layer of result.layers ?? []) {
    for (const binding of layer.bindings ?? []) {
      const entity = semanticBindingString(binding.entity);
      const name = displayLiteral(semanticBindingString(binding.name));
      if (!entity || !name) continue;
      const key = `${layer.layer}|${entity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        entity,
        name,
        description: displayLiteral(semanticBindingString(binding.description)),
        type: compactType(semanticBindingString(binding.type)),
        layer: layer.layer,
      });
    }
  }
  return rows;
}

export function buildMemoryKeywordQuery(value: string): string {
  const terms = Array.from(
    new Set(
      value
        .toLowerCase()
        .match(/[\p{L}\p{N}_.:/#@+-]+/gu)
        ?.filter((term) => term.length > 1 && !STOP_WORDS.has(term)) ?? [],
    ),
  ).slice(0, 5);
  if (terms.length === 0) {
    throw new Error("Add a topic, person, decision, file or code symbol.");
  }
  const filter = terms
    .map((term) => {
      const literal = JSON.stringify(term);
      return `(CONTAINS(LCASE(STR(?name)), ${literal}) || CONTAINS(LCASE(COALESCE(STR(?description), "")), ${literal}))`;
    })
    .join(" || ");
  return `${PREFIXES}
SELECT DISTINCT ?entity ?name ?description ?type WHERE {
  GRAPH ?g {
    ?entity schema:name ?name .
    OPTIONAL { ?entity schema:description ?description }
    OPTIONAL { ?entity rdf:type ?type }
    FILTER (${filter})
  }
}
LIMIT 25`;
}

export const MEMORY_SEARCH_SUGGESTIONS = {
  "Recent decisions": `${PREFIXES}
SELECT DISTINCT ?entity ?name ?description ?type WHERE {
  GRAPH ?g {
    ?entity rdf:type decisions:Decision ; schema:name ?name .
    OPTIONAL { ?entity schema:description ?description }
    BIND(decisions:Decision AS ?type)
  }
}
LIMIT 25`,
  "Open tasks": `${PREFIXES}
SELECT DISTINCT ?entity ?name ?description ?type WHERE {
  GRAPH ?g {
    ?entity rdf:type tasks:Task ; schema:name ?name .
    OPTIONAL { ?entity schema:description ?description }
    OPTIONAL { ?entity tasks:status ?status }
    FILTER (!BOUND(?status) || (!CONTAINS(LCASE(STR(?status)), "done") && !CONTAINS(LCASE(STR(?status)), "complete")))
    BIND(tasks:Task AS ?type)
  }
}
LIMIT 25`,
  "People & agents": `${PREFIXES}
SELECT DISTINCT ?entity ?name ?description ?type WHERE {
  GRAPH ?g {
    VALUES ?type { schema:Person github:User }
    ?entity rdf:type ?type ; schema:name ?name .
    OPTIONAL { ?entity schema:description ?description }
  }
}
LIMIT 25`,
} as const;

export const CHANNEL_TOPOLOGY_RELATION_QUERIES = [
  `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate { memory:contains }
    ?subject ?predicate ?object .
  }
}
LIMIT 40`,
  `${PREFIXES}
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
LIMIT 60`,
  `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate {
      prov:wasDerivedFrom prov:wasGeneratedBy prov:wasAttributedTo
      buzz:channel buzz:proposalEvent buzz:inThreadOf
    }
    ?subject ?predicate ?object .
  }
}
LIMIT 20`,
] as const;

export const CHANNEL_TOPOLOGY_FALLBACK_NODE_QUERY = `${PREFIXES}
SELECT ?subject ?predicate ?object WHERE {
  GRAPH ?g {
    VALUES ?predicate { rdf:type schema:name schema:description }
    ?subject ?predicate ?object .
  }
}
LIMIT 100`;

export function buildTopologyEndpointMetadataQuery(
  endpoints: string[],
): string {
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
