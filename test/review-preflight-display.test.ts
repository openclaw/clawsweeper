import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withLocalPreflightSource } from "../dist/review-preflight-display.js";
import { serializeReviewPreflightPayload } from "../dist/review-preflight-contract.js";
import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import { reportReviewDecision } from "../dist/report-review-decision.js";
import { withReviewRecord } from "./helpers.ts";

test("local source display uses the real merge base and never projects contributor fields", (t) => {
  const targetDir = mkdtempSync(join(tmpdir(), "preflight-display-"));
  t.after(() => rmSync(targetDir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: targetDir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Source fixture");
  git("config", "user.email", "source@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "pull head");
  const head = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", base);
  git("commit", "--allow-empty", "-qm", "advanced target");
  const targetTip = git("rev-parse", "HEAD");
  const payload = {
    v: 1 as const,
    repo: "owner/project",
    base,
    head,
    tool: { name: "private-tool", version: "private-version" },
    completion: "failed" as const,
    summary: "<script>private-summary</script> --> [private](https://example.invalid/private)",
    report_sha256: "d".repeat(64),
  };
  const pull = {
    number: 12,
    body: `Human evidence\n\n${serializeReviewPreflightPayload(payload)}\n`,
    base: { sha: targetTip, repo: { full_name: "Owner/Project" } },
    head: { sha: head, repo: { full_name: "fork-owner/project" } },
  };
  const observation = { repo: "owner/project", number: 12, targetDir, pull };
  const report = withReviewRecord(
    `---\nrepository: owner/project\nnumber: 12\ntype: pull_request\npull_head_sha: ${head}\nreview_status: complete\n---\n## Summary\n\nNative review.\n`,
    { decision: "keep_open", closeReason: "none", summary: "Native review." },
  );
  const before = JSON.stringify(observation);
  const shown = withLocalPreflightSource(report, observation);
  assert.match(shown, /Source matches\./);
  assert.match(shown, /Completion is self-reported/);
  assert.match(shown, /report bytes are not verified/);
  for (const secret of [
    "private-tool",
    "private-version",
    "private-summary",
    payload.report_sha256,
  ])
    assert.equal(shown.includes(secret), false);
  assert.equal(JSON.stringify(observation), before);
  assert.deepEqual(reportReviewDecision(shown), reportReviewDecision(report));
  assert.equal(
    renderReviewCommentFromReport(shown, "none"),
    renderReviewCommentFromReport(report, "none"),
  );
  assert.equal(withLocalPreflightSource(shown, observation), shown);
  assert.equal(withLocalPreflightSource(shown), report);
  for (const completion of ["complete", "partial", "failed"] as const) {
    assert.equal(
      withLocalPreflightSource(report, {
        ...observation,
        pull: { ...pull, body: serializeReviewPreflightPayload({ ...payload, completion }) },
      }),
      shown,
    );
  }

  for (const change of [{ repo: "private/other" }, { base: targetTip }, { head: base }]) {
    const changed = { ...pull, body: serializeReviewPreflightPayload({ ...payload, ...change }) };
    const stale = withLocalPreflightSource(shown, { ...observation, pull: changed });
    assert.match(stale, /Source stale\./);
    assert.doesNotMatch(stale, /Source matches\.|private\/other/);
    assert.equal(stale.match(/## Local preflight source/g)?.length, 1);
  }

  const unknownPulls = [
    { ...pull, number: 13 },
    { ...pull, base: { ...pull.base, repo: { full_name: "private/other" } } },
    { ...pull, base: { sha: targetTip } },
    { ...pull, head: { sha: "b".repeat(64) } },
    { ...pull, body: "No summary" },
    { ...pull, body: `${pull.body}\n${pull.body}` },
    { ...pull, body: pull.body.replace("preflight:v1", "preflight:v2") },
    { ...pull, body: `\`\`\`\n${pull.body}\n\`\`\`` },
    {
      ...pull,
      body: serializeReviewPreflightPayload({ ...payload, summary: "💥".repeat(128) }) + "x",
    },
  ];
  for (const changed of unknownPulls) {
    const unknown = withLocalPreflightSource(shown, { ...observation, pull: changed });
    assert.match(unknown, /Source unknown\./);
    assert.doesNotMatch(unknown, /Source matches\.|private\/other/);
  }
  assert.match(
    withLocalPreflightSource(report.replace(head, base), observation),
    /Source unknown\./,
  );
  assert.match(
    withLocalPreflightSource(report.replace("number: 12", "number: 13"), observation),
    /Source unknown\./,
  );
  assert.match(
    withLocalPreflightSource(
      report.replace("repository: owner/project", "repository: other/project"),
      observation,
    ),
    /Source unknown\./,
  );
  assert.match(
    withLocalPreflightSource(shown, { ...observation, targetDir: join(targetDir, "absent") }),
    /Source unknown\./,
  );
  const tree = git("rev-parse", `${base}^{tree}`);
  const left = git("commit-tree", tree, "-p", head, "-p", targetTip, "-m", "left merge");
  const right = git("commit-tree", tree, "-p", targetTip, "-p", head, "-m", "right merge");
  assert.match(
    withLocalPreflightSource(report.replace(head, right), {
      ...observation,
      pull: { ...pull, base: { ...pull.base, sha: left }, head: { sha: right } },
    }),
    /Source unknown\./,
  );
  writeFileSync(join(targetDir, ".git", "shallow"), `${head}\n`);
  assert.match(withLocalPreflightSource(shown, observation), /Source unknown\./);
});
