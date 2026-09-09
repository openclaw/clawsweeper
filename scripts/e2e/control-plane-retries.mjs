import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(".artifacts/control-plane-proof");
await mkdir(root, { recursive: true });
const transcript = [];
const record = (value) => {
  console.log(value);
  transcript.push(value);
};
let wrangler;
let server;
try {
  for (const statuses of [[503, 503, 200], [400]]) {
    let count = 0;
    const times = [];
    server = createServer((_req, res) => {
      times.push(Date.now());
      const status = statuses[count++] ?? 500;
      res.writeHead(status, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ attempt: count, status }));
    });
    await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
    const result = await execute(
      "bash",
      [
        "-c",
        `source scripts/control-plane-curl.sh
control_plane_curl --silent --show-error --output "$PROOF_BODY" --write-out '%{http_code}' "$PROOF_URL"`,
      ],
      {
        env: {
          ...process.env,
          PROOF_BODY: join(root, "curl-body.json"),
          PROOF_URL: `http://127.0.0.1:${server.address().port}/enqueue`,
        },
      },
    );
    const body = await readFile(join(root, "curl-body.json"), "utf8");
    record(
      `HTTP fixture ${statuses.join(" -> ")}\n${result.stderr.trim()}\nFinal HTTP ${result.stdout}; body ${body}; requests ${count}; elapsed gaps ${times
        .slice(1)
        .map((time, index) => time - times[index])
        .join(",")} ms`,
    );
    assert.equal(count, statuses.length);
    assert.equal(result.stdout, String(statuses.at(-1)));
    for (let index = 1; index < times.length; index++)
      assert.ok(times[index] - times[index - 1] >= 1000);
    await new Promise((done) => server.close(done));
    server = null;
  }
  const secret = "synthetic-control-plane-proof-secret";
  await writeFile(
    join(root, "entry.ts"),
    `
import worker, { ExactReviewQueue } from ${JSON.stringify(resolve("dashboard/worker.ts"))};
export class ProofQueue extends ExactReviewQueue {
  constructor(state, env) {
    super(state, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => ({ outcome: "retryable", retryAt: Date.now() + 30_000 }) });
  }
  async fetch(request) {
    if (new URL(request.url).pathname === "/enqueue" && (await request.clone().json()).decision?.itemNumber === 43) throw new Error("synthetic unexpected failure");
    return super.fetch(request);
  }
}
globalThis.fetch = async () => { throw new Error("proof forbids outbound network"); };
export default { fetch(request, env, ctx) { return worker.fetch(request, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" }, ctx); } };
`,
  );
  const portServer = createServer();
  await new Promise((ready) => portServer.listen(0, "127.0.0.1", ready));
  const port = portServer.address().port;
  await new Promise((done) => portServer.close(done));
  await writeFile(
    join(root, "wrangler.json"),
    JSON.stringify({
      name: "control-plane-retries-proof",
      main: "entry.ts",
      compatibility_date: "2026-05-11",
      durable_objects: { bindings: [{ name: "EXACT_REVIEW_QUEUE", class_name: "ProofQueue" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["ProofQueue"] }],
      vars: { CLAWSWEEPER_WEBHOOK_SECRET: secret },
    }),
  );
  let workerLog = "";
  wrangler = spawn(
    "corepack",
    [
      "pnpm",
      "dlx",
      "wrangler@4.107.0",
      "dev",
      "--config",
      join(root, "wrangler.json"),
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      join(root, "state"),
      "--show-interactive-dev-session=false",
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  wrangler.stdout.on("data", (chunk) => {
    workerLog += chunk;
  });
  wrangler.stderr.on("data", (chunk) => {
    workerLog += chunk;
  });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (
      await fetch(`${url}/api/health`)
        .then((response) => response.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    if (wrangler.exitCode !== null) break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  await writeFile(join(root, "workerd.log"), workerLog);
  assert.ok(ready, "local workerd startup; inspect workerd.log");
  for (const itemNumber of [42, 43]) {
    for (const path of ["/github/webhook", "/internal/exact-review/enqueue"]) {
      const webhook = path === "/github/webhook";
      const body = JSON.stringify(
        webhook
          ? {
              action: "opened",
              repository: { full_name: "openclaw/gogcli", default_branch: "main", private: false },
              issue: { number: itemNumber },
              installation: { id: 123 },
            }
          : {
              delivery_id: `synthetic-internal-${itemNumber}`,
              decision: {
                targetRepo: "openclaw/gogcli",
                targetBranch: "main",
                supersedesInProgress: false,
                itemNumber,
                itemKind: "issue",
                sourceEvent: "issues",
                sourceAction: "opened",
              },
            },
      );
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      const response = await fetch(url + path, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          ...(webhook
            ? {
                "x-github-event": "issues",
                "x-github-delivery": `synthetic-webhook-${itemNumber}`,
                "x-hub-signature-256": signature,
              }
            : { "x-clawsweeper-exact-review-signature": signature }),
        },
      });
      const text = await response.text();
      record(
        `workerd POST ${path} fixture=${itemNumber === 42 ? "probe-retryable" : "unexpected-exception"}: HTTP ${response.status}; retry-after=${response.headers.get("retry-after")}; ${itemNumber === 42 || !webhook ? text : "workerd internal error response"}`,
      );
      assert.equal(response.status, itemNumber === 42 ? 503 : 500);
      if (itemNumber === 42) {
        assert.match(response.headers.get("retry-after") ?? "", /^\d+$/);
        assert.deepEqual(JSON.parse(text), {
          error: "target_visibility_unverified",
          retryable: true,
        });
      } else assert.equal(response.headers.get("retry-after"), null);
    }
  }
  await writeFile(join(root, "workerd.log"), workerLog);
  assert.match(workerLog, /exact_review_queue_structured_server_response/);
  record(
    `PASS; provider=local-workerd; Node=${process.version}; head=${execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}; limits=synthetic admission, no production or GitHub calls`,
  );
} finally {
  if (server) await new Promise((done) => server.close(done));
  if (wrangler && wrangler.exitCode === null) {
    wrangler.kill("SIGTERM");
    await new Promise((done) => wrangler.once("exit", done));
  }
  await writeFile(join(root, "transcript.txt"), transcript.join("\n") + "\n");
}
