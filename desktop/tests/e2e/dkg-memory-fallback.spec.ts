import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { waitForMockLiveSubscription } from "../helpers/subscriptions";

const CHANNEL = "engineering";
const CG = "buzz-e2e-flat-capture-fixture";

const FLAT_MEMORY = {
  gate: "ok",
  cg: CG,
  layers: { WM: [], SWM: [{ graph: "g1", label: "g1" }], VM: [], SWMCount: 3 },
  decisions: [
    {
      uri: `did:dkg:context-graph:${CG}/assertion/0xabc/buzz-dkg-1`,
      name: "DECISION: adopt NIP-42 for WebSockets and NIP-98 for HTTP.",
      digest: "sha256:aaaa",
      at: "2026-08-10T12:00:00Z",
    },
    {
      uri: `did:dkg:context-graph:${CG}/assertion/0xabc/buzz-dkg-2`,
      name: "DECISION: community provider is the default read path.",
      digest: "sha256:bbbb",
      at: "2026-08-10T13:00:00Z",
    },
    {
      uri: `did:dkg:context-graph:${CG}/assertion/0xabc/buzz-dkg-3`,
      name: "DECISION: flat capture ships in beta.3.",
      digest: "sha256:cccc",
      at: "2026-08-10T14:00:00Z",
    },
  ],
  contributors: [],
  subgraphs: [],
};

async function openMemoryPanel(
  page: import("@playwright/test").Page,
  namedTopicCount = 0,
) {
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-engineering").click();
  await waitForMockLiveSubscription(page, CHANNEL);
  await page.getByTestId("dkg-memory-toggle").click();
  const panel = page.getByTestId("dkg-memory-panel");
  await expect(
    panel.getByText(
      new RegExp(`3 decisions · ${namedTopicCount} named topics`, "i"),
    ),
  ).toBeVisible({ timeout: 20_000 });
  return panel;
}

async function expectPaintedGraphCanvas(
  overlay: import("@playwright/test").Locator,
) {
  const canvas = overlay.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        canvas.evaluate((node) => {
          const element = node as HTMLCanvasElement;
          const context = element.getContext("2d", {
            willReadFrequently: true,
          });
          if (!context || element.width === 0 || element.height === 0) return 0;
          const pixels = context.getImageData(
            0,
            0,
            element.width,
            element.height,
          ).data;
          let painted = 0;
          for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] > 0) painted += 1;
            if (painted >= 10) break;
          }
          return painted;
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(10);
}

test("flat capture: All-decisions lens resolves evidence into Traces and Graph", async ({
  page,
}) => {
  const subgraphRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/subgraph-graph") {
      subgraphRequests.push(request.url());
    }
  });
  await page.addInitScript((cg) => {
    window.localStorage.setItem("dkg-memory-cg-override", cg);
  }, CG);
  await page.route("http://127.0.0.1:9295/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/channel-memory")) {
      return route.fulfill({ json: FLAT_MEMORY });
    }
    if (url.includes("/api/evidence")) {
      const uri = new URL(url).searchParams.get("uri") ?? "";
      if (uri !== FLAT_MEMORY.decisions[0].uri) {
        return route.fulfill({ json: { gate: "ok", found: false } });
      }
      return route.fulfill({
        json: {
          gate: "ok",
          found: true,
          claimId: uri,
          name: FLAT_MEMORY.decisions[0].name,
          memoryLayer: "SWM",
          attribution: ["c9f4f94b"],
          sources: [
            {
              id: "urn:nostr:event:e1",
              span: "which auth methods should the service support?",
              author: "c9f4f94b",
              at: 1_786_363_100,
            },
            {
              id: "urn:nostr:event:e2",
              span: "NIP-42 plus NIP-98 covers both transports.",
              author: "c9f4f94b",
              at: 1_786_363_150,
            },
          ],
          relations: [],
        },
      });
    }
    return route.fulfill({ json: { gate: "ok" } });
  });
  const panel = await openMemoryPanel(page);

  const lens = panel.getByTestId("dkg-subgraph-all-decisions");
  await expect(lens).toBeVisible();
  await lens.click();

  const overlay = page.getByTestId("dkg-graph-overlay");
  await expect(overlay.getByText("All decisions")).toBeVisible();
  // Envelope fan-out enriches the bare decision list: two ⊕ sources land.
  await expect(overlay.getByText("3 decisions · 2 evidence")).toBeVisible({
    timeout: 15_000,
  });
  await expect(overlay.getByTestId("traces-card")).toHaveCount(3);
  await expect(
    overlay.getByRole("region", { name: "Decision traces timeline" }),
  ).toBeVisible();
  const enriched = overlay
    .getByTestId("traces-card")
    .filter({ hasText: "adopt NIP-42 for WebSockets" })
    .first();
  await expect(enriched).toBeVisible();
  await expect(enriched.getByText("⊕ 2")).toBeVisible();
  // Selecting the decision surfaces its provenance in the evidence rail.
  await enriched.getByText(/adopt NIP-42 for WebSockets/).click();
  const rail = overlay.locator("aside");
  await expect(rail.getByText("Evidence trail")).toBeVisible();
  await expect(
    rail.getByText("NIP-42 plus NIP-98 covers both transports."),
  ).toBeVisible();
  // The lens has a real Graph mode now, still with zero subgraph queries.
  await overlay.getByTestId("dkg-topology-toggle").click();
  await expect(
    overlay.getByText(/5 entities · 2 relationships/i),
  ).toBeVisible();
  await expectPaintedGraphCanvas(overlay);
  await expect(
    overlay.getByRole("button", { name: "Zoom graph in" }),
  ).toBeVisible();
  await expect(
    overlay.getByRole("button", { name: "Zoom graph out" }),
  ).toBeVisible();
  await expect(
    overlay.getByRole("button", { name: "Fit graph to view" }),
  ).toBeVisible();
  expect(subgraphRequests).toEqual([]);
  await waitForAnimations(page);
});

test("contributor chip opens that participant's Traces lens", async ({
  page,
}) => {
  await page.addInitScript((cg) => {
    window.localStorage.setItem("dkg-memory-cg-override", cg);
  }, CG);
  const pubkey = "c9f4f94b87273745cc34b9d8b15847b27afb90eb9bb7c8a4363703821a0";
  await page.route("http://127.0.0.1:9295/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/channel-memory")) {
      return route.fulfill({
        json: {
          ...FLAT_MEMORY,
          contributors: [{ pubkey, events: 3, latest: 1_786_363_200 }],
        },
      });
    }
    if (url.includes("/api/contributor-trail")) {
      return route.fulfill({
        json: [
          {
            event: "urn:nostr:event:t1",
            content: "We should adopt NIP-42 for the WebSocket path.",
            at: 1_786_363_000,
            decision: FLAT_MEMORY.decisions[0].uri,
            decisionName: FLAT_MEMORY.decisions[0].name,
            layer: "SWM",
          },
          {
            event: "urn:nostr:event:t2",
            content: "Standalone remark, not yet feeding a decision.",
            at: 1_786_363_050,
            decision: null,
            decisionName: null,
            layer: "SWM",
          },
        ],
      });
    }
    return route.fulfill({ json: { gate: "ok" } });
  });
  const panel = await openMemoryPanel(page);

  const chip = panel.getByTestId(`dkg-contributor-${pubkey}`);
  await expect(chip).toBeVisible();
  await chip.click();

  const overlay = page.getByTestId("dkg-graph-overlay");
  // 1 linked decision; evidence = its source event + the unlinked remark.
  await expect(overlay.getByText("1 decisions · 2 evidence")).toBeVisible({
    timeout: 15_000,
  });
  await expect(overlay.getByTestId("traces-card")).toHaveCount(1);
  await expect(overlay.getByText("⊕ 1")).toBeVisible();
  await expect(
    overlay.getByText("evidence not yet feeding a decision (1)"),
  ).toBeVisible();
  await overlay.getByTestId("dkg-topology-toggle").click();
  await expect(
    overlay.getByText(/3 entities · 1 relationships/i),
  ).toBeVisible();
  await expectPaintedGraphCanvas(overlay);
  await waitForAnimations(page);
});

test("named subgraph lens queries the provider and keeps Graph available", async ({
  page,
}) => {
  const subgraphRequests: string[] = [];
  const tripleRequests: string[] = [];
  await page.addInitScript((cg) => {
    window.localStorage.setItem("dkg-memory-cg-override", cg);
  }, CG);
  await page.route("http://127.0.0.1:9295/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/channel-memory")) {
      return route.fulfill({
        json: {
          ...FLAT_MEMORY,
          subgraphs: [
            {
              uri: `${CG}/subgraph/engineering`,
              name: "engineering",
              entityCount: 3,
              tripleCount: 7,
            },
          ],
        },
      });
    }
    if (url.includes("/api/subgraph-graph")) {
      subgraphRequests.push(url);
      return route.fulfill({
        json: {
          gate: "ok",
          nodes: [
            {
              id: FLAT_MEMORY.decisions[0].uri,
              kind: "decision",
              label: FLAT_MEMORY.decisions[0].name,
              at: 1_786_363_200,
            },
          ],
          edges: [],
        },
      });
    }
    if (url.includes("/api/subgraph-triples")) {
      tripleRequests.push(url);
      return route.fulfill({
        json: {
          gate: "ok",
          triples: [
            {
              subject: FLAT_MEMORY.decisions[0].uri,
              predicate: "http://dkg.io/ontology/decisions/affects",
              object: "urn:component:buzz-relay",
              layer: "SWM",
              agent: "engineering",
            },
            {
              subject: FLAT_MEMORY.decisions[0].uri,
              predicate: "http://schema.org/name",
              object: '"Adopt NIP-42 and NIP-98"',
              layer: "SWM",
              agent: "engineering",
            },
            {
              subject: "urn:component:buzz-relay",
              predicate: "http://schema.org/name",
              object: '"Buzz relay"',
              layer: "SWM",
              agent: "engineering",
            },
          ],
        },
      });
    }
    return route.fulfill({ json: { gate: "ok" } });
  });

  const panel = await openMemoryPanel(page, 1);
  // The decisions timeline stays reachable even when named topics exist.
  await expect(panel.getByTestId("dkg-subgraph-all-decisions")).toBeVisible();
  await panel.getByTestId("dkg-subgraph-engineering").click();

  const overlay = page.getByTestId("dkg-graph-overlay");
  await expect(
    overlay.getByRole("heading", { name: /^engineering/i }),
  ).toBeVisible();
  await expect(overlay.getByTestId("traces-card")).toHaveCount(1);
  await expect(overlay.getByTestId("dkg-topology-toggle")).toBeVisible();
  expect(subgraphRequests).toHaveLength(1);
  expect(new URL(subgraphRequests[0]).searchParams.get("name")).toBe(
    "engineering",
  );

  await overlay.getByTestId("dkg-topology-toggle").click();
  await expect(
    overlay.getByRole("button", { name: "Entity types" }),
  ).toBeVisible();
  await expect(
    overlay.getByRole("button", { name: "Contributors" }),
  ).toBeVisible();
  await expect(overlay.getByText(/2 entities · 1 relationships/i)).toBeVisible({
    timeout: 15_000,
  });
  await expectPaintedGraphCanvas(overlay);
  expect(tripleRequests).toHaveLength(1);
  expect(new URL(tripleRequests[0]).searchParams.get("name")).toBe(
    "engineering",
  );
});

test("entity accounting: chips carry sub-graph counts that reconcile to the layer total", async ({
  page,
}) => {
  const pubkey = "c9f4f94b87273745cc34b9d8b15847b27afb90eb9bb7c8a4363703821a0";
  await page.addInitScript((cg) => {
    window.localStorage.setItem("dkg-memory-cg-override", cg);
  }, CG);
  await page.route("http://127.0.0.1:9295/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/channel-memory")) {
      return route.fulfill({
        json: {
          ...FLAT_MEMORY,
          contributors: [{ pubkey, events: 99, latest: 1_786_363_200 }],
        },
      });
    }
    return route.fulfill({ json: { gate: "ok" } });
  });
  // Community-gateway semantic queries: answer each bounded aggregate with a
  // fixture that reconciles exactly (13 = 3 decisions + 6 evidence + 1 agent
  // + 3 capture runs), echoing the request's own channel/operation so the
  // provider envelope validation passes.
  await page.route("**/api/dkg/query", (route) => {
    const body = route.request().postDataJSON() as {
      channelId: string;
      operation: string;
      arguments?: { sparql?: string };
    };
    const sparql = body.arguments?.sparql ?? "";
    const count = sparql.includes("DecisionCluster")
      ? 3
      : sparql.includes("nostr#Event")
        ? 6
        : sparql.includes("prov#Agent")
          ? 1
          : sparql.includes("Distillation")
            ? 3
            : sparql.includes("wasAttributedTo")
              ? 6
              : sparql.includes(
                    "?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?t",
                  )
                ? 13
                : 0;
    return route.fulfill({
      json: {
        ok: true,
        channelId: body.channelId,
        operation: body.operation,
        cg: CG,
        result: {
          queryType: "select",
          scope: { type: "current_channel" },
          layers: [
            {
              layer: "SWM",
              bindings: [
                { n: `"${count}"^^<http://www.w3.org/2001/XMLSchema#integer>` },
              ],
            },
            { layer: "VM", bindings: [{ n: '"0"' }] },
          ],
        },
      },
    });
  });
  const panel = await openMemoryPanel(page);

  // The reconciliation line proves the invariant: kind sub-graphs sum to the
  // layer's entity total, with zero-count kinds omitted.
  await expect(panel.getByTestId("dkg-entity-reconciliation")).toHaveText(
    "Shared memory: 13 entities = 3 decisions · 6 evidence · 1 people & agents · 3 capture runs",
    { timeout: 15_000 },
  );
  // SWM layer card prefers the gateway's uncapped count (fixture sends 3).
  await expect(panel.getByText("3", { exact: true }).first()).toBeVisible();
  // The agent chip carries its sub-graph's entity count (6), not raw events (99).
  const chip = panel.getByTestId(`dkg-contributor-${pubkey}`);
  await expect(chip).toContainText("6");
  await expect(chip).not.toContainText("99");
  await waitForAnimations(page);
});
