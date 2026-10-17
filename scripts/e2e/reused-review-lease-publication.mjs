#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const source = process.cwd();
const productHoldProof = process.env.PROOF_PRODUCT_DIRECTION_HOLD === "1";
const holdProof = productHoldProof || process.env.PROOF_CLOSE_POLICY_HOLD === "1";
const targetRepo = holdProof ? "openclaw/openclaw" : "openclaw/clawsweeper";
const staleProof = process.env.PROOF_STALE_REVIEW_PUBLICATION === "1";
const publisherProof = staleProof || holdProof || process.env.PROOF_ACTIVE_LEASE_DEFERRAL === "1";
const deferralProof = process.env.PROOF_ACTIVE_LEASE_DEFERRAL === "1";
assert.equal(
  process.argv.length,
  5,
  "usage: node scripts/e2e/reused-review-lease-publication.mjs <baseline-dist> <candidate-dist> <output-dir>",
);
const [baseline, candidate, out] = process.argv.slice(2).map((value) => resolve(value));
mkdirSync(out, { recursive: true });
assert.equal(
  readdirSync(out).length,
  0,
  "use an empty output directory for isolated ledger and fixture state",
);
const { workPlanCandidateReport, reportWithSyncedReviewComment } = await import(
  pathToFileURL(join(source, "test/helpers.ts"))
);
const { itemSourceRevisionSha256 } = await import(
  pathToFileURL(join(source, "dist/clawsweeper-source-revision.js"))
);
const { renderReviewStartStatusComment } = await import(
  pathToFileURL(join(source, "dist/clawsweeper.js"))
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function compiledIdentity(dir) {
  const files = [];
  function walk(relative = "") {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push([path, hash(readFileSync(join(dir, path)))]);
    }
  }
  walk();
  return hash(JSON.stringify(files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}
const sourceFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split(String.fromCharCode(0))
  .filter(Boolean)
  .sort();
const candidateFullSourceSha256 = hash(
  JSON.stringify(sourceFiles.map((file) => [file, hash(readFileSync(file))])),
);
const identity = {
  candidateFullSourceSha256,
  provider: process.env.PROOF_PROVIDER,
  lease: process.env.PROOF_LEASE,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  candidateSourceSha256: execFileSync(
    process.execPath,
    ["scripts/e2e/manual-review-publication.mjs", "source-id"],
    { encoding: "utf8" },
  ).trim(),
  candidateOwnerSourceSha256: hash(
    readFileSync(
      holdProof
        ? "src/clawsweeper-apply-decision-workflow.ts"
        : deferralProof
          ? "src/repair/publish-event-result.ts"
          : "src/clawsweeper-review-comment-state.ts",
    ),
  ),
  baselineDistSha256: compiledIdentity(baseline),
  candidateDistSha256: compiledIdentity(candidate),
};
const { reportReviewDecision } = await import(
  pathToFileURL(join(source, "dist/report-review-decision.js"))
);
const { issueAdvisoryLabelState, nextIssueAdvisoryLabels } = await import(
  pathToFileURL(join(source, "dist/clawsweeper-label-selection.js"))
);
const { nextPrRatingLabels } = await import(
  pathToFileURL(join(source, "dist/clawsweeper-rating.js"))
);
const { nextPrStatusLabels, prStatusLabelKindFromReport } = await import(
  pathToFileURL(join(source, "dist/clawsweeper-label-policy.js"))
);
const { createReviewedPrActivityCursorV2, reviewedPrActivityCursorV2Query } = await import(
  pathToFileURL(join(source, "dist/review-activity-cursor.js"))
);
const emptyActivityCursor = createReviewedPrActivityCursorV2({
  reviews: [],
  inlineComments: [],
  reviewThreads: [],
});
const results = [];
const replayNow = Date.now();
const candidateBoundaryReads = {};
const deferralStepOutputs = {};
for (const kind of productHoldProof ? ["pull_request"] : ["issue", "pull_request"]) {
  for (const [variant, dist, newerLive] of holdProof
    ? [
        ["baseline", baseline, false],
        ["candidate", candidate, false],
        ["missing-evidence", candidate, false],
        ["read-failure", candidate, false],
        ["changed-source", candidate, false],
        ["incomplete-receipt", candidate, false],
        ...(kind === "pull_request" ? [["changed-during-apply", candidate, false]] : []),
        ...(productHoldProof
          ? [
              ["young-pr", candidate, false],
              ["disabled-policy", candidate, false],
            ]
          : []),
      ]
    : staleProof
      ? [
          ["baseline", baseline, true],
          ["candidate", candidate, true],
          ["equal-time", candidate, true],
          ["older-live", candidate, false],
          ["unknown-owner", candidate, true],
          ["missing-source", candidate, true],
          ["different-source", candidate, true],
          ["duplicate-version", candidate, true],
          ...(kind === "pull_request" ? [["inconsistent-state", candidate, true]] : []),
          ["read-failure", candidate, true],
          ["changed-source", candidate, true],
        ]
      : deferralProof
        ? [
            ["baseline", baseline, false],
            ["candidate", candidate, false],
          ]
        : [
            ["baseline", baseline, false],
            ["candidate", candidate, false],
            ["newer-live-control", candidate, true],
            ["no-original-lease", candidate, false],
            ["expired-original-lease", candidate, false],
            ["lease-replaced-at-boundary", candidate, false],
          ]) {
    const name = kind + "-" + variant;
    const root = join(out, name);
    mkdirSync(join(root, "items"), { recursive: true });
    mkdirSync(join(root, "plans"), { recursive: true });
    const now = replayNow,
      reportAt = new Date(now - 300000).toISOString();
    const liveAt =
      variant === "equal-time"
        ? reportAt
        : new Date(now - (newerLive ? 120000 : 600000)).toISOString();
    const number = kind === "issue" ? 103599 : 171791;
    const issue = {
      number,
      title: holdProof
        ? "Verified close-policy hold replay"
        : "Reused command lease publication replay",
      body: "Stable reviewed source.",
      html_url: "https://github.com/" + targetRepo + "/issues/" + number,
      created_at: "2026-04-01T00:00:00Z",
      updated_at: reportAt,
      closed_at: null,
      state: "open",
      locked: false,
      active_lock_reason: null,
      author_association: "CONTRIBUTOR",
      user: { login: "reporter" },
      labels: [],
      comments: 2,
      pull_request:
        kind === "pull_request"
          ? { url: "https://api.github.com/repos/" + targetRepo + "/pulls/" + number }
          : null,
    };
    // Keep labels already synchronized so this replay isolates comment publication.
    // Label writes remain forbidden by the HTTP peer below.
    const proofReport = (fields) =>
      workPlanCandidateReport(
        fields,
        productHoldProof
          ? {
              itemCategory: "feature",
              requiresProductDecision: true,
              requiresNewFeature: true,
              overallCorrectness: "patch is correct",
              reviewFindings: [],
              securityReview: { status: "cleared", summary: "No security concerns.", concerns: [] },
              realBehaviorProof: {
                status: "sufficient",
                evidenceKind: "terminal",
                needsContributorAction: false,
                summary: "Controlled runtime proof.",
              },
              prRating: {
                overallTier: "B",
                proofTier: "A",
                patchTier: "B",
                summary: "Ready for product decision.",
                nextSteps: [],
              },
            }
          : {},
      );
    if (productHoldProof && variant === "missing-evidence") issue.created_at = "invalid";
    if (productHoldProof && variant === "young-pr")
      issue.created_at = new Date(now - 10 * 86400000).toISOString();
    const labelReport = proofReport({ type: kind, reviewed_at: reportAt });
    const labelDecision = reportReviewDecision(labelReport);
    const labelNames =
      kind === "issue"
        ? nextIssueAdvisoryLabels([], issueAdvisoryLabelState(labelReport, labelDecision))
        : nextPrStatusLabels(
            nextPrRatingLabels([], labelDecision.prRating),
            prStatusLabelKindFromReport(labelReport, { comments: [], timeline: [] }, []),
          );
    issue.labels = labelNames.map((name) => ({ name }));
    const humanComment = {
      id: 6161755397,
      created_at: new Date(now - 600000).toISOString(),
      updated_at: new Date(now - 600000).toISOString(),
      author_association: "NONE",
      user: { login: "reporter", type: "User" },
      body: "This remains relevant.",
    };
    if (holdProof && kind === "issue" && variant === "missing-evidence")
      humanComment.created_at = "invalid";
    if (holdProof && kind === "issue") issue.comments = 3;
    const revision = itemSourceRevisionSha256(
        issue,
        holdProof && kind === "issue" ? [humanComment] : [],
      ),
      head = "a".repeat(40);
    const owner = "github-run-current-1",
      leaseId = 6178075898;
    const fields = {
      repository: targetRepo,
      number,
      type: kind,
      title: issue.title,
      reviewed_at: reportAt,
      item_updated_at: reportAt,
      item_source_revision: revision,
      item_snapshot_hash: "reviewed-snapshot",
      ...(kind === "pull_request" ? { review_activity_cursor: emptyActivityCursor } : {}),
      review_lease_owner: owner,
      review_lease_comment_id: String(leaseId),
      pull_head_sha: kind === "pull_request" ? head : "unknown",
      labels: JSON.stringify(labelNames),
      ...(holdProof
        ? {
            decision: "close",
            action_taken: "proposed_close",
            close_reason: productHoldProof
              ? "unconfirmed_product_direction"
              : kind === "issue"
                ? "stale_insufficient_info"
                : "obsolete_fix_pr",
            confidence: "high",
            item_created_at: issue.created_at,
            work_candidate: "none",
            work_status: "none",
            ...(variant === "incomplete-receipt" ? {} : { review_timeline_revision: hash("[]") }),
          }
        : {}),
    };
    const report = proofReport(fields);
    let durable = reportWithSyncedReviewComment(
      proofReport({
        ...fields,
        reviewed_at: liveAt,
        review_lease_owner: "github-run-previous-1",
      }),
      number,
    ).comment;
    if (staleProof) {
      if (variant === "unknown-owner")
        durable = durable.replaceAll("github-run-previous-1", "unknown");
      if (variant === "missing-source") durable = durable.replace(/ source_revision=\S+/g, "");
      if (variant === "different-source") durable = durable.replaceAll(revision, "e".repeat(64));
      if (variant === "duplicate-version")
        durable = durable.replace(/(<!-- clawsweeper-review-version[^\n]+\n)/, "$1$1");
      if (variant === "inconsistent-state")
        durable = durable.replace(
          /(<!-- clawsweeper-review-state:[^\n]+ sha=)[^\s]+/,
          "$1" + "c".repeat(40),
        );
    }
    const lease = renderReviewStartStatusComment({
      number,
      kind,
      title: issue.title,
      headSha: kind === "pull_request" ? head : revision,
      startedAt: new Date(now - 360000).toISOString(),
      leaseExpiresAt: new Date(
        now + (variant === "expired-original-lease" ? -60000 : 1800000),
      ).toISOString(),
      leaseOwner: deferralProof ? "github-run-active-review-1" : owner,
    });
    const comments = [
      {
        id: 6161755396,
        html_url: issue.html_url + "#issuecomment-6161755396",
        created_at: liveAt,
        updated_at: liveAt,
        user: { login: "clawsweeper[bot]", type: "Bot" },
        body: durable,
      },
      {
        id: leaseId,
        html_url: issue.html_url + "#issuecomment-" + leaseId,
        created_at: reportAt,
        updated_at: reportAt,
        user: { login: "clawsweeper[bot]", type: "Bot" },
        body: lease,
      },
    ];
    if (staleProof) comments.splice(1, 1);
    if (holdProof && kind === "issue") comments.push(humanComment);
    if ((holdProof || staleProof) && variant === "changed-source")
      issue.body = "Edited after the reviewed snapshot.";
    if (variant === "no-original-lease") comments.splice(1, 1);
    let commentReads = 0;
    let issueReads = 0;
    let activityReads = 0;
    const pull = {
      ...issue,
      head: {
        sha: head,
        ref: "fix/example",
        repo: {
          full_name: "contributor/example",
          clone_url: "https://github.com/contributor/example.git",
        },
      },
      base: { sha: "b".repeat(40), ref: "main", repo: { full_name: targetRepo } },
      draft: false,
      mergeable: true,
      merged: false,
      additions: 1,
      deletions: 1,
      changed_files: 1,
      commits: 1,
    };
    writeFileSync(join(root, "items", number + ".md"), report);
    writeFileSync(join(root, "fixture.json"), JSON.stringify({ issue, pull, comments }));
    const trace = [];
    const server = createServer(async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const path = new URL(req.url, "http://proof.invalid").pathname.replace(/^\/api\/v3/, "");
      const entry = { method: req.method, path, bodySha256: hash(text) };
      trace.push(entry);
      const send = (value, status = 200) => {
        res.writeHead(status, {
          "content-type": "application/json",
          "x-github-request-id": "0000:0000:0000:0000",
        });
        res.end(JSON.stringify(value));
      };
      const prefix = "/repos/" + targetRepo;
      if (req.method === "POST" && path.endsWith("graphql")) {
        const payload = JSON.parse(text);
        const normalizeQuery = (value) => String(value).replace(/[\s,]+/g, "");
        // Match the CLI's IssueByNumber read and the runtime's exact activity read.
        // Unknown operations must fail this peer rather than masquerade as reads.
        const issueQuery = `query IssueByNumber($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) { hasIssuesEnabled
            issue: issueOrPullRequest(number: $number) { __typename
              ...on Issue { closedByPullRequestsReferences(first: 100) {
                nodes { id number url repository { id name owner { id login } } }
                pageInfo { hasNextPage endCursor }
              } id }
              ...on PullRequest { id }
            }
          }
        }`;
        const activityQuery = reviewedPrActivityCursorV2Query(...targetRepo.split("/"), [number]);
        const isActivityQuery = normalizeQuery(payload.query) === normalizeQuery(activityQuery);
        if (
          ![issueQuery, activityQuery].some(
            (query) => normalizeQuery(query) === normalizeQuery(payload.query),
          )
        ) {
          entry.forbidden = { query: payload.query };
          return send({ message: "unexpected GraphQL operation" }, 422);
        }

        const empty = {
          totalCount: 0,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        };
        const pr = {
          reviews: empty,
          reviewThreads: empty,
          closedByPullRequestsReferences: { nodes: [] },
        };
        if (productHoldProof && isActivityQuery) {
          entry.activityReadOrdinal = ++activityReads;
          if (variant === "changed-during-apply" && activityReads === 2) {
            // Initial context is captured before this final lease check. Its
            // following source re-read must observe the edited body.
            assert.equal(issueReads, 2);
            issue.body += "\nEdited after context capture while checking close policy.";
            pull.body = issue.body;
            entry.sourceEditedDuringPolicy = true;
          }
        }
        return send({
          data: {
            repository: {
              ["pr_" + number]: pr,
              pullRequest: pr,
              issue: { closedByPullRequestsReferences: { nodes: [] } },
            },
          },
        });
      }
      if (req.method === "GET" && path === prefix + "/issues/" + number) {
        issueReads++;
        if (productHoldProof && issueReads > 2 && variant === "read-failure")
          return send({ message: "upstream unavailable" }, 503);
        if (productHoldProof) entry.sourceBodySha256 = hash(issue.body);
        return send(issue);
      }
      if (req.method === "GET" && path === prefix + "/pulls/" + number) return send(pull);
      if (holdProof && req.method === "GET" && path === prefix + "/commits/" + head) {
        if (variant === "changed-during-apply") {
          issue.body += "\nEdited after context capture while checking close policy.";
          pull.body = issue.body;
          entry.sourceEditedDuringPolicy = true;
        }
        return variant === "read-failure"
          ? send({ message: "upstream unavailable" }, 503)
          : send({
              commit: {
                committer: {
                  date: variant === "missing-evidence" ? "" : new Date(now - 600000).toISOString(),
                },
              },
            });
      }
      if (holdProof && req.method === "GET" && path === prefix + "/actions/runs")
        return send({ total_count: 0, workflow_runs: [] });
      if (req.method === "GET" && path === prefix + "/commits/" + head + "/status")
        return send({ state: "pending", statuses: [], total_count: 0 });
      if (req.method === "GET" && path === prefix + "/commits/" + head + "/check-runs")
        return send({ total_count: 0, check_runs: [] });
      if (req.method === "GET" && path === prefix + "/issues/" + number + "/comments") {
        commentReads++;
        if (staleProof && variant === "read-failure")
          return send({ message: "upstream unavailable" }, 503);
        if (holdProof && kind === "issue" && variant === "read-failure" && commentReads > 2)
          return send({ message: "upstream unavailable" }, 503);
        // The issue source-digest read follows the lease snapshot; PR head reads
        // do not list comments. Replace before the final lease-election snapshot.
        if (
          variant === "lease-replaced-at-boundary" &&
          commentReads >= candidateBoundaryReads[kind] - (kind === "issue" ? 1 : 0)
        ) {
          const status = comments.find((comment) => comment.id === leaseId);
          if (status) {
            status.body = status.body.replaceAll(owner, "github-run-replacement-1");
            entry.leaseReplacedAtRead = commentReads;
          }
        }
        return send(comments);
      }
      if (req.method === "GET" && /\/(timeline|reviews|comments|files|commits)$/.test(path))
        return send([]);
      const match = path.match(/\/issues\/comments\/(\d+)$/);
      if (match) {
        const index = comments.findIndex((comment) => comment.id === Number(match[1]));
        if (index >= 0 && req.method === "GET") return send(comments[index]);
        if (index >= 0 && req.method === "PATCH") {
          const payload = JSON.parse(text);
          if (Number(match[1]) === 6161755396) {
            entry.commentReadsBeforePatch = commentReads;
            if (variant === "candidate") candidateBoundaryReads[kind] = commentReads;
          }
          assert.equal(typeof payload.body, "string");
          comments[index].body = payload.body;
          comments[index].updated_at = new Date().toISOString();
          entry.resultBodySha256 = hash(payload.body);
          return send(comments[index]);
        }
        if (index >= 0 && Number(match[1]) === leaseId && req.method === "DELETE") {
          comments.splice(index, 1);
          return send(null, 204);
        }
      }
      if (req.method === "GET" && path === "/search/issues")
        return send({ items: [], total_count: 0 });
      entry.forbidden = true;
      return send({ message: "unexpected proof request " + req.method + " " + path }, 500);
    });
    const socket = join(root, "gh.sock");
    await new Promise((done) => server.listen(socket, done));
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      GH_CONFIG_DIR: join(root, "gh-config"),
      GH_HOST: "proof.invalid",
      GH_ENTERPRISE_TOKEN: "synthetic-only-token",
      GH_TOKEN: "synthetic-only-token",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
      CLAWSWEEPER_ACTION_LEDGER_ROOT: join(root, "events"),
      CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT: join(root, "event-output"),
      CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: reportAt.slice(0, 10),
      GITHUB_REPOSITORY: targetRepo,
      GITHUB_SHA: identity.baseCommit,
      GITHUB_WORKFLOW: "reused-review-lease-proof",
      GITHUB_JOB: name,
      GITHUB_RUN_ID: String(replayNow),
      GITHUB_RUN_ATTEMPT: "1",
      CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
      ...(publisherProof
        ? {
            TARGET_REPO: targetRepo,
            ITEM_NUMBER: String(number),
            REVIEW_ONLY: holdProof ? "false" : "true",
            CLAWSWEEPER_OBSOLETE_FIX_PR_CLOSE_ENABLED: "true",
            CLAWSWEEPER_UNCONFIRMED_PRODUCT_DIRECTION_CLOSE_ENABLED:
              variant === "disabled-policy" ? "false" : "true",
            CLOSE_REASONS: "stale_insufficient_info,obsolete_fix_pr,unconfirmed_product_direction",
            EXACT_REVIEW_BATCH_ITEM_KEY: "proof-member",
            EXACT_REVIEW_BATCH_REVISION: "1",
            EXACT_REVIEW_BATCH_CLAIM_GENERATION: "1",
            EXACT_EVENT_PUBLICATION: "true",
            CLAWSWEEPER_CODE_ROOT: dirname(dist),
            EXACT_REVIEW_WORK_ROOT: root,
            EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR: join(root, "items"),
            EXACT_REVIEW_BATCH_MUTATION_OUTPUT: join(root, "batch.json"),
            GITHUB_OUTPUT: join(root, "github-output"),
          }
        : {}),
    };
    execFileSync("gh", ["config", "set", "http_unix_socket", socket], { env });
    await new Promise((done, reject) => {
      const probe = spawn("gh", ["api", "repos/" + targetRepo + "/issues/" + number], {
        env,
        stdio: "ignore",
      });
      probe.once("error", reject);
      probe.once("exit", (code) => (code === 0 ? done() : reject(new Error("gh probe failed"))));
    });
    const args = publisherProof
      ? [join(dist, "repair/publish-event-result.js")]
      : [
          join(dist, "clawsweeper.js"),
          "apply-decisions",
          "--target-repo",
          targetRepo,
          "--items-dir",
          join(root, "items"),
          "--closed-dir",
          join(root, "closed"),
          "--plans-dir",
          join(root, "plans"),
          "--report-path",
          join(root, "apply-report.json"),
          "--item-numbers",
          String(number),
          "--limit",
          "1",
          "--processed-limit",
          "1",
          "--close-delay-ms",
          "0",
          "--sync-comments-only",
          "--skip-dashboard",
          "--event-apply-proof",
          "--exact-event-publication",
        ];
    let stdout = "",
      stderr = "";
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: source,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => (stdout += data));
      child.stderr.on("data", (data) => (stderr += data));
      child.once("error", reject);
      child.once("exit", done);
    });
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    writeFileSync(join(root, "stdout.txt"), stdout);
    writeFileSync(join(root, "stderr.txt"), stderr);
    writeFileSync(join(root, "trace.json"), JSON.stringify(trace, null, 2));
    const applyReportPath = join(
      root,
      publisherProof ? ".artifacts/event-apply-report.json" : "apply-report.json",
    );
    assert.ok(existsSync(applyReportPath), stderr + stdout);
    const actions = JSON.parse(readFileSync(applyReportPath, "utf8"));
    const batchOutcome =
      publisherProof && existsSync(join(root, "batch.json"))
        ? JSON.parse(readFileSync(join(root, "batch.json"), "utf8"))
        : null;
    const stepOutputs =
      publisherProof && existsSync(join(root, "github-output"))
        ? readFileSync(join(root, "github-output"), "utf8")
        : "";
    const patches = trace.filter(
      (entry) => entry.method === "PATCH" && entry.path.endsWith("/issues/comments/6161755396"),
    );
    const expected =
      variant === "candidate" ? "review_comment_synced" : "skipped_stale_review_comment_sync";
    const resultingBody = comments.find((comment) => comment.id === 6161755396)?.body;
    const result = {
      name,
      code,
      actions,
      durablePatches: patches.length,
      requests: trace.length,
      fixtureSha256: hash(readFileSync(join(root, "fixture.json"))),
      reportSha256: hash(report),
      resultingDurableBodySha256: hash(resultingBody ?? ""),
      forbidden: trace.filter((entry) => entry.forbidden),
      ...(publisherProof ? { batchOutcome, stepOutputsSha256: hash(stepOutputs) } : {}),
    };
    results.push(result);
    writeFileSync(
      join(out, "receipt.json"),
      JSON.stringify(
        {
          identity,
          node: process.version,
          gh: execFileSync("gh", ["--version"], { encoding: "utf8" }).split("\n")[0],
          results,
        },
        null,
        2,
      ),
    );
    if (!holdProof && !staleProof) assert.equal(code, 0, stderr + stdout);
    assert.deepEqual(result.forbidden, []);
    if (staleProof) {
      assert.equal(patches.length, 0);
      assert.ok(
        trace.every(
          (entry) =>
            entry.method === "GET" || (entry.method === "POST" && entry.path.endsWith("graphql")),
        ),
      );
      // PR leases bind the head. A later body edit does not undo the completed
      // successor or authorize this obsolete artifact to request another review.
      if (variant === "candidate" || (variant === "changed-source" && kind === "pull_request")) {
        assert.equal(code, 0, stderr + stdout);
        assert.equal(actions.length, 1);
        assert.equal(actions[0]?.action, "skipped_stale_review_comment_sync");
        assert.equal(actions[0]?.newerReviewTupleVerified, true);
        assert.deepEqual(batchOutcome, {
          kind: "superseded",
          disposition: { requeueLatestExpected: false },
        });
        assert.ok(stepOutputs.includes("completion_kind=superseded\n"));
        assert.ok(stepOutputs.includes("reason_code=remote_newer_tuple\n"));
      } else if (variant === "read-failure") {
        assert.notEqual(code, 0);
        assert.deepEqual(actions, []);
        assert.equal(batchOutcome?.kind, "retryable_failure");
        assert.equal(batchOutcome?.reasonCode, "github_transient");
      } else if (variant === "changed-source") {
        assert.equal(code, 0, stderr + stdout);
        assert.equal(actions[0]?.action, "skipped_changed_since_review");
        assert.equal(batchOutcome?.disposition.requeueLatestExpected, true);
      } else {
        assert.notEqual(code, 0);
        assert.equal(actions.length, 1);
        assert.equal(actions[0]?.action, "skipped_stale_review_comment_sync");
        assert.equal(actions[0]?.newerReviewTupleVerified, undefined);
        assert.equal(batchOutcome?.kind, "permanent_failure");
        assert.equal(batchOutcome?.reasonCode, "unknown_failure");
      }
    } else if (holdProof) {
      assert.equal(patches.length, 0);
      assert.ok(
        trace.every(
          (entry) =>
            entry.method === "GET" || (entry.method === "POST" && entry.path.endsWith("graphql")),
        ),
        JSON.stringify(trace),
      );
      if (variant === "candidate" || variant === "young-pr") {
        assert.equal(code, 0, stderr + stdout);
        assert.equal(actions[0]?.action, "kept_open");
        assert.equal(actions[0]?.guardedOpenStateVerified, true);
        assert.equal(actions[0]?.closePolicyHoldVerified, true);
        assert.equal(batchOutcome?.kind, "eligible");
        assert.equal(batchOutcome?.disposition.guardedOpenAction, "kept_open");
        assert.equal(batchOutcome?.disposition.routableSyncExpected, false);
      } else if (variant === "changed-source" || variant === "changed-during-apply") {
        assert.equal(code, 0, stderr + stdout);
        assert.equal(actions[0]?.action, "skipped_changed_since_review");
        assert.equal(actions[0]?.closePolicyHoldVerified, undefined);
        assert.equal(batchOutcome?.disposition.requeueLatestExpected, true);
        if (variant === "changed-during-apply") {
          const mutationIndex = trace.findIndex((entry) => entry.sourceEditedDuringPolicy);
          assert.ok(mutationIndex >= 0);
          if (productHoldProof) {
            assert.ok(mutationIndex > trace.findIndex((entry) => entry.activityReadOrdinal === 1));
            const snapshots = trace.filter((entry) => entry.sourceBodySha256);
            assert.equal(snapshots[0].sourceBodySha256, snapshots[1].sourceBodySha256);
            assert.ok(
              trace
                .slice(mutationIndex + 1)
                .some(
                  (entry) =>
                    entry.sourceBodySha256 &&
                    entry.sourceBodySha256 !== snapshots[0].sourceBodySha256,
                ),
            );
          }
        }
      } else if (productHoldProof && variant === "read-failure") {
        assert.notEqual(code, 0);
        assert.deepEqual(actions, []);
        assert.equal(batchOutcome?.kind, "retryable_failure");
        assert.equal(batchOutcome?.reasonCode, "github_transient");
        assert.ok(stepOutputs.includes("reason_code=github_transient\n"));
      } else {
        assert.notEqual(code, 0);
        assert.equal(actions.length, 1);
        assert.equal(actions[0]?.number, number);
        assert.equal(actions[0]?.action, "kept_open");
        assert.equal(actions[0]?.closePolicyHoldVerified, undefined);
        assert.equal(actions[0]?.guardedOpenStateVerified, undefined);
        assert.equal(batchOutcome?.kind, "permanent_failure");
        assert.equal(batchOutcome?.reasonCode, "unknown_failure");
        assert.ok(stepOutputs.includes("completion_kind=permanent_failure\n"));
        assert.ok(stepOutputs.includes("reason_code=unknown_failure\n"));
      }
    } else if (deferralProof) {
      const retryAt = new Date(now + 1800000).toISOString();
      assert.equal(actions[0]?.action, "kept_open");
      assert.equal(actions[0]?.activeReviewLeaseVerified, true);
      assert.equal(patches.length, 0);
      assert.ok(
        trace.every(
          (entry) =>
            entry.method === "GET" || (entry.method === "POST" && entry.path.endsWith("graphql")),
        ),
      );
      assert.ok(stepOutputs.includes("reason_code=review_lease_active\n"));
      assert.ok(stepOutputs.includes("retry_at=" + retryAt + "\n"));
      if (variant === "baseline") {
        assert.equal(batchOutcome, null);
        deferralStepOutputs[kind] = stepOutputs;
      } else {
        assert.deepEqual(batchOutcome, {
          kind: "retryable_failure",
          reasonCode: "review_lease_active",
          retryAt,
        });
        assert.equal(stepOutputs, deferralStepOutputs[kind]);
      }
    } else if (variant === "lease-replaced-at-boundary") {
      assert.ok(
        trace.some((entry) => entry.leaseReplacedAtRead),
        "replacement must be observed by a live comment read",
      );
      assert.ok(
        actions.some((action) => /lease/.test(action.reason)),
        JSON.stringify(result),
      );
      assert.ok(
        actions.every((action) => action.action !== "review_comment_synced"),
        JSON.stringify(result),
      );
    } else assert.equal(actions[0]?.action, expected, JSON.stringify(result));
    if (!publisherProof)
      assert.equal(patches.length, variant === "candidate" ? 1 : 0, JSON.stringify(result));
    if (!publisherProof && variant === "candidate") {
      assert.match(resultingBody, /lease_owner=github-run-current-1/);
      assert.ok(resultingBody.includes("reviewed_at=" + reportAt));
    }
    console.log(
      JSON.stringify({
        name,
        code,
        actions,
        durablePatches: patches.length,
        requests: trace.length,
      }),
    );
  }
}
