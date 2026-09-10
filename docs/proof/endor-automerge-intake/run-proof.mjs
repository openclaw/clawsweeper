import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

// Exercise the shipped CLI and its subprocess transport. Only GitHub is substituted;
// the fixture persists label events across separate CLI invocations.
const repo = "openclaw/openclaw";
const label = "clawsweeper:automerge";
if (process.argv[2] === "--github-fixture") {
  serveGitHub();
} else {
  proveIntake();
}

function serveGitHub() {
  const args = process.argv.slice(3);
  const statePath = process.env.ENDOR_PROOF_STATE;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const endpoint = args[1];
  state.requests.push(args);
  let response;
  if (endpoint === `repos/${repo}`) {
    response = {
      full_name: repo,
      private: false,
      archived: false,
      disabled: false,
      has_issues: true,
      default_branch: "main",
    };
  } else if (
    endpoint === `repos/${repo}/issues?creator=endor-labs-pro%5Bbot%5D&state=open&per_page=100`
  ) {
    assert.deepEqual(args.slice(2), ["--paginate", "--slurp"]);
    response = [Object.values(state.pulls).map((pull) => ({ ...pull, pull_request: {} }))];
  } else {
    const match = endpoint.match(/^repos\/openclaw\/openclaw\/(issues|pulls)\/(\d+)(.*)$/);
    assert.ok(match, `Unexpected endpoint: ${endpoint}`);
    const [, kind, number, suffix] = match;
    const pull = state.pulls[number];
    assert.ok(pull);
    if (kind === "pulls" && suffix === "") {
      response = pull;
    } else if (kind === "issues" && suffix === "/events?per_page=100") {
      assert.deepEqual(args.slice(2), ["--paginate", "--slurp"]);
      response = [[], state.events[number] ?? []];
    } else {
      assert.deepEqual(args, [
        "api",
        `repos/${repo}/issues/${number}/labels`,
        "--method",
        "POST",
        "-f",
        `labels[]=${label}`,
      ]);
      pull.labels.push({ name: label });
      state.events[number] = [
        ...(state.events[number] ?? []),
        { event: "labeled", label: { name: label } },
      ];
      state.writes.push({ number: Number(number), label });
      response = pull.labels;
    }
  }
  writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify(response));
}

function proveIntake() {
  const root = resolve(import.meta.dirname, "../../..");
  const scratch = mkdtempSync(join(tmpdir(), "endor-intake-proof-"));
  const statePath = join(scratch, "github.json");
  const template = {
    user: { login: "endor-labs-pro[bot]", id: 179191674, type: "Bot" },
    state: "open",
    draft: false,
    locked: false,
    labels: [],
    base: { ref: "main", repo: { full_name: repo } },
    head: {
      ref: "endorlabs-e071/npm_and_yarn/dot-/fast-xml-parser-5.3.5",
      repo: { full_name: repo },
    },
  };
  const state = {
    pulls: {
      42: { ...template, number: 42 },
      43: { ...template, number: 43, user: { login: "human", id: 42, type: "User" } },
      44: { ...template, number: 44, labels: [{ name: "clawsweeper:human-review" }] },
      45: { ...template, number: 45 },
    },
    events: { 45: [{ event: "unlabeled", label: { name: label } }] },
    requests: [],
    writes: [],
  };
  writeFileSync(statePath, JSON.stringify(state));
  const workflow = parse(
    readFileSync(join(root, ".github/workflows/repair-comment-router.yml"), "utf8"),
  );
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((entry) => entry.name === "Enrol Endor remediation PRs");
  assert.ok(step);
  assert.equal(
    step.if,
    "${{ github.event_name == 'schedule' && vars.CLAWSWEEPER_COMMENT_ROUTER_EXECUTE == '1' && steps.target.outputs.target_repo == 'openclaw/openclaw' }}",
  );
  assert.equal(step["continue-on-error"], true);
  const env = {
    PATH: process.env.PATH,
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([join(import.meta.dirname, "run-proof.mjs"), "--github-fixture"]),
    GH_TOKEN: "isolated-fixture-not-a-token",
    ENDOR_PROOF_STATE: statePath,
    TARGET_REPO: repo,
  };
  const cli = join(root, "dist/repair/endor-automerge-intake.js");
  const preview = JSON.parse(
    execFileSync(process.execPath, [cli, "--repo", repo], { cwd: root, env, encoding: "utf8" }),
  );
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).writes.length, 0);
  // Execute the workflow's actual run command, not a separately maintained copy.
  const first = JSON.parse(
    execFileSync("bash", ["-euo", "pipefail", "-c", step.run], {
      cwd: root,
      env,
      encoding: "utf8",
    }),
  );
  const after = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(after.writes, [{ number: 42, label }]);
  after.pulls[42].labels = [];
  after.events[42].push({ event: "unlabeled", label: { name: label } });
  writeFileSync(statePath, JSON.stringify(after));
  const repeat = JSON.parse(
    execFileSync("bash", ["-euo", "pipefail", "-c", step.run], {
      cwd: root,
      env,
      encoding: "utf8",
    }),
  );
  const final = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(final.writes, [{ number: 42, label }]);
  const report = {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    command: step.run,
    before:
      "No automatic enrolment step exists on the base revision; eligible Endor PRs require manual opt-in.",
    preview,
    first,
    repeat,
    writes: final.writes,
    limits:
      "Controlled GitHub fixture via the real CLI/subprocess boundary; no live labels, review dispatches or merges. GitHub evaluates the schedule condition in production; here its contract is checked and its run command executed.",
  };
  const output = join(root, ".artifacts/endor-automerge/behavior.json");
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
