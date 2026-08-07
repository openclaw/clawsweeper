import assert from "node:assert/strict";
import test from "node:test";

import {
  ghJson,
  ghJsonWithRetry,
  ghJsonWithRetryAsync,
  ghSpawn,
  githubLimitedPagePath,
  githubPaginatedPath,
} from "../../dist/repair/github-cli.js";

test("githubPaginatedPath requests maximum REST page size by default", () => {
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues/123/comments"),
    "repos/openclaw/openclaw/issues/123/comments?per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?state=open&sort=created"),
    "repos/openclaw/openclaw/issues?state=open&sort=created&per_page=100",
  );
  assert.equal(
    githubPaginatedPath("repos/openclaw/openclaw/issues?per_page=50&state=open"),
    "repos/openclaw/openclaw/issues?per_page=50&state=open",
  );
});

test("githubLimitedPagePath caps one REST page and preserves existing filters", () => {
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 80),
    "repos/openclaw/openclaw/pulls/123/files?per_page=80&page=1",
  );
  assert.equal(
    githubLimitedPagePath(
      "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100",
      250,
      3,
    ),
    "repos/openclaw/openclaw/pulls/123/files?state=open&per_page=100&page=3",
  );
  assert.equal(
    githubLimitedPagePath("repos/openclaw/openclaw/pulls/123/files", 0, 0),
    "repos/openclaw/openclaw/pulls/123/files?per_page=1&page=1",
  );
});

test("public target reads preserve GitHub App mutations and every explicit credential", async () => {
  const fixtureEnv = {
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([
      "--eval",
      "process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN, args: process.argv.slice(1) }))",
      "--",
    ]),
    GH_TOKEN: "app-mutation-token",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "public-read-token",
  };
  const previous = Object.fromEntries(
    Object.keys(fixtureEnv).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, fixtureEnv);

  const observed = (args: string[], options?: { env?: NodeJS.ProcessEnv; input?: string }) =>
    ghJson<{ token: string; args: string[] }>(args, options);

  try {
    for (const args of [
      ["api", "repos/openclaw/openclaw/issues/comments/123"],
      ["api", "repos/openclaw/openclaw/issues/123"],
      ["api", "repos/openclaw/openclaw/issues?state=open&per_page=100"],
      ["api", "repos/openclaw/openclaw/issues/123/comments?per_page=100", "--paginate", "--slurp"],
      ["api", "repos/openclaw/openclaw/pulls/123/reviews?per_page=100"],
      ["api", "repos/openclaw/openclaw/pulls/123", "--jq", ".requested_reviewers"],
    ]) {
      assert.equal(observed(args).token, "public-read-token", args.join(" "));
    }

    assert.equal(
      (await ghJsonWithRetryAsync<{ token: string }>(["api", "repos/openclaw/openclaw/issues/123"]))
        .token,
      "public-read-token",
    );

    for (const args of [
      ["api", "user"],
      ["api", "repos/openclaw/openclaw/collaborators/person/permission"],
      ["api", "repos/openclaw/clawsweeper/issues/123"],
      ["api", "repos/private/secret/issues/123"],
      ["api", "https://api.github.com/repos/openclaw/openclaw/issues/123"],
      ["api", "repos/openclaw/openclaw/issues/../../clawsweeper/issues/123"],
      ["api", "repos/openclaw/openclaw/issues/%2e%2e/clawsweeper"],
      ["api", "repos/openclaw/openclaw/issues%2f123"],
      ["api", "repos/openclaw/openclaw/issues\\123"],
      ["api", "repos/openclaw/openclaw/issues/123", "--method", "GET"],
      ["api", "repos/openclaw/openclaw/issues/123", "--method", "POST"],
      ["api", "repos/openclaw/openclaw/issues/123", "--method=DELETE"],
      ["api", "repos/openclaw/openclaw/issues/123", "-X", "PATCH"],
      ["api", "repos/openclaw/openclaw/issues/123", "-XDELETE"],
      ["api", "repos/openclaw/openclaw/issues/123", "-f", "body=mutated"],
      ["api", "repos/openclaw/openclaw/issues/123", "-F", "body=mutated"],
      ["api", "repos/openclaw/openclaw/issues/123", "--field=body=mutated"],
      ["api", "repos/openclaw/openclaw/issues/123", "--raw-field", "body=mutated"],
      ["api", "repos/openclaw/openclaw/issues/123", "--input", "payload.json"],
      ["api", "repos/openclaw/openclaw/issues/123", "--header", "X-HTTP-Method-Override: DELETE"],
      ["api", "repos/openclaw/openclaw/issues/123", "--hostname", "example.invalid"],
      ["api", "repos/openclaw/openclaw/issues/123", "--jq"],
      ["pr", "view", "123", "--repo", "openclaw/openclaw"],
    ]) {
      assert.equal(observed(args).token, "app-mutation-token", args.join(" "));
    }

    const publicArgs = ["api", "repos/openclaw/openclaw/issues/comments/123"];
    assert.equal(
      observed(publicArgs, { env: { GH_TOKEN: "explicit-dispatch-token" } }).token,
      "explicit-dispatch-token",
    );
    assert.equal(
      observed(publicArgs, { env: { GITHUB_TOKEN: "explicit-token" } }).token,
      "app-mutation-token",
    );
    assert.equal(observed(publicArgs, { input: "request body" }).token, "app-mutation-token");

    const spawned = ghSpawn(publicArgs);
    assert.equal(JSON.parse(spawned.stdout).token, "app-mutation-token");

    delete process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN;
    assert.equal(observed(publicArgs).token, "app-mutation-token");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("public read throttles fall back once to the target App token", async () => {
  const fixtureEnv = {
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([
      "--eval",
      [
        'if (process.env.GH_TOKEN?.startsWith("public-read-token")) {',
        '  process.stderr.write("gh: API rate limit exceeded for installation (HTTP 403)\\n");',
        "  process.exit(1);",
        "}",
        "process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN }));",
      ].join("\n"),
      "--",
    ]),
    GH_TOKEN: "app-mutation-token",
    CLAWSWEEPER_PUBLIC_GH_TOKEN: "public-read-token",
  };
  const previous = Object.fromEntries(
    Object.keys(fixtureEnv).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, fixtureEnv);

  try {
    const args = ["api", "repos/openclaw/openclaw/issues/123"];
    assert.equal(ghJsonWithRetry<{ token: string }>(args).token, "app-mutation-token");
    assert.throws(() => ghJsonWithRetry(args), { name: "GitHubRateLimitError" });

    process.env.GH_TOKEN = "app-mutation-token-async";
    process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN = "public-read-token-async";
    assert.equal(
      (await ghJsonWithRetryAsync<{ token: string }>(args)).token,
      "app-mutation-token-async",
    );

    process.env.GH_TOKEN = "app-mutation-token";
    process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN = "public-read-token";
    assert.equal(
      ghJsonWithRetry<{ token: string }>(
        ["api", "--method", "POST", "repos/openclaw/openclaw/issues/123/labels"],
        { input: "{}" },
      ).token,
      "app-mutation-token",
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
