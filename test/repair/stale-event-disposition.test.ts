import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  staleEventDisposition,
  staleEventDispositionOutputLines,
} from "../../dist/repair/stale-event-disposition.js";

test("stale event dispositions are terminal, never retry-the-same-artifact", () => {
  assert.deepEqual(staleEventDisposition("remote-newer"), {
    detail: "current state has a newer tuple",
    requeueLatest: true,
    terminalClosed: false,
    terminalMissing: false,
  });
  assert.deepEqual(staleEventDisposition("remote-closed"), {
    detail: "current state is already closed",
    requeueLatest: false,
    terminalClosed: true,
    terminalMissing: false,
  });
  assert.deepEqual(staleEventDisposition("missing"), {
    detail: "the event produced no record tuple",
    requeueLatest: false,
    terminalClosed: false,
    terminalMissing: true,
  });
});

test("stale event disposition output lines match the workflow contract", () => {
  const lines = staleEventDispositionOutputLines(staleEventDisposition("remote-newer"));
  assert.ok(lines.includes("requeue_latest=true"));
  assert.ok(lines.includes("terminal_closed=false"));
  assert.ok(lines.includes("terminal_missing=false"));
  assert.ok(lines.includes("remote_tuple_verified=false"));
  const closed = staleEventDispositionOutputLines(staleEventDisposition("remote-closed"));
  assert.ok(closed.includes("terminal_closed=true"));
  assert.ok(closed.includes("requeue_latest=false"));
});

test("publish-event-result exits terminally on a stale preflight instead of throwing", () => {
  // The workflow classifier treats an unset disposition as failure -> infinite
  // requeue of the same stale artifact (2026-07-16 poison cohort). Guard the
  // contract at the source level.
  const source = readFileSync("src/repair/publish-event-result.ts", "utf8");
  const preflightBlock = source.slice(
    source.indexOf('preflightResult === "remote-closed"'),
    source.indexOf("const actions = readApplyActions"),
  );
  assert.ok(preflightBlock.includes("writeStaleEventDispositionOutputs"));
  assert.match(preflightBlock, /if \(options\.batchMutationOutput\)\s+writeBatchMutationResult/);
  assert.doesNotMatch(
    preflightBlock,
    /options\.batchMutationOutput && preflightResult !== "missing"/,
  );
  assert.ok(!preflightBlock.includes("throw new Error"));
});

for (const artifactDir of ["artifacts/event", ".artifacts/exact-review-bundle/review"]) {
  test(`manual artifact scope remains narrow in ${artifactDir}`, () => {
    for (const extra of ["metrics", "sibling", "directory"] as const) {
      const root = mkdtempSync(join(tmpdir(), "manual-artifact-scope-"));
      try {
        const artifacts = join(root, artifactDir);
        mkdirSync(artifacts, { recursive: true });
        writeFileSync(
          join(artifacts, "74.md"),
          "---\npublication_policy: record_comment_only\n---\nReport\n",
        );
        if (extra === "directory") mkdirSync(join(artifacts, "review-cache-metrics.json"));
        else
          writeFileSync(
            join(artifacts, extra === "metrics" ? "review-cache-metrics.json" : "75.md"),
            "{}",
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
              ...(artifactDir === "artifacts/event"
                ? {}
                : { EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR: artifactDir }),
              CLAWSWEEPER_CODE_ROOT: process.cwd(),
              EXACT_REVIEW_DECISION: JSON.stringify({
                sourceAction: "manual_explicit_review",
                publicationPolicy: "record_comment_only",
              }),
            },
            encoding: "utf8",
          },
        );
        assert.equal(result.status, 1);
        if (extra === "metrics") {
          assert.doesNotMatch(result.stderr, /artifact directory must contain only/);
          assert.match(result.stderr, /manual publication requires/);
        } else {
          assert.match(result.stderr, /artifact directory must contain only/);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
}

test("publisher snapshots the selected work root instead of the caller directory", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-work-root-"));
  try {
    const work = join(root, "work");
    const caller = join(root, "caller");
    const code = join(root, "code");
    const artifacts = join(work, ".artifacts/exact-review-bundle/review");
    mkdirSync(artifacts, { recursive: true });
    mkdirSync(caller);
    mkdirSync(join(code, "dist"), { recursive: true });
    const report =
      "---\nnumber: 74\nrepository: openclaw/openclaw\ntype: issue\nreviewed_at: 2026-09-07T00:00:00Z\ndecision: keep_open\n---\nReport\n";
    writeFileSync(join(artifacts, "74.md"), report);
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
} else {
  console.error("scoped apply reached");
  process.exitCode = 23;
}
`,
    );
    const result = spawnSync(process.execPath, [resolve("dist/repair/publish-event-result.js")], {
      cwd: caller,
      env: {
        PATH: process.env.PATH,
        TARGET_REPO: "openclaw/openclaw",
        ITEM_NUMBER: "74",
        EXACT_REVIEW_WORK_ROOT: work,
        CLAWSWEEPER_CODE_ROOT: code,
        EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR: ".artifacts/exact-review-bundle/review",
        EXACT_REVIEW_BATCH_MUTATION_OUTPUT: ".artifacts/result.json",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /scoped apply reached/);
    assert.doesNotMatch(result.stdout, /event produced no record tuple/);
    assert.equal(
      readFileSync(join(work, ".artifacts/event-record-snapshot/candidate/items/74.md"), "utf8"),
      report,
    );
    assert.equal(existsSync(join(caller, "records")), false);
    assert.equal(existsSync(join(work, ".artifacts/result.json")), true);
    assert.equal(existsSync(join(caller, ".artifacts")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-authority refusal output stays inside the selected work root", () => {
  const root = mkdtempSync(join(tmpdir(), "publication-refusal-root-"));
  try {
    const work = join(root, "work");
    const caller = join(root, "caller");
    mkdirSync(join(work, "artifacts/event"), { recursive: true });
    mkdirSync(caller);
    writeFileSync(
      join(work, "artifacts/event/74.md"),
      "---\npublication_policy: record_comment_only\n---\nReport\n",
    );
    const result = spawnSync(process.execPath, [resolve("dist/repair/publish-event-result.js")], {
      cwd: caller,
      env: {
        PATH: process.env.PATH,
        TARGET_REPO: "openclaw/openclaw",
        ITEM_NUMBER: "74",
        EXACT_REVIEW_WORK_ROOT: work,
        CLAWSWEEPER_CODE_ROOT: process.cwd(),
        EXACT_REVIEW_BATCH_MUTATION_OUTPUT: ".artifacts/refusal.json",
        EXACT_REVIEW_DECISION: JSON.stringify({
          sourceAction: "manual_explicit_review",
          publicationPolicy: "record_comment_only",
        }),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manual publication requires/);
    assert.equal(
      JSON.parse(readFileSync(join(work, ".artifacts/refusal.json"), "utf8")).kind,
      "permanent_failure",
    );
    assert.equal(existsSync(join(caller, ".artifacts")), false);
    assert.equal(existsSync(join(work, "records")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent event report preserves ordinary terminal behavior and refuses restricted hydrated reuse", () => {
  for (const restricted of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "missing-publication-"));
    try {
      const oldPath = join(root, "records/openclaw-openclaw/items/74.md");
      mkdirSync(join(root, "records/openclaw-openclaw/items"), { recursive: true });
      const old = "---\npublication_policy: record_comment_only\n---\nOld canonical report\n";
      writeFileSync(oldPath, old);
      const oldApply = join(root, ".artifacts/event-apply-report.json");
      mkdirSync(join(root, ".artifacts"), { recursive: true });
      writeFileSync(oldApply, "stale apply outcome");
      const output = join(root, "output");
      const mutation = join(root, "mutation.json");
      const env = {
        PATH: process.env.PATH,
        TARGET_REPO: "openclaw/openclaw",
        ITEM_NUMBER: "74",
        EXACT_REVIEW_WORK_ROOT: root,
        CLAWSWEEPER_CODE_ROOT: process.cwd(),
        EXACT_REVIEW_BATCH_MUTATION_OUTPUT: mutation,
        GITHUB_OUTPUT: output,
        EXACT_REVIEW_DECISION: JSON.stringify({
          sourceAction: restricted ? "manual_explicit_review" : "opened",
          ...(restricted ? { publicationPolicy: "record_comment_only" } : {}),
        }),
      };
      const result = spawnSync(process.execPath, [resolve("dist/repair/publish-event-result.js")], {
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, restricted ? 1 : 0, result.stderr);
      assert.doesNotMatch(result.stderr, /ENOENT/);
      const disposition = JSON.parse(readFileSync(mutation, "utf8"));
      assert.equal(disposition.kind, restricted ? "permanent_failure" : "superseded");
      if (restricted) {
        assert.equal(disposition.reasonCode, "missing_record_tuple");
        assert.match(readFileSync(output, "utf8"), /^reason_code=missing_record_tuple$/m);
      } else {
        assert.match(readFileSync(output, "utf8"), /terminal_missing=true/);
        assert.equal(existsSync(oldApply), false);
      }
      assert.equal(readFileSync(oldPath, "utf8"), old);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
