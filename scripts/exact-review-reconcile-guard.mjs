#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RECONCILE_COOLDOWN_MS = 5 * 60_000;
export const HISTORY_READ_DEADLINE_MS = 60_000;

export function recentReconciliation(
  runs,
  loadJobs,
  { now = Date.now(), currentRunId = "", clock = () => now } = {},
) {
  for (const run of runs) {
    const age = clock() - Date.parse(run.updatedAt);
    if (
      String(run.databaseId) === currentRunId ||
      !Number.isFinite(age) ||
      age < 0 ||
      age >= RECONCILE_COOLDOWN_MS
    )
      continue;
    const jobs = loadJobs(String(run.databaseId));
    if (
      jobs.some((job) => {
        const completedAge = clock() - Date.parse(job.completedAt);
        return (
          job.status === "completed" &&
          job.conclusion === "success" &&
          completedAge >= 0 &&
          completedAge < RECONCILE_COOLDOWN_MS &&
          (job.name.endsWith("/ Reconcile terminal run") ||
            job.name === "Reconcile terminal run" ||
            job.name === "Sweep terminal exact-review runs")
        );
      })
    ) {
      return String(run.databaseId);
    }
  }
  return null;
}

export function main({
  env = process.env,
  exec = execFileSync,
  clock = () => performance.now(),
  now = Date.now,
} = {}) {
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !env.GITHUB_OUTPUT) throw new Error("missing guard configuration");
  const deadline = clock() + HISTORY_READ_DEADLINE_MS;
  const gh = (args) => {
    const remaining = Math.floor(deadline - clock());
    if (remaining <= 0) throw new Error("history read deadline exhausted");
    const result = JSON.parse(
      exec("gh", args, {
        encoding: "utf8",
        timeout: Math.min(15_000, remaining),
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    if (clock() >= deadline) throw new Error("history read deadline exhausted");
    return result;
  };
  let recentRun = null;
  try {
    const runs = gh([
      "run",
      "list",
      "--repo",
      repository,
      "--workflow",
      "exact-review-reconcile.yml",
      "--limit",
      "30",
      "--json",
      "databaseId,updatedAt",
    ]);
    recentRun = recentReconciliation(
      runs,
      (id) => gh(["run", "view", id, "--repo", repository, "--json", "jobs"]).jobs,
      { currentRunId: env.GITHUB_RUN_ID || "", clock: now },
    );
  } catch {
    // History is an optimization, not authority to postpone lease recovery.
    console.error("Reconcile history unavailable; continuing reconciliation.");
  }
  appendFileSync(env.GITHUB_OUTPUT, `reconcile=${recentRun === null}\n`);
  console.log(
    recentRun
      ? `Skipping lease reconciliation: completed run ${recentRun} is under five minutes old.`
      : "No recent completed lease reconciliation; continuing.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
