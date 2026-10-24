// Local phases of one hourly corpus refresh at production scale, without a Worker: unseal the
// cached tree, build the aggregate, seal the tree again. Request counts come from run-proof.mjs.
//
//   node docs/proof/dashboard-incremental-corpus/bench.mjs [--records 100000] [--repositories 150]
//     [--samples 5] [--baseline <checkout>]
//
// With --baseline, the same phases run from that checkout too, interleaved (ABAB, alternating
// which goes first), and both aggregates must be equal apart from generatedAt. Synthetic front
// matter is sized like production review records (about 900 bytes each).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    records: { type: "string", default: "100000" },
    repositories: { type: "string", default: "150" },
    samples: { type: "string", default: "5" },
    baseline: { type: "string" },
  },
});
const records = Number(values.records);
const repositories = Number(values.repositories);
const samples = Number(values.samples);
const candidate = path.resolve(new URL("../../..", import.meta.url).pathname);
const checkouts = { candidate, ...(values.baseline ? { baseline: path.resolve(values.baseline) } : {}) };
const root = mkdtempSync(path.join(tmpdir(), "dashboard-corpus-bench-"));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAWSWEEPER_RECORDS_SECRET: "bench-secret" };

try {
  // One large repository with 60% of the records, the rest spread evenly, like production.
  const state = path.join(root, "seed");
  const now = Date.now();
  const at = new Date(now).toISOString();
  const cursor = { schemaVersion: 1, sections: ["items", "closed"], fullRebuildAt: at, refreshedAt: at, repositories: {} };
  const visibility = {};
  for (let index = 0; index < repositories; index++) {
    cursor.repositories["openclaw-repo" + index] = { revision: 1000 + index, refreshedAt: at, source: "full" };
    visibility["openclaw/repo" + index] = { public: true, checkedAt: at };
    for (const section of ["items", "closed"])
      mkdirSync(path.join(state, "records", "openclaw-repo" + index, section), { recursive: true });
  }
  for (let number = 1; number <= records; number++) {
    const repo = number <= records * 0.6 ? 0 : 1 + (number % (repositories - 1));
    const archived = number % 3 === 0;
    const decision = {
      decision: archived ? "close" : "keep_open",
      closeReason: archived ? "implemented_on_main" : null,
      confidence: "high",
      prRating: { overallTier: "solid" },
      realBehaviorProof: { status: "sufficient", summary: "Synthetic proof summary. ".repeat(6) },
      securityReview: { status: number % 11 ? "cleared" : "needs_attention" },
      maintainerDecision: { required: number % 7 === 0, kind: "product" },
      reviewFindings: [{ priority: 2, title: "Synthetic finding" }, { priority: 3, title: "Another finding" }],
    };
    const content = [
      "---",
      "repository: openclaw/repo" + repo,
      "number: " + number,
      "type: " + (number % 2 ? "issue" : "pull_request"),
      "title: " + JSON.stringify("Synthetic benchmark item " + number),
      "reviewed_at: " + new Date(now - (number % 60) * 86_400_000).toISOString(),
      "item_created_at: " + new Date(now - ((number % 90) + 30) * 86_400_000).toISOString(),
      "author_association: NONE",
      'labels: ["bug","synthetic"]',
      "review_policy: standard",
      "review_codex_elapsed_ms: " + (60_000 + number),
      ...(archived ? ["action_taken: closed", "applied_at: " + new Date(now - (number % 9) * 86_400_000).toISOString()] : []),
      "review_record: " + JSON.stringify({ version: 1, decision }),
      "---",
      "",
    ].join("\n");
    writeFileSync(path.join(state, "records", "openclaw-repo" + repo, archived ? "closed" : "items", number + ".md"), content);
  }
  writeFileSync(path.join(state, "cursor.json"), JSON.stringify(cursor));
  const treeBytes = Number(execFileSync("du", ["-sb", path.join(state, "records")], { encoding: "utf8" }).split("\t")[0]);

  const timings = {};
  const corpora = {};
  function run(name, checkout, phase, args) {
    const started = performance.now();
    execFileSync(process.execPath, args, { cwd: checkout, env, stdio: ["ignore", "ignore", "inherit"] });
    ((timings[name] ??= {})[phase] ??= []).push(performance.now() - started);
  }
  const archive = path.join(root, "tree.sealed");
  for (let sample = 0; sample < samples; sample++) {
    const order = Object.keys(checkouts);
    if (sample % 2) order.reverse();
    for (const name of order) {
      const checkout = checkouts[name];
      const live = path.join(root, "live");
      const out = path.join(root, "out-" + name);
      rmSync(live, { recursive: true, force: true });
      cpSync(state, live, { recursive: true });
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "visibility.json"), JSON.stringify(visibility));
      run(name, checkout, "seal", ["scripts/dashboard-corpus.ts", "pack", "--state", live, "--archive", archive]);
      run(name, checkout, "unseal", ["scripts/dashboard-corpus.ts", "unpack", "--archive", archive, "--state", live]);
      run(name, checkout, "aggregate", ["dashboard-site/scripts/build-corpus.ts", "--records", path.join(live, "records"), "--out", out]);
      corpora[name] = { ...JSON.parse(readFileSync(path.join(out, "corpus.json"), "utf8")), generatedAt: undefined };
    }
  }
  if (corpora.baseline) {
    for (const corpus of Object.values(corpora)) for (const part of corpus.repositories) part.stats.reviewed7d = part.stats.reviewed30d = 0;
    assert.deepEqual(corpora.candidate, corpora.baseline);
  }
  const summarize = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]);
    return { median: pick(0.5), p95: pick(0.95), min: Math.round(sorted[0]), max: Math.round(sorted.at(-1)) };
  };
  console.log(
    JSON.stringify(
      {
        records,
        repositories,
        samples,
        treeFiles: records,
        treeBytes,
        sealedBytes: statSync(archive).size,
        msPerPhase: Object.fromEntries(
          Object.entries(timings).map(([name, phases]) => [
            name,
            Object.fromEntries(Object.entries(phases).map(([phase, values]) => [phase, summarize(values)])),
          ]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
