import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { reviewUsageExportFixture } from "../../../test/review-usage-export-fixture.ts";

const repository = resolve(import.meta.dirname, "../../..");
const output = resolve(process.argv[2] || ".artifacts/review-usage-export/proof.json");
const receipts = [];
for (const scenario of [
  "complete",
  "projection-failure",
  "missing-completion",
  "corrupt",
  "redirect",
  "existing-output",
  "deadline",
]) {
  const f = await reviewUsageExportFixture({
    projectionFailure: scenario === "projection-failure",
  });
  const succeeded = scenario === "complete" || scenario === "projection-failure";
  let requests = 0;
  let stalledResponseClosed = false;
  if (scenario === "missing-completion")
    for (const p of f.objects.keys()) if (p.includes("/completed-shard-sets/")) f.objects.delete(p);
  if (scenario === "existing-output") {
    mkdirSync(f.source.output);
    writeFileSync(join(f.source.output, "keep.txt"), "keep");
  }
  const server = createServer(async (request, response) => {
    requests += 1;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      if (scenario === "redirect") {
        response.writeHead(302, { location: "/forbidden" });
        response.end();
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter(([, v]) => typeof v === "string"),
      );
      const result = await f.fetchImpl(`https://clawsweeper.openclaw.ai${request.url}`, {
        method: request.method,
        headers,
        body,
        redirect: "error",
      });
      const bytes = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, Object.fromEntries(result.headers));
      const args = JSON.parse(body);
      if (
        scenario === "deadline" &&
        request.url?.endsWith("/chunk") &&
        String(args.path).includes("/completed-shard-sets/")
      ) {
        response.on("close", () => {
          stalledResponseClosed = true;
        });
        response.write(bytes.subarray(0, 1));
        return;
      }
      if (
        scenario === "corrupt" &&
        request.url?.endsWith("/chunk") &&
        String(args.path).startsWith("ledger/v1/events/")
      )
        bytes[0] ^= 1;
      response.end(bytes);
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const preload = join(f.root, "transport.mjs");
    // Only the external network boundary is redirected. Product argument,
    // signing, streaming, budget, closure, filesystem and reporting code runs unchanged.
    writeFileSync(
      preload,
      `const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(String(input));if(url.origin!=="https://clawsweeper.openclaw.ai"||!url.pathname.startsWith("/internal/state/blobs/"))throw new Error("unexpected transport");return nativeFetch("http://127.0.0.1:${port}"+url.pathname,init);};`,
      { mode: 0o600 },
    );
    const args = [
      "--import",
      preload,
      join(repository, "dist/review-usage-export.js"),
      "--run-id",
      f.source.runId,
      "--run-attempt",
      String(f.source.runAttempt),
      "--source-sha",
      f.source.sourceSha,
      "--date",
      f.source.partitionDate,
      "--output",
      f.source.output,
    ];
    const started = performance.now();
    const child = spawn(process.execPath, args, {
      cwd: repository,
      env: {
        PATH: process.env.PATH,
        HOME: f.root,
        CLAWSWEEPER_WEBHOOK_SECRET: f.source.webhookSecret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b;
      if (stdout.length > 2 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (b) => {
      stderr += b;
      if (stderr.length > 64 * 1024) child.kill();
    });
    const guard = setTimeout(() => child.kill(), 135_000);
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    clearTimeout(guard);
    const elapsed = performance.now() - started;
    assert.equal(code, succeeded ? 0 : 1, stderr);
    assert.ok(!stdout.includes(f.source.webhookSecret) && !stderr.includes(f.source.webhookSecret));
    if (succeeded) {
      const { report, selection } = JSON.parse(stdout);
      assert.deepEqual(
        selection.paths,
        f.paths.filter((p) => !p.includes(".crabfleet_projection/")),
      );
      assert.deepEqual(report.rows[0].usage, { input_tokens: 100, output_tokens: 10 });
      assert.equal(report.coverage.actual_billing, "unavailable");
      if (scenario === "complete") {
        for (const [path, bytes] of f.objects)
          assert.deepEqual(readFileSync(join(f.source.output, path)), bytes);
      } else {
        assert.equal(selection.producer.producer, "review.fixture.default");
        const projectionPaths = f.paths.filter((p) => p.includes(".crabfleet_projection/"));
        assert.ok(projectionPaths.length > 0);
        for (const path of projectionPaths) {
          assert.equal(existsSync(join(f.source.output, path)), false);
          assert.ok(!f.calls.some((c) => c.body.path === path));
        }
      }
    } else if (scenario === "existing-output") {
      assert.match(stderr, /output_exists.*choose a new output directory/);
      assert.equal(requests, 0);
      assert.equal(readFileSync(join(f.source.output, "keep.txt"), "utf8"), "keep");
    } else {
      assert.equal(existsSync(f.source.output), false);
      assert.equal(stdout, "");
    }
    if (scenario === "redirect") assert.equal(requests, 1);
    if (scenario === "deadline") {
      assert.match(stderr, /deadline/);
      assert.ok(elapsed >= 119_000 && elapsed < 130_000);
      assert.equal(stalledResponseClosed, true);
    }
    receipts.push({
      scenario,
      cli_exit: code,
      requests,
      elapsed_ms: Math.round(elapsed),
      report_sha256: stdout ? createHash("sha256").update(stdout).digest("hex") : null,
      partial_export_visible: succeeded ? false : existsSync(join(f.source.output, "ledger")),
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    f.cleanup();
  }
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      receipts,
      limits:
        "Synthetic R2 transport and HMAC only; no production request, provider/model call, credential setup, loaded configuration, billing or quota qualification.",
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ scenarios: receipts.length, all_passed: true }));
