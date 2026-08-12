import type { ChannelMemory, MemoryGate } from "../api";
import { DkgProviderError } from "../provider";

export type MemoryPanelState =
  | { kind: "loading" }
  | { kind: "provisioning" }
  | { kind: "fallback"; gate: MemoryGate }
  | { kind: "overview"; data: ChannelMemory & { gate: "ok" } };

function isUnknownChannel(error: unknown): boolean {
  return (
    (error instanceof DkgProviderError && error.code === "unknown_channel") ||
    (error instanceof Error &&
      /unknown_channel|not configured for DKG/i.test(error.message))
  );
}

export function resolveMemoryPanelState({
  bindingLoading,
  memoryLoading,
  error,
  data,
}: {
  bindingLoading: boolean;
  memoryLoading: boolean;
  error: unknown;
  data: ChannelMemory | undefined;
}): MemoryPanelState {
  if (bindingLoading || memoryLoading) return { kind: "loading" };
  if (isUnknownChannel(error)) return { kind: "provisioning" };
  if (data?.gate === "ok")
    return { kind: "overview", data: { ...data, gate: "ok" } };
  return { kind: "fallback", gate: data?.gate ?? "node-missing" };
}
