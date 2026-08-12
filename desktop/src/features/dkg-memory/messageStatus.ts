import type { TranscriptItem } from "@/features/agents/ui/agentSessionTypes";
import {
  asRecord,
  parseToolResultValue,
} from "@/features/agents/ui/agentSessionUtils";
import { memoryProposalProgress } from "./proposalState";

export type MessageMemoryStatus = "recording" | "stored" | "failed";

type ToolItem = Extract<TranscriptItem, { type: "tool" }>;

function commandFor(item: ToolItem): string | null {
  const command = item.args.command;
  return typeof command === "string" ? command.trim() : null;
}

function operationFor(item: ToolItem): string {
  return `${item.buzzToolName ?? ""} ${item.descriptor.operation ?? ""}`
    .trim()
    .toLowerCase();
}

function isMemoryProposal(item: ToolItem): boolean {
  const command = commandFor(item);
  return command
    ? /(?:^|\s)(?:buzz\s+)?memory\s+propose(?:\s|$)/i.test(command)
    : /memory[_\s-]+propose/.test(operationFor(item));
}

function isMessagePublish(item: ToolItem): boolean {
  const command = commandFor(item);
  return command
    ? /(?:^|\s)(?:buzz\s+)?messages?\s+send(?:\s|$)/i.test(command)
    : /messages?[_\s-]+send/.test(operationFor(item));
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function proposalSources(item: ToolItem): Set<string> {
  const sources = new Set<string>();
  for (const value of [item.args.source, item.args.sources]) {
    for (const source of stringList(value)) sources.add(source.toLowerCase());
  }
  const command = commandFor(item);
  if (!command) return sources;
  const sourcePattern =
    /(?:^|\s)--source(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi;
  for (const match of command.matchAll(sourcePattern)) {
    const source = match[1] ?? match[2] ?? match[3];
    if (source) sources.add(source.toLowerCase());
  }
  return sources;
}

function parsedResultRecord(item: ToolItem): Record<string, unknown> {
  const record = asRecord(parseToolResultValue(item.result));
  const stdout = record.stdout;
  if (typeof stdout === "string") {
    const nested = asRecord(parseToolResultValue(stdout));
    if (Object.keys(nested).length > 0) return nested;
  }
  return record;
}

function publishedEventId(item: ToolItem): string | null {
  const result = parsedResultRecord(item);
  for (const key of ["event_id", "eventId", "id"]) {
    const value = result[key];
    if (typeof value === "string") return value.toLowerCase();
  }
  return null;
}

/**
 * Derive graph-write status from authenticated ACP telemetry. Commands,
 * evidence IDs, and proposal state are read from their structured fields;
 * display labels never participate in the status contract.
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
      (item): item is ToolItem =>
        item.type === "tool" &&
        isMemoryProposal(item) &&
        proposalSources(item).has(normalizedId),
    );
  if (memoryTool) {
    if (memoryTool.isError || memoryTool.status === "failed") return "failed";
    if (memoryTool.status === "executing" || memoryTool.status === "pending") {
      return "recording";
    }
    const progress = memoryProposalProgress(
      parsedResultRecord(memoryTool).state,
    );
    if (progress === "stored") return "stored";
    if (progress === "processing") return "recording";
    return "failed";
  }

  const publishTool = [...channelItems]
    .reverse()
    .find(
      (item): item is ToolItem =>
        item.type === "tool" &&
        isMessagePublish(item) &&
        publishedEventId(item) === normalizedId,
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
