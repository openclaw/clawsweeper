import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const executor = path.join(process.cwd(), "dist/repair/execute-fix-artifact.js");

test("execute-fix CLI defers outcome publication until fresh-token invocation", () => {
  const fixture = runPublicationFixture(false);
  try {
    assert.equal(fs.readFileSync(fixture.tokenLog, "utf8"), "fresh-token\n");
    assert.equal(fs.existsSync(fixture.dispatchLog), false);
    assert.equal(fixture.report.actions.at(-1)?.action, "automerge_repair_outcome_comment");
    assert.equal(fixture.report.actions.at(-1)?.status, "executed");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("no-op automerge continuation dispatches with its trusted status identity", () => {
  const fixture = runPublicationFixture(true);
  try {
    assert.equal(fs.readFileSync(fixture.tokenLog, "utf8"), "fresh-token\n");
    const dispatch = JSON.parse(fs.readFileSync(fixture.dispatchLog, "utf8"));
    assert.equal(dispatch.client_payload.source_action, "branch_repaired");
    assert.equal(dispatch.client_payload.command_status_marker, fixture.commandStatusMarker);
    assert.equal(dispatch.client_payload.status_comment_id, 9001);
    assert.equal(Object.hasOwn(dispatch.client_payload, "source_head_sha"), false);
    assert.equal(fixture.report.actions.at(-1)?.action, "automerge_repair_outcome_comment");
    assert.equal(fixture.report.actions.at(-1)?.status, "updated");
    assert.equal(
      fixture.report.actions.at(-1)?.automerge_continuation?.review_dispatch?.status,
      "executed",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function runPublicationFixture(reviewPending: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publication-cli-"));
  const binDir = path.join(root, "bin");
  const jobPath = path.join(root, "job.md");
  const resultPath = path.join(root, "result.json");
  const reportPath = path.join(root, "fix-execution-report.json");
  const tokenLog = path.join(root, "outcome-tokens.log");
  const commentLog = path.join(root, "comment-bodies.jsonl");
  const dispatchLog = path.join(root, "review-dispatch.json");
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:494:automerge:0123456789abcdef0123456789abcdef01234567 -->";
  const statusComment = {
    id: 9001,
    user: { login: "clawsweeper[bot]" },
    body: [
      "<!-- clawsweeper-command-status:999:automerge:wrong-pr -->",
      "<!-- clawsweeper-command-status:494:re_review:wrong-intent -->",
      commandStatusMarker,
      "Repair in progress.",
    ].join("\n"),
  };
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    jobPath,
    `---\nrepo: openclaw/clawsweeper\ncluster_id: automerge-openclaw-clawsweeper-494\nmode: autonomous\nsource: pr_automerge\nallowed_actions: [comment]\ncandidates: [#494]\ncanonical: [#494]\n---\nfixture\n`,
  );
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({
      repo: "openclaw/clawsweeper",
      cluster_id: "automerge-openclaw-clawsweeper-494",
      mode: "autonomous",
      canonical_pr: "https://github.com/openclaw/clawsweeper/pull/494",
      reviewed_sha: "a".repeat(40),
      fix_artifact: {
        source_prs: ["https://github.com/openclaw/clawsweeper/pull/494"],
      },
      actions: [],
    })}\n`,
  );
  const ghPath = path.join(binDir, "gh.mjs");
  fs.writeFileSync(
    ghPath,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'const rendered = args.join(" ");',
      'if (rendered.includes("issues/494/comments?per_page=100")) {',
      `  process.stdout.write(${JSON.stringify(`${JSON.stringify(reviewPending ? [statusComment] : [])}\n`)});`,
      '} else if (args[0] === "pr" && args[1] === "view" && args[2] === "494") {',
      `  process.stdout.write(${JSON.stringify(`{"state":"${reviewPending ? "OPEN" : "CLOSED"}","headRefOid":"${"a".repeat(40)}","statusCheckRollup":[]}\n`)});`,
      '} else if (args[0] === "api" && args[1] === "repos/openclaw/clawsweeper/dispatches") {',
      '  const input = args[args.indexOf("--input") + 1];',
      '  appendFileSync(process.env.DISPATCH_LOG, readFileSync(input, "utf8"));',
      '} else if ((rendered.includes("issues/comments/9001") && args.includes("PATCH")) || (rendered.includes("issues/494/comments") && args.includes("POST"))) {',
      '  appendFileSync(process.env.TOKEN_LOG, `${process.env.GH_TOKEN ?? ""}\\n`);',
      '  const input = args[args.indexOf("--input") + 1];',
      '  appendFileSync(process.env.COMMENT_LOG, `${JSON.stringify(JSON.parse(readFileSync(input, "utf8")))}\\n`);',
      "} else {",
      "  process.stderr.write(`unexpected gh args: ${rendered}\\n`);",
      "  process.exit(1);",
      "}",
    ].join("\n"),
    { mode: 0o755 },
  );
  const baseEnv = {
    ...process.env,
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([ghPath]),
    CLAWSWEEPER_ALLOW_EXECUTE: "1",
    CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
    CLAWSWEEPER_MODEL: "fixture-model",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ID: "123",
    DISPATCH_LOG: dispatchLog,
    TOKEN_LOG: tokenLog,
    COMMENT_LOG: commentLog,
  };

  runExecutor([jobPath, resultPath, "--defer-publication"], {
    ...baseEnv,
    GH_TOKEN: "expired-token",
  });
  assert.equal(fs.existsSync(reportPath), true);
  if (reviewPending) {
    assert.equal(fs.readFileSync(tokenLog, "utf8"), "expired-token\n");
    const progress = JSON.parse(fs.readFileSync(commentLog, "utf8"));
    assert.match(progress.body, /repair started/);
    assert.doesNotMatch(progress.body, /<!-- clawsweeper-repair-outcome:/);
    fs.rmSync(tokenLog);
  } else {
    assert.equal(fs.existsSync(tokenLog), false);
  }
  assert.equal(fs.existsSync(dispatchLog), false);

  runExecutor([jobPath, resultPath, "--publish-report-only"], {
    ...baseEnv,
    GH_TOKEN: "fresh-token",
  });
  const lastComment = JSON.parse(fs.readFileSync(commentLog, "utf8").trim().split("\n").at(-1)!);
  assert.match(lastComment.body, /<!-- clawsweeper-repair-outcome:/);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  return { root, tokenLog, dispatchLog, commandStatusMarker, report };
}

function runExecutor(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawnSync(process.execPath, [executor, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
}
