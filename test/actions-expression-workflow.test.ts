import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

function checkScripts(value: unknown, location: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === "run" || key === "script") && typeof child === "string") {
      assert.doesNotMatch(
        child,
        /\$\{\{[^}]*\b(?:inputs\b|github\.event[.[]|github\.head_ref\b|steps\b|needs\b)/,
        `${location}.${key} must receive untrusted expressions through env`,
      );
    } else {
      checkScripts(child, `${location}.${key}`);
    }
  }
}

test("workflows and composite actions keep untrusted expressions out of scripts", () => {
  for (const entry of readdirSync(".github", { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = join(entry.parentPath, entry.name);
    checkScripts(YAML.parse(readFileSync(file, "utf8")), file);
  }
});

test("comment dispatch validates identifiers before invoking the router", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/repair-comment-router.yml", "utf8"));
  const step = workflow.jobs["route-comments"].steps.find(
    (entry: { id?: string }) => entry.id === "route-comments",
  );
  const root = mkdtempSync(join(tmpdir(), "comment-router-shape-"));
  const sentinel = join(root, "pwned");
  const normal = { target_repo: "openclaw/openclaw", item_number: "42", comment_id: "7" };
  const run = (payload: Record<string, string>, name: string) => {
    const args = join(root, `${name}.args`);
    const env: Record<string, string> = {
      PATH: process.env.PATH!,
      ARG_FILE: args,
      GITHUB_ACTOR: "fixture",
      GITHUB_RUN_ID: "123",
    };
    for (const [key, expression] of Object.entries(step.env)) {
      if (!/^(INPUT|DISPATCH|VARS_|EVENT_NAME)/.test(key)) continue;
      const value = new Function(
        "github",
        "inputs",
        "vars",
        `return (${String(expression).slice(3, -2)});`,
      )({ event_name: "repository_dispatch", event: { client_payload: payload } }, {}, {});
      env[key] = value === undefined || value === null ? "" : String(value);
    }
    const result = spawnSync(
      "bash",
      ["-c", `pnpm() { printf '%s\\0' "$@" > "$ARG_FILE"; }\n${step.run}`],
      {
        env,
        encoding: "utf8",
      },
    );
    return { result, args };
  };
  try {
    const valid = run(
      { ...normal, target_branch: "fix/a_b-1.2", status_comment_id: "09" },
      "valid",
    );
    assert.equal(valid.result.status, 0, valid.result.stderr);
    const argv = readFileSync(valid.args, "utf8").split("\0");
    assert.ok(argv.includes("fix/a_b-1.2"));
    assert.ok(argv.includes("09"));
    assert.ok(argv.includes("--execute"));
    for (const [field, value] of [
      ["target_repo", `openclaw/x$(touch ${sentinel})`],
      ["target_branch", `fix/$(touch ${sentinel})`],
      ["item_number", "1;id"],
      ["comment_id", "7\n8"],
      ["status_comment_id", "9,10"],
    ]) {
      const invalid = run({ ...normal, [field]: value }, field);
      assert.equal(invalid.result.status, 1, field);
      assert.match(invalid.result.stdout, /::error::Invalid/);
      assert.equal(existsSync(invalid.args), false, field);
      assert.equal(existsSync(sentinel), false, field);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activity notifications reject workflow runs from another repository", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/github-activity.yml", "utf8"));
  assert.equal(workflow.permissions.contents, "read");
  const evaluate = new Function(
    "github",
    "contains",
    "fromJSON",
    `return (${workflow.jobs.notify.if.slice(3, -2)});`,
  );
  for (const [eventName, repo, conclusion, runEvent, expected] of [
    ["workflow_run", "openclaw/clawsweeper", "failure", "schedule", true],
    ["workflow_run", "openclaw/clawsweeper", "failure", "repository_dispatch", true],
    ["workflow_run", "someone/fork", "failure", "schedule", false],
    ["workflow_run", "openclaw/clawsweeper", "success", "schedule", false],
    // pull_request_target runs report the base repository as head_repository.
    ["workflow_run", "openclaw/clawsweeper", "failure", "pull_request_target", false],
    ["issues", "someone/fork", "failure", "schedule", true],
  ]) {
    assert.equal(
      evaluate(
        {
          repository: "openclaw/clawsweeper",
          event_name: eventName,
          event: {
            action: "opened",
            workflow_run: { head_repository: { full_name: repo }, conclusion, event: runEvent },
          },
        },
        (values: string[], value: string) => values.includes(value),
        JSON.parse,
      ),
      expected,
    );
  }
});
