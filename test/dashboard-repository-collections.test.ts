import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  aggregateRecords,
  combineCorpus,
  type Visibility,
} from "../dashboard-site/scripts/records.ts";
import {
  boundedRepositoryCollection,
  repositoryCollection,
  repositoryCollectionStatus,
} from "../dashboard-site/src/lib/repository-collections.ts";

const names = ["stale", "maintainer", "security", "closes"] as const;

test("repository selection precedes every global cap, totals precede repository caps, and both visibility gates apply", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "repository-collections-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.parse("2026-10-30T12:00:00Z");
  const visibility: Visibility = {};
  const put = (repo: string, number: number, area: string, reviewedAt: string, flagged = true) => {
    const dir = join(root, repo.replace("/", "-"), area);
    mkdirSync(dir, { recursive: true });
    const decision = {
      decision: area === "closed" ? "close" : "keep_open",
      closeReason: "inactive",
      triagePriority: "P1",
      maintainerDecision: { required: flagged, kind: "manual_review" },
      securityReview: { status: flagged ? "needs_attention" : "clear" },
    };
    writeFileSync(
      join(dir, `${number}.md`),
      [
        "---",
        `repository: ${repo}`,
        `number: ${number}`,
        "type: issue",
        `title: "Controlled record ${number}"`,
        `reviewed_at: ${reviewedAt}`,
        ...(area === "closed"
          ? [
              "action_taken: closed",
              `applied_at: ${repo === "example/alpha" ? "2026-10-29" : "2026-10-28"}T00:00:00Z`,
            ]
          : []),
        `review_record: ${JSON.stringify({ version: 1, decision })}`,
        "---",
      ].join("\n"),
    );
  };
  for (const repo of [
    "example/alpha",
    "example/beta",
    "example/empty",
    "example/hidden",
    "example/withdrawn",
  ]) {
    visibility[repo] = {
      public: repo !== "example/hidden",
      checkedAt: new Date(now).toISOString(),
    };
    const count = repo === "example/alpha" ? 1102 : repo === "example/beta" ? 12 : 1;
    for (let n = 1; n <= count; n++) {
      put(
        repo,
        n,
        "items",
        repo === "example/alpha"
          ? "2026-01-01T00:00:00Z"
          : repo === "example/empty"
            ? "2026-10-29T00:00:00Z"
            : "2026-02-01T00:00:00Z",
        repo !== "example/empty",
      );
      if (repo !== "example/empty") put(repo, n + 1000, "closed", "2026-02-01T00:00:00Z");
    }
  }
  const cache = await aggregateRecords(root, visibility, undefined, now);
  assert(!JSON.stringify(cache).includes("example/hidden"));
  const output = combineCorpus(cache, (repo) => repo !== "example/withdrawn");
  assert(!JSON.stringify(output).includes("example/withdrawn"));
  const collections = output.repositoryCollections["example-beta"];
  for (const name of names) {
    const global = name === "closes" ? output.recordedCloses.recent : output.lists[name];
    assert.equal(global.length, 500);
    assert(global.every((row) => row.repo === "example/alpha"));
    assert.equal(collections[name].items.length, 10);
    assert.equal(collections[name].total, 12);
    assert.equal(collections[name].selection, "repository-before-limit");
    assert(collections[name].items.every((row) => row.repo === "example/beta"));
    const empty = output.repositoryCollections["example-empty"][name];
    assert.equal(empty.total, 0);
    assert.equal(repositoryCollectionStatus(empty).empty, true);
  }
  assert.equal(
    collections.stale.total,
    output.repos.find((repo) => repo.repo === "example/beta")!.staleOpen,
  );
  // Legacy cache arrays remain useful observations, not proof of selection coverage.
  for (const part of cache.repositories) delete part.collectionTotals;
  delete cache.attentionOrder;
  const legacy = combineCorpus(cache, () => true).repositoryCollections["example-beta"];
  for (const name of names) {
    assert.equal(legacy[name].total, null);
    assert.equal(legacy[name].selection, "legacy-unknown");
    assert.equal(repositoryCollectionStatus(legacy[name]).empty, false);
  }
});

test("unknown, legacy, missing and contradictory collections never claim all-clear", () => {
  const repo = "example/beta";
  const row = { repo, number: 1, assessment: { version: 1, lifecycle: "unknown" } };
  for (const name of names) {
    assert.equal(
      repositoryCollectionStatus(repositoryCollection(undefined, repo, [])).empty,
      false,
      name,
    );
    const unknown = boundedRepositoryCollection([], null, "legacy-unknown");
    assert.match(repositoryCollectionStatus(unknown).message, /unavailable.*unknown/);
    const missingRows = boundedRepositoryCollection([], 10, "repository-before-limit");
    assert.equal(repositoryCollectionStatus(missingRows).empty, false);
    assert.match(repositoryCollectionStatus(missingRows).message, /10.*rows are unavailable/);
    const contradiction = boundedRepositoryCollection([row], 0, "repository-before-limit");
    assert.equal(contradiction.total, null);
    assert.equal(repositoryCollectionStatus(contradiction).empty, false);
  }
  const wrongKpi = repositoryCollection(
    boundedRepositoryCollection([], 0, "repository-before-limit"),
    repo,
    [],
    10,
  );
  assert.equal(wrongKpi.total, 10);
  assert.equal(repositoryCollectionStatus(wrongKpi).empty, false);
  const observed = repositoryCollection(undefined, repo, [
    { repo: "example/alpha", number: 2 },
    row,
  ]);
  assert.deepEqual(observed.items, [row]);
  assert.strictEqual(observed.items[0].assessment, row.assessment);
  const wrongRepo = repositoryCollection(
    boundedRepositoryCollection([{ repo: "example/alpha" }], 1, "repository-before-limit"),
    repo,
    [],
  );
  assert.equal(wrongRepo.total, null);
  assert.equal(repositoryCollectionStatus(wrongRepo).empty, false);
  for (const total of [-1, NaN, Infinity, 1.5])
    assert.equal(boundedRepositoryCollection([], total, "repository-before-limit").total, null);
});

test("unreadable corpus sections fail closed instead of publishing partial zero counts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "repository-unreadable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "example-alpha");
  mkdirSync(join(dir, "items"), { recursive: true });
  writeFileSync(join(dir, "items/1.md"), "---\nrepository: example/alpha\nnumber: 1\n---\n");
  writeFileSync(join(dir, "closed"), "not a directory");
  const now = Date.parse("2026-10-30T12:00:00Z");
  await assert.rejects(
    aggregateRecords(
      root,
      { "example/alpha": { public: true, checkedAt: new Date(now).toISOString() } },
      undefined,
      now,
    ),
    /ENOTDIR/,
  );
});
