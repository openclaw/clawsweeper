import { createHmac } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isReviewUsageRecord } from "./review-usage-contract.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_LINES = 200;

/** Submit only bounded, validated records from the untrusted review's local handoff. */
export async function submitReviewUsageFile(options: {
  path: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = options.env ?? process.env;
  const baseUrl = env.EXACT_REVIEW_QUEUE_URL;
  const secret = env.CLAWSWEEPER_WEBHOOK_SECRET;
  if (!options.path || !baseUrl || !secret) return;

  try {
    const url = new URL("/internal/exact-review/review-usage", baseUrl);
    const base = new URL(baseUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (
      (base.protocol !== "https:" && !(base.protocol === "http:" && local)) ||
      base.username ||
      base.password
    ) {
      throw new Error("Unsupported telemetry destination");
    }

    const file = await open(
      options.path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    let data: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
      // One extra byte detects growth without allowing an unbounded read.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > stat.size) return;
      data = buffer.subarray(0, length);
    } finally {
      await file.close();
    }

    let start = 0;
    for (let line = 0; line < MAX_LINES && start < data.length; line++) {
      const newline = data.indexOf(10, start);
      const end = newline === -1 ? data.length : newline;
      const length = end - start;
      const offset = start;
      start = end + 1;
      if (length === 0 || length > MAX_LINE_BYTES) continue;
      let record: unknown;
      try {
        record = JSON.parse(data.toString("utf8", offset, end));
      } catch {
        continue;
      }
      if (!isReviewUsageRecord(record)) continue;
      const body = JSON.stringify(record);
      const signature = createHmac("sha256", secret).update(body).digest("hex");
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": `sha256=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(1500),
          redirect: "error",
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("Telemetry rejected");
      } catch {
        // Never log response bodies, destinations, credentials, or review output.
        console.error("[review-usage] best-effort telemetry unavailable");
      }
    }
  } catch {
    console.error("[review-usage] best-effort telemetry unavailable");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await submitReviewUsageFile({
    path: process.argv[2] ?? process.env.CLAWSWEEPER_REVIEW_USAGE_PATH ?? "",
  });
  process.exitCode = 0;
}
