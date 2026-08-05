// Full-screen inspection state of the Memory panel — the graph view's ONE
// home in v1 (per the deliberation: panel expansion first, built as the
// reusable canvas the Knowledge section mounts later). Read-only: node click
// selects and focuses the evidence rail; the graph orients, it never
// navigates away. Labels are inert text; no editing, no action execution.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useSubgraphGraph } from "../hooks";
import { TopologyView } from "../topology/TopologyView";
import { GraphCanvas, type GraphSelection } from "./GraphCanvas";

const LAYER_META = {
  WM: { label: "Draft — only on this node", dot: "bg-slate-400" },
  SWM: {
    label: "Channel Memory — shared with channel members",
    dot: "bg-amber-400",
  },
  VM: {
    label: "Anchored Record — integrity anchor on-chain",
    dot: "bg-green-500",
  },
} as const;

export function GraphOverlay({
  cg,
  subgraph,
  onClose,
}: {
  cg: string;
  subgraph: string;
  onClose: () => void;
}) {
  const graph = useSubgraphGraph(cg, subgraph);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  // Spine is the first paint; topology (hexagonal RdfGraph) mounts only on
  // this explicit scoped action — per the repurpose wrap's acceptance gate.
  const [mode, setMode] = useState<"spine" | "topology">("spine");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const data = graph.data;
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);

  const decisionCount = nodes.filter((n) => n.kind === "decision").length;
  const evidenceCount = nodes.length - decisionCount;
  const layerCounts = useMemo(() => {
    const c = { WM: 0, SWM: 0, VM: 0 };
    for (const n of nodes) if (n.layer) c[n.layer] += 1;
    return c;
  }, [nodes]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background"
      data-testid="dkg-graph-overlay"
    >
      <header className="flex items-center gap-3 border-b border-border py-2 pl-20 pr-4">
        <h2 className="text-sm font-semibold">
          {subgraph}
          <span className="ml-2 font-normal text-muted-foreground">
            {decisionCount} decisions · {evidenceCount} evidence
          </span>
        </h2>
        <span className="rounded-md border border-green-600/40 bg-green-600/10 px-2 py-0.5 text-xs">
          provenance checked by your node
        </span>
        <div className="ml-2 flex items-center gap-2">
          {(["WM", "SWM", "VM"] as const).map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-2xs"
              title={LAYER_META[tag].label}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${LAYER_META[tag].dot}`}
              />
              {tag}
              <span className="tabular-nums text-muted-foreground">
                {layerCounts[tag]}
              </span>
            </span>
          ))}
        </div>
        <div className="flex-1" />
        <div className="mr-2 flex rounded-md border border-border text-xs">
          <button
            type="button"
            onClick={() => setMode("spine")}
            className={`rounded-l-md px-2 py-1 ${mode === "spine" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
          >
            Traces
          </button>
          <button
            type="button"
            onClick={() => setMode("topology")}
            data-testid="dkg-topology-toggle"
            className={`rounded-r-md px-2 py-1 ${mode === "topology" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
          >
            ⬡ Graph
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
          aria-label="Close graph view"
        >
          ✕ close
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          {graph.isLoading && (
            <div className="p-6 text-sm text-muted-foreground">
              Reading subgraph through your node…
            </div>
          )}
          {graph.isError && (
            <div className="p-6 text-sm text-muted-foreground">
              Could not read this subgraph through your local node.
            </div>
          )}
          {data && data.gate !== "ok" && (
            <div className="p-6 text-sm text-muted-foreground">
              Your edge node is not answering — the graph view resolves only
              through your own node.
            </div>
          )}
          {data && data.gate === "ok" && mode === "spine" && (
            <GraphCanvas
              nodes={nodes}
              edges={edges}
              selectedId={selection?.node.id ?? null}
              onSelect={setSelection}
            />
          )}
          {mode === "topology" && (
            <TopologyView
              cg={cg}
              subgraph={subgraph}
              onSelectUri={(uri, label) => {
                const known = nodes.find((n) => n.id === uri);
                if (known) {
                  const neighbors: {
                    rel: string;
                    node: (typeof nodes)[number];
                  }[] = [];
                  const seen = new Set<string>();
                  for (const e of edges) {
                    if (e.from !== uri && e.to !== uri) continue;
                    const other = nodes.find(
                      (n) => n.id === (e.from === uri ? e.to : e.from),
                    );
                    if (!other || seen.has(`${e.rel}|${other.id}`)) continue;
                    seen.add(`${e.rel}|${other.id}`);
                    neighbors.push({ rel: e.rel, node: other });
                  }
                  setSelection({ node: known, neighbors });
                } else {
                  setSelection({
                    node: {
                      id: uri,
                      kind: "claim",
                      label: label ?? uri,
                      at: null,
                    },
                    neighbors: [],
                  });
                }
              }}
            />
          )}
        </main>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-border p-3">
          {selection ? (
            <EvidenceRail selection={selection} />
          ) : mode === "spine" ? (
            <p className="text-xs text-muted-foreground">
              Select a decision or evidence row to inspect its trail here. Cards
              are decisions in time order; ⊕ rows support a decision, ⊖ rows
              contest it. The strip up top is the whole deliberation — amber
              ticks are contested; click to jump.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              The knowledge graph as your DKG node renders it — hexagons are
              entities, sized by connections; zoom in for labels. Click a node
              to inspect it, or select one to open its evidence trail here.
            </p>
          )}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

function EvidenceRail({ selection }: { selection: GraphSelection }) {
  const { node, neighbors } = selection;
  return (
    <div className="space-y-3">
      <div>
        <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs uppercase tracking-wide">
          {node.kind}
        </span>
        {node.layer && (
          <span className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs">
            <span
              className={`h-1.5 w-1.5 rounded-full ${LAYER_META[node.layer].dot}`}
            />
            {LAYER_META[node.layer].label}
          </span>
        )}
        {(node.contested ?? 0) > 0 && (
          <span className="ml-1.5 rounded-full border border-amber-500/60 bg-amber-500/10 px-2 py-0.5 text-2xs text-amber-500">
            contested ({node.contested})
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap text-xs leading-snug">{node.label}</p>
      {node.at && (
        <p className="text-2xs text-muted-foreground">
          {new Date(node.at * 1000).toLocaleString()}
        </p>
      )}
      {node.commit && (
        <p className="break-all font-mono text-2xs text-muted-foreground">
          commit {node.commit}
        </p>
      )}
      {neighbors.length > 0 && (
        <section>
          <h4 className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Evidence trail
          </h4>
          <div className="space-y-1.5">
            {neighbors.map((n) => (
              <div
                key={`${n.rel}-${n.node.id}`}
                className="rounded-md border border-border bg-muted/20 px-2 py-1"
              >
                <span
                  className={`text-2xs uppercase ${
                    n.rel === "contradicts"
                      ? "text-amber-500"
                      : "text-muted-foreground"
                  }`}
                >
                  {n.rel}
                </span>
                <p className="text-xs leading-snug">
                  {n.node.label.slice(0, 160)}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="break-all font-mono text-3xs text-muted-foreground/70">
        {node.id}
      </p>
    </div>
  );
}
