// Traces view — the readable timeline (v2, per the "readable timeline"
// proposal deliberated in the Web of Trust channel; round-2 refinements
// from UT Voice / OpenClaw / Hermes folded in).
//
// The v1 fixed-geometry SVG (156×32px boxes, 24-char labels, 7-slot window)
// showed THAT decisions existed but not WHAT they were. v2 keeps the exact
// information design — time-ordered decisions, supports vs counter-claims,
// contested flags, WM/SWM/VM layer dots — and changes only the medium.
// Deliberated invariants:
//  - no title hard-truncation (2-line clamp + expand);
//  - disagreement is visible WITHOUT expansion — the first counter-claim
//    renders inline even in compact density, never just a count;
//  - quiet gaps stay visible: the mini-map is true-time (clamped so dense
//    regions stay clickable) and the list carries gap separators;
//  - contested-only filtering keeps dim neighbor anchors so a dispute
//    never loses its place in the sequence;
//  - hovering a card highlights its mini-map tick (and vice versa).
// Read-only: clicking selects and focuses the evidence rail; it never
// navigates.
import { useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "../api";

const LAYER_DOT = {
  WM: "bg-slate-400",
  SWM: "bg-amber-400",
  VM: "bg-green-500",
} as const;

/** Retained for compatibility; the timeline scrolls instead of windowing. */
export const MAX_SPINE = 7;

/** List gaps ≥ this many seconds get a visible separator. */
const GAP_SEPARATOR_S = 6 * 3600;
/** Mini-map tick spacing bounds (px in viewBox units). */
const TICK_MIN_GAP = 6;
const TICK_MAX_GAP = 40;

export interface GraphSelection {
  node: GraphNode;
  neighbors: { rel: string; node: GraphNode }[];
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Ignored in v2 (scroll replaces windowing); kept for call-site compat. */
  window?: number;
  onWindow?: (start: number) => void;
  selectedId: string | null;
  onSelect: (sel: GraphSelection | null) => void;
}

function fmtTime(at: number | null): string {
  if (!at) return "—";
  const d = new Date(at * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? hm
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`;
}

function fmtGap(seconds: number): string {
  const h = Math.round(seconds / 3600);
  if (h < 48) return `${h} h quiet`;
  return `${Math.round(h / 24)} days quiet`;
}

type Row =
  | { kind: "decision"; node: GraphNode; anchor: boolean }
  | { kind: "gap"; id: string; label: string };

export function GraphCanvas({ nodes, edges, selectedId, onSelect }: Props) {
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  const [contestedOnly, setContestedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hoverId, setHoverId] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  // Identical layout computation to v1 — the semantics are the contract.
  const layout = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const spine = nodes
      .filter((n) => n.kind === "decision")
      .sort(
        (a, b) =>
          (a.at ?? Number.MAX_SAFE_INTEGER) -
            (b.at ?? Number.MAX_SAFE_INTEGER) || a.label.localeCompare(b.label),
      );
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

  // True-time mini-map positions: proportional to elapsed time, clamped so
  // one long silence never compresses dense regions below clickability
  // (OpenClaw's guardrail). Falls back to even spacing when times are absent.
  const ticks = useMemo(() => {
    const xs: number[] = [];
    let x = 1;
    for (let i = 0; i < spine.length; i++) {
      if (i > 0) {
        const prev = spine[i - 1].at;
        const cur = spine[i].at;
        let gap = TICK_MIN_GAP;
        if (prev && cur && cur > prev) {
          // 1h ≈ 2px beyond the minimum, clamped.
          gap = Math.min(
            TICK_MAX_GAP,
            Math.max(TICK_MIN_GAP, TICK_MIN_GAP + ((cur - prev) / 3600) * 2),
          );
        }
        x += gap;
      }
      xs.push(x);
    }
    return { xs, width: Math.max((xs[xs.length - 1] ?? 0) + 6, 60) };
  }, [spine]);

  // Visible rows: full list, or contested + dim neighbor anchors; with gap
  // separators wherever consecutive decisions are far apart in time.
  const rows = useMemo<Row[]>(() => {
    let picked: { node: GraphNode; anchor: boolean }[];
    if (!contestedOnly) {
      picked = spine.map((n) => ({ node: n, anchor: false }));
    } else {
      const keep = new Map<string, boolean>(); // id -> isAnchor
      spine.forEach((n, i) => {
        if ((n.contested ?? 0) > 0) {
          keep.set(n.id, false);
          const prev = spine[i - 1];
          const next = spine[i + 1];
          if (prev && !keep.has(prev.id)) keep.set(prev.id, true);
          if (next && !keep.has(next.id)) keep.set(next.id, true);
        }
      });
      picked = spine
        .filter((n) => keep.has(n.id))
        .map((n) => ({ node: n, anchor: keep.get(n.id) === true }));
    }
    const out: Row[] = [];
    for (let i = 0; i < picked.length; i++) {
      if (i > 0) {
        const prev = picked[i - 1].node.at;
        const cur = picked[i].node.at;
        if (prev && cur && cur - prev >= GAP_SEPARATOR_S) {
          out.push({
            kind: "gap",
            id: `gap-${picked[i].node.id}`,
            label: fmtGap(cur - prev),
          });
        }
      }
      out.push({ kind: "decision", ...picked[i] });
    }
    return out;
  }, [spine, contestedOnly]);

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

  const jumpTo = (id: string) => {
    cardRefs.current.get(id)?.scrollIntoView({ block: "center" });
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  if (spine.length === 0 && unlinked.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No decisions or evidence in this subgraph yet.
      </div>
    );
  }

  const compact = density === "compact";

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-label="Decision traces timeline"
    >
      {/* True-time mini-map + controls */}
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5">
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: navigation strip; ticks carry titles */}
        <svg
          className="h-5 min-w-0 flex-1"
          viewBox={`0 0 ${ticks.width} 20`}
          preserveAspectRatio="none"
          role="img"
        >
          {spine.map((d, i) => {
            const contested = (d.contested ?? 0) > 0;
            const active = d.id === selectedId || d.id === hoverId;
            return (
              // biome-ignore lint/a11y/useSemanticElements: SVG tick — button invalid inside svg
              <rect
                key={d.id}
                role="button"
                tabIndex={-1}
                x={ticks.xs[i]}
                y={contested ? 2 : 6}
                width={4}
                height={contested ? 16 : 8}
                rx={1}
                className={`cursor-pointer ${
                  active
                    ? "fill-primary"
                    : contested
                      ? "fill-amber-500"
                      : "fill-muted-foreground/40 hover:fill-muted-foreground"
                }`}
                onClick={() => jumpTo(d.id)}
                onMouseEnter={() => setHoverId(d.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                <title>{d.label}</title>
              </rect>
            );
          })}
        </svg>
        <label className="flex items-center gap-1 text-2xs text-muted-foreground">
          <input
            type="checkbox"
            checked={contestedOnly}
            onChange={(e) => setContestedOnly(e.target.checked)}
            className="h-3 w-3"
          />
          contested only
        </label>
        <button
          type="button"
          onClick={() => setDensity(compact ? "comfortable" : "compact")}
          className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-muted"
          title="Toggle density"
        >
          {compact ? "comfortable" : "compact"}
        </button>
        <button
          type="button"
          onClick={() => {
            const last = rows.filter((r) => r.kind === "decision").pop();
            if (last && last.kind === "decision") jumpTo(last.node.id);
          }}
          className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-muted"
        >
          latest ↓
        </button>
      </div>

      {/* The timeline */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ol className="mx-auto max-w-2xl space-y-0 px-4 py-3">
          {rows.map((row) => {
            if (row.kind === "gap") {
              return (
                <li
                  key={row.id}
                  className="relative border-l-2 border-dashed border-border py-1 pl-4"
                >
                  <span className="text-2xs italic text-muted-foreground">
                    · {row.label} ·
                  </span>
                </li>
              );
            }
            const d = row.node;
            const contested = (d.contested ?? 0) > 0;
            const supports = under.get(d.id) ?? [];
            const counters = over.get(d.id) ?? [];
            const isSelected = selectedId === d.id;
            const isExpanded = expanded.has(d.id);
            // Progressive disclosure (Hermes): first counter always inline;
            // rest behind expansion. Supports show fully in comfortable,
            // count-only in compact.
            const inlineCounters =
              isExpanded || !compact ? counters : counters.slice(0, 1);
            const hiddenCounters = counters.length - inlineCounters.length;
            const inlineSupports = isExpanded || !compact ? supports : [];
            return (
              <li
                key={d.id}
                ref={(el) => {
                  if (el) cardRefs.current.set(d.id, el);
                  else cardRefs.current.delete(d.id);
                }}
                data-testid="traces-card"
                className={`relative border-l-2 border-border pb-1 pl-4 last:pb-3 ${
                  row.anchor ? "opacity-50" : ""
                }`}
                onMouseEnter={() => setHoverId(d.id)}
                onMouseLeave={() => setHoverId(null)}
              >
                <span
                  className={`absolute top-3 h-2.5 w-2.5 rounded-full ${contested ? "bg-amber-500" : "bg-muted-foreground/60"}`}
                  style={{ left: "-5.5px" }}
                />
                <div
                  className={`my-1 rounded-md border px-3 ${compact ? "py-1.5" : "py-2"} ${
                    isSelected
                      ? "border-primary bg-primary/5"
                      : contested
                        ? "border-amber-500/60 bg-card"
                        : hoverId === d.id
                          ? "border-foreground/30 bg-card"
                          : "border-border bg-card"
                  }`}
                >
                  <div className="mb-0.5 flex items-center gap-2 text-2xs text-muted-foreground">
                    <span className="tabular-nums">{fmtTime(d.at)}</span>
                    {d.layer && (
                      <span className="flex items-center gap-1">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${LAYER_DOT[d.layer]}`}
                        />
                        {d.layer}
                      </span>
                    )}
                    {row.anchor && <span className="italic">context</span>}
                    {contested && (
                      <span className="rounded bg-amber-500/15 px-1 font-medium text-amber-600 dark:text-amber-400">
                        CONTESTED{d.contested ? ` (${d.contested})` : ""}
                      </span>
                    )}
                    <span className="ml-auto">
                      {counters.length > 0 && `⊖ ${counters.length} · `}
                      {supports.length > 0 && `⊕ ${supports.length}`}
                    </span>
                  </div>
                  <div className="flex items-start gap-1">
                    <button
                      type="button"
                      onClick={() => select(d)}
                      className={`min-w-0 flex-1 text-left text-sm text-foreground hover:text-primary ${
                        isExpanded ? "" : "line-clamp-2"
                      }`}
                      title={isExpanded ? undefined : d.label}
                    >
                      {d.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleExpand(d.id)}
                      className="shrink-0 rounded px-1 text-2xs text-muted-foreground hover:bg-muted"
                      aria-label={isExpanded ? "Collapse" : "Expand"}
                    >
                      {isExpanded ? "▴" : "▾"}
                    </button>
                  </div>
                  {(inlineCounters.length > 0 || inlineSupports.length > 0) && (
                    <ul className="mt-1.5 space-y-0.5 border-t border-border/60 pt-1.5">
                      {inlineCounters.map((n) => (
                        <li key={`c-${n.id}`}>
                          <button
                            type="button"
                            onClick={() => select(n)}
                            className="w-full truncate text-left text-xs text-red-600/90 hover:underline dark:text-red-400/90"
                            title={n.label}
                          >
                            ⊖ {n.label}
                          </button>
                        </li>
                      ))}
                      {hiddenCounters > 0 && (
                        <li>
                          <button
                            type="button"
                            onClick={() => toggleExpand(d.id)}
                            className="text-left text-2xs text-red-600/70 hover:underline dark:text-red-400/70"
                          >
                            +{hiddenCounters} more counter-claim
                            {hiddenCounters > 1 ? "s" : ""}
                          </button>
                        </li>
                      )}
                      {inlineSupports.map((n) => (
                        <li key={`s-${n.id}`}>
                          <button
                            type="button"
                            onClick={() => select(n)}
                            className="w-full truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
                            title={n.label}
                          >
                            ⊕ {n.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {unlinked.length > 0 && !contestedOnly && (
          <div className="mx-auto max-w-2xl px-4 pb-4">
            <p className="mb-1 text-2xs text-muted-foreground">
              evidence not yet feeding a decision ({unlinked.length})
            </p>
            <div className="flex flex-wrap gap-1">
              {unlinked.slice(0, 24).map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => select(n)}
                  title={n.label}
                  className="max-w-56 truncate rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs hover:bg-muted"
                >
                  {n.label}
                </button>
              ))}
              {unlinked.length > 24 && (
                <span className="text-2xs text-muted-foreground">
                  +{unlinked.length - 24}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
