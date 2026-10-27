import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
  prepareGithubActivity as prepareCompiled,
  runGithubActivityPreflight as preflightCompiled,
} from "../../dist/repair/github-activity-admission.js";
import {
  prepareGithubActivity as prepareSource,
  runGithubActivityPreflight as preflightSource,
} from "../../src/repair/github-activity-admission.ts";
import { runGithubActivityNotifier } from "../../dist/repair/notify-github-activity.js";

const observedAt = new Date("2026-10-01T12:00:00.000Z");
const issue = { number: 42, title: "Fix admission", state: "open" };
const invalidHook = {
  CLAWSWEEPER_OPENCLAW_HOOK_URL: "not a URL",
  CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "fixture-token",
  CLAWSWEEPER_DISCORD_TARGET: "channel:fixture",
};

test("source and emitted admission preserve normalized facts, skip reasons, and reports", () => {
  const fixtures = [
    {
      eventName: "issue_comment",
      payload: {
        action: "edited",
        issue,
        sender: { login: "contributor" },
        comment: { id: 1, body: "plain edit", user: { login: "contributor" } },
      },
      admitted: false,
      reason: "issue comment edit",
    },
    ...["contributor", "third-party[bot]"].map((login) => ({
      eventName: "issue_comment",
      payload: {
        action: "edited",
        issue,
        sender: { login },
        comment: { id: 2, body: "@clawsweeper re-review", user: { login } },
      },
      admitted: true,
      reason: null,
    })),
    {
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue,
        sender: { login: "clawsweeper[bot]" },
        comment: { id: 3, body: "@clawsweeper review", user: { login: "clawsweeper[bot]" } },
      },
      admitted: false,
      reason: "ClawSweeper-authored",
    },
    {
      eventName: "repository_dispatch",
      payload: {
        client_payload: {
          event_name: "issue_comment",
          activity: {
            type: "issues",
            action: "edited",
            repo: "openclaw/forwarded",
            actor: "third-party[bot]",
            subject: { kind: "issue", number: 42 },
            body_excerpt: "/re-run",
          },
        },
      },
      admitted: true,
      reason: null,
    },
    {
      eventName: "repository_dispatch",
      payload: {
        client_payload: {
          event_name: "issue_comment",
          activity: {
            action: "edited",
            subject: { kind: "issue", number: 42 },
            body_excerpt: `${"x".repeat(1200)} @clawsweeper review`,
          },
        },
      },
      admitted: false,
      reason: "issue comment edit",
    },
    ...["success", "neutral", "skipped"].map((conclusion) => ({
      eventName: "workflow_run",
      payload: { action: "completed", workflow_run: { id: 4, conclusion } },
      admitted: false,
      reason: "successful automation event",
    })),
    {
      eventName: "workflow_run",
      payload: { action: "completed", workflow_run: { id: 5, conclusion: "failure" } },
      admitted: true,
      reason: null,
    },
  ];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-admission-"));
  try {
    for (const fixture of fixtures) {
      const eventPath = path.join(root, "event.json");
      const reportPath = path.join(root, "report.json");
      fs.writeFileSync(eventPath, JSON.stringify(fixture.payload));
      const results = [prepareSource, prepareCompiled].map((prepare) => {
        fs.rmSync(reportPath, { force: true });
        const result = prepare({
          root,
          eventPath,
          eventName: fixture.eventName,
          reportPath,
          env: { GITHUB_REPOSITORY: "openclaw/fallback", ...invalidHook },
          writeReport: true,
          now: () => observedAt,
        });
        return {
          result,
          report: fs.existsSync(reportPath)
            ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
            : null,
        };
      });
      assert.deepEqual(results[0], results[1]);
      const { result, report } = results[0]!;
      assert.equal(result.admitted, fixture.admitted);
      if (!result.admitted) {
        assert.match(result.summary.reason ?? "", new RegExp(fixture.reason!));
        assert.equal(result.summary.sent, 0);
        assert.equal(result.summary.exitCode, 0);
        assert.equal(report.generated_at, observedAt.toISOString());
        assert.equal(report.event_path, "event.json");
        assert.equal(report.hook_run_id, null);
        assert.equal(report.failed, 0);
        assert.equal(report.reason, result.summary.reason);
      } else {
        assert.equal(report, null);
        assert.equal(result.observedAt, observedAt.toISOString());
        assert.equal(result.eventName, fixture.eventName);
        assert.equal(result.eventPath, eventPath);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing, unsupported, and malformed events keep their original outcomes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-admission-invalid-"));
  try {
    const eventPath = path.join(root, "event.json");
    const reportPath = path.join(root, "report.json");
    for (const prepare of [prepareSource, prepareCompiled]) {
      const options = { root, eventPath, reportPath, env: {}, writeReport: true };
      fs.rmSync(eventPath, { force: true });
      assert.deepEqual(prepare({ ...options, eventName: "issues" }), {
        admitted: false,
        summary: {
          status: "skipped",
          sent: 0,
          failed: 0,
          exitCode: 0,
          reason: "GitHub event payload missing",
        },
      });
      fs.writeFileSync(eventPath, "{}");
      const unsupported = prepare({ ...options, eventName: "unknown" });
      assert.equal(unsupported.admitted, false);
      if (!unsupported.admitted)
        assert.equal(unsupported.summary.reason, "unsupported GitHub event: unknown");
      assert.equal(fs.existsSync(reportPath), false);
      fs.writeFileSync(eventPath, "{");
      assert.throws(() => prepare({ ...options, eventName: "issues" }), SyntaxError);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preflight records explicit admission and preserves the rejected report", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-preflight-"));
  const eventPath = path.join(root, "event.json");
  const output = path.join(root, "output");
  const log = context.mock.method(console, "log", () => undefined);
  try {
    for (const preflight of [preflightSource, preflightCompiled]) {
      for (const action of ["opened", "edited"]) {
        fs.writeFileSync(output, "");
        fs.writeFileSync(eventPath, JSON.stringify({ action, issue }));
        const admission = preflight(
          {
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_EVENT_NAME: "issues",
            GITHUB_OUTPUT: output,
            ...invalidHook,
          },
          root,
        );
        assert.equal(admission.admitted, action === "opened");
        assert.equal(fs.readFileSync(output, "utf8"), `admitted=${action === "opened"}\n`);
        if (!admission.admitted) {
          const report = JSON.parse(
            fs.readFileSync(path.join(root, "notifications/github-activity-report.json"), "utf8"),
          );
          assert.equal(report.reason, admission.summary.reason);
          assert.deepEqual(
            JSON.parse(String(log.mock.calls.at(-1)!.arguments[0])),
            admission.summary,
          );
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("routine rejection precedes hook configuration, while admitted hook failures stay visible", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-admission-hooks-"));
  const eventPath = path.join(root, "event.json");
  let posts = 0;
  const runtime = {
    root,
    log: () => undefined,
    fetch: async () => {
      posts += 1;
      throw new Error("unexpected hook call");
    },
  };
  try {
    fs.writeFileSync(eventPath, JSON.stringify({ action: "edited", issue }));
    const routine = await runGithubActivityNotifier(["--write-report"], {
      ...runtime,
      env: { ...invalidHook, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "issues" },
    });
    assert.equal(routine.status, "skipped");
    assert.match(routine.reason ?? "", /metadata edit/);
    fs.writeFileSync(eventPath, JSON.stringify({ action: "opened", issue }));
    const env = { ...invalidHook, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: "issues" };
    const missing = await runGithubActivityNotifier([], {
      ...runtime,
      env: { ...env, CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "" },
    });
    assert.equal(missing.reason, "OpenClaw hook notification is not configured");
    for (const args of [[], ["--dry-run"]]) {
      await assert.rejects(runGithubActivityNotifier(args, { ...runtime, env }), /Invalid URL/);
    }
    assert.equal(posts, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workflow admits activity before package setup and retains runtime and hook boundaries", () => {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/github-activity.yml", "utf8"));
  const steps = workflow.jobs.notify.steps;
  const checkout = steps.findIndex(
    (step: { uses?: string }) => step.uses === "actions/checkout@v7",
  );
  const node = steps.findIndex((step: { uses?: string }) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  const admission = steps.findIndex((step: { id?: string }) => step.id === "activity");
  const packages = steps.findIndex(
    (step: { uses?: string }) => step.uses === "./.github/actions/setup-pnpm",
  );
  assert.ok(checkout < node && node < admission && admission < packages);
  assert.equal(steps[node].with["node-version"], "24.22.1");
  assert.equal(steps[admission].run, "node src/repair/github-activity-admission.ts");
  assert.equal(steps[admission].env, undefined);
  for (const step of [
    steps[packages],
    steps.find((step: { name?: string }) => step.name === "Feed activity to OpenClaw"),
  ]) {
    assert.equal(step.if, "steps.activity.outputs.admitted == 'true'");
    const admitted = new Function("steps", `return (${step.if});`);
    assert.equal(admitted({ activity: { outputs: { admitted: "false" } } }), false);
    assert.equal(admitted({ activity: { outputs: { admitted: "true" } } }), true);
  }
  assert.equal(steps[packages].with["build-script"], "build:repair");
  assert.equal(workflow["permissions"].contents, "read");
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
});
