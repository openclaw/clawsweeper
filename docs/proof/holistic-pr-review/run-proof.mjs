// Historical, opt-in live-model proof. Never run as a unit test or in CI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = process.cwd();
const out = resolve(process.argv[2] ?? ".artifacts/holistic-pr-review/live");
const model = process.argv[3] ?? "gpt-6.1-sol";
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
function fixture(name, forwardSignal) {
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
  const head = snapshot(dir, "feat: support request cancellation", base);
  assert.equal(git(dir, "status", "--porcelain"), "");
  return { dir, base, head, diffSha256: sha256(git(dir, "diff", base, head)) };
}

// The evaluator and expected observations stay outside each reviewer checkout.
const cases = [fixture("case-a", false), fixture("case-b", true)];
const legacyRoot = join(out, "legacy-runner");
mkdirSync(legacyRoot, { recursive: true });
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
execFileSync("tar", ["-xf", archivePath, "-C", legacyRoot]);
cpSync(join(root, "node_modules"), join(legacyRoot, "node_modules"), { recursive: true });
execFileSync("pnpm", ["run", "build"], { cwd: legacyRoot, stdio: "pipe", timeout: 120000 });
const legacyPrompt = readFileSync(join(legacyRoot, "prompts/review-item.md"), "utf8");
const issueCore = readFileSync(join(root, "prompts/review-item.md"), "utf8").replace(
  "{{review_procedure}}",
  readFileSync(join(root, "prompts/review-issue.md"), "utf8").trim(),
);
const receipt = {
  baseRevision,
  candidateHead: git(root, "rev-parse", "HEAD"),
  candidateDiffSha256: sha256(git(root, "diff", "HEAD")),
  model,
  node: process.version,
  platform: process.platform,
  codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
  environment:
    "Linux native local-range runner; no container lease or image; no GitHub publication",
  promptAssets: Object.fromEntries(
    ["review-pr.md", "review-issue.md", "review-item.md"].map((name) => [
      name,
      sha256(readFileSync(join(root, "prompts", name))),
    ]),
  ),
  legacyPromptSha256: sha256(legacyPrompt),
  issuePromptUnchanged: issueCore === legacyPrompt,
  cases,
  runs: [],
};
assert.ok(receipt.issuePromptUnchanged);
for (const [variant, runnerRoot] of [
  ["candidate", root],
  ["legacy", legacyRoot],
]) {
  for (let i = 0; i < cases.length; i++) {
    // Fresh Git clone per run excludes local review history from earlier runs.
    const sourceCase = cases[i];
    const targetDir = join(out, variant + "-target-" + (i + 1));
    git(root, "clone", "--quiet", "--no-local", sourceCase.dir, targetDir);
    const fixtureCase = { ...sourceCase, dir: targetDir };
    const artifactDir = join(out, variant + "-" + (i + 1));
    const args = [
      join(runnerRoot, "dist/clawsweeper.js"),
      "review",
      "--local-range",
      "--target-repo",
      "openclaw/review-fixture",
      "--target-dir",
      fixtureCase.dir,
      "--base",
      fixtureCase.base,
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
    receipt.runs.push({
      variant,
      case: i + 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      command: [process.execPath, ...args],
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
      artifactDir,
      targetDir,
      targetClean: git(fixtureCase.dir, "status", "--porcelain") === "",
      promptSha256: existsSync(promptPath) ? sha256(readFileSync(promptPath)) : null,
      resultSha256: decision ? sha256(readFileSync(resultPath)) : null,
      result: decision && {
        summary: decision.summary,
        reviewFindings: decision.reviewFindings,
        overallCorrectness: decision.overallCorrectness,
        solutionAssessment: decision.solutionAssessment,
        evidence: decision.evidence,
        realBehaviorProof: decision.realBehaviorProof,
      },
    });
    writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(variant + " case " + (i + 1) + ": exit " + result.status);
    assert.equal(result.status, 0, "Inspect " + variant + "-" + (i + 1) + ".log");
    assert.ok(
      decision && Array.isArray(decision.reviewFindings),
      "A completed model decision is required, not only exit zero.",
    );
    assert.ok(receipt.runs.at(-1).targetClean);
  }
}
