import assert from "node:assert/strict";
import test from "node:test";
import proposalStates from "../../../../shared/dkg-memory/proposal-states.json" with {
  type: "json",
};
import { memoryStatusForMessage } from "./messageStatus.ts";
import {
  advertisesDkgMemory,
  advertisesDkgSemanticQuery,
  parseDkgMemoryCapabilities,
} from "./capabilities.ts";
import { buildMessageMemoryStatusMap } from "./messageStatusMap.ts";
import {
  memoryProposalProgress,
  normalizeMemoryProposalResponse,
} from "./proposalState.ts";

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

test("the map helper suppresses badges when its capability gate is closed", () => {
  const message = {
    id: MESSAGE,
    author: "Fizz",
    isAgent: true,
    signerPubkey: "f".repeat(64),
  };
  const statuses = buildMessageMemoryStatusMap(
    CHANNEL,
    [message],
    false,
    new Map(),
  );
  assert.equal(statuses.size, 0);
});

test("every shared beta processing phase remains an in-flight recording", () => {
  for (const state of proposalStates.processing) {
    assert.equal(memoryProposalProgress(state), "processing", state);
    assert.equal(
      memoryStatusForMessage(
        [tool({ result: JSON.stringify({ state }) })],
        CHANNEL,
        MESSAGE,
      ),
      "recording",
      state,
    );
  }
});

test("provisioning normalization preserves raw beta lifecycle phases", () => {
  for (const state of proposalStates.processing) {
    assert.deepEqual(normalizeMemoryProposalResponse({ state }, 202), {
      internalState: state === "processing" ? undefined : state,
      state: "processing",
    });
  }
  assert.deepEqual(
    normalizeMemoryProposalResponse(
      { state: "distilled", internalState: "relay-phase" },
      202,
    ),
    { internalState: "relay-phase", state: "processing" },
  );
});

test("the channel-level map derives each agent status from one shared pass", () => {
  const pubkey = "f".repeat(64);
  const transcript = [tool()];
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
    new Map([[pubkey, { transcript, completedTurnIds: new Set() }]]),
  );
  assert.deepEqual(statuses.get(MESSAGE), {
    agentName: "Fizz",
    agentPubkey: pubkey,
    status: "stored",
  });
  assert.strictEqual(transcript.length, 1);
});

test("relay discovery mirrors the ACP memory capability contract", () => {
  assert.equal(
    advertisesDkgMemory({ supported_extensions: ["buzz-dkg-memory-v2"] }),
    false,
  );
  assert.equal(
    advertisesDkgMemory({
      supported_extensions: ["buzz-dkg-memory-v2"],
      dkg_memory: {
        schema_versions: [2],
        profiles: ["dkg-memory@1"],
      },
    }),
    true,
  );
  assert.equal(
    advertisesDkgSemanticQuery({
      supported_extensions: ["buzz-dkg-memory-v2"],
      dkg_memory: {
        schema_versions: [2],
        profiles: ["dkg-memory@1"],
        query_operations: ["semantic_query"],
        semantic_query: {
          scopes: ["current_channel"],
          forms: ["select", "ask", "construct"],
        },
      },
    }),
    true,
  );
  assert.equal(
    advertisesDkgSemanticQuery({
      supported_extensions: ["buzz-dkg-memory-v2"],
      dkg_memory: {
        schema_versions: [2],
        profiles: ["dkg-memory@1"],
        query_operations: ["semantic_query"],
      },
    }),
    false,
  );
  assert.equal(
    advertisesDkgMemory({
      supported_extensions: ["buzz-dkg-memory-v1"],
    }),
    true,
  );
  assert.equal(advertisesDkgMemory({ supported_extensions: [] }), false);
  assert.equal(advertisesDkgMemory({}), false);

  assert.equal(
    parseDkgMemoryCapabilities({
      supported_extensions: ["buzz-dkg-memory-v2"],
      dkg_memory: {
        schema_versions: [2],
        profiles: ["dkg-memory@1", "dkg-trust@1"],
        query_operations: ["trust_network"],
      },
    }).trust,
    true,
  );
  assert.equal(
    parseDkgMemoryCapabilities({
      supported_extensions: ["buzz-dkg-memory-v2"],
      dkg_memory: {
        schema_versions: [2],
        profiles: ["dkg-memory@1", "dkg-trust@1"],
        query_operations: [],
      },
    }).trust,
    false,
  );
});
