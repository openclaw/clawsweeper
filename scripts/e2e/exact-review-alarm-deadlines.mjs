import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
const require = createRequire(resolve(process.argv[2], "package.json"));
const { build } = require("esbuild");
const { Miniflare } = require("miniflare");
const root = process.cwd();
const filename = root + "/dashboard/exact-review-queue.ts";
const base = execFileSync(
  "git",
  ["show", (process.argv[3] || "d55f1be") + ":dashboard/exact-review-queue.ts"],
  { encoding: "utf8", maxBuffer: 8e6 },
);
const entry = `import {ExactReviewQueue} from '${filename}';
export class Q extends ExactReviewQueue {
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;}
 async fetch(request){
  await super.fetch(new Request('https://q/stats'));
  this.commandIntakeStore.nextAttemptAt=()=>Date.now()-7200000;
  const before=Date.now()+500; await this.storage.setAlarm(before);
  this.invalidateReadCaches();
  await super.fetch(new Request('https://q/stats'));
  const after=await this.storage.getAlarm();
  // Exercise the adjacent fast path independently on the same real storage.
  const fastBefore=Date.now()+500;await this.storage.setAlarm(fastBefore);
  await this.scheduleSourceAuthorityVerification(Date.now()-7200000);
  const fastAfter=await this.storage.getAlarm();
  await this.storage.deleteAlarm();
  const missingStartedAt=Date.now();
  await this.scheduleSourceAuthorityVerification(Date.now()-7200000);
  const missingAfter=await this.storage.getAlarm();
  await this.storage.deleteAlarm();
  // Hold the input gate while a real pending alarm becomes due. Request
  // scheduling must not move it later simply because delivery is delayed.
  const due = await this.ctx.blockConcurrencyWhile(async()=>{
   const dueBefore=Date.now()+20; await this.storage.setAlarm(dueBefore);
   await new Promise(resolve=>setTimeout(resolve,80));
   const dueObservedAt=Date.now();
   await this.scheduleSourceAuthorityVerification(Date.now()-7200000);
   const dueAfter=await this.storage.getAlarm();
   await this.storage.deleteAlarm();
   return {dueBefore,dueObservedAt,dueAfter};
  });
  // Advance only the application's clock to exercise the five-minute recovery
  // threshold quickly. Alarm storage and scheduling still use real workerd.
  const recovery = await this.ctx.blockConcurrencyWhile(async()=>{
   const realNow=Date.now;
   try {
    const stranded=Date.now()+500;await this.storage.setAlarm(stranded);
    let observed=stranded+6*60_000;Date.now=()=>observed;
    await this.scheduleNext({items:{},deliveries:{}},observed);
    const first=await this.storage.getAlarm();
    observed+=6*60_000;
    await this.scheduleNext({items:{},deliveries:{}},observed);
    const second=await this.storage.getAlarm();
    await this.storage.deleteAlarm();
    return {stranded,first,second};
   } finally {Date.now=realNow;}
  });
  return Response.json({before,after,fastBefore,fastAfter,missingStartedAt,missingAfter,...due,...recovery});
 }
 async alarm(){} // Terminal local sink: no GitHub or production effects.
}
export default{fetch(r,e){return e.Q.get(e.Q.idFromName('proof')).fetch(r);}};`;
const observations = {
  runtime: "real workerd / SQLite Durable Object",
  base_sha: execFileSync("git", ["rev-parse", process.argv[3] || "d55f1be"], {
    encoding: "utf8",
  }).trim(),
  limits:
    "Scheduling and storage paths are real; fixture seeds auxiliary due work and uses a no-op alarm sink. Stranded recovery advances only the application clock; native alarm storage remains real. No external calls or claim of production dispatch.",
};
for (const variant of ["base", "head"]) {
  const contents = variant === "base" ? base : readFileSync(filename, "utf8");
  const bundle = await build({
    stdin: { contents: entry, sourcefile: "proof.ts", loader: "ts", resolveDir: root },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2024",
    plugins: [
      {
        name: "source",
        setup(b) {
          b.onLoad({ filter: /\/dashboard\/exact-review-queue\.ts$/ }, () => ({
            contents,
            loader: "ts",
            resolveDir: root + "/dashboard",
          }));
        },
      },
    ],
  });
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-05-11",
    durableObjects: { Q: { className: "Q", useSQLite: true } },
    outboundService: () => {
      throw Error("External request forbidden");
    },
  });
  try {
    const result = await (await mf.dispatchFetch("https://proof/check")).json();
    observations[variant] = result;
    if (variant === "base") {
      assert.ok(result.after < result.before);
      assert.ok(result.fastAfter < result.fastBefore);
      assert.ok(result.missingAfter < result.missingStartedAt + 1000);
      assert.ok(result.dueObservedAt > result.dueBefore);
      assert.ok(result.dueAfter > result.dueBefore);
    } else {
      assert.equal(result.after, result.before);
      assert.equal(result.fastAfter, result.fastBefore);
      assert.ok(result.missingAfter >= result.missingStartedAt + 1000);
      assert.ok(result.dueObservedAt > result.dueBefore);
      assert.equal(result.dueAfter, result.dueBefore);
      assert.ok(result.first > result.stranded);
      assert.equal(result.second, result.first);
    }
  } finally {
    await mf.dispose();
  }
}
if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify(observations, null, 2));
console.log(JSON.stringify(observations, null, 2));
