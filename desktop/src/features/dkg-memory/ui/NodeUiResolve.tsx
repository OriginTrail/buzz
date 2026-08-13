// Resolve-in-node-UI affordance — the bridge from the Buzz memory surface
// into the DKG node's own Knowledge Asset views, and the honest upgrade
// prompt when the viewer has no node (the RFC's progressive path: community
// provider today, your own Edge node when you want independent verification).
//
// The affordance is gated on whether a node UI actually ANSWERS on this
// device, not on the panel's read path: gateway reads and a running node UI
// legitimately coexist (e.g. the node doesn't hold this CG yet), and the
// setup prompt is only for viewers with no node at all.
import { useState } from "react";
import { explorerSource, nodeUiDeepLink } from "../api";
import { useNodeUiPresence } from "../hooks";
import { openExternal } from "./openExternal";

const EDGE_NODE_GUIDE = "https://github.com/OriginTrail/buzz-dkg-integration";

export function NodeUiResolve({
  cg,
  layer,
  entity,
}: {
  cg: string;
  layer?: "WM" | "SWM" | "VM" | null;
  /** Entity URI to focus inside the CG tab (preferred over a layer tab). */
  entity?: string | null;
}) {
  const [hint, setHint] = useState(false);
  const source = explorerSource();
  const nodeUi = useNodeUiPresence(source !== "local");
  const lc = layer ? (layer.toLowerCase() as "wm" | "swm" | "vm") : undefined;

  if (source === "local" || nodeUi.data === true) {
    const href = nodeUiDeepLink(cg, entity ? { entity } : { layer: lc });
    return (
      <a
        href={href}
        onClick={(event) => openExternal(event, href)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
        title={
          source === "local"
            ? undefined
            : "A DKG node UI is running on this device; the asset opens there. Panel reads still resolve through the community provider."
        }
        data-testid="dkg-node-ui-link"
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
          {" — none was detected on this device"}. You are currently reading
          through the community provider — run your own node to resolve assets
          locally and upgrade this panel to{" "}
          <span className="text-green-600 dark:text-green-400">
            ✓ verified through your node
          </span>
          .{" "}
          <a
            href={EDGE_NODE_GUIDE}
            onClick={(event) => openExternal(event, EDGE_NODE_GUIDE)}
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
