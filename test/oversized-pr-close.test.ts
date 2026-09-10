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
  threshold: 50000,
  head: "b".repeat(40),
};
const pull = {
  number: 141913,
  title: "Synthetic size policy PR",
  body: "Synthetic size policy body",
  comments: 0,
  review_comments: 0,
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
  for (const total of [49999, 50000, 50001]) {
    assert.equal(
      evaluateOversizedPullRequest({ ...size, additions: total, deletions: 0 }).admitted,
      total <= 50000,
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
    assert.equal(maxPrChangedLines({ CLAWSWEEPER_MAX_PR_CHANGED_LINES: invalid }), 50000);
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
  for (const threshold of [undefined, null, 0, -1, "50000", 1.5]) {
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
  "durable-missing-lease",
  "durable-reserved-lease",
  "under-limit",
  "exempt",
  "head-drift",
  "late-under-limit",
  "late-exempt",
  "late-body",
  "late-human-comment",
  "close-error",
  "notice-error",
] as const) {
  test(`built review and apply size policy: ${scenario}`, () => {
    withApplyTestWorkspace(join(process.env.TMPDIR || "/tmp", "oversized-pr-"), (workspace) => {
      const admissionPath = join(workspace.root, "admission.json");
      const reservedAt = new Date(Date.now() - 10_000).toISOString();
      const lease = {
        id: 5602217053,
        body: `Review started.\n\n<!-- clawsweeper-review-status:started item=${pull.number} sha=${size.head} started_at=${reservedAt} lease_expires_at=${new Date(Date.now() + 600_000).toISOString()} owner=reserved v=1 -->\n<!-- clawsweeper-review-lease item=${pull.number} -->`,
        user: { login: "clawsweeper[bot]" },
        created_at: reservedAt,
        updated_at: reservedAt,
      };
      writeFileSync(
        admissionPath,
        JSON.stringify({
          repo: "openclaw/openclaw",
          pull: {
            ...pull,
            comments:
              scenario === "durable-reserved-lease"
                ? 2
                : scenario === "durable-missing-lease"
                  ? 1
                  : 0,
            updated_at: scenario === "durable-reserved-lease" ? reservedAt : pull.updated_at,
          },
          observedAt: new Date().toISOString(),
        }),
      );
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
                ...(scenario === "durable-reserved-lease"
                  ? ["--review-lease-owner", "reserved", "--review-lease-comment-id", "5602217053"]
                  : []),
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
          title: pull.title,
          body: pull.body,
          draft: pull.draft,
          trackCommentActivity: true,
          itemUpdatedAt: scenario === "durable-reserved-lease" ? reservedAt : pull.updated_at,
          comment: "",
          comments: scenario.startsWith("durable-")
            ? [
                {
                  id: 9000 + pull.number,
                  body: `Prior durable review\n\n<!-- clawsweeper-review-version item=${pull.number} reviewed_at=2026-05-01T00:00:00Z sha=${size.head} source_revision=${"a".repeat(64)} lease_owner=previous lease_comment_id=5602217052 v=1 -->\n\n<!-- clawsweeper-review item=${pull.number} -->`,
                  user: { login: "clawsweeper[bot]" },
                  created_at: "2026-05-01T00:00:00Z",
                  updated_at: "2026-05-01T00:00:00Z",
                },
                ...(scenario === "durable-reserved-lease" ? [lease] : []),
              ]
            : [],
          commentsAfterCommentWrite:
            scenario === "late-human-comment"
              ? [
                  {
                    id: 777,
                    body: "Human follow-up",
                    user: { login: "human" },
                    created_at: "2026-05-01T02:00:00Z",
                    updated_at: "2026-05-01T02:00:00Z",
                  },
                ]
              : undefined,
          labels: scenario === "exempt" ? ["size: accepted-large"] : [],
          authorAssociation: "OWNER",
          headSha: scenario === "head-drift" ? "c".repeat(40) : size.head,
          changedFiles: size.changedFiles,
          additions: scenario === "under-limit" ? 49999 : size.additions,
          deletions: scenario === "under-limit" ? 0 : size.deletions,
          pullAfterCommentWrite:
            scenario === "late-body"
              ? { body: "Human edited the PR body" }
              : scenario === "late-under-limit"
                ? { additions: 49999, deletions: 0 }
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
          apply();
        });
        const result = existsSync(workspace.reportPath)
          ? JSON.parse(readFileSync(workspace.reportPath, "utf8"))
          : [];
        if (existsSync(commandLog))
          assert.doesNotMatch(
            readFileSync(commandLog, "utf8"),
            /\/pulls\/141913\/(files|commits)|check-runs|git\/blobs/,
          );
        if (scenario === "durable-missing-lease") {
          assert.ok(
            result.some(
              (entry: any) =>
                entry.action === "skipped_stale_review_comment_sync" &&
                /no durable lease identity/.test(entry.reason),
            ),
            JSON.stringify(result),
          );
        }
        const mutations = existsSync(calls) ? readFileSync(calls, "utf8") : "";
        assert.ok(existsSync(report), JSON.stringify(result));
        assert.equal(existsSync(join(workspace.closedDir, `${pull.number}.md`)), false);
        assert.doesNotMatch(mutations, /pr close/);
        if (
          [
            "close",
            "exact-close",
            "durable-reserved-lease",
            "notice-error",
            "close-error",
          ].includes(scenario)
        ) {
          assert.ok(
            result.some(
              (entry: any) =>
                entry.action === "kept_open" && /queue-owned activity evidence/.test(entry.reason),
            ),
            JSON.stringify(result),
          );
          assert.ok(
            result.some((entry: any) => entry.action === "review_comment_synced"),
            JSON.stringify(result),
          );
          const commentState = JSON.parse(
            readFileSync(join(workspace.root, `comment-state-${pull.number}.json`), "utf8"),
          );
          assert.match(commentState.body, /ClawSweeper proposes closing/);
          assert.doesNotMatch(commentState.body, /ClawSweeper closed/);
        }
        assert.match(readFileSync(report, "utf8"), /decision: close/);
      } finally {
        if (previousGate === undefined) delete process.env.CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED;
        else process.env.CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED = previousGate;
      }
    });
  });
}
