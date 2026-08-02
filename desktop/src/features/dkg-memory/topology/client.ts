// Adapter boundary for the topology view (per the node-ui repurpose wrap):
// render code never calls the node or explorer directly — this module owns
// the transport. Today's implementation reads the local explorer (fallback
// transport per the spec); the canonical direct-node transport can replace
// the body without touching render code, because the contract is node-shaped.
const EXPLORER = "http://127.0.0.1:9295";

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
  cg: string,
  name: string,
): Promise<TopologyData> {
  const res = await fetch(
    `${EXPLORER}/api/subgraph-triples?cg=${encodeURIComponent(cg)}&name=${encodeURIComponent(name)}`,
  );
  if (!res.ok) throw new Error(`subgraph-triples ${res.status}`);
  return (await res.json()) as TopologyData;
}
