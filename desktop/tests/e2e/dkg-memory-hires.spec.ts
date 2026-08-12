// High-resolution captures of the openclaw sub-graph — Traces + Graph —
// for the repo's documentation. 1920×1080 viewport at deviceScaleFactor 2
// (3840×2160 PNGs) against the LIVE Web of Trust context graph through the
// local explorer, same seeding as dkg-memory-demo.spec.ts.
import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";
import { waitForMockLiveSubscription } from "../helpers/subscriptions";

const SHOTS = "test-results/dkg-memory-hires";
const CHANNEL = "engineering";
const WOT_CG = "0x633E5a7C5e612d9981538F60D824cC03be97e2Ab/web-of-trust";

test.skip(
  Boolean(process.env.CI),
  "manual high-resolution capture requires a reachable DKG provider",
);

test.use({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
});

test("hires: openclaw Traces + Graph", async ({ page }) => {
  await page.addInitScript((cg) => {
    window.localStorage.setItem("dkg-memory-cg-override", cg);
  }, WOT_CG);
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-engineering").click();
  await waitForMockLiveSubscription(page, CHANNEL);
  const receipt = `🟡 Captured "seed". Distilled to Shared Working Memory.\ncontext-graph: ${WOT_CG}\nsource-digest: sha256:${"a".repeat(64)}\nka: seed`;
  await page.evaluate(
    (payload) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: payload.channel,
        content: payload.content,
      }),
    { channel: CHANNEL, content: receipt },
  );
  await page.getByTestId("dkg-memory-toggle").click();
  const panel = page.getByTestId("dkg-memory-panel");
  await expect(panel.getByTestId("dkg-channel-graph")).toBeVisible({
    timeout: 25_000,
  });

  await page.getByTestId("dkg-subgraph-openclaw").click();
  const overlay = page.getByTestId("dkg-graph-overlay");
  await expect(overlay.getByTestId("traces-card").first()).toBeVisible({
    timeout: 30_000,
  });
  await waitForAnimations(page);
  await overlay.screenshot({ path: `${SHOTS}/openclaw-traces@2x.png` });

  // Selected decision + evidence rail (resolve link visible).
  await overlay
    .getByTestId("traces-card")
    .first()
    .locator("button")
    .first()
    .click();
  await expect(
    overlay.getByText(/resolve in your node ui|resolve in node ui/i),
  ).toBeVisible({ timeout: 15_000 });
  await waitForAnimations(page);
  await overlay.screenshot({
    path: `${SHOTS}/openclaw-traces-selected@2x.png`,
  });

  // Graph — entity-type colors (node-UI parity).
  await overlay.getByTestId("dkg-topology-toggle").click();
  await expect(
    overlay.getByRole("button", { name: "Entity types" }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(overlay.locator("canvas").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(3500); // settle the force layout
  await waitForAnimations(page);
  await overlay.screenshot({ path: `${SHOTS}/openclaw-graph@2x.png` });

  // Graph — contributors coloring.
  await overlay.getByRole("button", { name: "Contributors" }).click();
  await page.waitForTimeout(1500);
  await overlay.screenshot({
    path: `${SHOTS}/openclaw-graph-contributors@2x.png`,
  });
});
