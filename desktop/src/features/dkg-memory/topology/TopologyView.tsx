// Scoped topology mode of the graph overlay — the node-UI-parity hexagonal
// RDF canvas (dkg-graph-viz, exact-pinned 10.0.11), mounted ONLY when the
// user explicitly enters topology (acceptance gate from the repurpose wrap:
// no RdfGraph import until a scoped topology action). Render-only: data
// arrives through the topology client boundary; node clicks select — they
// never navigate. Attribution colors show recorded attribution, not
// verification.
import { Suspense, lazy, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTopologyTriples } from "./client";
import {
  applyHeaviestSubjectsCap,
  attributionLegend,
  attributionNodeColors,
  splitGraphTriplesForShelf,
} from "./topology";

const RdfGraph = lazy(() =>
  import("@origintrail-official/dkg-graph-viz/react").then((m) => ({
    default: m.RdfGraph,
  })),
);

export function TopologyView({
  cg,
  subgraph,
  onSelectUri,
}: {
  cg: string;
  subgraph: string;
  onSelectUri: (uri: string, label?: string) => void;
}) {
  const query = useQuery({
    queryKey: ["dkg-memory", "topology", cg, subgraph],
    queryFn: () => fetchTopologyTriples(cg, subgraph),
    staleTime: 30 * 1000,
  });

  const shaped = useMemo(() => {
    const triples = query.data?.triples ?? [];
    const bounded = applyHeaviestSubjectsCap(triples);
    const { canvasTriples, singletonItems } =
      splitGraphTriplesForShelf(bounded);
    return {
      canvasTriples,
      singletonItems,
      nodeColors: attributionNodeColors(bounded),
      legend: attributionLegend(bounded),
      dropped: triples.length - bounded.length,
    };
  }, [query.data]);

  const graphData = useMemo(
    () =>
      shaped.canvasTriples.map((t) => ({
        subject: t.subject,
        predicate: t.predicate,
        object: t.object,
      })),
    [shaped.canvasTriples],
  );

  if (query.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Reading subgraph triples through your node…
      </div>
    );
  }
  if (query.isError || query.data?.gate !== "ok") {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Topology unavailable — the graph resolves only through your own node.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Attribution legend — recorded attribution, never verification. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        {shaped.legend.map((l) => (
          <span
            key={l.agent}
            className="flex items-center gap-1 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-2xs"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: l.color }}
            />
            {l.agent}
            <span className="tabular-nums text-muted-foreground">
              {l.subjects}
            </span>
          </span>
        ))}
        <span className="ml-auto text-2xs text-muted-foreground">
          colors = recorded attribution, not verification
          {shaped.dropped > 0 && ` · ${shaped.dropped} triples beyond cap`}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="p-6 text-sm text-muted-foreground">
              Loading graph renderer…
            </div>
          }
        >
          <RdfGraph
            data={graphData}
            format="triples"
            options={{
              labelMode: "humanized",
              renderer: "2d",
              style: { nodeColors: shaped.nodeColors },
            }}
            initialFit
            onNodeClick={(node) => onSelectUri(node.id, node.label)}
            className="h-full w-full"
            style={{ height: "100%" }}
          />
        </Suspense>
      </div>

      {shaped.singletonItems.length > 0 && (
        <div className="border-t border-border px-3 py-1.5">
          <span
            className="mr-2 text-2xs text-muted-foreground"
            title="Entities with no visible links are grouped here to keep the graph readable."
          >
            Standalone entities ({shaped.singletonItems.length})
          </span>
          <span className="inline-flex max-w-full flex-wrap gap-1 align-middle">
            {shaped.singletonItems.slice(0, 12).map((item) => (
              <button
                key={item.uri}
                type="button"
                title={item.uri}
                onClick={() => onSelectUri(item.uri, item.label)}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs hover:bg-muted"
              >
                {item.label.slice(0, 32)}
              </button>
            ))}
            {shaped.singletonItems.length > 12 && (
              <span className="text-2xs text-muted-foreground">
                +{shaped.singletonItems.length - 12}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
