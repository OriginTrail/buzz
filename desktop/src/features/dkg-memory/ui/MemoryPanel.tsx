import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BrainCircuit, RefreshCw, Stethoscope } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { enableChannelMemory } from "../api";
import {
  useChannelContextGraph,
  useChannelMemory,
  useDkgMemoryCapabilities,
  useDiscoveryFallback,
} from "../hooks";
import { DkgDiagnostics } from "./DkgDiagnostics";
import { MemoryOverview } from "./MemoryOverview";
import {
  MemoryFallback,
  MemoryLoading,
  MemoryProvisioningGate,
} from "./MemoryPanelStates";
import { resolveMemoryPanelState } from "./memoryPanelState";

export function MemoryPanel({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const capabilities = useDkgMemoryCapabilities({ enabled: true });
  const cgQuery = useChannelContextGraph(channelId);
  const localCgOverride = cgQuery.data ?? null;
  const memory = useChannelMemory(
    channelId,
    localCgOverride,
    !cgQuery.isLoading,
  );
  const cg = memory.data?.cg ?? localCgOverride;
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const panelState = resolveMemoryPanelState({
    bindingLoading: cgQuery.isLoading,
    memoryLoading: memory.isLoading,
    error: memory.error,
    data: memory.data,
  });
  const discovery = useDiscoveryFallback(
    channelId,
    panelState.kind === "fallback",
  );

  async function startMemory() {
    setEnabling(true);
    setEnableError(null);
    try {
      await enableChannelMemory(channelId);
      await queryClient.invalidateQueries({ queryKey: ["dkg-memory"] });
      window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["dkg-memory"] });
      }, 2_500);
    } catch (cause) {
      setEnableError(
        cause instanceof Error
          ? cause.message
          : "Could not start DKG memory for this channel.",
      );
    } finally {
      setEnabling(false);
    }
  }

  const diagnosticsAction = (
    <Button
      type="button"
      variant={diagnosticsOpen ? "secondary" : "ghost"}
      size="icon-xs"
      onClick={() => setDiagnosticsOpen((open) => !open)}
      title="Test DKG connection"
      aria-label="Test DKG connection"
      data-testid="dkg-diagnostics-toggle"
    >
      <Stethoscope />
    </Button>
  );
  const action =
    panelState.kind === "overview" ? (
      <div className="flex items-center gap-1">
        {diagnosticsAction}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => void memory.refetch()}
          disabled={memory.isFetching}
          title="Refresh channel memory"
        >
          <RefreshCw className={memory.isFetching ? "animate-spin" : ""} />
        </Button>
      </div>
    ) : (
      diagnosticsAction
    );

  return (
    <PanelShell action={action}>
      {diagnosticsOpen && <DkgDiagnostics channelId={channelId} />}
      {panelState.kind === "loading" && <MemoryLoading />}
      {panelState.kind === "provisioning" && (
        <MemoryProvisioningGate
          enabling={enabling}
          error={enableError}
          onStart={() => void startMemory()}
        />
      )}
      {panelState.kind === "fallback" && (
        <MemoryFallback
          entries={discovery.data}
          loading={discovery.isLoading}
          gate={panelState.gate}
          cg={cg}
        />
      )}
      {panelState.kind === "overview" && (
        <MemoryOverview
          channelId={channelId}
          cg={cg}
          data={panelState.data}
          trustAvailable={capabilities.data?.trust ?? false}
        />
      )}
    </PanelShell>
  );
}

function PanelShell({
  action,
  children,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2 pr-10">
        <div className="rounded-lg bg-primary/10 p-1.5 text-primary">
          <BrainCircuit className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Channel memory</h3>
          <p className="text-3xs text-muted-foreground">
            Powered by OriginTrail DKG
          </p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
