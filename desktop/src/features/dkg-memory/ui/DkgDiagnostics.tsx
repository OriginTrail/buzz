import { useState } from "react";
import {
  Check,
  CircleX,
  Copy,
  Loader2,
  Minus,
  Stethoscope,
} from "lucide-react";
import { runDkgDiagnostics, type DkgDiagnosticReport } from "../api";
import { writeTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";

function reportText(report: DkgDiagnosticReport): string {
  return [
    `Buzz DKG diagnostic — ${report.checkedAt}`,
    `Relay: ${report.relay}`,
    `Channel: ${report.channelId}`,
    ...report.checks.map(
      (check) =>
        `${check.status.toUpperCase()} — ${check.label}: ${check.detail}${check.durationMs === undefined ? "" : ` (${check.durationMs}ms)`}`,
    ),
  ].join("\n");
}

export function DkgDiagnostics({ channelId }: { channelId: string }) {
  const [report, setReport] = useState<DkgDiagnosticReport | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setCopied(false);
    setError(null);
    try {
      setReport(await runDkgDiagnostics(channelId));
    } catch (cause) {
      setReport(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "The diagnostic could not be started.",
      );
    } finally {
      setRunning(false);
    }
  }

  async function copy() {
    if (!report) return;
    await writeTextToClipboard(reportText(report));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <Card
      className="mb-3 border-primary/20 bg-primary/[0.035] p-3"
      data-testid="dkg-diagnostics"
    >
      <div className="flex items-start gap-2.5">
        <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
          <Stethoscope className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold">DKG connection check</p>
          <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
            Tests relay discovery, your Buzz identity, channel access and a
            light graph query.
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          onClick={() => void run()}
          disabled={running}
        >
          {running ? <Loader2 className="animate-spin" /> : <Stethoscope />}
          {running ? "Checking…" : report ? "Run again" : "Run check"}
        </Button>
      </div>

      {report ? (
        <div className="mt-3 space-y-1.5">
          {report.checks.map((check) => (
            <div
              key={check.id}
              className="flex items-start gap-2 rounded-lg bg-background/70 px-2.5 py-2"
            >
              {check.status === "pass" ? (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : check.status === "fail" ? (
                <CircleX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              ) : (
                <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-2xs font-medium">{check.label}</p>
                <p className="text-3xs leading-relaxed text-muted-foreground">
                  {check.detail}
                </p>
              </div>
              {check.durationMs !== undefined ? (
                <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                  {check.durationMs}ms
                </span>
              ) : null}
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void copy()}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy report"}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-2xs text-destructive">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
