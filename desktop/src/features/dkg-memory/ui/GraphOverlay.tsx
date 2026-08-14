// Full-screen inspection state of the Memory panel — the graph view's ONE
// home in v1 (per the deliberation: panel expansion first, built as the
// reusable canvas the Knowledge section mounts later). Read-only: node click
// selects and focuses the evidence rail; the graph orients, it never
// navigates away. Labels are inert text; no editing, no action execution.
//
// Four lenses share this overlay: the whole channel, a named subgraph, the
// all-decisions timeline, and one contributor's trail. The latter two are
// client-assembled (lensGraphs) from operations every deployment already
// serves, so Traces AND Graph work even while capture is flat and the
// gateway advertises no named subgraphs.
import { Hexagon, ListTree } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DecisionEntry, GraphEdge, GraphNode } from "../api";
import { explorerSource } from "../api";
import {
  useContributorGraph,
  useDecisionsGraph,
  useEvidence,
  useSubgraphGraph,
} from "../hooks";
import { lensLayerCounts } from "../lensGraphs";
import { TopologyView } from "../topology/TopologyView";
import type { TopologyTarget } from "../topology/client";
import { GraphCanvas, type GraphSelection } from "./GraphCanvas";
import { LensTopology } from "./LensTopology";
import { NodeUiResolve } from "./NodeUiResolve";

export type GraphOverlayTarget =
  | TopologyTarget
  | { kind: "channel-decisions"; decisions: DecisionEntry[] }
  | { kind: "contributor"; pubkey: string; name: string };

function decisionsToNodes(decisions: DecisionEntry[]): GraphNode[] {
  return decisions.map((decision) => ({
    id: decision.uri,
    kind: "decision",
    label: decision.name ?? decision.uri.split("/").pop() ?? decision.uri,
    at: decision.at
      ? Math.floor(new Date(decision.at).getTime() / 1_000) || null
      : null,
  }));
}

/** One-hop selection out of a lens graph — the shared rail contract. */
function selectionFor(
  nodes: GraphNode[],
  edges: GraphEdge[],
  uri: string,
  label?: string,
): GraphSelection {
  const known = nodes.find((node) => node.id === uri);
  if (!known) {
    return {
      node: { id: uri, kind: "claim", label: label ?? uri, at: null },
      neighbors: [],
      evidenceUri: uri,
    };
  }
  const neighbors: GraphSelection["neighbors"] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (edge.from !== uri && edge.to !== uri) continue;
    const other = nodes.find(
      (node) => node.id === (edge.from === uri ? edge.to : edge.from),
    );
    if (!other || seen.has(`${edge.rel}|${other.id}`)) continue;
    seen.add(`${edge.rel}|${other.id}`);
    neighbors.push({ rel: edge.rel, node: other });
  }
  return {
    node: known,
    neighbors,
    evidenceUri: neighbors.length === 0 ? known.id : undefined,
  };
}

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
  channelId,
  cg,
  target,
  onClose,
}: {
  channelId: string;
  cg: string | null;
  target: GraphOverlayTarget;
  onClose: () => void;
}) {
  if (target.kind === "channel") {
    return (
      <ChannelGraphOverlay
        channelId={channelId}
        cg={cg}
        target={target}
        onClose={onClose}
      />
    );
  }
  if (target.kind === "channel-decisions") {
    return (
      <DecisionsGraphOverlay
        channelId={channelId}
        cg={cg}
        target={target}
        onClose={onClose}
      />
    );
  }
  if (target.kind === "contributor") {
    return (
      <ContributorGraphOverlay
        channelId={channelId}
        cg={cg}
        target={target}
        onClose={onClose}
      />
    );
  }
  return (
    <SubgraphGraphOverlay
      channelId={channelId}
      cg={cg}
      target={target}
      onClose={onClose}
    />
  );
}

type OverlayShellProps = {
  aside: ReactNode;
  /** Rendered dead-center in the header — the view toggle's prominent home. */
  center?: ReactNode;
  children: ReactNode;
  headerControls?: ReactNode;
  onClose: () => void;
  title: ReactNode;
};

function GraphOverlayShell({
  aside,
  center,
  children,
  headerControls,
  onClose,
  title,
}: OverlayShellProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background"
      data-testid="dkg-graph-overlay"
    >
      <header className="relative flex items-center gap-3 border-b border-border py-2 pl-20 pr-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <ProviderBadge />
        {center && (
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            {center}
          </div>
        )}
        <div className="flex-1" />
        {headerControls}
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
        <main className="min-w-0 flex-1">{children}</main>
        <aside className="w-80 shrink-0 overflow-y-auto border-l border-border p-3">
          {aside}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

function ProviderBadge() {
  return explorerSource() === "gateway" ? (
    <span className="rounded-md border border-sky-600/40 bg-sky-600/10 px-2 py-0.5 text-xs">
      resolved through the community DKG provider
    </span>
  ) : (
    <span className="rounded-md border border-green-600/40 bg-green-600/10 px-2 py-0.5 text-xs">
      provenance checked by your node
    </span>
  );
}

// Lens legends count NODES IN THIS VIEW — a different unit from the
// dashboard's layer cards (channel-wide entity totals). The qualifier is
// load-bearing: without it the same chip design silently means two things
// (buzz-dkg-beta#13).
function LayerCountsLegend({
  counts,
}: {
  counts: Readonly<Record<keyof typeof LAYER_META, number>>;
}) {
  return (
    <div className="ml-2 flex items-center gap-2">
      {(["WM", "SWM", "VM"] as const).map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-2xs"
          title={`${LAYER_META[tag].label} — nodes in this view, not the channel total`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${LAYER_META[tag].dot}`} />
          {tag}
          <span className="tabular-nums text-muted-foreground">
            {counts[tag]}
          </span>
        </span>
      ))}
      <span className="text-2xs italic text-muted-foreground">
        in this view
      </span>
    </div>
  );
}

// The lens's two ways of seeing — a first-class, centered segmented control
// rather than a corner utility. The active segment carries the primary color
// with a soft glow; the switch itself sits on a subtle gradient ring so it
// reads as THE control of the overlay.
function GraphModeToggle({
  mode,
  onChange,
}: {
  mode: "spine" | "topology";
  onChange: (mode: "spine" | "topology") => void;
}) {
  const segment = (active: boolean) =>
    `flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all duration-200 ${
      active
        ? "bg-primary text-primary-foreground shadow-md shadow-primary/40"
        : "text-muted-foreground hover:bg-primary/10 hover:text-foreground"
    }`;
  return (
    <div
      className="flex items-center gap-0.5 rounded-full border border-primary/30 bg-gradient-to-b from-primary/15 via-primary/5 to-transparent p-1 shadow-lg shadow-primary/10 backdrop-blur-sm"
      data-testid="dkg-view-toggle"
    >
      <button
        type="button"
        onClick={() => onChange("spine")}
        className={segment(mode === "spine")}
        aria-pressed={mode === "spine"}
      >
        <ListTree className="h-3.5 w-3.5" />
        Traces
      </button>
      <button
        type="button"
        onClick={() => onChange("topology")}
        data-testid="dkg-topology-toggle"
        className={segment(mode === "topology")}
        aria-pressed={mode === "topology"}
      >
        <Hexagon className="h-3.5 w-3.5" />
        Graph
      </button>
    </div>
  );
}

function ChannelGraphOverlay({
  channelId,
  cg,
  target,
  onClose,
}: {
  channelId: string;
  cg: string | null;
  target: Extract<TopologyTarget, { kind: "channel" }>;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<GraphSelection | null>(null);

  return (
    <GraphOverlayShell
      onClose={onClose}
      title="Channel knowledge graph"
      aside={
        selection ? (
          <EvidenceRail selection={selection} channelId={channelId} cg={cg} />
        ) : (
          <TopologyHelp />
        )
      }
    >
      <TopologyView
        channelId={channelId}
        cg={cg}
        target={target}
        onSelectUri={(uri, label, neighbors) => {
          const resolvedNeighbors = (neighbors ?? []).map((neighbor) => ({
            rel: neighbor.rel,
            node: {
              id: neighbor.uri,
              kind: "claim" as const,
              label: neighbor.label,
              at: null,
            },
          }));
          setSelection({
            node: { id: uri, kind: "claim", label: label ?? uri, at: null },
            neighbors: resolvedNeighbors,
            evidenceUri: resolvedNeighbors.length === 0 ? uri : undefined,
          });
        }}
      />
    </GraphOverlayShell>
  );
}

function DecisionsGraphOverlay({
  channelId,
  cg,
  target,
  onClose,
}: {
  channelId: string;
  cg: string | null;
  target: Extract<GraphOverlayTarget, { kind: "channel-decisions" }>;
  onClose: () => void;
}) {
  const enriched = useDecisionsGraph(channelId, cg, target.decisions);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [mode, setMode] = useState<"spine" | "topology">("spine");

  // The timeline never waits on enrichment: bare decision cards render
  // immediately and evidence rows appear when the envelopes resolve.
  const graph = useMemo(
    () =>
      enriched.data ?? {
        nodes: decisionsToNodes(target.decisions),
        edges: [] as GraphEdge[],
      },
    [enriched.data, target],
  );
  const decisionCount = graph.nodes.filter(
    (node) => node.kind === "decision",
  ).length;
  const evidenceCount = graph.nodes.length - decisionCount;
  const layerCounts = useMemo(() => lensLayerCounts(graph.nodes), [graph]);

  return (
    <GraphOverlayShell
      onClose={onClose}
      title={
        <>
          All decisions
          <span className="ml-2 font-normal text-muted-foreground">
            {decisionCount} decisions · {evidenceCount} evidence
            {enriched.isLoading ? " · resolving evidence…" : ""}
          </span>
        </>
      }
      headerControls={<LayerCountsLegend counts={layerCounts} />}
      center={<GraphModeToggle mode={mode} onChange={setMode} />}
      aside={
        selection ? (
          <EvidenceRail selection={selection} channelId={channelId} cg={cg} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Select a decision to inspect its provenance here — the messages it
            was derived from, who authored them, and when.
          </p>
        )
      }
    >
      {mode === "spine" ? (
        <GraphCanvas
          nodes={graph.nodes}
          edges={graph.edges}
          selectedId={selection?.node.id ?? null}
          onSelect={setSelection}
        />
      ) : (
        <LensTopology
          graph={graph}
          onSelectUri={(uri, label) =>
            setSelection(selectionFor(graph.nodes, graph.edges, uri, label))
          }
        />
      )}
    </GraphOverlayShell>
  );
}

function ContributorGraphOverlay({
  channelId,
  cg,
  target,
  onClose,
}: {
  channelId: string;
  cg: string | null;
  target: Extract<GraphOverlayTarget, { kind: "contributor" }>;
  onClose: () => void;
}) {
  const graph = useContributorGraph(channelId, cg, target.pubkey);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [mode, setMode] = useState<"spine" | "topology">("spine");
  const data = graph.data;
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const decisionCount = nodes.filter((node) => node.kind === "decision").length;
  const evidenceCount = nodes.length - decisionCount;
  const layerCounts = useMemo(() => lensLayerCounts(nodes), [nodes]);

  return (
    <GraphOverlayShell
      onClose={onClose}
      title={
        <>
          {target.name}
          <span className="ml-2 font-normal text-muted-foreground">
            {decisionCount} decisions · {evidenceCount} evidence
          </span>
        </>
      }
      headerControls={<LayerCountsLegend counts={layerCounts} />}
      center={<GraphModeToggle mode={mode} onChange={setMode} />}
      aside={
        selection ? (
          <EvidenceRail selection={selection} channelId={channelId} cg={cg} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Everything this participant fed into the channel's memory: cards are
            the decisions their contributions reached, ⊕ rows the signed
            messages behind them. Select any row to inspect its trail.
          </p>
        )
      }
    >
      {graph.isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">
          Reading this contributor's trail through the DKG provider…
        </div>
      ) : null}
      {graph.isError ? (
        <div className="p-6 text-sm text-muted-foreground">
          Could not read this contributor's trail through the available DKG
          provider.
        </div>
      ) : null}
      {data && mode === "spine" ? (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          selectedId={selection?.node.id ?? null}
          onSelect={setSelection}
        />
      ) : null}
      {data && mode === "topology" ? (
        <LensTopology
          graph={data}
          onSelectUri={(uri, label) =>
            setSelection(selectionFor(nodes, edges, uri, label))
          }
        />
      ) : null}
    </GraphOverlayShell>
  );
}

function SubgraphGraphOverlay({
  channelId,
  cg,
  target,
  onClose,
}: {
  channelId: string;
  cg: string | null;
  target: Extract<TopologyTarget, { kind: "subgraph" }>;
  onClose: () => void;
}) {
  const graph = useSubgraphGraph(channelId, cg, target.name);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [mode, setMode] = useState<"spine" | "topology">("spine");
  const data = graph.data;
  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);
  const decisionCount = nodes.filter((node) => node.kind === "decision").length;
  const evidenceCount = nodes.length - decisionCount;
  const layerCounts = useMemo(() => lensLayerCounts(nodes), [nodes]);

  const selectTopologyUri = (uri: string, label?: string) => {
    setSelection(selectionFor(nodes, edges, uri, label));
  };

  return (
    <GraphOverlayShell
      onClose={onClose}
      title={
        <>
          {target.name}
          <span className="ml-2 font-normal text-muted-foreground">
            {decisionCount} decisions · {evidenceCount} evidence
          </span>
        </>
      }
      headerControls={<LayerCountsLegend counts={layerCounts} />}
      center={<GraphModeToggle mode={mode} onChange={setMode} />}
      aside={
        selection ? (
          <EvidenceRail selection={selection} channelId={channelId} cg={cg} />
        ) : mode === "spine" ? (
          <p className="text-xs text-muted-foreground">
            Select a decision or evidence row to inspect its trail here. Cards
            are decisions in time order; ⊕ rows support a decision, ⊖ rows
            contest it. The strip up top is the whole deliberation — amber ticks
            are contested; click to jump.
          </p>
        ) : (
          <TopologyHelp />
        )
      }
    >
      {graph.isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">
          Reading subgraph through the DKG provider…
        </div>
      ) : null}
      {graph.isError ? (
        <div className="p-6 text-sm text-muted-foreground">
          Could not read this subgraph through the available DKG provider.
        </div>
      ) : null}
      {data && data.gate !== "ok" ? (
        <div className="p-6 text-sm text-muted-foreground">
          This graph is unavailable through both the local node and the
          community DKG provider.
        </div>
      ) : null}
      {data?.gate === "ok" && mode === "spine" ? (
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          selectedId={selection?.node.id ?? null}
          onSelect={setSelection}
        />
      ) : null}
      {mode === "topology" ? (
        <TopologyView
          channelId={channelId}
          cg={cg}
          target={target}
          onSelectUri={selectTopologyUri}
        />
      ) : null}
    </GraphOverlayShell>
  );
}

function TopologyHelp() {
  return (
    <p className="text-xs text-muted-foreground">
      The knowledge graph as your DKG node renders it — hexagons are entities,
      sized by connections; zoom in for labels. Click a node to inspect it, or
      select one to open its evidence trail here.
    </p>
  );
}

function EvidenceRail({
  selection,
  channelId,
  cg,
}: {
  selection: GraphSelection;
  channelId: string;
  cg: string | null;
}) {
  const { node, neighbors, evidenceUri } = selection;
  // Evidence resolution is chosen by the overlay/selection owner. The rail
  // renders that policy but never infers network work from incidental shape.
  const envelope = useEvidence(channelId, cg, evidenceUri ?? null);
  const sources =
    envelope.data?.found === false ? [] : (envelope.data?.sources ?? []);
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
      {cg && <NodeUiResolve cg={cg} layer={node.layer} entity={node.id} />}
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
      {evidenceUri && envelope.isLoading && (
        <p className="text-2xs text-muted-foreground">Resolving evidence…</p>
      )}
      {evidenceUri && envelope.isSuccess && sources.length > 0 && (
        <section data-testid="dkg-entity-evidence">
          <h4 className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Captured evidence
          </h4>
          <div className="space-y-1.5">
            {sources.map((source) => (
              <div
                key={source.id}
                className="rounded-md border border-border bg-muted/20 px-2 py-1"
              >
                <p className="text-xs leading-snug">
                  {(source.span ?? source.id).slice(0, 160)}
                </p>
                {source.at && (
                  <p className="text-2xs text-muted-foreground">
                    {new Date(source.at * 1000).toLocaleString()}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {evidenceUri && envelope.isSuccess && sources.length === 0 && (
        <p className="text-2xs text-muted-foreground">
          No captured evidence resolvable for this entity yet.
        </p>
      )}
      <p className="break-all font-mono text-3xs text-muted-foreground/70">
        {node.id}
      </p>
    </div>
  );
}
