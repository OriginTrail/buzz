// Prototype mount for the Buzz-native DKG memory experience, per the
// 2026-08-01 design deliberation (captured in the web-of-trust CG):
// a read-first "Catch up" side panel beside the conversation, toggled by a
// floating chip. Self-contained so the ChannelPane diff stays one line.
import { useState } from "react";
import { MemoryPanel } from "./MemoryPanel";

export function DkgMemoryDock({ channelId }: { channelId: string | null }) {
  const [open, setOpen] = useState(false);
  if (!channelId) return null;
  return (
    <>
      <button
        type="button"
        data-testid="dkg-memory-toggle"
        onClick={() => setOpen((v) => !v)}
        className="absolute right-3 top-14 z-30 rounded-full border border-border bg-background/90 px-2.5 py-1 text-xs font-medium shadow-sm backdrop-blur transition-colors hover:bg-muted"
        title="Channel memory (DKG)"
      >
        ◈ Memory
      </button>
      {open ? (
        <aside
          data-testid="dkg-memory-panel"
          className="absolute bottom-0 right-0 top-14 z-20 w-[340px] border-l border-t border-border bg-background shadow-xl"
        >
          <MemoryPanel channelId={channelId} />
        </aside>
      ) : null}
    </>
  );
}
