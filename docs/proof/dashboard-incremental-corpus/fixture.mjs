// Shared local fixture for the dashboard corpus proofs: the production Worker and exact-review
// queue Durable Object under the dashboard site's pinned Wrangler (workerd, SQLite, local R2),
// a counting proxy in front of it, and synthetic canonical records written through the
// production tuple-write API.
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

import { postCanonicalRecordTuple } from "../../../dist/repair/state-append-client.js";

export const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
export const secret = "synthetic-dashboard-corpus-secret";
export const bin = (name) => path.join(repoRoot, "dashboard-site/node_modules/.bin", name);

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Starts the Worker and the counting proxy. "counts" holds the requests sent through "baseUrl"
// since the last "resetCounts()"; "cleanup()" stops everything and removes the temporary root.
export async function startWorker() {
  const root = mkdtempSync(path.join(tmpdir(), "dashboard-corpus-proof-"));
  const nonce = randomUUID();
  const workerPort = await freePort();
  const workerUrl = "http://127.0.0.1:" + workerPort;
  const fixture = { root, workerUrl, counts: null };
  fixture.resetCounts = () =>
    (fixture.counts = { requests: 0, exportPages: 0, exportRecords: 0, responseBytes: 0 });
  fixture.resetCounts();
  const proxy = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      const forward = httpRequest(
        {
          host: "127.0.0.1",
          port: workerPort,
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers, host: "127.0.0.1:" + workerPort },
        },
        (response) => {
          const parts = [];
          response.on("data", (chunk) => parts.push(chunk));
          response.on("end", () => {
            const payload = Buffer.concat(parts);
            const counts = fixture.counts;
            counts.requests++;
            counts.responseBytes += payload.length;
            if (incoming.url === "/internal/state/records/export" && response.statusCode === 200) {
              const decode = {
                br: brotliDecompressSync,
                gzip: gunzipSync,
                deflate: inflateSync,
              }[response.headers["content-encoding"] ?? ""];
              counts.exportPages++;
              counts.exportRecords += JSON.parse(
                (decode ? decode(payload) : payload).toString("utf8"),
              ).records.length;
            }
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            outgoing.end(payload);
          });
        },
      );
      forward.on("error", (error) => {
        outgoing.writeHead(502);
        outgoing.end(String(error));
      });
      forward.end(Buffer.concat(chunks));
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  fixture.baseUrl = "http://127.0.0.1:" + proxy.address().port;

  const child = spawn(
    bin("wrangler"),
    [
      "dev",
      "--config",
      "docs/proof/dashboard-incremental-corpus/wrangler.toml",
      "--local",
      "--persist-to",
      path.join(root, "worker-state"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--inspector-port",
      "0",
      "--var",
      "PROOF_NONCE:" + nonce,
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
      },
    },
  );
  let diagnostics = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-8000);
    });
  const exited = once(child, "exit");
  const signalChildGroup = (signal) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let cleanupPromise;
  fixture.cleanup = (extra = () => {}) =>
    (cleanupPromise ??= (async () => {
      proxy.close();
      signalChildGroup("SIGTERM");
      const forceStop = setTimeout(() => signalChildGroup("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(forceStop);
        // The wrapper can exit before workerd; kill any remaining owned descendants.
        signalChildGroup("SIGKILL");
        extra();
        rmSync(root, { recursive: true, force: true });
      }
    })());
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.on(signal, () => {
      fixture.cleanup().then(
        () => process.exit(exitCode),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
  }
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(workerUrl + "/__proof/ready", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.json()).nonce === nonce) return fixture;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await fixture.cleanup();
  throw new Error("local Worker did not start: " + diagnostics);
}

// Synthetic canonical records.
const NOW = Date.now();
const SECTIONS = ["items", "closed", "plans", "decision-packets"];
const REPORT_BODY = "Synthetic report body line for the corpus proof.\n".repeat(60);
const iso = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const recordPath = (slug, section, id) =>
  "records/" + slug + "/" + section + "/" + id + (section === "decision-packets" ? ".json" : ".md");

export function record(repo, number, { version = 1, archived = false } = {}) {
  const decision = {
    decision: archived ? "close" : number % 5 === 0 ? "needs_maintainer" : "keep_open",
    closeReason: archived ? "implemented_on_main" : null,
    confidence: number % 2 ? "high" : "medium",
    prRating: { overallTier: number % 3 ? "solid" : "needs_work" },
    realBehaviorProof: { status: number % 4 ? "sufficient" : "missing" },
    securityReview: { status: number % 11 ? "cleared" : "needs_attention" },
    maintainerDecision: { required: number % 7 === 0, kind: "product" },
    reviewFindings: [{ priority: (number % 3) + 1 }],
  };
  return [
    "---",
    "repository: " + repo,
    "number: " + number,
    "type: " + (number % 2 ? "issue" : "pull_request"),
    "title: " + JSON.stringify("Synthetic item " + number + " v" + version),
    "reviewed_at: " + iso((number % 40) + version - 1),
    "item_created_at: " + iso((number % 40) + 30),
    "author_association: " + (number % 6 ? "NONE" : "MEMBER"),
    "review_policy: standard",
    "review_codex_elapsed_ms: " + (60_000 + number),
    ...(archived ? ["action_taken: closed", "applied_at: " + iso(number % 9)] : []),
    "review_record: " + JSON.stringify({ version: 1, decision }),
    "---",
    "",
    REPORT_BODY,
  ].join("\n");
}

// Canonical tuple writes, as the review publisher sends them: all four sections of one item,
// each guarded by the digest it replaces; a section without content is deleted.
export function recordWriter(workerUrl) {
  const digests = new Map();
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  async function publish(slug, id, contents) {
    const operations = SECTIONS.map((section) => {
      const content = contents[section];
      return {
        path: recordPath(slug, section, id),
        expectedDigest: digests.get(recordPath(slug, section, id)) ?? null,
        ...(content === undefined
          ? {}
          : { contentBase64: Buffer.from(content).toString("base64") }),
      };
    });
    await postCanonicalRecordTuple({
      queueUrl: workerUrl,
      webhookSecret: secret,
      mutation: { deliveryId: randomUUID(), key: slug + "/" + id, operations },
    });
    for (const section of SECTIONS) {
      const content = contents[section];
      if (content === undefined) digests.delete(recordPath(slug, section, id));
      else digests.set(recordPath(slug, section, id), sha256(content));
    }
  }
  return async function publishAll(writes, concurrency = 16) {
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < writes.length) {
          const [slug, id, contents] = writes[next++];
          await publish(slug, id, contents);
        }
      }),
    );
  };
}

// The initial store: three repositories (one not public), items and closed records with plans
// for some open items.
export const REPOSITORIES = {
  "openclaw-openclaw": { repo: "openclaw/openclaw", count: 1500 },
  "openclaw-clawhub": { repo: "openclaw/clawhub", count: 400 },
  "openclaw-private-fixture": { repo: "openclaw/private-corpus-fixture", count: 60 },
};
export const PRIVATE_REPO = "openclaw/private-corpus-fixture";
export const PUBLIC_REPOS = ["openclaw/openclaw", "openclaw/clawhub", "openclaw/fs-safe"];

export function seedWrites() {
  const writes = [];
  for (const [slug, { repo, count }] of Object.entries(REPOSITORIES)) {
    for (let id = 1; id <= count; id++) {
      const archived = id % 4 === 0;
      writes.push([
        slug,
        id,
        {
          [archived ? "closed" : "items"]: record(repo, id, { archived }),
          ...(!archived && id % 3 === 0 ? { plans: "# Plan " + id + "\n" } : {}),
        },
      ]);
    }
  }
  return writes;
}

// Writes after the stored snapshot's watermark, replayed from the journal by a full rebuild.
export function afterSnapshotWrites() {
  const writes = [];
  for (let id = 5; id <= 1500; id += 5) {
    const archived = id % 4 === 0;
    writes.push([
      "openclaw-openclaw",
      id,
      { [archived ? "closed" : "items"]: record("openclaw/openclaw", id, { version: 2, archived }) },
    ]);
  }
  return writes;
}

// A busy hour: updates, archive moves (items to closed), reopen moves (closed to items),
// deletions, plans-only edits in the private repository, and a new repository.
export function busyHourWrites() {
  const writes = [];
  for (let id = 1; id <= 1500; id += 7)
    if (id % 4 !== 0)
      writes.push(["openclaw-openclaw", id, { items: record("openclaw/openclaw", id, { version: 3 }) }]);
  for (let id = 2; id <= 400; id += 10)
    if (id % 4 !== 0)
      writes.push([
        "openclaw-clawhub",
        id,
        { closed: record("openclaw/clawhub", id, { version: 2, archived: true }) },
      ]);
  for (let id = 8; id <= 400; id += 40)
    writes.push(["openclaw-clawhub", id, { items: record("openclaw/clawhub", id, { version: 2 }) }]);
  for (let id = 3; id <= 1500; id += 50)
    if (id % 4 !== 0 && id % 7 !== 1) writes.push(["openclaw-openclaw", id, {}]);
  for (let id = 3; id <= 60; id += 6)
    if (id % 4 !== 0)
      writes.push([
        "openclaw-private-fixture",
        id,
        { items: record(PRIVATE_REPO, id), plans: "# Plan " + id + " v2\n" },
      ]);
  writes.push(["openclaw-private-fixture", 61, { items: record(PRIVATE_REPO, 61) }]);
  for (let id = 1; id <= 25; id++)
    writes.push(["openclaw-fs-safe", id, { items: record("openclaw/fs-safe", id) }]);
  return writes;
}
