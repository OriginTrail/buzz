// Deterministic graph canvas for a subgraph lens — the on-demand graph view
// the deliberation settled: time-ordered decision SPINE on the horizontal
// axis, one hop of evidence hanging OFF the spine (supports below,
// counter-claims above, dashed + labeled — never color alone), deterministic
// positions (no physics), labels only on selection. Scale picks the layout:
// this canvas IS the small-subgraph direct-DAG mode; cluster-map first paint
// for channel-wide scale arrives with the Knowledge section.
import { useMemo } from "react";
import type { GraphEdge, GraphNode } from "../api";

const LAYER_DOT = {
  WM: "fill-slate-400",
  SWM: "fill-amber-400",
  VM: "fill-green-500",
} as const;

const SLOT_W = 190;
const SPINE_Y = 150;
const EVIDENCE_Y0 = 230;
const EVIDENCE_DY = 48;
const CONTRA_Y0 = 70;
export const MAX_SPINE = 7;
const MAX_EVIDENCE_PER = 4;

export interface GraphSelection {
  node: GraphNode;
  neighbors: { rel: string; node: GraphNode }[];
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  window: number; // spine window start index
  onWindow: (start: number) => void;
  selectedId: string | null;
  onSelect: (sel: GraphSelection | null) => void;
}

export function GraphCanvas({
  nodes,
  edges,
  window: winStart,
  onWindow,
  selectedId,
  onSelect,
}: Props) {
  const layout = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const spine = nodes
      .filter((n) => n.kind === "decision")
      .sort(
        (a, b) =>
          (a.at ?? Number.MAX_SAFE_INTEGER) -
            (b.at ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label),
      );
    // Evidence grouped under the first decision it supports; counter-claims
    // grouped above the decision they contradict.
    const under = new Map<string, GraphNode[]>();
    const over = new Map<string, GraphNode[]>();
    const linked = new Set<string>();
    for (const e of edges) {
      const src = byId.get(e.from);
      const dst = byId.get(e.to);
      if (!src || !dst || dst.kind !== "decision") continue;
      const lane = e.rel === "contradicts" ? over : under;
      if (!lane.has(dst.id)) lane.set(dst.id, []);
      if (!lane.get(dst.id)?.some((n) => n.id === src.id)) {
        lane.get(dst.id)?.push(src);
      }
      linked.add(src.id);
    }
    for (const list of [...under.values(), ...over.values()]) {
      list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    }
    const unlinked = nodes
      .filter((n) => n.kind !== "decision" && !linked.has(n.id))
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return { byId, spine, under, over, unlinked };
  }, [nodes, edges]);

  const { spine, under, over, unlinked } = layout;
  // First paint: coarsest view that shows at least one contested decision;
  // fallback: the latest window (consensus rule + UT Voice's fallback).
  const start = Math.max(0, Math.min(winStart, spine.length - MAX_SPINE));
  const visible = spine.slice(start, start + MAX_SPINE);
  const width = Math.max(visible.length, 1) * SLOT_W + 80;
  const maxUnder = Math.max(
    0,
    ...visible.map((d) =>
      Math.min(under.get(d.id)?.length ?? 0, MAX_EVIDENCE_PER),
    ),
  );
  const unlinkedY = EVIDENCE_Y0 + maxUnder * EVIDENCE_DY + 40;
  const height = unlinkedY + (unlinked.length > 0 ? 70 : 10);

  const select = (node: GraphNode) => {
    const neighbors: { rel: string; node: GraphNode }[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.from !== node.id && e.to !== node.id) continue;
      const other = layout.byId.get(e.from === node.id ? e.to : e.from);
      if (!other || seen.has(`${e.rel}|${other.id}`)) continue;
      seen.add(`${e.rel}|${other.id}`);
      neighbors.push({ rel: e.rel, node: other });
    }
    onSelect({ node, neighbors });
  };

  const xOf = (i: number) => 60 + i * SLOT_W + SLOT_W / 2;

  return (
    <div className="h-full w-full overflow-auto">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label="Decision traces graph"
        className="min-h-full"
      >
        {/* time axis = the spine line */}
        {visible.length > 0 && (
          <line
            x1={30}
            y1={SPINE_Y}
            x2={width - 30}
            y2={SPINE_Y}
            className="stroke-border"
            strokeWidth={2}
          />
        )}
        {start > 0 && (
          <SpineFold
            x={34}
            y={SPINE_Y}
            label={`‹ +${start} earlier`}
            onClick={() => onWindow(Math.max(0, start - MAX_SPINE))}
          />
        )}
        {start + MAX_SPINE < spine.length && (
          <SpineFold
            x={width - 44}
            y={SPINE_Y}
            anchor="end"
            label={`+${spine.length - start - MAX_SPINE} later ›`}
            onClick={() => onWindow(start + MAX_SPINE)}
          />
        )}

        {visible.map((d, i) => {
          const x = xOf(i);
          const evidence = (under.get(d.id) ?? []).slice(0, MAX_EVIDENCE_PER);
          const extra = (under.get(d.id)?.length ?? 0) - evidence.length;
          const counters = over.get(d.id) ?? [];
          const contested = (d.contested ?? 0) > 0 || counters.length > 0;
          return (
            <g key={d.id}>
              {/* evidence below: supports */}
              {evidence.map((n, j) => {
                const y = EVIDENCE_Y0 + j * EVIDENCE_DY;
                return (
                  <g key={n.id}>
                    <line
                      x1={x}
                      y1={SPINE_Y + 16}
                      x2={x}
                      y2={y - 14}
                      className="stroke-border"
                      strokeWidth={1}
                    />
                    <EvidenceNode
                      node={n}
                      x={x}
                      y={y}
                      selected={selectedId === n.id}
                      onClick={() => select(n)}
                    />
                  </g>
                );
              })}
              {extra > 0 && (
                <text
                  x={x}
                  y={EVIDENCE_Y0 + evidence.length * EVIDENCE_DY}
                  textAnchor="middle"
                  className="fill-muted-foreground text-2xs"
                >
                  +{extra} more
                </text>
              )}
              {/* counter-claims above: dashed + labeled relation */}
              {counters.slice(0, 2).map((n, j) => {
                const y = CONTRA_Y0 - j * EVIDENCE_DY;
                return (
                  <g key={n.id}>
                    <line
                      x1={x}
                      y1={y + 14}
                      x2={x}
                      y2={SPINE_Y - 16}
                      className="stroke-amber-500"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                    <text
                      x={x + 6}
                      y={(y + SPINE_Y) / 2}
                      className="fill-amber-500 text-3xs"
                    >
                      counter-claim
                    </text>
                    <EvidenceNode
                      node={n}
                      x={x}
                      y={y}
                      counter
                      selected={selectedId === n.id}
                      onClick={() => select(n)}
                    />
                  </g>
                );
              })}
              {/* decision on the spine */}
              {/* biome-ignore lint/a11y/useSemanticElements: SVG interactive node — <button> is invalid inside <svg> */}
              <g
                role="button"
                tabIndex={0}
                onClick={() => select(d)}
                onKeyDown={(e) => e.key === "Enter" && select(d)}
                className="cursor-pointer"
              >
                <rect
                  x={x - 78}
                  y={SPINE_Y - 16}
                  width={156}
                  height={32}
                  rx={6}
                  className={`${
                    selectedId === d.id
                      ? "fill-primary/15 stroke-primary"
                      : "fill-muted stroke-foreground/60"
                  } ${contested ? "stroke-amber-500" : ""}`}
                  strokeWidth={contested ? 2 : 1.5}
                />
                <title>{d.label}</title>
                {d.layer && (
                  <circle
                    cx={x + 72}
                    cy={SPINE_Y - 10}
                    r={3}
                    className={LAYER_DOT[d.layer]}
                  />
                )}
                <text
                  x={x}
                  y={SPINE_Y + 4}
                  textAnchor="middle"
                  className="fill-foreground text-2xs"
                >
                  {ellipsize(d.label, 24)}
                </text>
                {contested && (
                  <text
                    x={x}
                    y={SPINE_Y - 22}
                    textAnchor="middle"
                    className="fill-amber-500 text-3xs font-medium"
                  >
                    CONTESTED{d.contested ? ` (${d.contested})` : ""}
                  </text>
                )}
              </g>
            </g>
          );
        })}

        {/* unlinked evidence lane */}
        {unlinked.length > 0 && (
          <g>
            <text
              x={40}
              y={unlinkedY - 12}
              className="fill-muted-foreground text-2xs"
            >
              evidence not yet feeding a decision
            </text>
            {unlinked.slice(0, 12).map((n, i) => (
              <EvidenceNode
                key={n.id}
                node={n}
                x={60 + i * 52}
                y={unlinkedY + 16}
                selected={selectedId === n.id}
                onClick={() => select(n)}
              />
            ))}
            {unlinked.length > 12 && (
              <text
                x={60 + 12 * 52}
                y={unlinkedY + 20}
                className="fill-muted-foreground text-2xs"
              >
                +{unlinked.length - 12}
              </text>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}

function EvidenceNode({
  node,
  x,
  y,
  counter,
  selected,
  onClick,
}: {
  node: GraphNode;
  x: number;
  y: number;
  counter?: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const stroke = selected
    ? "stroke-primary"
    : counter
      ? "stroke-amber-500"
      : "stroke-foreground/50";
  const fill = selected ? "fill-primary/20" : "fill-muted";
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVG interactive node — <button> is invalid inside <svg>
    <g
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className="cursor-pointer"
    >
      <title>{node.label}</title>
      {node.layer && (
        <circle
          cx={x + 12}
          cy={y - 10}
          r={3}
          className={LAYER_DOT[node.layer]}
        />
      )}
      {node.kind === "commit" ? (
        <rect
          x={x - 11}
          y={y - 11}
          width={22}
          height={22}
          className={`${fill} ${stroke}`}
          strokeWidth={1.5}
        />
      ) : (
        <circle
          cx={x}
          cy={y}
          r={12}
          className={`${fill} ${stroke}`}
          strokeWidth={1.5}
        />
      )}
    </g>
  );
}

function SpineFold({
  x,
  y,
  label,
  anchor,
  onClick,
}: {
  x: number;
  y: number;
  label: string;
  anchor?: "end";
  onClick: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVG interactive node — <button> is invalid inside <svg>
    <text
      x={x}
      y={y - 24}
      textAnchor={anchor ?? "start"}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      className="cursor-pointer fill-primary text-2xs hover:underline"
    >
      {label}
    </text>
  );
}

function ellipsize(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
