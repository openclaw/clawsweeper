#!/usr/bin/env node
// Controlled Linux process proof. Build each selected source before invoking it.
// node run-proof.mjs --source-root /checkout --expected-head SHA --expect baseline|candidate --output /new/path
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = realpathSync(fileURLToPath(import.meta.url));
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const lines = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, state: fields[0], parentPid: Number(fields[1]), startTicks: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

async function fakeGh(payloadPath, args) {
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  const previous = lines(payload.events).filter((entry) => entry.event === "child_start");
  const ordinal = previous.length + 1;
  const identity = processIdentity(process.pid);
  const record = (event, data = {}) =>
    appendFileSync(
      payload.events,
      `${JSON.stringify({ event, ordinal, atMs: Date.now(), identity, ...data })}\n`,
    );
  record("child_start", { args });
  process.on("exit", (code) => record("child_exit", { code }));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      record("child_signal", { signal });
      process.exit(signal === "SIGTERM" ? 143 : 130);
    });
  }
  const revision = args[1]?.match(
    /^repos\/fixture\/repository\/git\/trees\/([0-9a-f]{40})\?recursive=1$/,
  )?.[1];
  assert.equal(args[0], "api");
  assert.equal(args.length, 4);
  assert.equal(args[2], "--jq");
  assert.ok(revision && Object.hasOwn(payload.responses, revision), "unexpected fake gh request");
  if (ordinal === 1) {
    record("delay_start", { delayMs: 31_000 });
    await new Promise((done) => setTimeout(done, 31_000));
    record("delay_complete");
  }
  record("metadata_response", { revision });
  process.stdout.write(JSON.stringify(payload.responses[revision]));
}

function findGit() {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, "git");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {}
  }
  throw new Error("A trusted Git executable must be available on PATH.");
}

function sourceManifest(root, git) {
  const files = [];
  const visit = (relative) => {
    const path = join(root, relative);
    assert.equal(lstatSync(path).isSymbolicLink(), false, `unexpected source link: ${relative}`);
    if (lstatSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(`${relative}/${entry}`);
    } else {
      files.push({ path: relative, sha256: sha256(path) });
    }
  };
  for (const path of ["src", "dist", "package.json", "pnpm-lock.yaml", "tsconfig.json"])
    visit(path);
  return {
    head: git(root, "rev-parse", "HEAD"),
    committedTree: git(root, "rev-parse", "HEAD^{tree}"),
    worktreeStatus: git(root, "status", "--porcelain=v1", "--untracked-files=no"),
    files,
  };
}

async function main() {
  assert.equal(process.platform, "linux", "This proof requires Linux /proc process identities.");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node >=24 is required.");
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    assert.ok(["--source-root", "--expected-head", "--expect", "--output"].includes(key));
    assert.equal(Object.hasOwn(options, key), false, `duplicate option ${key}`);
    assert.ok(process.argv[index + 1], `missing value for ${key}`);
    options[key] = process.argv[index + 1];
  }
  assert.equal(Object.keys(options).length, 4, "All four documented options are required.");
  assert.ok(["baseline", "candidate"].includes(options["--expect"]));
  assert.match(options["--expected-head"], /^[0-9a-f]{40}$/);
  const root = realpathSync(resolve(options["--source-root"]));
  const output = resolve(options["--output"]);
  const gitBinary = findGit();
  mkdirSync(output, { mode: 0o700 }); // Refuse an existing path; never overwrite prior evidence.
  const bin = join(output, "bin");
  const home = join(output, "home");
  const temp = join(output, "tmp");
  for (const path of [bin, home, temp]) mkdirSync(path, { mode: 0o700 });
  const payloadPath = join(output, "transport.json");
  const childEvents = join(output, "child-events.jsonl");
  const requestEvents = join(output, "request-events.jsonl");
  const gitTrace = join(output, "git-trace.jsonl");
  symlinkSync(gitBinary, join(bin, "git"));
  symlinkSync(process.execPath, join(bin, "node"));
  const fakeGhPath = join(bin, "gh");
  writeFileSync(
    fakeGhPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(self)} --fake-gh ${shellQuote(payloadPath)} "$@"\n`,
    { mode: 0o700 },
  );
  // Nothing from the calling environment reaches Git, gh, or imported runtime modules.
  process.env = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: temp,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([self, "--fake-gh", payloadPath]),
    GH_CONFIG_DIR: join(home, "gh"),
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "maintenance.auto",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "gc.auto",
    GIT_CONFIG_VALUE_2: "0",
    GIT_TRACE2_EVENT: gitTrace,
  };
  const git = (cwd, ...args) =>
    execFileSync(gitBinary, args, {
      cwd,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    }).trim();
  const report = {
    schema: "hydration-deadline-proof/v1",
    expectation: options["--expect"],
    accepted: false,
    startedAt: new Date().toISOString(),
    output,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    proofScriptSha256: sha256(self),
    ownerBudgetMs: 30_000,
    firstResponseDelayMs: 31_000,
    limitations: [
      "Synthetic local Git state and fake gh transport; no real GitHub, scanner, model, or review invocation.",
      "Both expectations intentionally refuse source admission; success is not a review verdict or restored prerequisite.",
      "This slow-response scenario does not exercise retry, throttle, fallback, or broker branches.",
      "No historical timeout attribution, Team operation, private data, or kernel-enforced egress claim.",
      "Committed tree, worktree status, and byte manifests are separate; the caller must verify build provenance.",
    ],
  };
  console.log(`PROOF_OUTPUT=${output}`);
  try {
    assert.equal(
      JSON.parse(readFileSync(join(root, "package.json"))).packageManager,
      "pnpm@12.4.1",
    );
    report.gitVersion = git(root, "--version");
    const beforeSource = sourceManifest(root, git);
    json(join(output, "source-before.json"), beforeSource);
    assert.equal(beforeSource.head, options["--expected-head"]);
    report.source = {
      head: beforeSource.head,
      committedTree: beforeSource.committedTree,
      manifestSha256: sha256(join(output, "source-before.json")),
    };
    const origin = join(output, "origin.git");
    const source = join(output, "fixture-source");
    const target = join(output, "fixture-target");
    mkdirSync(source);
    git(output, "init", "--bare", "-q", origin);
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(source, "init", "-q", "-b", "main");
    git(source, "config", "user.name", "Hydration Proof");
    git(source, "config", "user.email", "hydration-proof@example.invalid");
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
    git(source, "push", "-q", "origin", "HEAD:refs/pull/982/head");
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
    git(
      target,
      "fetch",
      "-q",
      "--filter=blob:none",
      "origin",
      "refs/pull/982/head:refs/clawsweeper/review-cache/head-982",
    );
    assert.equal(git(target, "config", "remote.origin.promisor"), "true");
    const responses = Object.fromEntries(
      [baseSha, headSha].map((revision) => [
        revision,
        {
          truncated: false,
          tree: git(source, "ls-tree", "-r", "-l", revision)
            .split("\n")
            .map((line) => {
              const match = /^(\d+) blob ([0-9a-f]{40})\s+(\d+)\t/.exec(line);
              assert.ok(match);
              return { type: "blob", sha: match[2], size: Number(match[3]) };
            }),
        },
      ]),
    );
    json(payloadPath, { events: childEvents, responses });
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
    assert.equal(beforeMissing.length, 3, "fixture must retain all three changed blobs as missing");
    report.fixture = {
      baseSha,
      headSha,
      baseTree: git(source, "rev-parse", `${baseSha}^{tree}`),
      headTree: git(source, "rev-parse", `${headSha}^{tree}`),
      remote: git(target, "remote", "get-url", "origin"),
      beforeMissing,
    };
    const load = (name) => import(pathToFileURL(join(root, "dist", `${name}.js`)).href);
    const [
      { createContextHydration },
      { createGitHubRuntime },
      { createGitHubExecution },
      { runText, SWEEPER_COMMAND_MAX_BUFFER_BYTES, resolveCommand },
    ] = await Promise.all([
      load("clawsweeper-context-hydration"),
      load("clawsweeper-github-runtime"),
      load("clawsweeper-github-execution"),
      load("command"),
    ]);
    const resolvedGh = resolveCommand("gh", ["api"], process.env);
    assert.equal(resolvedGh.command, process.execPath);
    assert.deepEqual(resolvedGh.args.slice(0, 3), [self, "--fake-gh", payloadPath]);
    const startedAtMs = Date.now();
    const startedNs = process.hrtime.bigint();
    const record = (event, data = {}) =>
      appendFileSync(
        requestEvents,
        `${JSON.stringify({ event, atMs: Date.now(), elapsedMs: Date.now() - startedAtMs, ...data })}\n`,
      );
    const runtime = createGitHubRuntime({
      ROOT: target,
      targetRepo: () => "fixture/repository",
      run(command, args, options = {}) {
        assert.equal(command, "gh");
        record("request_start", { args, timeoutMs: options.timeoutMs ?? null });
        try {
          const value = runText(command, args, {
            cwd: options.cwd ?? target,
            env: options.env,
            maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
            timeoutMs: options.timeoutMs,
            trim: "both",
          });
          record("request_complete");
          return value;
        } catch (error) {
          record("request_error", {
            name: error.name,
            code: error.code ?? null,
            pid: error.pid ?? null,
            status: error.status ?? null,
            signal: error.signal ?? null,
          });
          throw error;
        }
      },
    });
    const execution = createGitHubExecution({
      ROOT: target,
      gitHubRuntime: runtime,
      labelAlreadyExistsError: () => false,
    });
    const context = createContextHydration(
      new Proxy(
        {
          ROOT: target,
          asRecord: (value) =>
            value && typeof value === "object" && !Array.isArray(value) ? value : {},
          stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
          isSafeGitBranchName: (branch) => branch === "main",
          targetRepo: () => "fixture/repository",
          ghJson: (args, options) => {
            record("metadata_admission", { args, deadlineAt: options?.deadlineAt ?? null });
            return execution.ghJson(args, options);
          },
          ghJsonOnce: execution.ghJsonOnce,
          GitHubRuntimeBudgetError: runtime.GitHubRuntimeBudgetError,
        },
        {
          get: (object, key) =>
            Reflect.get(object, key) ??
            (() => {
              throw new Error(`Unexpected hydration dependency: ${String(key)}`);
            }),
        },
      ),
    );
    const traceOffset = lines(gitTrace).length;
    try {
      context.hydratePullRequestReviewSource({
        itemNumber: 982,
        targetDir: target,
        pullRequest: { base: { ref: "main", sha: baseSha }, head: { sha: headSha } },
      });
      report.refusal = null;
    } catch (error) {
      report.refusal = {
        name: error.name,
        reason: error.reason ?? null,
        retryable: error.retryable ?? null,
        reviewedHeadSha: error.reviewedHeadSha ?? null,
      };
    }
    report.wallElapsedMs = Date.now() - startedAtMs;
    report.monotonicElapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    const hydrationTrace = lines(gitTrace).slice(traceOffset);
    json(join(output, "hydration-git-trace.json"), hydrationTrace);
    report.fetchStarts = hydrationTrace.filter(
      (event) => event.event === "start" && event.argv?.includes("fetch"),
    );
    report.afterMissing = missing();
    report.requests = lines(requestEvents);
    report.children = lines(childEvents);
    report.childClosure = report.children
      .filter((entry) => entry.event === "child_start")
      .map(({ identity, ordinal }) => ({
        ordinal,
        identity,
        observedAfterJoin: processIdentity(identity.pid),
      }));
    const afterSource = sourceManifest(root, git);
    json(join(output, "source-after.json"), afterSource);
    assert.deepEqual(afterSource, beforeSource, "source changed during proof");
    assert.deepEqual(report.refusal, {
      name: "AgentInputScanError",
      reason: "deadline",
      retryable: false,
      reviewedHeadSha: headSha,
    });
    assert.deepEqual(report.afterMissing, beforeMissing);
    assert.deepEqual(report.fetchStarts, []);
    assert.ok(report.childClosure.length > 0);
    assert.ok(
      report.childClosure.every(
        ({ observedAfterJoin, identity }) =>
          !observedAfterJoin || observedAfterJoin.startTicks !== identity.startTicks,
      ),
      "an exact fake gh child remains after synchronous join",
    );
    const starts = report.requests.filter((entry) => entry.event === "request_start");
    const childStarts = report.children.filter((entry) => entry.event === "child_start");
    const metadataResponses = report.children.filter(
      (entry) => entry.event === "metadata_response",
    );
    if (options["--expect"] === "baseline") {
      assert.deepEqual(
        starts.map((entry) => entry.args[1]),
        [baseSha, headSha].map(
          (revision) => `repos/fixture/repository/git/trees/${revision}?recursive=1`,
        ),
      );
      assert.equal(starts[1].elapsedMs >= 30_000, true);
      assert.equal(childStarts.length, 2);
      assert.equal(metadataResponses.length, 2);
      assert.equal(
        report.children.some((entry) => entry.event === "delay_complete"),
        true,
      );
    } else {
      assert.equal(starts.length, 1);
      assert.ok(starts[0].timeoutMs > 0 && starts[0].timeoutMs <= 30_000);
      assert.equal(childStarts.length, 1);
      assert.equal(metadataResponses.length, 0);
      assert.equal(
        report.children.some((entry) => entry.event === "delay_complete"),
        false,
      );
      assert.equal(
        report.requests.some(
          (entry) => entry.event === "request_error" && entry.code === "ETIMEDOUT",
        ),
        true,
      );
      assert.equal(
        report.children.some(
          (entry) => entry.event === "child_signal" && entry.signal === "SIGTERM",
        ),
        true,
      );
    }
    assert.equal(
      report.children.filter((entry) => entry.event === "child_exit").length,
      childStarts.length,
    );
    report.accepted = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.message };
    process.exitCode = 1;
  } finally {
    // Only known fake-transport identities qualify for cleanup, never unrelated reused PIDs.
    report.cleanup = [];
    for (const { identity, ordinal } of lines(childEvents).filter(
      (entry) => entry.event === "child_start",
    )) {
      const same = () => processIdentity(identity.pid)?.startTicks === identity.startTicks;
      if (same()) {
        report.accepted = false;
        process.exitCode = 1;
        const signal = (name) => {
          if (!same()) return;
          try {
            process.kill(identity.pid, name);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        };
        signal("SIGTERM");
        for (let attempt = 0; attempt < 20 && same(); attempt++) pause(50);
        signal("SIGKILL");
        for (let attempt = 0; attempt < 20 && same(); attempt++) pause(50);
        report.cleanup.push({ ordinal, identity, liveAfterCleanup: same() });
      }
    }
    report.finishedAt = new Date().toISOString();
    report.fixturesPreserved = true;
    json(join(output, "result.json"), report);
    console.log(
      JSON.stringify({
        accepted: report.accepted,
        expectation: report.expectation,
        result: join(output, "result.json"),
        resultSha256: sha256(join(output, "result.json")),
      }),
    );
  }
}

if (process.argv[2] === "--fake-gh") {
  await fakeGh(process.argv[3], process.argv.slice(4));
} else {
  await main();
}
