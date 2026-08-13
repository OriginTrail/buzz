import assert from "node:assert/strict";
import test from "node:test";

import {
  DKG_READ_STALE_TIME_MS,
  dkgReadQueryPolicy,
} from "./queryLoadPolicy.ts";

test("heavy DKG reads are cached briefly without polling or retry amplification", () => {
  assert.equal(DKG_READ_STALE_TIME_MS, 30_000);
  assert.deepEqual(dkgReadQueryPolicy, {
    retry: false,
    refetchInterval: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
});
