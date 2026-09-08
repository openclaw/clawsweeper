import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  fixture,
  perturbFixture,
  rewriteLedger,
  baselineSha,
  targetRepo,
} from "../../docs/proof/aggregate-review-recovery/fixture.mjs";

const cli = resolve("dist/repair/workflow-utils.js");

for (const kind of [
  "mixed",
  "filtered",
  "late-completed",
  "unmatched",
  "accepted-mutation",
  "mutation-only",
  "unsupported",
  "ambiguous",
  "receipt-reason",
  "missing",
  "incomplete",
  "missing-terminal",
  "foreign-batch",
  "wrong-shard",
  "report-identity",
  "report-digest",
]) {
  test(`recovery CLI preserves per-item authority: ${kind}`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "review-recovery-test-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const seeded = await fixture(root, kind);
    perturbFixture(seeded, kind);
    const result = recover(root, seeded);
    const holdAll = [
      "filtered",
      "missing",
      "incomplete",
      "missing-terminal",
      "foreign-batch",
      "wrong-shard",
    ].includes(kind);
    assert.deepEqual(
      result.retryable,
      holdAll
        ? []
        : ["mutation-only", "unsupported", "ambiguous"].includes(kind)
          ? [4]
          : kind === "receipt-reason"
            ? [3]
            : [3, 4],
    );
    assert.deepEqual(
      result.staged,
      holdAll
        ? []
        : ["late-completed", "report-identity", "report-digest"].includes(kind)
          ? [2]
          : [1, 2],
    );
    if (!holdAll) {
      const item = (number) => result.items.find((entry) => entry.number === number);
      assert.equal(item(7).disposition, "terminal");
      for (const number of [5, 6, 8]) assert.equal(item(number).disposition, "held");
      for (const number of result.staged) {
        assert.equal(
          readFileSync(join(root, "staged", `${number}.md`), "utf8"),
          readFileSync(join(seeded.reports, `${number}.md`), "utf8"),
        );
      }
    }
  });
}

for (const [key, value] of [
  ["repository", "example/other"],
  ["sha", "a".repeat(40)],
  ["workflow", "other.yml"],
  ["job", "publish"],
  ["run_id", "987654"],
  ["run_attempt", 2],
]) {
  test(`recovery CLI rejects a foreign producer ${key}`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "review-recovery-identity-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const seeded = await fixture(root);
    rewriteLedger(seeded.ledgerDir, (events) =>
      events.map((event) => ({ ...event, producer: { ...event.producer, [key]: value } })),
    );
    const result = recover(root, seeded);
    assert.equal(result.evidence_complete, false);
    assert.deepEqual(result.retryable, []);
    assert.deepEqual(result.staged, []);
    assert.ok(result.items.every((item) => item.disposition === "held"));
  });
}

test("recovery CLI holds corrupted ledger bytes and never follows a report symlink", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-recovery-files-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seeded = await fixture(root);
  const linkedReport = join(root, "linked-report.md");
  writeFileSync(linkedReport, readFileSync(join(seeded.reports, "1.md")));
  rmSync(join(seeded.reports, "1.md"));
  symlinkSync(linkedReport, join(seeded.reports, "1.md"));
  assert.deepEqual(recover(root, seeded).staged, [2]);
  rmSync(join(root, "staged"), { recursive: true });
  const shard = readdirSync(seeded.ledgerDir, { recursive: true }).find((file) =>
    String(file).endsWith(".jsonl"),
  )!;
  writeFileSync(join(seeded.ledgerDir, String(shard)), "{}\n");
  const result = recover(root, seeded);
  assert.equal(result.evidence_complete, false);
  assert.deepEqual(result.retryable, []);
  assert.deepEqual(result.staged, []);
});

function recover(root, seeded) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        cli,
        "review-recovery",
        "--ledger-dir",
        seeded.ledgerDir,
        "--producer-repository",
        targetRepo,
        "--producer-sha",
        baselineSha,
        "--run-id",
        "123456",
        "--run-attempt",
        "1",
        "--target-repo",
        targetRepo,
        "--shard",
        "0",
        "--shard-count",
        "1",
        "--item-numbers",
        seeded.planned.join(","),
        "--reports-dir",
        seeded.reports,
        "--stage-dir",
        join(root, "staged"),
      ],
      { env: { PATH: process.env.PATH }, encoding: "utf8" },
    ),
  );
}
