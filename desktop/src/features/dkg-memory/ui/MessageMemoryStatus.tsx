import { useMemo, useState } from "react";
import {
  BrainCircuit,
  Check,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  useAgentTranscript,
  useObserverEvents,
} from "@/features/agents/ui/useObserverEvents";
import { relayClient } from "@/shared/api/relayClient";
import { Button } from "@/shared/ui/button";
import { memoryStatusForMessage } from "../messageStatus";

export function MessageMemoryStatus({
  agentName,
  agentPubkey,
  channelId,
  messageId,
}: {
  agentName: string;
  agentPubkey: string;
  channelId: string;
  messageId: string;
}) {
  const transcript = useAgentTranscript(true, agentPubkey);
  const observer = useObserverEvents(true, agentPubkey);
  const completedTurnIds = useMemo(
    () =>
      new Set(
        observer.events
          .filter(
            (event) =>
              event.channelId === channelId &&
              event.turnId &&
              ["turn_completed", "turn_error", "agent_panic"].includes(
                event.kind,
              ),
          )
          .map((event) => event.turnId as string),
      ),
    [channelId, observer.events],
  );
  const status = memoryStatusForMessage(
    transcript,
    channelId,
    messageId,
    completedTurnIds,
  );
  const [retrying, setRetrying] = useState(false);
  const [retryRequested, setRetryRequested] = useState(false);
  if (!status) return null;

  async function retry() {
    setRetrying(true);
    try {
      await relayClient.sendMessage(
        channelId,
        `@${agentName} Retry recording DKG memory for response ${messageId}. Use that response as a --source, submit the memory proposal, and do not post a duplicate answer.`,
        [agentPubkey],
      );
      setRetryRequested(true);
    } finally {
      setRetrying(false);
    }
  }

  if (status === "stored") {
    return (
      <div
        className="mt-1.5 flex items-center gap-1 text-2xs text-emerald-600 dark:text-emerald-400"
        data-testid="dkg-message-stored"
      >
        <Check className="h-3.5 w-3.5" />
        <span>Stored in channel memory</span>
      </div>
    );
  }
  if (status === "recording") {
    return (
      <div
        className="mt-1.5 flex items-center gap-1 text-2xs text-muted-foreground"
        data-testid="dkg-message-recording"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        <span>Recording to DKG…</span>
      </div>
    );
  }
  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 text-2xs text-amber-600 dark:text-amber-400"
      data-testid="dkg-message-failed"
    >
      {retryRequested ? (
        <BrainCircuit className="h-3.5 w-3.5" />
      ) : (
        <TriangleAlert className="h-3.5 w-3.5" />
      )}
      <span>
        {retryRequested ? "Memory retry requested" : "Memory was not stored"}
      </span>
      {!retryRequested ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-5 px-1.5 text-2xs"
          disabled={retrying}
          onClick={() => void retry()}
        >
          {retrying ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Retry
        </Button>
      ) : null}
    </div>
  );
}
