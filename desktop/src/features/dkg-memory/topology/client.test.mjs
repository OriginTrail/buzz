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
      { kind: "subgraph", name: "decisions" },
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

test("channel topology fetches labels for bounded relationship endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const requests = [];
  globalThis.window = {
    ...(globalThis.window ?? {}),
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === "get_relay_http_url") return "https://relay.example";
        if (command === "sign_event") {
          return JSON.stringify({ kind: 27235, content: "", tags: args.tags });
        }
        throw new Error(`unexpected Tauri command: ${command}`);
      },
    },
  };
  globalThis.localStorage = { getItem: () => null };
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const sparql = request.arguments.sparql;
    let bindings;
    if (sparql.includes("VALUES ?subject")) {
      bindings = [
        {
          subject: "urn:memory:hello",
          predicate: "http://schema.org/name",
          object: '"Hello World memory"',
        },
        {
          subject: "urn:decision:responsive",
          predicate: "http://schema.org/name",
          object: '"Build a responsive page"',
        },
        {
          subject: "urn:component:page",
          predicate: "http://schema.org/name",
          object: '"Hello World page"',
        },
      ];
    } else if (sparql.includes("memory:contains")) {
      bindings = [
        {
          subject: "urn:memory:hello",
          predicate: "http://dkg.io/ontology/memory/contains",
          object: "urn:decision:responsive",
        },
      ];
    } else if (sparql.includes("decisions:affects")) {
      bindings = [
        {
          subject: "urn:decision:responsive",
          predicate: "http://dkg.io/ontology/decisions/affects",
          object: "urn:component:page",
        },
      ];
    } else {
      bindings = [
        {
          subject: "urn:decision:responsive",
          predicate: "http://www.w3.org/ns/prov#wasDerivedFrom",
          object: "urn:nostr:event:source",
        },
      ];
    }
    return new Response(
      JSON.stringify({
        ok: true,
        channelId: request.channelId,
        cg: "server-cg",
        operation: "semantic_query",
        result: {
          queryType: "select",
          scope: { type: "current_channel" },
          layers: [{ layer: "SWM", bindings }],
        },
      }),
    );
  };

  try {
    const result = await fetchTopologyTriples(
      "550e8400-e29b-41d4-a716-446655440000",
      null,
      { kind: "channel" },
    );
    assert.equal(result.gate, "ok");
    assert.equal(result.cg, "server-cg");
    assert.equal(requests.length, 4);
    assert.ok(
      requests.every((request) => request.operation === "semantic_query"),
    );
    assert.match(requests[0].arguments.sparql, /memory:contains/);
    assert.match(requests[1].arguments.sparql, /decisions:affects/);
    assert.match(requests[2].arguments.sparql, /prov:wasDerivedFrom/);
    const metadataQuery = requests.at(-1).arguments.sparql;
    assert.match(metadataQuery, /VALUES \?subject/);
    assert.match(metadataQuery, /<urn:memory:hello>/);
    assert.match(metadataQuery, /<urn:decision:responsive>/);
    assert.match(metadataQuery, /<urn:component:page>/);
    assert.match(metadataQuery, /<urn:nostr:event:source>/);
    assert.deepEqual(
      result.triples
        .filter((triple) => !triple.object.startsWith('"'))
        .map(({ subject, predicate, object }) => [subject, predicate, object]),
      [
        [
          "urn:memory:hello",
          "http://dkg.io/ontology/memory/contains",
          "urn:decision:responsive",
        ],
        [
          "urn:decision:responsive",
          "http://dkg.io/ontology/decisions/affects",
          "urn:component:page",
        ],
        [
          "urn:decision:responsive",
          "http://www.w3.org/ns/prov#wasDerivedFrom",
          "urn:nostr:event:source",
        ],
      ],
    );
  } finally {
    resetDkgMemoryProvider();
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
  }
});

test("channel topology retains successful slices and rejects when every relation slice fails", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  globalThis.window = {
    ...(globalThis.window ?? {}),
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        if (command === "get_relay_http_url") return "https://relay.example";
        if (command === "sign_event") {
          return JSON.stringify({ kind: 27235, content: "", tags: args.tags });
        }
        throw new Error(`unexpected Tauri command: ${command}`);
      },
    },
  };
  globalThis.localStorage = { getItem: () => null };

  const ok = (request, bindings) =>
    new Response(
      JSON.stringify({
        ok: true,
        channelId: request.channelId,
        cg: "server-cg",
        operation: "semantic_query",
        result: {
          queryType: "select",
          scope: { type: "current_channel" },
          layers: [{ layer: "SWM", bindings }],
        },
      }),
    );
  const busy = () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: { code: "upstream_busy", message: "Blazegraph is busy" },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );

  try {
    const partialRequests = [];
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      partialRequests.push(request);
      const sparql = request.arguments.sparql;
      if (partialRequests.length === 1) return busy();
      if (sparql.includes("decisions:affects")) {
        return ok(request, [
          {
            subject: "urn:decision:x402",
            predicate: "http://dkg.io/ontology/decisions/affects",
            object: "urn:component:payments",
          },
        ]);
      }
      if (sparql.includes("VALUES ?subject")) {
        return ok(request, [
          {
            subject: "urn:decision:x402",
            predicate: "http://schema.org/name",
            object: '"Adopt x402 payments"',
          },
        ]);
      }
      return ok(request, []);
    };

    const partial = await fetchTopologyTriples("partial-channel", null, {
      kind: "channel",
    });
    assert.equal(partial.gate, "ok");
    assert.equal(partialRequests.length, 4);
    assert.match(partialRequests.at(-1).arguments.sparql, /VALUES \?subject/);
    assert.ok(
      partial.triples.some(
        ({ predicate }) =>
          predicate === "http://dkg.io/ontology/decisions/affects",
      ),
    );

    resetDkgMemoryProvider();
    let failedRequests = 0;
    globalThis.fetch = async () => {
      failedRequests += 1;
      return busy();
    };
    await assert.rejects(
      fetchTopologyTriples("failed-channel", null, { kind: "channel" }),
      /Blazegraph is busy/,
    );
    assert.equal(failedRequests, 3);
  } finally {
    resetDkgMemoryProvider();
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
  }
});
