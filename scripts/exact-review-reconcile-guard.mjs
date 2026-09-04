#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const RECONCILE_COOLDOWN_MS = 5 * 60_000;

export function recentReconciliation(runs, loadJobs, { now = Date.now(), currentRunId = "" } = {}) {
  for (const run of runs) {
    const age = now - Date.parse(run.updatedAt);
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
        const completedAge = now - Date.parse(job.completedAt);
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

export function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !process.env.GITHUB_OUTPUT) throw new Error("missing guard configuration");
  const gh = (args) =>
    JSON.parse(
      execFileSync("gh", args, {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
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
      { currentRunId: process.env.GITHUB_RUN_ID || "" },
    );
  } catch {
    // History is an optimization, not authority to postpone lease recovery.
    console.error("Reconcile history unavailable; continuing reconciliation.");
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `reconcile=${recentRun === null}\n`);
  console.log(
    recentRun
      ? `Skipping lease reconciliation: completed run ${recentRun} is under five minutes old.`
      : "No recent completed lease reconciliation; continuing.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
