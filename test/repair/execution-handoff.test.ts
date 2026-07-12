import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertExactValidationProofPlan,
  assertPublicationPauseBoundary,
  assertPublicationSafetyBoundary,
  assertPublicationSourceIdentity,
  assertRepairDeltaBaseBinding,
  assertSourcePullRevision,
  checkpointedSourceClosures,
  completePendingSourceClosureReceipt,
  missingRequiredPublicationLabels,
  pendingSourceClosures,
  prepareExecutionAuthorization,
  preparedRefPublicationState,
  publicationPauseItems,
  replacementPublicationLabels,
  runExactReplacementReopenMutation,
  runHeadBoundPullMutation,
  runPublicationMutationBoundary,
  selectAuthorizedReplacementPull,
  sealExecutionHandoff,
  sourceCloseoutStateBlock,
  type SourcePullRevision,
  verifyExecutionHandoff,
  verifyValidationReceipt,
} from "../../dist/repair/execution-handoff.js";
import {
  authorizedFixArtifact,
  createPreparedPublication,
  digestJson,
  executionIntentRepairDeltaBaseSha,
  publicationReceipt,
  type PreparedPublication,
  verifyExecutionIntentIdentity,
  verifyPreparedPublication,
} from "../../dist/repair/prepared-publication.js";
import { issueSourceRevisionSha256 } from "../../dist/repair/issue-source-guard.js";
import {
  buildStagedProofPlan,
  stagedProofPlanArtifact,
} from "../../dist/repair/staged-proof-gates.js";

test("execution authorization selects one explicit run and seals its immutable identity", () => {
  const fixture = handoffFixture();
  try {
    const authorization = prepareAuthorization(fixture);
    assert.equal(authorization.target_repo, "openclaw/example");
    assert.equal(fs.existsSync(path.join(fixture.outputRoot, "run", "result.json")), true);

    fs.writeFileSync(
      path.join(fixture.outputRoot, "run", "fix-execution-report.json"),
      `${JSON.stringify({
        actions: [
          {
            action: "open_fix_pr",
            status: "prepared",
            pr_url: "https://github.com/openclaw/example/pull/42",
          },
        ],
      })}\n`,
    );
    const manifest = sealExecutionHandoff({
      root: fixture.outputRoot,
      expectedAuthorizationSha256: authorization.identity_sha256,
      executeOutcome: "success",
    });
    assert.equal(manifest.mutation_ready, false);
    assert.equal(
      verifyExecutionHandoff(fixture.outputRoot, authorization.identity_sha256).tree_sha256,
      manifest.tree_sha256,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects extra run directories", () => {
  const fixture = handoffFixture();
  try {
    fs.mkdirSync(path.join(fixture.runsRoot, "attacker-run"));
    fs.writeFileSync(path.join(fixture.runsRoot, "attacker-run", "result.json"), "{}\n");
    assert.throws(
      () => prepareAuthorization(fixture),
      /must contain exactly one run directory; found 2/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects a worker result for another repository", () => {
  const fixture = handoffFixture();
  try {
    fs.writeFileSync(
      path.join(fixture.runsRoot, "trusted-run", "result.json"),
      `${JSON.stringify({
        repo: "openclaw/attacker-selected",
        cluster_id: "handoff-test",
        mode: "autonomous",
        actions: [],
      })}\n`,
    );
    assert.throws(
      () => prepareAuthorization(fixture),
      /worker result repo does not match the immutable job/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects symlinked handoff content", () => {
  const fixture = handoffFixture();
  try {
    fs.symlinkSync(
      path.join(fixture.runsRoot, "trusted-run", "result.json"),
      path.join(fixture.runsRoot, "trusted-run", "linked-result.json"),
    );
    assert.throws(() => prepareAuthorization(fixture), /handoff contains symlink/);
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects same-repository source redirection", () => {
  const fixture = handoffFixture();
  try {
    fs.writeFileSync(
      fixture.jobPath,
      fs
        .readFileSync(fixture.jobPath, "utf8")
        .replace("candidates: [#42]", "candidates: [#42, #43]\ncanonical: [#42]"),
    );
    assert.throws(
      () =>
        prepareExecutionAuthorization({
          jobPath: fixture.jobPath,
          runsRoot: fixture.runsRoot,
          outputRoot: fixture.outputRoot,
          workflowRunId: "123456",
          workflowRunAttempt: "2",
          workflowRepository: "openclaw/clawsweeper",
          workflowSha: "a".repeat(40),
          allowedOwner: "openclaw",
          resolveIntent: ({ actionIdentitySha256 }) => {
            const base = executionIntent(actionIdentitySha256);
            const { identity_sha256: _identitySha256, ...identity } = base;
            const redirected = {
              ...identity,
              source: {
                ...identity.source,
                kind: "pull_request" as const,
                number: 43,
                url: "https://github.com/openclaw/example/pull/43",
                expected_state: "open",
                expected_head_repo: "openclaw/example",
                expected_head_ref: "feature",
                expected_head_sha: "2".repeat(40),
                expected_base_ref: "main",
                expected_base_sha: "1".repeat(40),
              },
              source_prs: ["https://github.com/openclaw/example/pull/43"],
            };
            return { ...redirected, identity_sha256: digestJson(redirected) };
          },
        }),
      /redirected the immutable source item/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects output repository redirection", () => {
  const fixture = handoffFixture();
  try {
    assert.throws(
      () =>
        prepareExecutionAuthorization({
          jobPath: fixture.jobPath,
          runsRoot: fixture.runsRoot,
          outputRoot: fixture.outputRoot,
          workflowRunId: "123456",
          workflowRunAttempt: "2",
          workflowRepository: "openclaw/clawsweeper",
          workflowSha: "a".repeat(40),
          allowedOwner: "openclaw",
          resolveIntent: ({ actionIdentitySha256 }) => {
            const base = executionIntent(actionIdentitySha256);
            const { identity_sha256: _identitySha256, ...identity } = base;
            const redirected = { ...identity, output_repo: "openclaw/other" };
            return { ...redirected, identity_sha256: digestJson(redirected) };
          },
        }),
      /changed the authorized output operation/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects same-repository output branch redirection", () => {
  const fixture = handoffFixture();
  try {
    assert.throws(
      () =>
        prepareExecutionAuthorization({
          jobPath: fixture.jobPath,
          runsRoot: fixture.runsRoot,
          outputRoot: fixture.outputRoot,
          workflowRunId: "123456",
          workflowRunAttempt: "2",
          workflowRepository: "openclaw/clawsweeper",
          workflowSha: "a".repeat(40),
          allowedOwner: "openclaw",
          resolveIntent: ({ actionIdentitySha256 }) => {
            const base = executionIntent(actionIdentitySha256);
            const { identity_sha256: _identitySha256, ...identity } = base;
            const redirected = {
              ...identity,
              output_branch: "clawsweeper/attacker-selected",
            };
            return { ...redirected, identity_sha256: digestJson(redirected) };
          },
        }),
      /changed the authorized output operation/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("execution authorization rejects an altered immutable source head", () => {
  const fixture = handoffFixture();
  try {
    fs.writeFileSync(
      fixture.jobPath,
      fs
        .readFileSync(fixture.jobPath, "utf8")
        .replace(
          "allow_fix_pr: true",
          `allow_fix_pr: true\nexpected_head_sha: "${"1".repeat(40)}"`,
        ),
    );
    assert.throws(
      () =>
        prepareExecutionAuthorization({
          jobPath: fixture.jobPath,
          runsRoot: fixture.runsRoot,
          outputRoot: fixture.outputRoot,
          workflowRunId: "123456",
          workflowRunAttempt: "2",
          workflowRepository: "openclaw/clawsweeper",
          workflowSha: "a".repeat(40),
          allowedOwner: "openclaw",
          resolveIntent: ({ actionIdentitySha256 }) => executionIntent(actionIdentitySha256),
        }),
      /changed the expected source head/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("sealed execution rejects an unexpected top-level run path", () => {
  const fixture = handoffFixture();
  try {
    const authorization = prepareAuthorization(fixture);
    sealExecutionHandoff({
      root: fixture.outputRoot,
      expectedAuthorizationSha256: authorization.identity_sha256,
      executeOutcome: "success",
    });
    fs.mkdirSync(path.join(fixture.outputRoot, "attacker-run"));
    assert.throws(
      () => verifyExecutionHandoff(fixture.outputRoot, authorization.identity_sha256),
      /unexpected top-level entries: attacker-run/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("sealed execution rejects post-seal result and report tampering", () => {
  const fixture = handoffFixture();
  try {
    const authorization = prepareAuthorization(fixture);
    sealExecutionHandoff({
      root: fixture.outputRoot,
      expectedAuthorizationSha256: authorization.identity_sha256,
      executeOutcome: "success",
    });
    fs.appendFileSync(path.join(fixture.outputRoot, "run", "result.json"), "\n");
    assert.throws(
      () => verifyExecutionHandoff(fixture.outputRoot, authorization.identity_sha256),
      /job or result digest changed/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("sealed execution rejects a digest from another pre-execution identity", () => {
  const fixture = handoffFixture();
  try {
    prepareAuthorization(fixture);
    assert.throws(
      () =>
        sealExecutionHandoff({
          root: fixture.outputRoot,
          expectedAuthorizationSha256: "b".repeat(64),
          executeOutcome: "success",
        }),
      /digest does not match trusted pre-execution identity/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("report-only execution cannot become mutation-ready", () => {
  const fixture = handoffFixture();
  try {
    const authorization = prepareAuthorization(fixture);
    fs.writeFileSync(
      path.join(fixture.outputRoot, "run", "fix-execution-report.json"),
      `${JSON.stringify({
        actions: [{ action: "open_fix_pr", status: "opened" }],
      })}\n`,
    );
    const manifest = sealExecutionHandoff({
      root: fixture.outputRoot,
      expectedAuthorizationSha256: authorization.identity_sha256,
      executeOutcome: "failure",
    });
    assert.equal(manifest.mutation_ready, false);
    assert.throws(
      () =>
        verifyValidationReceipt({
          root: fixture.outputRoot,
          receiptPath: path.join(fixture.outputRoot, "attacker-receipt.json"),
          expectedAuthorizationSha256: authorization.identity_sha256,
          expectedReceiptSha256: "c".repeat(64),
        }),
      /report-only execution cannot authorize privileged mutation/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("publication retry accepts only the exact already-pushed authorized commit", () => {
  const expectedSha = "1".repeat(40);
  const preparedSha = "2".repeat(40);
  assert.equal(
    preparedRefPublicationState({
      liveSha: expectedSha,
      expectedSha,
      preparedSha,
    }),
    "publish",
  );
  assert.equal(
    preparedRefPublicationState({
      liveSha: preparedSha,
      expectedSha,
      preparedSha,
    }),
    "already_published",
  );
  assert.throws(
    () =>
      preparedRefPublicationState({
        liveSha: "3".repeat(40),
        expectedSha,
        preparedSha,
      }),
    /moved outside the exact authorized commit transition/,
  );
});

test("replacement retry reopens only the exact closed authorized pull request", () => {
  const intent = executionIntent("a".repeat(64));
  const publication = {
    ...checkpointPublication([]),
    prepared_head_sha: "2".repeat(40),
    pr_title: "fix: exact replacement",
    pr_body: "Exact replacement body.",
  } as PreparedPublication;
  const exactClosed = {
    number: 99,
    state: "closed",
    merged_at: null,
    title: publication.pr_title,
    body: publication.pr_body,
    head: {
      repo: { full_name: intent.output_repo },
      ref: intent.output_branch,
      sha: publication.prepared_head_sha,
    },
    base: { ref: intent.target_base_ref },
  };
  const checkpoint = publicationReceipt({
    validationReceiptSha256: "f".repeat(64),
    publication,
    targetPrNumber: 99,
    mutations: [],
  });

  assert.deepEqual(
    selectAuthorizedReplacementPull({
      pulls: [
        {
          ...exactClosed,
          number: 98,
          title: "unrelated historical pull",
        },
        exactClosed,
      ],
      publication,
      intent,
      publicationCheckpoint: checkpoint,
    }),
    { number: 99, state: "reopen" },
  );
  assert.throws(
    () =>
      selectAuthorizedReplacementPull({
        pulls: [exactClosed],
        publication,
        intent,
      }),
    /lacks a verified publication checkpoint/,
  );
  assert.throws(
    () =>
      selectAuthorizedReplacementPull({
        pulls: [exactClosed],
        publication,
        intent,
        publicationCheckpoint: publicationReceipt({
          validationReceiptSha256: "f".repeat(64),
          publication,
          targetPrNumber: 100,
          mutations: [],
        }),
      }),
    /does not authorize reopening/,
  );
  assert.throws(
    () =>
      selectAuthorizedReplacementPull({
        pulls: [{ ...exactClosed, state: "open", body: "forged body" }],
        publication,
        intent,
      }),
    /does not match the authorized publication/,
  );
  assert.throws(
    () =>
      selectAuthorizedReplacementPull({
        pulls: [{ ...exactClosed, merged_at: "2026-07-12T00:00:00Z" }],
        publication,
        intent,
      }),
    /already merged/,
  );
  assert.throws(
    () =>
      selectAuthorizedReplacementPull({
        pulls: [exactClosed, { ...exactClosed, number: 100 }],
        publication,
        intent,
      }),
    /multiple exact pull request targets/,
  );

  let liveReplacement = exactClosed;
  let reopenCount = 0;
  assert.equal(
    runExactReplacementReopenMutation({
      readPull: () => liveReplacement,
      expectedNumber: 99,
      publication,
      intent,
      publicationCheckpoint: checkpoint,
      mutation: () => ++reopenCount,
    }),
    1,
  );
  liveReplacement = { ...exactClosed, state: "open" };
  assert.throws(
    () =>
      runExactReplacementReopenMutation({
        readPull: () => liveReplacement,
        expectedNumber: 99,
        publication,
        intent,
        publicationCheckpoint: checkpoint,
        mutation: () => ++reopenCount,
      }),
    /no longer the exact closed authorized target/,
  );
  assert.equal(reopenCount, 1);
});

test("replacement publication binds source, implementation, and automerge labels", () => {
  assert.deepEqual(
    replacementPublicationLabels({
      sourceLabelSets: [
        ["bug", "component: gateway", "clawsweeper:automerge", "clawsweeper:human-review"],
      ],
      requiredLabels: ["required: implementation"],
      issueImplementation: false,
      commitFinding: false,
    }),
    [
      "bug",
      "component: gateway",
      "clawsweeper:automerge",
      "clawsweeper",
      "required: implementation",
    ],
  );
  assert.deepEqual(
    replacementPublicationLabels({
      sourceLabelSets: [["clawsweeper:automerge"]],
      requiredLabels: [],
      issueImplementation: true,
      commitFinding: false,
    }),
    ["clawsweeper", "clawsweeper:autogenerated", "clawsweeper:autofix"],
  );
  assert.deepEqual(
    missingRequiredPublicationLabels(["clawsweeper", "clawsweeper:automerge"], ["ClawSweeper"]),
    ["clawsweeper:automerge"],
  );
});

test("planned source closure is not checkpointed until an exact publication receipt exists", () => {
  const revision = sourcePullRevision(42);
  const intent = revisionBoundIntent(revision, "open_pull_request");
  const publication = checkpointPublication([
    {
      source: revision.url,
      operation: "close",
    },
  ]);
  const closedPull = livePull(revision, { state: "closed" });

  const plannedOnly = checkpointedSourceClosures(publication, null, intent);
  assert.equal(plannedOnly.size, 0);
  assert.throws(
    () =>
      assertSourcePullRevision(revision, closedPull, {
        allowClosed: plannedOnly.has(revision.url),
      }),
    /revision changed after authorization/,
  );

  const receipt = publicationReceipt({
    validationReceiptSha256: "c".repeat(64),
    publication,
    targetPrNumber: 99,
    mutations: [],
  });
  const receiptWithoutClose = checkpointedSourceClosures(publication, receipt, intent);
  assert.equal(receiptWithoutClose.size, 0);
  const pendingReceipt = publicationReceipt({
    validationReceiptSha256: "c".repeat(64),
    publication,
    targetPrNumber: 99,
    mutations: [
      {
        operation: "begin_close_source_pull_request",
        source: revision.url,
        repo: revision.repo,
        pull_number: revision.number,
        expected_head_sha: revision.expected_head_sha,
        expected_base_sha: revision.expected_base_sha,
      },
    ],
  });
  assert.equal(checkpointedSourceClosures(publication, pendingReceipt, intent).size, 0);
  assert.deepEqual([...pendingSourceClosures(publication, pendingReceipt, intent)], [revision.url]);
  const recoveredReceipt = completePendingSourceClosureReceipt({
    publication,
    receipt: pendingReceipt,
    intent,
    revision,
  });
  assert.deepEqual(
    [...checkpointedSourceClosures(publication, recoveredReceipt, intent)],
    [revision.url],
  );
  assert.equal(
    completePendingSourceClosureReceipt({
      publication,
      receipt: recoveredReceipt,
      intent,
      revision,
    }).identity_sha256,
    recoveredReceipt.identity_sha256,
  );
  assert.throws(
    () =>
      completePendingSourceClosureReceipt({
        publication,
        receipt,
        intent,
        revision,
      }),
    /lacks its durable pre-close checkpoint/,
  );
  const completedReceipt = publicationReceipt({
    validationReceiptSha256: "c".repeat(64),
    publication,
    targetPrNumber: 99,
    mutations: [
      {
        operation: "close_source_pull_request",
        source: revision.url,
        repo: revision.repo,
        pull_number: revision.number,
        expected_head_sha: revision.expected_head_sha,
        expected_base_sha: revision.expected_base_sha,
      },
    ],
  });
  const checkpointed = checkpointedSourceClosures(publication, completedReceipt, intent);
  assert.deepEqual([...checkpointed], [revision.url]);
  assert.doesNotThrow(() =>
    assertSourcePullRevision(revision, closedPull, {
      allowClosed: checkpointed.has(revision.url),
    }),
  );
  assert.throws(
    () =>
      assertSourcePullRevision(
        revision,
        { ...closedPull, merged_at: "2026-07-12T00:00:00Z" },
        {
          allowClosed: true,
        },
      ),
    /revision changed after authorization/,
  );
  assert.throws(
    () =>
      checkpointedSourceClosures(
        publication,
        {
          ...completedReceipt,
          prepared_publication_sha256: "f".repeat(64),
        },
        intent,
      ),
    /publication receipt does not match/,
  );
  const unauthorizedCompletion = publicationReceipt({
    validationReceiptSha256: "c".repeat(64),
    publication,
    targetPrNumber: 99,
    mutations: [
      {
        operation: "close_source_pull_request",
        source: revision.url,
        repo: revision.repo,
        pull_number: revision.number,
        expected_head_sha: "f".repeat(40),
        expected_base_sha: revision.expected_base_sha,
      },
    ],
  });
  assert.throws(
    () => checkpointedSourceClosures(publication, unauthorizedCompletion, intent),
    /unauthorized source-close completion/,
  );
});

test("completed source closeout distinguishes a later human reopen", () => {
  const source = "https://github.com/openclaw/openclaw/pull/42";
  assert.equal(sourceCloseoutStateBlock({ source, state: "closed", completed: true }), "");
  assert.match(
    sourceCloseoutStateBlock({ source, state: "open", completed: true }),
    /reopened after ClawSweeper closeout/,
  );
  assert.match(
    sourceCloseoutStateBlock({ source, state: "closed", completed: false }),
    /closed without a completed ClawSweeper receipt/,
  );
  assert.equal(sourceCloseoutStateBlock({ source, state: "open", completed: false }), "");
  assert.equal(
    sourceCloseoutStateBlock({ source, state: "closed", completed: false, pending: true }),
    "",
  );
});

test("every source closeout remains bound to its exact head and base revisions", () => {
  const revision = sourcePullRevision(43);
  assert.doesNotThrow(() => assertSourcePullRevision(revision, livePull(revision)));
  assert.throws(
    () =>
      assertSourcePullRevision(revision, {
        ...livePull(revision),
        head: {
          ...livePull(revision).head,
          sha: "4".repeat(40),
        },
      }),
    /revision changed after authorization/,
  );
  assert.throws(
    () =>
      assertSourcePullRevision(revision, {
        ...livePull(revision),
        base: {
          ...livePull(revision).base,
          sha: "5".repeat(40),
        },
      }),
    /revision changed after authorization/,
  );
});

test("publication checkpoint binds source closeout and every mutation rechecks live safety", () => {
  const source = fs.readFileSync("src/repair/execution-handoff.ts", "utf8");
  const mutationWrapper = source.slice(
    source.indexOf("function runPublicationMutation"),
    source.indexOf("export function publicationPauseItems"),
  );
  assert.match(mutationWrapper, /assertPublicationSourceIdentity\(/);
  assert.match(mutationWrapper, /assertPublicationSafetyBoundary\(intent, targetNumbers/);
  for (const mutationOwner of [
    "function publishPreparedRef",
    "function publishExactPullComment",
    "function publishRequiredPullLabels",
  ]) {
    const start = source.indexOf(mutationOwner);
    const end = source.indexOf("\nfunction ", start + mutationOwner.length);
    assert.match(source.slice(start, end), /runPublicationMutation\(/, mutationOwner);
  }
  const replacement = source.slice(
    source.indexOf("function publishReplacementRepair"),
    source.indexOf("export function selectAuthorizedReplacementPull"),
  );
  assert.ok(
    replacement.indexOf("selectAuthorizedReplacementPull") <
      replacement.indexOf("publishPreparedRef"),
  );
  assert.match(
    replacement,
    /publishPreparedRef\(\{[\s\S]*targetPrNumber: liveTargetPr,[\s\S]*\}\)/,
  );
  assert.match(
    replacement,
    /runPublicationMutation\(\{[\s\S]*targetNumbers: \[\],[\s\S]*"pr",\s*"create"/,
  );
  assert.match(replacement, /"pr", "reopen"/);
  assert.doesNotMatch(replacement, /"pr",\s*"close"|clawsweeper-replacement-publication/);
  assert.ok(
    replacement.indexOf("publishRequiredPullLabels") <
      replacement.lastIndexOf("verifyPublishedPull(intent.target_repo, targetPrNumber"),
  );
  const publisher = source.slice(
    source.indexOf("export function publishValidatedExecution"),
    source.indexOf("export function verifyPublishedReceipt"),
  );
  assert.ok(
    publisher.indexOf("publishReplacementRepair") < publisher.indexOf("publicationReceipt"),
  );
  assert.ok(
    publisher.indexOf("readPriorPublicationCheckpoint") <
      publisher.indexOf("assertPublicationSourceIdentity"),
  );
  const closeoutStart = source.indexOf("function closeSupersededReplacementSources");
  const closeout = source.slice(
    closeoutStart,
    source.indexOf("\nfunction verifyPublishedPull(", closeoutStart),
  );
  assert.match(
    closeout,
    /ensurePublishedReplacementAvailable\([\s\S]*publishExactPullComment\([\s\S]*ensurePublishedReplacementAvailable\([\s\S]*"pr",\s*"close"/,
  );
  assert.match(
    closeout,
    /publishExactPullComment\(\{[\s\S]*checkpointedClosures: completedClosures,[\s\S]*runPublicationMutation\(\{[\s\S]*revalidateSourcePullRevision\(/,
  );
  assert.match(
    closeout,
    /sourceClosureAttemptReceiptMutation\(action\.revision\)[\s\S]*writeJson\(publicationReceiptPath, currentReceipt\)[\s\S]*"pr", "close"[\s\S]*completePendingSourceClosureReceipt\(\{[\s\S]*revision: action\.revision,[\s\S]*writeJson\(publicationReceiptPath, currentReceipt\)/,
  );
  assert.match(
    closeout,
    /for \(const source of pendingAttempts\)[\s\S]*state !== "closed"[\s\S]*completePendingSourceClosureReceipt\(\{[\s\S]*revision,[\s\S]*writeJson\(publicationReceiptPath, currentReceipt\)/,
  );
  assert.ok(closeout.indexOf("sourceCloseoutStateBlock") < closeout.indexOf('["pr", "close"'));
  const resolver = source.slice(
    source.indexOf("function resolveLiveExecutionIntent"),
    source.indexOf("function verifyAuthorizedPreparedPublication"),
  );
  assert.match(resolver, /source_pull_revisions: liveSourcePulls\.map/);
  const liveRevalidation = source.slice(
    source.indexOf("export function assertPublicationSourceIdentity"),
    source.indexOf("function checkoutIdentity"),
  );
  assert.doesNotMatch(liveRevalidation, /superseded_source_actions/);
});

test("shared publication mutation identity rejects source drift and limits rerun allowances", () => {
  const revision = sourcePullRevision(42);
  const preparedHead = "9".repeat(40);
  const intent = revisionBoundIntent(revision, "update_source_pr");
  const publication = {
    ...checkpointPublication([]),
    operation: "update_source_pr" as const,
    source: intent.source,
    prepared_head_sha: preparedHead,
  };
  let pull = livePull(revision);
  const readers = {
    readPull: () => pull,
  };

  assert.doesNotThrow(() => assertPublicationSourceIdentity({ intent, publication, readers }));
  pull = {
    ...livePull(revision),
    head: { ...livePull(revision).head, sha: preparedHead },
  };
  assert.doesNotThrow(() => assertPublicationSourceIdentity({ intent, publication, readers }));

  pull = {
    ...livePull(revision),
    head: { ...livePull(revision).head, sha: "8".repeat(40) },
  };
  assert.throws(
    () => assertPublicationSourceIdentity({ intent, publication, readers }),
    /revision changed after authorization/,
  );

  pull = livePull(revision, { state: "closed" });
  assert.throws(
    () => assertPublicationSourceIdentity({ intent, publication, readers }),
    /revision changed after authorization/,
  );
  assert.doesNotThrow(() =>
    assertPublicationSourceIdentity({
      intent,
      publication,
      checkpointedClosures: new Set([revision.url]),
      readers,
    }),
  );

  pull = {
    ...livePull(revision, { state: "closed" }),
    merged_at: "2026-07-12T00:00:00Z",
  };
  assert.throws(
    () =>
      assertPublicationSourceIdentity({
        intent,
        publication,
        checkpointedClosures: new Set([revision.url]),
        readers,
      }),
    /revision changed after authorization/,
  );

  pull = {
    ...livePull(revision),
    base: { ...livePull(revision).base, sha: "7".repeat(40) },
  };
  assert.throws(
    () => assertPublicationSourceIdentity({ intent, publication, readers }),
    /revision changed after authorization/,
  );

  const replacementIntent = revisionBoundIntent(revision, "open_pull_request");
  pull = {
    ...livePull(revision),
    head: { ...livePull(revision).head, sha: preparedHead },
  };
  assert.throws(
    () =>
      assertPublicationSourceIdentity({
        intent: replacementIntent,
        publication: { ...publication, operation: "open_pull_request" },
        readers,
      }),
    /revision changed after authorization/,
  );
});

test("shared publication mutation identity rejects sealed issue drift", () => {
  const issue = {
    state: "open",
    locked: false,
    title: "Preserve exact source identity",
    body: "Original issue body",
    labels: [],
  };
  const revision = issueSourceRevisionSha256(issue, []);
  const base = executionIntent("a".repeat(64));
  const intent = {
    ...base,
    source: {
      ...base.source,
      kind: "issue" as const,
      repo: "openclaw/example",
      number: 42,
      url: "https://github.com/openclaw/example/issues/42",
      expected_state: "open",
      expected_revision_sha256: revision,
    },
  };
  const publication = { ...checkpointPublication([]), source: intent.source };
  let liveIssue = issue;
  const readers = {
    readIssue: () => liveIssue,
    readComments: () => [],
  };

  let mutated = false;
  assert.doesNotThrow(() =>
    runPublicationMutationBoundary({
      intent,
      publication,
      targetNumbers: [],
      readers,
      mutation: () => {
        mutated = true;
      },
    }),
  );
  assert.equal(mutated, true);
  liveIssue = { ...issue, body: "Changed after authorization" };
  mutated = false;
  assert.throws(
    () =>
      runPublicationMutationBoundary({
        intent,
        publication,
        targetNumbers: [],
        readers,
        mutation: () => {
          mutated = true;
        },
      }),
    /source issue changed since ClawSweeper queued implementation/,
  );
  assert.equal(mutated, false);
});

test("required label mutation rejects a concurrently replaced target head", () => {
  const intent = executionIntent("a".repeat(64));
  const publication = checkpointPublication([]);
  let livePull = {
    state: "open",
    merged_at: null,
    labels: [],
    head: {
      repo: { full_name: intent.output_repo },
      ref: intent.output_branch,
      sha: publication.prepared_head_sha,
    },
    base: { ref: intent.target_base_ref },
    title: publication.pr_title,
    body: publication.pr_body,
  };
  assert.deepEqual(missingRequiredPublicationLabels(intent.required_labels, []), ["clawsweeper"]);
  livePull = {
    ...livePull,
    head: { ...livePull.head, sha: "8".repeat(40) },
  };
  let mutated = false;

  assert.throws(
    () =>
      runHeadBoundPullMutation({
        readPull: () => livePull,
        publication,
        intent,
        verifyLabels: false,
        mutation: () => {
          mutated = true;
        },
      }),
    /published pull request does not match the validated output identity/,
  );
  assert.equal(mutated, false);
});

test("publication pause boundary covers secondary sources and retry targets on every mutation", () => {
  const base = executionIntent("a".repeat(64));
  const { identity_sha256: _identitySha256, ...baseIdentity } = base;
  const identity = {
    ...baseIdentity,
    source: {
      ...baseIdentity.source,
      kind: "pull_request" as const,
      number: 42,
      url: "https://github.com/openclaw/example/pull/42",
      expected_state: "open",
      expected_head_repo: "openclaw/example",
      expected_head_ref: "source-42",
      expected_head_sha: "2".repeat(40),
      expected_base_ref: "main",
      expected_base_sha: "1".repeat(40),
    },
    source_prs: [
      "https://github.com/openclaw/example/pull/42",
      "https://github.com/openclaw/example/pull/43",
    ],
    superseded_source_prs: [
      "https://github.com/openclaw/example/pull/42",
      "https://github.com/openclaw/example/pull/43",
    ],
  };
  const intent = verifyExecutionIntentIdentity({
    ...identity,
    identity_sha256: digestJson(identity),
  });
  assert.deepEqual(publicationPauseItems(intent, [99, 43]), [
    { repo: "openclaw/example", number: 42 },
    { repo: "openclaw/example", number: 43 },
    { repo: "openclaw/example", number: 99 },
  ]);

  const labels = new Map<string, string[]>([
    ["openclaw/example#42", []],
    ["openclaw/example#43", ["clawsweeper:human-review"]],
    ["openclaw/example#99", []],
  ]);
  const readLabels = (repo: string, number: number) => labels.get(`${repo}#${number}`) ?? [];
  assert.throws(
    () => assertPublicationPauseBoundary(intent, [99], readLabels),
    /human-review.*openclaw\/example#43/,
  );

  labels.set("openclaw/example#43", []);
  assert.doesNotThrow(() => assertPublicationPauseBoundary(intent, [99], readLabels));
  labels.set("openclaw/example#43", ["clawsweeper:manual-only"]);
  assert.throws(
    () => assertPublicationPauseBoundary(intent, [99], readLabels),
    /manual-only.*openclaw\/example#43/,
  );

  labels.set("openclaw/example#43", []);
  labels.set("openclaw/example#99", ["clawsweeper:human-review"]);
  assert.throws(
    () => assertPublicationPauseBoundary(intent, [99], readLabels),
    /human-review.*openclaw\/example#99/,
  );

  labels.set("openclaw/example#99", []);
  labels.set("openclaw/example#43", ["security:sensitive"]);
  assert.throws(
    () =>
      assertPublicationSafetyBoundary(intent, [99], (repo, number) => ({
        labels: readLabels(repo, number),
        comments: [],
      })),
    /security signal.*openclaw\/example#43/,
  );

  labels.set("openclaw/example#43", []);
  assert.throws(
    () =>
      assertPublicationSafetyBoundary(intent, [99], (repo, number) => ({
        labels: readLabels(repo, number),
        comments:
          number === 99 ? ["<!-- clawsweeper-security:security-sensitive item=99 sha=abc -->"] : [],
      })),
    /security signal.*openclaw\/example#99/,
  );
});

test("fresh replacements bind proof policy to the sealed source and repair strategy", () => {
  const base = executionIntent("a".repeat(64));
  const intent = {
    ...base,
    source: {
      ...base.source,
      kind: "pull_request" as const,
      number: 42,
      url: "https://github.com/openclaw/example/pull/42",
      expected_head_sha: "2".repeat(40),
    },
    repair_strategy: "replace_uneditable_branch",
    source_prs: ["https://github.com/openclaw/example/pull/42"],
  };
  assert.equal(executionIntentRepairDeltaBaseSha(intent), "2".repeat(40));
  assert.equal(
    executionIntentRepairDeltaBaseSha({
      ...intent,
      expected_output_sha: "3".repeat(40),
    }),
    "3".repeat(40),
  );
  assert.deepEqual(
    authorizedFixArtifact(intent, {
      repair_strategy: "repair_contributor_branch",
      source_prs: ["https://github.com/openclaw/example/pull/99"],
      supersede_source_prs: [],
      validation_commands: ["pnpm test"],
    }),
    {
      repair_strategy: "replace_uneditable_branch",
      source_prs: ["https://github.com/openclaw/example/pull/42"],
      supersede_source_prs: [],
      validation_commands: ["pnpm test"],
    },
  );
});

test("independent validation rejects self-consistent plans that omit required gates", () => {
  const command = (parts: string[], originalIndex: number) => ({
    parts,
    source: "artifact" as const,
    canonical: false,
    required: true,
    originalIndex,
  });
  const independentlyRequired = stagedProofPlanArtifact(
    buildStagedProofPlan({
      commands: [
        command(["git", "diff", "--check"], 0),
        command(["pnpm", "test:serial", "test/repair/execution-handoff.test.ts"], 1),
      ],
      changedFiles: ["src/repair/execution-handoff.ts"],
    }),
  );
  const forgedSelfConsistent = stagedProofPlanArtifact(
    buildStagedProofPlan({
      commands: [command(["git", "diff", "--check"], 0)],
      changedFiles: ["src/repair/execution-handoff.ts"],
    }),
  );

  assert.throws(
    () => assertExactValidationProofPlan(forgedSelfConsistent, independentlyRequired),
    /differs from independently required validation policy/,
  );
});

test("independent validation rejects plan additions and reordering", () => {
  const required = stagedProofPlanArtifact(
    buildStagedProofPlan({
      commands: [
        {
          parts: ["pnpm", "lint"],
          source: "configured",
          canonical: false,
          required: true,
          originalIndex: 0,
        },
        {
          parts: ["pnpm", "check:test-types"],
          source: "configured",
          canonical: false,
          required: true,
          originalIndex: 1,
        },
      ],
      changedFiles: [],
    }),
  );
  const added = {
    ...required,
    commands: [
      ...required.commands,
      {
        ...required.commands[0]!,
        command_id: "forged-addition",
        original_index: 2,
      },
    ],
  };
  const reordered = {
    ...required,
    commands: [...required.commands].reverse(),
  };

  assert.throws(
    () => assertExactValidationProofPlan(added, required),
    /differs from independently required validation policy/,
  );
  assert.throws(
    () => assertExactValidationProofPlan(reordered, required),
    /differs from independently required validation policy/,
  );
});

test("trusted publication rejects forged deterministic comment metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-publication-"));
  const targetDir = path.join(root, "target");
  const outputDir = path.join(root, "run");
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, "example.txt"), "base\n");
  git(targetDir, "init");
  git(targetDir, "config", "user.name", "ClawSweeper Test");
  git(targetDir, "config", "user.email", "clawsweeper@example.invalid");
  git(targetDir, "add", ".");
  git(targetDir, "-c", "commit.gpgsign=false", "commit", "-m", "base");
  const repairDeltaBaseSha = git(targetDir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(targetDir, "hidden.ts"), "export const hidden = true;\n");
  git(targetDir, "add", ".");
  git(targetDir, "-c", "commit.gpgsign=false", "commit", "-m", "hidden code change");
  const intermediateSha = git(targetDir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(targetDir, "example.txt"), "prepared\n");
  git(targetDir, "add", ".");
  git(targetDir, "-c", "commit.gpgsign=false", "commit", "-m", "prepared");
  const preparedHeadSha = git(targetDir, "rev-parse", "HEAD");
  const preparedTreeSha = git(targetDir, "rev-parse", "HEAD^{tree}");
  const baseIntent = executionIntent("a".repeat(64));
  const { identity_sha256: _baseIdentitySha256, ...baseIdentity } = baseIntent;
  const intentIdentity = { ...baseIdentity, target_base_sha: repairDeltaBaseSha };
  const intent = {
    ...intentIdentity,
    identity_sha256: digestJson(intentIdentity),
  };
  const fixArtifact = {
    pr_title: "fix: handoff fixture",
    pr_body: "Handoff fixture.",
  };

  try {
    const publication = createPreparedPublication({
      outputDir,
      targetDir,
      authorizationSha256: "b".repeat(64),
      executionIntent: intent,
      fixArtifact,
      repairDeltaBaseSha,
      preparedHeadSha,
      preparedTreeSha,
    });
    assert.doesNotThrow(() => assertRepairDeltaBaseBinding(targetDir, intent, publication));
    assert.throws(
      () =>
        assertRepairDeltaBaseBinding(targetDir, intent, {
          ...publication,
          repair_delta_base_sha: intermediateSha,
        }),
      /is not the immutable pre-execution head/,
    );
    const { identity_sha256: _identitySha256, ...identity } = publication;
    const forgedIdentity = {
      ...identity,
      source_comment: "forged privileged comment",
    };
    const forged = {
      ...forgedIdentity,
      identity_sha256: digestJson(forgedIdentity),
    };

    assert.throws(
      () =>
        verifyPreparedPublication({
          publication: forged,
          executionIntent: intent,
          authorizationSha256: "b".repeat(64),
          root,
          fixArtifact,
        }),
      /prepared source comment is not deterministic/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function prepareAuthorization(fixture: ReturnType<typeof handoffFixture>) {
  return prepareExecutionAuthorization({
    jobPath: fixture.jobPath,
    runsRoot: fixture.runsRoot,
    outputRoot: fixture.outputRoot,
    workflowRunId: "123456",
    workflowRunAttempt: "2",
    workflowRepository: "openclaw/clawsweeper",
    workflowSha: "a".repeat(40),
    allowedOwner: "openclaw",
    resolveIntent: ({ actionIdentitySha256 }) => executionIntent(actionIdentitySha256),
  });
}

function handoffFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-handoff-"));
  const jobPath = path.join(
    process.cwd(),
    "jobs",
    "openclaw",
    "inbox",
    `handoff-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const runsRoot = path.join(root, "runs");
  const runDir = path.join(runsRoot, "trusted-run");
  const outputRoot = path.join(root, "authorized");
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    jobPath,
    [
      "---",
      "repo: openclaw/example",
      "cluster_id: handoff-test",
      "mode: autonomous",
      "allowed_actions: [comment, fix, raise_pr]",
      "candidates: [#42]",
      "allow_fix_pr: true",
      "---",
      "fixture",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(runDir, "result.json"),
    `${JSON.stringify({
      repo: "openclaw/example",
      cluster_id: "handoff-test",
      mode: "autonomous",
      canonical_pr: null,
      reviewed_sha: null,
      actions: [{ action: "open_fix_pr", status: "planned" }],
      fix_artifact: {
        repair_strategy: "new_fix_pr",
        source_prs: [],
        pr_title: "fix: handoff fixture",
        pr_body: "Handoff fixture.",
        validation_commands: ["npm test"],
      },
    })}\n`,
  );
  return {
    jobPath,
    outputRoot,
    runsRoot,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(jobPath, { force: true });
    },
  };
}

function executionIntent(actionIdentitySha256: string) {
  const identity = {
    schema_version: 2,
    target_repo: "openclaw/example",
    source: {
      kind: "job" as const,
      repo: "openclaw/example",
      number: null,
      url: null,
      expected_state: "authorized",
      expected_revision_sha256: null,
      expected_head_repo: null,
      expected_head_ref: null,
      expected_head_sha: null,
      expected_base_ref: null,
      expected_base_sha: null,
    },
    target_base_ref: "main",
    target_base_sha: "1".repeat(40),
    operation: "open_pull_request" as const,
    output_repo: "openclaw/example",
    output_branch: "clawsweeper/handoff-test",
    expected_output_sha: null,
    expected_target_pr_number: null,
    action_name: "open_fix_pr" as const,
    repair_strategy: "new_fix_pr",
    action_identity_sha256: actionIdentitySha256,
    source_prs: [],
    source_closing_references: [],
    contributor_credits: [],
    superseded_source_prs: [],
    close_superseded_source_prs: false,
    required_labels: ["clawsweeper"],
  };
  return { ...identity, identity_sha256: digestJson(identity) };
}

function sourcePullRevision(number: number): SourcePullRevision {
  return {
    url: `https://github.com/openclaw/example/pull/${number}`,
    repo: "openclaw/example",
    number,
    expected_state: "open",
    expected_head_repo: "contributor/example",
    expected_head_ref: `source-${number}`,
    expected_head_sha: "2".repeat(40),
    expected_base_ref: "main",
    expected_base_sha: "1".repeat(40),
  };
}

function livePull(revision: SourcePullRevision, { state = "open" } = {}) {
  return {
    state,
    merged_at: null,
    head: {
      repo: { full_name: revision.expected_head_repo },
      ref: revision.expected_head_ref,
      sha: revision.expected_head_sha,
    },
    base: {
      ref: revision.expected_base_ref,
      sha: revision.expected_base_sha,
    },
  };
}

function revisionBoundIntent(
  revision: SourcePullRevision,
  operation: "update_source_pr" | "open_pull_request",
) {
  const base = executionIntent("a".repeat(64));
  return {
    ...base,
    operation,
    source: {
      ...base.source,
      kind: "pull_request" as const,
      repo: revision.repo,
      number: revision.number,
      url: revision.url,
      expected_state: revision.expected_state,
      expected_head_repo: revision.expected_head_repo,
      expected_head_ref: revision.expected_head_ref,
      expected_head_sha: revision.expected_head_sha,
      expected_base_ref: revision.expected_base_ref,
      expected_base_sha: revision.expected_base_sha,
    },
    source_prs: [revision.url],
    source_pull_revisions: [revision],
  };
}

function checkpointPublication(supersededSourceActions: Array<Record<string, string>>) {
  const intent = executionIntent("a".repeat(64));
  return {
    schema_version: 2,
    authorization_sha256: "b".repeat(64),
    execution_intent_sha256: intent.identity_sha256,
    action_identity_sha256: intent.action_identity_sha256,
    target_repo: intent.target_repo,
    operation: "open_pull_request",
    output_repo: intent.output_repo,
    output_branch: intent.output_branch,
    expected_output_sha: intent.expected_output_sha,
    source: intent.source,
    target_base_ref: intent.target_base_ref,
    target_base_sha: intent.target_base_sha,
    repair_delta_base_sha: intent.target_base_sha,
    prepared_head_sha: "2".repeat(40),
    prepared_tree_sha: "3".repeat(40),
    bundle_path: "prepared-repair.bundle",
    bundle_sha256: "d".repeat(64),
    pr_title: "fix: exact replacement",
    pr_body: "Exact replacement.",
    source_comment: "Prepared replacement.",
    superseded_source_actions: supersededSourceActions,
    identity_sha256: "e".repeat(64),
  } as PreparedPublication;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
