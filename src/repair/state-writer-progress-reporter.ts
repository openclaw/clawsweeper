import { spawn } from "node:child_process";
import type { StateWriterTelemetryObserver } from "./state-writer-telemetry-recorder.js";

export type StateWriterProgressClaim = {
  queueUrl: string;
  leaseId: string;
  itemKey: string;
  leaseRevision: number;
  claimGeneration: number;
  runId: string;
  runAttempt: number;
};

export function stateWriterProgressReporter(
  claim: StateWriterProgressClaim | null,
): StateWriterTelemetryObserver | undefined {
  if (!claim || !validClaim(claim)) return undefined;
  return {
    progress(progress) {
      try {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const [url, payload] = process.argv.slice(1);
             const controller = new AbortController();
             setTimeout(() => controller.abort(), 4000).unref();
             fetch(url, { method: "POST", headers: {"content-type": "application/json"},
               body: payload, signal: controller.signal }).catch(() => {});`,
            `${claim.queueUrl.replace(/\/$/, "")}/internal/exact-review/state-writer-progress`,
            JSON.stringify({
              ...progress,
              lease_id: claim.leaseId,
              item_key: claim.itemKey,
              lease_revision: claim.leaseRevision,
              claim_generation: claim.claimGeneration,
              run_id: claim.runId,
              run_attempt: claim.runAttempt,
            }),
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.on("error", () => {});
        child.unref();
      } catch {
        // Progress is intentionally fire-and-forget.
      }
    },
  };
}

function validClaim(claim: StateWriterProgressClaim): boolean {
  return (
    claim.queueUrl.startsWith("https://") &&
    Boolean(claim.leaseId) &&
    Boolean(claim.itemKey) &&
    /^\d+$/.test(claim.runId) &&
    Number.isInteger(claim.leaseRevision) &&
    claim.leaseRevision > 0 &&
    Number.isInteger(claim.claimGeneration) &&
    claim.claimGeneration > 0 &&
    Number.isInteger(claim.runAttempt) &&
    claim.runAttempt > 0
  );
}
