// Prototype mount for the Buzz-native DKG memory experience, per the
// 2026-08-01 design deliberation (captured in the web-of-trust CG):
// a read-first "Catch up" side panel beside the conversation. The toggle
// lives in the channel header so it never covers message actions.
import { MemoryPanel } from "./MemoryPanel";
import { useDkgMemoryDockOpen } from "./memoryDockStore";

export function DkgMemoryDock({ channelId }: { channelId: string | null }) {
  const open = useDkgMemoryDockOpen(channelId);
  if (!channelId || !open) return null;
  return (
    <aside
      data-testid="dkg-memory-panel"
      className="absolute bottom-0 right-0 top-14 z-40 w-[420px] max-w-[calc(100vw-1rem)] border-l border-t border-border/70 bg-background/98 shadow-2xl backdrop-blur"
    >
      <MemoryPanel channelId={channelId} />
    </aside>
  );
}
