import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type TestContext } from "node:test";
import * as execution from "../dist/clawsweeper-github-execution.js";
import * as runtime from "../dist/clawsweeper-github-runtime.js";
import type { GitHubRuntimeBudget } from "../src/clawsweeper-types.js";
import {
  githubTest as test,
  installEtagBroker,
  installGhFixture,
} from "./github-runtime-fixture.ts";

const args = ["api", "repos/openclaw/openclaw/issues/123", "--jq", "."];
const systemNow = Date.now;

function fixture(t: TestContext, label: string, source: string, publicFallback = false) {
  // A test can create several fixtures; do not stack mock-tracker restorations.
  t.after(() => {
    Date.now = systemNow;
  });
  const gh = installGhFixture(t, source);
  const metricsPath = join(gh.root, "metrics.jsonl");
  const observationPath = join(gh.root, "observations.jsonl");
  const appToken = `synthetic-${label}-app`;
  const publicToken = `synthetic-${label}-public`;
  const env: NodeJS.ProcessEnv = {
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
  });
  const started = performance.now();
  Date.now = () =>
    JSON.parse(readFileSync(gh.statePath, "utf8")).now + Math.floor(performance.now() - started);
  t.mock.method(console, "error", () => {});
  return {
    ...gh,
    observationPath,
    appToken,
    publicToken,
    advance(ms: number) {
      const state = JSON.parse(readFileSync(gh.statePath, "utf8"));
      state.now += ms;
      writeFileSync(gh.statePath, JSON.stringify(state));
    },
    metrics: () =>
      readFileSync(metricsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { outcome: string }),
    observations: () =>
      readFileSync(observationPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { provenance: string }),
  };
}

const throttledRead = `
  if (args[1] === "rate_limit") {
    process.stdout.write(JSON.stringify({ remaining: 0, reset: Math.floor(state.now / 1000) + 600 }));
  } else if (token === process.env.REPO_TOKEN) {
    throw new Error("HTTP 403: API rate limit exceeded");
  } else process.stdout.write('{"ok":true}');
`;

test("operation deadline intersects the outer budget without poisoning its yield state", (t) => {
  const f = fixture(t, "intersection", 'throw new Error("must not dispatch");');
  const now = Date.now();
  const budget: GitHubRuntimeBudget = { startedAtMs: now, maxRuntimeMs: 10_000 };
  const deadlineAt = now + 4_000;
  runtime.withGitHubRuntimeBudget(budget, () => {
    assert.ok(runtime.githubCommandTimeoutMs(20_000, deadlineAt)! <= 4_000);
    assert.doesNotThrow(() => runtime.ensureGitHubRetryFits(2_000, deadlineAt));
    assert.throws(
      () => runtime.ensureGitHubRetryFits(4_000, deadlineAt),
      runtime.GitHubOperationDeadlineError,
    );
    f.advance(4_000);
    assert.throws(
      () => runtime.githubCommandTimeoutMs(undefined, deadlineAt),
      runtime.GitHubOperationDeadlineError,
    );
    assert.ok(runtime.githubCommandTimeoutMs()! > 0);
    assert.equal(budget.yieldReason, undefined);
  });
  assert.equal(f.requests().length, 0);
});

test("local retry refusal preserves positive outer time when neither budget fits backoff", (t) => {
  fixture(t, "overlap", 'throw new Error("must not dispatch");');
  const budget: GitHubRuntimeBudget = { startedAtMs: Date.now(), maxRuntimeMs: 2_000 };
  runtime.withGitHubRuntimeBudget(budget, () => {
    assert.throws(
      () => runtime.ensureGitHubRetryFits(2_000, Date.now() + 500),
      runtime.GitHubOperationDeadlineError,
    );
    assert.equal(budget.yieldReason, undefined);
    assert.ok(runtime.githubCommandTimeoutMs()! > 0);
  });
});

for (const outerState of ["pending", "expired"] as const) {
  test(`local retry refusal preserves an already ${outerState} outer budget error`, (t) => {
    fixture(t, outerState, 'throw new Error("must not dispatch");');
    const budget: GitHubRuntimeBudget = {
      startedAtMs: Date.now() - (outerState === "expired" ? 20_000 : 0),
      maxRuntimeMs: 10_000,
      ...(outerState === "pending" ? { yieldReason: "prior outer refusal" } : {}),
    };
    runtime.withGitHubRuntimeBudget(budget, () => {
      assert.throws(
        () => runtime.ensureGitHubRetryFits(2_000, Date.now()),
        runtime.GitHubRuntimeBudgetError,
      );
      assert.match(
        budget.yieldReason ?? "",
        outerState === "pending" ? /prior outer refusal/ : /before GitHub retry/,
      );
    });
  });
}

test("transport and malformed JSON retries consume one deadline and preserve request accounting", (t) => {
  const f = fixture(
    t,
    "retries",
    `
    state.attempt = (state.attempt || 0) + 1;
    if (state.attempt === 1) throw new Error("HTTP 502: temporary failure");
    process.stdout.write(state.attempt === 2 ? "{" : '{"ok":true}');
  `,
  );
  const started = performance.now();
  assert.deepEqual(execution.ghJson(args, { deadlineAt: Date.now() + 15_000 }), { ok: true });
  assert.equal(f.requests().length, 3);
  assert.ok(performance.now() - started >= 4_000, "both real retry waits elapsed");
  assert.deepEqual(
    f.metrics().map(({ outcome }) => outcome),
    ["transient", "success", "success"],
  );
});

for (const failure of ["transport", "json"] as const) {
  test(`${failure} retry cannot spend the operation's remaining time on backoff`, (t) => {
    const f = fixture(
      t,
      failure,
      failure === "transport"
        ? 'throw new Error("HTTP 502: temporary failure");'
        : 'process.stdout.write("{");',
    );
    const budget: GitHubRuntimeBudget = { startedAtMs: Date.now(), maxRuntimeMs: 60_000 };
    runtime.withGitHubRuntimeBudget(budget, () => {
      assert.throws(
        () => execution.ghJson(args, { deadlineAt: Date.now() + 2_000 }),
        runtime.GitHubOperationDeadlineError,
      );
      assert.equal(budget.yieldReason, undefined);
    });
    assert.equal(f.requests().length, 1);
    assert.deepEqual(
      f.metrics().map(({ outcome }) => outcome),
      [failure === "transport" ? "transient" : "success"],
    );
  });
}

test("a response arriving after the operation deadline cannot start another attempt", (t) => {
  const f = fixture(t, "late", "state.now += 30_001; process.stdout.write('{\"ok\":true}');");
  assert.throws(
    () => execution.ghJson(args, { deadlineAt: Date.now() + 30_000 }),
    runtime.GitHubOperationDeadlineError,
  );
  assert.equal(f.requests().length, 1);
  assert.deepEqual(
    f.metrics().map(({ outcome }) => outcome),
    ["success"],
  );
});

test("rate-limit lookup and one App fallback share the remaining deadline", (t) => {
  const f = fixture(t, "fallback", throttledRead, true);
  const deadlineAt = Date.now() + 5_000;
  assert.deepEqual(execution.ghJson(args, { deadlineAt }), { ok: true });
  assert.deepEqual(
    f.requests().map(({ token }) => token),
    [f.publicToken, f.publicToken, f.appToken],
  );
  assert.equal(f.observations()[0]?.provenance, "fallback");
  assert.equal(f.observations().at(-1)?.provenance, "rate_limit_status");
  assert.deepEqual(
    f.metrics().map(({ outcome }) => outcome),
    ["throttle", "success", "success"],
  );
  assert.throws(() => execution.ghJson(args, { deadlineAt }), { name: "GitHubRateLimitError" });
  assert.equal(f.requests().length, 3);
});

test("expiry records throttling without claiming an unused lookup or fallback", (t) => {
  const f = fixture(
    t,
    "expired",
    `
    if (!state.expired) { state.expired = true; state.now += 30_001; }
    ${throttledRead}
  `,
    true,
  );
  const budget: GitHubRuntimeBudget = { startedAtMs: Date.now(), maxRuntimeMs: 180_000 };
  runtime.withGitHubRuntimeBudget(budget, () => {
    assert.throws(
      () => execution.ghJson(args, { deadlineAt: Date.now() + 30_000 }),
      runtime.GitHubOperationDeadlineError,
    );
    assert.equal(budget.yieldReason, undefined);
    assert.equal(f.requests().length, 1);
    assert.equal(existsSync(`${f.observationPath}.lookup-repository_actions.lock`), false);
    assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), false);
    assert.equal(f.observations()[0]?.provenance, "fallback");
    f.advance(61_000);
    assert.deepEqual(execution.ghJson(args, { deadlineAt: Date.now() + 5_000 }), { ok: true });
    assert.equal(f.requests().length, 4);
  });
});

for (const claimKind of ["lookup-repository_actions", "fallback-target_app"] as const) {
  test(`an undispatched ${claimKind} releases its filesystem reservation`, (t) => {
    const source = claimKind.startsWith("lookup")
      ? throttledRead
      : 'if (token === process.env.REPO_TOKEN) throw new Error("HTTP 403: API rate limit exceeded; retry-after: 60"); process.stdout.write(\'{"ok":true}\');';
    const f = fixture(t, claimKind, source, true);
    const deadlineAt = Date.now() + 5_000;
    const lockPath = `${f.observationPath}.${claimKind}.lock`;
    const clock = Date.now;
    let expired = false;
    Date.now = () => {
      if (!expired && existsSync(lockPath)) {
        expired = true;
        f.advance(6_000);
      }
      return clock();
    };
    assert.throws(
      () => execution.ghJson(args, { deadlineAt }),
      runtime.GitHubOperationDeadlineError,
    );
    assert.equal(existsSync(lockPath), false);
    assert.equal(f.requests().length, 1);
    f.advance(61_000);
    assert.deepEqual(execution.ghJson(args, { deadlineAt: Date.now() + 5_000 }), { ok: true });
    assert.equal(existsSync(lockPath), true);
  });
}

for (const outcome of ["success", "failure"] as const) {
  test(`a dispatched lookup's late ${outcome} retains its one-shot scope and lock`, (t) => {
    const f = fixture(
      t,
      `lookup-${outcome}`,
      `
      if (args[1] === "rate_limit") {
        state.now += 5_000;
        ${outcome === "failure" ? 'throw new Error("HTTP 502: operation timed out");' : "process.stdout.write(JSON.stringify({ remaining: 0, reset: Math.floor(state.now / 1000) + 600 }));"}
      } else if (token === process.env.REPO_TOKEN) throw new Error("HTTP 403: API rate limit exceeded");
      else process.stdout.write('{"ok":true}');
    `,
      true,
    );
    assert.throws(
      () => execution.ghJson(args, { deadlineAt: Date.now() + 5_000 }),
      runtime.GitHubOperationDeadlineError,
    );
    assert.equal(f.requests().length, 2);
    assert.equal(existsSync(`${f.observationPath}.lookup-repository_actions.lock`), true);
    assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), false);
    assert.deepEqual(
      f.metrics().map(({ outcome }) => outcome),
      ["throttle", outcome === "success" ? "success" : "transient"],
    );
    assert.deepEqual(execution.ghJson(args, { deadlineAt: Date.now() + 5_000 }), { ok: true });
    assert.equal(f.requests().filter(({ args }) => args[1] === "rate_limit").length, 1);
  });

  test(`a late dispatched App ${outcome} retains the one-shot claim`, (t) => {
    const f = fixture(
      t,
      `app-${outcome}`,
      `
      if (token === process.env.REPO_TOKEN) throw new Error("HTTP 403: API rate limit exceeded; retry-after: 60");
      state.now += 5_000;
      ${outcome === "failure" ? 'throw new Error("HTTP 502: temporary failure");' : "process.stdout.write('{\"ok\":true}');"}
    `,
      true,
    );
    assert.throws(
      () => execution.ghJson(args, { deadlineAt: Date.now() + 5_000 }),
      runtime.GitHubOperationDeadlineError,
    );
    assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), true);
    assert.throws(() => execution.ghJson(args, { deadlineAt: Date.now() + 5_000 }), {
      name: "GitHubRateLimitError",
    });
    assert.equal(f.requests().filter(({ token }) => token === f.appToken).length, 1);
  });
}

test("callers without an operation deadline retain ordinary retries", (t) => {
  const f = fixture(
    t,
    "unbounded",
    'state.attempt = (state.attempt || 0) + 1; if (state.attempt === 1) throw new Error("HTTP 502: temporary failure"); process.stdout.write(\'{"ok":true}\');',
  );
  assert.deepEqual(execution.ghJson(args), { ok: true });
  assert.equal(f.requests().length, 2);
});

test("fallback rollback never removes a replaced lock or clears its exclusion", (t) => {
  const f = fixture(t, "replaced", 'throw new Error("must not dispatch");', true);
  const claim = runtime.claimPublicReadFallback(args);
  assert.ok(claim);
  const lock = `${f.observationPath}.fallback-target_app.lock`;
  renameSync(lock, `${lock}.original`);
  writeFileSync(lock, "replacement owner");
  assert.equal(claim.releaseIfUndispatched(), false);
  assert.equal(readFileSync(lock, "utf8"), "replacement owner");
  process.env.CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH = `${f.observationPath}.other`;
  assert.equal(runtime.claimPublicReadFallback(args), null);
});

for (const expiry of ["before", "after"] as const) {
  test(`ETag fallback expiry ${expiry} GitHub dispatch preserves claim ownership`, async (t) => {
    const f = fixture(
      t,
      `etag-${expiry}`,
      `
      if (token === process.env.REPO_TOKEN) {
        process.stdout.write("HTTP/2 403 Forbidden\\n\\n{}");
        throw new Error("HTTP 403: API rate limit exceeded; retry-after: 60");
      }
      ${expiry === "after" ? "state.now += 5_000;" : ""}
      process.stdout.write('HTTP/2 200 OK\\n\\n{"ok":true}');
    `,
      true,
    );
    await installEtagBroker(
      t,
      f.root,
      expiry === "before"
        ? `
      if (operation === "lookup" && lookups === 2) {
        const path = join(root, "state.json");
        const state = JSON.parse(readFileSync(path, "utf8")); state.now += 5_000;
        writeFileSync(path, JSON.stringify(state));
      }
    `
        : "",
    );
    assert.throws(
      () => execution.ghJson(args.slice(0, 2), { deadlineAt: Date.now() + 5_000 }),
      runtime.GitHubOperationDeadlineError,
    );
    assert.equal(
      f.requests().filter(({ token }) => token === f.appToken).length,
      expiry === "before" ? 0 : 1,
    );
    assert.equal(existsSync(`${f.observationPath}.fallback-target_app.lock`), expiry === "after");
    if (expiry === "before")
      assert.deepEqual(execution.ghJson(args.slice(0, 2), { deadlineAt: Date.now() + 5_000 }), {
        ok: true,
      });
    else
      assert.throws(() => execution.ghJson(args.slice(0, 2), { deadlineAt: Date.now() + 5_000 }), {
        name: "GitHubRateLimitError",
      });
    assert.equal(f.requests().filter(({ token }) => token === f.appToken).length, 1);
  });
}

test("ghJsonEach dispatches first attempts together and retries only transient failures", (t) => {
  const f = fixture(
    t,
    "concurrent",
    `
    const number = Number(args[1].split("/").at(-1));
    const marker = join(root, "attempt-" + number);
    const retry = existsSync(marker);
    writeFileSync(marker, "started");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (number === 2 && !retry) throw new Error("HTTP 502: Bad Gateway");
    if (number === 3) throw new Error("HTTP 404: Not Found");
    process.stdout.write(JSON.stringify({ number }));
  `,
  );
  const requests = [1, 2, 3].map((number) => ["api", `repos/openclaw/openclaw/issues/${number}`]);
  const results = execution.ghJsonEach(requests);
  assert.deepEqual(results.slice(0, 2), [
    { ok: true, value: { number: 1 } },
    { ok: true, value: { number: 2 } },
  ]);
  assert.ok(results[2] && !results[2].ok);
  assert.match(String(results[2].error), /HTTP 404/);
  const dispatched = f.requests();
  assert.equal(dispatched.length, 4);
  assert.equal(dispatched[3]?.args[1], requests[1]?.[1]);
  assert.ok(
    Math.max(...dispatched.slice(0, 3).map(({ at }) => at)) -
      Math.min(...dispatched.slice(0, 3).map(({ at }) => at)) <
      1_000,
  );
  const exhausted = runtime.withGitHubRuntimeBudget(
    { startedAtMs: Date.now() - 20_000, maxRuntimeMs: 15_000 },
    () => execution.ghJsonEach(requests),
  );
  assert.ok(
    exhausted.every(
      (result) => !result.ok && result.error instanceof runtime.GitHubRuntimeBudgetError,
    ),
  );
  assert.equal(f.requests().length, 4);
});

test("queued concurrent reads expire without dispatch when the shared deadline drains", (t) => {
  const gh = installGhFixture(
    t,
    `
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
    process.stdout.write("{}");
  `,
  );
  const requests = Array.from({ length: runtime.GITHUB_CONCURRENT_READS + 1 }, (_, index) => [
    "api",
    "repos/openclaw/openclaw/issues/" + (index + 1),
    "--jq",
    ".",
  ]);
  const budget: GitHubRuntimeBudget = { startedAtMs: Date.now(), maxRuntimeMs: 3_000 };
  const results = runtime.withGitHubRuntimeBudget(budget, () => execution.ghJsonEach(requests));
  assert.ok(gh.requests().length > 0);
  assert.ok(gh.requests().length <= runtime.GITHUB_CONCURRENT_READS);
  const queued = results.at(-1);
  assert.ok(queued && !queued.ok && queued.error instanceof runtime.GitHubRuntimeBudgetError);
  assert.match(budget.yieldReason ?? "", /before GitHub operation/);
});

test("a hung gh process is bounded by the operation deadline without yielding the outer budget", (t) => {
  const f = fixture(
    t,
    "hung",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);",
  );
  const budget: GitHubRuntimeBudget = { startedAtMs: Date.now(), maxRuntimeMs: 60_000 };
  const started = performance.now();
  runtime.withGitHubRuntimeBudget(budget, () => {
    assert.throws(
      () => execution.ghJson(args, { deadlineAt: Date.now() + 5_000 }),
      runtime.GitHubOperationDeadlineError,
    );
    assert.equal(budget.yieldReason, undefined);
  });
  assert.equal(f.requests().length, 1);
  assert.ok(
    performance.now() - started < 20_000,
    "the child must not consume its thirty-second sleep",
  );
});
