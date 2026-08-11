import { useSyncExternalStore } from "react";

let openChannelId: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of listeners) listener();
}

export function toggleDkgMemoryDock(channelId: string) {
  const next = openChannelId === channelId ? null : channelId;
  if (next === openChannelId) return;
  openChannelId = next;
  emit();
}

export function closeDkgMemoryDock() {
  if (openChannelId === null) return;
  openChannelId = null;
  emit();
}

export function resetDkgMemoryDockState() {
  closeDkgMemoryDock();
}

export function isDkgMemoryDockOpen(channelId: string | null): boolean {
  return channelId !== null && openChannelId === channelId;
}

export function useDkgMemoryDockOpen(channelId: string | null) {
  return useSyncExternalStore(
    subscribe,
    () => isDkgMemoryDockOpen(channelId),
    () => false,
  );
}
