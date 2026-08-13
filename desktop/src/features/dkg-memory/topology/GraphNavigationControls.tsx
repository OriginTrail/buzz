import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/shared/ui/button";

export function GraphNavigationControls({
  surfaceRef,
  onFit,
}: {
  surfaceRef: RefObject<HTMLDivElement | null>;
  onFit: () => void;
}) {
  const zoom = (direction: "in" | "out") => {
    const canvas = surfaceRef.current?.querySelector("canvas");
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaY: direction === "in" ? -180 : 180,
        view: window,
      }),
    );
  };

  return (
    <div
      data-testid="dkg-graph-controls"
      className="flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Zoom graph in"
        title="Zoom in"
        onClick={() => zoom("in")}
      >
        <ZoomIn />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Zoom graph out"
        title="Zoom out"
        onClick={() => zoom("out")}
      >
        <ZoomOut />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Fit graph to view"
        title="Fit graph to view"
        onClick={onFit}
      >
        <Maximize2 />
      </Button>
    </div>
  );
}
