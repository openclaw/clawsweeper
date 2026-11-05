import fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Console } from "node:console";
import worker from "../../dashboard/worker.ts";
import { readCoverageForBuild } from "../../dashboard-site/scripts/coverage.ts";
import { coverageCliFixture } from "./review-coverage-cli.ts";
import { installCoverageFailure } from "./coverage-summary-failure.ts";
const root = resolve(import.meta.dirname, "../.."),
  canonical = join(root, "dist/repair/target-fanout.js"),
  entry = join(dirname(canonical), "coverage-summary-failure-entry-" + process.pid + ".mjs"),
  trace = process.env.CENSUS_SUMMARY_FAILURE_TRACE,
  stage = process.env.CENSUS_SUMMARY_FAILURE_STAGE ?? "start",
  kind = process.env.CENSUS_SUMMARY_FAILURE_KIND ?? "http503",
  sha = (x) => createHash("sha256").update(x).digest("hex");
const f = await coverageCliFixture([{ name: "core", issues: 2, pulls: 1 }]);
let argv;
// Reuse the exact existing fixture argument owner without executing its mocked
// export. The byte-identical compiled entry then exercises its REAL main guard.
f.useImplementations({
  runTargetFanout: async (args) => {
    argv = [...args];
  },
  worker,
  readCoverageForBuild,
  queue: f.authority.queue,
});
await f.run("coverage", "v2", { windowDays: 7 });
const fault = installCoverageFailure(f, stage, kind),
  realConsole = new Console(process.stdout, process.stderr),
  bytes = fs.readFileSync(canonical),
  compiledSha256 = sha(bytes);
fs.writeFileSync(entry, bytes);
if (sha(fs.readFileSync(entry)) !== compiledSha256)
  throw new Error("compiled failure fixture mismatch");
console.error = realConsole.error.bind(realConsole);
process.once("beforeExit", () => {
  const result = {
    actualCliExit: process.exitCode ?? 0,
    compiledCanonicalSha256: compiledSha256,
    compiledEntrySha256: sha(fs.readFileSync(entry)),
    entryByteIdentical: true,
    stage,
    kind,
    countQueries: fault.countQueries,
    identityQueries: fault.identityQueries,
    controlRequests: fault.requests,
    publicReads: f.publicCoverageReads,
    v1Publications: f.calls.filter(
      (c) => c.path.endsWith("/review-coverage/inventory") && c.method === "POST",
    ).length,
  };
  fault.restore();
  f.close();
  result.fixtureClosed = true;
  fs.unlinkSync(entry);
  if (trace) fs.writeFileSync(trace, JSON.stringify(result, null, 2));
});
process.argv = [process.execPath, entry, ...argv];
await import(pathToFileURL(entry).href);
