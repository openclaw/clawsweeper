import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateRecords, combineCorpus } from "../dashboard-site/scripts/records.ts";
import { compareAttention } from "../dashboard-site/scripts/attention.ts";

test("priority survives bounded collection; archived and private flags stay out", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-attention-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const now = Date.parse("2026-10-14T12:00:00Z");
  const visibility = {};
  for (const repo of ["example/alpha", "example/beta"]) {
    visibility[repo] = { public: true, checkedAt: new Date(now).toISOString() };
    for (const area of ["items", "closed"])
      mkdirSync(join(root, repo.replace("/", "-"), area), { recursive: true });
  }
  const put = (repo, number, priority, reviewedAt, area = "items") => {
    const decision = {
      triagePriority: priority,
      maintainerDecision: { required: true, kind: "manual_review" },
      securityReview: { status: "needs_attention" },
    };
    writeFileSync(
      join(root, repo.replace("/", "-"), area, `${number}.md`),
      [
        "---",
        `repository: ${repo}`,
        `number: ${number}`,
        "type: issue",
        `reviewed_at: ${reviewedAt}`,
        `review_record: ${JSON.stringify({ version: 1, decision })}`,
        "---",
        "",
      ].join("\n"),
    );
  };
  put("example/alpha", 1, "P0", "2026-01-01T00:00:00Z");
  for (let number = 2; number <= 1102; number++)
    put("example/alpha", number, "P2", "2026-10-13T00:00:00Z");
  put("example/alpha", 2000, "P0", "2025-01-01T00:00:00Z", "closed");
  put("example/beta", 1, "P0", "2026-01-01T00:00:00Z");
  const cache = await aggregateRecords(root, visibility, undefined, now);
  assert.equal(cache.attentionOrder, "reviewer-priority-age-v1");
  for (const name of ["maintainer", "security"] as const) {
    const all = combineCorpus(cache, () => true).lists[name];
    assert.equal(all.length, 500);
    assert.deepEqual(
      all.slice(0, 2).map((row) => [row.repo, row.number]),
      [
        ["example/alpha", 1],
        ["example/beta", 1],
      ],
    );
    assert(!all.some((row) => row.number === 2000));
    const publicOnly = combineCorpus(cache, (repo) => repo === "example/alpha").lists[name];
    assert.equal(publicOnly[0].number, 1);
    assert(publicOnly.every((row) => row.repo === "example/alpha"));
  }
  // A legacy cache has lost the older rows before this code sees it. Preserve
  // its actual newest-first contract instead of pretending it is a full backlog.
  delete cache.attentionOrder;
  const legacy = combineCorpus(cache, () => true);
  assert.equal(legacy.attentionOrder, null);
  assert.equal(legacy.lists.maintainer[0].reviewedAt, "2026-10-13T00:00:00.000Z");
});

test("unknown priority and missing dates do not outrank known evidence", () => {
  const row = (number, triagePriority, reviewedAt) => ({
    repo: "example/alpha",
    kind: "issue",
    number,
    triagePriority,
    reviewedAt,
  });
  const rows = [
    row(8, "none", "2025-01-01"),
    row(3, "P1", null),
    row(2, "P1", "2026-10-13"),
    row(1, "P1", "2026-10-13"),
    row(9, "invalid", null),
  ];
  assert.deepEqual(
    rows.sort(compareAttention).map((item) => item.number),
    [1, 2, 3, 8, 9],
  );
});
