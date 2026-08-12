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
  threadHead: TimelineMessage | null,
  threadMessages: readonly TimelineMessage[],
): ReadonlyMap<string, React.ReactNode> {
  const allMessages = React.useMemo(() => {
    const byId = new Map<string, TimelineMessage>();
    for (const message of messages) byId.set(message.id, message);
    if (threadHead) byId.set(threadHead.id, threadHead);
    for (const message of threadMessages) byId.set(message.id, message);
    return [...byId.values()];
  }, [messages, threadHead, threadMessages]);
  const statuses = useMessageMemoryStatusMap(channelId, allMessages);

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
