// Adapter boundary for the topology view. The shared provider owns local-first
// selection and authenticated community fallback; render code remains transport
// agnostic and remote authorization remains channel-scoped.
import { queryDkgProvider } from "../provider";

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
  return queryDkgProvider<TopologyData, "subgraph_triples">({
    channelId,
    operation: "subgraph_triples",
    arguments: { name },
    localPath: cg
      ? `/api/subgraph-triples?cg=${encodeURIComponent(cg)}&name=${encodeURIComponent(name)}`
      : null,
  });
}
