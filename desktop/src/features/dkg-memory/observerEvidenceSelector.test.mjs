import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  injectObserverEventsForE2E,
  resetAgentObserverStore,
} from "@/features/agents/observerRelayStore";
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
