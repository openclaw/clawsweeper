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
  assertRepairDeltaBaseBinding,
  missingRequiredPublicationLabels,
  prepareExecutionAuthorization,
  preparedRefPublicationState,
  publicationPauseItems,
  replacementPublicationLabels,
  selectAuthorizedReplacementPull,
  sealExecutionHandoff,
  verifyExecutionHandoff,
  verifyValidationReceipt,
} from "../../dist/repair/execution-handoff.js";
import {
  authorizedFixArtifact,
  createPreparedPublication,
  digestJson,
  executionIntentRepairDeltaBaseSha,
  type PreparedPublication,
  verifyExecutionIntentIdentity,
  verifyPreparedPublication,
} from "../../dist/repair/prepared-publication.js";
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
    }),
    { number: 99, state: "reopen" },
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

test("publication checkpoint precedes source closeout and every mutation rechecks live safety", () => {
  const source = fs.readFileSync("src/repair/execution-handoff.ts", "utf8");
  const mutationWrapper = source.slice(
    source.indexOf("function runPublicationMutation"),
    source.indexOf("export function publicationPauseItems"),
  );
  assert.match(mutationWrapper, /assertPublicationSafe\(intent, targetNumbers\)/);
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
  assert.match(replacement, /runPublicationMutation\(intent, \[\],[\s\S]*"pr",\s*"create"/);
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
  const closeout = source.slice(
    source.indexOf("function closeSupersededReplacementSources"),
    source.indexOf("function verifyPublishedPull"),
  );
  assert.match(
    closeout,
    /ensurePublishedReplacementAvailable\([\s\S]*publishExactPullComment\([\s\S]*ensurePublishedReplacementAvailable\([\s\S]*"pr",\s*"close"/,
  );
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
