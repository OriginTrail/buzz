export type MemoryProposalProgress = "stored" | "processing" | "unknown";

import proposalStates from "../../../../shared/dkg-memory/proposal-states.json" with {
  type: "json",
};

const STORED_STATES = new Set(proposalStates.stored);
const PROCESSING_STATES = new Set(proposalStates.processing);

/**
 * Compatibility shim for beta relays that predate the public two-state
 * lifecycle. The same checked-in contract is consumed by `buzz memory`.
 */
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
