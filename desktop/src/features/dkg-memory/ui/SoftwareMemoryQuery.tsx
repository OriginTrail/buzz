import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
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
  const [repository, setRepository] = useState("");
  const [component, setComponent] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [componentType, setComponentType] = useState<
    "function" | "class" | "interface" | "file" | "package"
  >("function");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runQuery() {
    const repositoryUrl = repository.trim();
    const componentName = component.trim();
    if (
      !repositoryUrl ||
      !componentName ||
      (mode === "decisions" && !commitSha.trim())
    )
      return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      if (mode === "contributors") {
        setResult({
          kind: mode,
          value: await fetchSoftwareContributors(
            channelId,
            repositoryUrl,
            componentName,
            componentType,
          ),
        });
      } else {
        setResult({
          kind: mode,
          value: await fetchDecisionTrace(
            channelId,
            repositoryUrl,
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
    <section className="space-y-3" data-testid="dkg-software-memory-query">
      <p className="text-2xs leading-relaxed text-muted-foreground">
        Follow code provenance with stable repository and component identities.
      </p>
      <div className="flex gap-1.5">
        {(["contributors", "decisions"] as const).map((item) => (
          <Button
            key={item}
            type="button"
            variant={mode === item ? "secondary" : "outline"}
            size="xs"
            onClick={() => {
              setMode(item);
              setResult(null);
              setError(null);
            }}
          >
            {item === "contributors" ? "Who changed it?" : "Why this commit?"}
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <Input
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
          placeholder="https://github.com/owner/repository"
          aria-label="Repository URL"
        />
        <div className="flex gap-2">
          {mode === "contributors" && (
            <select
              value={componentType}
              onChange={(event) =>
                setComponentType(event.target.value as typeof componentType)
              }
              aria-label="Component type"
              className="h-9 rounded-lg border border-input/40 bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="function">Function</option>
              <option value="class">Class</option>
              <option value="interface">Interface</option>
              <option value="file">File</option>
              <option value="package">Package</option>
            </select>
          )}
          <Input
            value={component}
            onChange={(event) => setComponent(event.target.value)}
            placeholder="Component name"
            aria-label="Component name"
            className="min-w-0 flex-1"
          />
        </div>
        {mode === "decisions" && (
          <Input
            value={commitSha}
            onChange={(event) => setCommitSha(event.target.value)}
            placeholder="Commit SHA"
            aria-label="Commit SHA"
          />
        )}
        <Button
          type="button"
          onClick={() => void runQuery()}
          disabled={
            loading ||
            !repository.trim() ||
            !component.trim() ||
            (mode === "decisions" && !commitSha.trim())
          }
          size="sm"
          className="w-full"
        >
          <Search className={loading ? "animate-pulse" : ""} />
          {loading ? "Searching…" : "Search software memory"}
        </Button>
      </div>
      {error && <p className="mt-1 text-2xs text-destructive">{error}</p>}
      {result?.kind === "contributors" && (
        <div className="mt-2 space-y-1 text-xs">
          {result.value.contributors.length === 0 ? (
            <p className="text-muted-foreground">No matching edits found.</p>
          ) : (
            result.value.contributors.map((entry) => (
              <Card
                key={`${entry.contributor}:${entry.commit}`}
                className="px-2.5 py-2"
              >
                <span className="font-medium">
                  {entry.contributorName ?? entry.contributor}
                </span>
                <span className="ml-1 text-muted-foreground">
                  {entry.sha.slice(0, 10)} · {entry.layer}
                </span>
              </Card>
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
              <Card key={entry.decision} className="px-2.5 py-2">
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
              </Card>
            ))
          )}
        </div>
      )}
    </section>
  );
}
