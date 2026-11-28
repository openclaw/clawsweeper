import assert from "node:assert/strict";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

type Scenarios = typeof import("./review-coverage-byte-pressure.ts") &
  typeof import("./review-coverage-cleanup.ts") &
  typeof import("./review-coverage-sticky-drift.ts") &
  typeof import("./review-coverage-pending-promotion.ts");

const modules = {
  runBytePressureScenario: "./review-coverage-byte-pressure.ts",
  cleanupProgressScenario: "./review-coverage-cleanup.ts",
  noWorkProgressScenario: "./review-coverage-cleanup.ts",
  stickyDriftScenario: "./review-coverage-sticky-drift.ts",
  pendingCopyDriftScenario: "./review-coverage-pending-promotion.ts",
  pendingWitnessDriftScenario: "./review-coverage-pending-promotion.ts",
} satisfies Record<keyof Scenarios, string>;

// These CLI fixtures own the process clock, transport and output until they finish.
// Keep that state away from the test reporter and terminate it at the test deadline.
export async function runCensusScenario<K extends keyof Scenarios>(
  t: TestContext,
  scenario: K,
  ...args: Parameters<Scenarios[K]>
): Promise<Awaited<ReturnType<Scenarios[K]>>> {
  const worker = new Worker(new URL(import.meta.url), { workerData: { scenario, args } });
  t.after(async () => {
    await worker.terminate();
  });
  let response: { result: Awaited<ReturnType<Scenarios[K]>> } | undefined;
  worker.once("message", (message) => {
    response = message;
  });
  const [code] = await once(worker, "exit");
  assert.equal(code, 0, `Census worker for ${scenario} exited with status ${code}`);
  assert.ok(response, `Census worker for ${scenario} exited without returning a result`);
  return response.result;
}

if (!isMainThread && Object.hasOwn(modules, workerData?.scenario)) {
  const { scenario, args } = workerData as { scenario: keyof Scenarios; args: unknown[] };
  const fixture = await import(modules[scenario]);
  parentPort!.postMessage({ result: await fixture[scenario](...args) });
}
