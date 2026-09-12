import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve(process.argv[2], "package.json"));
const { build } = require("esbuild");
const { Miniflare } = require("miniflare");
const base = process.argv[3];
assert.match(base ?? "", /^[a-f0-9]{40}$/);
const files = ["dashboard/worker.ts", "dashboard/public-observability.ts"];
const baseline = new Map(
  files.map((file) => [
    resolve(file),
    execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8", maxBuffer: 8e6 }),
  ]),
);
const responses = [];
const entry = `
import worker from './dashboard/worker.ts';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-09-12T12:00:00.000Z'])); }
  static now() { return RealDate.parse('2026-09-12T12:00:00.000Z'); }
};
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/proof-cache') {
      const { path, body } = await request.json();
      const key = new Request(new URL(path, request.url));
      if (body === null) await caches.default.delete(key);
      else await caches.default.put(key, Response.json(body, { headers: { 'cache-control': 'public, max-age=600' } }));
      return Response.json({ seeded: true });
    }
    return worker.fetch(request, env, ctx);
  }
};`;

for (const variant of ["base", "candidate"]) {
  const bundle = await build({
    stdin: { contents: entry, sourcefile: "proof.ts", resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
    plugins:
      variant === "base"
        ? [
            {
              name: "baseline",
              setup(builder) {
                builder.onLoad(
                  { filter: /\/dashboard\/(worker|public-observability)\.ts$/ },
                  (args) => ({ contents: baseline.get(args.path), loader: "ts" }),
                );
              },
            },
          ]
        : [],
  });
  const runtime = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-05-11",
    outboundService: () => {
      throw new Error("External request forbidden");
    },
  });
  const bodies = [];
  try {
    const seed = async (path, body) => {
      const result = await runtime.dispatchFetch("https://proof/proof-cache", {
        method: "POST",
        body: JSON.stringify({ path, body }),
      });
      assert.equal(result.status, 200);
    };
    for (const [route, cachePath] of [
      ["triage", "triage-cache/v3"],
      ["pr-proof-triage", "pr-proof-triage-cache/v2"],
    ]) {
      const read = async () => {
        const response = await runtime.dispatchFetch(`https://proof/api/${route}`);
        assert.equal(response.status, 200);
        const body = await response.text();
        assert.equal(body.includes("synthetic-private"), false);
        bodies.push(body);
        return JSON.parse(body);
      };
      const unavailable = await read();
      assert.equal(unavailable.complete, false);
      const fixture = {
        schema_version: 1,
        generated_at: "2026-09-12T12:00:00.000Z",
        diagnostics: { errors: [] },
        counts: Object.fromEntries(unavailable.views.map((view) => [view.id, 2])),
        views: unavailable.views.map((view) => ({
          ...view,
          total_count: 2,
          item_limit: 10,
          items: [{ title: "synthetic-private", url: "https://example.invalid/synthetic-private" }],
        })),
      };
      await seed(`/api/${cachePath}/fresh`, fixture);
      const fresh = await read();
      assert.equal(fresh.complete, true);
      assert.ok(fresh.views.every((view) => view.total_count === 2 && view.items.length === 0));
      await seed(`/api/${cachePath}/fresh`, fresh);
      assert.deepEqual(await read(), fresh);
      await seed(`/api/${cachePath}/fresh`, { ...fixture, counts: {} });
      await seed(`/api/${cachePath}/stale`, fixture);
      assert.deepEqual(await read(), fresh);
      await seed(`/api/${cachePath}/stale`, null);
      assert.deepEqual(await read(), unavailable);
    }
    responses.push(bodies);
  } finally {
    await runtime.dispose();
  }
}
assert.deepEqual(responses[0], responses[1]);
console.log(
  JSON.stringify(
    {
      base,
      head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      source_sha256: createHash("sha256")
        .update(
          files
            .concat(["dashboard/public-timestamp.ts", "dashboard/public-triage.ts"])
            .map((file) => readFileSync(file, "utf8"))
            .join("\n"),
        )
        .digest("hex"),
      runtime: "built Worker in workerd with real Cache API",
      response_count: responses[1].length,
      response_sha256: createHash("sha256").update(JSON.stringify(responses[1])).digest("hex"),
      byte_identical: true,
      production_mutations: 0,
      limits:
        "Both public triage routes; raw and projected fresh caches, malformed fresh with valid stale fallback, incomplete collection. Synthetic cache seeding and a fixed application clock; no GitHub transport or deployment.",
    },
    null,
    2,
  ),
);
