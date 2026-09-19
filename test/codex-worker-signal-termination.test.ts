import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CODEX_PROCESS_WORKER_PATH = fileURLToPath(
  new URL("../dist/codex-process-worker.js", import.meta.url),
);
const tmpPrefix = join(tmpdir(), "clawsweeper-codex-signal-test-");

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  // A killed orphan stays a zombie until PID 1 reaps it, and kill(pid, 0) still succeeds
  // for zombies; treat an exited-but-unreaped process as gone.
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
  });
  const stat = (state.stdout ?? "").trim();
  return stat.length > 0 && !stat.startsWith("Z");
}

// The fake codex spawns a SIGTERM-ignoring grandchild and publishes both PIDs only after
// the grandchild has installed its handler, so the test never signals a booting process.
function fakeCodex(childIgnoresSigterm: boolean): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const readyPath = process.env.CODEX_TEST_PID_PATH + ".ready";
const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.CODEX_TEST_READY_PATH, '1'); setInterval(() => {}, 1000)"],
  { stdio: "ignore", env: { ...process.env, CODEX_TEST_READY_PATH: readyPath } },
);
${childIgnoresSigterm ? 'process.on("SIGTERM", () => {});' : ""}
const announce = () => {
  if (!fs.existsSync(readyPath)) return setTimeout(announce, 10);
  fs.writeFileSync(
    process.env.CODEX_TEST_PID_PATH + ".tmp",
    JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
  );
  fs.renameSync(process.env.CODEX_TEST_PID_PATH + ".tmp", process.env.CODEX_TEST_PID_PATH);
};
announce();
setInterval(() => {}, 1000);
`;
}

interface Pids {
  child: number;
  grandchild: number;
}

interface WorkerRun {
  root: string;
  resultPath: string;
  worker: ReturnType<typeof spawn>;
  workerExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  pids: Pids;
}

async function startWorker(script: string): Promise<WorkerRun> {
  const root = mkdtempSync(tmpPrefix);
  const pidPath = join(root, "codex.pid");
  const binary = join(root, "fake-codex");
  writeFileSync(binary, script, { mode: 0o755 });
  const optionsPath = join(root, "worker-options.json");
  const resultPath = join(root, "result.json");
  writeFileSync(
    optionsPath,
    JSON.stringify({
      args: [],
      command: binary,
      timeoutMs: 60_000,
      resultPath,
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
      tailBytes: 4096,
      maxOutputFileBytes: 65_536,
    }),
  );
  const worker = spawn(process.execPath, [CODEX_PROCESS_WORKER_PATH, optionsPath], {
    cwd: root,
    env: { ...process.env, CODEX_TEST_PID_PATH: pidPath },
    stdio: "ignore",
  });
  const workerExit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => worker.once("exit", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidPath)) {
    if (Date.now() > deadline) throw new Error("fake Codex child never started");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const pids = JSON.parse(readFileSync(pidPath, "utf8")) as Pids;
  return { root, resultPath, worker, workerExit, pids };
}

async function waitForTree(pids: Pids, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && [pids.child, pids.grandchild].some(processAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function cleanup(run: WorkerRun | undefined): void {
  if (!run) return;
  for (const pid of [run.pids.child, run.pids.grandchild]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(run.root, { recursive: true, force: true });
}

for (const repeated of [false, true]) {
  test(
    `Codex worker kills a child that ignores SIGTERM when the worker itself is terminated${repeated ? " repeatedly" : ""}`,
    { skip: process.platform === "win32" ? "uses POSIX signals" : false },
    async () => {
      let run: WorkerRun | undefined;
      try {
        run = await startWorker(fakeCodex(true));
        run.worker.kill("SIGTERM");
        if (repeated) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(run.worker.kill("SIGTERM"), true, "worker must survive until escalation");
        }
        const exit = await run.workerExit;
        await waitForTree(run.pids);
        for (const pid of [run.pids.child, run.pids.grandchild]) {
          assert.equal(processAlive(pid), false, `pid ${pid} survived worker termination`);
        }
        assert.equal(exit.code, 0, JSON.stringify(exit));
        const result = JSON.parse(readFileSync(run.resultPath, "utf8")) as {
          signal: string | null;
        };
        assert.equal(result.signal, "SIGKILL");
      } finally {
        cleanup(run);
      }
    },
  );
}

test(
  "Codex worker kills a signal-ignoring grandchild after the direct child exits on SIGTERM",
  { skip: process.platform === "win32" ? "uses POSIX signals" : false },
  async () => {
    let run: WorkerRun | undefined;
    try {
      run = await startWorker(fakeCodex(false));
      run.worker.kill("SIGTERM");
      const exit = await run.workerExit;
      await waitForTree(run.pids);
      assert.equal(processAlive(run.pids.child), false, `child ${run.pids.child} survived`);
      assert.equal(
        processAlive(run.pids.grandchild),
        false,
        `grandchild ${run.pids.grandchild} survived after the direct child exited`,
      );
      assert.equal(exit.code, 0, JSON.stringify(exit));
      const result = JSON.parse(readFileSync(run.resultPath, "utf8")) as {
        signal: string | null;
      };
      assert.equal(result.signal, "SIGTERM");
    } finally {
      cleanup(run);
    }
  },
);
