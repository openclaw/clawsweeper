import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateRecords, combineCorpus } from "../dashboard-site/scripts/records.ts";
import { writeAssessmentScenario } from "../dashboard-site/fixtures/assessment-records.ts";

const now = Date.parse("2026-10-30T23:00:00Z");

test("real record aggregation classifies before bounded selection and preserves exact totals", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "assessment-corpus-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { visibility, expected } = writeAssessmentScenario(root, now, 240);
  const cache = await aggregateRecords(root, visibility, undefined, now);
  const corpus = combineCorpus(cache, () => true);
  assert.equal(cache.excludedRepositories, 1);
  assert(corpus.assessments);
  for (const [group, total] of Object.entries(expected)) {
    for (const concern of ["security", "maintainer"]) {
      const collection = corpus.assessments.groups[group][concern];
      assert.equal(collection.total, total);
      assert.equal(collection.items.length, Math.min(total, 100));
    }
  }
  const mine = corpus.repositoryAssessments["fixture-assessments"]!;
  assert.equal(mine.groups.open.security.total, 242);
  assert.equal(mine.groups.open.security.items.length, 20);
  assert.equal(mine.groups.open.security.items[0].number, 2);
  assert.deepEqual(
    mine.groups.historical.security.items.map((item) => item.number),
    [3, 7],
  );
  assert.deepEqual(
    mine.groups.changed.security.items.map((item) => item.number),
    [4, 6],
  );
  assert.equal(mine.groups.unknown.security.items[0].number, 5);
  assert.equal(corpus.repositoryAssessments["fixture-other-repo"]!.groups.open.security.total, 1);
  assert(!JSON.stringify(corpus).includes("PRIVATE_"));
  assert(!JSON.stringify(corpus).includes("BODY_SENTINEL"));
  const kept = combineCorpus(cache, (repo) => repo === "fixture/other-repo");
  assert.equal(kept.assessments!.groups.open.security.total, 1);
  assert.deepEqual(Object.keys(kept.repositoryAssessments), ["fixture-other-repo"]);
});

test("legacy and mixed-generation caches never manufacture complete group counts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "assessment-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { visibility } = writeAssessmentScenario(root, now);
  const cache = await aggregateRecords(root, visibility, undefined, now);
  const legacy = cache.repositories.find((part) => part.stats.slug === "fixture-assessments")!;
  delete legacy.assessments;
  const corpus = combineCorpus(cache, () => true);
  assert.equal(corpus.assessments, null);
  assert.equal(corpus.repositoryAssessments["fixture-assessments"], null);
  assert(corpus.repositoryAssessments["fixture-other-repo"]);
  assert(corpus.lists.security.length > 0);
});
