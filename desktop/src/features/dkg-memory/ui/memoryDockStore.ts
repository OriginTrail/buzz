import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setDkgMemoryDockOpen(next: boolean) {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function useDkgMemoryDockOpen() {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}
