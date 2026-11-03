// Build src/data/dashboard.json for one static dashboard deploy.
//
//   node scripts/build-data.ts --state <state dir>
//
// Inputs: the corpus aggregate <state dir>/corpus.json (scripts/build-corpus.ts), the public Worker
// APIs for live queue, coverage, 7-day queue health history and apply outcomes, and an
// incremental GitHub Actions history kept in the
// state directory between runs. Tokens: GITHUB_TOKEN for incremental reads and repository
// visibility; BOOTSTRAP_GITHUB_TOKEN (optional, higher rate limit) when no history exists yet.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  backfillSweepCounts,
  loadActionsState,
  refreshActions,
  saveActionsState,
  summarizeActions,
} from "./actions.ts";
import { type CorpusCache } from "./records.ts";
import { summarizeOperations } from "./operations.ts";
import { readCoverageForBuild, publicDashboardInputs } from "./coverage.ts";

const ORIGIN = "https://clawsweeper.openclaw.ai";
const site = new URL("../", import.meta.url).pathname;

const { values } = parseArgs({
  options: { state: { type: "string" }, "backfill-days": { type: "string", default: "0" } },
});
if (!values.state) throw new Error("usage: build-data.ts --state <dir> [--backfill-days <0-30>]");
const stateDir = values.state;
const backfillDays = Number(values["backfill-days"]);
if (!Number.isInteger(backfillDays) || backfillDays < 0 || backfillDays > 30)
  throw new Error("--backfill-days must be a whole number from 0 to 30");
await mkdir(stateDir, { recursive: true });

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN is required");
const coverageSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET;
if (!coverageSecret) throw new Error("coverage_build_secret_required");

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// The public APIs are served by the production Worker; a short outage or a dropped connection
// (a socket can close mid-body) must not fail the build.
async function publicApi(path: string) {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const response = await fetch(`${ORIGIN}${path}`, { headers: { Accept: "application/json" } });
      if (response.ok) return await response.json();
      failure = `HTTP ${response.status}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (attempt >= 4) throw new Error(`${path}: ${failure}`);
    await sleep(attempt * 15_000);
  }
}

// The build never reads records: the Dashboard corpus workflow refreshes the aggregate
// (scripts/build-corpus.ts) and this build reuses the newest one.
const cache = await readJson<CorpusCache | null>(join(stateDir, "corpus.json"), null);
if (cache?.version !== 2)
  throw new Error("no cached corpus: run the Dashboard corpus workflow once with mode=full");

// A repository can turn private after the corpus was built. Every build lists the owners'
// public repositories again; a corpus name not on that list (renamed or transferred) is
// checked on its own, and GitHub follows the redirect. Anything not public is dropped.
// A failed listing fails the build: nothing is published without a current answer.
const github = (path: string) =>
  fetch(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
  });
const actionsPath = join(stateDir, "actions.json");
const previous = await loadActionsState(actionsPath);
const actionsState = await refreshActions(
  previous,
  previous ? token : (process.env.BOOTSTRAP_GITHUB_TOKEN ?? token),
);
// Count-only sweep history for older days uses this repository's GITHUB_TOKEN, never the app
// token: the app's rate limit is shared with production reviews.
if (backfillDays > 0)
  console.log(
    JSON.stringify({ sweepBackfill: await backfillSweepCounts(actionsState, token, backfillDays) }),
  );
await saveActionsState(actionsPath, actionsState);

const [queue, coverage, history, applyDay, applyWeek] = await Promise.all([
  publicApi("/api/exact-review-queue"),
  readCoverageForBuild(coverageSecret),
  publicApi("/api/health-history?range=7d"),
  publicApi("/api/apply-observability?range=24h"),
  publicApi("/api/apply-observability?range=7d"),
]);

// One CURRENT validation of the full publication population, after data reads.
// No private candidate is written to disk or substituted from the anonymous API.
const selected = await publicDashboardInputs(cache, coverage, github);
const corpus = selected.corpus;
const publicCoverage = selected.coverage;
const repositoryStates = selected.repositoryStates;
const dashboard = {
  generatedAt: new Date().toISOString(),
  queue,
  coverage: publicCoverage,
  repositoryStates,
  operations: summarizeOperations(history, applyDay, applyWeek),
  actions: summarizeActions(actionsState),
  corpus,
};
await mkdir(join(site, "src/data"), { recursive: true });
await writeFile(join(site, "src/data/dashboard.json"), JSON.stringify(dashboard));
console.log(
  JSON.stringify({
    records: corpus.totals.records,
    repositories: corpus.totals.repositories,
    workflows: dashboard.actions.workflows.length,
    actionsFrom: dashboard.actions.coveredFrom,
  }),
);
