import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContributorGraph,
  buildDecisionsGraph,
  lensLayerCounts,
  lensTriples,
} from "./lensGraphs.ts";

const DECISION = {
  uri: "urn:buzz-dkg:decision:aaa",
  name: "DECISION: adopt NIP-42.",
  digest: "sha256:aaa",
  at: null,
};

const ENVELOPE = {
  gate: "ok",
  found: true,
  claimId: DECISION.uri,
  name: "DECISION: adopt NIP-42 for WebSockets.",
  memoryLayer: "SWM",
  attribution: ["c9f4f94b"],
  sources: [
    {
      id: "urn:nostr:event:e1",
      span: "which auth methods should the service support?",
      author: "c9f4f94b",
      at: 1_785_782_065,
    },
    { id: "urn:nostr:event:e2", span: null, author: null, at: 1_785_782_100 },
  ],
  relations: [{ from: "urn:buzz-dkg:claim:zzz", rel: "contradictsClaim" }],
};

test("decisions lens links envelope sources as supports and counts layers", () => {
  const { nodes, edges } = buildDecisionsGraph([DECISION], [ENVELOPE]);
  const decision = nodes.find((n) => n.id === DECISION.uri);
  assert.equal(decision.kind, "decision");
  // Envelope name wins over the channel_memory name; layer flows through.
  assert.equal(decision.label, ENVELOPE.name);
  assert.equal(decision.layer, "SWM");
  // No ISO `at` on the decision → latest source timestamp stands in.
  assert.equal(decision.at, 1_785_782_100);
  const supports = edges.filter(
    (e) => e.rel === "supports" && e.to === DECISION.uri,
  );
  assert.equal(supports.length, 2);
  const evidence = nodes.find((n) => n.id === "urn:nostr:event:e1");
  assert.equal(evidence.kind, "claim");
  assert.equal(evidence.label, ENVELOPE.sources[0].span);
  // Decision + both sources carry SWM; the bare relation node has no layer.
  assert.equal(lensLayerCounts(nodes).SWM, 3);
});

test("decisions lens marks contradicting relations as contested", () => {
  const { nodes, edges } = buildDecisionsGraph([DECISION], [ENVELOPE]);
  const contradicts = edges.find((e) => e.rel === "contradicts");
  assert.equal(contradicts.from, "urn:buzz-dkg:claim:zzz");
  assert.equal(contradicts.to, DECISION.uri);
  assert.equal(nodes.find((n) => n.id === DECISION.uri).contested, 1);
});

test("a null envelope degrades to a bare decision card, never a dropped one", () => {
  const { nodes, edges } = buildDecisionsGraph([DECISION], [null]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, DECISION.name);
  assert.equal(nodes[0].layer, undefined);
  assert.equal(edges.length, 0);
});

test("shared sources merge into one evidence node with an edge per decision", () => {
  const second = { ...DECISION, uri: "urn:buzz-dkg:decision:bbb" };
  const { nodes, edges } = buildDecisionsGraph(
    [DECISION, second],
    [ENVELOPE, { ...ENVELOPE, claimId: second.uri, relations: [] }],
  );
  assert.equal(nodes.filter((n) => n.id === "urn:nostr:event:e1").length, 1);
  assert.equal(edges.filter((e) => e.from === "urn:nostr:event:e1").length, 2);
  // Duplicate decision URIs collapse instead of double-rendering.
  const again = buildDecisionsGraph([DECISION, DECISION], [ENVELOPE, ENVELOPE]);
  assert.equal(again.nodes.filter((n) => n.kind === "decision").length, 1);
});

const TRAIL = [
  {
    event: "urn:nostr:event:t1",
    content: "Alice implemented verifyCanary in commit 0ec45696.",
    at: 1_786_249_603,
    decision: "urn:buzz-dkg:entity:alice",
    decisionName: "Alice Canary",
    layer: "SWM",
  },
  {
    event: "urn:nostr:event:t2",
    content: "Standalone remark with no decision yet.",
    at: 1_786_249_700,
    decision: null,
    decisionName: null,
    layer: "SWM",
  },
  {
    event: "urn:nostr:event:t3",
    content: "Second message feeding the same decision.",
    at: 1_786_249_800,
    decision: "urn:buzz-dkg:entity:alice",
    decisionName: "Alice Canary",
    layer: "SWM",
  },
];

test("contributor lens dedupes decisions and keeps unlinked events visible", () => {
  const { nodes, edges } = buildContributorGraph(TRAIL);
  const decisions = nodes.filter((n) => n.kind === "decision");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].label, "Alice Canary");
  // Decision time follows its latest supporting event.
  assert.equal(decisions[0].at, 1_786_249_800);
  assert.equal(edges.length, 2);
  // The unlinked event is still a node — the shelf shows it.
  assert.ok(nodes.some((n) => n.id === "urn:nostr:event:t2"));
});

test("lens triples project types, escaped labels, and relation edges", () => {
  const graph = buildDecisionsGraph(
    [{ ...DECISION, name: 'She said "yes"\ntwice' }],
    [null],
  );
  const triples = lensTriples(graph);
  assert.ok(
    triples.some(
      (t) =>
        t.predicate.endsWith("#type") &&
        t.object === "https://w3id.org/buzz-dkg/buzz#DecisionCluster",
    ),
  );
  const name = triples.find((t) => t.predicate === "http://schema.org/name");
  assert.equal(name.object, '"She said \\"yes\\" twice"');
  const linked = lensTriples(buildDecisionsGraph([DECISION], [ENVELOPE]));
  assert.ok(
    linked.some(
      (t) => t.predicate === "https://w3id.org/buzz-dkg/buzz#supports",
    ),
  );
});
