import { useState } from "react";
import { Network, ShieldCheck, Users } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import type { ChannelMemory } from "../api";
import { explorerSource, nodeUiDeepLink } from "../api";
import { useContributorTrail, useProfileNames } from "../hooks";
import { EvidenceCard } from "./EvidenceCard";
import { GraphOverlay, type GraphOverlayTarget } from "./GraphOverlay";
import { MemorySearch } from "./MemorySearch";
import { SoftwareMemoryQuery } from "./SoftwareMemoryQuery";

const LAYER_META = {
  WM: { label: "Draft", hint: "only on this node", dot: "bg-slate-400" },
  SWM: { label: "Shared", hint: "channel memory", dot: "bg-amber-400" },
  VM: { label: "Anchored", hint: "integrity record", dot: "bg-emerald-500" },
} as const;

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`;
}

export function MemoryOverview({
  channelId,
  cg,
  data,
}: {
  channelId: string;
  cg: string | null;
  data: ChannelMemory & { gate: "ok" };
}) {
  const [trailPubkey, setTrailPubkey] = useState<string | null>(null);
  const [graphTarget, setGraphTarget] = useState<GraphOverlayTarget | null>(
    null,
  );
  const trail = useContributorTrail(channelId, cg, trailPubkey);
  const contributorPubkeys = (data.contributors ?? []).map(
    (contributor) => contributor.pubkey,
  );
  const profiles = useProfileNames(contributorPubkeys);
  const sortedDecisions = [...(data.decisions ?? [])].sort((a, b) =>
    (b.at ?? "").localeCompare(a.at ?? ""),
  );
  const latestDecision =
    sortedDecisions.find((decision) => decision.at) ??
    sortedDecisions[0] ??
    null;
  const providerIsGateway = explorerSource() === "gateway";
  const topicCount = (data.subgraphs ?? []).filter(
    (subgraph) => subgraph.entityCount > 0,
  ).length;

  return (
    <>
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
        onClick={() => setGraphTarget({ kind: "channel" })}
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

          {sortedDecisions.length > 0 && topicCount === 0 && (
            <section>
              <SectionTitle icon={<Network />}>Timeline</SectionTitle>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() =>
                  setGraphTarget({
                    kind: "channel-decisions",
                    decisions: sortedDecisions,
                  })
                }
                title="Open all captured decisions as a traces timeline"
                data-testid="dkg-subgraph-all-decisions"
              >
                All decisions
                <span className="text-muted-foreground">
                  {sortedDecisions.length}
                </span>
              </Button>
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
                      onClick={() =>
                        setGraphTarget({
                          kind: "subgraph",
                          name: subgraph.name,
                        })
                      }
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

      {graphTarget && (
        <GraphOverlay
          channelId={channelId}
          cg={cg}
          target={graphTarget}
          onClose={() => setGraphTarget(null)}
        />
      )}
    </>
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
