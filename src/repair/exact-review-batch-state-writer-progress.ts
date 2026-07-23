import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";

import type { ExactReviewBatchMember } from "./exact-review-batch-publisher.js";
import type { StateWriterTelemetryObserver } from "./state-writer-telemetry-recorder.js";

export function exactReviewBatchStateWriterProgressReporter(input: {
  queueUrl: string;
  webhookSecret: string;
  batchId: string;
  leaseOwner: string;
  items: readonly ExactReviewBatchMember[];
}): StateWriterTelemetryObserver | undefined {
  if (!input.queueUrl.startsWith("https://") || !input.webhookSecret || !input.items.length) {
    return undefined;
  }
  return {
    progress(progress) {
      try {
        const body = JSON.stringify({
          batch_id: input.batchId,
          lease_owner: input.leaseOwner,
          items: input.items.map((item) => ({
            item_key: item.itemKey,
            revision: item.revision,
            claim_generation: item.claimGeneration,
          })),
          state_writer_progress: progress,
        });
        const signature = `sha256=${createHmac("sha256", input.webhookSecret).update(body).digest("hex")}`;
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const [url, signature, body] = process.argv.slice(1);
             const controller = new AbortController();
             setTimeout(() => controller.abort(), 4000).unref();
             fetch(url, { method: "POST", headers: {"content-type": "application/json", "x-clawsweeper-exact-review-signature": signature},
               body, signal: controller.signal }).catch(() => {});`,
            `${input.queueUrl.replace(/\/$/, "")}/internal/exact-review/publication-batches/heartbeat`,
            signature,
            body,
          ],
          { detached: true, stdio: "ignore", windowsHide: true },
        );
        child.on("error", () => {});
        child.unref();
      } catch {
        // Progress must never alter publication behavior.
      }
    },
  };
}
