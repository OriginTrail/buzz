import { expect, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

test("channel header owns a CI-safe memory dock toggle", async ({ page }) => {
  await page.route("http://127.0.0.1:9295/**", (route) => route.abort());
  await page.route("**/api/dkg/query", async (route) => {
    const request = route.request().postDataJSON() as {
      channelId: string;
      operation: string;
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        channelId: request.channelId,
        cg: "dock-test-cg",
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
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("dkg-memory-toggle")).toHaveCount(0);

  await page.getByTestId("channel-engineering").click();
  const toggle = page.getByTestId("dkg-memory-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId("dkg-memory-panel")).toBeVisible();

  await toggle.click();
  await expect(page.getByTestId("dkg-memory-panel")).toHaveCount(0);
});
