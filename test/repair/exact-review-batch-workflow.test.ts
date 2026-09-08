import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
import { createGitHubRuntime } from "../../dist/clawsweeper-github-runtime.js";
import { runCopyProof } from "../../scripts/e2e/exact-review-selected-tuple-copy.mjs";

const path = ".github/workflows/exact-review-batch-publish.yml";
const source = readFileSync(path, "utf8");
const cliSource = readFileSync("src/repair/exact-review-batch-cli.ts", "utf8");
const prepareSource = readFileSync("scripts/prepare-exact-review-batch.mjs", "utf8");
const publisherSource = readFileSync("src/repair/publish-event-result.ts", "utf8");
const sweepSource = readFileSync(".github/workflows/sweep.yml", "utf8");
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

test("manual review timeouts survive queue resolution within the existing exact-review cap", () => {
  const steps = YAML.parse(sweepSource).jobs["event-review-apply"].steps;
  const script = steps
    .find((step: { id?: string }) => step.id === "target")
    .run.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  for (const [sourceAction, codexTimeoutMs, configuredTimeoutMs, expected] of [
    ["manual_explicit_review", 300_000, 1_200_000, 300_000],
    ["manual_explicit_review", 2_400_000, 1_200_000, 2_400_000],
    ["manual_explicit_review", 3_600_000, 1_200_000, 2_700_000],
    ["opened", 2_400_000, 1_200_000, 1_800_000],
    ["opened", 2_400_000, 3_600_000, 2_700_000],
    ["opened", -1, -1, 1_200_000],
  ]) {
    let output = "";
    runInNewContext(script, {
      require: () => ({
        appendFileSync: (_path: string, value: string) => {
          output += value;
        },
      }),
      process: {
        env: {
          CLAIM_DECISION: JSON.stringify({
            targetRepo: "openclaw/openclaw",
            itemNumber: 71,
            sourceAction,
            codexTimeoutMs,
            publicationPolicy:
              sourceAction === "manual_explicit_review" ? "record_comment_only" : undefined,
          }),
          CONFIGURED_CODEX_TIMEOUT_MS: String(configuredTimeoutMs),
        },
      },
    });
    assert.match(output, new RegExp(`^codex_timeout_ms=${expected}$`, "m"));
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
  assert.match(sweepSource, /name: Admit explicit manual reviews/);
  assert.match(sweepSource, /manual-review-enqueue\.js/);
  assert.match(sweepSource, /apply_existing != 'true'.*inputs\.item_number != ''/);
  assert.match(sweepSource, /manual_explicit.*true.*queue_feed=true/);
  assert.match(prepareSource, /EXACT_REVIEW_DECISION: JSON\.stringify\(producer\)/);
  assert.match(source, /publication_policy.*record_comment_only.*failed_review_shard_recovery/);
  assert.match(source, /AUTO_IMPLEMENT_ISSUES.*\n\s*\[ -z "\$publication_policy" \]/);
});

for (const targetBranch of ["release/proof", ""]) {
  test(
    `manual admission preserves branch selection ${targetBranch || "(default lookup)"}`,
    { skip: process.platform === "win32" },
    () => {
      const sweep = YAML.parse(sweepSource);
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
  assert.equal(workflow.jobs.publish!.env.EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY, "1");
  assert.equal(workflow.jobs.publish!.env.CLAWSWEEPER_APP_CLIENT_ID, "Iv23liOECG0slfuhz093");
  assert.equal(workflow.concurrency, undefined);
  assert.deepEqual(workflow.permissions, { actions: "write", contents: "read" });
});

test("batch publication bounds shared GitHub retries without dropping failed artifacts", () => {
  assert.match(
    prepareSource,
    /publish-event-result\.js"\)\],[\s\S]*?\.\.\.process\.env,\s*CLAWSWEEPER_GH_RETRY_ATTEMPTS: "2"/,
  );
  assert.match(
    prepareSource,
    /if \(result\.code !== 0 && !existsSync\(outcomePath\)\) \{\s*writeFailure\(outcomePath, "retryable_failure", "unknown_failure"\)/,
  );
  assert.match(cliSource, /const failure = failureCompletion\(current, outcome\)/);
  assert.match(cliSource, /completions\.push\(failure\)/);
});

test("transient retries stay bounded while GitHub throttles defer immediately", () => {
  const previous = process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
  try {
    delete process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
    const defaultExecution = githubRetryExecution(2);
    assert.equal(defaultExecution.execution.ghWithRetry(["api", "repos/test/item"]), "ok");
    assert.equal(defaultExecution.calls(), 3);

    process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS = "2";
    const boundedExecution = githubRetryExecution(3);
    assert.throws(
      () => boundedExecution.execution.ghWithRetry(["api", "repos/test/item"]),
      /HTTP 502/,
    );
    assert.equal(boundedExecution.calls(), 2);
    assert.deepEqual(boundedExecution.waits, [2_000]);

    for (const kind of ["throttle-403", "throttle-429"] as const) {
      const throttledExecution = githubRetryExecution(3, kind);
      assert.throws(
        () => throttledExecution.execution.ghWithRetry(["api", "repos/test/item"]),
        /API rate limit exceeded|HTTP 429/,
      );
      assert.equal(throttledExecution.calls(), 1);
      assert.deepEqual(throttledExecution.waits, []);

      const mutationExecution = githubRetryExecution(3, kind);
      assert.throws(
        () =>
          mutationExecution.execution.ghObservedMutationCommand({
            args: ["api", "repos/test/item"],
            identity: "batch-publication",
          }),
        /API rate limit exceeded|HTTP 429/,
      );
      assert.equal(mutationExecution.calls(), 1);
      assert.deepEqual(mutationExecution.waits, []);
    }

    const explicitExecution = githubRetryExecution(2);
    assert.equal(explicitExecution.execution.ghWithRetry(["api", "repos/test/item"], 3), "ok");
    assert.equal(explicitExecution.calls(), 3);
  } finally {
    if (previous === undefined) delete process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS;
    else process.env.CLAWSWEEPER_GH_RETRY_ATTEMPTS = previous;
  }
});

test("sweep runtime routes only public target REST reads onto the public token", () => {
  const fixtureEnv = {
    EXACT_EVENT_PUBLICATION: "true",
    GH_TOKEN: "target-app-token",
    REPO_TOKEN: "workflow-repository-token",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "public-read-token",
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([
      "--eval",
      "process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN, args: process.argv.slice(1) }))",
      "--",
    ]),
  };
  const previous = Object.fromEntries(
    [...Object.keys(fixtureEnv), "GH_HOST"].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, fixtureEnv);
  delete process.env.GH_HOST;

  let currentTarget = "openclaw/openclaw";
  const requests: Array<{ args: string[]; token: string | undefined; timeoutMs?: number }> = [];
  const run = (
    _command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ) => {
    const request = {
      args,
      token: options?.env?.GH_TOKEN ?? process.env.GH_TOKEN,
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
    requests.push(request);
    return JSON.stringify(request);
  };
  const runtime = createGitHubRuntime({
    ROOT: process.cwd(),
    run,
    targetRepo: () => currentTarget,
  });
  const observed = (
    args: string[],
    timeoutMs: number | undefined = 5_000,
    env: NodeJS.ProcessEnv = {},
  ) =>
    JSON.parse(runtime.ghWithPreparedTimeout(args, timeoutMs, env)) as {
      token: string;
      args: string[];
      timeoutMs?: number;
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
    assert.equal(observed(publicArgs, 1234).timeoutMs, 1234);
    assert.equal(JSON.parse(runtime.gh(publicArgs)).token, "public-read-token");
    assert.equal(JSON.parse(runtime.ghOnce(publicArgs, 10_000)).token, "public-read-token");

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
    assert.equal(JSON.parse(runtime.ghOnce(privateRequests[6]!, 10_000)).token, "target-app-token");
    assert.equal(
      observed(publicArgs, 5_000, { GH_TOKEN: "explicit-token" }).token,
      "explicit-token",
    );
    assert.equal(
      observed(publicArgs, 5_000, { GITHUB_TOKEN: "explicit-github-token" }).token,
      "target-app-token",
    );

    const execution = createGitHubExecution({
      ROOT: process.cwd(),
      run,
      gitHubRuntime: runtime,
      sweepStatus: {
        sweepStatusRelativePath: () => "status.json",
        writeSweepStatus: () => undefined,
      },
      labelAlreadyExistsError: () => false,
    } as unknown as Parameters<typeof createGitHubExecution>[0]);
    assert.equal(
      JSON.parse(
        execution.ghObservedMutationCommand({
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

    currentTarget = "openclaw/private";
    assert.equal(observed(publicArgs).token, "public-read-token");
    currentTarget = "openclaw/openclaw";

    process.env.GH_HOST = "enterprise.example.invalid";
    assert.equal(observed(publicArgs).token, "target-app-token");
    delete process.env.GH_HOST;

    delete process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN;
    delete process.env.REPO_TOKEN;
    assert.equal(observed(publicArgs).token, "target-app-token");
    assert.ok(requests.length > privateRequests.length);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("sweep public read throttles fall back once to the ambient App token", () => {
  const fixtureEnv = {
    GH_TOKEN: "sweep-fallback-app-token",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "sweep-fallback-public-token",
  };
  const previous = Object.fromEntries(
    Object.keys(fixtureEnv).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, fixtureEnv);

  const observedTokens: string[] = [];
  const run = (
    _command: string,
    _args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ) => {
    const token = options?.env?.GH_TOKEN ?? process.env.GH_TOKEN ?? "";
    observedTokens.push(token);
    if (token === fixtureEnv.CLAWSWEEPER_PUBLIC_GH_TOKEN) {
      throw new Error("gh: API rate limit exceeded for installation (HTTP 403)");
    }
    return JSON.stringify({ token });
  };
  const runtime = createGitHubRuntime({
    ROOT: process.cwd(),
    run,
    targetRepo: () => "openclaw/openclaw",
  });
  const execution = createGitHubExecution({
    ROOT: process.cwd(),
    gitHubRuntime: runtime,
    labelAlreadyExistsError: () => false,
  });

  try {
    const args = ["api", "repos/openclaw/openclaw/issues/123"];
    assert.equal(JSON.parse(execution.ghWithRetry(args)).token, fixtureEnv.GH_TOKEN);
    assert.deepEqual(observedTokens, [fixtureEnv.CLAWSWEEPER_PUBLIC_GH_TOKEN, fixtureEnv.GH_TOKEN]);

    assert.throws(() => execution.ghWithRetry(args), { name: "GitHubRateLimitError" });
    assert.deepEqual(observedTokens, [
      fixtureEnv.CLAWSWEEPER_PUBLIC_GH_TOKEN,
      fixtureEnv.GH_TOKEN,
      fixtureEnv.CLAWSWEEPER_PUBLIC_GH_TOKEN,
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("exact publication records the Actions reset before one bounded App fallback", () => {
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
  const observed: Array<{ token: string; args: string[] }> = [];
  const reset = Math.floor(Date.now() / 1_000) + 600;
  const run = (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    const token = options?.env?.GH_TOKEN ?? process.env.GH_TOKEN ?? "";
    observed.push({ token, args });
    if (args[0] === "api" && args[1] === "rate_limit") {
      return JSON.stringify({ remaining: 0, reset });
    }
    if (token === fixtureEnv.REPO_TOKEN) {
      throw new Error("gh: API rate limit exceeded for repository token (HTTP 403)");
    }
    return JSON.stringify({ token });
  };
  const runtime = createGitHubRuntime({
    ROOT: process.cwd(),
    run,
    targetRepo: () => "openclaw/openclaw",
  });
  const execution = createGitHubExecution({
    ROOT: process.cwd(),
    gitHubRuntime: runtime,
    labelAlreadyExistsError: () => false,
  });
  try {
    const result = JSON.parse(execution.ghWithRetry(["api", "repos/openclaw/openclaw/issues/123"]));
    assert.equal(result.token, fixtureEnv.GH_TOKEN);
    assert.deepEqual(
      observed.map(({ token }) => token),
      [fixtureEnv.REPO_TOKEN, fixtureEnv.REPO_TOKEN, fixtureEnv.GH_TOKEN],
    );
    const observations = readFileSync(observationPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(observations, [
      {
        scope: "repository_actions",
        observed_at: observations[0].observed_at,
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

test("inherited GitHub Actions credentials open the repository quota circuit", () => {
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
  const observedTokens: string[] = [];
  const reset = Math.floor(Date.now() / 1_000) + 300;
  const run = (_command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    const token =
      options?.env?.GH_TOKEN ??
      options?.env?.GITHUB_TOKEN ??
      process.env.GH_TOKEN ??
      process.env.GITHUB_TOKEN ??
      "";
    observedTokens.push(token);
    if (args[0] === "api" && args[1] === "rate_limit") {
      return JSON.stringify({ remaining: 0, reset });
    }
    throw new Error("gh: API rate limit exceeded for GITHUB_TOKEN (HTTP 403)");
  };
  const runtime = createGitHubRuntime({
    ROOT: process.cwd(),
    run,
    targetRepo: () => "openclaw/openclaw",
  });
  const execution = createGitHubExecution({
    ROOT: process.cwd(),
    gitHubRuntime: runtime,
    labelAlreadyExistsError: () => false,
  });
  try {
    assert.throws(
      () => execution.ghWithRetry(["api", "repos/openclaw/openclaw/issues/123/comments"]),
      { name: "GitHubRateLimitError" },
    );
    assert.deepEqual(observedTokens, [fixtureEnv.GITHUB_TOKEN, fixtureEnv.GITHUB_TOKEN]);
    const observations = readFileSync(observationPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(observations, [
      {
        scope: "repository_actions",
        observed_at: observations[0].observed_at,
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
  assert.match(prepareSource, /"retryable_failure", "artifact_unavailable"/);
  assert.match(prepareSource, /"permanent_failure", "tuple_protocol_invalid"/);
  assert.match(prepareSource, /EXACT_REVIEW_BATCH_MUTATION_OUTPUT/);
  assert.match(
    publisherSource,
    /if \(options\.batchMutationOutput\)[\s\S]*?writeBatchMutationResult\(options\.batchMutationOutput, \{[\s\S]*?kind: completionKind,[\s\S]*?reasonCode,/,
  );
  assert.match(
    publisherSource,
    /canonicalTargetKey: `\$\{options\.targetRepo\}#\$\{options\.itemNumber\}`,\s*fenceKey: itemKey/,
  );
  // Keep the fixture from looking like an embedded credential while still
  // proving that artifact downloads use the owner-scoped repository token.
  const ghToken = ["GH", "TOKEN"].join("_");
  assert.match(prepareSource, new RegExp(`${ghToken}: repositoryToken`));
  assert.match(prepareSource, /activeCircuit[\s\S]*?attempted: false/);
  assert.match(
    prepareSource,
    /githubThrottleText\(result\.stderr\)[\s\S]*?resolveRateLimitObservation/,
  );
  assert.match(prepareSource, /was submitted too quickly/);
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
  assert.match(prepareSource, /outcomePath\.replace\(\/\\\.json\$\/, "\.report\.md"\)/);
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
  assert.match(cliSource, /outcome\.postEffectsRequired === true/);
  assert.match(source, /Capture runner start timestamp/);
  assert.match(source, /EXACT_REVIEW_BATCH_DISPATCH_ID/);
  assert.match(source, /Record batch preparation start/);
  assert.match(source, /Record batch preparation finish/);
  assert.match(source, /EXACT_REVIEW_BATCH_OBSERVATION=final_github_apply/);
  assert.match(source, /EXACT_REVIEW_BATCH_OBSERVATION=github_throttle/);
  assert.match(source, /rate limit\|abuse detection\|was submitted too quickly\|HTTP 429/);
  assert.match(cliSource, /"observe"/);
  assert.match(cliSource, /optionalDispatchTelemetry/);
  assert.match(cliSource, /optionalRunnerTelemetry/);
  assert.match(cliSource, /if \(!startedAt\) return undefined;/);

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
  const sweep = YAML.parse(sweepSource) as typeof workflow;
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

test("exact-review producer uses direct publication with bounded legacy fallback", () => {
  assert.match(sweepSource, /name: Deliver GitHub effects and prepare direct state mutation/);
  assert.match(sweepSource, /records-item-number: \$\{\{ steps\.target\.outputs\.item_number \}\}/);
  assert.match(
    sweepSource,
    /EXACT_REVIEW_BATCH_MUTATION_OUTPUT: \.artifacts\/direct-publication-outcome\.json/,
  );
  assert.match(sweepSource, /repair:exact-review-direct-publication/);
  assert.match(
    sweepSource,
    /EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: \$\{\{ vars\.EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED \|\| '1' \}\}/,
  );
  assert.match(
    sweepSource,
    /name: Upload exact review artifact bundle[\s\S]*?steps\.direct-exact-review-publication\.outputs\.accepted != 'true'/,
  );
  assert.match(
    sweepSource,
    /name: Queue durable exact review publication[\s\S]*?steps\.upload-exact-review-bundle\.outcome == 'success'/,
  );
  assert.match(sweepSource, /internal\/exact-review\/enqueue/);
  assert.match(source, /name: Claim one durable publication batch/);
});

test("direct publication reads the existing selected bundle instead of producer diagnostics", () => {
  const sweep = YAML.parse(sweepSource) as {
    jobs: Record<string, { steps?: Array<{ name?: string; env?: Record<string, string> }> }>;
  };
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
  assert.match(
    publisherSource,
    /artifactDir: resolve\(\s*workRoot,\s*process\.env\.EXACT_REVIEW_PUBLICATION_ARTIFACT_DIR \|\| "artifacts\/event",?\s*\)/,
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
  assert.match(cliSource, /slugForRepo\(normalizeRepo\(target\)\)/);
  assert.doesNotMatch(source, /permissions:\n(?:.*\n)*?\s+issues: write/);
  assert.doesNotMatch(prepareSource, /stateClone|CLAWSWEEPER_STATE_DIR|"clone"/);
  assert.match(prepareSource, /CLAWSWEEPER_CODE_ROOT: workspace/);
  assert.match(prepareSource, /EXACT_REVIEW_WORK_ROOT: root/);
  assert.match(prepareSource, /publish-event-result\.js"\)\],\s*\{\s*cwd: root,\s*env:/);
  assert.match(publisherSource, /codeRoot: resolve\(process\.env\.CLAWSWEEPER_CODE_ROOT/);
  assert.match(publisherSource, /const cli = join\(options\.codeRoot, "dist\/clawsweeper\.js"\)/);
  assert.match(
    publisherSource,
    /spawnSync\(process\.execPath, \[cli, \.\.\.args\], \{\s*cwd: options\.workRoot,/,
  );
  assert.equal(
    publisherSource.match(/\.\.\.eventRecordDirectoryArgs\(options, (?:recordPaths|paths)\)/g)
      ?.length,
    2,
  );
  for (const flag of ["items", "closed", "plans", "decision-packets"]) {
    assert.match(publisherSource, new RegExp(`"--${flag}-dir"`));
  }
  assert.match(publisherSource, /"--record-root",\s*options\.workRoot/);
  assert.doesNotMatch(publisherSource, /runStreaming\("pnpm"/);
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

test("batch preparation is bounded, heartbeat-fenced, and deterministically aggregated", () => {
  assert.match(prepareSource, /const MAX_CONCURRENCY = 4/);
  assert.match(prepareSource, /const MAX_ITEMS = 32/);
  assert.match(prepareSource, /results\[index\] = await worker/);
  assert.match(prepareSource, /EXACT_REVIEW_BATCH_HEARTBEAT_FAILURE_PATH/);
  assert.match(prepareSource, /DEFAULT_ITEM_TIMEOUT_MS/);
  assert.match(prepareSource, /DEFAULT_TOTAL_TIMEOUT_MS/);
  assert.match(prepareSource, /Math\.min\(itemTimeoutMs, remainingTimeout\(deadline\)\)/);
  assert.doesNotMatch(prepareSource, /importPreparedMutationObjects|pack-objects|targetOid/);
  assert.match(prepareSource, /terminate\("SIGKILL"\)/);
  assert.match(prepareSource, /prepare-telemetry\.json/);
});

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

test("batch claim treats an all-stale fetched batch as terminal", () => {
  assert.match(cliSource, /if \(!manifest\.items\.length\) return;/);
  assert.ok(
    cliSource.indexOf("if (!manifest.items.length) return;") < cliSource.indexOf("owners.size"),
  );
});

test("batch manifest records the dashboard effective lease size", () => {
  assert.match(cliSource, /configuredBatchSize: lease\.configuredBatchSize/);
  assert.doesNotMatch(
    cliSource,
    /configuredBatchSize: positiveInteger\(env\("EXACT_REVIEW_BATCH_MAX_ITEMS"\)\)/,
  );
});

test("batch failure cleanup completes manifest fences without a queue fetch", () => {
  const releaseSource = /async function release\(\) \{([\s\S]*?)\n\}/.exec(cliSource)?.[1] ?? "";
  assert.match(releaseSource, /manifest\.items\.map/);
  assert.match(releaseSource, /readBatchReceipt\(manifest, false\)/);
  assert.match(releaseSource, /receipt\?\.outcomes\.get\(member\.itemKey\)/);
  assert.match(releaseSource, /receipt\?\.publishedItemKeys\.has\(member\.itemKey\)/);
  assert.match(releaseSource, /terminalOutcome: "published"/);
  assert.match(releaseSource, /receipt\?\.stateCommitSha/);
  assert.match(releaseSource, /receipt\?\.stateWriter/);
  assert.doesNotMatch(releaseSource, /client\.fetch/);
});

test("batch commit publishes every prepared tuple to canonical Worker state", () => {
  const commitSource = /async function commit\(\) \{([\s\S]*?)\n\}/.exec(cliSource)?.[1] ?? "";
  assert.match(commitSource, /await publishCanonicalBatch\(commitCandidates\)/);
  assert.match(commitSource, /permanentPublicationOutcome\(current, failureFingerprint\(error\)\)/);
  assert.match(commitSource, /outcomes: publicationOutcomes/);
  assert.match(cliSource, /canonicalTargetKey/);
  assert.match(cliSource, /fenceKey/);
  assert.match(cliSource, /postDirectPublicationResult/);
  assert.match(cliSource, /publication-batch-results/);
  assert.match(
    cliSource,
    /payload: prepareDirectPublicationPayload\(\{ revision: plan\.identity\.revision, plan \}\)/,
  );
  assert.doesNotMatch(cliSource, /runGit|targetOid/);
  assert.doesNotMatch(cliSource, /commitPreparedStateBatch/);
  assert.doesNotMatch(cliSource, /state-publication-batch/);
});

function githubRetryExecution(
  failures: number,
  kind: "transient" | "throttle-403" | "throttle-429" = "transient",
) {
  let calls = 0;
  const waits: number[] = [];
  class TestGitHubRuntimeBudgetError extends Error {}
  const request = () => {
    calls += 1;
    if (calls <= failures) {
      throw new Error(
        kind === "throttle-403"
          ? "API rate limit exceeded for installation ID 122230863 (HTTP 403)"
          : kind === "throttle-429"
            ? "HTTP 429: Too Many Requests"
            : "HTTP 502: transient upstream failure",
      );
    }
    return "ok";
  };
  const execution = createGitHubExecution({
    ROOT: process.cwd(),
    run: request,
    gitHubRuntime: {
      GitHubRuntimeBudgetError: TestGitHubRuntimeBudgetError,
      claimPublicReadFallback: () => null,
      ensureGitHubRetryFits: () => undefined,
      ensureGitHubRuntimeAvailable: () => undefined,
      gh: request,
      ghOnce: request,
      ghWithPreparedTimeout: request,
      githubCommandTimeoutMs: () => undefined,
      githubRuntimeBudgetError: () => new TestGitHubRuntimeBudgetError(),
      sleepBeforeGitHubRetry: (waitMs: number) => waits.push(waitMs),
    },
    sweepStatus: {
      sweepStatusRelativePath: () => "status.json",
      writeSweepStatus: () => undefined,
    },
    labelAlreadyExistsError: () => false,
  } as unknown as Parameters<typeof createGitHubExecution>[0]);

  return { execution, calls: () => calls, waits };
}
