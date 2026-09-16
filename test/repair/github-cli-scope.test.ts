import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { GitHubRateLimitError } from "../../dist/github-retry.js";
import {
  ghPagedLimitWithRetry,
  ghStdoutFromError,
  ghText,
  ghTextAsync,
  ghTextWithRetry,
  ghTextWithRetryAsync,
} from "../../dist/repair/github-cli.js";

const publicArgs = ["api", "repos/openclaw/openclaw/issues/123"];
const throttle =
  'process.stdout.write(\'{"message":"limited"}\'); process.stderr.write("gh: rate limit exceeded (HTTP 429)\\n"); process.exit(1);';

function fixture(t: TestContext, script = throttle) {
  const label = t.name.replaceAll(/[^a-z0-9]/gi, "-");
  const app = "synthetic-" + label + "-app";
  const actions = "synthetic-" + label + "-actions";
  const repository = "synthetic-" + label + "-repository";
  const env: NodeJS.ProcessEnv = {
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify(["--eval", script, "--"]),
    GH_TOKEN: app,
    GITHUB_TOKEN: repository,
    REPO_TOKEN: repository,
    CLAWSWEEPER_PUBLIC_GH_TOKEN: actions,
    GH_HOST: undefined,
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
  return { app, actions, repository };
}

function assertScope(error: unknown, scope: "repository_actions" | "target_app"): boolean {
  assert.ok(error instanceof GitHubRateLimitError);
  assert.equal(error.scope, scope);
  assert.match(error.message, new RegExp("credential scope " + scope));
  assert.ok(error.cause instanceof Error);
  assert.equal(ghStdoutFromError(error.cause), '{"message":"limited"}');
  assert.match(String((error.cause as Error & { stderr: string }).stderr), /HTTP 429/);
  assert.equal(error.provenance, "fallback");
  assert.equal(error.authoritative, false);
  return true;
}

for (const mode of ["sync", "async"] as const) {
  test(mode + " throttles retain the prepared credential precedence", async (t) => {
    const f = fixture(t);
    const cases: Array<{ env: NodeJS.ProcessEnv; scope: "repository_actions" | "target_app" }> = [
      { env: { GH_TOKEN: f.actions }, scope: "repository_actions" },
      { env: { GH_TOKEN: f.repository }, scope: "repository_actions" },
      { env: { GH_TOKEN: f.app }, scope: "target_app" },
      {
        env: { GH_TOKEN: "synthetic-explicit-app", GITHUB_TOKEN: f.repository },
        scope: "target_app",
      },
      { env: { GH_TOKEN: "", GITHUB_TOKEN: f.repository }, scope: "repository_actions" },
      { env: { GH_TOKEN: " ", GITHUB_TOKEN: f.repository }, scope: "target_app" },
      { env: { GITHUB_TOKEN: f.repository }, scope: "target_app" },
    ];
    for (const { env, scope } of cases) {
      const options = { env, attempts: 1 };
      if (mode === "sync") {
        assert.throws(
          () => ghTextWithRetry(publicArgs, options),
          (error) => assertScope(error, scope),
        );
      } else {
        await assert.rejects(ghTextWithRetryAsync(publicArgs, options), (error) =>
          assertScope(error, scope),
        );
      }
    }
  });

  test(mode + " alternate host selections retain legacy attribution", async (t) => {
    const f = fixture(t);
    const cases = [
      { args: publicArgs, host: "enterprise.example.invalid" },
      { args: [...publicArgs, "--hostname", "enterprise.example.invalid"], host: "github.com" },
      { args: [...publicArgs, "--hostname=enterprise.example.invalid"], host: "github.com" },
      { args: [...publicArgs, "--hostname=github.com"], host: "github.com" },
      { args: ["api", "https://enterprise.example.invalid/api/v3/user"], host: "github.com" },
      { args: ["api", "https://api.github.com/user"], host: "github.com" },
      {
        args: ["pr", "view", "1", "--repo", "enterprise.example.invalid/org/repo"],
        host: "github.com",
      },
    ];
    for (const { args, host } of cases) {
      const options = {
        attempts: 1,
        env: { GH_HOST: host, GH_TOKEN: f.actions, GH_ENTERPRISE_TOKEN: "synthetic-enterprise" },
      };
      if (mode === "sync") {
        assert.throws(
          () => ghTextWithRetry(args, options),
          (error) => assertScope(error, "target_app"),
        );
      } else {
        await assert.rejects(ghTextWithRetryAsync(args, options), (error) =>
          assertScope(error, "target_app"),
        );
      }
    }
  });

  test(mode + " an exhausted App fallback reports the App and cannot be reclaimed", async (t) => {
    fixture(t);
    if (mode === "sync") {
      assert.throws(
        () => ghTextWithRetry(publicArgs, 1),
        (error) => assertScope(error, "target_app"),
      );
      assert.throws(
        () => ghTextWithRetry(publicArgs, 1),
        (error) => assertScope(error, "repository_actions"),
      );
    } else {
      await assert.rejects(ghTextWithRetryAsync(publicArgs, 1), (error) =>
        assertScope(error, "target_app"),
      );
      await assert.rejects(ghTextWithRetryAsync(publicArgs, 1), (error) =>
        assertScope(error, "repository_actions"),
      );
    }
  });

  test(
    mode + " successful fallback leaves later public throttles attributed to Actions",
    async (t) => {
      fixture(
        t,
        'if (process.env.GH_TOKEN?.endsWith("-app")) process.stdout.write("recovered"); else { ' +
          throttle +
          " }",
      );
      if (mode === "sync") {
        assert.equal(ghTextWithRetry(publicArgs, 1), "recovered");
        assert.throws(
          () => ghTextWithRetry(publicArgs, 1),
          (error) => assertScope(error, "repository_actions"),
        );
      } else {
        assert.equal(await ghTextWithRetryAsync(publicArgs, 1), "recovered");
        await assert.rejects(ghTextWithRetryAsync(publicArgs, 1), (error) =>
          assertScope(error, "repository_actions"),
        );
      }
    },
  );
}

test("limited pagination attributes the failing later page without replacing its native error", (t) => {
  const f = fixture(t);
  const nativeError = Object.freeze(
    Object.assign(new Error("HTTP 429"), {
      stdout: '{"message":"limited"}',
      stderr: "gh: rate limit exceeded (HTTP 429)",
      output: [null, '{"message":"limited"}', "gh: rate limit exceeded (HTTP 429)"],
    }),
  );
  const requests: string[][] = [];
  t.mock.method(childProcess, "execFileSync", (_command, args, options) => {
    requests.push(args);
    assert.equal(options.env.GH_TOKEN, f.actions);
    if (new URL(args.at(-1)!, "https://api.github.com/").searchParams.get("page") === "1")
      return JSON.stringify(Array.from({ length: 100 }, () => ({})));
    throw nativeError;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.throws(
    () => ghPagedLimitWithRetry("repos/openclaw/openclaw/issues/123/comments", 101, 1),
    (error) => {
      assertScope(error, "repository_actions");
      assert.equal((error as Error).cause, nativeError);
      return true;
    },
  );
  assert.equal(requests.length, 2);
  assert.match(requests[1]!.at(-1)!, /per_page=100&page=2$/);
});

test("raw sync failures retain their exact object and output fields", (t) => {
  fixture(t);
  const nativeError = Object.freeze(
    Object.assign(new Error("HTTP 404: Not Found"), {
      stdout: '{"message":"Not Found"}',
      stderr: "gh: Not Found (HTTP 404)",
      output: [null, '{"message":"Not Found"}', "gh: Not Found (HTTP 404)"],
    }),
  );
  t.mock.method(childProcess, "execFileSync", () => {
    throw nativeError;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.throws(
    () => ghText(publicArgs),
    (error) => error === nativeError,
  );
  assert.throws(
    () => ghTextWithRetry(publicArgs, 1),
    (error) => error === nativeError,
  );
  assert.equal(ghStdoutFromError(nativeError), '{"message":"Not Found"}');
  assert.equal(Object.isFrozen(nativeError), true);
});

test("async failures keep dispatch-time identity when ambient tokens change in flight", async (t) => {
  const f = fixture(t, "setTimeout(() => { " + throttle + " }, 30);");
  const pending = ghTextWithRetryAsync(publicArgs, { attempts: 1, env: { GH_TOKEN: f.actions } });
  process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN = "synthetic-later-actions";
  process.env.REPO_TOKEN = "synthetic-later-repository";
  process.env.GITHUB_TOKEN = "synthetic-later-github";
  await assert.rejects(pending, (error) => assertScope(error, "repository_actions"));
});

test("raw async and input-bearing failures retain native diagnostics", async (t) => {
  const f = fixture(t);
  const options = { env: { GH_TOKEN: f.actions } };
  await assert.rejects(ghTextAsync(publicArgs, options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.notEqual(error.name, "GitHubRateLimitError");
    assert.equal(ghStdoutFromError(error), '{"message":"limited"}');
    assert.match(String((error as Error & { stderr: string }).stderr), /HTTP 429/);
    return true;
  });
  await assert.rejects(
    ghTextWithRetryAsync(publicArgs, { ...options, input: "{}", attempts: 1 }),
    (error) => assertScope(error, "repository_actions"),
  );
});
