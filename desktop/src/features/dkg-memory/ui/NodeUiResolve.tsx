// Resolve-in-node-UI affordance — the bridge from the Buzz memory surface
// into the DKG node's own Knowledge Asset views, and the honest upgrade
// prompt when the viewer has no node (the RFC's progressive path: community
// provider today, your own Edge node when you want independent verification).
import { useState } from "react";
import { explorerSource, nodeUiDeepLink } from "../api";

const EDGE_NODE_GUIDE =
  "https://github.com/Zigoljube/buzz-dkg-integration-ot/blob/ot-rfc-67-reference-instance/docs/ot-rfc-67/BUILDING.md";

export function NodeUiResolve({
  cg,
  layer,
}: {
  cg: string;
  layer?: "WM" | "SWM" | "VM" | null;
}) {
  const [hint, setHint] = useState(false);
  const source = explorerSource();
  const lc = layer ? (layer.toLowerCase() as "wm" | "swm" | "vm") : undefined;

  if (source === "local") {
    return (
      <a
        href={nodeUiDeepLink(cg, lc)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
      >
        Resolve in your node UI ↗
      </a>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setHint((h) => !h)}
        className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground hover:underline"
      >
        Resolve in node UI ↗
      </button>
      {hint && (
        <p className="mt-1 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-2xs leading-snug text-muted-foreground">
          Opening Knowledge Assets in the DKG node UI requires a{" "}
          <span className="font-medium text-foreground">
            local DKG Edge node
          </span>
          . You are currently reading through the community provider — run your
          own node to resolve assets locally and upgrade this panel to{" "}
          <span className="text-green-600 dark:text-green-400">
            ✓ verified through your node
          </span>
          .{" "}
          <a
            href={EDGE_NODE_GUIDE}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            Setup guide ↗
          </a>
        </p>
      )}
    </div>
  );
}
