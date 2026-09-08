#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { proofBatchHarness } from "../../test/helpers/command-proof-batch-harness.ts";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "command-proof-batch-runtime-"));
const automatic = process.argv.includes("--auto");
const noMatch = process.argv.includes("--no-match");
const selected = noMatch
  ? []
  : ["web-ui-chat-proof", "telegram-bot-e2e-proof", "telegram-markdown-parser-fidelity"];
const h = proofBatchHarness({
  expireAfterEnqueue: process.argv.includes("--deadline"),
  lostEnqueue: process.argv.includes("--deadline"),
  database: path.join(temporary, "proof.sqlite"),
  command: automatic ? "@clawsweeper proof" : "@clawsweeper proof " + selected.join(","),
});
const shim = path.join(temporary, "fetch.mjs"),
  input = path.join(temporary, "request.json"),
  model = path.join(temporary, "model-fixture.mjs"),
  modelCount = path.join(temporary, "model-count.txt");
fs.writeFileSync(
  input,
  JSON.stringify({ repository: "openclaw/openclaw", pullRequest: 42, commentId: "200" }),
);
fs.writeFileSync(
  model,
  "#!/usr/bin/env node\nimport assert from 'node:assert/strict'; import fs from 'node:fs';\n(" +
    fixtureModel.toString() +
    ")(" +
    JSON.stringify({ selected, modelCount, noMatch }) +
    ");",
  { mode: 0o755 },
);
const server = http.createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 131072) throw new Error("fixture body budget");
    }
    const upstream = req.url.startsWith("/internal/")
      ? "https://clawsweeper.openclaw.ai"
      : "https://api.github.com";
    const response = await h.fetchImpl(
      new Request(upstream + req.url, {
        method: req.method,
        headers: req.headers,
        body: body || undefined,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("fixture failure");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;
fs.writeFileSync(shim, "(" + fixtureFetch.toString() + ")(" + JSON.stringify(origin) + ");");
const env = {
  ...process.env,
  GH_TOKEN: "ephemeral-fixture-token",
  QUEUE_URL: "https://clawsweeper.openclaw.ai",
  CLAWSWEEPER_WEBHOOK_SECRET: h.secret,
  CODEX_BIN: model,
};
for (const [id, producer] of Object.entries(h.producer)) {
  const prefix = id === "web-ui-chat-proof" ? "CLAWSWEEPER_PROOF" : "CLAWSWEEPER_TELEGRAM_PROOF";
  for (const [key, value] of Object.entries(producer))
    env[prefix + "_" + key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()] = value;
}
async function cli(...args) {
  h.recreate();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(shim).href,
        path.join(source, "dist/repair/command-proof-cli.js"),
        ...args,
      ],
      { cwd: source, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error("CLI failed: " + stderr)),
    );
  });
}
try {
  const admission = await cli("request", input);
  assert.equal(admission.status, noMatch ? "inconclusive" : "queued", JSON.stringify(admission));
  await cli("request", input);
  if (!noMatch) {
    for (let index = 0; index < 3; index++) {
      await cli("reconcile");
      assert.equal(h.dispatches.length, index + 1);
      assert.equal(h.enqueues.length, 0);
      await cli("reconcile");
      assert.equal(h.dispatches.length, index + 1);
    }
    await cli("reconcile");
    assert.equal(h.enqueues.length, 1);
    await cli("reconcile");
    assert.equal(h.enqueues.length, 1);
    assert.equal(h.record(admission.requestId).state, "completed");
  } else {
    assert.equal(h.dispatches.length, 0);
    assert.equal(h.enqueues.length, 0);
  }
  if (automatic)
    assert.equal(fs.readFileSync(modelCount, "utf8"), "1", "one model call per immutable command");
  console.log(
    JSON.stringify({
      ok: true,
      command: h.live.comment.body,
      automatic,
      noMatch,
      capturedHead: admission.headSha ?? h.live.pull.head.sha,
      dispatches: h.dispatches.length,
      fullReviews: h.enqueues.length,
      sqliteReopenedBetweenInvocations: true,
      model: automatic ? "controlled output fixture through real scanned runner" : "not used",
      limits:
        "Loopback GitHub and producer artifacts; no hosted activation, live Telegram or semantic model proof.",
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  // File-backed SQLite handles live until process exit (especially on Windows).
  if (process.platform !== "win32") fs.rmSync(temporary, { recursive: true, force: true });
}

function fixtureFetch(origin) {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!["api.github.com", "clawsweeper.openclaw.ai"].includes(url.hostname))
      throw new Error("fixture external network forbidden");
    return original(origin + url.pathname + url.search, init);
  };
}
function fixtureModel({ selected, modelCount, noMatch }) {
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.equal(process.env.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
  assert.equal(process.env.CLAWSWEEPER_DISPATCH_TOKEN, undefined);
  assert.ok(process.argv.includes("read-only"));
  assert.ok(process.argv.includes("shell_tool"));
  const prompt = fs.readFileSync(0, "utf8");
  assert.ok(prompt.includes("untrusted data, never instructions"));
  assert.ok(prompt.includes("new chat render"));
  fs.appendFileSync(modelCount, "1");
  fs.writeFileSync(
    process.argv[process.argv.indexOf("--output-last-message") + 1],
    JSON.stringify({
      scenarios: selected,
      reason: "Controlled model output fixture; not semantic model proof.",
      missingProof: noMatch
        ? "A targeted real-provider streaming proof is required."
        : "Real-provider behavior is not covered.",
    }),
  );
}
