// Controlled local HTTPS proof: pnpm run build:repair && node scripts/proof-batch-heartbeat-outage.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "batch-heartbeat-proof-"));
const secret = "synthetic-local-proof";
let server;
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  let responseStatus = 500;
  let renewedExpiry;
  let requests = 0;
  server = createServer(
    {
      key: readFileSync(join(root, "key.pem")),
      cert: readFileSync(join(root, "cert.pem")),
    },
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/internal/exact-review/publication-batches/heartbeat");
      assert.equal(
        request.headers["x-clawsweeper-exact-review-signature"],
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      );
      const parsed = JSON.parse(body);
      assert.equal(parsed.batch_id, "local-proof");
      assert.equal(parsed.lease_owner, "local-worker");
      requests++;
      response.writeHead(responseStatus, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          responseStatus === 200
            ? {
                batch: {
                  batch_id: parsed.batch_id,
                  lease_owner: parsed.lease_owner,
                  lease_expires_at: renewedExpiry,
                  items: parsed.items,
                },
              }
            : {
                error:
                  responseStatus === 409
                    ? "batch_lease_not_active"
                    : "exact_review_queue_unavailable",
              },
        ),
      );
    },
  );
  await new Promise((resolve) => server.listen(0, "localhost", resolve));
  const manifestPath = join(root, "manifest.json");
  const results = [];
  for (const scenario of [
    { name: "strict-500", status: 500, leaseMs: 1_200_000, strict: true, code: 1 },
    { name: "ample-500", status: 500, leaseMs: 1_200_000, code: 0 },
    { name: "margin-500", status: 500, leaseMs: 120_000, code: 1 },
    { name: "fence-409", status: 409, leaseMs: 1_200_000, code: 1 },
    { name: "auth-401", status: 401, leaseMs: 1_200_000, code: 1 },
    { name: "renewed-200", status: 200, leaseMs: 1_200_000, code: 0 },
  ]) {
    requests = 0;
    responseStatus = scenario.status;
    renewedExpiry = new Date(Date.now() + 1_800_000).toISOString();
    const manifest = {
      batchId: "local-proof",
      leaseOwner: "local-worker",
      leaseExpiresAt: new Date(Date.now() + scenario.leaseMs).toISOString(),
      configuredBatchSize: 1,
      batchWaitMs: 0,
      items: [
        {
          itemKey: "synthetic#1",
          revision: 1,
          claimGeneration: 1,
          decision: {},
          outcomePath: "unused.json",
        },
      ],
    };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const child = spawn(
      process.execPath,
      [
        "dist/repair/exact-review-batch-cli.js",
        "heartbeat",
        ...(scenario.strict ? [] : ["--tolerate-until-lease"]),
      ],
      {
        env: {
          PATH: process.env.PATH,
          NODE_EXTRA_CA_CERTS: join(root, "cert.pem"),
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
          EXACT_REVIEW_QUEUE_URL: `https://localhost:${server.address().port}`,
          EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, scenario.code, `${scenario.name}: ${stderr}`);
    assert.equal(requests, scenario.status === 500 ? 3 : 1);
    const stored = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(
      stored.leaseExpiresAt,
      scenario.status === 200 ? renewedExpiry : manifest.leaseExpiresAt,
    );
    const output = stdout ? JSON.parse(stdout) : null;
    if (scenario.name === "ample-500") {
      assert.equal(output.ok, false);
      assert.equal(output.tolerated, true);
      assert.equal(output.reason, "HTTP_500");
      assert.ok(output.remaining_ms > 180_000 && output.remaining_ms < scenario.leaseMs);
    } else if (scenario.status === 200) {
      assert.deepEqual(output, { ok: true, batch_id: manifest.batchId });
    } else {
      assert.equal(output, null);
    }
    results.push({
      scenario: scenario.name,
      exit: code,
      requests,
      output,
      lease: scenario.status === 200 ? "refreshed" : "unchanged",
    });
  }
  console.log(
    JSON.stringify(
      {
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        provider: "local-process",
        platform: process.platform,
        node: process.version,
        transport: "real localhost HTTPS with a temporary trusted certificate",
        results,
        limits:
          "Synthetic queue responses; no hosted workflow, production queue, or GitHub publication executed.",
      },
      null,
      2,
    ),
  );
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
