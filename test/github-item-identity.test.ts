import assert from "node:assert/strict";
import test from "node:test";
import { assertGitHubItemIdentity, GitHubItemMovedError } from "../dist/github-item-identity.js";
import { createReviewPlanningInventory } from "../dist/clawsweeper-review-planning-inventory.js";
import { LiveReadGeneration } from "../dist/live-read-generation.js";

const repository = "example/project";
const item = (repo = repository, number = 41) => ({
  number,
  html_url: `https://github.com/${repo}/issues/${number}`,
  title: "Identity fixture",
  state: "open",
  created_at: "2026-10-17T00:00:00Z",
  updated_at: "2026-10-17T00:00:00Z",
});

test("GitHub item identity binds the repository, number, and canonical URL", () => {
  assert.doesNotThrow(() => assertGitHubItemIdentity(item(), "Example/Project", 41));
  assert.doesNotThrow(() =>
    assertGitHubItemIdentity(
      { ...item(), html_url: "https://github.example/Example/Project/pull/41" },
      repository,
      41,
    ),
  );
  for (const moved of [item("example/other"), item("example/other", 12), item(repository, 12)]) {
    assert.throws(() => assertGitHubItemIdentity(moved, repository, 41), GitHubItemMovedError);
  }
  for (const invalid of [
    { number: 41 },
    { ...item(), html_url: "not a URL" },
    { ...item(), number: 42 },
  ]) {
    assert.throws(() => assertGitHubItemIdentity(invalid, repository, 41), /invalid item identity/);
  }
});

for (const mode of ["live", "snapshot", "generation"] as const) {
  test(`a transferred ${mode} item cannot enter selection or repair the read model`, () => {
    let repairs = 0;
    const moved = item("example/other", 12);
    const inventory = createReviewPlanningInventory({
      targetRepo: () => repository,
      ghJson: () => moved,
      ghJsonLines: () => [],
      normalizeAuthorAssociation: () => "CONTRIBUTOR",
      githubReadModelRequestSync: (operation: string) => {
        if (operation === "repair") repairs += 1;
        return mode === "snapshot" ? { usable: true, item: moved } : null;
      },
    } as never);
    assert.throws(
      () =>
        inventory.fetchItem(
          41,
          mode === "generation" ? { liveReadGeneration: new LiveReadGeneration() } : {},
        ),
      GitHubItemMovedError,
    );
    assert.equal(repairs, 0);
  });
}

test("a mismatched cached identity is replaced by a verified live read", () => {
  let liveReads = 0;
  const repaired: unknown[] = [];
  const inventory = createReviewPlanningInventory({
    targetRepo: () => repository,
    ghJson: () => {
      liveReads += 1;
      return item();
    },
    ghJsonLines: () => [],
    normalizeAuthorAssociation: () => "CONTRIBUTOR",
    githubReadModelRequestSync: (operation: string, payload: Record<string, unknown>) => {
      if (operation === "repair") repaired.push(payload.objects);
      return { usable: true, item: item("example/other") };
    },
  } as never);
  assert.equal(inventory.fetchItem(41).item.url, item().html_url);
  assert.equal(liveReads, 1);
  assert.equal(repaired.length, 1);
  assert.deepEqual(repaired[0], [
    {
      kind: "item",
      repository,
      number: 41,
      itemKind: "issue",
      sourceUpdatedAt: new Date(item().updated_at).toISOString(),
      snapshot: item(),
    },
  ]);
});
