import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Link2,
  Loader2,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useChannelMembersQuery } from "@/features/channels/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Textarea } from "@/shared/ui/textarea";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { publishTrustVouch } from "../api";
import { useProfileNames, useTrustNetwork } from "../hooks";

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

export function WebOfTrustPanel({ channelId }: { channelId: string }) {
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
  const [notice, setNotice] = useState<string | null>(null);
  const activePubkey = selected ?? people[0]?.pubkey ?? null;
  const activePerson = people.find((person) => person.pubkey === activePubkey);
  const received = (network.data?.vouches ?? []).filter(
    (vouch) => vouch.subject === activePubkey && vouch.status === "active",
  );

  const publish = useMutation({
    mutationFn: () =>
      publishTrustVouch({
        channelId,
        subjectPubkey: activePubkey ?? "",
        subjectName: activePubkey
          ? labelFor(activePubkey, displayNames)
          : "community member",
        note,
      }),
    onSuccess: async (result) => {
      setNote("");
      setNotice(
        result.state === "processing"
          ? "Signed vouch accepted. The Context Graph is still updating."
          : "Signed vouch stored with its source evidence.",
      );
      await queryClient.invalidateQueries({
        queryKey: ["dkg-memory", "trust-network", channelId],
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
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="dkg-web-of-trust">
      <Card className="border-primary/20 bg-primary/5 p-3">
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-xs font-semibold">Evidence, not a score</p>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              Vouches are signed by people. Contribution counts and every trust
              relationship stay linked to their channel evidence.
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
        <Badge variant="success">DKG evidence</Badge>
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {identity.data?.pubkey?.toLowerCase() !== activePubkey && (
            <div className="border-t border-border/70 pt-3">
              <p className="text-xs font-medium">Add your signed vouch</p>
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
                  Sign vouch
                </Button>
              </div>
              {publish.isError && (
                <p className="mt-2 text-2xs text-destructive">
                  {publish.error instanceof Error
                    ? publish.error.message
                    : "The vouch could not be recorded."}
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
