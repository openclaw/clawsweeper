#!/usr/bin/env node
// Usage: node scripts/e2e/queue-review-upgrade.mjs /tmp/latest-stable.tar /tmp/upgrade-proof
// Requires current dist/, Node >=24, git, tar, and pnpm 10.33.2 with the stable
// lockfile's packages cached in STABLE_PNPM_STORE_DIR. Installation is offline.
// STABLE_PNPM_BIN may name a pnpm 10.33.2 executable/wrapper.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const archive = process.argv[2] && resolve(process.argv[2]);
const output = resolve(process.argv[3] || "/tmp/queue-review-upgrade-proof");
assert.ok(archive, "usage: queue-review-upgrade.mjs STABLE_GIT_ARCHIVE OUTPUT_DIRECTORY");
assert.ok(!existsSync(output), "output directory must be new (never overwrite prior evidence)");
mkdirSync(output, { recursive: true });
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clawsweeper-stable-upgrade-")));
const stable = join(scratch, "stable");
const storage = join(output, "storage");
const items = join(storage, "items");
const bin = join(scratch, "bin");
for (const dir of [stable, items, bin, join(storage, "closed"), join(storage, "plans")]) {
  mkdirSync(dir, { recursive: true });
}
const stableTag = "v0.3.0";
const stableCommit = "a3469c99f6a8362d57771f750262f6f9c798d649";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Only tool discovery and package-cache configuration survive from the caller.
// No GitHub, cloud, model, queue, credential helper, or proxy environment survives.
const env = {
  PATH: `${bin}:${process.env.PATH}`,
  HOME: join(scratch, "home"),
  TMPDIR: scratch,
  CI: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  COREPACK_ENABLE_NETWORK: "0",
  PNPM_HOME: process.env.PNPM_HOME || "",
};
mkdirSync(env.HOME);
const result = {
  stable_tag: stableTag,
  stable_commit: stableCommit,
  archive_sha256: digest(readFileSync(archive)),
  status: "setup",
  limits: [
    "Local GitHub CLI transport and deterministic model response; no production GitHub, Worker, queue, or model operations.",
    "v0.3.0 writes legacy Markdown and generic durable review markers, not v1 causal review-version/review-state markers. This proof cannot claim stable v1 causal-marker generation.",
    "Current apply is read-only and must conservatively refuse the pre-review_record report. Successful migration or mutation is not claimed.",
    "The retained storage manifest excludes build/setup and diagnostic output. No historical schema migration or source patch is applied.",
  ],
};
function redact(text) {
  return text
    .replaceAll(scratch, "<scratch>")
    .replaceAll(output, "<proof-output>")
    .replaceAll(root, "<checkout>");
}
function run(label, command, args, options = {}) {
  const child = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  writeFileSync(join(output, `${label}.stdout.log`), redact(child.stdout || ""));
  writeFileSync(join(output, `${label}.stderr.log`), redact(child.stderr || ""));
  assert.equal(child.status, 0, `${label}: ${child.error?.message || child.stderr}`);
  return child.stdout.trim();
}
function manifest(dir, prefix = "") {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const name = prefix + entry.name;
        const path = join(dir, entry.name);
        return entry.isDirectory()
          ? Object.entries(manifest(path, `${name}/`))
          : [[name, digest(readFileSync(path))]];
      }),
  );
}
try {
  result.current_head = run("current-head", "git", ["rev-parse", "HEAD"]);
  result.current_changes = run("current-changes", "git", ["diff", "--name-only"]);
  const entries = run("archive-list", "tar", ["-tf", archive]).split("\n");
  assert.ok(
    entries.every((entry) => !entry.startsWith("/") && !entry.split("/").includes("..")),
    "unsafe archive path",
  );
  run("extract", "tar", ["-xf", archive, "-C", stable]);
  // git archive records the source commit in its pax header; refuse a mislabeled archive.
  const archiveIdentity = spawnSync("git", ["get-tar-commit-id"], {
    input: readFileSync(archive),
    encoding: "utf8",
  });
  assert.equal(archiveIdentity.status, 0, archiveIdentity.stderr);
  assert.equal(
    archiveIdentity.stdout.trim(),
    stableCommit,
    "archive is not the pinned latest stable commit",
  );
  const pkg = JSON.parse(readFileSync(join(stable, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.3.0");
  const stableSource = readFileSync(join(stable, "src/clawsweeper.ts"), "utf8");
  assert.ok(!stableSource.includes("clawsweeper-review-version"));
  assert.ok(!stableSource.includes("clawsweeper-review-state"));
  assert.ok(!stableSource.includes("review_record:"));
  const pnpm = process.env.STABLE_PNPM_BIN || "pnpm";
  assert.ok(
    process.env.STABLE_PNPM_STORE_DIR,
    "set STABLE_PNPM_STORE_DIR to the prehydrated pnpm store",
  );
  run(
    "stable-install",
    pnpm,
    [
      "install",
      "--offline",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--store-dir",
      resolve(process.env.STABLE_PNPM_STORE_DIR),
    ],
    { cwd: stable },
  );
  run("stable-build", pnpm, ["run", "build"], { cwd: stable });
  const stableApi = await import(pathToFileURL(join(stable, "dist/clawsweeper.js")).href);
  const { promotionGhMock } = await import("../../test/helpers.ts");
  const number = 74;
  const title = "Controlled stored-data upgrade fixture";
  const timestamp = "2026-05-01T00:00:00Z";
  const requestLog = join(output, "github-requests.jsonl");
  const writeLog = join(output, "stable-comment-writes.jsonl");
  const ghScript = join(bin, "gh.cjs");
  // Real git fetches stay inside a disposable local repository.
  const origin = join(scratch, "origin");
  const target = join(scratch, "target");
  run("target-init", "git", ["init", "--initial-branch=main", origin]);
  writeFileSync(join(origin, "fixture.txt"), "local target\n");
  run("target-add", "git", ["-C", origin, "add", "fixture.txt"]);
  run("target-commit", "git", [
    "-C",
    origin,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-m",
    "Local target",
  ]);
  run("target-clone", "git", ["-c", "protocol.file.allow=always", "clone", origin, target]);
  const targetHead = run("target-head", "git", ["-C", target, "rev-parse", "HEAD"]);
  const transport = promotionGhMock({
    number,
    title,
    body: "Controlled local transport; no product behavior claim.",
    labels: [],
    itemUpdatedAt: timestamp,
    headSha: targetHead,
    comment: "",
    comments: [],
    timeline: [],
    commandLogPath: requestLog,
    commentWriteLogPath: writeLog,
    sourceFiles: ["fixture.txt"],
  });
  // Capture the existing fixture transport's argv, but reject all writes once
  // stable has finished. Non-api release reads are controlled here as well.
  writeFileSync(
    ghScript,
    `const raw = process.argv.slice(2);\nconst args0 = raw[0] === '--repo' ? raw.slice(2) : raw;\nif (args0[0] === 'release') { console.log('null'); process.exit(0); }\nif (process.env.UPGRADE_READ_ONLY === '1' && (raw.includes('--input') || raw.some(x => ['POST','PATCH','PUT','DELETE'].includes(x)) || ['pr','issue','workflow'].includes(args0[0]))) { throw new Error('forbidden current-reader mutation: '+JSON.stringify(raw)); }\n${transport}`,
  );
  env.GH_BIN = process.execPath;
  env.GH_BIN_ARGS = JSON.stringify([ghScript]);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(ghScript)} "$@"\n`,
    { mode: 0o755 },
  );
  for (const name of ["curl", "wget"]) {
    writeFileSync(
      join(bin, name),
      "#!/bin/sh\necho 'network transport forbidden in upgrade proof' >&2\nexit 97\n",
      { mode: 0o755 },
    );
  }
  const decision = stableApi.codexFailureDecisionForTest(1, "controlled response template");
  Object.assign(decision, {
    summary: "Controlled keep-open decision for stored-data compatibility.",
    changeSummary: "A fixture only; no live repository review was performed.",
    evidence: [],
    risks: [],
    bestSolution: "Retain the controlled item open.",
    codexTerminalFailure: false,
  });
  const schema = JSON.parse(stableApi.reviewDecisionSchemaText());
  const modelDecision = Object.fromEntries(
    Object.entries(decision).filter(([key]) => key in schema.properties),
  );
  stableApi.parseDecision(modelDecision);
  writeFileSync(join(output, "model-response.json"), JSON.stringify(modelDecision, null, 2));
  const codex = join(bin, "codex.cjs");
  writeFileSync(
    codex,
    `const fs=require('node:fs'); const args=process.argv.slice(2); fs.readFileSync(0); const index=args.indexOf('--output-last-message'); if(index<0) throw new Error('missing model output argument'); fs.writeFileSync(args[index+1],fs.readFileSync(${JSON.stringify(join(output, "model-response.json"))}));`,
  );
  env.CODEX_BIN = process.execPath;
  env.CODEX_BIN_ARGS = JSON.stringify([codex]);
  // Stable codex-spawn uses CODEX_BIN directly, so provide a real executable.
  const codexExecutable = join(bin, "codex");
  writeFileSync(
    codexExecutable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(codex)} "$@"\n`,
    { mode: 0o755 },
  );
  env.CODEX_BIN = codexExecutable;
  delete env.CODEX_BIN_ARGS;
  const generated = join(scratch, "generated");
  run(
    "stable-review",
    process.execPath,
    [
      join(stable, "dist/clawsweeper.js"),
      "review",
      "--target-repo",
      "openclaw/openclaw",
      "--target-dir",
      target,
      "--artifact-dir",
      generated,
      "--items-dir",
      items,
      "--item-number",
      String(number),
      "--batch-size",
      "1",
    ],
    { cwd: stable },
  );
  const reportName = readdirSync(generated).find((name) => name.endsWith(".md"));
  assert.ok(reportName, "stable review must write a report");
  run(
    "stable-retain",
    process.execPath,
    [
      join(stable, "dist/clawsweeper.js"),
      "apply-artifacts",
      "--target-repo",
      "openclaw/openclaw",
      "--artifact-dir",
      generated,
      "--items-dir",
      items,
      "--closed-dir",
      join(storage, "closed"),
      "--plans-dir",
      join(storage, "plans"),
      "--skip-reconcile",
    ],
    { cwd: stable },
  );
  const storedReport = join(items, reportName);
  assert.ok(existsSync(storedReport));
  assert.ok(!readFileSync(storedReport, "utf8").includes("review_record:"));
  run(
    "stable-publish",
    process.execPath,
    [
      join(stable, "dist/clawsweeper.js"),
      "apply-decisions",
      "--target-repo",
      "openclaw/openclaw",
      "--items-dir",
      items,
      "--closed-dir",
      join(storage, "closed"),
      "--plans-dir",
      join(storage, "plans"),
      "--report-path",
      join(output, "stable-apply.json"),
      "--sync-comments-only",
      "--item-number",
      String(number),
      "--skip-dashboard",
    ],
    { cwd: stable },
  );
  const commentState = join(scratch, "comment-state-74.json");
  const comment = JSON.parse(readFileSync(commentState, "utf8"));
  assert.match(comment.body, /<!-- clawsweeper-review item=74 -->/);
  assert.ok(!comment.body.includes("clawsweeper-review-version"));
  copyFileSync(commentState, join(storage, "durable-comment.json"));
  writeFileSync(join(storage, "durable-body.txt"), comment.body);
  result.original = manifest(storage);
  writeFileSync(join(output, "original-sha256.json"), JSON.stringify(result.original, null, 2));
  env.UPGRADE_READ_ONLY = "1";
  const reader = join(scratch, "current-reader.mjs");
  writeFileSync(
    reader,
    `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { issueReviewCommentState, durableReviewCausalIdentityFromBody } from ${JSON.stringify(pathToFileURL(join(root, "dist/clawsweeper-review-comment-state.js")).href)};
import { withGitHubRun } from ${JSON.stringify(pathToFileURL(join(root, "dist/clawsweeper-github-runtime.js")).href)};
const retained = JSON.parse(readFileSync(${JSON.stringify(join(storage, "durable-comment.json"))}, 'utf8'));
const selected = withGitHubRun(() => issueReviewCommentState(74).reviewComment);
assert.deepEqual(selected, retained);
assert.equal(durableReviewCausalIdentityFromBody(selected.body, 74), null);
console.log(JSON.stringify({selected_comment_id:selected.id, body_sha256:createHash('sha256').update(selected.body).digest('hex'), causal_identity:null, interpretation:'generic legacy durable review is readable, but grants no causal publication authority'}));
`,
  );
  result.durable_reader = JSON.parse(run("current-durable-reader", process.execPath, [reader]));
  assert.equal(result.durable_reader.body_sha256, result.original["durable-body.txt"]);
  const currentOutcome = join(output, "current-apply.json");
  run("current-apply", process.execPath, [
    join(root, "dist/clawsweeper.js"),
    "apply-decisions",
    "--target-repo",
    "openclaw/openclaw",
    "--items-dir",
    items,
    "--closed-dir",
    join(storage, "closed"),
    "--plans-dir",
    join(storage, "plans"),
    "--report-path",
    currentOutcome,
    "--item-number",
    String(number),
    "--dry-run",
    "--sync-comments-only",
    "--skip-dashboard",
  ]);
  result.apply_results = JSON.parse(readFileSync(currentOutcome, "utf8"));
  assert.equal(result.apply_results.length, 1);
  assert.match(
    result.apply_results[0].reason,
    /review_record: missing record; fresh review required/,
  );
  // Retained fixture transport storage must also be byte-identical: current must
  // not mutate the durable comment while deciding that the report needs review.
  assert.equal(digest(readFileSync(commentState)), result.original["durable-comment.json"]);
  result.final = manifest(storage);
  assert.deepEqual(result.final, result.original);
  result.storage_changes = [];
  result.marker = "<!-- clawsweeper-review item=74 -->";
  result.compatibility_boundary =
    "v0.3.0 has no typed review_record. Current apply retains these bytes but requires a fresh review before applying; v1 causal markers postdate v0.3.0.";
  result.preexisting_main_boundary = {
    inspected_commit: "69e22d84385785fe06ea721eacd5deeac11143c3",
    source: "src/review-record.ts:125-129 and src/clawsweeper-apply-close-decision.ts",
    reason:
      "requireReviewRecord throws ReviewRecordFormatError('missing record'); apply adds '; fresh review required'. Established by source inspection, not a baseline runtime claim.",
  };
  result.status = "passed-conservative-legacy-retention";
} catch (error) {
  result.status = "failed";
  result.error = redact(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  if (existsSync(storage)) {
    result.final = manifest(storage);
    writeFileSync(join(output, "final-sha256.json"), JSON.stringify(result.final, null, 2));
  }
  writeFileSync(join(output, "result.json"), redact(JSON.stringify(result, null, 2)));
  // Redact diagnostics only, never the retained report or durable-marker bytes.
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(output, entry.name);
      writeFileSync(path, redact(readFileSync(path, "utf8")));
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
console.log(redact(JSON.stringify(result)));
