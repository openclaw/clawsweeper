import { assertMatchesJsonSchema } from "../scripts/hosted-review-canary-proof.mjs";
import { parseDecision } from "../dist/clawsweeper.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateOversizedPullRequest,
  maxPrChangedLines,
  oversizedPullRequestDecision,
  oversizedPullRequestComment,
  parseOversizedPullRequestEvidence,
} from "../dist/clawsweeper-oversized-pr-policy.js";
import { ALLOWED_REASONS } from "../dist/clawsweeper-policy.js";
import { closeReasonsArg, closeReasonEnabled } from "../dist/clawsweeper-item-policy.js";
import { PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES } from "../dist/repair/exact-review-guard-labels.js";
import {
  closeDecision,
  promotionGhMock,
  runOpenClawApplyDecisionsForTest,
  withApplyTestWorkspace,
  withMockGh,
} from "./helpers.ts";

const size = {
  additions: 45791,
  deletions: 120895,
  changedFiles: 2747,
  threshold: 30000,
  head: "b".repeat(40),
};
const pull = {
  number: 141913,
  title: "Synthetic size policy PR",
  state: "open",
  locked: false,
  additions: size.additions,
  deletions: size.deletions,
  changed_files: size.changedFiles,
  head: { sha: size.head },
  base: { ref: "main", sha: "a".repeat(40) },
  user: { login: "synthetic-owner" },
  author_association: "OWNER",
  draft: true,
  created_at: "2026-02-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
  labels: [],
};

test("oversized PR predicate boundaries, missing metadata, exemptions and threshold configuration", () => {
  for (const total of [29999, 30000, 30001]) {
    assert.equal(
      evaluateOversizedPullRequest({ ...size, additions: total, deletions: 0 }).admitted,
      total <= 30000,
    );
  }
  for (const key of ["additions", "deletions", "changedFiles", "head"]) {
    assert.equal(evaluateOversizedPullRequest({ ...size, [key]: undefined }).admitted, true);
  }
  for (const label of [...PR_AUTO_CLOSE_EXEMPT_LABEL_NAMES, "size: accepted-large"]) {
    assert.equal(
      evaluateOversizedPullRequest({ ...size, labels: [{ name: ` ${label.toUpperCase()} ` }] })
        .admitted,
      true,
    );
  }
  for (const invalid of [undefined, "", "0", "-1", "1.5", "NaN", "1e5", "9007199254740992"]) {
    assert.equal(maxPrChangedLines({ CLAWSWEEPER_MAX_PR_CHANGED_LINES: invalid }), 30000);
  }
  assert.equal(maxPrChangedLines({ CLAWSWEEPER_MAX_PR_CHANGED_LINES: "12345" }), 12345);
  assert.equal(evaluateOversizedPullRequest({ ...size, threshold: 200000 }).admitted, true);
  assert.equal(ALLOWED_REASONS.has("oversized_pull_request"), true);
  assert.equal(closeReasonEnabled("oversized_pull_request", closeReasonsArg("all")), true);
  const schema = JSON.parse(readFileSync("schema/clawsweeper-decision.schema.json", "utf8"));
  assert.ok(schema.properties.closeReason.enum.includes("oversized_pull_request"));
  const schemaDecision = closeDecision({
    closeReason: "oversized_pull_request",
    nextStep: { kind: "none", text: "" },
  });
  assertMatchesJsonSchema(
    JSON.parse(JSON.stringify(schemaDecision.closeReason)),
    schema.properties.closeReason,
  );
  assert.equal(
    parseDecision(JSON.parse(JSON.stringify(schemaDecision))).closeReason,
    "oversized_pull_request",
  );
  for (const threshold of [undefined, null, 0, -1, "30000", 1.5]) {
    assert.equal(parseOversizedPullRequestEvidence({ ...size, threshold }), null);
  }
  const decision = oversizedPullRequestDecision(size);
  assert.deepEqual(
    parseOversizedPullRequestEvidence(JSON.stringify(decision.oversizedPullRequest)),
    size,
  );
  assert.equal(decision.localCheckoutAccess, undefined);
  assert.ok(oversizedPullRequestComment(size).split(/\s+/).length <= 120);
  assert.match(
    decision.closeComment,
    /166,686 lines \(45,791 added, 120,895 removed\) across 2,747 files/,
  );
});

for (const scenario of [
  "disabled",
  "dry-run",
  "close",
  "exact-close",
  "under-limit",
  "exempt",
  "head-drift",
  "late-under-limit",
  "late-exempt",
  "close-error",
  "notice-error",
] as const) {
  test(`built review and apply size policy: ${scenario}`, () => {
    withApplyTestWorkspace(join(process.env.TMPDIR || "/tmp", "oversized-pr-"), (workspace) => {
      const admissionPath = join(workspace.root, "admission.json");
      writeFileSync(admissionPath, JSON.stringify({ repo: "openclaw/openclaw", pull }));
      const calls = join(workspace.root, "calls.log");
      const commandLog = join(workspace.root, "commands.log");
      const previousGate = process.env.CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED;
      process.env.CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED =
        scenario === "disabled" ? "false" : "true";
      try {
        withMockGh(
          workspace.root,
          'throw new Error("review must not call GitHub after admission handoff")',
          () => {
            execFileSync(
              process.execPath,
              [
                "dist/clawsweeper.js",
                "review",
                "--target-repo",
                "openclaw/openclaw",
                "--item-number",
                String(pull.number),
                "--pr-admission-file",
                admissionPath,
                "--artifact-dir",
                workspace.itemsDir,
                "--skip-start-comment",
              ],
              { stdio: "pipe" },
            );
          },
        );
        const report = join(workspace.itemsDir, `${pull.number}.md`);
        const markdown = readFileSync(report, "utf8");
        assert.match(markdown, /action_taken: proposed_close/);
        assert.match(markdown, /review_model: none/);
        assert.match(markdown, /local_checkout_access: unverified/);
        assert.match(markdown, /oversized_pull_request: /);
        const mock = promotionGhMock({
          number: pull.number,
          comment: "",
          comments: [],
          labels: scenario === "exempt" ? ["size: accepted-large"] : [],
          authorAssociation: "OWNER",
          headSha: scenario === "head-drift" ? "c".repeat(40) : size.head,
          changedFiles: size.changedFiles,
          additions: scenario === "under-limit" ? 29999 : size.additions,
          deletions: scenario === "under-limit" ? 0 : size.deletions,
          pullAfterCommentWrite:
            scenario === "late-under-limit"
              ? { additions: 29999, deletions: 0 }
              : scenario === "late-exempt"
                ? { labels: ["size: accepted-large"] }
                : {},
          commandLogPath: commandLog,
          commentWriteLogPath: calls,
          commentWriteErrorAfterClose:
            scenario === "notice-error" ? "synthetic notice update rejection" : "",
          closeCommandLogPath: calls,
          closeCommandError: scenario === "close-error" ? "synthetic close rejection" : "",
        });
        withMockGh(workspace.root, mock, () => {
          const apply = () =>
            runOpenClawApplyDecisionsForTest({
              ...workspace,
              dryRun: scenario === "dry-run",
              extraArgs: [
                "--skip-dashboard",
                "--item-number",
                String(pull.number),
                "--min-age-minutes",
                "0",
                ...(scenario === "exact-close" ? ["--exact-event-publication"] : []),
              ],
            });
          if (scenario === "close-error") assert.throws(apply);
          else apply();
        });
        const result = existsSync(workspace.reportPath)
          ? JSON.parse(readFileSync(workspace.reportPath, "utf8"))
          : [];
        if (existsSync(commandLog))
          assert.doesNotMatch(
            readFileSync(commandLog, "utf8"),
            /\/pulls\/141913\/(files|commits|reviews|comments)|check-runs|git\/blobs/,
          );
        const mutations = existsSync(calls) ? readFileSync(calls, "utf8") : "";
        if (scenario === "close" || scenario === "exact-close" || scenario === "notice-error") {
          assert.ok(
            existsSync(join(workspace.closedDir, `${pull.number}.md`)),
            JSON.stringify(result),
          );
          assert.equal(existsSync(report), false);
          const currentComment = JSON.parse(
            readFileSync(join(workspace.root, `comment-state-${pull.number}.json`), "utf8"),
          );
          assert.match(
            currentComment.body,
            scenario === "notice-error"
              ? /ClawSweeper proposes closing this pull request/
              : /ClawSweeper closed this pull request/,
          );
          assert.doesNotMatch(currentComment.body, /did not apply/);
          assert.equal(
            mutations.split("\n").filter((line) => line.includes("pr close")).length,
            1,
            mutations,
          );
          assert.equal(
            mutations
              .split("\n")
              .filter((line) => line.includes("comments") && line.includes("POST")).length,
            1,
            mutations,
          );
        } else {
          assert.ok(existsSync(report), JSON.stringify(result));
          assert.equal(existsSync(join(workspace.closedDir, `${pull.number}.md`)), false);
          if (scenario.startsWith("late-") || scenario === "close-error") {
            assert.equal(
              mutations
                .split("\n")
                .filter((line) => line.includes("comments") && line.includes("POST")).length,
              1,
              mutations,
            );
            if (scenario !== "close-error") assert.doesNotMatch(mutations, /pr close/);
            const currentComment = JSON.parse(
              readFileSync(join(workspace.root, `comment-state-${pull.number}.json`), "utf8"),
            );
            assert.match(currentComment.body, /ClawSweeper proposes closing this pull request/);
            assert.doesNotMatch(currentComment.body, /ClawSweeper closed this pull request/);
          } else assert.equal(mutations, "");
          assert.match(readFileSync(report, "utf8"), /decision: close/);
        }
      } finally {
        if (previousGate === undefined) delete process.env.CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED;
        else process.env.CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED = previousGate;
      }
    });
  });
}
