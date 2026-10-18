import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { githubJsonForTest } from "../dashboard/worker.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
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
  ]);
});
