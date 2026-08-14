import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CONTRIBUTOR_COUNT_QUERIES,
  boundedContributorPubkeys,
  countQueries,
  emptyLayerCounts,
  parseCountBinding,
  reconcile,
  reconciliationLine,
} from "./subgraphCounts.ts";

test("query battery uses exact IRIs, LIMITs, and per-agent attribution", () => {
  const queries = countQueries(["aa".repeat(32), "bb".repeat(32)]);
  // total + 6 kinds + 2 agents
  assert.equal(queries.length, 9);
  for (const q of queries) {
    assert.match(q.sparql, /LIMIT 25$/);
    // Budget rules: no GROUP BY, no GRAPH, no ORDER BY.
    assert.doesNotMatch(q.sparql, /GROUP BY|GRAPH|ORDER BY/);
  }
  assert.ok(queries.slice(0, 7).every((query) => query.view === "both"));
  assert.ok(queries.slice(7).every((query) => query.view === "shared"));
  const decisions = queries.find((q) => q.key === "decisions");
  assert.match(
    decisions.sparql,
    /<https:\/\/w3id\.org\/buzz-dkg\/buzz#DecisionCluster>/,
  );
  const agent = queries.find((q) => q.key === `agent:${"aa".repeat(32)}`);
  assert.match(agent.sparql, /wasAttributedTo> <urn:nostr:pubkey:a{64}>/);
  // The typed-total query is the only one with a variable object.
  const total = queries.find((q) => q.key === "typedTotal");
  assert.match(
    total.sparql,
    /\?s <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type> \?t/,
  );
});

test("contributor counts reject unsafe keys, deduplicate, and cap fan-out", () => {
  const valid = Array.from({ length: 20 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  const selected = boundedContributorPubkeys([
    valid[0],
    valid[0],
    ...valid.slice(1),
    "A".repeat(64),
    `${"b".repeat(63)}> ?s ?p ?o`,
  ]);

  assert.equal(selected.length, MAX_CONTRIBUTOR_COUNT_QUERIES);
  assert.equal(new Set(selected).size, selected.length);
  assert.ok(selected.every((pubkey) => /^[0-9a-f]{64}$/.test(pubkey)));
  assert.equal(
    countQueries([...valid, ...valid]).length,
    7 + MAX_CONTRIBUTOR_COUNT_QUERIES,
  );
});

test("count parsing handles typed-literal, object, and absent shapes", () => {
  assert.equal(
    parseCountBinding([
      { n: '"30"^^<http://www.w3.org/2001/XMLSchema#integer>' },
    ]),
    30,
  );
  assert.equal(parseCountBinding([{ n: { value: "312" } }]), 312);
  assert.equal(parseCountBinding([{ n: "0" }]), 0);
  assert.equal(parseCountBinding([{ n: "-1" }]), null);
  assert.equal(parseCountBinding([{ n: "12.5" }]), null);
  assert.equal(parseCountBinding([{ n: "about 30" }]), null);
  assert.equal(parseCountBinding([{ n: "9007199254740992" }]), null);
  assert.equal(parseCountBinding([]), null);
  assert.equal(parseCountBinding(undefined), null);
});

test("reconcile reports the net difference without assigning a cause", () => {
  const exact = emptyLayerCounts();
  exact.typedTotal = 312;
  exact.kinds = {
    decisions: 30,
    evidence: 240,
    agents: 11,
    activities: 30,
    claims: 1,
  };
  assert.deepEqual(reconcile(exact), { sum: 312, delta: 0 });

  const unclassified = emptyLayerCounts();
  unclassified.typedTotal = 315;
  unclassified.kinds = { ...exact.kinds };
  assert.deepEqual(reconcile(unclassified), { sum: 312, delta: 3 });

  const crossTyped = emptyLayerCounts();
  crossTyped.typedTotal = 310;
  crossTyped.kinds = { ...exact.kinds };
  assert.deepEqual(reconcile(crossTyped), { sum: 312, delta: -2 });

  const unknownTotal = emptyLayerCounts();
  unknownTotal.kinds = { decisions: 30 };
  assert.deepEqual(reconcile(unknownTotal), { sum: 30, delta: null });
});

test("reconciliation line names complete kinds without claiming a partition", () => {
  const layer = emptyLayerCounts();
  layer.typedTotal = 312;
  layer.kinds = {
    decisions: 30,
    evidence: 240,
    agents: 11,
    activities: 30,
    claims: 0,
    code: 0,
  };
  // Zero-count kinds are omitted from the prose but required for completeness.
  assert.equal(
    reconciliationLine(layer),
    "312 typed entities · 311 listed type assignments: 30 decisions · 240 evidence · 11 people & agents · 30 capture runs",
  );
  layer.kinds.claims = 1;
  assert.equal(
    reconciliationLine(layer),
    "312 typed entities · 312 listed type assignments: 30 decisions · 240 evidence · 11 people & agents · 30 capture runs · 1 claims",
  );
  // No total or a partial query battery → no misleading reconciliation.
  const empty = emptyLayerCounts();
  assert.equal(reconciliationLine(empty), null);
  empty.typedTotal = 10;
  assert.equal(reconciliationLine(empty), null);
  empty.kinds = { decisions: 10 };
  assert.equal(reconciliationLine(empty), null);
});
