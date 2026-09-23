#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const configured = Number(
  process.env.CLAWSWEEPER_OPENCLAW_CODEX_SOURCE_TIMEOUT_MS ??
    process.env.CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS ??
    process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS,
);
const timeoutMs =
  Number.isFinite(configured) && configured > 0 && configured <= 2_147_483_647
    ? Math.max(1, Math.floor(configured))
    : 120_000;
const child = spawn("git", process.argv.slice(2), {
  stdio: "inherit",
  detached: process.platform !== "win32",
});
let stopping = false;
let finished = false;
let escalation;

function signalGroup(signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function stop(signal = "SIGTERM") {
  if (stopping || finished) return;
  stopping = true;
  signalGroup(signal);
  escalation = setTimeout(() => signalGroup("SIGKILL"), 1_000);
}

const deadline = setTimeout(() => {
  console.error(`Codex source fetch timed out after ${timeoutMs}ms.`);
  stop();
}, timeoutMs);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(signal));
}

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  clearTimeout(escalation);
  // A leader exit does not prove that its transport descendants have exited.
  signalGroup("SIGKILL");
  process.exitCode = stopping ? 124 : (code ?? 1);
}

child.once("error", (error) => {
  console.error(error.message);
  finish(1);
});
child.once("close", (code) => finish(code));
