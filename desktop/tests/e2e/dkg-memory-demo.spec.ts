import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

// Demo screenshots for the Buzz-native DKG memory panel: a realistic
// deliberation timeline plus the panel resolving the REAL web-of-trust
// Context Graph through the developer's local explorer/edge node.
const SHOTS = "test-results/dkg-memory-demo";
const CHANNEL = "engineering";
const WOT_CG = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust";

async function waitForMockLiveSubscription(
  page: import("@playwright/test").Page,
  channelName: string,
) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ channelName }) =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName }) ??
          false,
        { channelName },
      ),
    )
    .toBe(true);
}

async function emit(
  page: import("@playwright/test").Page,
  content: string,
) {
  const event = await page.evaluate(
    (payload) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: payload.channel,
        content: payload.content,
      }),
    { channel: CHANNEL, content },
  );
  if (!event) throw new Error("mock message emitter is not installed");
  return event as { created_at: number; id: string };
}

const DELIBERATION = [
  "DESIGN THREAD A — Placement & shape: side panel, center tab, or message-anchored memory? Take a position.",
  "OPENING TAKE: ship a read-first “Catch up” side panel beside the conversation; receipts focus matching rows, deeper inspection expands on demand.",
  "ATProto labels are signed source/subject/value objects with explicit negation and expiry — steal that lifecycle for claim rows.",
  "Add Ceramic/IPLD: content-addressed streams give mutable claim histories anchored to immutable records. Rows should link both.",
  "🟡 Captured “DESIGN THREAD A — Placement & shape…”. Distilled to Shared Working Memory — visible to this channel's members, off-chain.\nassertion: did:dkg:context-graph:0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust/assertion/0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/buzz-dkg-6655106675c1\nka: buzz-dkg-6655106675c1\ncontext-graph: 0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust\nsource-digest: sha256:6655106675c1aa2b7e2fb0f3a3f9f1d2c4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9\ntrigger: 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0\nstatus: SWM (not published to Verifiable Memory)",
  "JOINT RECOMMENDATION — A: side panel; B: by-type rows with agent filters; C: relay discovery fallback upgrading to node-verified.",
];

test.describe("dkg memory panel demo", () => {
  test("verified panel over the live web-of-trust graph", async ({ page }) => {
    await page.addInitScript((cg) => {
      window.localStorage.setItem("dkg-memory-cg-override", cg);
    }, WOT_CG);
    await installMockBridge(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByTestId("channel-engineering").click();
    await waitForMockLiveSubscription(page, CHANNEL);
    for (const msg of DELIBERATION) {
      await emit(page, msg);
    }
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/01-channel-with-memory-chip.png` });

    await page.getByTestId("dkg-memory-toggle").click();
    const panel = page.getByTestId("dkg-memory-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Verified through your node")).toBeVisible({
      timeout: 20_000,
    });
    await expect(panel.getByText(/what this channel remembers/i)).toBeVisible({
      timeout: 20_000,
    });
    await waitForAnimations(page);
    await page.screenshot({ path: `${SHOTS}/02-panel-verified-overview.png` });
    await panel.screenshot({ path: `${SHOTS}/03-panel-detail.png` });

    // Evidence trail (provenance) — the "why" behind a decision.
    try {
      await panel.getByText("View evidence", { exact: false }).first().click();
      // Wait for the evidence to actually resolve through the node (not the
      // "Reading evidence…" spinner) before capturing.
      await expect(panel.getByText(/reading evidence/i)).toBeHidden({
        timeout: 20_000,
      });
      await expect(
        panel.getByText(/derived from|source|sha256|assertion|evidence/i).first(),
      ).toBeVisible({ timeout: 20_000 });
      await waitForAnimations(page);
      await panel.screenshot({ path: `${SHOTS}/06-evidence-trail.png` });
    } catch {
      /* evidence view optional for the screenshot run */
    }

    // Contributor trail drill-in.
    const chip = panel.locator("button", { hasText: "…" }).first();
    await chip.click();
    await expect(panel.getByText(/loading trail|fed decision|structured entity|\d{4}/).first())
      .toBeVisible({ timeout: 20_000 });
    await waitForAnimations(page);
    await panel.screenshot({ path: `${SHOTS}/04-contributor-trail.png` });
  });

  test("community gateway fallback resolves full memory", async ({ page }) => {
    await page.addInitScript((cg) => {
      window.localStorage.setItem("dkg-memory-cg-override", cg);
    }, WOT_CG);
    // Simulate a tester's machine: no local explorer, but tailnet reachable.
    await page.route("http://127.0.0.1:9295/**", (route) => route.abort());
    await installMockBridge(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByTestId("channel-engineering").click();
    await waitForMockLiveSubscription(page, CHANNEL);
    for (const msg of DELIBERATION) {
      await emit(page, msg);
    }
    await page.getByTestId("dkg-memory-toggle").click();
    const panel = page.getByTestId("dkg-memory-panel");
    await expect(
      panel.getByText(/resolved via community gateway/i),
    ).toBeVisible({ timeout: 25_000 });
    await expect(panel.getByText(/what this channel remembers/i)).toBeVisible({
      timeout: 25_000,
    });
    await waitForAnimations(page);
    await panel.screenshot({ path: `${SHOTS}/07-gateway-mode.png` });
  });

  test("discovery fallback when no local node", async ({ page }) => {
    await page.addInitScript((cg) => {
      window.localStorage.setItem("dkg-memory-cg-override", cg);
    }, WOT_CG);
    await page.route("http://127.0.0.1:9295/**", (route) => route.abort());
    // Also block the community gateway so pure discovery mode is exercised.
    await page.route("**/wot-explorer/**", (route) => route.abort());
    await installMockBridge(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.getByTestId("channel-engineering").click();
    await waitForMockLiveSubscription(page, CHANNEL);
    for (const msg of DELIBERATION) {
      await emit(page, msg);
    }
    await page.getByTestId("dkg-memory-toggle").click();
    const panel = page.getByTestId("dkg-memory-panel");
    await expect(panel.getByText("Shown for discovery", { exact: false }))
      .toBeVisible({ timeout: 20_000 });
    await waitForAnimations(page);
    await panel.screenshot({ path: `${SHOTS}/05-discovery-fallback.png` });
  });
});
