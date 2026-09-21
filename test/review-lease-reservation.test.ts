import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test(
  "reservation workflow avoids comment churn for stale and retrying owners",
  { timeout: 180_000 },
  () => {
    const output = mkdtempSync(join(tmpdir(), "reservation-proof-"));
    try {
      execFileSync(process.execPath, ["scripts/e2e/review-reservation.mjs", output], {
        timeout: 170_000,
      });
      assert.equal(JSON.parse(readFileSync(join(output, "summary.json"), "utf8")).passed, 9);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  },
);
