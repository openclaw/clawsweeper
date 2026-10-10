import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

import { createGitHubExecution } from "../../dist/clawsweeper-github-execution.js";
import * as gitHubRuntime from "../../dist/clawsweeper-github-runtime.js";
import { repositoryProfileFor, withTargetProfile } from "../../dist/repository-profiles.js";
import { githubTest, installGhFixture } from "../github-runtime-fixture.ts";
import { runCopyProof } from "../../scripts/e2e/exact-review-selected-tuple-copy.mjs";
import { MAX_MEDIA_PROOF_TIMEOUT_MS } from "../../dist/media-proof-budget.js";

const { gh, ghOnce, ghWithPreparedTimeout, withGitHubRun } = gitHubRuntime;
const { ghObservedMutationCommand, ghWithRetry } = createGitHubExecution({
  ROOT: process.cwd(),
  gitHubRuntime,
});

const path = ".github/workflows/exact-review-batch-publish.yml";
const source = readFileSync(path, "utf8");
const sweep = YAML.parse(readFileSync(".github/workflows/sweep.yml", "utf8"));
const workflow = YAML.parse(source) as {
  on: {
    schedule?: unknown;
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if: string;
      env: Record<string, string>;
      steps: Array<{ name?: string; if?: string; run?: string; uses?: string }>;
    }
  >;
};

// Runs the claimed-payload step as the workflow does: from the checkout root,
// before the build, with the runner Node.
function resolveEventPayload(decision: Record<string, unknown>, configuredTimeoutMs: number) {
  const run = sweep.jobs["event-review-apply"].steps.find(
    (step: { id?: string }) => step.id === "target",
  ).run;
  const root = mkdtempSync(join(tmpdir(), "resolve-event-payload-"));
  try {
    const output = join(root, "output");
    execFileSync("bash", ["-c", run], {
      env: {
        PATH: process.env.PATH,
        CLAIM_DECISION: JSON.stringify({
          targetRepo: "openclaw/openclaw",
          itemNumber: 71,
          ...decision,
        }),
        CONFIGURED_CODEX_TIMEOUT_MS: String(configuredTimeoutMs),
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
      },
    });
    return readFileSync(output, "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("manual review timeouts survive queue resolution within the existing exact-review cap", () => {
  for (const [sourceAction, codexTimeoutMs, configuredTimeoutMs, expected] of [
    ["manual_explicit_review", 300_000, 1_200_000, 300_000],
    ["manual_explicit_review", 2_400_000, 1_200_000, 2_400_000],
    ["manual_explicit_review", 3_600_000, 1_200_000, 2_700_000],
    ["opened", 2_400_000, 1_200_000, 1_800_000],
    ["opened", 2_400_000, 3_600_000, 2_700_000],
    ["opened", -1, -1, 1_200_000],
  ] as const) {
    const output = resolveEventPayload(
      {
        sourceAction,
        codexTimeoutMs,
        publicationPolicy:
          sourceAction === "manual_explicit_review" ? "record_comment_only" : undefined,
      },
      configuredTimeoutMs,
    );
    assert.match(output, new RegExp(`^codex_timeout_ms=${expected}$`, "m"));
  }
});

test("claimed media allowance and review reserve come from the media proof budget", () => {
  for (const [mediaProofTimeoutMs, expected] of [
    [MAX_MEDIA_PROOF_TIMEOUT_MS * 10, MAX_MEDIA_PROOF_TIMEOUT_MS],
    [1_000, 1_000],
    [-1, 0],
  ]) {
    const output = resolveEventPayload({ mediaProofTimeoutMs }, 1_200_000);
    assert.match(output, new RegExp(`^media_proof_timeout_ms=${expected}$`, "m"));
    assert.match(
      output,
      new RegExp(`^media_preprocessing_reserve_seconds=${MAX_MEDIA_PROOF_TIMEOUT_MS / 1000}$`, "m"),
    );
  }
});

test("manual publication proof driver parses as a complete executable module", () => {
  const result = spawnSync(
    process.execPath,
    ["--check", "scripts/e2e/manual-review-publication.mjs"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test(
  "manual admission proof workspace executes its real CLI entry point",
  { skip: process.platform === "win32" },
  () => {
    const driver = readFileSync("scripts/e2e/manual-review-publication.mjs", "utf8");
    const start = driver.indexOf("  const admissionWork = ");
    const end = driver.indexOf("  const admissionEnv = ", start);
    assert.ok(start >= 0 && end > start);
    const root = mkdtempSync(join(tmpdir(), "manual-admission-workspace-"));
    try {
      const work = runInNewContext(`${driver.slice(start, end)}\nadmissionWork`, {
        root,
        source: process.cwd(),
        join,
        mkdirSync,
        cpSync,
        symlinkSync,
      });
      const result = spawnSync(process.execPath, ["dist/repair/manual-review-enqueue.js"], {
        cwd: work,
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--target-repo is required/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("manual publication proof preserves isolated toolchain settings without inherited credentials", () => {
  const driver = readFileSync("scripts/e2e/manual-review-publication.mjs", "utf8");
  const start = driver.indexOf("  runtimeEnv = {");
  const end = driver.indexOf("\n  };", start);
  assert.ok(start >= 0 && end > start);
  const toolchain = {
    PATH: "/installed/bin",
    HOME: "/isolated-home",
    XDG_CONFIG_HOME: "/isolated-home/.config",
    XDG_CACHE_HOME: "/isolated-home/.cache",
    OPENAI_API_KEY: "must-not-forward",
    GITHUB_TOKEN: "must-not-forward",
  };
  const env = runInNewContext(`${driver.slice(start, end + 5)}\nruntimeEnv`, {
    process: { env: toolchain },
    bin: "/fixture/bin",
    root: "/fixture/state",
    transport: "/fixture/transport.mjs",
    baseUrl: "http://127.0.0.1:1",
    secret: "synthetic-coordinator-secret",
    producerRepo: "example/source",
    base: "a".repeat(40),
    join,
  });
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"] as const)
    assert.equal(env[name], toolchain[name]);
  assert.equal(env.CI, "true");
  assert.equal(Object.hasOwn(env, "OPENAI_API_KEY"), false);
  assert.equal(Object.hasOwn(env, "GITHUB_TOKEN"), false);
});

test("manual publication stays queue-owned and excludes router and implementation hooks", () => {
  const admission = sweep.jobs.plan.steps.find(
    (step: { name?: string }) => step.name === "Admit explicit manual reviews",
  );
  assert.equal(admission.if, "${{ steps.mode.outputs.manual_explicit == 'true' }}");
  assert.match(admission.run, /manual-review-enqueue\.js/);
  assert.match(source, /publication_policy.*record_comment_only.*failed_review_shard_recovery/);
  assert.match(source, /AUTO_IMPLEMENT_ISSUES.*\n\s*\[ -z "\$publication_policy" \]/);
});

for (const targetBranch of ["release/proof", ""]) {
  test(
    `manual admission preserves branch selection ${targetBranch || "(default lookup)"}`,
    { skip: process.platform === "win32" },
    () => {
      const admission = sweep.jobs.plan.steps.find(
        (step: { name?: string }) => step.name === "Admit explicit manual reviews",
      );
      const root = mkdtempSync(join(tmpdir(), "manual-admission-branch-"));
      try {
        mkdirSync(join(root, ".artifacts"));
        const result = spawnSync(
          "bash",
          [
            "-c",
            `gh() { printf 'lookup\\n' >> "$LOOKUPS"; printf 'trunk\\n'; }
node() { printf '%s\\0' "$@" > "$ARGUMENTS"; }
${admission.run}`,
          ],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              TARGET_REPO: "example/repo",
              TARGET_BRANCH: targetBranch,
              CODEX_TIMEOUT_MS: "2400000",
              ADDITIONAL_PROMPT: "Preserve selected instructions.",
              ITEM_NUMBER: "71",
              ITEM_NUMBERS: "72",
              GITHUB_RUN_ID: "1000",
              QUEUE_URL: "https://queue.invalid",
              LOOKUPS: join(root, "lookups"),
              ARGUMENTS: join(root, "arguments"),
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        assert.equal(result.status, 0, result.stderr);
        const args = readFileSync(join(root, "arguments"), "utf8").split("\0");
        assert.equal(args[args.indexOf("--target-branch") + 1], targetBranch || "trunk");
        assert.equal(existsSync(join(root, "lookups")), !targetBranch);
        assert.equal(admission.env.TARGET_BRANCH, "${{ steps.target.outputs.target_branch }}");
        assert.equal(admission.env.CODEX_TIMEOUT_MS, "${{ steps.mode.outputs.codex_timeout_ms }}");
        assert.equal(
          admission.env.ADDITIONAL_PROMPT,
          "${{ github.event.inputs.additional_prompt || '' }}",
        );
        assert.equal(args[args.indexOf("--codex-timeout-ms") + 1], "2400000");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test("terminal batch lifecycle payload carries a stable run-attempt-fence operation id", () => {
  const builder = source.match(
    /export LIFECYCLE_TERMINAL="\$lifecycle_terminal"\s+lifecycle_payload="\$\(node -e '([\s\S]*?)'\)"/,
  )?.[1];
  assert.ok(builder);
  const env = {
    TARGET_REPO: "openclaw/openclaw",
    ITEM_NUMBER: "706",
    REVISION: "1",
    FENCE_KEY: "synthetic-lifecycle-fence",
    LIFECYCLE_TERMINAL: "policy_noop",
    GITHUB_RUN_ID: "706",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const run = (overrides = {}) => {
    const result = spawnSync(process.execPath, ["-e", builder], {
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = run();
  assert.deepEqual(first, run());
  assert.equal(
    first.operation_id,
    `terminal-batch:706:2:${createHash("sha256").update(env.FENCE_KEY).digest("hex").slice(0, 24)}`,
  );
  assert.notEqual(first.operation_id, run({ GITHUB_RUN_ATTEMPT: "3" }).operation_id);
  assert.notEqual(first.operation_id, run({ FENCE_KEY: "another-fence" }).operation_id);
});

test("batch publisher is event-driven and queue-bounded instead of workflow-serialized", () => {
  assert.equal(workflow.on.schedule, undefined);
  assert.ok(workflow.on.workflow_dispatch);
  assert.match(workflow.jobs.publish!.if, /inputs\.execute/);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    "execute",
    "dispatch_id",
    "dispatched_at",
  ]);
  assert.equal(workflow.jobs.publish!.env.EXACT_REVIEW_BATCH_MAX_ITEMS, "50");
  assert.equal(workflow.jobs.publish!.env.EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY, "2");
  assert.equal(workflow.jobs.publish!.env.CLAWSWEEPER_APP_CLIENT_ID, "Iv23liOECG0slfuhz093");
  assert.equal(workflow.concurrency, undefined);
  assert.deepEqual(workflow.permissions, { actions: "write", contents: "read" });
});

githubTest("transient retries stay bounded while GitHub throttles defer immediately", async (t) => {
  const previous = process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
    else process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS = previous;
  });
  for (const scenario of ["default", "bounded", "throttle-403", "throttle-429", "explicit"]) {
    await t.test(scenario, (t) =>
      withGitHubRun(() => {
        if (scenario === "default") delete process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
        else process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS = "2";
        const failures = scenario === "bounded" ? 3 : 2;
        const fixture = installGhFixture(
          t,
          `
state.calls = (state.calls || 0) + 1;
if (state.calls <= ${failures}) {
  console.error(${JSON.stringify(
    scenario === "throttle-403"
      ? "API rate limit exceeded for installation ID 122230863 (HTTP 403)"
      : scenario === "throttle-429"
        ? "HTTP 429: Too Many Requests"
        : "HTTP 502: transient upstream failure",
  )});
  process.exitCode = 1;
} else process.stdout.write("ok");
`,
        );
        const waits: number[] = [];
        const run = () =>
          ghWithRetry(["api", "repos/test/item"], scenario === "explicit" ? 3 : undefined, {
            sleepBeforeRetry: (ms) => waits.push(ms),
          });
        if (scenario.startsWith("throttle")) {
          assert.throws(run, /API rate limit exceeded|HTTP 429/);
          assert.equal(fixture.requests().length, 1);
          assert.deepEqual(waits, []);
          assert.throws(
            () =>
              ghObservedMutationCommand({
                args: ["api", "repos/test/item"],
                identity: "batch-publication",
                sleepBeforeRetry: (ms) => waits.push(ms),
              }),
            /API rate limit exceeded|HTTP 429/,
          );
          assert.equal(fixture.requests().length, 2);
          assert.deepEqual(waits, []);
        } else if (scenario === "bounded") {
          assert.throws(run, /HTTP 502/);
          assert.equal(fixture.requests().length, 2);
          assert.deepEqual(waits, [2_000]);
        } else {
          assert.equal(run(), "ok");
          assert.equal(fixture.requests().length, 3);
          assert.deepEqual(waits, [2_000, 4_000]);
        }
      }),
    );
  }
});

githubTest("sweep runtime routes only public target REST reads onto the public token", (t) => {
  const fixtureEnv = {
    EXACT_EVENT_PUBLICATION: "true",
    GH_TOKEN: "target-app-token",
    REPO_TOKEN: "workflow-repository-token",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "public-read-token",
  };
  const previous = Object.fromEntries(
    [...Object.keys(fixtureEnv), "GH_HOST"].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, fixtureEnv);
  delete process.env.GH_HOST;

  const fixture = installGhFixture(t, `process.stdout.write(JSON.stringify({ token, args }));`);
  const observed = (
    args: string[],
    timeoutMs: number | undefined = 5_000,
    env: NodeJS.ProcessEnv = {},
  ) =>
    JSON.parse(ghWithPreparedTimeout(args, timeoutMs, env)) as {
      token: string;
      args: string[];
    };

  try {
    for (const args of [
      ["api", "repos/openclaw/openclaw/issues/123"],
      ["api", "-i", "repos/openclaw/openclaw/issues/123/timeline?per_page=100"],
      ["api", "repos/openclaw/openclaw/issues/123/comments?per_page=100", "--paginate", "--slurp"],
      ["api", "repos/openclaw/openclaw/pulls/123/reviews?per_page=100", "--paginate", "--slurp"],
      ["api", "repos/openclaw/openclaw/pulls/123", "--jq", ".requested_reviewers"],
    ]) {
      assert.equal(observed(args).token, "public-read-token", args.join(" "));
    }

    const publicArgs = ["api", "repos/openclaw/openclaw/issues/comments/123"];
    assert.deepEqual(observed(publicArgs, 1234).args, publicArgs);
    assert.equal(JSON.parse(gh(publicArgs)).token, "public-read-token");
    assert.equal(JSON.parse(ghOnce(publicArgs, 10_000)).token, "public-read-token");

    const privateRequests = [
      ["api", "user"],
      ["api", "repos/openclaw/openclaw/collaborators/person/permission"],
      ["api", "repos/openclaw/private/issues/123"],
      ["api", "repos/openclaw/clawsweeper/issues/123"],
      ["api", "repos/openclaw/openclaw/issues/../../clawsweeper/issues/123"],
      ["api", "repos/openclaw/openclaw/issues/%2e%2e/clawsweeper"],
      ["api", "repos/openclaw/openclaw/issues/123", "--method", "PATCH"],
      ["api", "repos/openclaw/openclaw/issues/123", "--method=DELETE"],
      ["api", "repos/openclaw/openclaw/issues/123", "-f", "body=mutated"],
      ["api", "repos/openclaw/openclaw/issues/123", "--input", "payload.json"],
      ["api", "repos/openclaw/openclaw/issues/123", "--hostname", "example.invalid"],
      ["api", "-i", "repos/openclaw/openclaw/issues/123", "--method", "PATCH"],
      ["pr", "view", "123"],
    ];
    for (const args of privateRequests) {
      assert.equal(observed(args).token, "target-app-token", args.join(" "));
    }
    assert.equal(JSON.parse(ghOnce(privateRequests[6]!, 10_000)).token, "target-app-token");
    assert.equal(
      observed(publicArgs, 5_000, { GH_TOKEN: "explicit-token" }).token,
      "explicit-token",
    );
    assert.equal(
      observed(publicArgs, 5_000, { GITHUB_TOKEN: "explicit-github-token" }).token,
      "target-app-token",
    );

    assert.equal(
      JSON.parse(
        ghObservedMutationCommand({
          args: ["api", "repos/openclaw/openclaw/issues/123", "--method", "PATCH"],
          identity: "exact-publication-target-mutation",
        }),
      ).token,
      "target-app-token",
    );

    process.env.EXACT_EVENT_PUBLICATION = "false";
    process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN = "   ";
    assert.equal(observed(publicArgs).token, "target-app-token");
    delete process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN;
    assert.equal(observed(publicArgs).token, "target-app-token");

    process.env.EXACT_EVENT_PUBLICATION = "true";
    assert.equal(observed(publicArgs).token, "workflow-repository-token");

    process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN = "public-read-token";

    withTargetProfile(repositoryProfileFor("openclaw/private"), () => {
      assert.equal(observed(publicArgs).token, "public-read-token");
    });

    process.env.GH_HOST = "enterprise.example.invalid";
    assert.equal(observed(publicArgs).token, "target-app-token");
    delete process.env.GH_HOST;

    delete process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN;
    delete process.env.REPO_TOKEN;
    assert.equal(observed(publicArgs).token, "target-app-token");
    assert.ok(fixture.requests().length > privateRequests.length);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

githubTest("sweep public read throttles fall back once to the ambient App token", (t) => {
  const fixtureEnv = {
    GH_TOKEN: "sweep-fallback-app-token",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "sweep-fallback-public-token",
  };
  const previous = Object.fromEntries(
    Object.keys(fixtureEnv).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, fixtureEnv);

  const fixture = installGhFixture(
    t,
    `
if (token === ${JSON.stringify(fixtureEnv.CLAWSWEEPER_PUBLIC_GH_TOKEN)}) {
  console.error("gh: API rate limit exceeded for installation (HTTP 403)");
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify({ token }));
`,
  );
  try {
    const args = ["api", "repos/openclaw/openclaw/issues/123"];
    assert.equal(JSON.parse(ghWithRetry(args)).token, fixtureEnv.GH_TOKEN);
    assert.deepEqual(
      fixture.requests().map(({ token }) => token),
      [fixtureEnv.CLAWSWEEPER_PUBLIC_GH_TOKEN, fixtureEnv.GH_TOKEN],
    );

    assert.throws(() => ghWithRetry(args), { name: "GitHubRateLimitError" });
    assert.deepEqual(
      fixture.requests().map(({ token }) => token),
      [
        fixtureEnv.CLAWSWEEPER_PUBLIC_GH_TOKEN,
        fixtureEnv.GH_TOKEN,
        fixtureEnv.CLAWSWEEPER_PUBLIC_GH_TOKEN,
      ],
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

githubTest("exact publication records the Actions reset before one bounded App fallback", (t) => {
  const observationPath = join(
    tmpdir(),
    `clawsweeper-rate-limit-${process.pid}-${Date.now()}.jsonl`,
  );
  const fixtureEnv = {
    EXACT_EVENT_PUBLICATION: "true",
    GH_TOKEN: "exact-fallback-app-token",
    REPO_TOKEN: "exact-actions-token",
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observationPath,
  };
  const previous = Object.fromEntries(
    Object.keys(fixtureEnv).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, fixtureEnv);
  const reset = Math.floor(Date.now() / 1_000) + 600;
  const fixture = installGhFixture(
    t,
    `
if (args[0] === "api" && args[1] === "rate_limit") {
  process.stdout.write(JSON.stringify({ remaining: 0, reset: ${reset} }));
} else if (token === ${JSON.stringify(fixtureEnv.REPO_TOKEN)}) {
  console.error("gh: API rate limit exceeded for repository token (HTTP 403)");
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify({ token }));
`,
  );
  try {
    const result = JSON.parse(ghWithRetry(["api", "repos/openclaw/openclaw/issues/123"]));
    assert.equal(result.token, fixtureEnv.GH_TOKEN);
    assert.deepEqual(
      fixture.requests().map(({ token }) => token),
      [fixtureEnv.REPO_TOKEN, fixtureEnv.REPO_TOKEN, fixtureEnv.GH_TOKEN],
    );
    const observations = readFileSync(observationPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(observations[0].provenance, "fallback");
    assert.equal(observations[0].authoritative, false);
    assert.deepEqual(observations.slice(1), [
      {
        scope: "repository_actions",
        observed_at: observations[1].observed_at,
        retry_at: new Date(reset * 1_000).toISOString(),
        provenance: "rate_limit_status",
        authoritative: true,
      },
    ]);
  } finally {
    rmSync(observationPath, { force: true });
    rmSync(`${observationPath}.lookup-repository_actions.lock`, { force: true });
    rmSync(`${observationPath}.fallback-target_app.lock`, { force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

githubTest("inherited GitHub Actions credentials open the repository quota circuit", (t) => {
  const observationPath = join(
    tmpdir(),
    `clawsweeper-inherited-actions-rate-limit-${process.pid}-${Date.now()}.jsonl`,
  );
  const fixtureEnv = {
    GITHUB_TOKEN: "inherited-actions-token",
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observationPath,
  };
  const clearedKeys = ["GH_TOKEN", "REPO_TOKEN", "CLAWSWEEPER_PUBLIC_GH_TOKEN"];
  const previous = Object.fromEntries(
    [...Object.keys(fixtureEnv), ...clearedKeys].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, fixtureEnv);
  for (const key of clearedKeys) delete process.env[key];
  const reset = Math.floor(Date.now() / 1_000) + 300;
  const fixture = installGhFixture(
    t,
    `
if (args[0] === "api" && args[1] === "rate_limit") {
  process.stdout.write(JSON.stringify({ remaining: 0, reset: ${reset} }));
} else {
  console.error("gh: API rate limit exceeded for GITHUB_TOKEN (HTTP 403)");
  process.exitCode = 1;
}
`,
  );
  try {
    assert.throws(() => ghWithRetry(["api", "repos/openclaw/openclaw/issues/123/comments"]), {
      name: "GitHubRateLimitError",
    });
    assert.deepEqual(
      fixture.requests().map(({ token }) => token),
      [fixtureEnv.GITHUB_TOKEN, fixtureEnv.GITHUB_TOKEN],
    );
    const observations = readFileSync(observationPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(observations[0].provenance, "fallback");
    assert.equal(observations[0].authoritative, false);
    assert.deepEqual(observations.slice(1), [
      {
        scope: "repository_actions",
        observed_at: observations[1].observed_at,
        retry_at: new Date(reset * 1_000).toISOString(),
        provenance: "rate_limit_status",
        authoritative: true,
      },
    ]);
  } finally {
    rmSync(observationPath, { force: true });
    rmSync(`${observationPath}.lookup-repository_actions.lock`, { force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("batch workflow signs queue ownership, isolates item failures, and commits once", () => {
  assert.match(source, /repair:exact-review-batch claim/);
  assert.match(source, /repair:exact-review-batch heartbeat/);
  assert.equal(source.match(/repair:exact-review-batch commit/g)?.length, 1);
  assert.equal(source.match(/repair:exact-review-batch complete/g)?.length, 1);
  assert.equal(source.match(/repair:exact-review-batch release/g)?.length, 1);
  assert.match(source, /Finalize healthy members under a fenced heartbeat/);
  assert.match(source, /Release unfinished batch members/);
  assert.match(
    source,
    /name: Release unfinished batch members[\s\S]*?if: \$\{\{ always\(\) && steps\.batch\.outputs\.manifest != '' \}\}/,
  );
  assert.match(source, /name: Release unfinished batch members[\s\S]*?continue-on-error: true/);
  assert.match(source, /while sleep 60/);
  assert.match(source, /test ! -f "\$heartbeat_failed"/);
  assert.match(source, /node scripts\/prepare-exact-review-batch\.mjs/);
  assert.match(source, /gh workflow run repair-comment-router\.yml/);
  assert.match(source, /EXACT_REVIEW_GITHUB_REQUEST_REPEAT="\$repeat_revision"/);
  assert.match(
    source,
    /EXACT_REVIEW_GITHUB_REQUEST_OUTCOME=success[\s\S]*?repair:exact-review-batch request-metric/,
  );
  assert.match(source, /was submitted too quickly[\s\S]*?repair:exact-review-batch rate-limit/);
  assert.match(
    source,
    /EXACT_REVIEW_GITHUB_REQUEST_OUTCOME=error[\s\S]*?repair:exact-review-batch request-metric/,
  );
  assert.match(
    source,
    /AUTO_IMPLEMENT_ISSUES: \$\{\{ vars\.CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES \}\}/,
  );
  assert.match(source, /node scripts\/dispatch-issue-implementation-candidates\.mjs/);
  assert.match(
    source,
    /MAX_DISPATCH: \$\{\{ vars\.CLAWSWEEPER_AUTO_IMPLEMENT_MAX_DISPATCH_PER_SWEEP \|\| '' \}\}/,
  );
  assert.match(source, /remaining_implementations="\$MAX_DISPATCH"/);
  assert.match(source, /\[ "\$remaining_implementations" -gt 0 \]/);
  assert.match(source, /--max-dispatch "\$remaining_implementations"/);
  assert.match(
    source,
    /remaining_implementations=\$\(\(remaining_implementations - dispatched\)\)/,
  );
  assert.match(
    source,
    /if implementation_output="\$\(node scripts\/dispatch-issue-implementation-candidates\.mjs/,
  );
  assert.match(
    source,
    /Automatic issue implementation dispatch failed; scheduled backfill will retry/,
  );
  assert.match(source, /--item-number "\$item_number"/);
  assert.match(source, /post-effect --route router-receipt --payload/);
  assert.match(source, /post-effect --route terminal-disposition --payload/);
  assert.doesNotMatch(
    source,
    /curl --fail|lifecycle_signature|x-clawsweeper-exact-review-signature/,
  );
  assert.match(source, /router-batch-not-required/);
  assert.match(source, /router-batch/);
  assert.match(source, /router-batch-proof/);
  assert.match(source, /lifecycle_terminal="requeue"/);
  assert.match(source, /lifecycle_terminal="target_closed"/);
  assert.match(source, /lifecycle_terminal="target_missing"/);
  assert.match(source, /lifecycle_terminal="superseded"/);
  assert.doesNotMatch(source, /lifecycle_terminal="failure"/);
  const lifecycleHandoff = source.indexOf("post-effect --route terminal-disposition");
  const implementationDispatch = source.indexOf("dispatch-issue-implementation-candidates.mjs");
  const postEffectsComplete = source.indexOf(".postEffectsComplete = true");
  assert.ok(
    lifecycleHandoff >= 0 &&
      lifecycleHandoff < implementationDispatch &&
      implementationDispatch < postEffectsComplete,
  );
  assert.doesNotMatch(source, /TARGET_GH_TOKEN/);
  assert.doesNotMatch(source, /lifecycle\/command-ack\/attempt/);
  assert.doesNotMatch(source, /repair:update-command-status/);
  assert.match(source, /post-effect --route enqueue --payload/);
  assert.match(source, /source_drift_requeue/);
  assert.match(source, /state-receipt\.json/);
  assert.match(source, /receipt_outcome/);
  assert.match(source, /"permanent_failure"/);
  assert.match(source, /deferredCloseCoverageExpected == true/);
  assert.match(source, /lifecycle_deferred_coverage="true"/);
  assert.match(source, /durable handoff completes this review lifecycle/);
  assert.match(source, /jq '\.postEffectsRequired = true'/);
  assert.match(source, /jq '\.postEffectsComplete = true'/);
  assert.match(source, /Capture runner start timestamp/);
  assert.match(source, /EXACT_REVIEW_BATCH_DISPATCH_ID/);
  assert.match(source, /Record batch preparation start/);
  assert.match(source, /Record batch preparation finish/);
  assert.match(source, /EXACT_REVIEW_BATCH_OBSERVATION=final_github_apply/);
  assert.match(source, /EXACT_REVIEW_BATCH_OBSERVATION=github_throttle/);
  assert.match(source, /rate limit\|abuse detection\|was submitted too quickly\|HTTP 429/);

  const healthyMembers = workflow.jobs.publish!.steps.find(
    (step) => step.name === "Finalize healthy members under a fenced heartbeat",
  );
  assert.ok(healthyMembers, "missing healthy member finalizer");
  assert.match(
    healthyMembers.run ?? "",
    /permanent publisher result remains retryable until the durable/,
  );
  assert.match(healthyMembers.run ?? "", /\[ "\$outcome_kind" = "permanent_failure" \].*continue/s);
  const implementationBlock = (healthyMembers.run ?? "").slice(
    (healthyMembers.run ?? "").indexOf("# The optional implementation lane"),
    (healthyMembers.run ?? "").indexOf('report_path="${outcome_path%.json}.report.md"'),
  );
  assert.match(
    implementationBlock,
    /\{ \[ "\$receipt_outcome" = "accepted" \] \|\| \[ "\$receipt_outcome" = "deduped" \]; \} &&/,
  );
  assert.doesNotMatch(implementationBlock, /superseded|permanent/);
  assert.equal(
    workflow.jobs.publish!.steps.some(
      (step) => step.name === "Acknowledge terminal batch command lifecycle status",
    ),
    false,
  );
});

test("legacy batch proof reviews use the normal verdict router; failure recovery remains review-only", () => {
  const run =
    workflow.jobs.publish!.steps.find(
      (step) => step.name === "Finalize healthy members under a fenced heartbeat",
    )?.run ?? "";
  const start = run.indexOf('if [ "$receipt_outcome" = "superseded" ]; then');
  const end = run.indexOf(
    'if [ -n "$lifecycle_router_outcome" ] || [ -n "$lifecycle_terminal" ]; then',
    start,
  );
  assert.ok(start >= 0 && end > start);
  const branch = run.slice(start, end);
  for (const action of [
    "command_proof_result",
    "failed_review_shard_recovery",
    "legacy_dispatch",
  ]) {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          'source_action="$SOURCE_ACTION_CASE"',
          "receipt_outcome=accepted; outcome_kind=eligible; outcome_path=fixture.json",
          "lifecycle_router_outcome=; lifecycle_terminal=",
          'jq() { [ "$1" = "-e" ] && [ "$2" = ".disposition.routableSyncExpected == true" ]; }',
          'gh() { printf "router_called\\n"; }',
          "pnpm() { :; }",
          "for once in only; do",
          branch,
          "done",
          'printf "outcome=%s\\n" "$lifecycle_router_outcome"',
        ].join("\n"),
      ],
      { encoding: "utf8", env: { ...process.env, SOURCE_ACTION_CASE: action } },
    );
    assert.equal(result.status, 0, result.stderr);
    if (action !== "failed_review_shard_recovery") {
      assert.match(result.stdout, /router_called/);
      assert.match(result.stdout, /outcome=durable/);
    } else {
      assert.doesNotMatch(result.stdout, /router_called/);
      assert.match(result.stdout, /outcome=not_required/);
    }
  }
});

test("batch publisher gives canonical supersession precedence over artifact terminal plans", () => {
  const healthyMembers = workflow.jobs.publish!.steps.find(
    (step) => step.name === "Finalize healthy members under a fenced heartbeat",
  );
  assert.ok(healthyMembers, "missing healthy member finalizer");
  const run = healthyMembers.run ?? "";
  const supersededReceipt = run.indexOf('if [ "$receipt_outcome" = "superseded" ]; then');
  const staleArtifactPlan = run.indexOf("elif jq -e '.disposition.requeueLatestExpected == true'");
  const supersededTerminal = run.indexOf('lifecycle_terminal="superseded"', supersededReceipt);
  assert.ok(supersededReceipt >= 0);
  assert.ok(staleArtifactPlan > supersededReceipt);
  assert.ok(supersededTerminal > supersededReceipt && supersededTerminal < staleArtifactPlan);
});

test("direct proof reviews use the normal verdict router; failure recovery remains review-only", () => {
  const run =
    Object.values(sweep.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.name === "Finalize direct exact review lifecycle")?.run ?? "";
  const start = run.indexOf('if [ "${DIRECT_PUBLICATION_SUPERSEDED:-false}" != "true" ]; then');
  const end = run.indexOf('if [ -n "$lifecycle_router_outcome" ]; then', start);
  assert.ok(start >= 0 && end > start);
  const branch = run.slice(start, end);
  for (const action of [
    "command_proof_result",
    "failed_review_shard_recovery",
    "legacy_dispatch",
  ]) {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          'source_action="$SOURCE_ACTION_CASE"',
          "DIRECT_PUBLICATION_SUPERSEDED=false; DIRECT_OUTCOME=fixture.json",
          "lifecycle_router_outcome=; lifecycle_terminal=",
          'jq() { [ "$1" = "-e" ] && [ "$2" = ".disposition.routableSyncExpected == true" ]; }',
          'gh() { printf "router_called\n"; }',
          branch,
          'printf "outcome=%s\nterminal=%s\n" "$lifecycle_router_outcome" "$lifecycle_terminal"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SOURCE_ACTION_CASE: action },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      action !== "failed_review_shard_recovery"
        ? "router_called\noutcome=durable\nterminal=\n"
        : "outcome=not_required\nterminal=\n",
      action,
    );
  }
});

test("direct publication reads the existing selected bundle instead of producer diagnostics", () => {
  const configured = Object.values(sweep.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.env?.EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR !== undefined);
  assert.equal(configured.length, 1);
  const [direct] = configured;
  assert.ok(direct);
  assert.equal(direct.name, "Deliver GitHub effects and prepare direct state mutation");
  assert.equal(
    direct.env?.EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR,
    ".artifacts/exact-review-bundle/review",
  );
});

test("batch workflow uses owner-scoped mutation credentials and canonical Worker hydration", () => {
  assert.match(source, /owner: \$\{\{ steps\.batch\.outputs\.target_owner \}\}/);
  assert.match(source, /repositories: \$\{\{ steps\.batch\.outputs\.target_repositories \}\}/);
  assert.doesNotMatch(source, /uses: \.\/\.github\/actions\/create-state-token/);
  assert.match(source, /uses: \.\/\.github\/actions\/setup-state/);
  assert.match(source, /records-repo-slugs: \$\{\{ steps\.batch\.outputs\.records_repo_slugs \}\}/);
  assert.match(source, /hydrate-git-state: "false"/);
  assert.match(source, /hydrate-state-blobs: "false"/);
  assert.doesNotMatch(source, /permissions:\n(?:.*\n)*?\s+issues: write/);
});

test("batch preparation copies only canonical selected tuples and preserves publisher bases", () => {
  const proof = runCopyProof();
  assert.equal(proof.copiedFiles, 12);
  assert.equal(proof.publisherCount, 8);
});

for (const mode of ["missing-source", "file-source", "heartbeat", "circuit"]) {
  test(`batch preparation retains ${mode} no-mutation outcomes`, () => {
    runCopyProof({ mode, unrelatedRecords: 0 });
  });
}

for (const invalidDecision of [
  { targetRepo: "../outside" },
  { targetRepo: "owner/repo/extra" },
  { itemNumber: "../../outside" },
  { itemNumber: 0 },
  { itemNumber: -1 },
  { itemNumber: 1.5 },
  { itemNumber: Number.MAX_SAFE_INTEGER + 1 },
]) {
  test(`batch preparation rejects ${JSON.stringify(invalidDecision)} before canonical reads`, () => {
    runCopyProof({ mode: "copy", unrelatedRecords: 0, invalidDecision });
  });
}

test("batch workflow tolerates periodic heartbeat outages but establishes each lease strictly", () => {
  for (const name of [
    "Prepare each item independently",
    "Finalize healthy members under a fenced heartbeat",
  ]) {
    const step = workflow.jobs.publish!.steps.find((step) => step.name === name);
    assert.ok(step?.run, name);
    assert.match(step.run, /pnpm run --silent repair:exact-review-batch heartbeat\n\s*\(/);
    assert.match(
      step.run,
      /while sleep 60; do\s*if ! pnpm run --silent repair:exact-review-batch heartbeat --tolerate-until-lease; then\s*touch "\$heartbeat_failed"\s*exit 1/,
    );
    assert.match(step.run, /test ! -f "\$heartbeat_failed"/);
  }
});

test("batch workflow shell steps are valid Bash", () => {
  for (const step of workflow.jobs.publish!.steps) {
    if (!step.run) continue;
    const syntax = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
    assert.equal(syntax.status, 0, `${step.name ?? "unnamed step"}: ${syntax.stderr}`);
  }
});
