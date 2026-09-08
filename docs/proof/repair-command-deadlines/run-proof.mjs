import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { intent, receiptSecret } from "./intent.mjs";
import { mergeClusterIntakeLedger } from "../../../dist/repair/cluster-intake-state.js";

const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-deadline-proof-"));
const gh = process.argv[2] || "/opt/homebrew/bin/gh";
const sockets = new Set();
let connections = 0;
// Accept CONNECT but never answer it. gh must wait on a real network transport.
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once("data", () => connections++);
  socket.on("close", () => sockets.delete(socket));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const proxy = `http://127.0.0.1:${server.address().port}`;
const env = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  SystemRoot: process.env.SystemRoot,
  GH_BIN: gh,
  GH_CONFIG_DIR: path.join(dir, "gh"),
  GH_TOKEN: "synthetic-proof-token",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GIT_TERMINAL_PROMPT: "0",
  HTTP_PROXY: proxy,
  HTTPS_PROXY: proxy,
  ALL_PROXY: proxy,
  NO_PROXY: "",
  CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: "30000",
  CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
};
const traces = [];
async function run(args, overrides = {}) {
  const start = performance.now();
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...env, ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 45_000);
  try {
    const [code, signal] = await once(child, "close");
    return { code, signal, elapsedMs: Math.round(performance.now() - start), stdout, stderr };
  } finally {
    clearTimeout(watchdog);
  }
}
const value = intent();
const ledgerDir = path.join(dir, "results/cluster-repair-intake");
fs.mkdirSync(ledgerDir, { recursive: true });
const ledgerFile = path.join(ledgerDir, "openclaw-openclaw.json");
fs.writeFileSync(ledgerFile, JSON.stringify(mergeClusterIntakeLedger(undefined, [value])));
for (const job of value.jobs) {
  fs.mkdirSync(path.dirname(path.join(dir, job.path)), { recursive: true });
  fs.writeFileSync(path.join(dir, job.path), job.content);
}
const dispatchUrl = pathToFileURL(path.join(root, "dist/repair/cluster-intake-dispatch.js")).href;
const fixtureUrl = pathToFileURL(fileURLToPath(new URL("./intent.mjs", import.meta.url))).href;
const dispatchScript = `import { dispatchClusterIntakes } from ${JSON.stringify(dispatchUrl)};
import { intent } from ${JSON.stringify(fixtureUrl)};
dispatchClusterIntakes([intent()], ${JSON.stringify(dir)}, process.env, () => ({active:0,max_live_workers:1}));`;
let workerRun;
try {
  const before = connections;
  const dispatch = await run(["--input-type=module", "-e", dispatchScript]);
  assert.equal(dispatch.code, 1);
  assert.match(dispatch.stderr, /ETIMEDOUT/);
  assert.ok(dispatch.elapsedMs >= 29_000 && dispatch.elapsedMs < 40_000);
  assert.ok(connections > before);
  const ledger = () => JSON.parse(fs.readFileSync(ledgerFile));
  assert.equal(ledger().clusters["42"].status, "dispatch_claimed");
  const { dispatchClusterIntakes } = await import(dispatchUrl);
  const connectionCount = connections;
  dispatchClusterIntakes(
    [value],
    dir,
    env,
    () => ({ active: 0, max_live_workers: 1 }),
    () => ({ action: "wait", run: null }),
  );
  assert.equal(connections, connectionCount);
  dispatchClusterIntakes(
    [value],
    dir,
    env,
    () => ({ active: 0, max_live_workers: 1 }),
    () => ({ action: "recover", run: { databaseId: 123 } }),
  );
  assert.equal(ledger().clusters["42"].status, "dispatched");
  traces.push({
    scenario: "native-gh-dispatch-stall",
    elapsedMs: dispatch.elapsedMs,
    error: "ETIMEDOUT",
    claim: "preserved",
    duplicateDispatch: false,
    recovery: "dispatched",
  });

  const jobName = `deadline-proof-${path.basename(dir)}`;
  const jobFile = path.join(dir, `${jobName}.md`);
  fs.writeFileSync(
    jobFile,
    `---\nrepo: openclaw/clawsweeper\ncluster_id: ${jobName}\nmode: plan\nallowed_actions: [fix]\nsource: clawsweeper_commit\ncommit_sha: ${"1".repeat(40)}\nsecurity_policy: central_security_only\nsecurity_sensitive: false\n---\nSynthetic clone deadline proof.\n`,
  );
  workerRun = jobName;
  const cloneBefore = connections;
  const clone = await run(["dist/repair/run-worker.js", jobFile, "--mode", "plan"]);
  assert.equal(clone.code, 1);
  assert.match(clone.stderr, /gh repo clone openclaw\/clawsweeper failed:.*ETIMEDOUT/);
  assert.ok(clone.elapsedMs >= 29_000 && clone.elapsedMs < 40_000);
  assert.ok(connections > cloneBefore);
  const runs = fs.globSync(path.join(root, `.clawsweeper-repair/runs/${jobName}-plan-*`));
  assert.equal(runs.length, 1);
  assert.equal(fs.existsSync(path.join(runs[0], "cluster-plan.json")), false);
  traces.push({
    scenario: "native-gh-worker-clone-stall",
    elapsedMs: clone.elapsedMs,
    error: "ETIMEDOUT",
    plannerStarted: false,
  });

  // A real local Git repository exercises successful cloning without a remote write.
  const source = path.join(dir, "source");
  fs.mkdirSync(source);
  const git = (args) => execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: "pipe" });
  git(["init", "-b", "main"]);
  fs.writeFileSync(path.join(source, "marker.txt"), "synthetic checkout\n");
  git(["add", "marker.txt"]);
  git([
    "-c",
    "user.name=Proof",
    "-c",
    "user.email=proof@example.invalid",
    "commit",
    "-m",
    "test: synthetic source",
  ]);
  const cloneAdapter = path.join(dir, "clone-adapter.mjs");
  fs.writeFileSync(
    cloneAdapter,
    `import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const args=process.argv.slice(2); assert.deepEqual(args.slice(0,3), ['repo','clone','openclaw/clawsweeper']);
execFileSync('git',['clone','--depth=1',${JSON.stringify(pathToFileURL(source).href)},args[3]],{stdio:'inherit'});`,
  );
  const checkoutUrl = pathToFileURL(path.join(root, "dist/repair/target-checkout.js")).href;
  const result = await run(
    [
      "--input-type=module",
      "-e",
      `import fs from 'node:fs'; import path from 'node:path'; import {prepareTargetCheckout} from ${JSON.stringify(checkoutUrl)};
const target=await prepareTargetCheckout({frontmatter:{repo:'openclaw/clawsweeper'}}); console.log(fs.readFileSync(path.join(target,'marker.txt'),'utf8').trim());fs.rmSync(path.dirname(target),{recursive:true,force:true});`,
    ],
    {
      GH_BIN: process.execPath,
      GH_BIN_ARGS: JSON.stringify([cloneAdapter]),
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /synthetic checkout/);
  traces.push({
    scenario: "real-local-git-clone-via-gh-adapter",
    elapsedMs: result.elapsedMs,
    trackedFile: "synthetic checkout",
  });
  const stalledAdapter = path.join(dir, "stalled-git.cjs");
  const processTrace = path.join(dir, "git-processes.json");
  fs.writeFileSync(
    stalledAdapter,
    `const {spawn}=require('node:child_process');
const args=process.argv.slice(2);
const git=spawn('git',['clone','--depth=1','https://github.com/openclaw/clawsweeper.git',args[3]],{stdio:'inherit'});
require('node:fs').writeFileSync(process.env.PROCESS_TRACE,JSON.stringify({parent:process.pid,git:git.pid}));
git.on('exit',code=>process.exit(code ?? 1));`,
  );
  const gitBefore = connections;
  const stalledGit = await run(
    [
      "--input-type=module",
      "-e",
      `import {prepareTargetCheckout} from ${JSON.stringify(checkoutUrl)};
await prepareTargetCheckout({frontmatter:{repo:'openclaw/clawsweeper'}});`,
    ],
    {
      GH_BIN: process.execPath,
      GH_BIN_ARGS: JSON.stringify([stalledAdapter]),
      PROCESS_TRACE: processTrace,
    },
  );
  assert.equal(stalledGit.code, 1);
  assert.match(stalledGit.stderr, /ETIMEDOUT/);
  assert.ok(stalledGit.elapsedMs >= 29_000 && stalledGit.elapsedMs < 40_000);
  assert.ok(connections > gitBefore);
  const processes = JSON.parse(fs.readFileSync(processTrace));
  if (process.platform !== "win32") {
    const liveGroup = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([pgid, state]) => Number(pgid) === processes.parent && !state.startsWith("Z"));
    assert.deepEqual(liveGroup, []);
  }
  traces.push({
    scenario: "real-git-transport-stall-via-gh-adapter",
    elapsedMs: stalledGit.elapsedMs,
    error: "ETIMEDOUT",
    liveDescendants: 0,
  });
  console.log(
    JSON.stringify(
      { ghVersion: execFileSync(gh, ["--version"], { encoding: "utf8" }).split("\n")[0], traces },
      null,
      2,
    ),
  );
} finally {
  for (const socket of sockets) socket.destroy();
  server.close();
  if (workerRun)
    for (const runDir of fs.globSync(
      path.join(root, `.clawsweeper-repair/runs/${workerRun}-plan-*`),
    ))
      fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
