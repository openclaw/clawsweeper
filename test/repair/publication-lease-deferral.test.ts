import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

for (const batch of [false, true]) {
  for (const verified of [false, true]) {
    test(`publisher preserves ${verified ? "verified" : "unverified"} lease evidence in ${batch ? "batch" : "direct"} mode`, () => {
      const root = mkdtempSync(join(tmpdir(), "publication-lease-deferral-"));
      try {
        const artifacts = join(root, "artifacts/event");
        const code = join(root, "code");
        const output = join(root, "github-output");
        const mutation = join(root, "batch.json");
        const retryAt = new Date(Date.now() + 30 * 60_000).toISOString();
        mkdirSync(artifacts, { recursive: true });
        mkdirSync(join(code, "dist"), { recursive: true });
        writeFileSync(
          join(artifacts, "74.md"),
          "---\nnumber: 74\nrepository: openclaw/openclaw\ntype: issue\nreviewed_at: 2026-09-07T00:00:00Z\ndecision: keep_open\n---\nReport\n",
        );
        // Feed the real publisher its child's structured proof result; the child
        // fixture performs no GitHub mutation or canonical state publication.
        writeFileSync(
          join(code, "dist/clawsweeper.js"),
          `
const fs = require("node:fs");
const path = require("node:path");
const [command, ...args] = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (command === "apply-artifacts") {
  fs.mkdirSync(value("--items-dir"), { recursive: true });
  fs.copyFileSync(path.join(value("--artifact-dir"), "74.md"), path.join(value("--items-dir"), "74.md"));
} else if (command === "apply-decisions") {
  fs.mkdirSync(path.dirname(value("--report-path")), { recursive: true });
  fs.writeFileSync(value("--report-path"), JSON.stringify([{
    number: 74,
    action: "kept_open",
    reason: "same-revision review is active",
    activeReviewLeaseVerified: ${verified},
    activeReviewLeaseExpiresAt: ${JSON.stringify(retryAt)}
  }]));
} else throw new Error("unexpected fixture command: " + command);
`,
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
              CLAWSWEEPER_CODE_ROOT: code,
              EXACT_EVENT_PUBLICATION: "true",
              GITHUB_OUTPUT: output,
              ...(batch ? { EXACT_REVIEW_BATCH_MUTATION_OUTPUT: mutation } : {}),
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        assert.equal(result.status, verified ? 0 : 1, result.stdout + result.stderr);
        const outputs = readFileSync(output, "utf8");
        assert.match(
          outputs,
          verified
            ? /^completion_kind=retryable_failure$/m
            : /^completion_kind=permanent_failure$/m,
        );
        assert.match(
          outputs,
          verified ? /^reason_code=review_lease_active$/m : /^reason_code=unknown_failure$/m,
        );
        if (verified) assert.ok(outputs.includes("retry_at=" + retryAt));
        else assert.doesNotMatch(outputs, /^retry_at=/m);
        if (batch) {
          const outcome = JSON.parse(readFileSync(mutation, "utf8"));
          if (verified)
            assert.deepEqual(outcome, {
              kind: "retryable_failure",
              reasonCode: "review_lease_active",
              retryAt,
            });
          else {
            assert.equal(outcome.kind, "permanent_failure");
            assert.equal(outcome.reasonCode, "unknown_failure");
            assert.equal(outcome.retryAt, undefined);
          }
          assert.equal(outcome.plan, undefined);
        } else assert.equal(existsSync(mutation), false);
        assert.equal(
          existsSync(join(root, ".artifacts/event-record-snapshot/candidate/items/74.md")),
          true,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
