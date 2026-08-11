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

test("flat capture: All-decisions lens opens the Traces timeline", async ({
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
    return route.fulfill({ json: { gate: "ok" } });
  });
  const panel = await openMemoryPanel(page);

  const lens = panel.getByTestId("dkg-subgraph-all-decisions");
  await expect(lens).toBeVisible();
  await lens.click();

  const overlay = page.getByTestId("dkg-graph-overlay");
  await expect(overlay.getByText("All decisions")).toBeVisible();
  await expect(overlay.getByText("3 decisions · 0 evidence")).toBeVisible();
  await expect(overlay.getByTestId("traces-card")).toHaveCount(3, {
    timeout: 15_000,
  });
  await expect(
    overlay.getByRole("region", { name: "Decision traces timeline" }),
  ).toBeVisible();
  await expect(
    overlay
      .getByTestId("traces-card")
      .filter({ hasText: "adopt NIP-42 for WebSockets" })
      .first(),
  ).toBeVisible();
  await expect(overlay.getByTestId("dkg-topology-toggle")).toHaveCount(0);
  expect(subgraphRequests).toEqual([]);
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
  await expect(panel.getByTestId("dkg-subgraph-all-decisions")).toHaveCount(0);
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
  await expect(
    overlay.getByText(/2 connected entities · 1 relationships/i),
  ).toBeVisible({ timeout: 15_000 });
  const topologyCanvas = overlay.locator("canvas").first();
  await expect(topologyCanvas).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(
      () =>
        topologyCanvas.evaluate((node) => {
          const canvas = node as HTMLCanvasElement;
          const context = canvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (!context || canvas.width === 0 || canvas.height === 0) return 0;
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
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
  expect(tripleRequests).toHaveLength(1);
  expect(new URL(tripleRequests[0]).searchParams.get("name")).toBe(
    "engineering",
  );
});
