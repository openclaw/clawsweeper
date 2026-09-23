import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs, {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createGitHubExecution } from "../dist/clawsweeper-github-execution.js";
import {
  createGitHubRuntime,
  GitHubOperationDeadlineError,
} from "../dist/clawsweeper-github-runtime.js";
import type { GitHubRuntimeBudget } from "../src/clawsweeper-types.js";

const args = ["api", "repos/openclaw/openclaw/issues/123", "--jq", "."];
type Request = { args: string[]; timeoutMs: number | undefined; token: string | undefined };

function fixture(
  t: TestContext,
  label: string,
  respond: (request: Request, state: { now: number }) => string,
  publicFallback = false,
) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-operation-deadline-"));
  const metricsPath = join(root, "requests.jsonl");
  const observationPath = join(root, "rate-limit.jsonl");
  const appToken = `synthetic-${label}-app`;
  const publicToken = `synthetic-${label}-public`;
  const env: Record<string, string | undefined> = {
    GH_TOKEN: appToken,
    GITHUB_TOKEN: undefined,
    GH_HOST: undefined,
    REPO_TOKEN: publicFallback ? publicToken : undefined,
    CLAWSWEEPER_PUBLIC_GH_TOKEN: undefined,
    CLAWSWEEPER_GH_RETRY_ATTEMPTS: undefined,
    EXACT_EVENT_PUBLICATION: publicFallback ? "true" : undefined,
    EXACT_REVIEW_QUEUE_URL: undefined,
    CLAWSWEEPER_WEBHOOK_SECRET: undefined,
    CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: undefined,
    CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH: metricsPath,
    CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observationPath,
    CLAWSWEEPER_GITHUB_REQUEST_REPEAT: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const state = { now: 1_000_000 };
  t.mock.method(Date, "now", () => state.now);
  t.mock.method(console, "error", () => {});
  const requests: Request[] = [];
  const waits: number[] = [];
  const runtime = createGitHubRuntime({
    ROOT: root,
    targetRepo: () => "openclaw/openclaw",
    run: (_command, requestArgs, options) => {
      const request = {
        args: requestArgs,
        timeoutMs: options?.timeoutMs,
        token: options?.env?.GH_TOKEN ?? process.env.GH_TOKEN,
      };
      requests.push(request);
      return respond(request, state);
    },
  });
  t.mock.method(runtime, "sleepBeforeGitHubRetry", (waitMs, deadlineAt) => {
    runtime.ensureGitHubRetryFits(waitMs, deadlineAt);
    waits.push(waitMs);
    state.now += waitMs;
  });
  const execution = createGitHubExecution({
    ROOT: root,
    gitHubRuntime: runtime,
    labelAlreadyExistsError: () => false,
  });
  const metrics = () =>
    readFileSync(metricsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { outcome: string; category: string });
  const observations = () =>
    readFileSync(observationPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { scope: string; provenance: string });
  return {
    runtime,
    execution,
    state,
    requests,
    waits,
    metrics,
    observations,
    observationPath,
    appToken,
    publicToken,
  };
}

test("operation deadline intersects the outer budget without poisoning its yield state", (t) => {
  const f = fixture(t, "intersection", () => assert.fail("must not dispatch"));
  const budget: GitHubRuntimeBudget = { startedAtMs: f.state.now, maxRuntimeMs: 10_000 };
  const deadlineAt = f.state.now + 4_000;
  f.runtime.withGitHubRuntimeBudget(budget, () => {
    assert.equal(f.runtime.githubCommandTimeoutMs(20_000, deadlineAt), 4_000);
    f.state.now += 1_000;
    assert.equal(f.runtime.githubCommandTimeoutMs(undefined, deadlineAt), 3_000);
    assert.doesNotThrow(() => f.runtime.ensureGitHubRetryFits(2_999, deadlineAt));
    assert.throws(
      () => f.runtime.ensureGitHubRetryFits(3_000, deadlineAt),
      GitHubOperationDeadlineError,
    );
    assert.equal(budget.yieldReason, undefined);
    f.state.now = deadlineAt;
    assert.throws(
      () => f.runtime.githubCommandTimeoutMs(undefined, deadlineAt),
      GitHubOperationDeadlineError,
    );
    assert.equal(f.runtime.githubCommandTimeoutMs(), 5_000);
    assert.equal(budget.yieldReason, undefined);
    assert.equal(f.runtime.githubCommandTimeoutMs(20_000, deadlineAt + 20_000), 5_000);
  });
});

test("local retry refusal preserves positive outer time when neither budget fits backoff", (t) => {
  const f = fixture(t, "overlapping-wait", () => assert.fail("must not dispatch"));
  const budget: GitHubRuntimeBudget = { startedAtMs: f.state.now, maxRuntimeMs: 2_000 };
  const deadlineAt = f.state.now + 500;
  f.runtime.withGitHubRuntimeBudget(budget, () => {
    let failure: unknown;
    try {
      f.runtime.ensureGitHubRetryFits(2_000, deadlineAt);
    } catch (error) {
      failure = error;
    }
    t.diagnostic(
      JSON.stringify({
        errorName: failure instanceof Error ? failure.name : null,
        outerYieldReason: budget.yieldReason ?? null,
      }),
    );
    assert.ok(failure instanceof GitHubOperationDeadlineError);
    assert.equal(budget.yieldReason, undefined);
    assert.equal(f.runtime.githubCommandTimeoutMs(), 1_000);
  });
});

for (const outerState of ["pending", "expired"] as const) {
  test(`local retry refusal preserves an already ${outerState} outer budget error`, (t) => {
    const f = fixture(t, `outer-${outerState}`, () => assert.fail("must not dispatch"));
    const budget: GitHubRuntimeBudget = {
      startedAtMs: f.state.now,
      maxRuntimeMs: outerState === "expired" ? 1_000 : 10_000,
      ...(outerState === "pending" ? { yieldReason: "prior outer refusal" } : {}),
    };
    const expectedReason =
      outerState === "pending"
        ? "prior outer refusal"
        : "max runtime 1000ms reached before GitHub retry";
    f.runtime.withGitHubRuntimeBudget(budget, () => {
      assert.throws(
        () => f.runtime.ensureGitHubRetryFits(2_000, f.state.now),
        (error: unknown) =>
          error instanceof f.runtime.GitHubRuntimeBudgetError && error.reason === expectedReason,
      );
      assert.equal(budget.yieldReason, expectedReason);
    });
  });
}

test("transport and malformed JSON retries consume one deadline and preserve request accounting", (t) => {
  let attempt = 0;
  const f = fixture(t, "retries", (_request, state) => {
    state.now += 100;
    if (attempt++ === 0) throw new Error("HTTP 502: temporary failure");
    return attempt === 2 ? "{" : '{"ok":true}';
  });
  assert.deepEqual(f.execution.ghJson(args, { deadlineAt: f.state.now + 10_000 }), { ok: true });
  assert.deepEqual(
    f.requests.map((request) => request.timeoutMs),
    [10_000, 7_900, 5_800],
  );
  assert.deepEqual(f.waits, [2_000, 2_000]);
  assert.deepEqual(
    f.metrics().map((entry) => entry.outcome),
    ["transient", "success", "success"],
  );
});

for (const failure of ["transport", "json"] as const) {
  test(`${failure} retry cannot spend the operation's remaining time on backoff`, (t) => {
    const f = fixture(t, `wait-${failure}`, () => {
      if (failure === "transport") throw new Error("HTTP 502: temporary failure");
      return "{";
    });
    const budget: GitHubRuntimeBudget = { startedAtMs: f.state.now, maxRuntimeMs: 60_000 };
    f.runtime.withGitHubRuntimeBudget(budget, () => {
      assert.throws(
        () => f.execution.ghJson(args, { deadlineAt: f.state.now + 2_000 }),
        GitHubOperationDeadlineError,
      );
      assert.equal(budget.yieldReason, undefined);
    });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(
      f.metrics().map((entry) => entry.outcome),
      [failure === "transport" ? "transient" : "success"],
    );
  });
}

test("a response arriving after the operation deadline cannot start another attempt", (t) => {
  const f = fixture(t, "late-success", (_request, state) => {
    state.now += 30_001;
    return '{"ok":true}';
  });
  assert.throws(
    () => f.execution.ghJson(args, { deadlineAt: f.state.now + 30_000 }),
    GitHubOperationDeadlineError,
  );
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.waits, []);
  assert.deepEqual(
    f.metrics().map((entry) => entry.outcome),
    ["success"],
  );
});

test("rate-limit lookup and one App fallback share the remaining deadline", (t) => {
  const f = fixture(
    t,
    "fallback",
    (request, state) => {
      if (request.args[1] === "rate_limit") {
        state.now += 200;
        return JSON.stringify({ remaining: 0, reset: Math.floor(state.now / 1_000) + 600 });
      }
      state.now += 100;
      if (request.token === "synthetic-fallback-public") {
        throw new Error("HTTP 403: API rate limit exceeded");
      }
      return '{"ok":true}';
    },
    true,
  );
  const deadlineAt = f.state.now + 3_000;
  assert.deepEqual(f.execution.ghJson(args, { deadlineAt }), { ok: true });
  assert.deepEqual(
    f.requests.map((request) => request.timeoutMs),
    [3_000, 2_900, 2_700],
  );
  assert.deepEqual(
    f.requests.map((request) => request.token),
    [f.publicToken, f.publicToken, f.appToken],
  );
  assert.equal(f.observations()[0]?.provenance, "fallback");
  assert.equal(f.observations().at(-1)?.provenance, "rate_limit_status");
  assert.deepEqual(
    f.metrics().map((entry) => entry.outcome),
    ["throttle", "success", "success"],
  );
  assert.throws(() => f.execution.ghJson(args, { deadlineAt }), { name: "GitHubRateLimitError" });
  assert.equal(
    f.requests.length,
    3,
    "neither the exhausted pool nor the App fallback is probed again",
  );
});

test("expiry records throttling without claiming an unused lookup or fallback", (t) => {
  let expire = true;
  const f = fixture(
    t,
    "expired-throttle",
    (request, state) => {
      if (request.args[1] === "rate_limit") {
        return JSON.stringify({ remaining: 0, reset: Math.floor(state.now / 1_000) + 600 });
      }
      if (request.token === "synthetic-expired-throttle-public") {
        if (expire) state.now += 30_001;
        throw new Error("HTTP 403: API rate limit exceeded");
      }
      return '{"ok":true}';
    },
    true,
  );
  const budget: GitHubRuntimeBudget = { startedAtMs: f.state.now, maxRuntimeMs: 180_000 };
  f.runtime.withGitHubRuntimeBudget(budget, () => {
    assert.throws(
      () => f.execution.ghJson(args, { deadlineAt: f.state.now + 30_000 }),
      GitHubOperationDeadlineError,
    );
    assert.equal(budget.yieldReason, undefined);
    assert.equal(f.requests.length, 1);
    assert.equal(existsSync(`${f.observationPath}.lookup-repository_actions.lock`), false);
    assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), false);
    assert.equal(f.observations()[0]?.provenance, "fallback");
    assert.deepEqual(
      f.metrics().map((entry) => entry.outcome),
      ["throttle"],
    );
    expire = false;
    f.state.now += 61_000;
    assert.deepEqual(f.execution.ghJson(args, { deadlineAt: f.state.now + 5_000 }), { ok: true });
    assert.deepEqual(
      f.requests.map((request) => request.token),
      [f.publicToken, f.publicToken, f.publicToken, f.appToken],
    );
  });
});

test("an undispatched rate-limit lookup releases its scope and lock for the next member", (t) => {
  const f = fixture(
    t,
    "lookup-claim-race",
    (request, state) => {
      if (request.args[1] === "rate_limit") {
        return JSON.stringify({ remaining: 0, reset: Math.floor(state.now / 1_000) + 600 });
      }
      if (request.token === "synthetic-lookup-claim-race-public") {
        throw new Error("HTTP 403: API rate limit exceeded");
      }
      return '{"ok":true}';
    },
    true,
  );
  const deadlineAt = f.state.now + 500;
  const lockPath = `${f.observationPath}.lookup-repository_actions.lock`;
  const nativeOpen = fs.openSync;
  let expire = true;
  const mock = t.mock.method(fs, "openSync", (...call: Parameters<typeof nativeOpen>) => {
    const descriptor = nativeOpen(...call);
    if (call[0] === lockPath && call[1] === "wx" && expire) {
      expire = false;
      f.state.now = deadlineAt;
    }
    return descriptor;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  assert.throws(() => f.execution.ghJson(args, { deadlineAt }), GitHubOperationDeadlineError);
  assert.equal(f.requests.length, 1);
  assert.equal(existsSync(lockPath), false);
  assert.equal(f.observations()[0]?.provenance, "fallback");
  f.state.now += 61_000;
  assert.deepEqual(f.execution.ghJson(args, { deadlineAt: f.state.now + 5_000 }), { ok: true });
  assert.equal(f.requests.filter((request) => request.args[1] === "rate_limit").length, 1);
  assert.equal(f.observations().at(-1)?.provenance, "rate_limit_status");
  assert.equal(existsSync(lockPath), true);
});

for (const outcome of ["success", "failure"] as const) {
  test(`a dispatched lookup's late ${outcome} retains its one-shot scope and lock`, (t) => {
    const label = `lookup-expiry-${outcome}`;
    const f = fixture(
      t,
      label,
      (request, state) => {
        if (request.args[1] === "rate_limit") {
          assert.equal(request.timeoutMs, 1_000);
          state.now += 1_000;
          if (outcome === "failure")
            throw Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" });
          return JSON.stringify({ remaining: 0, reset: Math.floor(state.now / 1_000) + 600 });
        }
        if (request.token === `synthetic-${label}-public`)
          throw new Error("HTTP 403: API rate limit exceeded");
        return '{"ok":true}';
      },
      true,
    );
    assert.throws(
      () => f.execution.ghJson(args, { deadlineAt: f.state.now + 1_000 }),
      GitHubOperationDeadlineError,
    );
    assert.equal(f.requests.length, 2);
    assert.equal(existsSync(`${f.observationPath}.lookup-repository_actions.lock`), true);
    assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), false);
    assert.deepEqual(
      f.metrics().map((entry) => entry.outcome),
      ["throttle", outcome === "success" ? "success" : "transient"],
    );
    assert.deepEqual(f.execution.ghJson(args, { deadlineAt: f.state.now + 5_000 }), { ok: true });
    assert.equal(f.requests.filter((request) => request.args[1] === "rate_limit").length, 1);
  });
}

test("callers without an operation deadline retain ordinary retries", (t) => {
  let attempt = 0;
  const f = fixture(t, "unbounded-caller", () => {
    if (attempt++ === 0) throw new Error("HTTP 502: temporary failure");
    return '{"ok":true}';
  });
  assert.deepEqual(f.execution.ghJson(args), { ok: true });
  assert.deepEqual(
    f.requests.map((request) => request.timeoutMs),
    [undefined, undefined],
  );
  assert.deepEqual(f.waits, [2_000]);
});

test("a fallback claim that outlives admission is released for a later member", (t) => {
  const f = fixture(
    t,
    "claim-race",
    (request) => {
      if (request.token === "synthetic-claim-race-public") {
        throw new Error("HTTP 403: API rate limit exceeded; retry-after: 60");
      }
      return '{"ok":true}';
    },
    true,
  );
  const deadlineAt = f.state.now + 500;
  const originalClaim = f.runtime.claimPublicReadFallback;
  let expireClaim = true;
  t.mock.method(f.runtime, "claimPublicReadFallback", (requestArgs) => {
    const claim = originalClaim(requestArgs);
    if (claim && expireClaim) {
      expireClaim = false;
      f.state.now = deadlineAt;
    }
    return claim;
  });
  const execution = createGitHubExecution({
    ROOT: process.cwd(),
    gitHubRuntime: f.runtime,
    labelAlreadyExistsError: () => false,
  });
  assert.throws(() => execution.ghJson(args, { deadlineAt }), GitHubOperationDeadlineError);
  assert.deepEqual(
    f.requests.map((request) => request.token),
    [f.publicToken],
  );
  assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), false);
  assert.deepEqual(execution.ghJson(args, { deadlineAt: f.state.now + 5_000 }), { ok: true });
  assert.deepEqual(
    f.requests.map((request) => request.token),
    [f.publicToken, f.appToken],
  );
  assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), true);
  assert.throws(() => execution.ghJson(args, { deadlineAt: f.state.now + 5_000 }), {
    name: "GitHubRateLimitError",
  });
  assert.equal(f.requests.filter((request) => request.token === f.appToken).length, 1);
});

for (const outcome of ["success", "failure"] as const) {
  test(`a late dispatched App ${outcome} retains the one-shot claim`, (t) => {
    const label = `late-app-${outcome}`;
    const f = fixture(
      t,
      label,
      (request, state) => {
        if (request.token === `synthetic-${label}-public`) {
          throw new Error("HTTP 403: API rate limit exceeded; retry-after: 60");
        }
        state.now += 500;
        if (outcome === "failure") throw new Error("HTTP 502: temporary failure");
        return '{"ok":true}';
      },
      true,
    );
    assert.throws(
      () => f.execution.ghJson(args, { deadlineAt: f.state.now + 500 }),
      GitHubOperationDeadlineError,
    );
    assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), true);
    assert.throws(() => f.execution.ghJson(args, { deadlineAt: f.state.now + 5_000 }), {
      name: "GitHubRateLimitError",
    });
    assert.equal(f.requests.filter((request) => request.token === f.appToken).length, 1);
  });
}

test("fallback rollback never removes a replaced lock or clears its exclusion", (t) => {
  const f = fixture(t, "replaced-lock", () => assert.fail("must not dispatch"), true);
  const claim = f.runtime.claimPublicReadFallback(args);
  assert.ok(claim);
  const lock = `${f.observationPath}.fallback-target_app.lock`;
  renameSync(lock, `${lock}.original`);
  writeFileSync(lock, "replacement owner");
  assert.equal(claim.releaseIfUndispatched(), false);
  assert.equal(readFileSync(lock, "utf8"), "replacement owner");
  process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH = `${f.observationPath}.other`;
  assert.equal(f.runtime.claimPublicReadFallback(args), null);
});

for (const expiry of ["before", "after"] as const) {
  test(`ETag fallback expiry ${expiry} GitHub dispatch preserves claim ownership`, (t) => {
    const f = fixture(t, `etag-${expiry}`, () => assert.fail("must use the ETag transport"), true);
    process.env.EXACT_REVIEW_QUEUE_URL = "http://127.0.0.1:9";
    process.env.CLAWSWEEPER_WEBHOOK_SECRET = "synthetic-etag-deadline-secret";
    const deadlineAt = f.state.now + 500;
    let lookups = 0;
    let appDispatches = 0;
    const nativeSpawn = childProcess.spawnSync;
    const mock = t.mock.method(
      childProcess,
      "spawnSync",
      (...call: Parameters<typeof nativeSpawn>) => {
        const requestArgs = call[1] ?? [];
        const options = call[2];
        const response = (stdout: string, status = 0, stderr = "") => ({
          pid: 1,
          status,
          signal: null,
          stdout,
          stderr,
          output: [null, stdout, stderr],
        });
        if (requestArgs.at(-1)?.endsWith("/github-etag-cache/lookup")) {
          lookups += 1;
          if (expiry === "before" && lookups === 2) f.state.now = deadlineAt;
          return response('{"hit":false}');
        }
        assert.equal(requestArgs[0], "api");
        assert.equal(requestArgs[1], "-i");
        if (options?.env?.GH_TOKEN === f.publicToken) {
          return response(
            "HTTP/2 403 Forbidden\n\n{}",
            1,
            "HTTP 403: API rate limit exceeded; retry-after: 60",
          );
        }
        assert.equal(options?.env?.GH_TOKEN, f.appToken);
        appDispatches += 1;
        if (expiry === "after" && appDispatches === 1) f.state.now = deadlineAt;
        return response('HTTP/2 200 OK\n\n{"ok":true}');
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      mock.mock.restore();
      syncBuiltinESMExports();
    });
    const unprojectedArgs = args.slice(0, 2);
    assert.throws(
      () => f.execution.ghJson(unprojectedArgs, { deadlineAt }),
      GitHubOperationDeadlineError,
    );
    assert.equal(appDispatches, expiry === "before" ? 0 : 1);
    assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), expiry === "after");
    if (expiry === "before") {
      assert.deepEqual(f.execution.ghJson(unprojectedArgs, { deadlineAt: f.state.now + 5_000 }), {
        ok: true,
      });
    } else {
      assert.throws(
        () => f.execution.ghJson(unprojectedArgs, { deadlineAt: f.state.now + 5_000 }),
        { name: "GitHubRateLimitError" },
      );
    }
    assert.equal(appDispatches, 1);
  });
}
