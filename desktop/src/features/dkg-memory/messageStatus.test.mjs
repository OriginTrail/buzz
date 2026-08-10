import assert from "node:assert/strict";
import test from "node:test";
import { memoryStatusForMessage } from "./messageStatus.ts";

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
