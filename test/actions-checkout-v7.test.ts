import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

interface CheckoutStep {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowDocument {
  jobs?: Record<string, { steps?: CheckoutStep[] }>;
}

function yamlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/.test(entry.name) ? [path] : [];
  });
}

const actionFiles = yamlFiles(".github");
const checkoutReferences = actionFiles.flatMap((path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes("actions/checkout@"))
    .map((line) => ({
      path,
      reference: line
        .trim()
        .replace(/^-?\s*uses:\s*/, "")
        .replace(/\s+#.*$/, ""),
    })),
);
const checkoutV7Commit = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

test("every checkout uses v7 without disabling its fork-PR guard", () => {
  assert.ok(checkoutReferences.length > 0, "expected checkout action references");
  for (const { path, reference } of checkoutReferences) {
    assert.ok(
      reference === "actions/checkout@v7" || reference === `actions/checkout@${checkoutV7Commit}`,
      `${path}: ${reference}`,
    );
  }

  const sources = actionFiles.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(sources, /allow-unsafe-pr-checkout:\s*true/);
});

test("production crawl-remote checkout is pinned to the audited v7 commit", () => {
  const workflow = parse(
    readFileSync(".github/workflows/deploy-crawl-remote.yml", "utf8"),
  ) as WorkflowDocument;
  const preflightCheckout = workflow.jobs?.preflight?.steps?.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  const deployCheckout = workflow.jobs?.deploy?.steps?.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(preflightCheckout?.uses, `actions/checkout@${checkoutV7Commit}`);
  assert.equal(preflightCheckout?.with?.repository, "openclaw/crawl-remote");
  assert.equal(deployCheckout?.uses, `actions/checkout@${checkoutV7Commit}`);
  assert.equal(deployCheckout?.with?.repository, "openclaw/clawsweeper");
  assert.equal(deployCheckout?.with?.ref, "${{ github.sha }}");
  assert.equal(deployCheckout?.with?.["sparse-checkout"], ".github/deploy/crawl-remote-toolchain");
  assert.equal(deployCheckout?.with?.["persist-credentials"], false);
});

test("trusted-event workflows explicitly checkout the default branch", () => {
  for (const path of [
    ".github/workflows/dashboard-ci.yml",
    ".github/workflows/repair-publish-results.yml",
  ]) {
    const workflow = parse(readFileSync(path, "utf8")) as WorkflowDocument;
    const checkoutSteps = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses === "actions/checkout@v7");
    assert.equal(checkoutSteps.length, 1, path);
    assert.equal(
      checkoutSteps[0]?.with?.ref,
      "${{ github.event.repository.default_branch }}",
      path,
    );
  }

  const activityPath = ".github/workflows/github-activity.yml";
  const activity = parse(readFileSync(activityPath, "utf8")) as WorkflowDocument;
  const activityCheckouts = Object.values(activity.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses === "actions/checkout@v7");
  assert.equal(activityCheckouts.length, 2, activityPath);
  for (const checkout of activityCheckouts) {
    assert.equal(checkout.with?.ref, "${{ github.event.repository.default_branch }}");
  }
});

test("GitHub activity replay builds trusted code before downloading receipts", () => {
  const workflow = parse(
    readFileSync(".github/workflows/github-activity.yml", "utf8"),
  ) as WorkflowDocument;
  const steps = workflow.jobs?.["replay-dispatch-receipts"]?.steps ?? [];
  const checkoutIndex = steps.findIndex((step) => step.uses === "actions/checkout@v7");
  const setupIndex = steps.findIndex((step) => step.uses === "./.github/actions/setup-pnpm");
  const selectIndex = steps.findIndex((step) => step.id === "select-activity-dispatch-ledger");
  const downloadIndex = steps.findIndex((step) => step.uses === "actions/download-artifact@v8");

  assert.ok(checkoutIndex >= 0, "replay job must checkout trusted source");
  assert.ok(setupIndex > checkoutIndex, "replay job must setup after trusted checkout");
  assert.equal(steps[setupIndex]?.with?.["build-script"], "build:repair");
  assert.ok(selectIndex > setupIndex, "replay job must select receipts after the trusted build");
  assert.ok(downloadIndex > selectIndex, "replay job must select receipts before downloading");
});

test("GitHub activity rerun attempt two replays attempt one without redispatch", () => {
  const workflowPath = ".github/workflows/github-activity.yml";
  const workflowSource = readFileSync(workflowPath, "utf8");
  const workflow = parse(workflowSource) as WorkflowDocument;
  const steps = workflow.jobs?.["replay-dispatch-receipts"]?.steps ?? [];
  const selector = steps.find((step) => step.id === "select-activity-dispatch-ledger");
  const download = steps.find((step) => step.id === "download-activity-dispatch-ledger");
  assert.ok(selector?.run, "replay job must select an artifact from the stable workflow run");

  const runId = "991234";
  const artifact = (attempt: number, id: number, expired = false) => ({
    expired,
    id,
    name: `github-activity-dispatch-receipts-${runId}-${attempt}`,
  });
  assert.deepEqual(
    runReplayArtifactSelection(selector.run, runId, 2, [
      artifact(1, 101),
      artifact(2, 102, true),
      artifact(3, 103),
      { expired: false, id: 104, name: `unrelated-${runId}-2` },
    ]),
    {
      artifact_id: "101",
      artifact_name: `github-activity-dispatch-receipts-${runId}-1`,
      producer_attempt: "1",
    },
  );
  assert.equal(
    runReplayArtifactSelection(selector.run, runId, 2, [artifact(1, 101), artifact(2, 102)])
      .artifact_id,
    "102",
    "a rerun that uploaded a current-attempt bundle must prefer it",
  );
  assert.equal(
    runReplayArtifactSelection(selector.run, runId, 4, [artifact(1, 101), artifact(3, 103)])
      .artifact_id,
    "103",
    "multiple replay-only reruns must select the latest prior producer attempt",
  );

  assert.match(selector.run, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/artifacts/);
  assert.doesNotMatch(selector.run, /GITHUB_RUN_ATTEMPT\s*-\s*1/);
  assert.equal(
    download?.with?.["artifact-ids"],
    "${{ steps.select-activity-dispatch-ledger.outputs.artifact_id }}",
  );
  assert.equal(download?.with?.["github-token"], "${{ github.token }}");
  assert.equal(download?.with?.["run-id"], "${{ github.run_id }}");
  const replay = workflowSource.slice(workflowSource.indexOf("replay-dispatch-receipts:"));
  assert.doesNotMatch(replay, /repair:spam-comment-intake|Dispatch spam scan candidate/);
});

test("trusted-event state checkout remains pinned to the state repository branch", () => {
  const action = parse(readFileSync(".github/actions/setup-state/action.yml", "utf8")) as {
    runs?: { steps?: CheckoutStep[] };
  };
  const checkout = action.runs?.steps?.find((step) => step.uses === "actions/checkout@v7");
  assert.equal(checkout?.with?.repository, "openclaw/clawsweeper-state");
  assert.equal(checkout?.with?.ref, "state");
});

function runReplayArtifactSelection(
  script: string,
  runId: string,
  runAttempt: number,
  artifacts: unknown[],
): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-replay-artifact-"));
  try {
    const bin = join(root, "bin");
    const output = join(root, "github-output");
    mkdirSync(bin);
    const gh = join(bin, "gh");
    writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' \"$GH_ARTIFACT_RESPONSE\"\n");
    chmodSync(gh, 0o755);
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_RUN_ATTEMPT: String(runAttempt),
        GITHUB_RUN_ID: runId,
        GH_ARTIFACT_RESPONSE: JSON.stringify([{ artifacts }]),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          assert.ok(separator > 0, `invalid workflow output: ${line}`);
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
