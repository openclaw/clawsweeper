import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { withReviewRecord } from "../helpers.ts";

for (const batch of [false, true]) {
  for (const kind of ["issue", "pull_request"] as const) {
    test(`publisher rejects invalid ${kind} close reason before ${batch ? "batch" : "direct"} mutation`, () => {
      const root = mkdtempSync(join(tmpdir(), "publication-invalid-decision-"));
      try {
        const artifacts = join(root, "artifacts/event");
        const output = join(root, "github-output");
        const mutation = join(root, "batch.json");
        const closeReason =
          kind === "issue" ? "unconfirmed_product_direction" : "stale_version_bug";
        mkdirSync(artifacts, { recursive: true });
        writeFileSync(
          join(artifacts, "74.md"),
          withReviewRecord(
            `---\nnumber: 74\nrepository: openclaw/openclaw\ntype: ${kind}\nreviewed_at: 2026-09-07T00:00:00Z\n---\nReport\n`,
            { decision: "close", closeReason },
          ),
        );
        const result = spawnSync(
          process.execPath,
          [resolve("dist/repair/publish-event-result.js")],
          {
            env: {
              PATH: process.env.PATH,
              TARGET_REPO: "openclaw/openclaw",
              ITEM_NUMBER: "74",
              EXACT_REVIEW_WORK_ROOT: root,
              // No child executable exists: reaching apply is a test failure.
              CLAWSWEEPER_CODE_ROOT: join(root, "absent-code"),
              EXACT_EVENT_PUBLICATION: "true",
              GITHUB_OUTPUT: output,
              ...(batch ? { EXACT_REVIEW_BATCH_MUTATION_OUTPUT: mutation } : {}),
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, new RegExp(`${closeReason} is allowed only for`));
        assert.doesNotMatch(result.stderr, /Cannot find module|MODULE_NOT_FOUND/);
        const outputs = readFileSync(output, "utf8");
        assert.match(outputs, /^completion_kind=permanent_failure$/m);
        assert.match(outputs, /^reason_code=policy_invariant$/m);
        assert.doesNotMatch(outputs, /^retry_at=/m);
        if (batch) {
          const outcome = JSON.parse(readFileSync(mutation, "utf8"));
          assert.equal(outcome.kind, "permanent_failure");
          assert.equal(outcome.reasonCode, "policy_invariant");
          assert.equal(outcome.plan, undefined);
        } else assert.equal(existsSync(mutation), false);
        assert.equal(existsSync(join(root, ".artifacts")), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
