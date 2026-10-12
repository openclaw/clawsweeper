import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("activity tail emits only allowlisted scalar outcomes, never invocation metadata or unrelated logs", () => {
  const outcome = {
    event: "github_activity_hook",
    delivery_id: "delivery-1",
    source_event: "issue_comment",
    repository: "openclaw/clawsweeper",
    item_number: 42,
    outcome: "admitted",
    hook_status: 200,
    attempts: 1,
    duration_ms: 15,
    hook_url: "https://secret.invalid",
    token: "secret-token",
    payload: { body: "secret-body" },
  };
  const input = [
    "Connecting to tail...",
    JSON.stringify(
      {
        event: { request: { url: "https://private-request.invalid" } },
        logs: [
          { message: [JSON.stringify({ token: "unrelated-secret" })] },
          { message: ["not JSON", JSON.stringify(outcome)] },
        ],
      },
      null,
      2,
    ),
    JSON.stringify({
      logs: [
        {
          message: [
            JSON.stringify({ event: "github_activity_hook", outcome: { token: "nested-secret" } }),
          ],
        },
      ],
    }),
  ].join("\n");
  const result = spawnSync(process.execPath, ["scripts/github-activity-tail.mjs"], {
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      {
        delivery_id: "delivery-1",
        source_event: "issue_comment",
        repository: "openclaw/clawsweeper",
        item_number: 42,
        outcome: "admitted",
        hook_status: 200,
        attempts: 1,
        duration_ms: 15,
      },
    ],
  );
  assert.ok(!result.stdout.includes("secret"));
  assert.equal(result.stderr, "");
});
