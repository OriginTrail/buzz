import { useState } from "react";
import {
  fetchDecisionTrace,
  fetchSoftwareContributors,
  type DecisionTrace,
  type SoftwareContributors,
} from "../api";

type QueryResult =
  | { kind: "contributors"; value: SoftwareContributors }
  | { kind: "decisions"; value: DecisionTrace };

export function SoftwareMemoryQuery({ channelId }: { channelId: string }) {
  const [mode, setMode] = useState<"contributors" | "decisions">(
    "contributors",
  );
  const [component, setComponent] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runQuery() {
    const componentName = component.trim();
    if (!componentName || (mode === "decisions" && !commitSha.trim())) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      if (mode === "contributors") {
        setResult({
          kind: mode,
          value: await fetchSoftwareContributors(
            channelId,
            componentName,
            "function",
          ),
        });
      } else {
        setResult({
          kind: mode,
          value: await fetchDecisionTrace(
            channelId,
            commitSha.trim(),
            componentName,
          ),
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Query failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mb-3" data-testid="dkg-software-memory-query">
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Software knowledge
      </h4>
      <div className="mb-1 flex gap-1">
        {(["contributors", "decisions"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => {
              setMode(item);
              setResult(null);
              setError(null);
            }}
            className={`rounded-full border px-2 py-0.5 text-2xs ${mode === item ? "border-primary bg-primary/10" : "border-border bg-muted/30"}`}
          >
            {item === "contributors" ? "Who changed it?" : "Why this commit?"}
          </button>
        ))}
      </div>
      <div className="flex gap-1">
        <input
          value={component}
          onChange={(event) => setComponent(event.target.value)}
          placeholder={
            mode === "contributors" ? "Function name" : "Component name"
          }
          className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs outline-none focus:border-primary/60"
        />
        {mode === "decisions" && (
          <input
            value={commitSha}
            onChange={(event) => setCommitSha(event.target.value)}
            placeholder="Commit SHA"
            className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs outline-none focus:border-primary/60"
          />
        )}
        <button
          type="button"
          onClick={() => void runQuery()}
          disabled={loading}
          className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          {loading ? "…" : "Ask"}
        </button>
      </div>
      {error && <p className="mt-1 text-2xs text-destructive">{error}</p>}
      {result?.kind === "contributors" && (
        <div className="mt-2 space-y-1 text-xs">
          {result.value.contributors.length === 0 ? (
            <p className="text-muted-foreground">No matching edits found.</p>
          ) : (
            result.value.contributors.map((entry) => (
              <div
                key={`${entry.contributor}:${entry.commit}`}
                className="rounded bg-muted/30 px-2 py-1"
              >
                <span className="font-medium">
                  {entry.contributorName ?? entry.contributor}
                </span>
                <span className="ml-1 text-muted-foreground">
                  {entry.sha.slice(0, 10)} · {entry.layer}
                </span>
              </div>
            ))
          )}
        </div>
      )}
      {result?.kind === "decisions" && (
        <div className="mt-2 space-y-1 text-xs">
          {result.value.decisions.length === 0 ? (
            <p className="text-muted-foreground">
              No matching decisions found.
            </p>
          ) : (
            result.value.decisions.map((entry) => (
              <div
                key={entry.decision}
                className="rounded bg-muted/30 px-2 py-1"
              >
                <p className="font-medium">
                  {entry.decisionName ?? entry.decision}
                </p>
                {entry.context && (
                  <p className="text-muted-foreground">Why: {entry.context}</p>
                )}
                {entry.outcome && (
                  <p className="text-muted-foreground">
                    Outcome: {entry.outcome}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
