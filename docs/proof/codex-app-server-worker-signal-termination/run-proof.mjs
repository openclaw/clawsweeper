// Compiled before/after proof for Codex app-server process-tree cleanup on repeated worker
// signals and on a direct child that exits before the SIGKILL escalation fires.
//
// Both arms start the real compiled Codex app-server worker with a fake `codex` binary
// that answers the JSON-RPC handshake, starts a turn that never completes, spawns a
// SIGTERM-ignoring grandchild, and never exits on its own, then send SIGTERM to the worker
// itself, the signal a job cancellation or an outer deadline delivers, and record whether
// the child and grandchild are still alive three seconds later. Three scenarios run per
// arm: the direct child ignores a single SIGTERM (the control: both arms stop the tree
// through the one-second SIGKILL escalation), the direct child exits on SIGTERM while its
// grandchild ignores it, and repeated SIGTERM while both ignore it. The baseline arm
// compiles src/codex-app-server-worker.ts from the base commit (default: merge base with
// origin/main, or HEAD~1 once the change is on main) in an isolated copy of src/; the
// candidate arm uses the current dist/.
//
// POSIX only: the worker's process-group handling has no Windows equivalent here.
//
// Usage: node docs/proof/codex-app-server-worker-signal-termination/run-proof.mjs
//        [--base <rev>] [--out <dir>] [--baseline-dist <dir>]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.error("This proof uses POSIX signals and process groups; run it on Linux or macOS.");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const WORKER = "src/codex-app-server-worker.ts";

const git = (...gitArgs) =>
  execFileSync("git", gitArgs, { cwd: repoRoot, encoding: "utf8" }).trim();

// On a multi-commit branch the pre-change code is the merge base with origin/main, not
// HEAD~1; once the change is on main, HEAD~1 is the previous main commit.
function defaultBaseRev() {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return "HEAD~1";
  } catch {
    try {
      return git("merge-base", "HEAD", "origin/main");
    } catch (error) {
      console.warn(
        `origin/main is unavailable (${error.message.trim()}); using HEAD~1 as the baseline`,
      );
      return "HEAD~1";
    }
  }
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const baseRev = option("--base", defaultBaseRev());
const outDir = resolve(
  repoRoot,
  option("--out", ".artifacts/codex-app-server-worker-signal-termination"),
);
const providedBaselineDist = option("--baseline-dist", "");
mkdirSync(outDir, { recursive: true });

function compileBaselineDist() {
  const baseSha = git("rev-parse", baseRev);
  const baselineSource = git("show", `${baseSha}:${WORKER}`);
  writeFileSync(join(outDir, "baseline-worker.ts"), baselineSource);
  // Compile an isolated copy of src/ so the tracked checkout is never modified, even if
  // the driver is interrupted while the baseline build runs.
  const baselineRoot = join(outDir, "baseline-build");
  const baselineSrc = join(baselineRoot, "src");
  rmSync(baselineRoot, { recursive: true, force: true });
  cpSync(join(repoRoot, "src"), baselineSrc, { recursive: true });
  writeFileSync(join(baselineRoot, WORKER), baselineSource);
  // The copy must resolve modules and the ESM package type the way the checkout does,
  // even when the output directory lives outside the repository.
  writeFileSync(join(baselineRoot, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  symlinkSync(join(repoRoot, "node_modules"), join(baselineRoot, "node_modules"), "junction");
  const baselineDist = join(baselineRoot, "dist");
  const posix = (value) => value.replace(/\\/g, "/");
  writeFileSync(
    join(baselineRoot, "tsconfig.json"),
    JSON.stringify(
      {
        extends: posix(join(repoRoot, "tsconfig.json")),
        compilerOptions: {
          rootDir: posix(baselineSrc),
          outDir: posix(baselineDist),
          typeRoots: [posix(join(repoRoot, "node_modules", "@types"))],
        },
        include: [posix(join(baselineSrc, "**", "*.ts"))],
        exclude: [posix(join(baselineSrc, "repair", "**"))],
      },
      null,
      2,
    ),
  );
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(baselineRoot, "tsconfig.json"),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  return { baselineDist, baseSha };
}

// The fake app-server answers initialize, thread/start, and turn/start over stdio, then
// keeps the turn open forever. The grandchild announces that its SIGTERM handler is
// installed before the child publishes the PIDs, so the driver never signals a grandchild
// that is still booting.
const fakeCodexAppServer = (childIgnoresSigterm) => `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const readyPath = process.env.CODEX_PROOF_PID_PATH + ".ready";
const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.CODEX_PROOF_READY_PATH, '1'); setInterval(() => {}, 1000)"],
  { stdio: "ignore", env: { ...process.env, CODEX_PROOF_READY_PATH: readyPath } },
);
${childIgnoresSigterm ? 'process.on("SIGTERM", () => {});' : ""}
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1", sessionId: "session-1" } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    const announce = () => {
      if (!fs.existsSync(readyPath)) return setTimeout(announce, 10);
      fs.writeFileSync(
        process.env.CODEX_PROOF_PID_PATH + ".tmp",
        JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
      );
      fs.renameSync(process.env.CODEX_PROOF_PID_PATH + ".tmp", process.env.CODEX_PROOF_PID_PATH);
    };
    announce();
  }
});
setInterval(() => {}, 1000);
`;

const scenarios = [
  {
    name: "control: direct child ignores a single SIGTERM (grandchild ignores too)",
    script: fakeCodexAppServer(true),
  },
  {
    name: "direct child exits on SIGTERM, grandchild ignores it",
    script: fakeCodexAppServer(false),
  },
  {
    name: "direct child ignores repeated SIGTERM (grandchild ignores too)",
    script: fakeCodexAppServer(true),
    repeated: true,
  },
];

function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code !== "ESRCH";
  }
  // A killed orphan stays a zombie until PID 1 reaps it, and kill(pid, 0) still succeeds
  // for zombies; treat an exited-but-unreaped process as gone.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = (state.stdout ?? "").trim();
  return stat.length > 0 && !stat.startsWith("Z");
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function runScenario(arm, scenario) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-app-server-signal-proof-"));
  const pidPath = join(root, "codex.pid");
  const binary = join(root, "fake-codex");
  writeFileSync(binary, scenario.script);
  chmodSync(binary, 0o755);
  const optionsPath = join(root, "worker-options.json");
  const resultPath = join(root, "result.json");
  writeFileSync(
    optionsPath,
    JSON.stringify({
      args: ["exec", "--cd", root, "--sandbox", "read-only", "--json", "-"],
      command: binary,
      timeoutMs: 60_000,
      resultPath,
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      tailBytes: 4096,
      maxOutputFileBytes: 65_536,
      appServer: { statePath: join(root, "thread.json") },
    }),
  );
  const worker = spawn(
    process.execPath,
    [join(arm.dist, "codex-app-server-worker.js"), optionsPath],
    {
      cwd: root,
      env: { ...process.env, CODEX_PROOF_PID_PATH: pidPath },
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  worker.stdin.end("Review the fixture.");
  const workerExit = new Promise((resolveExit) =>
    worker.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
  let pids;
  try {
    const startDeadline = Date.now() + 10_000;
    while (!existsSync(pidPath)) {
      if (Date.now() > startDeadline) throw new Error("fake Codex app-server never started a turn");
      await sleep(50);
    }
    pids = JSON.parse(readFileSync(pidPath, "utf8"));
    const signalledAt = Date.now();
    worker.kill("SIGTERM");
    if (scenario.repeated) {
      await sleep(50);
      worker.kill("SIGTERM");
    }
    const exit = await workerExit;
    const workerExitMs = Date.now() - signalledAt;
    const reapDeadline = signalledAt + 3_000;
    while (Date.now() < reapDeadline && [pids.child, pids.grandchild].some(processAlive)) {
      await sleep(50);
    }
    const treeGoneMs = Date.now() - signalledAt;
    const childAlive = processAlive(pids.child);
    const grandchildAlive = processAlive(pids.grandchild);
    const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;
    return {
      scenario: scenario.name,
      workerExit: exit,
      workerExitMs,
      childAliveAfterWait: childAlive,
      grandchildAliveAfterWait: grandchildAlive,
      treeGoneMs: childAlive || grandchildAlive ? null : treeGoneMs,
      resultSignal: result ? (result.signal ?? null) : "no result file",
    };
  } finally {
    for (const pid of [pids?.child, pids?.grandchild]) {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const head = git("rev-parse", "HEAD");
const candidateDist = join(repoRoot, "dist");
if (!existsSync(join(candidateDist, "codex-app-server-worker.js"))) {
  throw new Error("dist/codex-app-server-worker.js is missing; run pnpm run build first");
}
const baseline = providedBaselineDist
  ? { baselineDist: resolve(repoRoot, providedBaselineDist), baseSha: "provided" }
  : compileBaselineDist();

const results = [];
for (const arm of [
  {
    name: `baseline (${WORKER} from ${baseline.baseSha.slice(0, 10)})`,
    dist: baseline.baselineDist,
  },
  { name: `candidate (${head.slice(0, 10)})`, dist: candidateDist },
]) {
  const scenarioResults = [];
  for (const scenario of scenarios) scenarioResults.push(await runScenario(arm, scenario));
  results.push({ arm: arm.name, scenarios: scenarioResults });
}
const [baselineResult, candidateResult] = results;
const stops = (entry, expectedSignal) =>
  entry.workerExit.code === 0 &&
  entry.childAliveAfterWait === false &&
  entry.grandchildAliveAfterWait === false &&
  entry.resultSignal === expectedSignal;
// Before the change finish() cancels the pending escalation once the direct child closes
// and never signals the rest of the process group, so the grandchild outlives the worker.
const baselineLeaksGrandchild = (entry) =>
  entry.workerExit.code === 0 &&
  entry.childAliveAfterWait === false &&
  entry.grandchildAliveAfterWait === true &&
  entry.resultSignal === "SIGTERM";
// Before the change the one-shot handler is consumed by the first signal, so the second
// one kills the worker through the default action before the escalation fires.
const baselineDiesOnRepeat = (entry) =>
  entry.workerExit.signal === "SIGTERM" &&
  entry.childAliveAfterWait === true &&
  entry.grandchildAliveAfterWait === true &&
  entry.resultSignal === "no result file";
const pass =
  stops(baselineResult.scenarios[0], "SIGKILL") &&
  baselineLeaksGrandchild(baselineResult.scenarios[1]) &&
  baselineDiesOnRepeat(baselineResult.scenarios[2]) &&
  stops(candidateResult.scenarios[0], "SIGKILL") &&
  stops(candidateResult.scenarios[1], "SIGTERM") &&
  stops(candidateResult.scenarios[2], "SIGKILL");
const summary = {
  head,
  base: baseline.baseSha,
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  results,
  pass,
};
writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`PROOF_RESULT=${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
