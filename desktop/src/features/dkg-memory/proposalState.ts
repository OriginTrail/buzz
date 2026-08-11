export type MemoryProposalProgress = "stored" | "processing" | "unknown";

const STORED_STATES = new Set(["stored", "receipted"]);
const PROCESSING_STATES = new Set([
  "processing",
  "distilled",
  "wm_written",
  "finalized",
  "shared",
]);

/** Keep the desktop's public lifecycle vocabulary aligned with `buzz memory`. */
export function memoryProposalProgress(state: unknown): MemoryProposalProgress {
  if (typeof state !== "string") return "unknown";
  if (STORED_STATES.has(state)) return "stored";
  if (PROCESSING_STATES.has(state)) return "processing";
  return "unknown";
}

export function normalizedMemoryProposalState(
  state: unknown,
): string | undefined {
  const progress = memoryProposalProgress(state);
  return progress === "unknown" ? undefined : progress;
}
