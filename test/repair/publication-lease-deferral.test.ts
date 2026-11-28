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

test("guarded and closed publications release the producer's review banner", (t) => {
  const root = mkdtempSync(join(tmpdir(), "guarded-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = join(root, "artifacts/event");
  const code = join(root, "code");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(join(code, "dist"), { recursive: true });
  const number = "129388";
  const repo = "openclaw/openclaw";
  const owner = "github-run-46053739737-1";
  const commentId = "5442236054";
  const itemKey = `${repo}#${number}`;
  writeFileSync(
    join(artifacts, `${number}.md`),
    [
      "---",
      `number: ${number}`,
      `repository: ${repo}`,
      "type: pull_request",
      "reviewed_at: 2026-11-27T19:02:28Z",
      "item_updated_at: 2026-11-27T19:02:23Z",
      "pull_head_sha: " + "a".repeat(40),
      "item_source_revision: " + "b".repeat(64),
      `review_lease_owner: ${owner}`,
      `review_lease_comment_id: ${commentId}`,
      "action_taken: proposed_close",
      "decision: close",
      "---",
      "Oversized PR",
      "",
    ].join("\n"),
  );
  // Replay the apply outcome from the recovery run through the production publisher.
  writeFileSync(
    join(code, "dist/clawsweeper.js"),
    `
const fs = require("node:fs");
const path = require("node:path");
const [command, ...args] = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const report = ${JSON.stringify(number + ".md")};
if (command === "apply-artifacts") {
  fs.mkdirSync(value("--items-dir"), { recursive: true });
  fs.copyFileSync(path.join(value("--artifact-dir"), report), path.join(value("--items-dir"), report));
} else if (command === "apply-decisions") {
  const item = path.join(value("--items-dir"), report);
  const closed = process.env.ITEM_CLOSED === "true";
  const action = closed ? "skipped_already_closed" : "skipped_protected_label";
  fs.writeFileSync(item, fs.readFileSync(item, "utf8").replace("action_taken: proposed_close", "action_taken: " + action));
  if (closed) {
    fs.mkdirSync(value("--closed-dir"), { recursive: true });
    fs.renameSync(item, path.join(value("--closed-dir"), report));
  }
  fs.mkdirSync(path.dirname(value("--report-path")), { recursive: true });
  fs.writeFileSync(value("--report-path"), JSON.stringify([{ number: ${number}, action, guardedOpenStateVerified: !closed, terminalStateVerified: closed }]));
} else if (command === "expire-review-lease") {
  fs.writeFileSync("released.json", JSON.stringify(args));
  if (process.env.CLEANUP_ERROR) throw new Error(process.env.CLEANUP_ERROR);
} else throw new Error("unexpected command: " + command);
`,
  );
  const publish = (cleanupError = "", closed = false) => {
    rmSync(join(root, "records"), { recursive: true, force: true });
    return spawnSync(process.execPath, [resolve("dist/repair/publish-event-result.js")], {
      env: {
        ITEM_CLOSED: String(closed),
        CLEANUP_ERROR: cleanupError,
        PATH: process.env.PATH,
        TARGET_REPO: repo,
        ITEM_NUMBER: number,
        EXACT_REVIEW_WORK_ROOT: root,
        CLAWSWEEPER_CODE_ROOT: code,
        EXACT_EVENT_PUBLICATION: "true",
        EXACT_REVIEW_BATCH_MUTATION_OUTPUT: join(root, "outcome.json"),
        EXACT_REVIEW_BATCH_ITEM_KEY: itemKey,
        EXACT_REVIEW_BATCH_REVISION: "699",
        EXACT_REVIEW_BATCH_CLAIM_GENERATION: "1",
      },
      encoding: "utf8",
    });
  };
  const result = publish();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(root, "outcome.json"), "utf8")).disposition.guardedOpenAction,
    "skipped_protected_label",
  );
  assert.ok(
    existsSync(join(root, "released.json")),
    "the guarded publication left the start banner on the old verdict",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(root, "released.json"), "utf8")), [
    "--repo",
    repo,
    "--item-number",
    number,
    "--comment-id",
    commentId,
    "--release-owner",
    owner,
  ]);
  rmSync(join(root, "released.json"));
  const closed = publish("", true);
  assert.equal(closed.status, 0, closed.stderr);
  assert.ok(existsSync(join(root, "released.json")), "closed PR kept its review lease");
  for (const terminalSkip of ["GitHub API HTTP 404;", "HTTP 403: conversation is locked"]) {
    const skipped = publish(terminalSkip);
    assert.equal(skipped.status, 0, skipped.stderr);
  }
  const transient = publish("HTTP 503 Service Unavailable");
  assert.notEqual(transient.status, 0);
  assert.equal(
    JSON.parse(readFileSync(join(root, "outcome.json"), "utf8")).reasonCode,
    "github_transient",
  );
});
