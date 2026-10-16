// Controlled local workerd/R2 proof. Usage: node <this-file> /absolute/wrangler-prefix
// No remote bindings or credentials; the baseline replaces only the storage owner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = process.cwd();
const base = "983558446396c3f44ad7f24e22582c5a2906c58d";
const prefix = process.argv[2];
assert.ok(prefix && path.isAbsolute(prefix), "supply the qualified Wrangler prefix");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
const require = createRequire(path.join(prefix, "package.json"));
assert.equal(require("./package.json").version, "4.110.0");
assert.equal(require("miniflare/package.json").version, "4.20260708.1");
const { Miniflare, Log, LogLevel } = require("miniflare");
const { build } = require("esbuild");
const secret = "synthetic-r2-conditional-proof";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baseline = execFileSync("git", ["show", base + ":dashboard/state-blobs.ts"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
});
const owner = path.join(root, "dashboard/state-blobs.ts");
const worker = path.join(root, "dashboard/worker.ts");
const results = [];
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("local proof operation exceeded 30 seconds")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
for (const variant of ["baseline", "candidate"]) {
  const bundle = await build({
    stdin: {
      contents: `import worker from ${JSON.stringify(worker)};
const gates = new Map();
export default { async fetch(request, env, ctx) {
  const bucket = env.STATE_SNAPSHOTS;
  if (new URL(request.url).pathname === "/__native") {
    const bytes = new TextEncoder().encode("native condition");
    const opts = { onlyIf: new Headers({ "If-None-Match": "*" }) };
    const writes = await Promise.all([bucket.put("native-key", bytes, opts), bucket.put("native-key", bytes, opts)]);
    return Response.json({ results: writes.map((write) => write === null ? "null" : "object") });
  }
  const bound = (name) => bucket[name].bind(bucket);
  const wrapped = {
    head: async (key) => {
      const object = await bucket.head(key);
      if (request.headers.get("x-proof-race") === "yes") {
        let gate = gates.get(key);
        if (!gate) {
          let release;
          const ready = new Promise((resolve) => { release = resolve; });
          gate = { reads: 0, ready, release };
          gates.set(key, gate);
        }
        if (++gate.reads <= 2) {
          if (gate.reads === 2) gate.release();
          await gate.ready;
        }
      }
      return object;
    },
    get: bound("get"), put: bound("put"), list: bound("list"),
    createMultipartUpload: bound("createMultipartUpload"), resumeMultipartUpload: bound("resumeMultipartUpload"),
  };
  return worker.fetch(request, { ...env, STATE_SNAPSHOTS: wrapped }, ctx);
}};`,
      resolveDir: root,
      sourcefile: "r2-conditional-proof.ts",
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    plugins:
      variant === "baseline"
        ? [
            {
              name: "baseline-owner",
              setup(builder) {
                builder.onLoad({ filter: /state-blobs\.ts$/ }, (args) =>
                  args.path === owner ? { contents: baseline, loader: "ts" } : undefined,
                );
              },
            },
          ]
        : [],
  });
  let externalRequests = 0;
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-08",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    port: 0,
    r2Buckets: ["STATE_SNAPSHOTS"],
    r2Persist: false,
    bindings: { CLAWSWEEPER_WEBHOOK_SECRET: secret },
    log: new Log(LogLevel.NONE),
    outboundService: () => {
      externalRequests += 1;
      return new Response("external egress denied", { status: 502 });
    },
  });
  let calls = 0;
  const post = async (operation, payload, race = false) => {
    const body = JSON.stringify(payload);
    calls += 1;
    return bounded(
      mf.dispatchFetch("http://127.0.0.1/internal/state/blobs/" + operation, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature":
            "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
          ...(race ? { "x-proof-race": "yes" } : {}),
        },
        body,
      }),
    );
  };
  const put = (key, content, race) =>
    post(
      "put",
      {
        path: key,
        digest: sha256(content),
        contentBase64: content.toString("base64"),
      },
      race,
    );
  try {
    const native = await bounded(mf.dispatchFetch("http://127.0.0.1/__native"));
    assert.deepEqual((await native.json()).results.sort(), ["null", "object"]);
    const key = "ledger/v1/conditional-race.jsonl";
    const bodies = [Buffer.from("first writer\n"), Buffer.from("other writer\n")];
    const responses = await Promise.all(bodies.map((body) => put(key, body, true)));
    const statuses = responses.map((response) => response.status);
    assert.deepEqual([...statuses].sort(), variant === "baseline" ? [201, 201] : [201, 409]);
    const stat = await (await post("stat", { path: key })).json();
    const winner = bodies.find((body) => sha256(body) === stat.blob.digest);
    assert.ok(winner);
    assert.equal(stat.blob.bytes, winner.byteLength);
    assert.equal(stat.blob.digestVerified, true);
    const downloaded = await post("chunk", { path: key, offset: 0, length: winner.byteLength });
    assert.equal(downloaded.status, 206);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), winner);
    if (variant === "candidate") assert.equal(statuses[bodies.indexOf(winner)], 201);
    const replayStatuses = [];
    for (const family of ["ledger", "artifact"]) {
      const content = Buffer.from("identical replay\n");
      const replayKey =
        family === "ledger"
          ? "ledger/v1/replay.jsonl"
          : "artifacts/exact-review/v1/" + sha256(content);
      const replay = await Promise.all([
        put(replayKey, content, true),
        put(replayKey, content, true),
      ]);
      const seen = replay.map((response) => response.status).sort();
      assert.deepEqual(seen, variant === "baseline" ? [201, 201] : [200, 201]);
      replayStatuses.push({ family, statuses: seen });
    }
    const artifactKey = "artifacts/exact-review/v1/" + sha256(Buffer.from("original"));
    assert.equal((await put(artifactKey, Buffer.from("mismatch"))).status, 400);
    const assetKey = "assets/conditional-proof.svg";
    assert.equal((await put(assetKey, Buffer.from("old"))).status, 201);
    assert.equal((await put(assetKey, Buffer.from("new"))).status, 201);
    const asset = await post("chunk", { path: assetKey, offset: 0, length: 3 });
    assert.equal(await asset.text(), "new");
    assert.equal(externalRequests, 0);
    results.push({
      variant,
      ownerSha256: sha256(variant === "baseline" ? baseline : readFileSync(owner)),
      nativeConditionalResults: ["null", "object"],
      divergentStatuses: statuses.sort(),
      replayStatuses,
      winnerDigest: sha256(winner),
      calls,
      externalRequests,
    });
  } finally {
    await mf.dispose();
  }
}
console.log(
  JSON.stringify(
    {
      result: "passed",
      base,
      node: process.version,
      runtime: "Miniflare 4.20260708.1 / workerd 1.20260708.1",
      results,
      limits: "local R2 implementation; no production/distributed R2 or multipart atomicity proof",
    },
    null,
    2,
  ),
);
