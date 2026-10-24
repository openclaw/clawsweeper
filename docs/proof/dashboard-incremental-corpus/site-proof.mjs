// Data and check steps of the controlled Dashboard site job in run-workflow-proof.mjs. The job
// keeps the publish job's own cache restore, corpus selection and site build steps; this script
// stands in for build-data.ts (live GitHub and production API reads) by combining the selected
// corpus with the committed fixture, and checks the built pages afterwards. Run from dashboard-site/.
//
//   node ../docs/proof/dashboard-incremental-corpus/site-proof.mjs data ../.dashboard-state/corpus.json
//   node ../docs/proof/dashboard-incremental-corpus/site-proof.mjs check
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { combineCorpus } from "../../../dashboard-site/scripts/records.ts";

const [mode, corpusPath] = process.argv.slice(2);
if (mode === "data") {
  const cache = JSON.parse(readFileSync(corpusPath, "utf8"));
  const fixture = JSON.parse(readFileSync("fixtures/dashboard.json", "utf8"));
  // build-corpus.ts already left non-public repositories out of the aggregate.
  const corpus = combineCorpus(cache, () => true);
  mkdirSync("src/data", { recursive: true });
  writeFileSync("src/data/dashboard.json", JSON.stringify({ ...fixture, generatedAt: new Date().toISOString(), corpus }));
  console.log(JSON.stringify({ siteCorpusGeneratedAt: cache.generatedAt, siteRecords: corpus.totals.records }));
} else if (mode === "check") {
  const html = readdirSync("dist", { recursive: true })
    .filter((file) => String(file).endsWith(".html"))
    .map((file) => readFileSync(path.join("dist", String(file)), "utf8"))
    .join("\n");
  const records = JSON.parse(readFileSync("src/data/dashboard.json", "utf8")).corpus.totals.records;
  const shown = records.toLocaleString("en-US");
  if (!html.includes(shown)) throw new Error("the built site does not show " + shown + " records");
  console.log(JSON.stringify({ siteShowsRecords: shown, siteListsFsSafe: html.includes("openclaw/fs-safe") }));
} else {
  throw new Error("usage: site-proof.mjs data <corpus.json> | check");
}
