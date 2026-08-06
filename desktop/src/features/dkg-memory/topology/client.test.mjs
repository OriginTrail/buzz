import assert from "node:assert/strict";
import test from "node:test";

import { resetDkgMemoryProvider } from "../provider.ts";
import { fetchTopologyTriples } from "./client.ts";

test("topology falls back to the authenticated channel-scoped gateway operation", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const invocations = [];
  const requests = [];
  globalThis.window = {
    ...(globalThis.window ?? {}),
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        invocations.push({ command, args });
        if (command === "get_relay_http_url") return "https://relay.example";
        if (command === "sign_event") {
          return JSON.stringify({ kind: 27235, content: "", tags: args.tags });
        }
        throw new Error(`unexpected Tauri command: ${command}`);
      },
    },
  };
  globalThis.localStorage = { getItem: () => null };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:9295/")) {
      throw new TypeError("no local explorer");
    }
    requests.push({ url: target, init });
    return new Response(
      JSON.stringify({
        ok: true,
        channelId: "550e8400-e29b-41d4-a716-446655440000",
        cg: "server-cg",
        operation: "subgraph_triples",
        result: { subgraph: "decisions", triples: [] },
      }),
    );
  };

  try {
    const result = await fetchTopologyTriples(
      "550e8400-e29b-41d4-a716-446655440000",
      "receipt-cg",
      "decisions",
    );
    assert.equal(result.gate, "ok");
    assert.equal(result.cg, "server-cg");
    assert.equal(requests[0].url, "https://relay.example/api/dkg/query");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      channelId: "550e8400-e29b-41d4-a716-446655440000",
      operation: "subgraph_triples",
      arguments: { name: "decisions" },
    });
    assert.equal(requests[0].init.body.includes("receipt-cg"), false);
    assert.equal(
      invocations.filter(({ command }) => command === "sign_event").length,
      1,
    );
    assert.match(requests[0].init.headers.Authorization, /^Nostr /);
  } finally {
    resetDkgMemoryProvider();
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
  }
});
