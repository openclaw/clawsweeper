import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const observer = fileURLToPath(new URL("../scripts/review-run-observer.mjs", import.meta.url));
const preload = fileURLToPath(
  new URL("./fixtures/review-run-observer-transport.mjs", import.meta.url),
);
const secret = "synthetic-observer-signing-key";
function runObserver(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "observer-transport-"));
  try {
    const event = join(root, "event.json");
    writeFileSync(
      event,
      JSON.stringify({
        workflow_run: {
          id: 1234,
          run_attempt: 2,
          status: "completed",
          conclusion: "success",
          event: "repository_dispatch",
          display_title: "Review event item openclaw/openclaw#674",
          run_started_at: "2026-09-21T00:00:00Z",
          updated_at: "2026-09-21T00:01:00Z",
          html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1234",
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", preload, observer, "--event-file", event],
      {
        env: {
          PATH: process.env.PATH,
          OBSERVER_FIXTURE_MODE: mode,
          GH_TOKEN: "synthetic-github-token",
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          GITHUB_API_URL: "https://github.example.test",
          QUEUE_URL: "https://queue.example.test",
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    const line = result.stdout.split("\n").find((line) => line.startsWith("OBSERVER_FIXTURE "));
    assert.ok(line, result.stderr);
    const receipt = JSON.parse(line.slice("OBSERVER_FIXTURE ".length));
    assert.equal(receipt.finished, true, result.stderr);
    for (const call of receipt.calls) {
      assert.equal(call.body, receipt.calls[0].body);
      assert.equal(
        call.signature,
        `sha256=${createHmac("sha256", secret).update(call.body).digest("hex")}`,
      );
    }
    assert.equal(JSON.parse(receipt.calls[0].body).run_attempt, 2);
    return { ...result, ...receipt };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of [
  "500",
  "408",
  "reset",
  "timeout",
  "retry-seconds",
  "retry-date",
  "retry-cap",
  "retry-invalid",
]) {
  test(`observer CLI retries ${mode} with the same signed terminal tuple`, () => {
    const result = runObserver(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 2);
    const delay =
      mode === "retry-seconds"
        ? 7_000
        : mode === "retry-date"
          ? 8_000
          : mode === "retry-cap"
            ? 10_000
            : 1_000;
    assert.deepEqual(result.timers, [20_000, delay, 20_000]);
    assert.equal(result.cancelledBodies, ["reset", "timeout"].includes(mode) ? 1 : 2);
    assert.match(result.stdout, /observed review run 1234\/2/);
  });
}
for (const mode of ["terminal", "certificate", "invalid", "ack-cleanup-failure"]) {
  test(`observer CLI does not retry ${mode}`, () => {
    const result = runObserver(mode);
    assert.equal(result.status, 1);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.timers, [20_000]);
    assert.doesNotMatch(result.stdout, /observed review run/);
    if (mode === "ack-cleanup-failure")
      assert.match(result.stderr, /acknowledged but response cleanup failed/);
  });
}
test("observer CLI fails after its bounded transient attempts and settles every response", () => {
  const result = runObserver("exhausted");
  assert.equal(result.status, 1);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.timers, [20_000, 1_000, 20_000, 2_000, 20_000]);
  assert.equal(result.cancelledBodies, 3);
  assert.match(result.stderr, /review telemetry write returned 503/);
  assert.doesNotMatch(result.stderr, /synthetic upstream response/);
});
