// Exercise the production dashboard reader over HTTP with synthetic App credentials.
// Usage: node scripts/proof-app-token-scoping.mjs [output.json]
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { githubJsonForTest } from "../dashboard/worker.ts";

const mints = [];
const reads = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url === "/app/installations/999/access_tokens" && req.method === "POST") {
    mints.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        token: `synthetic-${mints.length}`,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    return;
  }
  assert.equal(req.method, "GET");
  const tokenId = Number(String(req.headers.authorization).replace("Bearer synthetic-", ""));
  assert.ok(tokenId > 0 && tokenId <= mints.length);
  reads.push({ path: req.url, scope: tokenId });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const env = {
    GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
    CLAWSWEEPER_APP_CLIENT_ID: "Iv23synthetic-proof",
    CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    CLAWSWEEPER_APP_INSTALLATION_ID: "999",
  };
  for (const path of [
    "/repos/fixture/alpha/issues/1",
    "/repos/fixture/alpha/issues/2",
    "/repos/fixture/beta/issues/1",
    "/repos/fixture/alpha/actions/runs",
    "/repos/fixture/alpha/commits/abc/check-runs",
    "/repos/fixture/state/contents/status.json",
  ])
    assert.deepEqual(await githubJsonForTest(env, path), { ok: true });
  assert.deepEqual(mints, [
    { repositories: ["alpha"], permissions: { issues: "read" } },
    { repositories: ["beta"], permissions: { issues: "read" } },
    { repositories: ["alpha"], permissions: { actions: "read" } },
    { repositories: ["alpha"], permissions: { checks: "read" } },
    { repositories: ["state"], permissions: { contents: "read" } },
  ]);
  assert.deepEqual(
    reads.map((read) => read.scope),
    [1, 1, 2, 3, 4, 5],
  );
  const proof = {
    result: "PASS",
    runtime: process.version,
    provider: "local-node",
    image: null,
    lease: null,
    mints,
    reads,
    limits:
      "Synthetic loopback GitHub HTTP responses; verifies outgoing request scoping and cache behavior, not GitHub authorization or deployed workflows.",
  };
  const output = `${JSON.stringify(proof, null, 2)}\n`;
  if (process.argv[2]) await writeFile(process.argv[2], output);
  process.stdout.write(output);
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
