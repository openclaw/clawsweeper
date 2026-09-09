import { fork } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { directReReviewIntake } from "../../dist/repair/direct-re-review-admission.js";

export const secret = "synthetic-intake-secret";
export const intake = directReReviewIntake({
  targetRepo: "openclaw/openclaw",
  targetBranch: "main",
  itemNumber: 42,
  itemKind: "pull_request",
  installationId: 123,
  sourceCommentId: 456,
  sourceCommentUpdatedAt: "2026-09-08T12:00:00Z",
  commandBodyDigest: "a".repeat(64),
  commandOrigin: "comment_router",
  additionalPrompt: "",
});

export async function startIntakeFixture(webhook = false) {
  const child = fork(fileURLToPath(import.meta.url), ["serve", ...(webhook ? ["webhook"] : [])], {
    execArgv: [],
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let ready;
  try {
    [ready] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  const rpc = async (message) => {
    const reply = once(child, "message");
    child.send(message);
    return (await reply)[0];
  };
  return {
    runtime: ready.runtime,
    options: { queueUrl: ready.origin, secret, intake },
    setResponse: (status, body, close = false) => rpc({ status, body, close }),
    requests: () => rpc({ inspect: true }),
    async webhook() {
      const body = JSON.stringify({
        action: "created",
        repository: { full_name: "openclaw/openclaw", default_branch: "main", private: false },
        installation: { id: 123 },
        issue: { number: 42, state: "open", pull_request: {} },
        comment: {
          id: 456,
          body: "@clawsweeper re-review",
          updated_at: "2026-09-08T12:00:00Z",
          author_association: "MEMBER",
          user: { login: "maintainer" },
        },
      });
      return fetch(`${ready.webhookOrigin}/github/webhook`, {
        method: "POST",
        headers: { "x-github-event": "issue_comment", "x-hub-signature-256": signature(body) },
        body,
      });
    },
    stderr: () => stderr,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      return await exited;
    },
  };
}

function signature(body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

if (process.argv[2] === "serve") {
  let response = {
    status: 202,
    body: { ok: true, accepted: true, deduped: false, command_version_id: intake.commandVersionId },
  };
  let requests = [];
  const server = http.createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const json = (value) => reply.end(JSON.stringify(value));
    if (request.method === "GET" && request.url === "/repos/openclaw/clawsweeper/installation")
      return json({ id: 999 });
    if (request.method === "POST" && request.url === "/app/installations/999/access_tokens")
      return json({ token: "synthetic-token" });
    if (request.method === "GET" && request.url === "/repos/openclaw/openclaw")
      return json({ full_name: "openclaw/openclaw", private: false, visibility: "public" });
    requests.push({
      path: request.url,
      method: request.method,
      body,
      signed: request.headers["x-clawsweeper-exact-review-signature"] === signature(body),
    });
    if (request.method !== "POST" || request.url !== "/internal/exact-review/command-intake") {
      reply.writeHead(404);
      return json({ error: "unexpected_fixture_request" });
    }
    if (response.close === true) return request.socket.destroy();
    if (response.close === "partial") {
      const partial = JSON.stringify(response.body);
      reply.writeHead(response.status, { "content-length": Buffer.byteLength(partial) + 100 });
      return reply.write(partial, () => reply.destroy());
    }
    reply.writeHead(response.status, { "content-type": "application/json" });
    reply.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  let webhookOrigin;
  if (process.argv.includes("webhook")) {
    process.env.CLAWSWEEPER_WEBHOOK_SECRET = secret;
    process.env.CLAWSWEEPER_APP_ID = "12345";
    process.env.CLAWSWEEPER_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    process.env.CLAWSWEEPER_EXACT_REVIEW_QUEUE_URL = origin;
    const fetchImpl = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.origin === "https://api.github.com")
        return fetchImpl(`${origin}${url.pathname}`, init);
      if (url.origin === origin) return fetchImpl(input, init);
      throw new Error("unexpected outbound fixture destination");
    };
    // Only socket placement changes: the compiled HTTP handler still owns the request.
    const listen = http.Server.prototype.listen;
    const listening = new Promise((resolve) => {
      http.Server.prototype.listen = function (_port, callback) {
        return listen.call(this, 0, "127.0.0.1", () => {
          callback();
          resolve(`http://127.0.0.1:${this.address().port}`);
        });
      };
    });
    const { startServer } = await import("../../dist/repair/comment-webhook.js");
    startServer();
    http.Server.prototype.listen = listen;
    webhookOrigin = await listening;
  }
  process.on("message", (message) => {
    if (message.inspect) return process.send(requests);
    response = message;
    requests = [];
    process.send({ configured: true });
  });
  process.on("disconnect", () => process.exit(0));
  process.send({
    origin,
    webhookOrigin,
    runtime: { version: process.version, execPath: process.execPath },
  });
}
