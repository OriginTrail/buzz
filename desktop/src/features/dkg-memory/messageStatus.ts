import type { TranscriptItem } from "@/features/agents/ui/agentSessionTypes";

export type MessageMemoryStatus = "recording" | "stored" | "failed";

function toolText(item: Extract<TranscriptItem, { type: "tool" }>): string {
  return [
    item.title,
    item.toolName,
    item.buzzToolName,
    JSON.stringify(item.args),
    item.result,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function isMemoryProposal(text: string): boolean {
  return /(?:buzz\s+)?memory\s+propose/.test(text);
}

function isMessagePublish(text: string): boolean {
  return /(?:buzz\s+)?messages?\s+send/.test(text);
}

/**
 * Derive graph-write status from authenticated ACP telemetry. The proposal is
 * linked to the visible response by its required `--source <event-id>`; a
 * successful tool call is only "stored" when the integration explicitly says
 * the graph is queryable.
 */
export function memoryStatusForMessage(
  items: readonly TranscriptItem[],
  channelId: string,
  messageId: string,
  completedTurnIds: ReadonlySet<string> = new Set(),
): MessageMemoryStatus | null {
  const normalizedId = messageId.toLowerCase();
  const channelItems = items.filter((item) => item.channelId === channelId);
  const memoryTool = [...channelItems]
    .reverse()
    .find(
      (item): item is Extract<TranscriptItem, { type: "tool" }> =>
        item.type === "tool" &&
        isMemoryProposal(toolText(item)) &&
        toolText(item).includes(normalizedId),
    );
  if (memoryTool) {
    const text = toolText(memoryTool);
    const normalizedResult = text.replaceAll("\\", "");
    if (memoryTool.isError || memoryTool.status === "failed") return "failed";
    if (memoryTool.status === "executing" || memoryTool.status === "pending") {
      return "recording";
    }
    if (/"state"\s*:\s*"(?:stored|receipted)"/.test(normalizedResult)) {
      return "stored";
    }
    if (/"state"\s*:\s*"processing"/.test(normalizedResult)) {
      return "recording";
    }
    return "failed";
  }

  const publishTool = [...channelItems]
    .reverse()
    .find(
      (item): item is Extract<TranscriptItem, { type: "tool" }> =>
        item.type === "tool" &&
        isMessagePublish(toolText(item)) &&
        toolText(item).includes(normalizedId),
    );
  if (!publishTool?.turnId) return null;
  const turnFinished =
    channelItems.some(
      (item) =>
        item.turnId === publishTool.turnId &&
        item.type === "lifecycle" &&
        /completed|failed|cancelled|timed out|error/i.test(
          `${item.title} ${item.text}`,
        ),
    ) || completedTurnIds.has(publishTool.turnId);
  return turnFinished ? "failed" : "recording";
}
