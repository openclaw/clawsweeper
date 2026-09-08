import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";

import { readText } from "../helpers.ts";

function routerWorkflowSteps(source: string) {
  const workflow = parseYaml(source) as {
    jobs: Record<
      string,
      {
        steps?: Array<{
          name?: string;
          run?: string;
          env?: Record<string, string>;
        }>;
      }
    >;
  };
  return Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
}

test("comment router records receipts after durable command boundaries", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.match(source, /rawCommands\.push\(command\);\s+recordCommandReceived\(command\);/);
  assert.match(
    source,
    /writeLedger\(ledgerPath\(\), ledger\);\s+for \(const command of claimedCommands\) recordCommandClaimed\(command\);/,
  );
  assert.match(
    source,
    /writeLedger\(ledgerPath\(\), ledger\);\s+for \(const key of dispatchClaimLookupKeys\(claim\)\) priorDispatchClaims\.set\(key, claim\);\s+recordCommandClaimRefreshed\(claim\);/,
  );
  assert.match(
    source,
    /function executeCommandWithReceipt[\s\S]*executeCommand\(command\);\s+recordCommandOutcome\(command\);[\s\S]*recordCommandFailure\(command, error\);/,
  );
  assert.match(source, /await flushCommandActionEvents\(\);/);
});

test("comment router wraps every GitHub mutation at the request boundary", () => {
  const source = readText("src/repair/comment-router.ts");

  assert.doesNotMatch(source, /\bghText\(/);
  assert.equal(source.match(/\bghSpawn\(/g)?.length, 1);
  assert.doesNotMatch(source, /\bghBestEffort\b/);
  assert.doesNotMatch(source, /ghTextWithRetry as ghText/);
  assert.match(source, /function runGitHubTextMutation[\s\S]*runCommandMutationWithRetry/);
  assert.match(source, /ghTextWithRetry\(ghArgs, \{ \.\.\.runOptions, attempts: 1 \}\)/);
  assert.match(source, /ghTextWithRetry\(ghArgs, \{ \.\.\.options, attempts: 1 \}\)/);
  assert.match(source, /return ghRetryKind\(error\) === "transient"/);
  assert.match(source, /function runGitHubBestEffortMutation[\s\S]*runGitHubTextMutationOnce/);
  assert.match(source, /function runGitHubSpawnMutation[\s\S]*runCommandMutation/);
  assert.match(
    source,
    /const result = ghSpawn\(ghArgs, options\);\s*if \(result\.status !== 0 && ghRetryKind\(result\) === "throttle"\) \{\s*throw new GitHubRateLimitError\(result\);/,
  );
  for (const kind of [
    "label_create",
    "label_add",
    "label_remove",
    "description_update",
    "reaction_add",
    "reaction_delete",
    "ack_comment_update",
    "ack_comment_delete",
    "comment_create",
    "comment_update",
    "pull_request_close",
    "issue_close",
    "pull_request_merge",
    "review_dispatch",
    "assist_dispatch",
    "repair_dispatch",
  ]) {
    assert.match(source, new RegExp(`"${kind}"`), kind);
  }
});

test("router stops autoclose and reaction fan-out after the first GitHub throttle", () => {
  const source = readText("src/repair/comment-router.ts");
  for (const [name, expectedGuards] of [
    ["claimedDispatchState", 2],
    ["runGitHubBestEffortMutation", 1],
    ["executeAutoclose", 1],
    ["discoverAutocloseTargets", 1],
    ["fetchCollaboratorPermission", 1],
    ["fetchCollaboratorPermissionAsync", 1],
    ["convergePrecreatedCommandAckComments", 1],
    ["exactCommentVersionStillCurrent", 1],
    ["convergeExactCommentVersionFastPathAck", 1],
    ["reactToComment", 1],
    ["removeOwnCommentReaction", 2],
  ] as const) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    const remainder = source.slice(start + 1);
    const end = remainder.search(/\n(?:async )?function /);
    const body = end < 0 ? remainder : remainder.slice(0, end);
    assert.equal(
      body.match(/if \(error instanceof GitHubRateLimitError\) throw error;/g)?.length,
      expectedGuards,
      name,
    );
  }
  assert.match(
    source,
    /quotaExhausted = error instanceof GitHubRateLimitError;[\s\S]*?finally \{[\s\S]*?if \(!quotaExhausted\) clearTerminalMaintainerCommandReaction\(command\);/,
  );
});

test("comment router isolates public target reads from its GitHub App mutation identity", () => {
  const source = readText("src/repair/github-cli.ts");
  const publicReadSource = readText("src/github-public-read.ts");
  const workflow = readText(".github/workflows/repair-comment-router.yml");

  assert.equal(
    workflow.match(/CLAWSWEEPER_PUBLIC_GH_TOKEN: \$\{\{ github\.token \}\}/g)?.length,
    2,
  );
  assert.equal(
    workflow.match(/GH_TOKEN: \$\{\{ steps\.app_token\.outputs\.token \}\}/g)?.length,
    3,
  );
  const steps = routerWorkflowSteps(workflow);
  assert.deepEqual(
    steps
      .filter((step) => step.env?.GH_TOKEN === "${{ steps.app_token.outputs.token }}")
      .map((step) => step.name),
    [
      "Route ClawSweeper comments",
      "Reconcile explicitly requested behavioral proof",
      "Retry waiting repair dispatches",
    ],
  );
  assert.deepEqual(
    steps
      .filter((step) => step.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN === "${{ github.token }}")
      .map((step) => step.name),
    ["Route ClawSweeper comments", "Retry waiting repair dispatches"],
  );
  const proof = steps.find(
    (step) => step.name === "Reconcile explicitly requested behavioral proof",
  );
  assert.ok(proof);
  assert.equal(proof.run, "node dist/repair/command-proof-cli.js reconcile");
  assert.equal(proof.env?.GH_TOKEN, "${{ steps.app_token.outputs.token }}");
  assert.equal(proof.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN, undefined);
  assert.equal(proof.env?.CLAWSWEEPER_WEBHOOK_SECRET, "${{ secrets.CLAWSWEEPER_WEBHOOK_SECRET }}");
  // Proof metadata/permission reads remain authenticated with the App identity,
  // rather than borrowing the router's optional public-read token.
  assert.match(
    readText("src/repair/command-proof-cli.ts"),
    /githubToken: process\.env\.GH_TOKEN \?\? ""/,
  );
  assert.match(source, /process\.env\.CLAWSWEEPER_PUBLIC_GH_TOKEN\?\.trim\(\)/);
  assert.match(source, /Object\.hasOwn\(overrides, "GH_TOKEN"\)/);
  assert.match(source, /Object\.hasOwn\(overrides, "GITHUB_TOKEN"\)/);
  assert.match(source, /isPublicOpenClawReadOnlyRequest/);
  assert.match(publicReadSource, /function isPublicOpenClawReadOnlyRequest/);
  assert.match(publicReadSource, /repos\\\/openclaw\\\/openclaw\\\/\(\?:issues\|pulls\)/);
});

test("re-review recovery signs with the Worker-accepted webhook secret", () => {
  const source = readText("src/repair/comment-router.ts");
  const workflow = readText(".github/workflows/repair-comment-router.yml");
  const intake = source.slice(
    source.indexOf("function enqueueClawSweeperReReview"),
    source.indexOf("function dispatchCompletedReviewVerdict"),
  );

  assert.match(intake, /process\.env\.CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.doesNotMatch(intake, /CLAWSWEEPER_INTERNAL_QUEUE_SECRET/);
  assert.doesNotMatch(workflow, /CLAWSWEEPER_INTERNAL_QUEUE_SECRET/);
  assert.equal(
    workflow.match(/CLAWSWEEPER_WEBHOOK_SECRET: \$\{\{ secrets\.CLAWSWEEPER_WEBHOOK_SECRET \}\}/g)
      ?.length,
    6,
  );
  assert.deepEqual(
    routerWorkflowSteps(workflow)
      .filter(
        (step) =>
          step.env?.CLAWSWEEPER_WEBHOOK_SECRET === "${{ secrets.CLAWSWEEPER_WEBHOOK_SECRET }}",
      )
      .map((step) => step.name),
    [
      "Route ClawSweeper comments",
      "Reconcile explicitly requested behavioral proof",
      "Commit comment router ledger",
      "Retry waiting repair dispatches",
      "Commit comment router retry ledger",
      "Publish immutable command action ledger",
    ],
  );
});

test("exact comment convergence classifies a missing comment as no mutation", () => {
  const source = readText("src/repair/comment-router.ts");
  const fastPath = source.slice(source.indexOf("function convergeExactCommentVersionFastPathAck"));

  assert.match(source, /function githubNotFoundNoMutation[\s\S]*isGitHubNotFoundError\(error\)/);
  assert.match(
    fastPath,
    /"ack_comment_update"[\s\S]*githubNotFoundNoMutation[\s\S]*return "already_converged"/,
  );
});

test("forced replay attempt identity flows through the production workflow", () => {
  const source = readText("src/repair/comment-router.ts");
  const workflow = readText(".github/workflows/repair-comment-router.yml");

  assert.match(source, /forcedReplayCommandFields\(\{ forceReprocess, attemptId \}\)/);
  assert.match(workflow, /attempt_id:/);
  assert.match(workflow, /attempt_id="forced-replay-\$\{GITHUB_RUN_ID\}"/);
  assert.equal(workflow.match(/args\+=\(--attempt-id "\$attempt_id"\)/g)?.length, 2);
});

test("command receipt identity excludes list position and binds command attempts", () => {
  const source = readText("src/repair/command-action-ledger.ts");

  assert.match(source, /idempotencyKey: String\(command\.idempotency_key/);
  assert.match(source, /commentBodySha256: sha256OrNull\(command\.comment_body_sha256\)/);
  assert.match(source, /const attemptId = commandDurableAttemptId\(command\)/);
  assert.match(source, /\.\.\.\(attemptId \? \{ attemptId \} : \{\}\)/);
  assert.match(source, /durableAttemptId: commandDurableAttemptId\(command\)/);
  assert.match(source, /invocation: String\(process\.env\.CLAWSWEEPER_ACTION_LEDGER_INVOCATION/);
  assert.doesNotMatch(source, /\bindex\b/);
});
