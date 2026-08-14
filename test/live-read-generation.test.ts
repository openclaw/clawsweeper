import assert from "node:assert/strict";
import test from "node:test";

import { LiveReadGeneration } from "../dist/live-read-generation.js";
import { createReviewPlanningInventory } from "../dist/clawsweeper-review-planning-inventory.js";

test("live reads are shared only inside one generation", () => {
  const generation = new LiveReadGeneration();
  let calls = 0;
  const read = () => generation.read("issue:42", () => ++calls);

  assert.equal(read(), 1);
  assert.equal(read(), 1);
  assert.equal(calls, 1);

  generation.invalidate();
  assert.equal(read(), 2);
  assert.equal(calls, 2);
});

test("generation bypass always reaches the live reader", () => {
  const generation = new LiveReadGeneration();
  let calls = 0;
  const read = () => ++calls;

  assert.equal(generation.read("comments:42", read), 1);
  assert.equal(generation.read("comments:42", read), 1);
  assert.equal(generation.read("comments:42", read, { bypassGenerationCache: true }), 2);
  assert.equal(generation.read("comments:42", read, { bypassGenerationCache: true }), 3);
});

test("values bound before a mutation cannot cross the generation boundary", () => {
  const generation = new LiveReadGeneration();
  const bound = generation.bind({ state: "open" });

  generation.invalidate();
  assert.throws(() => generation.value(bound), /belongs to generation 1, current generation is 2/);
});

test("fetchItem shares the full issue read and normalizes live label objects", () => {
  let calls = 0;
  const inventory = createReviewPlanningInventory({
    targetRepo: () => "openclaw/clawsweeper",
    ghJson: () => {
      calls += 1;
      return {
        number: 42,
        title: "Generation proof",
        html_url: "https://github.com/openclaw/clawsweeper/issues/42",
        created_at: "2026-08-13T00:00:00Z",
        updated_at: "2026-08-13T00:00:00Z",
        state: "open",
        user: { login: "contributor" },
        labels: [{ name: "bug" }, { name: "clawsweeper:ready" }],
      };
    },
    ghJsonLines: () => [],
    normalizeAuthorAssociation: () => "CONTRIBUTOR",
    indexedExistingReview: () => null,
  });
  const generation = new LiveReadGeneration();

  const first = inventory.fetchItem(42, { liveReadGeneration: generation });
  const second = inventory.fetchItem(42, { liveReadGeneration: generation });
  assert.equal(calls, 1);
  assert.deepEqual(first.item.labels, ["bug", "clawsweeper:ready"]);
  assert.deepEqual(second, first);
});
