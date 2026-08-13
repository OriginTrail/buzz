import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  History,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  UserRoundCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useChannelMembersQuery } from "@/features/channels/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Checkbox } from "@/shared/ui/checkbox";
import { Textarea } from "@/shared/ui/textarea";
import { truncatePubkey } from "@/shared/lib/pubkey";
import {
  publishTrustVouch,
  retryPendingTrustProjections,
  revokeTrustVouch,
  type ReputationSummary,
  type WorkEvidence,
} from "../api";
import {
  useProfileNames,
  useReputationSummary,
  useTrustNetwork,
} from "../hooks";

function labelFor(
  pubkey: string,
  names: Record<string, string> | undefined,
): string {
  return names?.[pubkey] ?? truncatePubkey(pubkey);
}

function sourceId(uri: string | null): string | null {
  if (!uri) return null;
  return uri.startsWith("urn:nostr:event:")
    ? uri.slice("urn:nostr:event:".length)
    : uri;
}

function evidenceLabel(evidence: WorkEvidence): string {
  const kind = evidence.kind.split(/[/#]/).at(-1) ?? "Evidence";
  return evidence.name ? `${evidence.name} · ${kind}` : kind;
}

export function WebOfTrustPanel({
  channelId,
  reputationAvailable,
}: {
  channelId: string;
  reputationAvailable: boolean;
}) {
  const queryClient = useQueryClient();
  const identity = useIdentityQuery();
  const network = useTrustNetwork(channelId);
  const members = useChannelMembersQuery(channelId);
  const people = useMemo(() => {
    const byPubkey = new Map(
      (network.data?.people ?? []).map((person) => [person.pubkey, person]),
    );
    for (const member of members.data ?? []) {
      const pubkey = member.pubkey.toLowerCase();
      if (!byPubkey.has(pubkey)) {
        byPubkey.set(pubkey, {
          pubkey,
          contributions: 0,
          latest: null,
          vouchesReceived: 0,
          vouchesGiven: 0,
          layer: "SWM",
        });
      }
    }
    return [...byPubkey.values()];
  }, [members.data, network.data?.people]);
  const pubkeys = useMemo(
    () => people.map((person) => person.pubkey),
    [people],
  );
  const names = useProfileNames(pubkeys);
  const displayNames = useMemo(() => {
    const resolved: Record<string, string> = {};
    for (const member of members.data ?? []) {
      if (member.displayName) {
        resolved[member.pubkey.toLowerCase()] = member.displayName;
      }
    }
    return { ...resolved, ...names.data };
  }, [members.data, names.data]);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const activePubkey = selected ?? people[0]?.pubkey ?? null;
  const activePerson = people.find((person) => person.pubkey === activePubkey);
  const reputation = useReputationSummary(
    reputationAvailable ? channelId : null,
    activePubkey,
  );
  const received = (network.data?.vouches ?? []).filter(
    (vouch) => vouch.subject === activePubkey && vouch.status === "active",
  );
  const historical = (network.data?.vouches ?? []).filter(
    (vouch) => vouch.subject === activePubkey && vouch.status !== "active",
  );
  const ownActive = received.find(
    (vouch) =>
      vouch.issuer === identity.data?.pubkey?.toLowerCase() &&
      sourceId(vouch.sourceEvent),
  );
  const workEvidence = reputation.data?.workEvidence ?? [];

  useEffect(() => {
    let active = true;
    void retryPendingTrustProjections(channelId).then((result) => {
      if (!active || result.completed === 0) return;
      setNotice(
        result.remaining > 0
          ? `${result.completed} pending trust update${result.completed === 1 ? "" : "s"} recovered; ${result.remaining} still waiting.`
          : `${result.completed} pending trust update${result.completed === 1 ? "" : "s"} recovered.`,
      );
      void queryClient.invalidateQueries({
        queryKey: ["dkg-memory", "trust-network", channelId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["dkg-memory", "reputation-summary", channelId],
      });
    });
    return () => {
      active = false;
    };
  }, [channelId, queryClient]);

  const publish = useMutation({
    mutationFn: () =>
      publishTrustVouch({
        channelId,
        subjectPubkey: activePubkey ?? "",
        subjectName: activePubkey
          ? labelFor(activePubkey, displayNames)
          : "community member",
        note,
        evidence: workEvidence.filter((item) =>
          selectedEvidence.includes(item.uri),
        ),
        supersedesEventId: ownActive ? sourceId(ownActive.sourceEvent) : null,
      }),
    onSuccess: async (result) => {
      setNote("");
      setSelectedEvidence([]);
      setNotice(
        result.state === "projection_pending"
          ? "Your signed vouch is safely queued. Relay delivery and its graph update will retry when this panel opens."
          : result.state === "processing"
            ? "Signed vouch accepted. The Context Graph is still updating."
            : "Signed vouch stored with its source evidence.",
      );
      await queryClient.invalidateQueries({
        queryKey: ["dkg-memory", "trust-network", channelId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["dkg-memory", "reputation-summary", channelId],
      });
    },
  });

  const revoke = useMutation({
    mutationFn: () =>
      revokeTrustVouch({
        channelId,
        subjectPubkey: activePubkey ?? "",
        targetEventId: ownActive ? (sourceId(ownActive.sourceEvent) ?? "") : "",
      }),
    onSuccess: async (result) => {
      setNotice(
        result.state === "projection_pending"
          ? "Your signed revocation is safely queued for relay and graph retry."
          : "Your signed vouch was revoked. Its history remains inspectable.",
      );
      await queryClient.invalidateQueries({
        queryKey: ["dkg-memory", "trust-network", channelId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["dkg-memory", "reputation-summary", channelId],
      });
    },
  });

  if (network.isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading trust evidence…
      </div>
    );
  }

  if (network.isError) {
    return (
      <Card className="p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">
          Trust evidence unavailable
        </p>
        <p className="mt-1">
          {network.error instanceof Error
            ? network.error.message
            : "The community DKG did not return a trust network."}
        </p>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="mt-3"
          disabled={network.isFetching}
          onClick={() => void network.refetch()}
        >
          <RefreshCw className={network.isFetching ? "animate-spin" : ""} />
          Try again
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="dkg-web-of-trust">
      <Card className="border-primary/20 bg-primary/5 p-3">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-xs font-semibold">
              Contextual, explainable reputation
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              Vouches are signed by people. Contribution counts and every trust
              relationship stay linked to their channel evidence. The score is
              specific to this channel and never grants permissions.
            </p>
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold">Community trust network</p>
          <p className="text-2xs text-muted-foreground">
            {people.length} identities · {network.data?.vouches.length ?? 0}{" "}
            signed vouches
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant="success">DKG evidence</Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={network.isFetching}
            onClick={() => void network.refetch()}
            title="Refresh trust evidence"
            aria-label="Refresh trust evidence"
          >
            <RefreshCw className={network.isFetching ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {people.length === 0 ? (
        <Card className="p-3 text-xs text-muted-foreground">
          No people have evidence in this channel yet. Agent memories and signed
          vouches will appear here as the community works.
        </Card>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {people.map((person) => (
            <Button
              key={person.pubkey}
              type="button"
              variant={activePubkey === person.pubkey ? "secondary" : "outline"}
              size="xs"
              onClick={() => {
                setSelected(person.pubkey);
                setSelectedEvidence([]);
                setNotice(null);
              }}
              data-testid={`trust-person-${person.pubkey}`}
            >
              {labelFor(person.pubkey, displayNames)}
              <span className="text-muted-foreground">
                {person.vouchesReceived} vouch
                {person.vouchesReceived === 1 ? "" : "es"}
              </span>
            </Button>
          ))}
        </div>
      )}

      {activePerson && activePubkey && (
        <Card className="space-y-3 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {labelFor(activePubkey, displayNames)}
              </p>
              <p className="font-mono text-3xs text-muted-foreground">
                {truncatePubkey(activePubkey)}
              </p>
            </div>
            <Badge variant={activePerson.layer === "VM" ? "success" : "info"}>
              {activePerson.layer === "VM" ? "Anchored" : "Channel memory"}
            </Badge>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <Metric
              label="Evidence records"
              value={activePerson.contributions}
            />
            <Metric
              label="Vouches received"
              value={activePerson.vouchesReceived}
            />
            <Metric label="Vouches given" value={activePerson.vouchesGiven} />
          </div>

          {reputationAvailable && (
            <ReputationCard
              isLoading={reputation.isLoading}
              error={reputation.error}
              data={reputation.data}
            />
          )}

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
              <UserRoundCheck className="h-3.5 w-3.5 text-primary" />
              Why people vouch for them
            </p>
            {received.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                No signed vouches yet. Absence of evidence is not negative
                evidence.
              </p>
            ) : (
              <div className="space-y-2">
                {received.map((vouch) => {
                  const source = sourceId(vouch.sourceEvent);
                  return (
                    <div
                      key={vouch.uri}
                      className="rounded-lg border border-border/70 bg-muted/20 p-2.5"
                    >
                      <p className="text-xs leading-relaxed">
                        {vouch.note ?? "Signed community vouch"}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-3xs text-muted-foreground">
                        <span>by {labelFor(vouch.issuer, displayNames)}</span>
                        {vouch.at && (
                          <span>
                            {new Date(vouch.at * 1_000).toLocaleString()}
                          </span>
                        )}
                        {source && (
                          <span
                            className="inline-flex items-center gap-1"
                            title={source}
                          >
                            <Link2 className="h-3 w-3" /> source{" "}
                            {truncatePubkey(source)}
                          </span>
                        )}
                      </div>
                      {(vouch.evidence ?? []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {(vouch.evidence ?? []).map((uri) => (
                            <Badge key={uri} variant="secondary" title={uri}>
                              <Link2 className="mr-1 h-3 w-3" />
                              {uri.split(/[/#]/).at(-1)?.slice(0, 24) ??
                                "evidence"}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {historical.length > 0 && (
            <details className="rounded-lg border border-border/70 bg-muted/10 p-2.5">
              <summary className="flex cursor-pointer items-center gap-1.5 text-2xs font-medium">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                Vouch history ({historical.length})
              </summary>
              <div className="mt-2 space-y-1.5">
                {historical.map((vouch) => (
                  <div
                    key={vouch.uri}
                    className="rounded-md border border-border/50 p-2 text-3xs text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">
                      {vouch.status}
                    </span>{" "}
                    · by {labelFor(vouch.issuer, displayNames)} ·{" "}
                    {vouch.note ?? "Signed community vouch"}
                  </div>
                ))}
              </div>
            </details>
          )}

          {identity.data?.pubkey?.toLowerCase() !== activePubkey && (
            <div className="border-t border-border/70 pt-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-medium">
                    {ownActive
                      ? "Update your signed vouch"
                      : "Add your signed vouch"}
                  </p>
                  {ownActive && (
                    <p className="mt-0.5 text-3xs text-muted-foreground">
                      The previous version will remain in history as superseded.
                    </p>
                  )}
                </div>
                {ownActive && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={revoke.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Revoke your current vouch? The signed history will remain visible.",
                        )
                      ) {
                        setNotice(null);
                        revoke.mutate();
                      }
                    }}
                    data-testid="trust-vouch-revoke"
                  >
                    {revoke.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldX className="h-3.5 w-3.5" />
                    )}
                    Revoke
                  </Button>
                )}
              </div>
              <p className="mt-0.5 text-2xs text-muted-foreground">
                Describe something you directly observed. This becomes the
                public explanation attached to your signature.
              </p>
              <Textarea
                className="mt-2 min-h-20 text-xs"
                maxLength={1_000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="For example: reviewed two releases carefully and caught a rollback edge case."
                data-testid="trust-vouch-note"
              />
              {workEvidence.length > 0 && (
                <div className="mt-3 rounded-lg border border-border/70 bg-muted/20 p-2.5">
                  <p className="text-2xs font-medium">Attach observed work</p>
                  <p className="mt-0.5 text-3xs text-muted-foreground">
                    Optional. Select up to 8 records; their graph URIs are
                    included in your signature.
                  </p>
                  <div className="mt-2 max-h-36 space-y-2 overflow-y-auto pr-1">
                    {workEvidence.map((item, index) => {
                      const checked = selectedEvidence.includes(item.uri);
                      const disabled = !checked && selectedEvidence.length >= 8;
                      const controlId = `trust-evidence-${index}`;
                      return (
                        <label
                          key={item.uri}
                          htmlFor={controlId}
                          className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/60"
                        >
                          <Checkbox
                            id={controlId}
                            className="mt-0.5"
                            checked={checked}
                            disabled={disabled}
                            onCheckedChange={(next) => {
                              setSelectedEvidence((current) =>
                                next
                                  ? [...current, item.uri].slice(0, 8)
                                  : current.filter((uri) => uri !== item.uri),
                              );
                            }}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-2xs">
                              {evidenceLabel(item)}
                            </span>
                            <span className="block text-3xs text-muted-foreground">
                              {item.layer === "VM"
                                ? "Anchored"
                                : "Channel memory"}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-3xs text-muted-foreground">
                  {note.length}/1,000
                </span>
                <Button
                  type="button"
                  size="xs"
                  disabled={!note.trim() || publish.isPending}
                  onClick={() => {
                    setNotice(null);
                    publish.mutate();
                  }}
                  data-testid="trust-vouch-submit"
                >
                  {publish.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <UserRoundCheck className="h-3.5 w-3.5" />
                  )}
                  {ownActive ? "Sign replacement" : "Sign vouch"}
                </Button>
              </div>
              {publish.isError && (
                <p className="mt-2 text-2xs text-destructive">
                  {publish.error instanceof Error
                    ? publish.error.message
                    : "The vouch could not be recorded."}
                </p>
              )}
              {revoke.isError && (
                <p className="mt-2 text-2xs text-destructive">
                  {revoke.error instanceof Error
                    ? revoke.error.message
                    : "The vouch could not be revoked."}
                </p>
              )}
              {notice && (
                <p className="mt-2 flex items-center gap-1.5 text-2xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {notice}
                </p>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/40 p-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-3xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ReputationCard({
  isLoading,
  error,
  data,
}: {
  isLoading: boolean;
  error: Error | null;
  data: ReputationSummary | undefined;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border/70 p-3 text-2xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Calculating bounded reputation paths…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-lg border border-border/70 p-3 text-2xs text-muted-foreground">
        {error?.message ?? "Reputation evidence is not available yet."}
      </div>
    );
  }

  const dimensions = [
    ["Direct trust", data.breakdown.directTrust],
    ["Network trust", data.breakdown.networkTrust],
    ["Demonstrated work", data.breakdown.demonstratedWork],
    ["Evidence diversity", data.breakdown.evidenceDiversity],
  ] as const;
  const confidenceVariant =
    data.confidence === "high"
      ? "success"
      : data.confidence === "medium"
        ? "info"
        : data.confidence === "low"
          ? "warning"
          : "secondary";

  return (
    <div
      className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-3"
      data-testid="dkg-reputation-summary"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold">Channel reputation</p>
          <p className="mt-0.5 text-3xs text-muted-foreground">
            From your perspective · maximum two trust hops
          </p>
        </div>
        <div className="text-right">
          <div
            className="text-2xl font-semibold tabular-nums leading-none"
            data-testid="dkg-reputation-score"
          >
            {data.score}
            <span className="text-xs font-normal text-muted-foreground">
              /100
            </span>
          </div>
          <div className="mt-1 flex justify-end gap-1">
            <Badge variant={confidenceVariant}>
              {data.confidence} confidence
            </Badge>
            {data.completeness === "partial" ? (
              <Badge variant="warning">bounded sample</Badge>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {dimensions.map(([label, value]) => (
          <div key={label}>
            <div className="mb-1 flex items-center justify-between text-3xs">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-medium tabular-nums">{value}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div>
        <p className="text-2xs font-medium">Why this score</p>
        <ul className="mt-1.5 space-y-1 text-3xs text-muted-foreground">
          {data.reasons.map((reason) => (
            <li key={reason} className="flex gap-1.5">
              <span aria-hidden="true">•</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="border-t border-primary/10 pt-2 text-3xs text-muted-foreground">
        Method: {data.methodology}. This advisory score is calculated from
        bounded graph evidence; it is not a universal identity rating.
      </p>
    </div>
  );
}
