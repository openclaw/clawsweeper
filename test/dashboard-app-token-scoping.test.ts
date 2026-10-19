import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { githubGraphqlForTest, githubJsonForTest } from "../dashboard/worker.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

test("dashboard evicts revoked cached tokens and retries only the rejected scope once", async (t) => {
  const mints: unknown[] = [];
  const reads: string[] = [];
  let revoked = false;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).endsWith("/access_tokens")) {
      mints.push(JSON.parse(String(init.body)));
      return Response.json({ token: `revocation-${mints.length}` });
    }
    const bearer = new Headers(init.headers).get("authorization")!;
    reads.push(bearer);
    return Response.json({}, { status: revoked && bearer === "Bearer revocation-1" ? 401 : 200 });
  });
  const env = appEnv("revocation");
  const alpha = "/repos/openclaw/alpha/issues/1";
  const beta = "/repos/openclaw/beta/issues/1";
  await githubJsonForTest(env, alpha);
  await githubJsonForTest(env, beta);
  revoked = true;
  await githubJsonForTest(env, alpha);
  await githubJsonForTest(env, alpha);
  await githubJsonForTest(env, beta);
  assert.deepEqual(mints, [
    { repositories: ["alpha"], permissions: { issues: "read" } },
    { repositories: ["beta"], permissions: { issues: "read" } },
    { repositories: ["alpha"], permissions: { issues: "read" } },
  ]);
  assert.deepEqual(
    reads,
    [1, 2, 1, 3, 3, 2].map((id) => `Bearer revocation-${id}`),
  );
});

test("dashboard fails closed after one unauthorized retry and discards its rejected replacement", async (t) => {
  let mints = 0;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).endsWith("/access_tokens")) {
      return Response.json({ token: `rejected-${++mints}` });
    }
    reads += 1;
    return Response.json({}, { status: 401 });
  });
  const env = appEnv("rejected");
  const path = "/repos/openclaw/alpha/issues/1";
  await assert.rejects(githubJsonForTest(env, path), /GitHub 401/);
  assert.equal(mints, 2);
  assert.equal(reads, 2);
  await assert.rejects(githubJsonForTest(env, path), /GitHub 401/);
  assert.equal(mints, 4);
  assert.equal(reads, 4);
});

test("dashboard does not retry permission failures or replace a supplied token", async (t) => {
  let mints = 0;
  let reads = 0;
  let responseStatus = 403;
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).endsWith("/access_tokens"))
      return Response.json({ token: `denied-${++mints}` });
    reads += 1;
    return Response.json({}, { status: responseStatus });
  });
  const env = appEnv("denied");
  const path = "/repos/openclaw/alpha/issues/1";
  await assert.rejects(githubJsonForTest(env, path), /GitHub 403/);
  assert.equal(mints, 1);
  assert.equal(reads, 1);
  responseStatus = 401;
  await assert.rejects(
    githubJsonForTest({ ...env, GITHUB_TOKEN: "supplied-fixture" }, path),
    /GitHub 401/,
  );
  assert.equal(mints, 1);
  assert.equal(reads, 2);
});

test("a delayed unauthorized response cannot evict a concurrently refreshed token", async (t) => {
  let mints = 0;
  let revoked = false;
  let releaseLate!: () => void;
  let observedLate!: () => void;
  const lateStarted = new Promise<void>((resolve) => {
    observedLate = resolve;
  });
  const lateResponse = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).endsWith("/access_tokens"))
      return Response.json({ token: `racing-${++mints}` });
    const bearer = new Headers(init.headers).get("authorization")!;
    reads.push(bearer);
    if (revoked && bearer === "Bearer racing-1") {
      if (String(input).endsWith("/2")) {
        observedLate();
        await lateResponse;
      }
      return Response.json({}, { status: 401 });
    }
    return Response.json({});
  });
  const env = appEnv("racing");
  await githubJsonForTest(env, "/repos/openclaw/alpha/issues/1");
  revoked = true;
  const late = githubJsonForTest(env, "/repos/openclaw/alpha/issues/2");
  await lateStarted;
  await githubJsonForTest(env, "/repos/openclaw/alpha/issues/3");
  releaseLate();
  await late;
  await githubJsonForTest(env, "/repos/openclaw/alpha/issues/4");
  assert.equal(mints, 2);
  assert.deepEqual(
    reads,
    [1, 1, 1, 2, 2, 2].map((id) => `Bearer racing-${id}`),
  );
});

function appEnv(suffix: string) {
  return {
    CLAWSWEEPER_APP_CLIENT_ID: `Iv23scope-${suffix}`,
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_APP_INSTALLATION_ID: "123",
  };
}

test("dashboard GraphQL refreshes rejected credentials with the same query and scope", async (t) => {
  const mints: unknown[] = [];
  const queries: unknown[] = [];
  const bearers: string[] = [];
  let revoked = false;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).endsWith("/access_tokens")) {
      mints.push(JSON.parse(String(init.body)));
      return Response.json({ token: `graphql-${mints.length}` });
    }
    assert.equal(new URL(String(input)).pathname, "/graphql");
    assert.equal(init.method, "POST");
    queries.push(JSON.parse(String(init.body)));
    const bearer = new Headers(init.headers).get("authorization")!;
    bearers.push(bearer);
    return Response.json(
      { data: { repository: {} } },
      {
        status: revoked && bearer === "Bearer graphql-1" ? 401 : 200,
      },
    );
  });
  const env = appEnv("graphql");
  const query =
    "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { name } }";
  const variables = { owner: "openclaw", name: "alpha" };
  await githubGraphqlForTest(env, query, variables);
  revoked = true;
  assert.deepEqual(await githubGraphqlForTest(env, query, variables), { repository: {} });
  assert.deepEqual(
    mints,
    Array(2).fill({
      repositories: ["alpha"],
      permissions: { issues: "read", pull_requests: "read" },
    }),
  );
  assert.deepEqual(queries, Array(3).fill({ query, variables }));
  assert.deepEqual(bearers, ["Bearer graphql-1", "Bearer graphql-1", "Bearer graphql-2"]);
});

test("dashboard token mints bind repository and permission sets and reuse only identical scopes", async (t) => {
  const mints: unknown[] = [];
  const bearers: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/access_tokens")) {
      mints.push(JSON.parse(String(init.body)));
      return Response.json({
        token: `fixture-${mints.length}`,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    }
    bearers.push(new Headers(init.headers).get("authorization")!);
    return Response.json({});
  });
  const env = {
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23scope-test",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_APP_INSTALLATION_ID: "123",
    TRIAGE_TARGET_REPOS: "openclaw/beta,openclaw/alpha,openclaw/beta",
  };
  for (const path of [
    "/repos/openclaw/alpha/issues/1",
    "/repos/openclaw/alpha/issues/2",
    "/repos/openclaw/beta/issues/1",
    "/repos/openclaw/alpha/actions/runs",
    "/repos/openclaw/alpha/commits/abc/check-runs",
    "/repos/openclaw/alpha/contents/README.md",
    "/repos/openclaw/alpha/pulls/1",
    "/search/issues?q=fixture",
  ])
    await githubJsonForTest(env, path);
  await githubJsonForTest(
    { ...env, TRIAGE_TARGET_REPOS: "openclaw/alpha,openclaw/beta" },
    "/search/issues?q=another",
  );
  await githubJsonForTest(env, "/search/issues?q=repo:openclaw/proof-only%20is:pr");
  await githubJsonForTest(env, "/search/issues?q=repo:openclaw/alpha%20is:issue");
  await githubJsonForTest(
    env,
    "/search/issues?q=repo:openclaw/alpha%20is:issue%20label:%22triage:%20repo:openclaw/extra%20is:pr%20%22",
  );
  assert.deepEqual(mints, [
    { repositories: ["alpha"], permissions: { issues: "read" } },
    { repositories: ["beta"], permissions: { issues: "read" } },
    { repositories: ["alpha"], permissions: { actions: "read" } },
    { repositories: ["alpha"], permissions: { checks: "read" } },
    { repositories: ["alpha"], permissions: { contents: "read" } },
    { repositories: ["alpha"], permissions: { pull_requests: "read" } },
    { repositories: ["alpha", "beta"], permissions: { issues: "read", pull_requests: "read" } },
    { repositories: ["proof-only"], permissions: { pull_requests: "read" } },
  ]);
  assert.deepEqual(bearers, [
    "Bearer fixture-1",
    "Bearer fixture-1",
    "Bearer fixture-2",
    "Bearer fixture-3",
    "Bearer fixture-4",
    "Bearer fixture-5",
    "Bearer fixture-6",
    "Bearer fixture-7",
    "Bearer fixture-7",
    "Bearer fixture-8",
    "Bearer fixture-1",
    "Bearer fixture-1",
  ]);
});
