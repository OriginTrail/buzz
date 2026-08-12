import assert from "node:assert/strict";
import test from "node:test";

import {
  isDkgMemoryDockOpen,
  resetDkgMemoryDockState,
  toggleDkgMemoryDock,
} from "./memoryDockStore.ts";

test.afterEach(resetDkgMemoryDockState);

test("dock ownership follows one channel and resets at the community boundary", () => {
  assert.equal(isDkgMemoryDockOpen("channel-a"), false);
  toggleDkgMemoryDock("channel-a");
  assert.equal(isDkgMemoryDockOpen("channel-a"), true);
  assert.equal(isDkgMemoryDockOpen("channel-b"), false);

  toggleDkgMemoryDock("channel-b");
  assert.equal(isDkgMemoryDockOpen("channel-a"), false);
  assert.equal(isDkgMemoryDockOpen("channel-b"), true);

  resetDkgMemoryDockState();
  assert.equal(isDkgMemoryDockOpen("channel-b"), false);
});
