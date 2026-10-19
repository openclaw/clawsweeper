#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
let {
  canonicalPullRequestClusterForTest,
  closeDecision,
  item,
  markedReviewCommentForTest,
  promotionGhMock,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  withMockCodexProof,
  withMockGh,
  workPlanCandidateReport,
} = {};
let validateCloseDecision, validateReportClose, reportReviewDecision;
let frontMatterValue, renderReviewCommentFromReport, reviewedPrActivityCursorV2Query;

const root = mkdtempSync(join(tmpdir(), "clawsweeper-closure-proof-"));
const savedEnv = { ...process.env };
const manualDecision = {
  required: true,
  kind: "product_direction",
  question: "Should a maintainer close this scope?",
  rationale: "Synthetic unresolved product decision.",
  options: [
    { title: "Keep", body: "Keep for owner review.", recommended: true },
    { title: "Close", body: "A maintainer may close manually.", recommended: false },
  ],
  likelyOwner: { person: "@maintainer", reason: "Product owner.", confidence: "high" },
};
const results = [];
const generatedPayloads = new Set();

function editQuery(ids) {
  return `query=query($after:String){nodes(ids:${JSON.stringify(ids)}){id ...on Comment{lastEditedAt userContentEdits(first:100,after:$after){totalCount nodes{id editedAt editor{__typename ...on User{id:databaseId} ...on Bot{id:databaseId}}} pageInfo{hasNextPage endCursor}}}}}`;
}

function fileManifest(paths) {
  const files = paths
    .flatMap((path) => {
      const entries = readdirSync(path, { withFileTypes: true });
      return entries.flatMap((entry) =>
        entry.isDirectory()
          ? fileManifest([`${path}/${entry.name}`]).files
          : [
              {
                path: `${path}/${entry.name}`,
                sha256: createHash("sha256")
                  .update(readFileSync(`${path}/${entry.name}`))
                  .digest("hex"),
              },
            ],
      );
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}

function sourceManifest() {
  const ignored = execFileSync(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      "src",
      "test",
      "prompts",
      "schema",
      "config",
      "scripts",
      "docs/proof",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig*.json",
      ".oxfmtrc.json",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
  assert.deepEqual(
    ignored,
    [],
    "ignored executable/build inputs must be removed or explicitly included before proof",
  );
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const files = paths.map((path) => ({
    path,
    sha256: existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null,
  }));
  return { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}

const fixtureManifest = () =>
  [
    "test/helpers.ts",
    "test/agent-input-scan-helpers.ts",
    "docs/proof/closure-evidence/run-proof.mjs",
  ].map((path) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));

// This transport never delegates to the real gh binary. The PATH shims cover
// raw gh/ghx callers too; GH_CONFIG_DIR and credentials are isolated below.
function readOnlyTransport(mock, tracePath, effect = null) {
  return `
const proofFs = require("node:fs");
const proofEffect = ${JSON.stringify(effect)};
const proofArgs = process.argv.slice(2);
const proofNormalized = proofArgs[0] === "--repo" ? proofArgs.slice(2) : proofArgs;
const proofMethodIndex = Math.max(proofNormalized.indexOf("--method"), proofNormalized.indexOf("-X"));
const proofJoinedMethod = proofNormalized.find(arg => arg.startsWith("--method=") || /^-X./.test(arg));
const proofMethod = proofJoinedMethod ? proofJoinedMethod.replace(/^(?:--method=|-X)/, "") : proofMethodIndex < 0 ? "GET" : proofNormalized[proofMethodIndex + 1];
const proofPath = (proofNormalized[1] === "-i" ? proofNormalized[2] : proofNormalized[1]) || "";
const proofGraphql = proofPath === "graphql";
const proofFields = proofNormalized.filter(arg => /^(?:query|owner|name|number|cursor|endCursor)=/.test(arg));
const proofQuery = proofFields.find(arg => arg.startsWith("query=")) || "";
const proofPayload = proofNormalized.some(arg => /^(?:-f|-F|--raw-field|--field|--input)/.test(arg));
const proofInput = proofNormalized.some(arg => /^--input(?:=|$)/.test(arg));
const proofFieldFlags = proofNormalized.flatMap((arg, index) => /^(?:-f|-F|--raw-field|--field)$/.test(arg) ? [{ flag: arg, value: proofNormalized[index + 1] }] : []);
const proofExpectedFields = proofFieldFlags.length === proofFields.length && proofFieldFlags.every(({ value }) => /^(?:query|owner|name|number|cursor|endCursor)=/.test(value || "")) && new Set(proofFields.map(field => field.split("=")[0])).size === proofFields.length;
const proofAllowedPath = /^(?:search\\/issues(?:\\?|$)|repos\\/openclaw\\/openclaw(?:$|\\/(?:issues\\/(?:321|400)(?:\\/(?:comments|timeline))?|issues\\/comments\\/(?:9321|9400)|pulls\\/(?:321|400)(?:\\/(?:files|comments|reviews|commits))?|commits(?:\\/(?:head-sha(?:\\/(?:status|check-runs))?|main))?|actions\\/runs|compare\\/[a-f0-9]{40}\\.\\.\\.[a-f0-9]{40})(?:\\?|$)))/.test(proofPath);
const proofAllowedQuery = proofGraphql && !proofInput && proofExpectedFields && /^query=\\s*query(?:\\s+\\w+)?\\s*\\(/.test(proofQuery) && !/\\bmutation\\b/.test(proofQuery) && (/pullRequest\\(number:\\s*\\$number\\)/.test(proofQuery) || proofFields.length === 1 && proofQuery === \"query=query($after:String){nodes(ids:[\\\"IC_9321\\\"]){id ...on Comment{lastEditedAt userContentEdits(first:100,after:$after){totalCount nodes{id editedAt editor{__typename ...on User{id:databaseId} ...on Bot{id:databaseId}}} pageInfo{hasNextPage endCursor}}}}}\");
const proofAllowedActivityQuery = proofGraphql && !proofInput && proofExpectedFields && proofFields.length === 1 && proofQuery === ${JSON.stringify(`query=${reviewedPrActivityCursorV2Query("openclaw", "openclaw", [321])}`)};
const proofClosingReferenceArgs = ["--repo", "openclaw/openclaw", "issue", "view", "321", "--repo", "openclaw/openclaw", "--json", "closedByPullRequestsReferences"];
const proofAllowedClosingReferences = JSON.stringify(proofArgs) === JSON.stringify(proofClosingReferenceArgs);
const proofEditQueries = ${JSON.stringify([editQuery(["IC_9321", "IC_9500"]), editQuery(["IC_9321", "IC_9600"])])};
const proofAllowedEdits = Boolean(proofEffect) && proofArgs.length === 4 && proofArgs[0] === "api" && proofArgs[1] === "graphql" && proofArgs[2] === "-f" && proofEditQueries.includes(proofArgs[3]);
const proofState = proofEffect && proofFs.existsSync(proofEffect.statePath) ? JSON.parse(proofFs.readFileSync(proofEffect.statePath, "utf8")) : null;
const proofPost = Boolean(proofEffect) && proofEffect.mode !== "human-edit" && !proofState && proofArgs.length === 6 && JSON.stringify(proofArgs.slice(0, 5)) === JSON.stringify(["api", "repos/openclaw/openclaw/issues/321/comments", "--method", "POST", "--input"]) && typeof proofArgs[5] === "string" && proofArgs[5].startsWith(${JSON.stringify(join(process.cwd(), ".artifacts", "comment-321-"))}) && /^[0-9a-f-]{36}\\.json$/.test(proofArgs[5].slice(${join(process.cwd(), ".artifacts", "comment-321-").length}));
let proofPostBody = null;
if (proofPost) {
  try {
    const payload = JSON.parse(proofFs.readFileSync(proofArgs[5], "utf8"));
    if (Object.keys(payload).length === 1 && payload.body === proofEffect.closeoutBody) proofPostBody = payload.body;
  } catch { /* Invalid payloads are denied and traced for exact-file cleanup. */ }
}
const proofClose = Boolean(proofEffect) && proofEffect.mode === "eligible" && proofState && !proofState.closed && JSON.stringify(proofArgs) === JSON.stringify(["--repo", "openclaw/openclaw", "pr", "close", "321"]);
const proofAllowed = Boolean(proofPostBody || proofClose || proofAllowedEdits || proofAllowedClosingReferences || proofNormalized[0] === "api" && proofMethod === "GET" && (proofAllowedQuery || proofAllowedActivityQuery || !proofPayload && proofAllowedPath));
proofFs.appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ args: proofNormalized, rawArgs: proofArgs, allowed: proofAllowed, stage: proofState ? "after-closeout" : "before-closeout", effect: proofPostBody ? "closeout-post" : proofClose ? "item-close" : null }) + "\\n");
if (!proofAllowed) { console.error("PROOF_FORBIDDEN_TRANSPORT_INTENT"); process.exit(86); }
if (proofPostBody) {
  const at = new Date().toISOString();
  const closeout = { id: 9500, node_id: "IC_9500", html_url: "https://github.com/openclaw/openclaw/pull/321#issuecomment-9500", created_at: at, updated_at: at, user: { login: "clawsweeper[bot]", type: "Bot" }, body: proofPostBody };
  proofFs.writeFileSync(proofEffect.statePath, JSON.stringify({ closeout, payload: proofArgs[5], closed: false }));
  proofFs.writeFileSync(proofEffect.commentStatePath, JSON.stringify(closeout));
  console.log(JSON.stringify(closeout)); process.exit(0);
}
if (proofClose) {
  proofFs.writeFileSync(proofEffect.statePath, JSON.stringify({ ...proofState, closed: true }));
  console.log(""); process.exit(0);
}
if (proofAllowedEdits) {
  const ids = JSON.parse(proofArgs[3].split("nodes(ids:")[1].split(")")[0]);
  console.log(JSON.stringify({ data: { nodes: ids.map(id => ({ id, lastEditedAt: id === "IC_9600" ? proofEffect.botEditedAt : null, userContentEdits: { totalCount: id === "IC_9600" ? 2 : 0, nodes: id === "IC_9600" ? [{ id: "edit-human", editedAt: proofEffect.humanEditedAt, editor: { __typename: "User", id: 123 } }, { id: "edit-bot", editedAt: proofEffect.botEditedAt, editor: { __typename: "Bot", id: 456 } }] : [], pageInfo: { hasNextPage: false, endCursor: null } } })) } })); process.exit(0);
}
if (proofState && proofEffect.mode === "late-main" && JSON.stringify(proofArgs) === JSON.stringify(["api", "repos/openclaw/openclaw/commits/main"])) { console.log(JSON.stringify({ sha: "b".repeat(40) })); process.exit(0); }
if (proofState && proofEffect.mode === "late-human" && proofNormalized[0] === "api" && /^repos\\/openclaw\\/openclaw\\/issues\\/321\\/comments(?:\\?|$)/.test(proofPath)) {
  const human = { ...proofEffect.humanComment, created_at: proofState.closeout.created_at, updated_at: proofState.closeout.created_at };
  const comments = [proofEffect.durableComment, proofState.closeout, human];
  console.log(JSON.stringify(proofNormalized.includes("--slurp") ? [comments] : comments)); process.exit(0);
}
if (proofAllowedClosingReferences) { console.log(JSON.stringify({ closedByPullRequestsReferences: [] })); process.exit(0); }
if (JSON.stringify(proofArgs) === JSON.stringify(["api", "search/issues?q=repo%3Aopenclaw%2Fopenclaw%20is%3Apr%20is%3Amerged%20%23321&per_page=10"])) { console.log(JSON.stringify({ total_count: 0, incomplete_results: false, items: [] })); process.exit(0); }
${mock}`;
}

function runScenario(
  name,
  {
    reason,
    canonical = false,
    residual = false,
    drift = false,
    dryRun = false,
    packet = manualDecision,
    finalEffect = null,
  },
) {
  const dir = join(root, name);
  const itemsDir = join(dir, "items"),
    closedDir = join(dir, "closed"),
    plansDir = join(dir, "plans");
  mkdirSync(itemsDir, { recursive: true });
  mkdirSync(plansDir);
  const reportPath = join(dir, "result.json"),
    tracePath = join(dir, "transport.jsonl"),
    proofLog = join(dir, "proof.log");
  const kind =
    reason === "unsponsored_feature_request" ||
    reason === "not_actionable_in_repo" ||
    reason === "clawhub"
      ? "issue"
      : "pull_request";
  const product = reason !== "obsolete_fix_pr";
  // Keep unrelated label publication settled so the deny-write transport can
  // observe the close guard itself without permitting auxiliary mutations.
  const labels = kind === "pull_request" ? ["proof: sufficient", "rating: 🦞 diamond lobster"] : [];
  const closeComment = product
    ? "A maintainer should decide this scope."
    : "Canonical source covers all useful original scope.";
  const report = `${workPlanCandidateReport(
    {
      repository: "openclaw/openclaw",
      number: 321,
      type: kind,
      title: "Synthetic closure scope",
      author: "reporter",
      author_association: "CONTRIBUTOR",
      labels: JSON.stringify(labels),
      decision: "close",
      action_taken: "proposed_close",
      close_reason: reason,
      confidence: "high",
      work_candidate: "none",
      work_status: "none",
      item_snapshot_hash: "synthetic-reviewed-snapshot",
      item_created_at: "2026-01-01T00:00:00Z",
      item_updated_at: "2026-01-01T00:00:00Z",
      pull_head_sha: "head-sha",
      ...(canonical
        ? {
            root_cause_cluster: canonicalPullRequestClusterForTest(
              "https://github.com/openclaw/openclaw/pull/400",
            ),
          }
        : {}),
    },
    {
      itemCategory: product ? "feature" : "bug",
      requiresProductDecision: product,
      requiresNewFeature: product,
      maintainerDecision: product
        ? packet
        : {
            required: false,
            kind: "none",
            question: "",
            rationale: "",
            options: [],
            likelyOwner: { person: "", reason: "", confidence: "low" },
          },
      overallCorrectness: kind === "pull_request" ? "patch is correct" : "not a patch",
      securityReview: { status: "cleared", summary: "Synthetic safe fixture.", concerns: [] },
      realBehaviorProof: {
        status: "sufficient",
        evidenceKind: "terminal",
        summary: "Synthetic prior proof.",
        needsContributorAction: false,
      },
      prRating: {
        overallTier: "A",
        proofTier: "A",
        patchTier: "A",
        summary: "Synthetic proven contribution.",
        nextSteps: [],
      },
      closeComment,
    },
  )}\n\n## Evidence\n\n- Synthetic original-scope evidence is recorded in the typed review.\n\n## Close Comment\n\n${closeComment}\n`;
  assert.equal(reportReviewDecision(report).publishedCloseComment, closeComment);
  assert.deepEqual(
    validateReportClose(
      { validateCloseDecision },
      item({ kind, repo: "openclaw/openclaw", labels, authorAssociation: "CONTRIBUTOR" }),
      report,
      reason,
      { requireCloseComment: true },
    ),
    { ok: true },
    `${name}: well-formed published close recommendation reaches the policy guard`,
  );
  const synced = reportWithSyncedReviewComment(report, 321, reason);
  // Apply renders the durable comment with the pre-apply labels. Seed that same
  // canonical rendering rather than allowing a comment PATCH before the guard.
  synced.comment = markedReviewCommentForTest(
    321,
    renderReviewCommentFromReport(report, reason, { previousLabels: labels, prStatusKind: null }),
  );
  synced.report = synced.report.replace(
    /^review_comment_sha256:.*$/m,
    `review_comment_sha256: ${createHash("sha256").update(synced.comment).digest("hex")}`,
  );
  const itemPath = join(itemsDir, "321.md");
  writeFileSync(itemPath, synced.report);
  const durableComment = {
    id: 9321,
    node_id: "IC_9321",
    html_url: "https://github.com/openclaw/openclaw/pull/321#issuecomment-9321",
    created_at: "2026-05-01T01:00:00Z",
    updated_at: "2026-05-01T01:00:00Z",
    user: { login: "clawsweeper[bot]", type: "Bot" },
    body: synced.comment,
  };
  const humanEditedAt = new Date(Date.now() - 2000).toISOString();
  const botEditedAt = new Date(Date.now() - 1000).toISOString();
  const editedComment = {
    id: 9600,
    node_id: "IC_9600",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: botEditedAt,
    user: { login: "automation[bot]", type: "Bot" },
    body: "An old automation note was edited by the contributor and later by a bot.",
  };
  const humanComment = {
    id: 9601,
    node_id: "IC_9601",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    author_association: "CONTRIBUTOR",
    user: { login: "reporter", type: "User" },
    body: "The original regression still reproduces; I am working on it.",
  };
  const effectStatePath = join(dir, "effect-state.json");
  const effect = finalEffect
    ? {
        mode: finalEffect,
        statePath: effectStatePath,
        commentStatePath: join(dir, "comment-state-321.json"),
        durableComment,
        humanComment,
        humanEditedAt,
        botEditedAt,
        closeoutBody: [
          "ClawSweeper recorded closeout evidence for this proposed close.",
          "",
          "- Action: close remains subject to final live verification.",
          "- Close reason: fix made obsolete by later main-branch changes.",
          `Review evidence: [durable ClawSweeper review](${frontMatterValue(synced.report, "review_comment_url")}).`,
          "- Coverage proof: Current canonical source covers all original scope. Covering PR: https://github.com/openclaw/openclaw/pull/400.",
          "",
          "<!-- clawsweeper-close-applied item=321 -->",
        ].join("\n"),
      }
    : null;
  const mock = promotionGhMock({
    number: 321,
    kind,
    title: "Synthetic closure scope",
    comment: synced.comment,
    ...(finalEffect ? { trackCommentActivity: true } : {}),
    ...(finalEffect === "human-edit" ? { comments: [durableComment, editedComment] } : {}),
    ...(finalEffect === "late-human"
      ? {
          // The receiver supplies the publication-time timestamps. Keep REST's
          // count consistent with that distinct human comment plus the closeout.
          commentsAfterCommentWrite: [durableComment, humanComment],
        }
      : {}),
    labels,
    itemCreatedAt: "2026-01-01T00:00:00Z",
    itemUpdatedAt: "2026-01-01T00:00:00Z",
    headCommittedAt: "2026-01-01T00:00:00Z",
    headActivityAt: "2026-01-01T01:00:00Z",
    changedFiles: 2,
    sourceFiles: ["src/runtime.ts", "test/runtime.test.ts"],
    postHeadPathChanges: {
      "src/runtime.ts": "2026-06-01T00:00:00Z",
      "test/runtime.test.ts": "2026-06-01T00:00:00Z",
    },
    mergeable: true,
    mergeableState: "clean",
    itemUpdatedAtAfterProofLogPath: proofLog,
    ...(drift ? { mainShaAfterProof: "b".repeat(40) } : {}),
    linkedPulls: canonical
      ? {
          400: {
            number: 400,
            title: "Canonical scope",
            html_url: "https://github.com/openclaw/openclaw/pull/400",
            state: "closed",
            merged_at: "2026-06-01T00:00:00Z",
            merge_commit_sha: "c".repeat(40),
            body: "Complete canonical behavior and tests.",
            comments: [],
            labels: [],
          },
        }
      : {},
  });
  try {
    withMockGh(dir, readOnlyTransport(mock, tracePath, effect), () => {
      const bin = join(dir, "bin");
      for (const command of ["gh", "ghx"])
        writeFileSync(
          join(bin, command),
          `#!${process.execPath}\nrequire(${JSON.stringify(join(bin, "gh.js"))});\n`,
          { mode: 0o755 },
        );
      process.env.PATH = `${bin}${delimiter}${savedEnv.PATH ?? ""}`;
      withMockCodexProof(
        dir,
        {
          type: "decision",
          decision: residual ? "keep_open" : "covered",
          reason: residual
            ? "A useful original regression test remains absent from main."
            : "Current canonical source covers all original scope.",
          invocationLogPath: proofLog,
        },
        () => {
          runApplyDecisionsForTest({
            targetRepo: "openclaw/openclaw",
            itemsDir,
            closedDir,
            plansDir,
            reportPath,
            extraArgs: [
              "--apply-kind",
              kind,
              "--apply-close-reasons",
              "all",
              "--item-number",
              "321",
              "--skip-dashboard",
              ...(dryRun ? ["--dry-run"] : []),
            ],
          });
        },
      );
    });
  } finally {
    if (existsSync(tracePath)) {
      const prefix = join(process.cwd(), ".artifacts", "comment-321-");
      for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) {
        const { rawArgs } = JSON.parse(line);
        if (
          rawArgs?.length === 6 &&
          JSON.stringify(rawArgs.slice(0, 5)) ===
            JSON.stringify([
              "api",
              "repos/openclaw/openclaw/issues/321/comments",
              "--method",
              "POST",
              "--input",
            ]) &&
          typeof rawArgs[5] === "string" &&
          rawArgs[5].startsWith(prefix) &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/.test(
            rawArgs[5].slice(prefix.length),
          )
        )
          generatedPayloads.add(rawArgs[5]);
      }
    }
  }
  const decisions = JSON.parse(readFileSync(reportPath, "utf8"));
  const trace = existsSync(tracePath)
    ? readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  assert.equal(
    trace.filter((call) => !call.allowed).length,
    0,
    `${name}: no forbidden write intent`,
  );
  const effectState = existsSync(effectStatePath)
    ? JSON.parse(readFileSync(effectStatePath, "utf8"))
    : null;
  const archived = existsSync(join(closedDir, "321.md"));
  const retained = readFileSync(archived ? join(closedDir, "321.md") : itemPath, "utf8");
  if (finalEffect) {
    assert.equal(dryRun, false);
    assert.equal(canonical, true);
    assert.equal(archived, finalEffect === "eligible");
    assert.equal(existsSync(itemPath), finalEffect !== "eligible");
    assert.equal(effectState?.closed ?? false, finalEffect === "eligible");
    assert.equal(
      trace.filter((call) => call.effect === "closeout-post").length,
      finalEffect === "human-edit" ? 0 : 1,
    );
    assert.equal(
      trace.filter((call) => call.effect === "item-close").length,
      finalEffect === "eligible" ? 1 : 0,
    );
    assert.equal(existsSync(proofLog), finalEffect !== "human-edit");
    assert.equal(decisions.length, 1);
    if (finalEffect === "eligible") {
      assert.equal(decisions[0].action, "closed");
      assert.doesNotMatch(decisions[0].reason, /dry-run/);
      assert.match(retained, /^action_taken: closed$/m);
    } else if (finalEffect === "human-edit") {
      assert.deepEqual(
        decisions.map(({ action, reason }) => ({ action, reason })),
        [{ action: "kept_open", reason: "PR has human edit activity within the last 30 days" }],
      );
      assert.ok(trace.some((call) => call.rawArgs.includes(editQuery(["IC_9321", "IC_9600"]))));
    } else if (finalEffect === "late-human") {
      assert.deepEqual(
        decisions.map(({ action, reason }) => ({ action, reason })),
        [
          {
            action: "skipped_changed_since_review",
            reason: "closeout evidence freshness receipt could not be recorded",
          },
        ],
      );
      assert.ok(
        trace.some(
          (call) =>
            call.stage === "after-closeout" && call.args[1]?.includes("/issues/321/comments"),
        ),
      );
    } else {
      assert.deepEqual(
        decisions.map(({ action, reason }) => ({ action, reason })),
        [
          {
            action: "retry_pr_close_coverage_proof",
            reason: "linked canonical PR #400 changed after coverage proof",
          },
        ],
      );
      assert.ok(
        trace.some(
          (call) =>
            call.stage === "after-closeout" &&
            call.args[1] === "repos/openclaw/openclaw/commits/main",
        ),
      );
    }
  } else if (product) {
    assert.deepEqual(
      decisions.map(({ action, reason: refusal }) => ({ action, refusal })),
      [
        {
          action: "kept_open",
          refusal: `maintainer decision required: ${packet.question || "product-scope rejection needs an item-specific human decision"}`,
        },
      ],
    );
    assert.match(retained, /^action_taken: proposed_close$/m);
  } else if (!canonical) {
    assert.deepEqual(
      decisions.map(({ action, reason }) => ({ action, reason })),
      [
        {
          action: "kept_open",
          reason:
            "duplicate/superseded PR close has no rootCauseCluster.canonicalRef; refusing duplicate/superseded auto-close",
        },
      ],
    );
    assert.equal(
      existsSync(proofLog),
      false,
      "path-only nomination never reaches semantic coverage",
    );
  } else if (residual || drift) {
    assert.equal(decisions.length, 1);
    assert.equal(
      decisions[0].action,
      residual ? "skipped_pr_close_coverage_proof" : "retry_pr_close_coverage_proof",
    );
    assert.match(
      decisions[0].reason,
      residual ? /regression test/ : /changed after coverage proof/,
    );
    assert.equal(existsSync(proofLog), true, "negative control reached independent coverage stage");
  } else {
    assert.equal(decisions[0]?.action, "closed");
    assert.match(decisions[0]?.reason ?? "", /dry-run: would close/);
    assert.equal(existsSync(proofLog), true, "positive control reached independent coverage stage");
  }
  if (!finalEffect) assert.equal(archived, false, `${name}: live item not archived`);
  results.push({
    name,
    dryRun,
    decisions,
    forbiddenIntents: 0,
    calls: trace.map((call) => call.args),
    ...(finalEffect
      ? { finalEffect, archived, syntheticState: effectState?.closed ? "closed" : "open", trace }
      : {}),
  });
}

try {
  const sourceCandidate = sourceManifest();
  const buildCommand = ["pnpm", "run", "build:node"];
  const buildEnv = { PATH: savedEnv.PATH, HOME: savedEnv.HOME, COREPACK_ENABLE_NETWORK: "0" };
  const packageNames = Object.keys({
    ...JSON.parse(readFileSync("package.json", "utf8")).dependencies,
    ...JSON.parse(readFileSync("package.json", "utf8")).devDependencies,
  }).sort();
  const installedPackages = packageNames.map((name) => {
    const path = `node_modules/${name}/package.json`,
      bytes = readFileSync(path),
      pkg = JSON.parse(bytes);
    const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
    return {
      name,
      version: pkg.version,
      packageJsonSha256: createHash("sha256").update(bytes).digest("hex"),
      bins: bins.map((bin) => ({
        path: bin,
        sha256: createHash("sha256")
          .update(readFileSync(`node_modules/${name}/${bin}`))
          .digest("hex"),
      })),
    };
  });
  const dependencyReceipt = {
    pnpm: execFileSync("pnpm", ["--version"], { env: buildEnv, encoding: "utf8" }).trim(),
    installedLockSha256: createHash("sha256")
      .update(readFileSync("node_modules/.pnpm/lock.yaml"))
      .digest("hex"),
    installedPackages,
  };
  // Build only frozen, already-installed dependencies. Corepack may not fetch.
  execFileSync(buildCommand[0], buildCommand.slice(1), { env: buildEnv, stdio: "pipe" });
  assert.deepEqual(sourceManifest(), sourceCandidate, "source stayed frozen through build");
  const builtCandidate = fileManifest(["dist"]);
  const fixtureInputs = fixtureManifest();
  assert.ok(builtCandidate.files.some((file) => file.path === "dist/clawsweeper.js"));
  // A base-environment allowlist excludes alternate runners and credentials,
  // including names unknown to this fixture. Only the fake Codex path is used.
  for (const key of Object.keys(process.env)) delete process.env[key];
  process.env.PATH = savedEnv.PATH ?? "/usr/bin:/bin";
  process.env.HOME = join(root, "home");
  process.env.TMPDIR = root;
  process.env.LANG = "C.UTF-8";
  mkdirSync(process.env.HOME);
  process.env.CLAWSWEEPER_RUNNER = "codex";
  process.env.GH_CONFIG_DIR = join(root, "empty-gh-auth");
  mkdirSync(process.env.GH_CONFIG_DIR);
  process.env.CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED = "true";
  process.env.CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED = "true";
  process.env.CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED = "true";
  process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS = "1";
  ({
    canonicalPullRequestClusterForTest,
    closeDecision,
    item,
    markedReviewCommentForTest,
    promotionGhMock,
    reportWithSyncedReviewComment,
    runApplyDecisionsForTest,
    withMockCodexProof,
    withMockGh,
    workPlanCandidateReport,
  } = await import("../../../test/helpers.ts"));
  ({ validateCloseDecision } = await import("../../../dist/clawsweeper-close-decision.js"));
  ({ validateReportClose } = await import("../../../dist/clawsweeper-apply-close-decision.js"));
  ({ reportReviewDecision } = await import("../../../dist/report-review-decision.js"));
  ({ frontMatterValue } = await import("../../../dist/report-front-matter.js"));
  ({ renderReviewCommentFromReport } =
    await import("../../../dist/clawsweeper-report-comment-presentation.js"));
  ({ reviewedPrActivityCursorV2Query } = await import("../../../dist/review-activity-cursor.js"));
  for (const reason of [
    "unconfirmed_product_direction",
    "unsponsored_feature_request",
    "clawhub",
    "not_actionable_in_repo",
  ]) {
    for (const packet of [
      { ...manualDecision, required: false },
      { ...manualDecision, kind: "manual_review" },
    ]) {
      const validation = validateCloseDecision(
        item({ kind: reason === "unconfirmed_product_direction" ? "pull_request" : "issue" }),
        closeDecision({ closeReason: reason, maintainerDecision: packet }),
      );
      assert.equal(validation.ok, false);
      assert.match(validation.reason, /outstanding product-direction maintainer decision/);
      results.push({
        name: `${reason}-packet-${packet.required ? "wrong-kind" : "required-false"}`,
        validation,
      });
    }
    runScenario(reason, { reason });
  }
  runScenario("obsolete-path-only", { reason: "obsolete_fix_pr", dryRun: true });
  runScenario("obsolete-covered-control", {
    reason: "obsolete_fix_pr",
    canonical: true,
    dryRun: true,
  });
  runScenario("obsolete-useful-test", {
    reason: "obsolete_fix_pr",
    canonical: true,
    residual: true,
    dryRun: true,
  });
  runScenario("obsolete-main-drift", {
    reason: "obsolete_fix_pr",
    canonical: true,
    drift: true,
    dryRun: true,
  });
  for (const finalEffect of ["eligible", "human-edit", "late-human", "late-main"]) {
    runScenario(`obsolete-final-${finalEffect}`, {
      reason: "obsolete_fix_pr",
      canonical: true,
      finalEffect,
    });
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const diff = execFileSync("git", ["diff", "--binary", "HEAD"], { maxBuffer: 32 * 1024 * 1024 });
  assert.deepEqual(
    fileManifest(["dist"]),
    builtCandidate,
    "built candidate stayed frozen during proof",
  );
  assert.deepEqual(fixtureManifest(), fixtureInputs, "fixture inputs stayed frozen during proof");
  assert.deepEqual(sourceManifest(), sourceCandidate, "full source stayed frozen during proof");
  console.log(
    JSON.stringify(
      {
        head,
        trackedDiffSha256: createHash("sha256").update(diff).digest("hex"),
        node: process.version,
        sourceCandidate,
        buildCommand,
        dependencyReceipt,
        builtCandidate,
        fixtureInputs,
        command: "node docs/proof/closure-evidence/run-proof.mjs",
        results,
        limits:
          "Synthetic GitHub and semantic-proof responses; proves production apply guard plumbing, not independent semantic truth or a hosted/live close.",
      },
      null,
      2,
    ),
  );
  console.log("CLOSURE_EVIDENCE_PROOF_OK");
} finally {
  for (const payload of generatedPayloads) {
    rmSync(payload, { force: true });
    rmSync(payload.replace(/\.json$/, ".md"), { force: true });
  }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
}
