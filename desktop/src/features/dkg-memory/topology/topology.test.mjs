import assert from "node:assert/strict";
import test from "node:test";

import { topologySummary } from "./topology.ts";

test("topology summary counts resource relationships without treating types as edges", () => {
  const triples = [
    {
      subject: "urn:memory:hello",
      predicate: "http://dkg.io/ontology/memory/contains",
      object: "urn:decision:responsive",
      layer: "SWM",
      agent: "SWM",
    },
    {
      subject: "urn:decision:responsive",
      predicate: "http://dkg.io/ontology/decisions/affects",
      object: "urn:component:page",
      layer: "SWM",
      agent: "SWM",
    },
    {
      subject: "urn:decision:responsive",
      predicate: "http://schema.org/name",
      object: '"Build a responsive page"',
      layer: "SWM",
      agent: "SWM",
    },
    {
      subject: "urn:decision:responsive",
      predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      object: "http://dkg.io/ontology/decisions/Decision",
      layer: "SWM",
      agent: "SWM",
    },
  ];

  assert.deepEqual(topologySummary(triples), {
    entities: 3,
    relationships: 2,
  });
});
