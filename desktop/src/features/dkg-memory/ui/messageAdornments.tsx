import * as React from "react";

import type { TimelineMessage } from "@/features/messages/types";
import { useMessageMemoryStatusMap } from "../messageStatusMap";
import { MessageMemoryStatus } from "./MessageMemoryStatus";

/**
 * Build DKG-owned message adornments at the channel boundary. The generic
 * message renderer receives only opaque React nodes and remains unaware of
 * memory status types or behavior.
 */
export function useDkgMemoryMessageAdornments(
  channelId: string | null,
  messages: readonly TimelineMessage[],
): ReadonlyMap<string, React.ReactNode> {
  const statuses = useMessageMemoryStatusMap(channelId, messages);

  return React.useMemo(() => {
    const result = new Map<string, React.ReactNode>();
    if (!channelId) return result;
    for (const [messageId, status] of statuses) {
      result.set(
        messageId,
        <MessageMemoryStatus
          agentName={status.agentName}
          agentPubkey={status.agentPubkey}
          channelId={channelId}
          messageId={messageId}
          status={status.status}
        />,
      );
    }
    return result;
  }, [channelId, statuses]);
}
