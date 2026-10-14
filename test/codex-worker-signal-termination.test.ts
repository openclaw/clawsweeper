import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

function alive(pid: number): boolean {
  // Orphan zombies have exited even when PID 1 has not reaped them yet.
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  assert.ifError(result.error);
  const state = result.stdout.trim();
  return state.length > 0 && !state.startsWith("Z");
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, "process fixture did not reach expected state");
    await delay(20);
  }
}

const scenarios = [
  "single",
  "repeated",
  "early-exit",
  "timeout",
  "graceful-cancel",
  "natural-exit",
  "natural-failure",
  "natural-inherited-exit",
  "natural-inherited-failure",
];
for (const scenario of scenarios) {
  test(
    `process worker cleans its process group: ${scenario}`,
    {
      skip: process.platform === "win32" ? "POSIX process groups" : false,
      timeout: 20_000,
    },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "codex-tree-"));
      const pidsPath = join(root, "pids.json");
      const readyPath = join(root, "ready");
      const cleanupPath = join(root, "cleanup-finished");
      const binary = join(root, "codex-fixture.cjs");
      const resultPath = join(root, "result.json");
      const optionsPath = join(root, "options.json");
      const ignoresSignal = scenario === "single" || scenario === "repeated";
      const naturalExit = scenario.startsWith("natural-");
      const naturalStatus = scenario.endsWith("failure") ? 7 : 0;
      const gracefulDescendant = scenario.includes("graceful");
      writeFileSync(
        binary,
        `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(`
  process.on("SIGTERM", () => {
    if (${gracefulDescendant}) setTimeout(() => {
      require("node:fs").writeFileSync(${JSON.stringify(cleanupPath)}, "finished");
      process.exit(0);
    }, 150);
  });
  require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready");
  setInterval(() => {}, 1000);
`)}], { stdio: ${JSON.stringify(scenario.includes("inherited") || gracefulDescendant ? "inherit" : "ignore")} });
${ignoresSignal ? 'process.on("SIGTERM", () => {});' : ""}
const announce = () => {
  if (!fs.existsSync(${JSON.stringify(readyPath)})) return setTimeout(announce, 10);
  fs.writeFileSync(${JSON.stringify(pidsPath + ".tmp")}, JSON.stringify([process.pid, grandchild.pid]));
  fs.renameSync(${JSON.stringify(pidsPath + ".tmp")}, ${JSON.stringify(pidsPath)});
  if (${naturalExit}) process.exit(${naturalStatus});
};
announce();
setInterval(() => {}, 1000);
`,
        { mode: 0o755 },
      );
      writeFileSync(
        optionsPath,
        JSON.stringify({
          command: binary,
          args: [],
          timeoutMs: scenario === "timeout" ? 2_000 : naturalExit ? 5_000 : 60_000,
          resultPath,
          stdoutPath: join(root, "stdout"),
          stderrPath: join(root, "stderr"),
          maxOutputFileBytes: 65_536,
          tailBytes: 4096,
        }),
      );
      const worker = spawn(
        process.execPath,
        [fileURLToPath(new URL("../dist/codex-process-worker.js", import.meta.url)), optionsPath],
        { cwd: root, stdio: ["pipe", "ignore", "pipe"] },
      );
      const exit = new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code, signal) => resolve({ code, signal }));
      });
      let stderr = "";
      worker.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      worker.stdin.end("Review the fixture.");
      let pids: number[] = [];
      try {
        await waitUntil(() => existsSync(pidsPath));
        pids = JSON.parse(readFileSync(pidsPath, "utf8")) as number[];
        if (scenario !== "timeout" && !naturalExit) {
          assert.ok(worker.kill("SIGTERM"));
          if (scenario === "repeated") {
            await delay(50);
            assert.ok(worker.kill("SIGTERM"));
          }
        }
        await waitUntil(() => worker.exitCode !== null || worker.signalCode !== null);
        assert.deepEqual(await exit, { code: 0, signal: null }, stderr);
        await waitUntil(() => pids.every((pid) => !alive(pid)));
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        if (gracefulDescendant) assert.equal(readFileSync(cleanupPath, "utf8"), "finished");
        if (naturalExit) {
          assert.equal(result.status, naturalStatus);
          assert.equal(result.signal, null);
          assert.notEqual(result.error?.code, "ETIMEDOUT");
        } else {
          assert.equal(result.signal, ignoresSignal ? "SIGKILL" : "SIGTERM");
          if (scenario === "timeout") assert.equal(result.error?.code, "ETIMEDOUT");
        }
        console.log(
          JSON.stringify({
            workerKind: "process",
            scenario,
            descendantsAlive: pids.map(alive),
            resultStatus: result.status,
            resultSignal: result.signal,
          }),
        );
      } finally {
        worker.kill("SIGKILL");
        // Recover recorded PIDs even if startup assertions failed.
        if (pids.length === 0 && existsSync(pidsPath))
          pids = JSON.parse(readFileSync(pidsPath, "utf8"));
        if (pids[0]) {
          try {
            process.kill(-pids[0], "SIGKILL");
          } catch {}
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
