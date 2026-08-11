import { expect, type Page } from "@playwright/test";

export async function waitForMockLiveSubscription(
  page: Page,
  channelName: string,
  kind?: number,
) {
  await expect
    .poll(() =>
      page.evaluate(
        ({ channelName, kind }) =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName,
            kind,
          }) ?? false,
        { channelName, kind },
      ),
    )
    .toBe(true);
}
