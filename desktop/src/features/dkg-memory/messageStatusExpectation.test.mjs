import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});
const originalFetch = globalThis.fetch;

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command) {
      if (command === "get_relay_http_url") {
        return Promise.resolve("https://relay.example");
      }
      return Promise.resolve(null);
    },
  };
});

after(() => dom.window.close());
afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  const { resetDkgMemoryCapabilityCache } = await import("./capabilities.ts");
  cleanup();
  resetDkgMemoryCapabilityCache();
  globalThis.fetch = originalFetch;
});

test("a mounted channel retries capability discovery and reveals stored memory", async () => {
  const React = await import("react");
  const { render, waitFor } = await import("@testing-library/react");
  const { buildMessageMemoryStatusMap, useDkgMemoryExpectation } = await import(
    "./messageStatusMap.ts"
  );
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    if (fetches === 1) throw new Error("relay is starting");
    return {
      ok: true,
      json: async () => ({
        supported_extensions: ["buzz-dkg-memory-v2"],
        dkg_memory: {
          schema_versions: [2],
          profiles: ["dkg-memory@1"],
        },
      }),
    };
  };

  const channelId = "channel-one";
  const messageId = "c".repeat(64);
  const pubkey = "f".repeat(64);
  const message = {
    id: messageId,
    author: "Fizz",
    isAgent: true,
    signerPubkey: pubkey,
  };
  const evidence = new Map([
    [
      pubkey,
      {
        completedTurnIds: new Set(),
        transcript: [
          {
            id: "memory-tool",
            type: "tool",
            renderClass: "shell",
            descriptor: { renderClass: "shell", label: "Shell", preview: null },
            title: "buzz memory propose",
            toolName: "shell",
            buzzToolName: null,
            status: "completed",
            args: { command: `buzz memory propose --source ${messageId}` },
            result: '{"state":"stored"}',
            isError: false,
            timestamp: "2026-08-11T08:00:00Z",
            startedAt: "2026-08-11T08:00:00Z",
            completedAt: "2026-08-11T08:00:01Z",
            channelId,
            turnId: "turn-one",
            sessionId: "session-one",
          },
        ],
      },
    ],
  ]);

  function Harness() {
    const expected = useDkgMemoryExpectation(channelId);
    const status = buildMessageMemoryStatusMap(
      channelId,
      [message],
      expected,
      evidence,
    ).get(messageId)?.status;
    return React.createElement(
      "span",
      { "data-testid": "memory" },
      status ?? "none",
    );
  }

  const view = render(React.createElement(Harness));
  assert.equal(view.getByTestId("memory").textContent, "none");
  await waitFor(
    () => assert.equal(view.getByTestId("memory").textContent, "stored"),
    { timeout: 2_000 },
  );
  assert.equal(fetches, 2);
});
