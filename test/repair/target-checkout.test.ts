import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareTargetCheckout } from "../../dist/repair/target-checkout.js";

const job = { frontmatter: { repo: "openclaw/clawsweeper" } };

test("target checkout selection avoids cloning supplied or current checkouts", async () => {
  assert.equal(
    await prepareTargetCheckout(
      { frontmatter: { ...job.frontmatter, target_checkout: " /explicit " } },
      { CLAWSWEEPER_TARGET_CHECKOUT: "/env" },
    ),
    "/explicit",
  );
  assert.equal(await prepareTargetCheckout(job, { CLAWSWEEPER_TARGET_CHECKOUT: " /env " }), "/env");
  assert.equal(
    await prepareTargetCheckout(job, { GITHUB_REPOSITORY: "openclaw/clawsweeper" }),
    process.cwd(),
  );
});

test("target clone honors budgets and kills stalled descendants before cleanup", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-clone-child-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const trace = path.join(tmp, "trace.json");
  const script = path.join(tmp, "clone.cjs");
  fs.writeFileSync(
    script,
    `const fs = require('node:fs'); const {spawn} = require('node:child_process');
const args = process.argv.slice(2);
require('node:assert/strict').deepEqual(args.slice(0,3), ['repo','clone','openclaw/clawsweeper']);
require('node:assert/strict').deepEqual(args.slice(4), ['--','--depth=1']);
fs.mkdirSync(args[3]); fs.writeFileSync(require('node:path').join(args[3], 'marker'), 'cloned');
if (process.env.STALL) {
 const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'inherit'});
 fs.writeFileSync(process.env.TRACE, JSON.stringify({parent:process.pid,pid:child.pid,target:args[3]}));
 process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
}`,
  );
  const listenerCounts = ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map((signal) =>
    process.listenerCount(signal),
  );
  let expected = 180_000;
  const nativeTimeout = setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    assert.equal(delay, expected);
    return nativeTimeout(callback, delay, ...args);
  });
  const base = {
    ...process.env,
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([script]),
    GITHUB_REPOSITORY: "",
    CLAWSWEEPER_TARGET_CHECKOUT: "",
    CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: "",
    CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS: "",
  };
  for (const [env, timeout] of [
    [{}, 180_000],
    [
      {
        CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: undefined,
        CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS: "240000",
      },
      240_000,
    ],
    [
      {
        CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: "300000",
        CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS: "45000",
      },
      300_000,
    ],
    [{ CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: "10" }, 30_000],
    ...["", "invalid", "0", "-1", "Infinity"].map((value) => [
      { CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS: value },
      180_000,
    ]),
  ] as const) {
    expected = timeout;
    const checkout = await prepareTargetCheckout(job, { ...base, ...env });
    assert.equal(fs.readFileSync(path.join(checkout, "marker"), "utf8"), "cloned");
    fs.rmSync(path.dirname(checkout), { recursive: true, force: true });
  }
  // Only the test clock is shortened; production selects its normal three-minute budget.
  // The process-tree helper may schedule a zero-delay forced-kill timer as well.
  t.mock.restoreAll();
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) =>
    nativeTimeout(callback, delay === 180_000 ? 1_000 : delay, ...args),
  );
  await assert.rejects(
    prepareTargetCheckout(job, { ...base, STALL: "1", TRACE: trace }),
    /ETIMEDOUT after 180000ms/,
  );
  assert.deepEqual(
    ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map((signal) => process.listenerCount(signal)),
    listenerCounts,
  );
  let { pid, target } = JSON.parse(fs.readFileSync(trace, "utf8"));
  const descendantPids = [pid];
  assert.equal(fs.existsSync(path.dirname(target)), false);
  fs.rmSync(trace);
  const caller = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {prepareTargetCheckout} from ${JSON.stringify(new URL("../../dist/repair/target-checkout.js", import.meta.url).href)};
await prepareTargetCheckout({frontmatter:{repo:'openclaw/clawsweeper'}});`,
    ],
    { env: { ...base, STALL: "1", TRACE: trace }, stdio: ["ignore", "ignore", "pipe"] },
  );
  t.after(() => caller.kill("SIGTERM"));
  let errorText = "";
  caller.stderr.on("data", (chunk) => (errorText += chunk));
  const ended = once(caller, "close");
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(trace) && Date.now() < deadline)
    await new Promise((resolve) => nativeTimeout(resolve, 20));
  assert.ok(fs.existsSync(trace), "clone subprocess started");
  caller.kill("SIGTERM");
  const [code] = await ended;
  assert.equal(code, 1);
  assert.match(errorText, /interrupted by SIGTERM/);
  ({ pid, target } = JSON.parse(fs.readFileSync(trace, "utf8")));
  descendantPids.push(pid);
  assert.equal(fs.existsSync(path.dirname(target)), false);
  if (process.platform !== "win32") {
    // A just-killed child may briefly remain a zombie until its reaper runs.
    await new Promise((resolve) => nativeTimeout(resolve, 100));
    const states = execFileSync("ps", ["-axo", "pid=,stat="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([id, state]) => descendantPids.includes(Number(id)) && !state.startsWith("Z"));
    assert.deepEqual(states, []);
  }
});
