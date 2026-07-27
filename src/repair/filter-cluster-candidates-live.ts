#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  hasClusterDecisionSignal,
  hasClusterFeatureSignal,
  hasClusterSecuritySignal,
} from "./gitcrawl-cluster-ranking.js";

type LiveItem = {
  number: number;
  state: string;
  title: string;
  body?: string;
  updated_at: string;
  labels: Array<{ name?: string }>;
  pull_request?: unknown;
};

type LivePull = {
  draft: boolean;
  maintainer_can_modify: boolean;
  head?: { repo?: { full_name?: string | null } | null };
};

export function filterClusterCandidatesLive(options: {
  repo: string;
  paths: readonly string[];
  now?: Date;
  maxAccepted?: number;
  readItem?: (number: number) => LiveItem;
  readPull?: (number: number) => LivePull;
}): { accepted: string[]; rejected: Array<{ path: string; reasons: string[] }> } {
  const now = options.now ?? new Date();
  const readItem = options.readItem ?? ((number) => githubItem(options.repo, number));
  const readPull = options.readPull ?? ((number) => githubPull(options.repo, number));
  const accepted: string[] = [];
  const rejected: Array<{ path: string; reasons: string[] }> = [];
  for (const jobPath of options.paths) {
    if (!/^jobs\/[A-Za-z0-9_.-]+\/inbox\/gitcrawl-[1-9]\d*-[^/]+\.md$/.test(jobPath)) {
      throw new Error(`invalid live cluster candidate path: ${jobPath}`);
    }
    const content = readFileSync(resolve(jobPath), "utf8");
    const candidateNumbers = frontmatterRefs(content, "candidates");
    const clusterNumbers = frontmatterRefs(content, "cluster_refs");
    if (
      candidateNumbers.length < 2 ||
      candidateNumbers.some((number) => !clusterNumbers.includes(number))
    ) {
      throw new Error("cluster context must contain at least two candidate refs");
    }
    const itemsByNumber = new Map(clusterNumbers.map((number) => [number, readItem(number)]));
    const candidates = candidateNumbers.map((number) => itemsByNumber.get(number)!);
    const clusterItems = [...itemsByNumber.values()];
    const reasons: string[] = [];
    const open = candidates.filter((item) => item.state.toLowerCase() === "open");
    if (open.length < 2) {
      reasons.push(`only ${open.length}/${candidates.length} candidates remain open`);
    }
    if (candidates.some((item) => item.state.toLowerCase() !== "open")) {
      reasons.push("candidate closed or merged after gitcrawl export");
    }
    const latestUpdate = Math.max(
      ...open.map((item) => Date.parse(item.updated_at)).filter(Number.isFinite),
    );
    if (!Number.isFinite(latestUpdate) || now.getTime() - latestUpdate > 45 * 86_400_000) {
      reasons.push("live candidates are stale");
    }
    if (
      clusterItems.some((item) =>
        hasClusterSecuritySignal({
          title: item.title,
          body: item.body ?? "",
          labels_json: JSON.stringify(item.labels.map((label) => label.name || "")),
        }),
      )
    ) {
      reasons.push("live cluster context has a security signal");
    }
    if (
      clusterItems.some((item) =>
        hasClusterFeatureSignal({
          title: item.title,
          body: item.body ?? "",
          labels_json: JSON.stringify(item.labels),
        }),
      )
    ) {
      reasons.push("live cluster context is feature or proposal work");
    }
    if (
      clusterItems.some((item) =>
        hasClusterDecisionSignal({
          title: item.title,
          body: item.body ?? "",
          labels_json: JSON.stringify(item.labels),
        }),
      )
    ) {
      reasons.push("live cluster context requires maintainer or product decision");
    }
    const pullCandidates = open.filter((item) => item.pull_request !== undefined);
    if (
      pullCandidates.length > 0 &&
      pullCandidates
        .map((item) => readPull(item.number))
        .every((pull) => {
          const sameRepositoryHead = pull.head?.repo?.full_name === options.repo;
          return pull.draft || (!sameRepositoryHead && pull.maintainer_can_modify === false);
        })
    ) {
      reasons.push("no repairable open implementation PR");
    }
    if (reasons.length === 0 && accepted.length >= (options.maxAccepted ?? Infinity)) {
      reasons.push("lower-ranked eligible candidate beyond intake limit");
    }
    if (reasons.length > 0) rejected.push({ path: jobPath, reasons });
    else accepted.push(jobPath);
  }
  return { accepted, rejected };
}

function frontmatterRefs(content: string, field: "candidates" | "cluster_refs"): number[] {
  const block = new RegExp(`^${field}:\\n((?:  - .+\\n?)*)`, "m").exec(content)?.[1] ?? "";
  const refs = [...block.matchAll(/#([1-9]\d*)/g)].map((match) => Number(match[1]));
  if (refs.length < 1 || refs.length > 20 || new Set(refs).size !== refs.length) {
    throw new Error(`cluster job requires bounded unique ${field} refs`);
  }
  return refs;
}

function githubItem(repo: string, number: number): LiveItem {
  const output = execFileSync("gh", ["api", `repos/${repo}/issues/${number}`], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(output) as LiveItem;
}

function githubPull(repo: string, number: number): LivePull {
  const output = execFileSync("gh", ["api", `repos/${repo}/pulls/${number}`], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(output) as LivePull;
}

if (process.argv[1]?.endsWith("filter-cluster-candidates-live.js")) {
  const values = process.argv.slice(2);
  const value = (name: string): string => {
    const index = values.indexOf(name);
    if (index < 0 || !values[index + 1]) throw new Error(`${name} is required`);
    return values[index + 1]!;
  };
  const input = resolve(value("--paths-file"));
  const output = resolve(value("--out"));
  const report = resolve(value("--report"));
  const paths = readFileSync(input, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const maxAccepted = Number(value("--limit"));
  if (!Number.isSafeInteger(maxAccepted) || maxAccepted < 1 || maxAccepted > 20) {
    throw new Error("--limit must be an integer from 1 to 20");
  }
  const result = filterClusterCandidatesLive({
    repo: value("--repo"),
    paths,
    maxAccepted,
  });
  for (const rejection of result.rejected) {
    console.error(`reject live cluster ${rejection.path}: ${rejection.reasons.join("; ")}`);
  }
  writeFileSync(output, `${result.accepted.join("\n")}${result.accepted.length ? "\n" : ""}`);
  writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`live cluster fence accepted ${result.accepted.length}/${paths.length} candidate(s)`);
}
