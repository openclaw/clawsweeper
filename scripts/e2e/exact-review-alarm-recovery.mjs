import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(resolve(process.argv[2], "package.json"));
const { build } = require("esbuild");
const { Miniflare } = require("miniflare");
const root = process.cwd();
const filename = root + "/dashboard/exact-review-queue.ts";
const baseRef = process.argv[3] || "e522ad2";
const entry = `import {ExactReviewQueue} from '${filename}';
export class Q extends ExactReviewQueue {
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.executions=0;}
 async handleAlarm(){
  this.executions++;
  await new Promise(resolve=>setTimeout(resolve,150));
  if(this.fail){await this.storage.deleteAlarm();throw Error('synthetic processor failure');}
 }
 async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/start'){
   await super.fetch(new Request('https://q/stats'));
   this.fail=url.searchParams.has('fail');
   this.commandIntakeStore.nextAttemptAt=()=>Date.now()-7200000;
   const realNow=Date.now;
   const stored=realNow()+100;await this.storage.setAlarm(stored);
   try {
    Date.now=()=>stored+6*60_000;
    await this.scheduleNext({items:{},deliveries:{}},Date.now());
    // Exercise the public native-entry method while request recovery runs.
    // This is a method-level race, not a claim of native platform delivery.
    if(this.executions){this.ctx.waitUntil(this.alarm().catch(()=>{}));}
   }finally{Date.now=realNow;}
   return Response.json({executions:this.executions,inFlight:this.alarmInFlightAt!==null});
  }
  return Response.json({executions:this.executions,inFlight:this.alarmInFlightAt!==null,alarm:await this.storage.getAlarm(),now:Date.now()});
 }
}
export default{fetch(r,e){return e.Q.get(e.Q.idFromName(new URL(r.url).searchParams.has('fail')?'failure':'success')).fetch(r);}};`;
const observations = {
  runtime: "real workerd / SQLite Durable Object",
  base_sha: execFileSync("git", ["rev-parse", baseRef], { encoding: "utf8" }).trim(),
  limits:
    "Real alarm wrapper, scheduler, storage, request/background lifecycle. Application clock advances six minutes; handleAlarm is a controlled delayed success/failure sink with no external effects. Native-entry race is a method call, not platform alarm delivery.",
};
for (const variant of ["base", "head"]) {
  const contents =
    variant === "base"
      ? execFileSync("git", ["show", baseRef + ":dashboard/exact-review-queue.ts"], {
          encoding: "utf8",
          maxBuffer: 8e6,
        })
      : readFileSync(filename, "utf8");
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
    observations[variant] = {};
    for (const scenario of ["success", "failure"]) {
      const query = scenario === "failure" ? "?fail" : "";
      const start = await (await mf.dispatchFetch("https://proof/start" + query)).json();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const settled = await (await mf.dispatchFetch("https://proof/state" + query)).json();
      observations[variant][scenario] = { start, settled };
      if (variant === "base") assert.equal(start.executions, 0);
      else {
        assert.equal(start.executions, 1);
        assert.equal(start.inFlight, true);
        assert.equal(settled.executions, 1);
        assert.equal(settled.inFlight, false);
        if (scenario === "failure") assert.ok(settled.alarm > settled.now);
      }
    }
  } finally {
    await mf.dispose();
  }
}
if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify(observations, null, 2));
console.log(JSON.stringify(observations, null, 2));
