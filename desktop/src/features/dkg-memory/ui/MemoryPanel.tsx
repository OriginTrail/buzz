// Buzz-native DKG memory panel: the channel's collective memory — three
// layers (WM/SWM/VM), named subgraphs (per-agent contribution lenses,
// decisions, projects), and drill-in contributor trails — rendered where the
// conversation happens. Data resolves through the viewer's OWN edge node
// (local-first); failing gates render instructions, never silent emptiness.
import { useState } from "react";
import {
  useChannelContextGraph,
  useChannelMemory,
  useContributorTrail,
  useDiscoveryFallback,
  useProfileNames,
} from "../hooks";
import { explorerSource, nodeUiDeepLink } from "../api";
import { EvidenceCard } from "./EvidenceCard";
import { GraphOverlay } from "./GraphOverlay";

// Humanized layer names per the 2026-08-02 humanize wrap (Hermes' table,
// seconded by OpenClaw): reach + durability in plain words, technical
// WM/SWM/VM kept as the small tag (progressive disclosure).
const LAYER_META = {
  WM: { label: "Draft", hint: "only on this node", dot: "bg-slate-400" },
  SWM: {
    label: "Channel Memory",
    hint: "shared with channel members",
    dot: "bg-amber-400",
  },
  VM: {
    label: "Anchored Record",
    hint: "integrity anchor on-chain",
    dot: "bg-green-500",
  },
} as const;

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`;
}

export function MemoryPanel({ channelId }: { channelId: string }) {
  const cgQuery = useChannelContextGraph(channelId);
  const receiptCg = cgQuery.data ?? null;
  const memory = useChannelMemory(channelId, receiptCg, !cgQuery.isLoading);
  const cg = memory.data?.cg ?? receiptCg;
  const [trailPubkey, setTrailPubkey] = useState<string | null>(null);
  const [graphSubgraph, setGraphSubgraph] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const trail = useContributorTrail(channelId, cg, trailPubkey);
  const gateFailed =
    Boolean(memory.data && memory.data.gate !== "ok") || memory.isError;
  const discovery = useDiscoveryFallback(channelId, gateFailed);
  const contributorPubkeys = (memory.data?.contributors ?? []).map(
    (c) => c.pubkey,
  );
  const profiles = useProfileNames(contributorPubkeys);
  const sortedDecisions = [...(memory.data?.decisions ?? [])].sort((a, b) =>
    (b.at ?? "").localeCompare(a.at ?? ""),
  );
  const latestDecision =
    sortedDecisions.find((d) => d.at) ?? sortedDecisions[0] ?? null;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const happeningNow = sortedDecisions.filter(
    (d) => d.at && Date.parse(d.at) > dayAgo,
  );
  const query = search.trim().toLowerCase();
  const filteredDecisions = query
    ? sortedDecisions.filter((d) =>
        (d.name ?? d.uri).toLowerCase().includes(query),
      )
    : sortedDecisions;

  if (cgQuery.isLoading) {
    return <PanelShell title="Memory">Resolving channel binding…</PanelShell>;
  }
  if (memory.isLoading) {
    return <PanelShell title="Memory">Reading channel memory…</PanelShell>;
  }
  const data = memory.data;
  if (data?.gate !== "ok") {
    return (
      <PanelShell title="Memory">
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs">
          Shown for discovery — unverified (via relay receipts). Run a local
          node to verify.
        </div>
        {discovery.data && discovery.data.length > 0 ? (
          <div className="mb-3 max-h-72 space-y-1 overflow-y-auto">
            {discovery.data.map((d) => (
              <div
                key={d.kaName}
                className="rounded px-1.5 py-0.5 text-xs"
                title={`digest ${d.digest ?? "?"}`}
              >
                <span
                  className={`mr-1 inline-block h-2 w-2 rounded-full ${d.layer === "VM" ? "bg-green-500" : "bg-amber-400"}`}
                />
                {d.title ?? d.kaName}
              </div>
            ))}
          </div>
        ) : (
          <p className="mb-3 text-xs text-muted-foreground">
            {discovery.isLoading
              ? "Reading receipts…"
              : "No receipts found in this channel yet."}
          </p>
        )}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Verify through your own node
          </summary>
          <div className="mt-2">
            <GateNotice gate={data?.gate ?? "node-missing"} cg={cg} />
          </div>
        </details>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title="Memory"
      action={
        explorerSource() === "local" && cg ? (
          <a
            className="text-xs text-primary hover:underline"
            href={nodeUiDeepLink(cg)}
            target="_blank"
            rel="noreferrer"
          >
            open in node ↗
          </a>
        ) : null
      }
    >
      {explorerSource() === "gateway" ? (
        <div className="mb-2 rounded-md border border-sky-600/40 bg-sky-600/10 px-2 py-1 text-xs">
          ✓ Resolved through the community DKG provider — shared and anchored
          memory from the community's node. Run your own node to verify
          independently.
        </div>
      ) : (
        <div className="mb-2 rounded-md border border-green-600/40 bg-green-600/10 px-2 py-1 text-xs">
          ✓ Verified through your node
        </div>
      )}
      {/* What this channel remembers — plain-language summary + layer ladder */}
      <section className="mb-3">
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          What this channel remembers
        </h4>
        <p className="mb-2 text-xs text-muted-foreground">
          {sortedDecisions.length} decisions across{" "}
          {(data.subgraphs ?? []).filter((sg) => sg.entityCount > 0).length}{" "}
          topics, from {(data.contributors ?? []).length} people &amp; agents.
        </p>
        <div className="mb-1 grid grid-cols-3 gap-2">
          {(["WM", "SWM", "VM"] as const).map((tag) => {
            const entries = data.layers?.[tag];
            const count = data.layers?.[`${tag}Count`] ?? entries?.length;
            const meta = LAYER_META[tag];
            return (
              <div
                key={tag}
                className="rounded-md border border-border bg-muted/30 px-2 py-1.5"
                title={meta.hint}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                  <span className="truncate text-xs font-medium">
                    {meta.label}
                  </span>
                  <span className="ml-auto text-3xs text-muted-foreground">
                    {tag}
                  </span>
                </div>
                <div className="text-base font-semibold tabular-nums">
                  {count ?? "—"}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* What is happening now */}
      {happeningNow.length > 0 && (
        <section className="mb-3">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What is happening now
          </h4>
          <p className="mb-1 text-2xs text-muted-foreground">
            {happeningNow.length} record{happeningNow.length === 1 ? "" : "s"}{" "}
            in the last 24 hours
          </p>
          <div className="space-y-0.5">
            {happeningNow.slice(0, 3).map((d) => (
              <p
                key={d.uri}
                className="truncate text-xs"
                title={d.name ?? d.uri}
              >
                {d.name ?? d.uri.split("/").pop()}
              </p>
            ))}
          </div>
        </section>
      )}

      {/* Latest decision — card anatomy + Evidence Envelope */}
      {latestDecision && (
        <section className="mb-3">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Latest decision
          </h4>
          <EvidenceCard
            channelId={channelId}
            cg={cg}
            uri={latestDecision.uri}
            title={latestDecision.name ?? latestDecision.uri}
            at={latestDecision.at}
          />
        </section>
      )}

      {/* Subgraph lenses */}
      {data.subgraphs && data.subgraphs.length > 0 && (
        <section className="mb-3">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Topics
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {data.subgraphs
              .filter((sg) => sg.entityCount > 0)
              .map((sg) => (
                <button
                  key={sg.uri}
                  type="button"
                  onClick={() => setGraphSubgraph(sg.name)}
                  className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs transition-colors hover:border-primary/60 hover:bg-muted"
                  title={`${sg.entityCount} entities · ${sg.tripleCount} triples — open as graph`}
                  data-testid={`dkg-subgraph-${sg.name}`}
                >
                  {sg.name}
                  <span className="ml-1 text-muted-foreground tabular-nums">
                    {sg.entityCount}
                  </span>
                  <span className="ml-1 text-muted-foreground">⌗</span>
                </button>
              ))}
          </div>
        </section>
      )}

      {/* Contributors → trail drill-in */}
      {data.contributors && data.contributors.length > 0 && (
        <section className="mb-3">
          <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            People &amp; agents
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {data.contributors.map((c) => (
              <button
                key={c.pubkey}
                type="button"
                onClick={() =>
                  setTrailPubkey(trailPubkey === c.pubkey ? null : c.pubkey)
                }
                className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  trailPubkey === c.pubkey
                    ? "border-primary bg-primary/10"
                    : "border-border bg-muted/40 hover:bg-muted"
                }`}
              >
                {profiles.data?.[c.pubkey] ?? shortPk(c.pubkey)}
                <span className="ml-1 text-muted-foreground tabular-nums">
                  {c.events}
                </span>
              </button>
            ))}
          </div>
          {trailPubkey && (
            <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/20 p-2">
              {trail.isLoading && (
                <div className="text-xs text-muted-foreground">
                  loading trail…
                </div>
              )}
              {trail.data?.map((t) => (
                <div key={t.event} className="text-xs leading-snug">
                  <span className="text-muted-foreground">
                    {t.at ? new Date(t.at * 1000).toLocaleString() : ""}
                  </span>{" "}
                  {t.content ?? "(structured entity)"}
                  {t.decisionName && (
                    <div className="text-primary">
                      ↳ fed decision: {t.decisionName}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* On-demand graph view: full-screen inspection state */}
      {graphSubgraph && (
        <GraphOverlay
          channelId={channelId}
          cg={cg}
          subgraph={graphSubgraph}
          onClose={() => setGraphSubgraph(null)}
        />
      )}

      {/* Ask this memory — search over what this channel knows */}
      <section>
        <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Ask this memory
        </h4>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search what this channel knows…"
          className="mb-2 w-full rounded-md border border-border bg-muted/30 px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/60"
          data-testid="dkg-memory-search"
        />
        {query ? (
          <p className="mb-1 text-2xs text-muted-foreground">
            {filteredDecisions.length} match
            {filteredDecisions.length === 1 ? "" : "es"}
          </p>
        ) : (
          <p className="mb-1 text-2xs text-muted-foreground">
            All decisions ({sortedDecisions.length})
          </p>
        )}
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {filteredDecisions.slice(0, 60).map((d) => (
            <div
              key={d.uri}
              className="truncate rounded px-1.5 py-0.5 text-xs hover:bg-muted/50"
              title={d.name ?? d.uri}
            >
              {d.name ?? d.uri.split("/").pop()}
            </div>
          ))}
        </div>
      </section>
    </PanelShell>
  );
}

function PanelShell({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <div className="mb-2 flex items-center justify-between pr-24">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function GateNotice({ gate, cg }: { gate: string; cg: string | null }) {
  if (gate === "not-subscribed" && cg) {
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          Your edge node has not joined this channel's Context Graph, so its
          memory is not synced to you yet.
        </p>
        <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
          {`curl -X POST http://127.0.0.1:9200/api/context-graph/subscribe \\
  -H "authorization: Bearer $(tail -1 $DKG_HOME/auth.token)" \\
  -H "content-type: application/json" \\
  -d '{"contextGraphId":"${cg}","includeSharedMemory":true}'`}
        </pre>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        Neither a local DKG edge node nor this community's DKG provider is
        answering. Run a local node, then reopen this panel.
      </p>
      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
        {`mkdir dkg-node && cd dkg-node && npm install dkg@latest
DKG_HOME=$HOME/.dkg node_modules/.bin/dkg start
node explorer/local-explorer.mjs   # from buzz-dkg-integration`}
      </pre>
    </div>
  );
}
