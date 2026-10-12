import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { parse } from "yaml";

test("disabled activity does not require optional hook secrets, while enabled activity does", (t) => {
  const workflow = parse(readFileSync(".github/workflows/dashboard.yml", "utf8"));
  const step = workflow.jobs.deploy.steps.find(
    (value: { name?: string }) => value.name === "Sync Worker secrets",
  );
  const source = step.run.match(/node -e '([\s\S]*?)' "\$secrets_file"/)?.[1];
  assert.ok(source);
  const root = mkdtempSync(path.join(os.tmpdir(), "activity-secrets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [gate, hook, expected] of [
    ["0", false, 0],
    ["1", false, 2],
    ["1", true, 0],
  ] as const) {
    const output = path.join(root, `${gate}-${hook}.json`);
    const result = spawnSync(process.execPath, ["-e", source, output], {
      encoding: "utf8",
      env: {
        CLAWSWEEPER_APP_PRIVATE_KEY: "synthetic-app-key",
        CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-webhook-secret",
        CLAWSWEEPER_GITHUB_ACTIVITY_FROM_WEBHOOK: gate,
        ...(hook
          ? {
              CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://synthetic.invalid/hooks",
              CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "synthetic-hook-token",
            }
          : {}),
      },
    });
    assert.equal(result.status, expected, result.stderr);
    if (expected === 0) {
      const names = Object.keys(JSON.parse(readFileSync(output, "utf8")).secrets).sort();
      assert.deepEqual(
        names,
        [
          "CLAWSWEEPER_APP_PRIVATE_KEY",
          "CLAWSWEEPER_WEBHOOK_SECRET",
          ...(hook ? ["CLAWSWEEPER_OPENCLAW_HOOK_TOKEN", "CLAWSWEEPER_OPENCLAW_HOOK_URL"] : []),
        ].sort(),
      );
    }
  }
});

test("relay shutdown follows the shared normalizer's event_name-before-activity.type contract", () => {
  const workflow = parse(readFileSync(".github/workflows/github-activity.yml", "utf8"));
  const expression = workflow.jobs.notify.if.replace(/^\s*\$\{\{|\}\}\s*$/g, "");
  for (const [payload, admitted] of [
    [{ event_name: "issue_comment", activity: {} }, false],
    [{ event_name: "issues", activity: { type: "pull_request_review" } }, false],
    [{ event_name: "pull_request_review", activity: { type: "issues" } }, true],
    [{ activity: { type: "pull_request_target", action: "opened" } }, false],
    [{ activity: { type: "push" } }, true],
  ] as const) {
    const result = runInNewContext(expression, {
      github: { event_name: "repository_dispatch", event: { client_payload: payload } },
      vars: { CLAWSWEEPER_GITHUB_ACTIVITY_RELAY_DISABLED: "1" },
      fromJSON: JSON.parse,
      contains: (values: unknown[], value: unknown) => values.includes(value),
    });
    assert.equal(result, admitted);
  }
});
