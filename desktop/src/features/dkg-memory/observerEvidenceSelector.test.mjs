import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  injectObserverEventsForE2E,
  resetAgentObserverStore,
} from "@/features/agents/observerRelayStore";
import { buildMessageMemoryStatusMap } from "./messageStatusMap.ts";
import { createChannelMemoryEvidenceSelector } from "./observerEvidenceSelector.ts";

const AGENT = "a".repeat(64);
const OTHER_AGENT = "b".repeat(64);
const CHANNEL = "channel-one";

function toolEvent(seq, channelId) {
  return {
    seq,
    timestamp: `2026-08-11T08:00:${String(seq).padStart(2, "0")}.000Z`,
    kind: "acp_read",
    agentIndex: 0,
    channelId,
    sessionId: "session-one",
    turnId: `turn-${seq}`,
    payload: {
      method: "session/update",
      params: {
        sessionId: "session-one",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: `memory-${seq}`,
          status: "completed",
          title: "shell",
          kind: "shell",
          rawInput: {
            command: `buzz memory propose --source ${"c".repeat(64)}`,
          },
          rawOutput: JSON.stringify({ state: "stored" }),
        },
      },
    },
  };
}

function publishEvent(seq, channelId, messageId, turnId) {
  const event = toolEvent(seq, channelId);
  event.turnId = turnId;
  event.payload.params.update.toolCallId = `publish-${seq}`;
  event.payload.params.update.rawInput = {
    command: `buzz messages send --channel ${channelId}`,
  };
  event.payload.params.update.rawOutput = JSON.stringify({
    event_id: messageId,
  });
  return event;
}

function lifecycleEvent(seq, channelId, turnId) {
  return {
    seq,
    timestamp: `2026-08-11T08:01:${String(seq).padStart(2, "0")}.000Z`,
    kind: "turn_completed",
    agentIndex: 0,
    channelId,
    sessionId: "session-one",
    turnId,
    payload: {},
  };
}

afterEach(() => resetAgentObserverStore());

test("channel memory evidence ignores unrelated agents and transcript entries", () => {
  resetAgentObserverStore();
  const readEvidence = createChannelMemoryEvidenceSelector(CHANNEL, [AGENT]);
  const initial = readEvidence();

  injectObserverEventsForE2E(OTHER_AGENT, [toolEvent(1, CHANNEL)]);
  assert.strictEqual(readEvidence(), initial);

  injectObserverEventsForE2E(AGENT, [toolEvent(2, "channel-two")]);
  const afterOtherChannel = readEvidence();
  assert.strictEqual(afterOtherChannel, initial);
  assert.equal(afterOtherChannel.get(AGENT)?.transcript.length, 0);

  injectObserverEventsForE2E(AGENT, [toolEvent(3, CHANNEL)]);
  const afterRelevantTranscript = readEvidence();
  assert.notStrictEqual(afterRelevantTranscript, initial);
  assert.equal(afterRelevantTranscript.get(AGENT)?.transcript.length, 1);
});

test("completed turns move an unproposed published message from recording to failed", () => {
  const messageId = "d".repeat(64);
  const turnId = "turn-publish";
  const message = {
    id: messageId,
    author: "Fizz",
    isAgent: true,
    signerPubkey: AGENT,
  };
  const readEvidence = createChannelMemoryEvidenceSelector(CHANNEL, [AGENT]);

  injectObserverEventsForE2E(AGENT, [
    publishEvent(4, CHANNEL, messageId, turnId),
  ]);
  const recordingEvidence = readEvidence();
  assert.equal(
    buildMessageMemoryStatusMap(
      CHANNEL,
      [message],
      true,
      recordingEvidence,
    ).get(messageId)?.status,
    "recording",
  );

  injectObserverEventsForE2E(AGENT, [lifecycleEvent(5, CHANNEL, turnId)]);
  const completedEvidence = readEvidence();
  assert.equal(
    completedEvidence.get(AGENT)?.completedTurnIds.has(turnId),
    true,
  );
  assert.equal(
    buildMessageMemoryStatusMap(
      CHANNEL,
      [message],
      true,
      completedEvidence,
    ).get(messageId)?.status,
    "failed",
  );
});
