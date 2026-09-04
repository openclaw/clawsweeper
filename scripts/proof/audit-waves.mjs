#!/usr/bin/env node
// Real subprocess completion exercises the production wave scheduler without GitHub dispatch.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { dispatchAuditWaves } from "../../dist/repair/target-fanout.js";
import { AUTOMATION_LIMITS } from "../../dist/limits.js";

const root = mkdtempSync(join(tmpdir(), "audit-wave-proof-"));
const children = [];
const trace = [];
const active = new Set();
let peak = 0;
try {
  await dispatchAuditWaves(
    Array.from({ length: 12 }, (_, index) => [String(index + 1)]),
    {
      dispatchRepo: "synthetic/audits",
      wait: () => delay(20),
      run: (args) => {
        const id = args[0] === "run" ? args[2] : args[0];
        const receipt = join(root, `${id}.json`);
        if (args[0] !== "run") {
          active.add(id);
          peak = Math.max(peak, active.size);
          trace.push({ event: "dispatch", id, active: active.size, at: Date.now() });
          const child = spawn(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
          import { writeFileSync } from "node:fs";
          setTimeout(() => writeFileSync(process.argv[1], JSON.stringify({
            databaseId: Number(process.argv[2]), status: "completed", conclusion: "success"
          })), 80 + Number(process.argv[2]) % 3 * 80);
        `,
              receipt,
              id,
            ],
            { stdio: "ignore" },
          );
          children.push(child);
          return JSON.stringify({ workflow_run_id: Number(id) });
        }
        if (!existsSync(receipt))
          return JSON.stringify({ databaseId: Number(id), status: "in_progress" });
        active.delete(id);
        trace.push({ event: "complete", id, active: active.size, at: Date.now() });
        return readFileSync(receipt, "utf8");
      },
    },
  );
  assert.equal(peak, AUTOMATION_LIMITS.audit.max_parallel_targets);
  assert.equal(active.size, 0);
  assert.equal(trace.filter((entry) => entry.event === "dispatch").length, 12);
  assert.equal(trace.filter((entry) => entry.event === "complete").length, 12);
  const result = {
    peak,
    targets: 12,
    bound: AUTOMATION_LIMITS.audit.max_parallel_targets,
    trace,
    limits:
      "Synthetic subprocesses replace GitHub audits; no live dispatch, hydration, Actions scheduling, or queue calls. Polling is accelerated to 20 ms.",
  };
  mkdirSync(".artifacts", { recursive: true });
  writeFileSync(".artifacts/audit-waves-proof.json", `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ peak, targets: 12, completed: 12 }));
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  rmSync(root, { recursive: true, force: true });
}
