// Prototype mount for the Buzz-native DKG memory experience, per the
// 2026-08-01 design deliberation (captured in the web-of-trust CG):
// a read-first "Catch up" side panel beside the conversation, toggled by a
// floating chip. Self-contained so the ChannelPane diff stays one line.
import { useState } from "react";
import { BrainCircuit, X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { MemoryPanel } from "./MemoryPanel";

export function DkgMemoryDock({ channelId }: { channelId: string | null }) {
  const [open, setOpen] = useState(false);
  if (!channelId) return null;
  return (
    <>
      {open ? (
        <Button
          type="button"
          data-testid="dkg-memory-toggle"
          onClick={() => setOpen(false)}
          variant="ghost"
          size="icon-xs"
          className="absolute right-3 top-[4.2rem] z-30"
          title="Close channel memory"
          aria-label="Close channel memory"
        >
          <X />
        </Button>
      ) : (
        <Button
          type="button"
          data-testid="dkg-memory-toggle"
          onClick={() => setOpen(true)}
          variant="outline"
          size="sm"
          className="absolute right-3 top-14 z-30 rounded-full bg-background/90 shadow-md backdrop-blur"
          title="Open channel memory"
        >
          <BrainCircuit className="text-primary" />
          Memory
        </Button>
      )}
      {open ? (
        <aside
          data-testid="dkg-memory-panel"
          className="absolute bottom-0 right-0 top-14 z-20 w-[420px] max-w-[calc(100vw-1rem)] border-l border-t border-border/70 bg-background/98 shadow-2xl backdrop-blur"
        >
          <MemoryPanel channelId={channelId} />
        </aside>
      ) : null}
    </>
  );
}
