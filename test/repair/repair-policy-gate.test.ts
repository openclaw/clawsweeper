import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("compiled proof suppresses queued and replayed Enterprise final I/O", () => {
  const result = spawnSync(process.execPath, ["scripts/e2e/proof-repair-policy-gate.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.ok, true);
  assert.deepEqual(
    proof.receipts.map(
      (receipt: { delivery: string; allowed: boolean; targetWriteCalls: number }) => ({
        delivery: receipt.delivery,
        allowed: receipt.allowed,
        targetWrites: receipt.targetWriteCalls,
      }),
    ),
    [
      { delivery: "queued", allowed: false, targetWrites: 0 },
      {
        delivery: "replayed-with-prior-execute-permission",
        allowed: false,
        targetWrites: 0,
      },
      { delivery: "allowed-control", allowed: true, targetWrites: 1 },
    ],
  );
});
