// Controlled GitHub HTTP fixture; all payloads are inert strings. No live GitHub writes or model calls.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createItemContext } from "../../../dist/clawsweeper-item-context.js";
import { runPreparedReviewItem } from "../../../dist/clawsweeper-review-item.js";
import { createReviewCoreRuntime } from "../../../dist/clawsweeper-review-core.js";
import { markdownFor } from "../../../dist/clawsweeper-report-document.js";
import { renderReviewCommentFromReport } from "../../../dist/clawsweeper-report-comment-presentation.js";
import { createReviewOutputBudget } from "../../../dist/review-output-policy.js";
import { itemSnapshotHash } from "../../../dist/clawsweeper-source-revision.js";
import { setTargetRepo } from "../../../dist/repository-profiles.js";
import { withGitHubRun } from "../../../dist/clawsweeper-github-runtime.js";
import { closeDecision, item, git, mockGhBinEnv } from "../../../test/helpers.ts";
import { hiddenComment } from "../../../test/hidden-payload-fixture.ts";

const self = fileURLToPath(import.meta.url);
const sourceIssue = {
  number: 1054, title: "Feature request: add dark mode support", body: "Please add dark mode to the documentation site.",
  state: "open", locked: false, labels: [], comments: 1,
  created_at: "2026-09-01T12:04:31Z", updated_at: "2026-09-01T12:04:36Z",
  author_association: "NONE", user: { login: "fixture-author", type: "User" },
  html_url: "https://github.com/openclaw/gogcli/issues/1054",
};
const sourceComments = [{ id: 99, body: hiddenComment, user: { login: "fixture-commenter", type: "User" }, created_at: sourceIssue.updated_at, updated_at: sourceIssue.updated_at }];

if (process.argv[2] === "--server") {
  const trace = process.argv[3];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const args = JSON.parse(body);
    const methodIndex = args.findIndex((arg) => arg === "--method" || arg === "-X");
    const method = methodIndex < 0 ? "GET" : args[methodIndex + 1];
    appendFileSync(trace, JSON.stringify({ args, method }) + "\n");
    if (args.includes("view") && args.includes("closedByPullRequestsReferences")) { response.end(JSON.stringify({ closedByPullRequestsReferences: [] })); return; }
    if (method !== "GET" || !args.includes("api")) { response.writeHead(405).end("fixture refuses writes"); return; }
    const path = args.find((arg) => /^(repos\/|search\/|graphql$)/.test(arg))?.split("?")[0] ?? "";
    let value;
    if (path.endsWith("/comments")) value = sourceComments;
    else if (path.endsWith("/timeline")) value = [];
    else if (path === "graphql") value = { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } };
    else if (path.includes("/issues/")) value = sourceIssue;
    else if (path.startsWith("search/")) value = { items: [], total_count: 0 };
    else value = {};
    let output = args.includes("-i") || args.includes("--include") ? "HTTP/2 200 OK\n\n" : "";
    output += JSON.stringify(args.includes("--slurp") ? [value] : value);
    response.end(output);
  });
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
} else if (process.argv[2] === "--transport") {
  const response = await fetch(process.env.HIDDEN_PAYLOAD_FIXTURE_URL, { method: "POST", body: JSON.stringify(process.argv.slice(3)) });
  if (!response.ok) throw new Error(await response.text());
  process.stdout.write(await response.text());
} else {
  const output = resolve(process.argv[2] || ".artifacts/hidden-payload/proof");
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(output, "run-"));
  const trace = join(root, "requests.jsonl");
  const server = spawn(process.execPath, [self, "--server", trace], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [port] = await once(server.stdout, "data");
    const transport = join(root, "transport.cjs");
    writeFileSync(transport, `(async () => { const response = await fetch(process.env.HIDDEN_PAYLOAD_FIXTURE_URL, { method: "POST", body: JSON.stringify(process.argv.slice(2)) }); if (!response.ok) throw new Error(await response.text()); process.stdout.write(await response.text()); })().catch(error => { console.error(error); process.exitCode = 1; });\n`);
    Object.assign(process.env, mockGhBinEnv(transport), { HIDDEN_PAYLOAD_FIXTURE_URL: `http://127.0.0.1:${String(port).trim()}` });
    setTargetRepo("openclaw/gogcli");
    const target = item({ repo: "openclaw/gogcli", number: 1054, title: sourceIssue.title, url: sourceIssue.html_url, createdAt: sourceIssue.created_at, updatedAt: sourceIssue.updated_at });
    const context = withGitHubRun(() => createItemContext({ relatedItemsContext: () => [], referencingMergedPullRequestsForIssue: () => [] }).collectItemContext(target));
    assert.equal(context.securityReview.status, "needs_attention");
    const core = createReviewCoreRuntime({
      reviewItemPromptPaths: { core: "prompts/review-item.md", issue: "prompts/review-item-issue.md", pull_request: "prompts/review-item-pr.md", closeReasons: "prompts/review-close-reasons.md" },
      decisionSchemaPath: "schema/clawsweeper-decision.schema.json", prCloseCoverageProofPromptPath: "prompts/pr-close-coverage-proof.md",
      run: () => { throw new Error("unexpected checkout operation"); }, untrustedCodexEnv: () => ({}), ensureDir: () => {},
      defaultRootCauseCluster: () => ({}), parseDecision: (value) => value,
    });
    const budget = createReviewOutputBudget(root, "debug");
    const modelDecision = closeDecision({ itemCategory: "feature", localCheckoutAccess: "verified" });
    const prepared = runPreparedReviewItem({
      item: target, context, git, model: "Codex", sandboxMode: "read-only", localOnly: true, localRange: false,
      reviewOpenclawDir: process.cwd(), reviewTreesDir: root, additionalPrompt: "", proofScratchDir: root,
      preparedMediaProof: { manifestPath: null, summaryPath: null, artifacts: [] }, resolveProvenancePull: () => null,
      shardIndex: 0, shardCount: 1, timeoutMs: 1000, humanLocalReview: false, outputSelection: { retention: "debug" },
      outputBudget: budget, itemOutputBudget: budget.item, codexWorkDir: root, forcedLoginMethod: "", itemCodexProfile: { reasoningEffort: "high", serviceTier: "" },
      existingPriorReview: null, contextElapsedMs: 0, onPrompt: (text) => writeFileSync(join(root, "prompt.md"), text),
    }, { ...core, itemSnapshotHash, runCodex: () => structuredClone(modelDecision), attachFixedPullRequest: (value) => value, verifyRegressionProvenance: (value) => value });
    assert.equal(prepared.decision.decision, "keep_open");
    assert.equal(prepared.decision.securityReview.status, "needs_attention");
    const reports = [];
    // Exercise both a proposed close carrying the new signal and an old unflagged close proposal.
    for (const scenario of ["flagged-close", "legacy-close"]) {
      const dir = join(root, scenario);
      mkdirSync(join(dir, "items"), { recursive: true });
      const decision = scenario === "flagged-close" ? { ...prepared.decision, decision: "close", closeReason: "implemented_on_main", closeComment: modelDecision.closeComment } : modelDecision;
      const report = markdownFor({ item: target, context, decision, git, action: { actionTaken: "proposed_close", closeComment: decision.closeComment }, reviewMode: "propose", snapshotHash: prepared.snapshotHash, contentDigest: "fixture", reviewPolicy: "fixture", runtime: prepared.runtime });
      writeFileSync(join(dir, "items", "1054.md"), report);
      const comment = renderReviewCommentFromReport(report, "implemented_on_main");
      if (scenario === "flagged-close") assert.match(comment, /Concealed shell payload/);
      writeFileSync(join(dir, "comment.md"), comment);
      const args = ["dist/clawsweeper.js", "apply-decisions", "--target-repo", "openclaw/gogcli", "--items-dir", join(dir, "items"), "--closed-dir", join(dir, "closed"), "--plans-dir", join(dir, "plans"), "--report-path", join(dir, "apply.json"), "--skip-dashboard", "--item-number", "1054", "--dry-run", "--limit", "1", "--processed-limit", "4", "--close-delay-ms", "0"];
      const stdout = execFileSync(process.execPath, args, { encoding: "utf8" });
      writeFileSync(join(dir, "stdout.log"), stdout);
      const applied = JSON.parse(readFileSync(join(dir, "apply.json"), "utf8"));
      assert.ok(!applied.some((entry) => entry.action === "closed" || entry.action === "would_close"));
      assert.match(JSON.stringify(applied), /security|concealed/i);
      reports.push({ scenario, command: ["node", ...args], result: applied });
    }
    const requests = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(requests.every((entry) => entry.method === "GET"));
    const result = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), provider: "local-process", node: process.version, platform: process.platform, modelBoundary: "fixed implemented-on-main output, deliberately unaware of payload", preparedDecision: prepared.decision.decision, security: prepared.decision.securityReview.status, reports, requests: requests.length, mutations: 0, artifact: root, limits: "Synthetic loopback GitHub fixture and fixed model response; no live collector, GitHub mutation, or model invocation." };
    writeFileSync(join(output, "summary.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally { server.kill(); await once(server, "exit"); }
}
