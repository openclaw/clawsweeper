// Opt-in native Astra prompt comparison; checked-in receipts are historical. Never run as a unit test or in CI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const out = resolve(process.argv[2] ?? ".artifacts/astra-review/live");
const model = "gpt-6-astra";
const candidateOnly = process.argv[3] === "--candidate-only";
assert.ok(process.argv[3] === undefined || candidateOnly, "Only --candidate-only is supported.");
const caseNumber = process.argv[4] === undefined ? null : Number(process.argv[4]);
assert.ok(
  caseNumber === null ||
    (candidateOnly && Number.isInteger(caseNumber) && caseNumber >= 1 && caseNumber <= 3),
  "An optional case number 1-3 requires --candidate-only.",
);
const reviewEnv = { ...process.env };
delete reviewEnv.CLAWSWEEPER_INTERNAL_MODEL; // Scoped experiment selection, never persisted.
assert.ok(
  !existsSync(out),
  "Choose a fresh output directory to avoid review-history contamination.",
);
mkdirSync(out, { recursive: true });
const baseRevision = "fe750d1779208b067c1f694dba70f494cb29c401";
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const trailer = "Co-authored-by: hannesrudolph <49103247+hannesrudolph@users.noreply.github.com>";
const fixtureEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Review fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Review fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-10-07T20:00:00Z",
  GIT_COMMITTER_DATE: "2026-10-07T20:00:00Z",
};
function snapshot(dir, subject, parent) {
  git(dir, "add", ".");
  const tree = git(dir, "write-tree");
  const head = execFileSync(
    "git",
    ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", subject + "\n\n" + trailer],
    { cwd: dir, env: fixtureEnv, encoding: "utf8" },
  ).trim();
  git(dir, "update-ref", "refs/heads/main", head);
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  return head;
}
function fixture(name, forwardSignal, capturedExecution = false) {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  writeFileSync(
    join(dir, "AGENTS.md"),
    "This is a self-contained request service. Inspect source read-only; do not edit, install dependencies, or start other reviewers. No external project contract applies.\n",
  );
  writeFileSync(
    join(dir, "README.md"),
    "# Request service\n\nsubmit(input, options) returns a promise for a transport response. Calls queue by default; queued: false runs immediately. Queued work is drained explicitly in FIFO order. A failed job rejects its own promise without preventing subsequent jobs. Transport is supplied by the caller.\n",
  );
  writeFileSync(
    join(dir, "queue.mjs"),
    "export class Queue {\n  jobs = [];\n  push(task) {\n    return new Promise((resolve, reject) => this.jobs.push({ task, resolve, reject }));\n  }\n  async drain(execute) {\n    while (this.jobs.length) {\n      const { task, resolve, reject } = this.jobs.shift();\n      try { resolve(await execute(task)); } catch (error) { reject(error); }\n    }\n  }\n}\n",
  );
  writeFileSync(
    join(dir, "worker.mjs"),
    "export function execute(task, transport) {\n  return transport(task.input);\n}\n",
  );
  writeFileSync(
    join(dir, "service.mjs"),
    "import { Queue } from './queue.mjs';\nimport { execute } from './worker.mjs';\nexport function createService(transport) {\n  const queue = new Queue();\n  return {\n    submit(input, { queued = true } = {}) {\n      const task = { input };\n      return queued ? queue.push(task) : execute(task, transport);\n    },\n    drain() { return queue.drain(task => execute({ input: task.input }, transport)); },\n  };\n}\n",
  );
  if (capturedExecution) {
    const queuePath = join(dir, "queue.mjs");
    writeFileSync(
      queuePath,
      readFileSync(queuePath, "utf8")
        .replace("push(task)", "push(task, run)")
        .replace("{ task, resolve, reject }", "{ task, run, resolve, reject }")
        .replace("const { task, resolve, reject }", "const { task, run, resolve, reject }")
        .replace("await execute(task)", "await (run ? run() : execute(task))"),
    );
  }
  const base = snapshot(dir, "Initial request service");
  git(dir, "update-ref", "refs/heads/baseline", base);
  writeFileSync(
    join(dir, "README.md"),
    readFileSync(join(dir, "README.md"), "utf8") +
      "\nsubmit accepts an optional AbortSignal for both queued and immediate calls. Aborting before execution rejects without invoking transport. Once started, the same signal reaches transport, which owns in-flight abort handling. Cancellation does not block later queued work.\n",
  );
  writeFileSync(
    join(dir, "worker.mjs"),
    "export function execute(task, transport) {\n  if (task.signal?.aborted) return Promise.reject(task.signal.reason);\n  return transport(task.input, { signal: task.signal });\n}\n",
  );
  writeFileSync(
    join(dir, "service.mjs"),
    "import { Queue } from './queue.mjs';\nimport { execute } from './worker.mjs';\nexport function createService(transport) {\n  const queue = new Queue();\n  return {\n    submit(input, { queued = true, signal } = {}) {\n      const task = { input, signal };\n      return queued ? queue.push(task) : execute(task, transport);\n    },\n    drain() { return queue.drain(task => execute(" +
      (forwardSignal ? "task" : "{ input: task.input }") +
      ", transport)); },\n  };\n}\n",
  );
  if (capturedExecution) {
    const servicePath = join(dir, "service.mjs");
    writeFileSync(
      servicePath,
      readFileSync(servicePath, "utf8").replace(
        "queue.push(task)",
        "queue.push(task, () => execute(task, transport))",
      ),
    );
  }
  const head = snapshot(dir, "feat: support request cancellation", base);
  assert.equal(git(dir, "status", "--porcelain"), "");
  return { dir, base, head, diffSha256: sha256(git(dir, "diff", base, head)) };
}

// Expected observations remain outside each model checkout; clone afresh for every run.
const cases = [fixture("case-a", false), fixture("case-b", true), fixture("case-c", false, true)];
const baselineRoot = join(out, "baseline-runner");
mkdirSync(baselineRoot, { recursive: true });
const archive = execFileSync(
  "git",
  [
    "archive",
    baseRevision,
    "src",
    "scripts",
    "prompts",
    "schema",
    "config",
    "package.json",
    "tsconfig.json",
  ],
  { cwd: root, maxBuffer: 64 * 1024 * 1024 },
);
const archivePath = join(out, "baseline.tar");
writeFileSync(archivePath, archive);
execFileSync("tar", ["-xf", archivePath, "-C", baselineRoot]);
cpSync(join(root, "node_modules"), join(baselineRoot, "node_modules"), { recursive: true });
execFileSync("pnpm", ["run", "build"], { cwd: baselineRoot, stdio: "pipe", timeout: 120000 });
execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "pipe", timeout: 120000 });
const baselinePrompt = readFileSync(join(baselineRoot, "prompts/review-item.md"), "utf8");
const issueCore = readFileSync(join(root, "prompts/review-item.md"), "utf8").replace(
  "{{review_procedure}}",
  () => readFileSync(join(root, "prompts/review-issue.md"), "utf8").trimEnd(),
);
assert.equal(issueCore, baselinePrompt);
const candidateRuntime = await import(pathToFileURL(join(root, "dist/clawsweeper.js")).href);
const baselineRuntime = await import(
  pathToFileURL(join(baselineRoot, "dist/clawsweeper.js")).href
);
assert.equal(
  candidateRuntime.reviewDecisionSchemaText(),
  baselineRuntime.reviewDecisionSchemaText(),
);
const issuePromptHashes = Object.fromEntries(
  ["openclaw/openclaw", "openclaw/clawsweeper", "openclaw/clawhub"].map((repo) => {
    const issueItem = {
      repo,
      number: 1,
      kind: "issue",
      title: "Issue composition fixture",
      url: "local:fixture",
      author: "Review fixture",
      authorAssociation: "CONTRIBUTOR",
      labels: [],
      createdAt: "2026-10-07T20:00:00Z",
      updatedAt: "2026-10-07T20:00:00Z",
    };
    const context = { issue: { body: "Issue composition fixture." }, comments: [], timeline: [] };
    const revision = { mainSha: "a".repeat(40), latestRelease: null };
    const candidate = candidateRuntime.reviewPromptForTest(issueItem, context, revision);
    const baseline = baselineRuntime.reviewPromptForTest(issueItem, context, revision);
    assert.equal(candidate, baseline, repo);
    return [repo, sha256(candidate)];
  }),
);
const baselineAssets = [
  "review-item.md",
  "review-item-issue.md",
  "review-item-pr.md",
  "review-close-reasons.md",
];
const assets = [...baselineAssets, "review-pr.md", "review-issue.md"];
const receipt = {
  baseRevision,
  candidateHead: git(root, "rev-parse", "HEAD"),
  candidateDiffSha256: sha256(git(root, "diff", "HEAD")),
  productionSourceSha256: Object.fromEntries(
    [
      "src/clawsweeper-review-runtime.ts",
      "src/clawsweeper-runtime.ts",
      "src/agent-runner.ts",
      "src/agent-input-scan.ts",
      "src/openclaw-process.ts",
    ].map((path) => [path, sha256(readFileSync(join(root, path)))]),
  ),
  model,
  modelSelection:
    "Explicit native Astra; private environment override removed only for these child processes, no persisted configuration change.",
  node: process.version,
  platform: process.platform,
  codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  environment: {
    architecture: process.arch,
    execution: "Native local-range processes; no GitHub publication",
    outerValidationEnvironment: "Provider, image, and lease must be recorded by the owner",
  },
  promptAssets: Object.fromEntries(
    assets.map((name) => [name, sha256(readFileSync(join(root, "prompts", name)))]),
  ),
  baselinePromptAssets: Object.fromEntries(
    baselineAssets.map((name) => [
      name,
      sha256(readFileSync(join(baselineRoot, "prompts", name))),
    ]),
  ),
  issuePromptUnchanged: true,
  issuePromptHashes,
  cases,
  runs: [],
};
const variants = candidateOnly
  ? [["candidate", root]]
  : [
      ["candidate", root],
      ["baseline", baselineRoot],
    ];
for (const [variant, runnerRoot] of variants) {
  for (let i = 0; i < cases.length; i++) {
    if (caseNumber !== null && i + 1 !== caseNumber) continue;
    const source = cases[i];
    const targetDir = join(out, variant + "-target-" + (i + 1));
    git(root, "clone", "--quiet", "--no-local", source.dir, targetDir);
    const artifactDir = join(out, variant + "-" + (i + 1));
    const args = [
      join(runnerRoot, "dist/clawsweeper.js"),
      "review",
      "--local-range",
      "--target-repo",
      "openclaw/review-fixture",
      "--target-dir",
      targetDir,
      "--base",
      source.base,
      "--codex-model",
      model,
      "--codex-timeout-ms",
      "180000",
      "--output-retention",
      "debug",
      "--artifact-dir",
      artifactDir,
    ];
    const startedAt = new Date().toISOString();
    const result = spawnSync(process.execPath, args, {
      cwd: runnerRoot,
      env: reviewEnv,
      encoding: "utf8",
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(
      join(out, variant + "-" + (i + 1) + ".log"),
      (result.stdout ?? "") + (result.stderr ?? ""),
    );
    const resultPath = join(artifactDir, "codex/0.json");
    const decision = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
    const promptPath = join(artifactDir, "codex/0.prompt.md");
    const stderrPath = join(artifactDir, "codex/0.1.codex.stderr.log");
    const runtimeLog = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "";
    const actualModel = runtimeLog.match(/^model: (.+)$/m)?.[1];
    const promptText = existsSync(promptPath) ? readFileSync(promptPath, "utf8") : "";
    const staticEnd = promptText.indexOf("\n## Repository State\n");
    const contextStart = promptText.indexOf("## GitHub Context");
    const load =
      staticEnd < 0
        ? null
        : {
            staticPromptBytes: Buffer.byteLength(promptText.slice(0, staticEnd)),
            schemaBytes: Buffer.byteLength(
              readFileSync(join(runnerRoot, "schema/clawsweeper-decision.schema.json")),
            ),
            runtimeEnvelopeAndContextBytes: Buffer.byteLength(promptText.slice(staticEnd)),
            gitHubContextSectionBytes: Buffer.byteLength(promptText.slice(contextStart)),
            requiredSchemaFields: JSON.parse(
              readFileSync(join(runnerRoot, "schema/clawsweeper-decision.schema.json"), "utf8"),
            ).required.length,
          };
    receipt.runs.push({
      variant,
      case: i + 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      command: [process.execPath, ...args],
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
      effectiveModel: actualModel === model ? model : "unexpected-or-unavailable-redacted",
      reasoningEffort: runtimeLog.match(/^reasoning effort: (.+)$/m)?.[1],
      sandbox: runtimeLog.match(/^sandbox: (.+)$/m)?.[1],
      artifactDir,
      targetDir,
      targetClean: git(targetDir, "status", "--porcelain") === "",
      load,
      promptSha256: promptText ? sha256(promptText) : null,
      resultSha256: decision ? sha256(readFileSync(resultPath)) : null,
      result: decision && {
        summary: decision.summary,
        systemContext: decision.systemContext,
        reviewFindings: decision.reviewFindings,
        overallCorrectness: decision.overallCorrectness,
        solutionAssessment: decision.solutionAssessment,
        evidence: decision.evidence,
        realBehaviorProof: decision.realBehaviorProof,
      },
    });
    writeFileSync(
      join(out, "receipt.json"),
      JSON.stringify(receipt, null, 2) + String.fromCharCode(10),
    );
    console.log(variant + " case " + (i + 1) + ": exit " + result.status);
    assert.equal(
      result.status,
      0,
      "Inspect the retained process log; no model fallback is allowed.",
    );
    assert.equal(
      actualModel === model,
      true,
      "Effective model was not the required public Astra model; no fallback permitted.",
    );
    assert.ok(
      decision && Array.isArray(decision.reviewFindings),
      "A completed decision is required, not only exit zero.",
    );
    assert.ok(receipt.runs.at(-1).targetClean);
    assert.ok(staticEnd > 0 && contextStart > staticEnd);
    assert.ok(!promptText.slice(contextStart).includes('"previousClawSweeperReview"'));
  }
}
