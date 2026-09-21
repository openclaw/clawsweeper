#!/usr/bin/env node
// Controlled POSIX proof; uses the production 30-second deadline without clock overrides.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = realpathSync(fileURLToPath(import.meta.url));
const secretFixture = "synthetic-fetch-redaction-value";
const promptFixture = "synthetic private prompt";
const modelFixture = "synthetic-model-redaction-value";
const stdoutFixture = "synthetic fetch stdout must remain private";
const diagnostic = "controlled blob fetch stalled before completion";
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const events = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function identity(pid) {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      return { pid, start: raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19] };
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return null;
      throw error;
    }
  }
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  if (result.status === 1 && !result.stdout.trim()) return null;
  assert.equal(result.status, 0);
  return { pid, start: result.stdout.trim() };
}
async function fakeGit(realGit, log, args) {
  const child = identity(process.pid);
  const record = (event, detail = {}) =>
    appendFileSync(log, JSON.stringify({ event, atMs: Date.now(), child, args, ...detail }) + "\n");
  const admittedFetch = args.includes("fetch") && args.includes("--stdin");
  record("git_start", { admittedFetch });
  if (!admittedFetch) {
    const result = spawnSync(realGit, args, { stdio: "inherit" });
    record("git_exit", {
      status: result.status,
      signal: result.signal,
      errorCode: result.error?.code ?? null,
    });
    if (result.signal) process.kill(process.pid, result.signal);
    process.exit(result.status ?? 1);
  }
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (part) => {
    input += part;
  });
  process.stdin.on("end", () =>
    record("fetch_input", { objectIds: input.trim().split("\n").filter(Boolean) }),
  );
  process.once("SIGTERM", () => {
    record("fetch_signal", { signal: "SIGTERM" });
    process.removeAllListeners("SIGTERM");
    process.kill(process.pid, "SIGTERM");
  });
  process.stderr.write(
    `${diagnostic}\nTOKEN=${secretFixture}\n${promptFixture}\n${modelFixture}\nhttps://example.invalid/private\n/fixture/private/path\n`,
  );
  process.stdout.write(stdoutFixture + "\n");
  record("fetch_waiting");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
function resolveGit() {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      const path = resolve(directory, "git");
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {}
  }
  throw new Error("A trusted real Git binary must be available on PATH.");
}
async function main() {
  assert.ok(["linux", "darwin"].includes(process.platform), "Linux or macOS is required.");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node >=24 is required.");
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    assert.ok(["--source-root", "--expect", "--output"].includes(process.argv[i]));
    assert.ok(process.argv[i + 1] && !Object.hasOwn(options, process.argv[i]));
    options[process.argv[i]] = process.argv[i + 1];
  }
  assert.equal(Object.keys(options).length, 3);
  assert.ok(["baseline", "candidate"].includes(options["--expect"]));
  const sourceRoot = realpathSync(resolve(options["--source-root"]));
  const output = resolve(options["--output"]),
    realGit = resolveGit(),
    log = join(output, "commands.jsonl");
  mkdirSync(output, { mode: 0o700 });
  for (const directory of ["bin", "home", "tmp"])
    mkdirSync(join(output, directory), { mode: 0o700 });
  const bin = join(output, "bin");
  symlinkSync(process.execPath, join(bin, "node"));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(self)} --fake-git ${shellQuote(realGit)} ${shellQuote(log)} "$@"\n`,
    { mode: 0o700 },
  );
  process.env = {
    PATH: bin,
    HOME: join(output, "home"),
    XDG_CONFIG_HOME: join(output, "home"),
    TMPDIR: join(output, "tmp"),
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "maintenance.auto",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "gc.auto",
    GIT_CONFIG_VALUE_2: "0",
  };
  const git = (cwd, ...args) =>
    execFileSync(realGit, args, {
      cwd,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
  const sourceFiles = [
    "agent-input-scan",
    "clawsweeper-review-blobs",
    "clawsweeper-review-failure-diagnostics",
    "clawsweeper-review-runtime",
    "review-source-preparation",
    "pr-review-evidence",
  ];
  const manifest = () => ({
    head: git(sourceRoot, "rev-parse", "HEAD"),
    committedTree: git(sourceRoot, "rev-parse", "HEAD^{tree}"),
    status: git(sourceRoot, "status", "--porcelain=v1", "--untracked-files=no"),
    files: [
      ...sourceFiles.flatMap((name) => [`src/${name}.ts`, `dist/${name}.js`]),
      "package.json",
      "pnpm-lock.yaml",
    ].map((path) => ({ path, sha256: hash(join(sourceRoot, path)) })),
  });
  const result = {
    schema: "native-fetch-deadline-proof/v1",
    accepted: false,
    expectation: options["--expect"],
    scriptSha256: hash(self),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    limits: [
      "Controlled synthetic file-only Git; no network, GitHub, scanner or review invocation.",
      "The real production30s deadline is unchanged; no Date or child_process replacement.",
      "Baseline demonstrates missing diagnostics; neither case is a review verdict or restored prerequisite.",
      "POSIX root-child closure is observed; no arbitrary descendant or production timing claim.",
    ],
  };
  console.log(`PROOF_OUTPUT=${output}`);
  try {
    const beforeSource = manifest();
    json(join(output, "source-before.json"), beforeSource);
    result.source = {
      head: beforeSource.head,
      committedTree: beforeSource.committedTree,
      manifestSha256: hash(join(output, "source-before.json")),
    };
    result.runtime.git = git(output, "--version");
    const origin = join(output, "origin.git"),
      source = join(output, "fixture-source"),
      target = join(output, "fixture-target");
    mkdirSync(source);
    git(output, "init", "--bare", "-q", origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(source, "init", "-q", "-b", "main");
    git(source, "config", "user.name", "Fetch Proof");
    git(source, "config", "user.email", "fetch-proof@example.invalid");
    git(source, "config", "commit.gpgsign", "false");
    writeFileSync(join(source, "changed.txt"), "synthetic before\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "synthetic base");
    const baseSha = git(source, "rev-parse", "HEAD");
    git(source, "remote", "add", "origin", pathToFileURL(origin).href);
    git(source, "push", "-q", "origin", "main");
    git(source, "checkout", "-qb", "feature");
    writeFileSync(join(source, "changed.txt"), "synthetic after\n");
    writeFileSync(join(source, "added.txt"), "synthetic addition\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "synthetic head");
    const headSha = git(source, "rev-parse", "HEAD");
    git(source, "push", "-q", "origin", "feature");
    git(
      output,
      "clone",
      "-q",
      "--no-checkout",
      "--filter=blob:none",
      "--single-branch",
      "--branch",
      "main",
      pathToFileURL(origin).href,
      target,
    );
    git(target, "fetch", "-q", "--filter=blob:none", "origin", "feature:refs/heads/feature");
    assert.equal(git(target, "config", "remote.origin.promisor"), "true");
    const missing = () =>
      git(
        target,
        "rev-list",
        "--objects",
        "--missing=print",
        `${baseSha}^{tree}`,
        `${headSha}^{tree}`,
      )
        .split("\n")
        .filter((line) => line.startsWith("?"))
        .sort();
    const beforeMissing = missing();
    assert.equal(beforeMissing.length, 3);
    result.fixture = {
      baseSha,
      headSha,
      baseTree: git(source, "rev-parse", `${baseSha}^{tree}`),
      headTree: git(source, "rev-parse", `${headSha}^{tree}`),
      beforeMissing,
      objects: beforeMissing.map((value) => ({
        oid: value.slice(1),
        bytes: Number(git(source, "cat-file", "-s", value.slice(1))),
      })),
    };
    const { hydratePullRequestReviewBlobs, ReviewGitError } = await import(
      pathToFileURL(join(sourceRoot, "dist/clawsweeper-review-blobs.js"))
    );
    const { AgentInputScanError, agentInputScanFailureExitCode } = await import(
      pathToFileURL(join(sourceRoot, "dist/agent-input-scan.js"))
    );
    const { writeExactReviewFailureDiagnostics } = await import(
      pathToFileURL(join(sourceRoot, "dist/clawsweeper-review-failure-diagnostics.js"))
    );
    const { createReviewRuntime } = await import(
      pathToFileURL(join(sourceRoot, "dist/clawsweeper-review-runtime.js"))
    );
    const unavailable = () => {
      throw new Error("Unexpected dependency in native fetch classification proof.");
    };
    const runtime = createReviewRuntime({
      reviewItemPromptPath: "",
      decisionSchemaPath: "",
      prCloseCoverageProofPromptPath: "",
      targetRepo: unavailable,
      run: unavailable,
      ghJson: unavailable,
      evidenceEntry: unavailable,
      untrustedCodexEnv: unavailable,
      asRecord: unavailable,
      defaultRootCauseCluster: unavailable,
      parseDecision: unavailable,
      ensureDir: unavailable,
      stringOrUndefined: unavailable,
    });
    let caught;
    const startedAt = Date.now(),
      startedNs = process.hrtime.bigint();
    try {
      hydratePullRequestReviewBlobs({
        targetDir: target,
        baseSha,
        headSha,
        resolveBlobSizes: (ids) =>
          new Map(ids.map((oid) => [oid, Number(git(source, "cat-file", "-s", oid))])),
      });
    } catch (error) {
      caught = error;
    }
    result.wallElapsedMs = Date.now() - startedAt;
    result.monotonicElapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    const baseline = options["--expect"] === "baseline";
    const retryable = runtime.codexReviewFailureRetryable(caught);
    if (baseline) {
      assert.ok(caught instanceof AgentInputScanError);
      assert.equal(caught.reason, "deadline");
    } else {
      assert.ok(caught instanceof ReviewGitError);
      assert.equal(caught.diagnosticReason, "review_blobs_unavailable");
    }
    assert.equal(retryable, !baseline);
    result.refusal = {
      name: caught.name,
      reason: baseline ? caught.reason : caught.diagnosticReason,
      retryable,
      workflowExit: agentInputScanFailureExitCode(caught) ?? 1,
    };
    assert.equal(result.refusal.workflowExit, 1);
    assert.ok(result.wallElapsedMs >= 30_000);
    result.commands = events(log);
    const fetches = result.commands.filter(
      (entry) => entry.event === "git_start" && entry.admittedFetch,
    );
    assert.equal(fetches.length, 1);
    const child = fetches[0].child;
    assert.deepEqual(fetches[0].args, [
      "-c",
      "fetch.negotiationAlgorithm=noop",
      "fetch",
      "origin",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "--stdin",
    ]);
    const inputs = result.commands.filter((entry) => entry.event === "fetch_input");
    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0].child, child);
    assert.deepEqual(
      inputs[0].objectIds.slice().sort(),
      beforeMissing.map((value) => value.slice(1)),
    );
    assert.equal(
      result.commands.filter(
        (entry) =>
          entry.event === "fetch_signal" &&
          entry.signal === "SIGTERM" &&
          entry.child.pid === child.pid &&
          entry.child.start === child.start,
      ).length,
      1,
    );
    result.childClosure = { child, observedAfterJoin: identity(child.pid) };
    assert.ok(
      !result.childClosure.observedAfterJoin ||
        result.childClosure.observedAfterJoin.start !== child.start,
    );
    result.afterMissing = missing();
    assert.deepEqual(result.afterMissing, beforeMissing);
    const writerDir = writeExactReviewFailureDiagnostics({
      artifactDir: join(output, "writer"),
      error: caught,
      prompt: promptFixture,
      model: modelFixture,
      classification: "codex_execution",
      repo: "fixture/repository",
      itemKind: "pull_request",
      itemNumber: 1,
      sourceSha: headSha,
      retryable,
      workflowExit: result.refusal.workflowExit,
      env: { FIXTURE_TOKEN: secretFixture },
    });
    result.diagnostics = JSON.parse(readFileSync(join(writerDir, "manifest.json"), "utf8"));
    const stderr = readFileSync(join(writerDir, "stderr.tail.txt"), "utf8"),
      stdout = readFileSync(join(writerDir, "stdout.error.txt"), "utf8");
    const filenames = ["manifest.json", "error.txt", "stderr.tail.txt", "stdout.error.txt"];
    const combined = filenames
      .map((name) => readFileSync(join(writerDir, name), "utf8"))
      .join("\n");
    for (const value of [
      secretFixture,
      promptFixture,
      modelFixture,
      stdoutFixture,
      "https://example.invalid/private",
      "/fixture/private/path",
    ])
      assert.equal(combined.includes(value), false);
    assert.equal(stdout, "[no diagnostic detail]\n");
    const expectedFailure = baseline
      ? { stage: "agent_input_scan", reason_code: "deadline" }
      : { stage: "source_preparation", reason_code: "review_blobs_unavailable" };
    assert.equal(result.diagnostics.classification, expectedFailure.stage);
    assert.equal(result.diagnostics.retryable, retryable);
    assert.deepEqual(result.diagnostics.failure, expectedFailure);
    if (baseline) {
      assert.equal(caught.cause, undefined);
      assert.equal(stderr, "[no diagnostic detail]\n");
      assert.deepEqual(result.diagnostics.process, {
        status: null,
        signal: null,
        error_code: null,
        workflow_exit: 1,
      });
    } else {
      assert.equal(caught.status, null);
      assert.equal(caught.signal, "SIGTERM");
      assert.equal(caught.errorCode, "ETIMEDOUT");
      assert.ok(stderr.includes(diagnostic));
      assert.ok(stderr.includes("[REDACTED]"));
      assert.deepEqual(result.diagnostics.process, {
        status: null,
        signal: "SIGTERM",
        error_code: "ETIMEDOUT",
        workflow_exit: 1,
      });
    }
    result.writerFiles = filenames.map((name) => ({
      name,
      sha256: hash(join(writerDir, name)),
      bytes: readFileSync(join(writerDir, name)).length,
    }));
    assert.ok(result.writerFiles.reduce((sum, file) => sum + file.bytes, 0) <= 24 * 1024);
    const afterSource = manifest();
    json(join(output, "source-after.json"), afterSource);
    assert.deepEqual(afterSource, beforeSource);
    result.accepted = true;
  } catch (error) {
    result.failure = { name: error.name, message: error.message };
    process.exitCode = 1;
  } finally {
    result.commands = events(log);
    result.finishedAt = new Date().toISOString();
    json(join(output, "result.json"), result);
    console.log(
      JSON.stringify({
        accepted: result.accepted,
        expectation: result.expectation,
        elapsedMs: result.monotonicElapsedMs,
        refusal: result.refusal,
        process: result.diagnostics?.process,
        childClosure: result.childClosure,
        source: result.source,
        result: join(output, "result.json"),
        sha256: hash(join(output, "result.json")),
      }),
    );
  }
}
if (process.argv[2] === "--fake-git")
  await fakeGit(process.argv[3], process.argv[4], process.argv.slice(5));
else await main();
