import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost",
});
const originalFetch = globalThis.fetch;
let queryClient;

function storedObserverEvent(channelId, messageId) {
  return {
    seq: 1,
    timestamp: "2026-08-11T08:00:00.000Z",
    kind: "acp_read",
    agentIndex: 0,
    channelId,
    sessionId: "session-one",
    turnId: "turn-one",
    payload: {
      method: "session/update",
      params: {
        sessionId: "session-one",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "memory-tool",
          status: "completed",
          title: "shell",
          kind: "shell",
          rawInput: {
            command: `buzz memory propose --source ${messageId}`,
          },
          rawOutput: '{"state":"stored"}',
        },
      },
    },
  };
}

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
      if (command === "get_identity") {
        return Promise.resolve({
          pubkey: "e".repeat(64),
          display_name: "Test owner",
        });
      }
      return Promise.resolve(null);
    },
  };
});

after(() => dom.window.close());
afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  queryClient?.clear();
  queryClient = undefined;
  const { resetAgentObserverStore } = await import(
    "@/features/agents/observerRelayStore"
  );
  resetAgentObserverStore();
  mock.restoreAll();
  globalThis.fetch = originalFetch;
});

test("a mounted channel retries capabilities, subscribes, and reveals observer memory", async () => {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { act, render, waitFor } = await import("@testing-library/react");
  const { useMessageMemoryStatusMap } = await import("./messageStatusMap.ts");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { injectObserverEventsForE2E, resetAgentObserverStore } = await import(
    "@/features/agents/observerRelayStore"
  );
  resetAgentObserverStore();
  let subscriptions = 0;
  mock.method(relayClient, "subscribeLive", async () => {
    subscriptions += 1;
    return async () => {};
  });
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

  function Harness() {
    const status = useMessageMemoryStatusMap(channelId, [message]).get(
      messageId,
    )?.status;
    return React.createElement(
      "span",
      { "data-testid": "memory" },
      status ?? "none",
    );
  }

  queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Harness),
    ),
  );
  assert.equal(view.getByTestId("memory").textContent, "none");
  await waitFor(() => assert.equal(subscriptions, 1), { timeout: 2_000 });
  await act(async () => {
    injectObserverEventsForE2E(pubkey, [
      storedObserverEvent(channelId, messageId),
    ]);
  });
  await waitFor(
    () => assert.equal(view.getByTestId("memory").textContent, "stored"),
    { timeout: 2_000 },
  );
  assert.equal(fetches, 2);
  assert.equal(subscriptions, 1);
});

test("a mounted non-DKG relay suppresses badges and observer subscription", async () => {
  const React = await import("react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { render, waitFor } = await import("@testing-library/react");
  const { useMessageMemoryStatusMap } = await import("./messageStatusMap.ts");
  const { relayClient } = await import("@/shared/api/relayClient");
  const { injectObserverEventsForE2E, resetAgentObserverStore } = await import(
    "@/features/agents/observerRelayStore"
  );
  resetAgentObserverStore();
  let subscriptions = 0;
  mock.method(relayClient, "subscribeLive", async () => {
    subscriptions += 1;
    return async () => {};
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ supported_extensions: [] }),
  });

  const channelId = "channel-without-dkg";
  const messageId = "d".repeat(64);
  const pubkey = "a".repeat(64);
  const message = {
    id: messageId,
    author: "Fizz",
    isAgent: true,
    signerPubkey: pubkey,
  };
  injectObserverEventsForE2E(pubkey, [
    storedObserverEvent(channelId, messageId),
  ]);

  function Harness() {
    const status = useMessageMemoryStatusMap(channelId, [message]).get(
      messageId,
    )?.status;
    return React.createElement(
      "span",
      { "data-testid": "memory" },
      status ?? "none",
    );
  }

  queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(Harness),
    ),
  );
  await waitFor(() =>
    assert.deepEqual(
      queryClient.getQueryData([
        "dkg-memory",
        "capabilities",
        "https://relay.example",
      ]),
      { memory: false, semanticQuery: false },
    ),
  );
  assert.equal(view.getByTestId("memory").textContent, "none");
  assert.equal(subscriptions, 0);
});
