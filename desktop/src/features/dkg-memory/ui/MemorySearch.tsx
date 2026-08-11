import { useState } from "react";
import { Search, Sparkles } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { fetchSemanticQuery } from "../api";
import {
  buildMemoryKeywordQuery,
  MEMORY_SEARCH_SUGGESTIONS,
  memorySearchRows,
  type MemorySearchRow,
} from "../semanticQueries";

export function MemorySearch({ channelId }: { channelId: string }) {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<MemorySearchRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState<string | null>(null);

  async function run(sparql: string, label?: string) {
    setLoading(true);
    setError(null);
    if (label) setInput(label);
    try {
      const result = await fetchSemanticQuery(channelId, sparql);
      setRows(memorySearchRows(result));
      setCost(
        result.cost
          ? `Query weight ${result.cost.score}/${result.cost.budget}`
          : null,
      );
    } catch (cause) {
      setRows(null);
      setCost(null);
      setError(cause instanceof Error ? cause.message : "Memory query failed.");
    } finally {
      setLoading(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      void run(buildMemoryKeywordQuery(input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Add a search topic.");
    }
  }

  return (
    <section className="space-y-3" data-testid="dkg-memory-search">
      <div>
        <div className="mb-1 flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <h4 className="text-sm font-semibold">Find in channel memory</h4>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Searches entities in this channel’s DKG. Ask an agent in chat when you
          want an explanation or synthesis.
        </p>
      </div>
      <form onSubmit={submit} className="flex gap-2">
        <Input
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="x402, Alice, verifyToken…"
          className="min-w-0"
          aria-label="Search channel memory"
        />
        <Button
          type="submit"
          size="icon"
          disabled={loading}
          aria-label="Search"
        >
          <Search className={loading ? "animate-pulse" : ""} />
        </Button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(MEMORY_SEARCH_SUGGESTIONS).map(([label, sparql]) => (
          <Button
            key={label}
            type="button"
            variant="outline"
            size="xs"
            disabled={loading}
            onClick={() => void run(sparql, label)}
          >
            {label}
          </Button>
        ))}
      </div>
      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {rows && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-2xs text-muted-foreground">
            <span>
              {rows.length} graph result{rows.length === 1 ? "" : "s"}
            </span>
            {cost && <span>{cost}</span>}
          </div>
          {rows.length === 0 ? (
            <p className="rounded-lg bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing matched yet. Try a shorter or more specific term.
            </p>
          ) : (
            <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {rows.map((row) => (
                <article
                  key={`${row.layer}-${row.entity}`}
                  className="rounded-lg border border-border/70 bg-card/60 px-3 py-2"
                  title={row.entity}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{row.name}</p>
                      {row.description && (
                        <p className="mt-0.5 line-clamp-2 text-2xs leading-relaxed text-muted-foreground">
                          {row.description}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                      {row.type ?? "Entity"} · {row.layer}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
