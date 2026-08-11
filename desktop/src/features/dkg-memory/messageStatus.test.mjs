import assert from "node:assert/strict";
import test from "node:test";
import { memoryStatusForMessage } from "./messageStatus.ts";
import {
  advertisesDkgMemory,
  buildMessageMemoryStatusMap,
} from "./messageStatusMap.ts";

const CHANNEL = "channel-one";
const MESSAGE = "a".repeat(64);

function tool(overrides = {}) {
  return {
    id: "tool-1",
    type: "tool",
    renderClass: "shell",
    descriptor: { renderClass: "shell", label: "Shell", preview: null },
    title: "buzz memory propose",
    toolName: "shell",
    buzzToolName: null,
    status: "completed",
    args: { command: `buzz memory propose --source ${MESSAGE}` },
    result: '{"state":"stored"}',
    isError: false,
    timestamp: "2026-08-11T08:00:00Z",
    startedAt: "2026-08-11T08:00:00Z",
    completedAt: "2026-08-11T08:00:01Z",
    channelId: CHANNEL,
    turnId: "turn-one",
    sessionId: "session-one",
    ...overrides,
  };
}

test("message memory status requires explicit stored confirmation", () => {
  assert.equal(memoryStatusForMessage([tool()], CHANNEL, MESSAGE), "stored");
  assert.equal(
    memoryStatusForMessage(
      [tool({ result: '{"state":"processing"}' })],
      CHANNEL,
      MESSAGE,
    ),
    "recording",
  );
  assert.equal(
    memoryStatusForMessage([tool({ result: "accepted" })], CHANNEL, MESSAGE),
    "failed",
  );
  assert.equal(
    memoryStatusForMessage(
      [
        tool({
          result: JSON.stringify({
            stdout: JSON.stringify({ state: "receipted" }),
            stderr: "",
          }),
        }),
      ],
      CHANNEL,
      MESSAGE,
    ),
    "stored",
  );
});

test("message memory status exposes failed proposals and in-flight recording", () => {
  assert.equal(
    memoryStatusForMessage(
      [tool({ status: "failed", isError: true, result: "timeout" })],
      CHANNEL,
      MESSAGE,
    ),
    "failed",
  );
  assert.equal(
    memoryStatusForMessage(
      [tool({ status: "executing", result: "" })],
      CHANNEL,
      MESSAGE,
    ),
    "recording",
  );
});

test("published response is recording until its turn finishes without a proposal", () => {
  const publish = tool({
    title: "buzz messages send",
    args: { command: "buzz messages send --channel channel-one" },
    result: `{"event_id":"${MESSAGE}"}`,
  });
  assert.equal(
    memoryStatusForMessage([publish], CHANNEL, MESSAGE),
    "recording",
  );
  assert.equal(
    memoryStatusForMessage(
      [
        publish,
        {
          id: "done",
          type: "lifecycle",
          renderClass: "status",
          title: "Turn completed",
          text: "completed",
          timestamp: "2026-08-11T08:00:02Z",
          channelId: CHANNEL,
          turnId: "turn-one",
          sessionId: "session-one",
        },
      ],
      CHANNEL,
      MESSAGE,
    ),
    "failed",
  );
  assert.equal(
    memoryStatusForMessage([publish], CHANNEL, MESSAGE, new Set(["turn-one"])),
    "failed",
  );
});

test("display text and unrelated result IDs cannot impersonate structured telemetry", () => {
  const unrelated = "b".repeat(64);
  assert.equal(
    memoryStatusForMessage(
      [
        tool({
          title: `buzz memory propose --source ${MESSAGE}`,
          args: { command: `echo ${MESSAGE}` },
          result: `stored ${MESSAGE}`,
        }),
      ],
      CHANNEL,
      MESSAGE,
    ),
    null,
  );
  assert.equal(
    memoryStatusForMessage(
      [
        tool({
          args: { command: `buzz memory propose --source ${unrelated}` },
        }),
      ],
      CHANNEL,
      MESSAGE,
    ),
    null,
  );
  assert.equal(
    memoryStatusForMessage(
      [
        tool({
          args: { command: 'buzz memory propose --source "mock-event-id"' },
        }),
      ],
      CHANNEL,
      "mock-event-id",
    ),
    "stored",
  );
});

test("a non-DKG relay never marks ordinary agent messages as memory failures", () => {
  const message = {
    id: MESSAGE,
    author: "Fizz",
    isAgent: true,
    signerPubkey: "f".repeat(64),
  };
  const statuses = buildMessageMemoryStatusMap(CHANNEL, [message], false, {
    transcriptForAgent: () => [
      tool({
        title: "buzz messages send",
        args: { command: "buzz messages send --channel channel-one" },
        result: `{"event_id":"${MESSAGE}"}`,
      }),
    ],
    observerEventsForAgent: () => [
      {
        channelId: CHANNEL,
        turnId: "turn-one",
        kind: "turn_completed",
      },
    ],
  });
  assert.equal(statuses.size, 0);
});

test("the channel-level map derives each agent status from one shared pass", () => {
  const pubkey = "f".repeat(64);
  let transcriptReads = 0;
  const statuses = buildMessageMemoryStatusMap(
    CHANNEL,
    [
      {
        id: MESSAGE,
        author: "Fizz",
        isAgent: true,
        signerPubkey: pubkey,
      },
      {
        id: "b".repeat(64),
        author: "Fizz",
        isAgent: true,
        signerPubkey: pubkey,
      },
    ],
    true,
    {
      transcriptForAgent: () => {
        transcriptReads += 1;
        return [tool()];
      },
      observerEventsForAgent: () => [],
    },
  );
  assert.deepEqual(statuses.get(MESSAGE), {
    agentName: "Fizz",
    agentPubkey: pubkey,
    status: "stored",
  });
  assert.equal(transcriptReads, 1);
});

test("relay discovery explicitly gates DKG memory expectations", () => {
  assert.equal(
    advertisesDkgMemory({ supported_extensions: ["buzz-dkg-memory-v2"] }),
    true,
  );
  assert.equal(advertisesDkgMemory({ supported_extensions: [] }), false);
  assert.equal(advertisesDkgMemory({}), false);
});
