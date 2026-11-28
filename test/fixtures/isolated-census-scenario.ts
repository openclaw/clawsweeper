import type { TestContext } from "node:test";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { runBytePressureScenario } from "./review-coverage-byte-pressure.ts";
import { cleanupProgressScenario, noWorkProgressScenario } from "./review-coverage-cleanup.ts";
import {
  pendingCopyDriftScenario,
  pendingWitnessDriftScenario,
} from "./review-coverage-pending-promotion.ts";
import { stickyDriftScenario } from "./review-coverage-sticky-drift.ts";

const scenarios = {
  runBytePressureScenario,
  cleanupProgressScenario,
  noWorkProgressScenario,
  pendingCopyDriftScenario,
  pendingWitnessDriftScenario,
  stickyDriftScenario,
};

type Scenarios = typeof scenarios;

// The scenarios install a process-global replay clock and HTTP fixtures.
// A node:test timeout ends the test without cancelling its async producer.
export function runCensusScenario<K extends keyof Scenarios>(
  t: TestContext,
  name: K,
  ...args: Parameters<Scenarios[K]>
): Promise<Awaited<ReturnType<Scenarios[K]>>> {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { runner: import.meta.url, name, args },
  });
  t.after(async () => {
    await worker.terminate();
  });
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) =>
      reject(new Error(`Census scenario ${name} exited before returning its result (${code})`)),
    );
  });
}

if (parentPort && workerData?.runner === import.meta.url) {
  const run = scenarios[workerData.name as keyof Scenarios];
  parentPort.postMessage(await Reflect.apply(run, undefined, workerData.args));
}
