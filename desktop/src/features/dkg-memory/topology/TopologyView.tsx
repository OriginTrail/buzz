// Graph mode of the overlay — the node-UI-parity hexagonal RDF canvas
// (dkg-graph-viz, exact-pinned 10.0.11), mounted ONLY when the user
// explicitly enters the Graph view (acceptance gate from the repurpose
// wrap: no RdfGraph import until a scoped graph action). Render-only:
// data arrives through the client boundary; node clicks select — they
// never navigate.
//
// Visual parity with the DKG node UI: options mirror MemoryLayerView's
// GRAPH_OPTIONS (packages/node-ui) — humanized labels over the same
// predicate list, the schema.org class palette, hexagon sizing, and the
// NodePanel inspector. "Entity types" coloring is the node-parity default;
// "Contributors" preserves the attribution view (recorded attribution,
// not verification).
import { Suspense, lazy, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CHANNEL_GRAPH_SCOPE, fetchTopologyTriples } from "./client";
import {
  applyHeaviestSubjectsCap,
  attributionLegend,
  attributionNodeColors,
  splitGraphTriplesForShelf,
  topologySummary,
} from "./topology";

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

// Mirrors packages/node-ui MemoryLayerView GRAPH_OPTIONS + memoryGraphLabels.
const NODE_UI_LABEL_PREDICATES = [
  "http://schema.org/text",
  "http://schema.org/name",
  "http://www.w3.org/2000/01/rdf-schema#label",
  "http://purl.org/dc/terms/title",
  "http://purl.org/dc/elements/1.1/title",
  "http://xmlns.com/foaf/0.1/name",
];
const BUZZ_NS = "https://w3id.org/buzz-dkg/buzz#";
const NODE_UI_GRAPH_OPTIONS = {
  labelMode: "humanized" as const,
  renderer: "2d" as const,
  labels: { predicates: NODE_UI_LABEL_PREDICATES },
  style: {
    classColors: {
      // node-UI schema.org palette…
      "http://schema.org/Person": "#f472b6",
      "http://schema.org/Organization": "#fb923c",
      "http://schema.org/Place": "#34d399",
      "http://schema.org/Product": "#c084fc",
      "http://schema.org/Event": "#facc15",
      "http://schema.org/CreativeWork": "#7dd3fc",
      "http://schema.org/Thing": "#94a3b8",
      // …extended to the buzz-dkg ontology with the same hues:
      [`${BUZZ_NS}Claim`]: "#7dd3fc", // a claim is a creative record
      [`${BUZZ_NS}AgentRun`]: "#facc15", // a run is an event
      [`${BUZZ_NS}DecisionCluster`]: "#c084fc",
      [`${BUZZ_NS}Commit`]: "#fb923c",
      [`${BUZZ_NS}Evidence`]: "#34d399",
    },
    defaultNodeColor: "#94a3b8",
    defaultEdgeColor: "#5f8598",
    edgeWidth: 0.9,
  },
  hexagon: { baseSize: 4, minSize: 3, maxSize: 6, scaleWithDegree: true },
  focus: { maxNodes: 3000, hops: 999 },
};

export function TopologyView({
  channelId,
  cg,
  subgraph,
  onSelectUri,
}: {
  channelId: string;
  cg: string | null;
  subgraph: string;
  onSelectUri: (uri: string, label?: string) => void;
}) {
  const [colorMode, setColorMode] = useState<"entity" | "attribution">(
    "entity",
  );
  const channelWide = subgraph === CHANNEL_GRAPH_SCOPE;
  const query = useQuery({
    queryKey: ["dkg-memory", "topology", channelId, cg, subgraph],
    queryFn: () => fetchTopologyTriples(channelId, cg, subgraph),
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
  const summary = useMemo(
    () => topologySummary(shaped.canvasTriples),
    [shaped.canvasTriples],
  );

  if (query.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Reading subgraph triples through the DKG provider…
      </div>
    );
  }
  if (query.isError || query.data?.gate !== "ok") {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Graph unavailable through the local node and community DKG provider.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Color-mode header: entity types (node-UI parity) or contributors. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="flex rounded-md border border-border text-2xs">
          <button
            type="button"
            onClick={() => setColorMode("entity")}
            className={`rounded-l-md px-2 py-0.5 ${colorMode === "entity" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
          >
            Entity types
          </button>
          {!channelWide && (
            <button
              type="button"
              onClick={() => setColorMode("attribution")}
              className={`rounded-r-md px-2 py-0.5 ${colorMode === "attribution" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
            >
              Contributors
            </button>
          )}
        </span>
        {colorMode === "attribution" &&
          shaped.legend.map((l) => (
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
          {summary.entities} connected entities · {summary.relationships}{" "}
          relationships ·{" "}
          {channelWide
            ? "bounded channel view · use search to narrow further"
            : colorMode === "attribution"
              ? "colors = recorded attribution, not verification"
              : "colors = entity types, as in your DKG node"}
          {shaped.dropped > 0 && ` · ${shaped.dropped} triples beyond cap`}
        </span>
      </div>

      {/* Dark node-idiom island: the renderer's palette is tuned for the DKG
          node UI's canvas (#0a0a0f); rendering on that background *is* the
          node look — bright hexagons, thin edges, light labels. */}
      <div className="min-h-0 flex-1" style={{ background: "#0a0a0f" }}>
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
            options={
              colorMode === "entity"
                ? NODE_UI_GRAPH_OPTIONS
                : {
                    ...NODE_UI_GRAPH_OPTIONS,
                    style: {
                      ...NODE_UI_GRAPH_OPTIONS.style,
                      nodeColors: shaped.nodeColors,
                    },
                  }
            }
            initialFit
            onNodeClick={(node) => onSelectUri(node.id, node.label)}
            className="h-full w-full"
            style={{ height: "100%" }}
          >
            {/* Node-UI-parity inspector, same props as MemoryLayerView. */}
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
