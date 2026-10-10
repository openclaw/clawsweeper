#!/usr/bin/env node
// Bound one git command. A stalled fetch otherwise holds the exact-review slot
// until the 150-minute job limit. The deadline kills the process group so
// git-remote-http cannot outlive git.

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const configured = Number(
  process.env.CLAWSWEEPER_REVIEW_TARGET_CHECKOUT_TIMEOUT_MS ??
    process.env.CLAWSWEEPER_GIT_NETWORK_TIMEOUT_MS ??
    process.env.CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS ??
    1_800_000,
);
if (!Number.isSafeInteger(configured) || configured < 1 || configured > 7_200_000) {
  console.error(`Invalid review checkout timeout: ${configured}`);
  process.exit(1);
}
const timeoutMs = configured;
const seconds = Math.ceil(timeoutMs / 1000);
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
  console.error(`Target checkout git command timed out after ${seconds}s.`);
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
  signalGroup("SIGKILL");
  process.exitCode = stopping ? 124 : (code ?? 1);
}

child.once("error", (error) => {
  console.error(error.message);
  finish(1);
});
child.once("close", (code) => finish(code));
