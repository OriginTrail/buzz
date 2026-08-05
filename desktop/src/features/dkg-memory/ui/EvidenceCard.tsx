// Decision card with the humanize-wrap anatomy: Status / Why / From / As of
// visible, "View evidence" disclosure revealing the full Evidence Envelope.
// The envelope is the canonical agent/human seam: the JSON toggle shows the
// EXACT object agents consume — fields collapse for humans, the envelope is
// never thinned.
import { useState } from "react";
import type { EvidenceEnvelope } from "../api";
import { useEvidence, useProfileNames } from "../hooks";
import { NodeUiResolve } from "./NodeUiResolve";

const LAYER_HUMAN = {
  WM: "Draft — only on this node",
  SWM: "Channel Memory — shared with channel members",
  VM: "Anchored Record — integrity anchor on-chain",
} as const;

export function EvidenceCard({
  cg,
  uri,
  title,
  at,
}: {
  cg: string;
  uri: string;
  title: string;
  at: string | null;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const evidence = useEvidence(cg, showEvidence ? uri : null);
  const env = evidence.data;
  const authorPks = env?.attribution ?? [];
  const profiles = useProfileNames(authorPks);

  const status =
    env?.memoryLayer === "VM"
      ? "Anchored Record"
      : "Shared with channel members";
  const from =
    authorPks.length > 0
      ? authorPks
          .map((pk) => profiles.data?.[pk] ?? `${pk.slice(0, 8)}…`)
          .join(", ")
      : null;

  return (
    <div className="rounded-md border border-border bg-muted/20 p-2">
      <p className="text-xs leading-snug">{title}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
        {showEvidence && env ? (
          <>
            <span>
              <span className="font-medium">Status:</span> {status}
            </span>
            {from && (
              <span>
                <span className="font-medium">From:</span> {from}
              </span>
            )}
          </>
        ) : null}
        {at && (
          <span>
            <span className="font-medium">As of:</span>{" "}
            {new Date(at).toLocaleString()}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowEvidence((v) => !v)}
          className="text-primary hover:underline"
          data-testid="view-evidence"
        >
          {showEvidence ? "Hide evidence" : "View evidence"}
        </button>
      </div>
      {showEvidence && (
        <div className="mt-2 border-t border-border pt-2">
          {evidence.isLoading && (
            <p className="text-2xs text-muted-foreground">
              Reading evidence through your node…
            </p>
          )}
          {env?.found && <EnvelopeBody env={env} />}
          {env && env.found === false && (
            <p className="text-2xs text-muted-foreground">
              This record is not resolvable through your node yet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function EnvelopeBody({ env }: { env: EvidenceEnvelope }) {
  const [showJson, setShowJson] = useState(false);
  return (
    <div className="space-y-1.5 text-2xs">
      <p className="text-muted-foreground">
        {env.trustState} ·{" "}
        {env.memoryLayer ? LAYER_HUMAN[env.memoryLayer] : "layer unknown"}
      </p>
      {env.sources && env.sources.length > 0 && (
        <div>
          <p className="mb-0.5 font-medium uppercase tracking-wide text-muted-foreground">
            Built from {env.sources.length} source message
            {env.sources.length === 1 ? "" : "s"}
          </p>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {env.sources.slice(0, 6).map((s) => (
              <p key={s.id} className="leading-snug" title={s.id}>
                {s.span ?? s.id}
              </p>
            ))}
            {env.sources.length > 6 && (
              <p className="text-muted-foreground">
                +{env.sources.length - 6} more
              </p>
            )}
          </div>
        </div>
      )}
      {env.digest && (
        <p className="break-all font-mono text-3xs text-muted-foreground">
          digest {env.digest}
        </p>
      )}
      {env.receiptUal && (
        <p className="break-all font-mono text-3xs text-muted-foreground">
          UAL {env.receiptUal}
        </p>
      )}
      {env.replay?.cg && (
        <NodeUiResolve cg={env.replay.cg} layer={env.memoryLayer} />
      )}
      <button
        type="button"
        onClick={() => setShowJson((v) => !v)}
        className="text-primary hover:underline"
        title="The exact envelope object agents consume — same data, same shape"
      >
        {showJson ? "hide agent view" : "{} agent view"}
      </button>
      {showJson && (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-1.5 font-mono text-3xs">
          {JSON.stringify(env, null, 2)}
        </pre>
      )}
    </div>
  );
}
