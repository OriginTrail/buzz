import assert from "node:assert/strict";
import test from "node:test";

import {
  isDkgWebOfTrustUiEnabled,
  shouldShowDkgWebOfTrustUi,
} from "./featureFlags.ts";

test("Web of Trust UI is disabled by default", () => {
  assert.equal(isDkgWebOfTrustUiEnabled({}), false);
  assert.equal(shouldShowDkgWebOfTrustUi(true, {}), false);
});

test("Web of Trust UI accepts explicit review-build values", () => {
  for (const value of ["1", "true", " TRUE "]) {
    assert.equal(
      isDkgWebOfTrustUiEnabled({ VITE_BUZZ_DKG_WEB_OF_TRUST: value }),
      true,
    );
  }
});

test("relay trust capability remains mandatory when the build flag is on", () => {
  const reviewBuild = { VITE_BUZZ_DKG_WEB_OF_TRUST: "true" };

  assert.equal(shouldShowDkgWebOfTrustUi(false, reviewBuild), false);
  assert.equal(shouldShowDkgWebOfTrustUi(true, reviewBuild), true);
});
