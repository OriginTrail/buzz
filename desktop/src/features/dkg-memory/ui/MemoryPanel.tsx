import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  Database,
  Network,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import {
  useChannelContextGraph,
  useChannelMemory,
  useContributorTrail,
  useDiscoveryFallback,
  useProfileNames,
} from "../hooks";
import { enableChannelMemory, explorerSource, nodeUiDeepLink } from "../api";
import { DkgProviderError } from "../provider";
import { CHANNEL_GRAPH_SCOPE } from "../topology/client";
import { EvidenceCard } from "./EvidenceCard";
import { GraphOverlay } from "./GraphOverlay";
import { MemorySearch } from "./MemorySearch";
import { SoftwareMemoryQuery } from "./SoftwareMemoryQuery";

const LAYER_META = {
  WM: { label: "Draft", hint: "only on this node", dot: "bg-slate-400" },
  SWM: {
    label: "Shared",
    hint: "channel memory",
    dot: "bg-amber-400",
  },
  VM: {
    label: "Anchored",
    hint: "integrity record",
    dot: "bg-emerald-500",
  },
} as const;

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`;
}

function isUnknownChannel(error: unknown): boolean {
  return (
    (error instanceof DkgProviderError && error.code === "unknown_channel") ||
    (error instanceof Error &&
      /unknown_channel|not configured for DKG/i.test(error.message))
  );
}

export function MemoryPanel({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const cgQuery = useChannelContextGraph(channelId);
  const receiptCg = cgQuery.data ?? null;
  const memory = useChannelMemory(channelId, receiptCg, !cgQuery.isLoading);
  const cg = memory.data?.cg ?? receiptCg;
  const [trailPubkey, setTrailPubkey] = useState<string | null>(null);
  const [graphSubgraph, setGraphSubgraph] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const trail = useContributorTrail(channelId, cg, trailPubkey);
  const gateFailed =
    Boolean(memory.data && memory.data.gate !== "ok") || memory.isError;
  const discovery = useDiscoveryFallback(channelId, gateFailed);
  const contributorPubkeys = (memory.data?.contributors ?? []).map(
    (contributor) => contributor.pubkey,
  );
  const profiles = useProfileNames(contributorPubkeys);
  const sortedDecisions = [...(memory.data?.decisions ?? [])].sort((a, b) =>
    (b.at ?? "").localeCompare(a.at ?? ""),
  );
  const latestDecision =
    sortedDecisions.find((decision) => decision.at) ??
    sortedDecisions[0] ??
    null;

  async function startMemory() {
    setEnabling(true);
    setEnableError(null);
    try {
      await enableChannelMemory(channelId);
      await queryClient.invalidateQueries({ queryKey: ["dkg-memory"] });
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["dkg-memory"] });
      }, 2_500);
    } catch (cause) {
      setEnableError(
        cause instanceof Error
          ? cause.message
          : "Could not start DKG memory for this channel.",
      );
    } finally {
      setEnabling(false);
    }
  }

  if (cgQuery.isLoading || memory.isLoading) {
    return (
      <PanelShell>
        <div className="space-y-3 p-1">
          <div className="h-20 animate-pulse rounded-xl bg-muted/60" />
          <div className="h-32 animate-pulse rounded-xl bg-muted/40" />
          <p className="text-center text-xs text-muted-foreground">
            Reading channel memory…
          </p>
        </div>
      </PanelShell>
    );
  }

  if (memory.isError && isUnknownChannel(memory.error)) {
    return (
      <PanelShell>
        <div className="flex min-h-[70vh] flex-col items-center justify-center px-5 text-center">
          <div className="mb-4 rounded-2xl bg-primary/10 p-4 text-primary">
            {enabling ? (
              <RefreshCw className="h-8 w-8 animate-spin" />
            ) : (
              <BrainCircuit className="h-8 w-8" />
            )}
          </div>
          <h3 className="text-base font-semibold">
            {enabling
              ? "Preparing this channel’s Context Graph…"
              : "Give this channel a memory"}
          </h3>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-muted-foreground">
            {enabling
              ? "The relay accepted the signed setup record. It is creating, sharing and checking the graph before Buzz starts querying it."
              : "Start a private Context Graph for this channel. Agents can then add decisions, people, code, tasks and their relationships as the team works."}
          </p>
          <Button
            type="button"
            className="mt-5"
            disabled={enabling}
            onClick={() => void startMemory()}
            data-testid="dkg-memory-enable"
          >
            {enabling ? <RefreshCw className="animate-spin" /> : <Sparkles />}
            {enabling ? "Provisioning Context Graph…" : "Start channel memory"}
          </Button>
          <p className="mt-3 text-2xs text-muted-foreground">
            {enabling
              ? "This can take up to a minute on a busy node. You can keep using the channel."
              : "Buzz posts a visible setup message, signs the first memory record, and the relay provisions the graph."}
          </p>
          {enableError && (
            <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {enableError}
            </p>
          )}
        </div>
      </PanelShell>
    );
  }

  const data = memory.data;
  if (data?.gate !== "ok") {
    return (
      <PanelShell>
        <Card className="mb-3 p-3">
          <div className="flex items-start gap-2">
            <Database className="mt-0.5 h-4 w-4 text-amber-500" />
            <div>
              <p className="text-xs font-medium">Memory provider unavailable</p>
              <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                Receipt-based records are shown below for discovery. They are
                not independently verified by this app.
              </p>
            </div>
          </div>
        </Card>
        {discovery.data && discovery.data.length > 0 ? (
          <div className="mb-3 max-h-72 space-y-1 overflow-y-auto">
            {discovery.data.map((entry) => (
              <div
                key={entry.kaName}
                className="rounded-lg bg-muted/40 px-2.5 py-2 text-xs"
                title={`digest ${entry.digest ?? "?"}`}
              >
                <span
                  className={`mr-2 inline-block h-2 w-2 rounded-full ${entry.layer === "VM" ? "bg-emerald-500" : "bg-amber-400"}`}
                />
                {entry.title ?? entry.kaName}
              </div>
            ))}
          </div>
        ) : (
          <p className="mb-3 text-xs text-muted-foreground">
            {discovery.isLoading
              ? "Reading receipts…"
              : "No memory receipts found in this channel yet."}
          </p>
        )}
        <GateNotice gate={data?.gate ?? "node-missing"} cg={cg} />
      </PanelShell>
    );
  }

  const providerIsGateway = explorerSource() === "gateway";
  const topicCount = (data.subgraphs ?? []).filter(
    (subgraph) => subgraph.entityCount > 0,
  ).length;

  return (
    <PanelShell
      action={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => void memory.refetch()}
          disabled={memory.isFetching}
          title="Refresh channel memory"
        >
          <RefreshCw className={memory.isFetching ? "animate-spin" : ""} />
        </Button>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <Badge variant={providerIsGateway ? "info" : "success"}>
          {providerIsGateway ? "Community DKG" : "Your DKG node"}
        </Badge>
        <span
          className="truncate text-2xs text-muted-foreground"
          title={cg ?? ""}
        >
          {providerIsGateway
            ? "authenticated channel access"
            : "locally verified"}
        </span>
        {explorerSource() === "local" && cg && (
          <a
            className="ml-auto shrink-0 text-2xs text-primary hover:underline"
            href={nodeUiDeepLink(cg)}
            target="_blank"
            rel="noreferrer"
          >
            Node UI ↗
          </a>
        )}
      </div>

      <button
        type="button"
        onClick={() => setGraphSubgraph(CHANNEL_GRAPH_SCOPE)}
        className="group mb-4 w-full rounded-xl border border-primary/25 bg-gradient-to-br from-primary/12 via-primary/5 to-transparent p-3 text-left transition hover:border-primary/50 hover:from-primary/16"
        data-testid="dkg-channel-graph"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-primary/15 p-2.5 text-primary transition group-hover:scale-105">
            <Network className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Explore the knowledge graph</p>
            <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
              See decisions, code, people and how they connect.
            </p>
          </div>
          <span className="text-lg text-primary">→</span>
        </div>
      </button>

      <Tabs defaultValue="overview" className="min-h-0">
        <TabsList className="grid h-8 w-full grid-cols-2">
          <TabsTrigger value="overview" className="py-0.5 text-xs">
            Overview
          </TabsTrigger>
          <TabsTrigger value="search" className="py-0.5 text-xs">
            Search graph
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <section>
            <div className="mb-2 grid grid-cols-3 gap-2">
              {(["WM", "SWM", "VM"] as const).map((tag) => {
                const entries = data.layers?.[tag];
                const count = data.layers?.[`${tag}Count`] ?? entries?.length;
                const meta = LAYER_META[tag];
                return (
                  <Card
                    key={tag}
                    className="p-2"
                    title={`${meta.label}: ${meta.hint}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
                      <span className="truncate text-2xs font-medium">
                        {meta.label}
                      </span>
                    </div>
                    <div className="mt-1 text-lg font-semibold tabular-nums">
                      {count ?? "—"}
                    </div>
                  </Card>
                );
              })}
            </div>
            <p className="text-2xs text-muted-foreground">
              {sortedDecisions.length} decisions · {topicCount} named topics ·{" "}
              {(data.contributors ?? []).length} people &amp; agents
            </p>
          </section>

          {latestDecision && (
            <section>
              <SectionTitle icon={<ShieldCheck />}>
                Latest captured decision
              </SectionTitle>
              <EvidenceCard
                channelId={channelId}
                cg={cg}
                uri={latestDecision.uri}
                title={latestDecision.name ?? latestDecision.uri}
                at={latestDecision.at}
              />
            </section>
          )}

          {data.subgraphs && data.subgraphs.length > 0 && (
            <section>
              <SectionTitle icon={<Network />}>Topic lenses</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {data.subgraphs
                  .filter((subgraph) => subgraph.entityCount > 0)
                  .map((subgraph) => (
                    <Button
                      key={subgraph.uri}
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setGraphSubgraph(subgraph.name)}
                      title={`${subgraph.entityCount} entities · ${subgraph.tripleCount} triples`}
                      data-testid={`dkg-subgraph-${subgraph.name}`}
                    >
                      {subgraph.name}
                      <span className="text-muted-foreground">
                        {subgraph.entityCount}
                      </span>
                    </Button>
                  ))}
              </div>
            </section>
          )}

          {data.contributors && data.contributors.length > 0 && (
            <section>
              <SectionTitle icon={<Users />}>People &amp; agents</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {data.contributors.map((contributor) => (
                  <Button
                    key={contributor.pubkey}
                    type="button"
                    variant={
                      trailPubkey === contributor.pubkey
                        ? "secondary"
                        : "outline"
                    }
                    size="xs"
                    onClick={() =>
                      setTrailPubkey(
                        trailPubkey === contributor.pubkey
                          ? null
                          : contributor.pubkey,
                      )
                    }
                  >
                    {profiles.data?.[contributor.pubkey] ??
                      shortPk(contributor.pubkey)}
                    <span className="text-muted-foreground">
                      {contributor.events}
                    </span>
                  </Button>
                ))}
              </div>
              {trailPubkey && (
                <div className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-xl border border-border/70 bg-muted/20 p-2.5">
                  {trail.isLoading && (
                    <div className="text-xs text-muted-foreground">
                      Loading trail…
                    </div>
                  )}
                  {trail.data?.map((entry) => (
                    <div key={entry.event} className="text-xs leading-relaxed">
                      <span className="text-muted-foreground">
                        {entry.at
                          ? new Date(entry.at * 1000).toLocaleString()
                          : ""}
                      </span>{" "}
                      {entry.content ?? "Structured entity"}
                      {entry.decisionName && (
                        <div className="text-primary">
                          ↳ {entry.decisionName}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </TabsContent>

        <TabsContent value="search" className="space-y-5">
          <MemorySearch channelId={channelId} />
          <details className="rounded-xl border border-border/70 bg-card/50 p-3">
            <summary className="cursor-pointer text-xs font-medium">
              Software provenance queries
            </summary>
            <div className="mt-3">
              <SoftwareMemoryQuery channelId={channelId} />
            </div>
          </details>
        </TabsContent>
      </Tabs>

      {graphSubgraph && (
        <GraphOverlay
          channelId={channelId}
          cg={cg}
          subgraph={graphSubgraph}
          onClose={() => setGraphSubgraph(null)}
        />
      )}
    </PanelShell>
  );
}

function SectionTitle({
  icon,
  children,
}: {
  icon: React.ReactElement<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
      <span className="[&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:text-primary">
        {icon}
      </span>
      {children}
    </h4>
  );
}

function PanelShell({
  action,
  children,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2 pr-10">
        <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
          <BrainCircuit className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Channel memory</h3>
          <p className="text-3xs text-muted-foreground">
            Powered by OriginTrail DKG
          </p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function GateNotice({ gate, cg }: { gate: string; cg: string | null }) {
  if (gate === "not-subscribed" && cg) {
    return (
      <details className="rounded-xl border border-border/70 p-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">
          Connect your own DKG node
        </summary>
        <p className="mt-2">
          Your edge node has not joined this channel’s Context Graph yet.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-2 text-2xs">
          {`curl -X POST http://127.0.0.1:9200/api/context-graph/subscribe \\
  -H "authorization: Bearer $(tail -1 $DKG_HOME/auth.token)" \\
  -H "content-type: application/json" \\
  -d '{"contextGraphId":"${cg}","includeSharedMemory":true}'`}
        </pre>
      </details>
    );
  }
  return (
    <Card className="p-3 text-xs leading-relaxed text-muted-foreground">
      Neither a local DKG node nor this community’s DKG provider is answering.
      Refresh in a moment or ask the community operator to check the
      integration.
    </Card>
  );
}
