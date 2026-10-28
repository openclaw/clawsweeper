import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";

const cliPath = resolve(process.argv[2] || "dist/repair/exact-review-batch-cli.js");
const baseline = process.argv.includes("--baseline");
const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "batch-outcome-proof-"));
const secret = "loopback-proof-secret";
const kinds = [
  "published",
  "superseded",
  "retryable_failure",
  "refresh_required",
  "permanent_failure",
];
const results = [];
let fixture;
let listenerError;
let server;
try {
  const keyPath = join(root, "key.pem");
  const certPath = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-noenc",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  server = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
        assert.equal(req.method, "POST");
        assert.equal(req.headers["x-clawsweeper-exact-review-signature"], signature);
        const route = req.url;
        fixture.requests.push({ route, signature_valid: true });
        let response;
        if (route === "/internal/exact-review/publication-batches/fetch") {
          response = { batch: fixture.batch, items: fixture.wireItems, superseded: 0 };
        } else {
          assert.equal(route, "/internal/exact-review/publication-batches/complete");
          fixture.completion = JSON.parse(body);
          response = { accepted: fixture.accepted, skipped: fixture.skipped, batch: fixture.batch };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (error) {
        listenerError = error;
        res.writeHead(500);
        res.end("fixture failure");
      }
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = "https://127.0.0.1:" + server.address().port;
  for (const command of ["complete", "release"]) {
    for (const scenario of ["mixed", "replayed", "empty"]) {
      const caseRoot = join(root, command + "-" + scenario);
      await mkdir(caseRoot);
      const outcomes =
        scenario === "empty"
          ? []
          : [
              { kind: "eligible", postEffectsComplete: true },
              { kind: "superseded" },
              { kind: "retryable_failure", reasonCode: "github_transient" },
              { kind: "refresh_required", reasonCode: "artifact_expired" },
              { kind: "permanent_failure", reasonCode: "tuple_protocol_invalid" },
            ];
      const items = [];
      for (const [index, outcome] of outcomes.entries()) {
        const itemNumber = 200001 + index;
        const outcomePath = join(caseRoot, index + ".json");
        await writeFile(outcomePath, JSON.stringify(outcome));
        items.push({
          itemKey: "openclaw/openclaw#" + itemNumber + "@publish:" + itemNumber + "0:1",
          revision: 1,
          claimGeneration: 1,
          decision: { targetRepo: "openclaw/openclaw", itemNumber },
          outcomePath,
        });
      }
      const batchId = "batch-outcome-proof-" + command + "-" + scenario;
      const leaseOwner = "proof-worker";
      const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
      const manifestPath = join(caseRoot, "manifest.json");
      const receiptPath = join(caseRoot, "receipt.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          batchId,
          leaseOwner,
          leaseExpiresAt,
          configuredBatchSize: 5,
          batchWaitMs: 0,
          items,
        }),
      );
      await writeFile(
        receiptPath,
        JSON.stringify({
          batchId,
          outcomes: [],
          publishedItemKeys: items.slice(0, 1).map((item) => item.itemKey),
        }),
      );
      const accepted = scenario === "mixed" ? 2 : 0;
      const skipped = items.length - accepted;
      fixture = {
        accepted,
        skipped,
        requests: [],
        completion: null,
        batch: {
          batch_id: batchId,
          lease_owner: leaseOwner,
          lease_expires_at: leaseExpiresAt,
          items: [],
        },
        wireItems: items.map((item) => ({
          item_key: item.itemKey,
          revision: item.revision,
          claim_generation: item.claimGeneration,
          decision: item.decision,
        })),
      };
      const { stdout } = await run(process.execPath, [cliPath, command], {
        timeout: 30_000,
        env: {
          ...process.env,
          NODE_EXTRA_CA_CERTS: certPath,
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
          EXACT_REVIEW_QUEUE_URL: origin,
          EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
          EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
        },
      });
      assert.ifError(listenerError);
      const summary = JSON.parse(stdout);
      const submitted = Object.fromEntries(kinds.map((kind) => [kind, items.length ? 1 : 0]));
      const wireKinds = fixture.completion?.items.map((item) => item.terminal_outcome) || [];
      assert.deepEqual(wireKinds, items.length ? kinds : []);
      assert.equal(summary[command === "complete" ? "accepted" : "released"], accepted);
      const matchesContract =
        isDeepStrictEqual(summary.submitted_outcomes, submitted) && summary.skipped === skipped;
      if (!baseline) assert.equal(matchesContract, true);
      assert.equal(
        fixture.requests.length,
        (command === "complete" ? 1 : 0) + (items.length ? 1 : 0),
      );
      results.push({
        command,
        scenario,
        summary,
        wire_kinds: wireKinds,
        matches_contract: matchesContract,
        requests: fixture.requests,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: baseline ? "baseline" : "candidate",
        node: process.version,
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        working_tree_dirty: Boolean(
          execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
        ),
        cli_sha256: createHash("sha256")
          .update(await readFile(cliPath))
          .digest("hex"),
        results,
      },
      null,
      2,
    ),
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
