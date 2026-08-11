import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  getAgentObserverChannelSnapshot,
  injectObserverEventsForE2E,
  resetAgentObserverStore,
} from "./observerRelayStore.ts";

const AGENT = "a".repeat(64);
const OTHER_AGENT = "b".repeat(64);
const CHANNEL = "channel-one";

function observerEvent(seq, channelId) {
  return {
    seq,
    timestamp: `2026-08-11T08:00:${String(seq).padStart(2, "0")}.000Z`,
    kind: "acp_write",
    agentIndex: 0,
    channelId,
    sessionId: "session-one",
    turnId: `turn-${seq}`,
    payload: {},
  };
}

afterEach(() => resetAgentObserverStore());

test("scoped observer snapshots ignore unrelated agents and channels", () => {
  resetAgentObserverStore();
  const initial = getAgentObserverChannelSnapshot(CHANNEL, [AGENT]);

  injectObserverEventsForE2E(OTHER_AGENT, [observerEvent(1, CHANNEL)]);
  const afterOtherAgent = getAgentObserverChannelSnapshot(CHANNEL, [AGENT]);
  assert.strictEqual(afterOtherAgent, initial);

  injectObserverEventsForE2E(AGENT, [observerEvent(2, "channel-two")]);
  const afterOtherChannel = getAgentObserverChannelSnapshot(CHANNEL, [AGENT]);
  assert.strictEqual(afterOtherChannel, initial);

  injectObserverEventsForE2E(AGENT, [observerEvent(3, CHANNEL)]);
  const afterRelevantEvent = getAgentObserverChannelSnapshot(CHANNEL, [AGENT]);
  assert.notStrictEqual(afterRelevantEvent, initial);
  assert.equal(afterRelevantEvent.get(AGENT)?.events.length, 1);
});
