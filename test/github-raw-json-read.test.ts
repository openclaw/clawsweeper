import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { ghJson } from "../dist/clawsweeper-github-execution.js";
import { rawGitHubJsonRead } from "../dist/github-raw-json-read.js";
import { githubTest as test, installGhFixture } from "./github-runtime-fixture.ts";
import { mockCommandBinEnv } from "./helpers.ts";

const args = ["api", "repos/openclaw/openclaw/issues/comments/20"];

function installReadFixture(
  t: TestContext,
  responses: Array<{ status?: number; body: unknown; headers?: string; exit?: number }>,
) {
  const gh = installGhFixture(
    t,
    `if (args[0] === "auth") {
      if (args.at(-1) === "github.com") console.log("synthetic-config-token");
      else if (args.at(-1) === "a.example") console.log("synthetic-a-token");
      else if (args.at(-1) === "broken.example") { console.error("keyring unavailable"); process.exit(2); }
      else { console.error("no oauth token found for " + args.at(-1)); process.exit(1); }
    } else console.log(JSON.stringify({ resources: { core: { remaining: 0, reset: 1900000000 } } }));`,
  );
  const statePath = join(gh.root, "raw.json");
  writeFileSync(statePath, JSON.stringify({ responses, requests: [] }));
  const script = join(gh.root, "curl.cjs");
  writeFileSync(
    script,
    `
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const response = state.responses[Math.min(state.requests.length, state.responses.length - 1)];
state.requests.push({ args: process.argv.slice(2), headers: fs.readFileSync(0, "utf8") });
fs.writeFileSync(statePath, JSON.stringify(state));
if (response.exit) process.exit(response.exit);
process.stdout.write("HTTP/1.1 " + (response.status || 200) + " Status\\r\\nContent-Type: application/json\\r\\n" + (response.headers || "") + "\\r\\n" + JSON.stringify(response.body));
`,
  );
  const previous = {
    CURL_BIN: process.env.CURL_BIN,
    CURL_BIN_ARGS: process.env.CURL_BIN_ARGS,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
  };
  process.env.GH_CONFIG_DIR = gh.root;
  Object.assign(process.env, mockCommandBinEnv("curl", script));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return () =>
    JSON.parse(readFileSync(statePath, "utf8")) as {
      requests: Array<{ args: string[]; headers: string }>;
    };
}

for (const [hosts, expected] of [
  ["enterprise.example: {}\n", "https://enterprise.example/api/v3/"],
  ["tenant.ghe.com: {}\n", "https://api.tenant.ghe.com/"],
  ["enterprise.example: {}\ngithub.com: {}\n", "https://api.github.com/"],
]) {
  test(`lossless receipt reads retain configured default host ${expected}`, (t) => {
    const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
    writeFileSync(join(process.env.GH_CONFIG_DIR!, "hosts.yml"), hosts);
    rawGitHubJsonRead(args, { ...process.env, GH_ENTERPRISE_TOKEN: "synthetic-enterprise" }, 1000);
    assert.equal(fixture().requests[0]!.args.at(-1), expected + args[1]);
  });
}

test("explicit receipt host overrides the configured sole host", (t) => {
  const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
  writeFileSync(join(process.env.GH_CONFIG_DIR!, "hosts.yml"), "enterprise.example: {}\n");
  rawGitHubJsonRead(args, { ...process.env, GH_HOST: "github.com" }, 1000);
  assert.equal(fixture().requests[0]!.args.at(-1), "https://api.github.com/" + args[1]);
});

test("configured API host retains canonical credentials and redirect origin", (t) => {
  const fixture = installReadFixture(t, [
    { status: 301, body: {}, headers: "Location: /repositories/1/issues/comments/20\r\n" },
    { body: { id: 20 } },
  ]);
  writeFileSync(
    join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
    "github.com:\n  api_host: PROXY.EXAMPLE\n",
  );
  assert.deepEqual(ghJson(args, { losslessJson: true }), { id: 20 });
  assert.equal(fixture().requests[0]!.args.at(-1), "https://proxy.example/" + args[1]);
  assert.equal(
    fixture().requests[1]!.args.at(-1),
    "https://proxy.example/repositories/1/issues/comments/20",
  );
  assert.match(fixture().requests[0]!.headers, /Bearer synthetic-runtime-token/);
});

test("API-host credentials precede canonical credentials", (t) => {
  const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
  writeFileSync(
    join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
    "github.com:\n  api_host: proxy.example\n",
  );
  rawGitHubJsonRead(args, { ...process.env, GH_ENTERPRISE_TOKEN: "synthetic-api-token" }, 1000);
  assert.match(fixture().requests[0]!.headers, /Bearer synthetic-api-token/);
});

test("keyring lookup uses gh's normalized request hostname", (t) => {
  const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
  rawGitHubJsonRead(args, { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" }, 1000);
  assert.match(fixture().requests[0]!.headers, /Bearer synthetic-config-token/);
});

test("API-host fallback selects the first configured owner lexically", (t) => {
  const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
  writeFileSync(
    join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
    "z.example:\n  api_host: proxy.example\na.example:\n  api_host: proxy.example\n",
  );
  rawGitHubJsonRead(
    args,
    { ...process.env, GH_HOST: "z.example", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" },
    1000,
  );
  assert.match(fixture().requests[0]!.headers, /Bearer synthetic-a-token/);
});

test("API-host lookup failures do not silently switch credentials", (t) => {
  const fixture = installReadFixture(t, [{ body: {} }]);
  writeFileSync(
    join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
    "github.com:\n  api_host: broken.example\n",
  );
  assert.throws(
    () =>
      rawGitHubJsonRead(
        args,
        { ...process.env, GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" },
        1000,
      ),
    /keyring unavailable/,
  );
  assert.equal(fixture().requests.length, 0);
});

test("configured Unix socket preserves plaintext transport and API authority", (t) => {
  const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
  writeFileSync(
    join(process.env.GH_CONFIG_DIR!, "config.yml"),
    "http_unix_socket: /fixture/gh.sock\n",
  );
  rawGitHubJsonRead(args, process.env, 1000);
  const request = fixture().requests[0]!;
  assert.equal(request.args[request.args.indexOf("--unix-socket") + 1], "/fixture/gh.sock");
  assert.equal(request.args.at(-1), "http://api.github.com/" + args[1]);
});

test("github.localhost uses public credentials and its HTTP API route", (t) => {
  const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
  rawGitHubJsonRead(args, { ...process.env, GH_HOST: "github.localhost" }, 1000);
  assert.equal(fixture().requests[0]!.args.at(-1), "http://api.github.localhost/" + args[1]);
  assert.match(fixture().requests[0]!.headers, /Bearer synthetic-runtime-token/);
});

test("configured API hosts reject ports", (t) => {
  const fixture = installReadFixture(t, [{ body: {} }]);
  writeFileSync(
    join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
    "github.com:\n  api_host: proxy.example:8443\n",
  );
  assert.throws(() => rawGitHubJsonRead(args, process.env, 1000), /invalid configured/);
  assert.equal(fixture().requests.length, 0);
});

test("API-host redirects cannot escape to the canonical host", (t) => {
  const fixture = installReadFixture(t, [
    { status: 302, body: {}, headers: "Location: https://api.github.com/other\r\n" },
  ]);
  writeFileSync(
    join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
    "github.com:\n  api_host: proxy.example\n",
  );
  assert.throws(() => rawGitHubJsonRead(args, process.env, 1000), /selected API origin/);
  assert.equal(fixture().requests.length, 1);
});

test("receipt host configuration errors never expose credential text", (t) => {
  const fixture = installReadFixture(t, [{ body: {} }]);
  writeFileSync(
    join(process.env.GH_CONFIG_DIR!, "hosts.yml"),
    "token: [synthetic-private-config\n",
  );
  assert.throws(
    () => rawGitHubJsonRead(args, process.env, 1000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "could not read GitHub receipt host configuration");
      return true;
    },
  );
  assert.equal(fixture().requests.length, 0);
});

test("lossless receipt reads preserve literal escapes, controls and whitespace", (t) => {
  process.env.GH_HOST = "GITHUB.COM";
  const body = String.raw`example \u001b and \u0007` + "\u001b\u0007\r\n\t 🦞 ";
  const fixture = installReadFixture(t, [{ body: { id: 20, body } }]);
  process.env.EXACT_EVENT_PUBLICATION = "true";
  process.env.EXACT_REVIEW_QUEUE_URL = "https://cache.invalid";
  process.env.CLAWSWEEPER_WEBHOOK_SECRET = "synthetic-cache-secret";
  assert.equal(ghJson<{ body: string }>(args, { losslessJson: true }).body, body);
  const [request] = fixture().requests;
  assert.equal(request!.args.includes("--request"), true);
  assert.equal(request!.args.includes("synthetic-runtime-token"), false);
  assert.match(request!.headers, /Authorization: Bearer synthetic-runtime-token/);
  assert.equal(fixture().requests.length, 1);
  assert.equal(
    request!.args[request!.args.indexOf("--url") + 1],
    "https://api.github.com/" + args[1],
  );
});

test("lossless receipt reads retain the public-token fallback", (t) => {
  process.env.CLAWSWEEPER_PUBLIC_GH_TOKEN = "synthetic-public";
  const fixture = installReadFixture(t, [
    { status: 429, body: { message: "rate limit exceeded" }, headers: "Retry-After: 1\r\n" },
    { body: { id: 20 } },
  ]);
  assert.deepEqual(ghJson(args, { losslessJson: true }), { id: 20 });
  assert.deepEqual(
    fixture().requests.map(({ headers }) => headers.split("\n")[0]),
    ["Authorization: Bearer synthetic-public", "Authorization: Bearer synthetic-runtime-token"],
  );
});

test("lossless receipt reads use the GitHub cloud route for GHE.com tenants", (t) => {
  const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
  rawGitHubJsonRead(args, { ...process.env, GH_HOST: "TENANT.GHE.COM" }, 1000);
  const request = fixture().requests[0]!;
  assert.equal(
    request.args[request.args.indexOf("--url") + 1],
    "https://api.tenant.ghe.com/" + args[1],
  );
  assert.match(request.headers, /Bearer synthetic-runtime-token/);
});

test("lossless receipt reads retain Enterprise Server routing and credentials", (t) => {
  const fixture = installReadFixture(t, [{ body: { id: 20 } }]);
  rawGitHubJsonRead(
    args,
    { ...process.env, GH_HOST: "enterprise.example", GH_ENTERPRISE_TOKEN: "synthetic-enterprise" },
    1000,
  );
  const request = fixture().requests[0]!;
  assert.equal(
    request.args[request.args.indexOf("--url") + 1],
    "https://enterprise.example/api/v3/" + args[1],
  );
  assert.match(request.headers, /Bearer synthetic-enterprise/);
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`lossless receipt reads follow same-origin ${status} redirects`, (t) => {
    const fixture = installReadFixture(t, [
      { status, body: {}, headers: "Location: /repositories/1/issues/comments/20\r\n" },
      { body: { id: 20, body: String.raw`example \u001b` } },
    ]);
    assert.equal(
      ghJson<{ body: string }>(args, { losslessJson: true }).body,
      String.raw`example \u001b`,
    );
    const requests = fixture().requests;
    assert.equal(requests.length, 2);
    assert.equal(
      requests[1]!.args.at(-1),
      "https://api.github.com/repositories/1/issues/comments/20",
    );
  });
}

for (const location of [
  "https://unrelated.example/comment",
  "http://api.github.com/comment",
  "https://user:password@api.github.com/comment",
]) {
  test(`lossless receipt reads reject unsafe redirect ${location}`, (t) => {
    const fixture = installReadFixture(t, [
      { status: 302, body: {}, headers: `Location: ${location}\r\n` },
    ]);
    assert.throws(() => rawGitHubJsonRead(args, process.env, 1000), /selected API origin/);
    assert.equal(fixture().requests.length, 1);
  });
}

test("lossless receipt redirect loops stop after ten redirects", (t) => {
  const fixture = installReadFixture(t, [
    { status: 301, body: {}, headers: "Location: /repositories/1/issues/comments/20\r\n" },
  ]);
  assert.throws(() => rawGitHubJsonRead(args, process.env, 5000), /redirect limit/);
  assert.equal(fixture().requests.length, 11);
});

test("lossless reads reject mutation and external URL arguments before dispatch", (t) => {
  const fixture = installReadFixture(t, [{ body: {} }]);
  for (const invalid of [
    [...args, "--method", "PATCH"],
    ["api", "https://example.com/secret"],
    ["api", "repos/openclaw/openclaw/issues/comments/../20"],
  ])
    assert.throws(
      () => rawGitHubJsonRead(invalid, process.env, 1000),
      /relative review comment GET/,
    );
  assert.equal(fixture().requests.length, 0);
});

test("lossless HTTP errors retain status and safe retry hints without response bodies", (t) => {
  installReadFixture(t, [
    {
      status: 403,
      body: { message: "secondary rate limit", private: "never-log-this" },
      headers: "Retry-After: 5\r\n",
    },
  ]);
  assert.throws(
    () => rawGitHubJsonRead(args, process.env, 1000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 403; rate limit exceeded; retry-after: 5/);
      assert.doesNotMatch(error.message, /never-log-this|synthetic-runtime-token/);
      return true;
    },
  );
});

test("expired lossless reads never dispatch", (t) => {
  const fixture = installReadFixture(t, [{ body: {} }]);
  assert.throws(() => rawGitHubJsonRead(args, process.env, 0), /timed out before dispatch/);
  assert.equal(fixture().requests.length, 0);
});

test("lossless transport errors keep retry classification without leaking stderr", (t) => {
  installReadFixture(t, [{ body: {}, exit: 28 }]);
  assert.throws(() => rawGitHubJsonRead(args, process.env, 1000), /curl exit 28.*timed out/);
});
