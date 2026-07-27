import fs from "node:fs";
import path from "node:path";

import { repoRoot } from "./lib.js";

export function existingGitcrawlMemberRefs(
  roots: readonly string[],
  targetRepo: string,
  relativeTo = repoRoot(),
): Map<number, string[]> {
  const refs = new Map<number, string[]>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { recursive: true })) {
      const file = path.join(root, String(entry));
      if (!file.endsWith(".md") || !fs.statSync(file).isFile()) continue;
      const text = fs.readFileSync(file, "utf8");
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterRepo(frontmatter?.[1] ?? "") !== targetRepo) continue;
      const clusterRefs = frontmatter?.[1]?.match(/^cluster_refs:\n((?:  - .+\n?)*)/m)?.[1] ?? "";
      for (const match of clusterRefs.matchAll(/#(\d+)/g)) {
        const number = Number(match[1]);
        if (!Number.isSafeInteger(number)) continue;
        const files = refs.get(number) ?? [];
        const relative = path.relative(relativeTo, file);
        if (!files.includes(relative)) files.push(relative);
        refs.set(number, files);
      }
    }
  }
  return refs;
}

export function existingGitcrawlClusterIds(
  roots: readonly string[],
  targetRepo: string,
): Set<number> {
  const ids = new Set<number>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { recursive: true })) {
      const file = path.join(root, String(entry));
      if (!fs.statSync(file).isFile()) continue;
      if (file.endsWith(".md")) {
        const text = fs.readFileSync(file, "utf8");
        const frontmatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
        if (frontmatterRepo(frontmatter) !== targetRepo) continue;
        for (const match of text.matchAll(/\b(?:ghcrawl|gitcrawl)-(\d+)\b/g)) {
          ids.add(Number(match[1]));
        }
        continue;
      }
      if (!file.endsWith(".json")) continue;
      try {
        const ledger = JSON.parse(fs.readFileSync(file, "utf8")) as {
          target_repo?: unknown;
          clusters?: unknown;
        };
        if (ledger.target_repo !== targetRepo || !isRecord(ledger.clusters)) continue;
        for (const clusterId of Object.keys(ledger.clusters)) {
          const number = Number(clusterId);
          if (Number.isSafeInteger(number) && number > 0) ids.add(number);
        }
      } catch {
        // A malformed or unrelated JSON file is not authoritative history.
      }
    }
  }
  return ids;
}

function frontmatterRepo(frontmatter: string): string {
  return /^repo:\s*["']?([^\s"']+)["']?\s*$/m.exec(frontmatter)?.[1] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
