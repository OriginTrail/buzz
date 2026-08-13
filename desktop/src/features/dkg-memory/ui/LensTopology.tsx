// Hex-graph mode for the client-assembled lenses (all-decisions and
// per-contributor). Same renderer, options, and dark node-idiom island as
// TopologyView — but fed triples projected from the lens graph instead of a
// provider round-trip, so the Graph view stays scoped to exactly what the
// lens shows. Render-only: node clicks select, they never navigate.
import { Suspense, lazy, useMemo, useRef, useState } from "react";
import type { LensGraph } from "../lensGraphs";
import { lensTriples } from "../lensGraphs";
import { GraphNavigationControls } from "../topology/GraphNavigationControls";
import { NODE_UI_GRAPH_OPTIONS } from "../topology/TopologyView";

const RdfGraph = lazy(() =>
  import("@origintrail-official/dkg-graph-viz/react").then((m) => ({
    default: m.RdfGraph,
  })),
);
const NodePanel = lazy(() =>
  import("@origintrail-official/dkg-graph-viz/react").then((m) => ({
    default: m.NodePanel,
  })),
);

export function LensTopology({
  graph,
  onSelectUri,
}: {
  graph: LensGraph;
  onSelectUri: (uri: string, label?: string) => void;
}) {
  const triples = useMemo(() => lensTriples(graph), [graph]);
  const [fitRevision, setFitRevision] = useState(0);
  const graphSurfaceRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <GraphNavigationControls
          surfaceRef={graphSurfaceRef}
          onFit={() => setFitRevision((revision) => revision + 1)}
        />
        <span className="text-2xs text-muted-foreground">
          {graph.nodes.length} entities · {graph.edges.length} relationships ·
          colors = entity types, as in your DKG node
        </span>
      </div>
      <div
        ref={graphSurfaceRef}
        data-buzz-wheel-surface
        className="min-h-0 flex-1"
        style={{ background: "#0a0a0f" }}
      >
        <Suspense
          fallback={
            <div className="p-6 text-sm text-muted-foreground">
              Loading graph renderer…
            </div>
          }
        >
          <RdfGraph
            key={fitRevision}
            data={triples}
            format="triples"
            options={NODE_UI_GRAPH_OPTIONS}
            initialFit
            onNodeClick={(node) => onSelectUri(node.id, node.label)}
            className="h-full w-full"
            style={{ height: "100%" }}
          >
            <NodePanel
              showUri
              showTypes
              showProperties
              showMetadata={false}
              maxValueLength={150}
            />
          </RdfGraph>
        </Suspense>
      </div>
    </div>
  );
}
