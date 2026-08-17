#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reportLiveProofPlan } from "../clawsweeper-report-parser.js";
import { repositoryProfileFor } from "../repository-profiles.js";

export interface LiveProofDispatchCandidateOptions {
  targetRepo: string;
  itemNumbers: readonly string[];
  recordsRoot: string;
}

export function liveProofDispatchCandidates(
  options: LiveProofDispatchCandidateOptions,
): Array<{ item: number; plan: ReturnType<typeof reportLiveProofPlan> }> {
  const profile = repositoryProfileFor(options.targetRepo);
  if (!profile.liveTest?.enabled) return [];

  const candidates: Array<{ item: number; plan: ReturnType<typeof reportLiveProofPlan> }> = [];
  for (const rawItem of options.itemNumbers) {
    const item = Number(rawItem);
    if (!Number.isSafeInteger(item) || item < 1) continue;
    let markdown: string;
    try {
      markdown = readFileSync(
        join(options.recordsRoot, profile.slug, "items", `${item}.md`),
        "utf8",
      );
    } catch {
      continue;
    }
    const plan = reportLiveProofPlan(markdown);
    if (plan.status === "recommended") candidates.push({ item, plan });
  }
  return candidates;
}

function main(): void {
  const targetRepo = String(process.env.TARGET_REPO ?? "").trim();
  if (!targetRepo) throw new Error("TARGET_REPO is required");
  const itemNumbers = String(process.env.ITEM_NUMBERS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const recordsRoot = resolve(process.env.RECORDS_ROOT || "records");
  for (const candidate of liveProofDispatchCandidates({ targetRepo, itemNumbers, recordsRoot })) {
    process.stdout.write(`${JSON.stringify(candidate)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
