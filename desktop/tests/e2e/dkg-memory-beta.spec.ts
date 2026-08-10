import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";

const CG = "buzz-test-channel";
const AGENT_PUBKEY = "f".repeat(64);
const AGENT_MESSAGE_ID = `mock-agents-managed-${AGENT_PUBKEY.slice(0, 8)}`;
const AGENTS_CHANNEL_ID = "94a444a4-c0a3-5966-ab05-530c6ddc2301";

test("channel memory exposes graph and authenticated search without named subgraphs", async ({
  page,
}) => {
  await page.route("http://localhost:3000/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/nostr+json",
      body: JSON.stringify({
        supported_extensions: ["buzz-dkg-memory-v2"],
        dkg_memory: { query_operations: ["channel_memory", "semantic_query"] },
      }),
    });
  });
  await page.route("**/api/dkg/query", async (route) => {
    const request = route.request().postDataJSON() as {
      channelId: string;
      operation: string;
      arguments: { sparql?: string };
    };
    let result: unknown;
    if (request.operation === "channel_memory") {
      result = {
        layers: {
          WM: null,
          SWM: [{ graph: "urn:graph:shared", label: "Shared memory" }],
          VM: [],
          SWMCount: 1,
          VMCount: 0,
        },
        decisions: [
          {
            uri: "urn:decision:query-proxy",
            name: "Use an authenticated relay query proxy",
            digest: "a".repeat(64),
            at: "2026-08-10T12:00:00Z",
          },
        ],
        contributors: [
          { pubkey: "deadbeef".repeat(8), events: 4, latest: 1_786_363_200 },
        ],
        subgraphs: [],
      };
    } else if (request.operation === "semantic_query") {
      const graphQuery = request.arguments.sparql?.includes(
        "?subject ?predicate ?object",
      );
      result = {
        queryType: "select",
        scope: { type: "current_channel" },
        cost: { score: 6, budget: 40 },
        layers: [
          {
            layer: "SWM",
            bindings: graphQuery
              ? [
                  {
                    subject: "urn:decision:query-proxy",
                    predicate:
                      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
                    object: "http://dkg.io/ontology/decisions/Decision",
                  },
                  {
                    subject: "urn:decision:query-proxy",
                    predicate: "http://schema.org/name",
                    object: '"Use an authenticated relay query proxy"',
                  },
                  {
                    subject: "urn:decision:query-proxy",
                    predicate: "http://dkg.io/ontology/decisions/affects",
                    object: "urn:component:memory-panel",
                  },
                  {
                    subject: "urn:component:memory-panel",
                    predicate: "http://schema.org/name",
                    object: '"Buzz memory panel"',
                  },
                ]
              : [
                  {
                    entity: "urn:decision:query-proxy",
                    name: '"Use an authenticated relay query proxy"',
                    description:
                      '"Let authenticated Buzz members search their channel graph."',
                    type: "http://dkg.io/ontology/decisions/Decision",
                  },
                ],
          },
        ],
      };
    } else {
      result = {};
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        channelId: request.channelId,
        cg: CG,
        operation: request.operation,
        result,
      }),
    });
  });

  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-engineering").click();
  await page.getByTestId("dkg-memory-toggle").click();

  const panel = page.getByTestId("dkg-memory-panel");
  await expect(
    panel.getByRole("heading", { name: "Channel memory" }),
  ).toBeVisible();
  await expect(panel.getByTestId("dkg-channel-graph")).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByText(/0 named topics/i)).toBeVisible();

  await panel.getByTestId("dkg-diagnostics-toggle").click();
  await panel.getByRole("button", { name: "Run check" }).click();
  await expect(panel.getByText("Relay capability")).toBeVisible();
  await expect(panel.getByText("Buzz identity", { exact: true })).toBeVisible();
  await expect(panel.getByText("Channel Context Graph")).toBeVisible();
  await expect(panel.getByText("Semantic query")).toBeVisible();
  await expect(panel.getByText(/weight 6\/40/i)).toBeVisible();
  await panel.screenshot({
    path: "test-results/dkg-memory-beta/panel-overview.png",
  });

  await panel.getByRole("tab", { name: "Search graph" }).click();
  await panel.getByPlaceholder("x402, Alice, verifyToken…").fill("query proxy");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    panel.getByText("Use an authenticated relay query proxy"),
  ).toBeVisible();
  await expect(panel.getByText("Query weight 6/40")).toBeVisible();
  await panel.screenshot({
    path: "test-results/dkg-memory-beta/panel-search.png",
  });

  await panel.getByTestId("dkg-channel-graph").click();
  const overlay = page.getByTestId("dkg-graph-overlay");
  await expect(overlay.getByText("Channel knowledge graph")).toBeVisible();
  await expect(
    overlay.getByRole("button", { name: "Entity types" }),
  ).toBeVisible();
  await expect(overlay.locator("canvas").first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    overlay.getByRole("button", { name: "Contributors" }),
  ).toHaveCount(0);
  await page.waitForTimeout(700);
  await overlay.screenshot({
    path: "test-results/dkg-memory-beta/channel-graph.png",
  });
});

test("a channel member can provision memory from the panel with visible provenance", async ({
  page,
}) => {
  let provisioned = false;
  let proposalCalls = 0;
  let proposal: { kind?: number; tags?: string[][]; content?: string } | null =
    null;
  await page.route("**/api/dkg/query", async (route) => {
    const request = route.request().postDataJSON() as {
      channelId: string;
      operation: string;
    };
    if (!provisioned) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: {
            code: "unknown_channel",
            message: "channel is not configured for DKG queries",
          },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        channelId: request.channelId,
        cg: CG,
        operation: request.operation,
        result: {
          layers: { WM: null, SWM: [], VM: [] },
          decisions: [],
          contributors: [],
          subgraphs: [],
        },
      }),
    });
  });
  await page.route("**/api/dkg/memory", async (route) => {
    proposal = route.request().postDataJSON() as typeof proposal;
    proposalCalls += 1;
    provisioned = proposalCalls >= 2;
    await route.fulfill({
      status: provisioned ? 200 : 202,
      contentType: "application/json",
      body: JSON.stringify({
        contextGraphId: CG,
        operationId: 42,
        state: provisioned ? "stored" : "processing",
      }),
    });
  });

  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-engineering").click();
  await page.getByTestId("dkg-memory-toggle").click();

  const panel = page.getByTestId("dkg-memory-panel");
  const enable = panel.getByTestId("dkg-memory-enable");
  await expect(enable).toBeVisible({ timeout: 10_000 });
  await enable.click();
  await expect(
    panel.getByText("Preparing this channel’s Context Graph…"),
  ).toBeVisible();
  await expect(panel.getByTestId("dkg-channel-graph")).toBeVisible({
    timeout: 10_000,
  });
  expect(proposalCalls).toBe(2);

  expect(proposal?.kind).toBe(40009);
  expect(proposal?.tags).toEqual(
    expect.arrayContaining([
      expect.arrayContaining(["t", "dkg-memory-proposal"]),
      expect.arrayContaining(["e", expect.any(String), "", "source"]),
    ]),
  );
  expect(JSON.parse(proposal?.content ?? "{}")).toMatchObject({
    schemaVersion: 2,
    profiles: ["dkg-memory@1"],
    promptVersion: "channel-memory-enable-v1",
  });
});

test("an agent response shows when its memory is stored", async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: AGENT_PUBKEY,
        name: "Fizz",
        status: "running",
        channelNames: ["agents"],
      },
    ],
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
  );
  await page.getByTestId("channel-agents").click();
  await expect(page.getByText("Fizz reporting in.")).toBeVisible();

  await page.evaluate(
    ({ agentPubkey, channelId, messageId }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events: [
          {
            seq: 1,
            timestamp: "2026-08-11T10:00:00Z",
            kind: "acp_read",
            agentIndex: 0,
            channelId,
            sessionId: "session-memory-status",
            turnId: "turn-memory-status",
            payload: {
              method: "session/update",
              params: {
                sessionId: "session-memory-status",
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "memory-proposal",
                  status: "completed",
                  title: "shell",
                  kind: "shell",
                  rawInput: {
                    command: `buzz memory propose --source ${messageId}`,
                  },
                  rawOutput: JSON.stringify({ state: "stored" }),
                },
              },
            },
          },
        ],
      });
    },
    {
      agentPubkey: AGENT_PUBKEY,
      channelId: AGENTS_CHANNEL_ID,
      messageId: AGENT_MESSAGE_ID,
    },
  );

  const fizzMessage = page
    .getByTestId("message-row")
    .filter({ hasText: "Fizz reporting in." });
  await expect(fizzMessage.getByTestId("dkg-message-stored")).toHaveText(
    "Stored in channel memory",
  );
  await fizzMessage.screenshot({
    path: "test-results/dkg-memory-beta/message-stored.png",
  });
});
