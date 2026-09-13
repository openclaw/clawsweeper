import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../../..");
const base = process.argv[2];
assert.match(base ?? "", /^[a-f0-9]{40}$/);
const scratch = mkdtempSync(join(tmpdir(), "strict-telemetry-proof-"));
const now = Date.parse("2026-09-11T20:00:00Z");
const files = [
  "dashboard/exact-review-failure-telemetry.ts",
  "dashboard/exact-review-source-revision.ts",
  "dashboard/durable-storage.ts",
  "src/stable-json.ts",
  "src/repair/exact-review-guard-labels.ts",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const results = [];
try {
  for (const label of ["base", "candidate"]) {
    const source = label === "base" ? join(scratch, "base") : root;
    if (label === "base") {
      for (const file of files) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        writeFileSync(join(source, file), execFileSync("git", ["show", `${base}:${file}`], { cwd: root }));
      }
    }
    const { ExactReviewFailureTelemetryStore } = await import(pathToFileURL(join(source, files[0])));
    const { exactReviewSourceRevisionMaterial } = await import(pathToFileURL(join(source, files[1])));
    const { sqlColumnNames } = await import(pathToFileURL(join(source, files[2])));
    const db = new DatabaseSync(join(scratch, `${label}.sqlite`));
    try {
      const storage = {
        sql: { exec(query, ...bindings) {
          const statement = db.prepare(query);
          if (statement.columns().length) return statement.all(...bindings);
          statement.run(...bindings);
          return [];
        } },
        transactionSync(callback) {
          db.exec("BEGIN");
          try { const result = callback(); db.exec("COMMIT"); return result; }
          catch (error) { db.exec("ROLLBACK"); throw error; }
        },
      };
      const store = new ExactReviewFailureTelemetryStore(storage);
      const attempts = ["agent_input_scan", "source_preparation", "provider_throttle", "workflow"].map((stage, index) => ({
        attemptId: digest(`attempt-${index}`), canonicalTargetKey: `openclaw/clawsweeper#${index+1}`,
        fenceKey: `openclaw/clawsweeper#${index+1}`, revision: 1, claimGeneration: 1,
        runId: String(100 + index), runAttempt: 1, sourceFingerprint: digest(`source-${index}`),
        failureFingerprint: digest(stage), sourceHeadSha: null, sourceContentRevision: null,
        sourceUpdatedAt: null, stage, reasonCode: "unknown", retryable: false, observedAt: now,
      }));
      for (const attempt of attempts) store.recordSync(attempt);
      store.recordSync(attempts[0]);
      const summary = new ExactReviewFailureTelemetryStore(storage).summarySync(now);
      assert.equal(summary.attempts, 4);
      assert.deepEqual(summary.by_stage, { agent_input_scan: 1, source_preparation: 1, provider_or_model: 1, workflow: 1 });
      assert.ok(sqlColumnNames(storage, "exact_review_failure_attempts_v1").has("source_content_revision"));
      const validSource = exactReviewSourceRevisionMaterial({ title: "Synthetic issue", body: "Evidence", locked: false, labels: ["bug"] });
      assert.ok(validSource);
      assert.equal(exactReviewSourceRevisionMaterial({ title: 7, body: null, locked: false, labels: [] }), null);
      results.push({ label, summary, validSource });
    } finally { db.close(); }
  }
  assert.deepEqual(results[0].summary, results[1].summary);
  assert.deepEqual(results[0].validSource, results[1].validSource);
  const output = { base, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), runtime: process.version, storage: "real on-disk node:sqlite", source_sha256: digest(readFileSync(join(root, files[0]))), result: "passed", results, production_mutations: 0 };
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  writeFileSync(join(root, ".artifacts/strict-telemetry-proof.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
