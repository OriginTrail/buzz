import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, mock } from "node:test";

import { relayClient } from "@/shared/api/relayClient";
import {
  deriveContextGraphId,
  fetchChannelMemory,
  fetchDecisionTrace,
  fetchReputationSummary,
  fetchSemanticQuery,
  fetchSoftwareContributors,
  fetchTrustNetwork,
  publishTrustVouch,
} from "./api.ts";
import {
  DkgProviderError,
  explorerSource,
  queryDkgProvider,
  resetDkgMemoryProvider,
} from "./provider.ts";

const CHANNEL_ID = "550e8400-e29b-41d4-a716-446655440000";
const AUTH_EVENT = {
  id: "event-id",
  sig: "signature",
  pubkey: "a".repeat(64),
  kind: 27235,
  created_at: 1,
  tags: [],
  content: "",
};

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalLocalStorage = globalThis.localStorage;

function installTauri(
  relayHttpUrl = "https://relay.example/",
  signer = () => AUTH_EVENT,
) {
  const invocations = [];
  globalThis.window = {
    ...(globalThis.window ?? {}),
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        invocations.push({ command, args });
        if (command === "get_relay_http_url") return relayHttpUrl;
        if (command === "sign_event") return JSON.stringify(signer(args));
        throw new Error(`unexpected Tauri command: ${command}`);
      },
    },
  };
  return invocations;
}

afterEach(() => {
  mock.restoreAll();
  resetDkgMemoryProvider();
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.localStorage = originalLocalStorage;
});

test("channel graph binding requires the gateway unless explicitly overridden", async () => {
  globalThis.localStorage = {
    getItem: () => null,
  };
  assert.equal(await deriveContextGraphId(CHANNEL_ID), null);

  globalThis.localStorage = {
    getItem: (key) =>
      key === `dkg-memory-cg:${CHANNEL_ID}` ? "explicit-local-cg" : null,
  };
  assert.equal(await deriveContextGraphId(CHANNEL_ID), "explicit-local-cg");
});

test("community gateway uses active relay URL and a fresh payload-bound NIP-98 event", async () => {
  const invocations = installTauri();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:9295/")) {
      throw new TypeError("no local explorer");
    }
    requests.push({ url: target, init });
    const request = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        ok: true,
        channelId: request.channelId,
        cg: "server-cg",
        operation: request.operation,
        result: { layers: {}, decisions: [] },
      }),
    );
  };

  const firstResult = await fetchChannelMemory(
    CHANNEL_ID,
    "receipt-cg-must-not-be-sent",
  );
  const secondResult = await fetchChannelMemory(CHANNEL_ID, null);
  assert.equal(firstResult.cg, "server-cg");
  assert.equal(secondResult.gate, "ok");

  const gatewayRequests = requests.filter(
    ({ url }) => url === "https://relay.example/api/dkg/query",
  );
  assert.equal(gatewayRequests.length, 2);
  const signCalls = invocations.filter(
    ({ command }) => command === "sign_event",
  );
  assert.equal(signCalls.length, 2);

  const nonces = [];
  for (let index = 0; index < gatewayRequests.length; index += 1) {
    const { init } = gatewayRequests[index];
    assert.equal(init.method, "POST");
    const body = String(init.body);
    assert.deepEqual(JSON.parse(body), {
      channelId: CHANNEL_ID,
      operation: "channel_memory",
      arguments: {},
    });
    assert.equal(body.includes("receipt-cg"), false);

    const tags = signCalls[index].args.tags;
    assert.deepEqual(tags.slice(0, 3), [
      ["u", "https://relay.example/api/dkg/query"],
      ["method", "POST"],
      ["payload", createHash("sha256").update(body).digest("hex")],
    ]);
    assert.equal(tags[3][0], "nonce");
    assert.match(tags[3][1], /^[0-9a-f-]{36}$/i);
    nonces.push(tags[3][1]);

    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(
      init.headers.Authorization,
      `Nostr ${btoa(JSON.stringify(AUTH_EVENT))}`,
    );
  }
  assert.notEqual(nonces[0], nonces[1]);
});

test("semantic queries are explicitly current-channel scoped and expose their cost", async () => {
  installTauri();
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        ok: true,
        channelId: CHANNEL_ID,
        cg: "semantic-cg",
        operation: "semantic_query",
        result: {
          queryType: "select",
          scope: { type: "current_channel" },
          cost: { score: 3, budget: 40 },
          layers: [{ layer: "SWM", bindings: [] }],
        },
      }),
    );
  };

  const result = await fetchSemanticQuery(
    CHANNEL_ID,
    "SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 10",
  );
  assert.deepEqual(requestBody, {
    channelId: CHANNEL_ID,
    operation: "semantic_query",
    scope: { type: "current_channel" },
    arguments: {
      sparql: "SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 10",
      view: "both",
    },
  });
  assert.equal(result.cg, "semantic-cg");
  assert.equal(result.gate, "ok");
  assert.equal(result.cost.score, 3);
});

test("structured DKG errors retain a useful code and message", async () => {
  installTauri();
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "unknown_channel",
          message: "channel is not configured for DKG queries",
        },
      }),
      { status: 404 },
    );

  await assert.rejects(
    () => fetchChannelMemory(CHANNEL_ID, null),
    (error) => {
      assert.equal(error instanceof DkgProviderError, true);
      assert.equal(error.status, 404);
      assert.equal(error.code, "unknown_channel");
      assert.equal(error.message, "channel is not configured for DKG queries");
      return true;
    },
  );
});

test("provider falls back from local to community and reset re-probes local", async () => {
  const invocations = installTauri();
  globalThis.localStorage = {
    getItem: (key) =>
      key === "dkg-memory-explorer-url" ? "http://127.0.0.1:9395/" : null,
  };

  let localMode = "ok";
  let localProbes = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("cg=probe")) {
      localProbes += 1;
      return new Response(null, { status: 404 });
    }
    if (target.startsWith("http://127.0.0.1:9395/")) {
      if (localMode === "ok") {
        return new Response(JSON.stringify({ found: true, source: "local" }));
      }
      throw new TypeError("local explorer unavailable");
    }
    if (target === "https://relay.example/api/dkg/query") {
      return new Response(
        JSON.stringify({
          ok: true,
          channelId: CHANNEL_ID,
          cg: "server-cg",
          operation: "evidence",
          result: { found: true, source: "community" },
        }),
      );
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const query = {
    channelId: CHANNEL_ID,
    operation: "evidence",
    arguments: { uri: "urn:claim:1" },
    localPath: "/api/evidence?cg=receipt-cg&uri=urn%3Aclaim%3A1",
  };
  assert.deepEqual(await queryDkgProvider(query), {
    found: true,
    source: "local",
  });
  assert.equal(explorerSource(), "local");
  assert.equal(localProbes, 1);
  assert.equal(invocations.length, 0);

  localMode = "down";
  assert.deepEqual(await queryDkgProvider(query), {
    gate: "ok",
    found: true,
    source: "community",
  });
  assert.equal(explorerSource(), "gateway");
  assert.equal(
    localProbes,
    1,
    "cached local selection was reused before fallback",
  );

  localMode = "ok";
  resetDkgMemoryProvider();
  assert.equal(explorerSource(), null);
  await queryDkgProvider(query);
  assert.equal(
    localProbes,
    2,
    "community reset must re-probe the local provider",
  );
  assert.equal(explorerSource(), "local");
});

test("an explicit local gate failure falls through to the community gateway", async () => {
  const invocations = installTauri();
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("cg=probe")) {
      return new Response(null, { status: 404 });
    }
    if (target.startsWith("http://127.0.0.1:9295/")) {
      return new Response(JSON.stringify({ gate: "not-subscribed" }));
    }
    if (target === "https://relay.example/api/dkg/query") {
      return new Response(
        JSON.stringify({
          ok: true,
          channelId: CHANNEL_ID,
          cg: "server-cg",
          operation: "channel_memory",
          result: { decisions: [] },
        }),
      );
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const result = await fetchChannelMemory(CHANNEL_ID, "receipt-cg");
  assert.deepEqual(result, {
    gate: "ok",
    cg: "server-cg",
    decisions: [],
  });
  assert.equal(explorerSource(), "gateway");
  assert.equal(
    invocations.filter(({ command }) => command === "sign_event").length,
    1,
  );
});

test("community gateway rejects an envelope for another operation", async () => {
  installTauri();
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("http://127.0.0.1:9295/")) {
      throw new TypeError("no local explorer");
    }
    return new Response(
      JSON.stringify({
        ok: true,
        channelId: CHANNEL_ID,
        cg: "server-cg",
        operation: "subgraph_graph",
        result: {},
      }),
    );
  };

  await assert.rejects(
    queryDkgProvider({
      channelId: CHANNEL_ID,
      operation: "channel_memory",
      arguments: {},
      localPath: null,
    }),
    /operation does not match the request/,
  );
  assert.equal(explorerSource(), null);
});

test("software competency queries use only their fixed typed operations", async () => {
  installTauri();
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    return new Response(
      JSON.stringify({
        ok: true,
        channelId: body.channelId,
        cg: "server-cg",
        operation: body.operation,
        result:
          body.operation === "software_contributors"
            ? {
                repository: "https://github.com/acme/api",
                componentName: "verifyToken",
                componentType: "function",
                contributors: [],
              }
            : {
                repository: "https://github.com/acme/api",
                commitSha: "a1b2c3d4",
                componentName: "Authentication gateway",
                decisions: [],
              },
      }),
    );
  };

  await fetchSoftwareContributors(
    CHANNEL_ID,
    "https://github.com/acme/api",
    "verifyToken",
    "function",
  );
  await fetchDecisionTrace(
    CHANNEL_ID,
    "https://github.com/acme/api",
    "a1b2c3d4",
    "Authentication gateway",
  );
  assert.deepEqual(bodies, [
    {
      channelId: CHANNEL_ID,
      operation: "software_contributors",
      arguments: {
        repository: "https://github.com/acme/api",
        componentName: "verifyToken",
        componentType: "function",
      },
    },
    {
      channelId: CHANNEL_ID,
      operation: "decision_trace",
      arguments: {
        repository: "https://github.com/acme/api",
        commitSha: "a1b2c3d4",
        componentName: "Authentication gateway",
      },
    },
  ]);
  assert.equal(JSON.stringify(bodies).includes("sparql"), false);
});

test("web of trust uses a fixed channel-scoped operation, never client SPARQL", async () => {
  installTauri();
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        ok: true,
        channelId: body.channelId,
        cg: "server-cg",
        operation: body.operation,
        result: {
          completeness: "complete",
          people: [
            {
              pubkey: "b".repeat(64),
              contributions: 3,
              latest: 1_786_363_200,
              vouchesReceived: 1,
              vouchesGiven: 0,
              layer: "SWM",
            },
          ],
          vouches: [],
        },
      }),
    );
  };

  const result = await fetchTrustNetwork(CHANNEL_ID);
  assert.deepEqual(body, {
    channelId: CHANNEL_ID,
    operation: "trust_network",
    arguments: {},
  });
  assert.equal(JSON.stringify(body).includes("sparql"), false);
  assert.equal(result.gate, "ok");
  assert.equal(result.cg, "server-cg");
  assert.equal(result.people[0].contributions, 3);
});

test("reputation uses a fixed subject query and returns an explainable bounded score", async () => {
  installTauri();
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        ok: true,
        channelId: body.channelId,
        cg: "server-cg",
        operation: body.operation,
        result: {
          subject: "b".repeat(64),
          perspective: "a".repeat(64),
          context: "channel",
          completeness: "complete",
          score: 74,
          confidence: "high",
          breakdown: {
            directTrust: 100,
            networkTrust: 60,
            demonstratedWork: 50,
            evidenceDiversity: 92,
          },
          signals: {
            directVouch: true,
            twoHopVouchers: 1,
            independentVouchers: 3,
            evidenceRecords: 4,
            verifiableEvidence: false,
          },
          reasons: ["Three independent people signed vouches."],
          evidence: [],
          methodology: "dkg-reputation-v1",
        },
      }),
    );
  };

  const result = await fetchReputationSummary(CHANNEL_ID, "b".repeat(64));
  assert.deepEqual(body, {
    channelId: CHANNEL_ID,
    operation: "reputation_summary",
    arguments: { pubkey: "b".repeat(64) },
  });
  assert.equal(JSON.stringify(body).includes("sparql"), false);
  assert.equal(result.score, 74);
  assert.equal(result.methodology, "dkg-reputation-v1");
});

test("a vouch signs and publishes human evidence before proposing its DKG projection", async () => {
  const issuer = "a".repeat(64);
  const subject = "b".repeat(64);
  const signed = [];
  installTauri("https://relay.example/", (args) => {
    const event = {
      id: String(signed.length + 1).repeat(64),
      sig: "c".repeat(128),
      pubkey: issuer,
      kind: args.kind,
      created_at: 1_786_363_200 + signed.length,
      tags: args.tags,
      content: args.content,
    };
    signed.push(event);
    return event;
  });
  const published = [];
  mock.method(relayClient, "publishEvent", async (event) => {
    published.push(event);
  });
  let memoryRequest;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://relay.example/api/dkg/memory");
    memoryRequest = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({
        contextGraphId: "server-cg",
        operationId: 42,
        state: "stored",
      }),
    );
  };

  const result = await publishTrustVouch({
    channelId: CHANNEL_ID,
    subjectPubkey: subject,
    subjectName: "Alice",
    note: "  Caught a rollback edge case while reviewing two releases.  ",
  });

  assert.equal(result.eventId, "1".repeat(64));
  assert.equal(result.state, "stored");
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], signed[0]);
  assert.equal(signed[0].kind, 1985);
  assert.equal(
    signed[0].content,
    "Caught a rollback edge case while reviewing two releases.",
  );
  assert.deepEqual(signed[0].tags, [
    ["h", CHANNEL_ID],
    ["L", "buzz.wot"],
    ["l", "vouch", "buzz.wot"],
    ["p", subject],
  ]);

  assert.equal(memoryRequest.kind, 40009);
  assert.deepEqual(memoryRequest.tags, [
    ["h", CHANNEL_ID],
    ["t", "dkg-memory-proposal"],
    ["e", "1".repeat(64), "", "source"],
  ]);
  const proposal = JSON.parse(memoryRequest.content);
  assert.deepEqual(proposal.profiles, ["dkg-memory@1", "dkg-trust@1"]);
  assert.equal(proposal.entities[0].type, "trust:Vouch");
  assert.equal(proposal.entities[1].locator.uri, `urn:nostr:pubkey:${issuer}`);
  assert.equal(proposal.entities[2].locator.uri, `urn:nostr:pubkey:${subject}`);
  assert.deepEqual(proposal.relations, [
    { subject: "vouch", predicate: "trust:issuer", object: "issuer" },
    { subject: "vouch", predicate: "trust:subject", object: "subject" },
  ]);
  assert.equal(signed.at(-1).kind, 27235);
});
