import fs from "node:fs";
import path from "node:path";
import { unmergedPaths, type RebaseOntoBaseResult } from "./git-repo-utils.js";

export type MechanicalRebaseConflictResult =
  | {
      status: "resolved";
      paths: string[];
      reason: string;
    }
  | {
      status: "skipped";
      paths: string[];
      reason: string;
    };

export function tryResolveMechanicalRebaseConflicts({
  targetDir,
  rebaseResult,
}: {
  targetDir: string;
  rebaseResult: RebaseOntoBaseResult;
}): MechanicalRebaseConflictResult {
  if (rebaseResult.status !== "conflicts") {
    return { status: "skipped", paths: [], reason: "rebase did not report conflicts" };
  }

  const paths = unmergedPaths(targetDir);
  if (paths.length === 0) {
    return {
      status: "skipped",
      paths,
      reason: "rebase has no unmerged paths",
    };
  }

  const resolutions: Array<{ filePath: string; text: string; reason: string }> = [];
  for (const filePath of paths) {
    const absolutePath = path.join(targetDir, filePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return {
        status: "skipped",
        paths,
        reason: `mechanical resolver cannot handle non-file conflict ${filePath}`,
      };
    }

    const original = fs.readFileSync(absolutePath, "utf8");
    if (filePath === "CHANGELOG.md") {
      const resolved = resolveChangelogConflictText(original);
      if (!resolved) {
        return {
          status: "skipped",
          paths,
          reason: "CHANGELOG.md conflict shape was not mechanically mergeable",
        };
      }
      resolutions.push({
        filePath,
        text: resolved,
        reason: "merged isolated CHANGELOG.md conflict by preserving both sides",
      });
      continue;
    }

    if (filePath === "docs/.generated/config-baseline.sha256") {
      const resolved = resolveGeneratedSha256ConflictText(original);
      if (!resolved) {
        return {
          status: "skipped",
          paths,
          reason: "generated config checksum conflict shape was not mechanically mergeable",
        };
      }
      resolutions.push({
        filePath,
        text: resolved,
        reason: "merged generated config checksums by preserving replayed entries",
      });
      continue;
    }

    return {
      status: "skipped",
      paths,
      reason:
        "mechanical resolver only handles CHANGELOG.md and generated config checksum conflicts",
    };
  }

  for (const resolution of resolutions) {
    fs.writeFileSync(path.join(targetDir, resolution.filePath), resolution.text);
  }

  return {
    status: "resolved",
    paths,
    reason: resolutions.map((resolution) => resolution.reason).join("; "),
  };
}

export function resolveChangelogConflictText(text: string): string | null {
  const conflictPattern =
    /^<<<<<<<[^\n]*\n([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\n]*\n([\s\S]*?))?^=======\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  let replaced = false;
  const resolved = text.replace(conflictPattern, (_match, ours, base = "", theirs) => {
    replaced = true;
    return mergeConflictSides(String(ours), String(theirs), String(base));
  });

  if (!replaced) return null;
  if (/^(<<<<<<<|\|\|\|\|\|\||=======|>>>>>>>)/m.test(resolved)) return null;
  return resolved.endsWith("\n") ? resolved : `${resolved}\n`;
}

function mergeConflictSides(ours: string, theirs: string, base: string): string {
  const baseLines = new Set(splitConflictSide(base));
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const line of [...splitConflictSide(ours), ...splitConflictSide(theirs)]) {
    if (baseLines.has(line) || seen.has(line)) continue;
    seen.add(line);
    merged.push(line);
  }
  return `${merged.join("\n")}\n`;
}

function splitConflictSide(text: string): string[] {
  const trimmed = text.replace(/\n+$/g, "");
  if (!trimmed) return [];
  return trimmed.split("\n");
}

export function resolveGeneratedSha256ConflictText(text: string): string | null {
  const conflictPattern =
    /^<<<<<<<[^\n]*\n([\s\S]*?)(?:^\|\|\|\|\|\|\|[^\n]*\n([\s\S]*?))?^=======\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  let failed = false;
  let replaced = false;
  const resolved = text.replace(conflictPattern, (_match, ours, base = "", theirs) => {
    replaced = true;
    const merged = mergeSha256ConflictSides(String(ours), String(theirs), String(base));
    if (!merged) {
      failed = true;
      return String(_match);
    }
    return merged;
  });

  if (!replaced || failed) return null;
  if (/^(<<<<<<<|\|\|\|\|\|\||=======|>>>>>>>)/m.test(resolved)) return null;
  return resolved.endsWith("\n") ? resolved : `${resolved}\n`;
}

function mergeSha256ConflictSides(ours: string, theirs: string, base: string): string | null {
  const oursEntries = parseSha256Side(ours);
  const theirsEntries = parseSha256Side(theirs);
  const baseEntries = parseSha256Side(base);
  if (!oursEntries || !theirsEntries || !baseEntries) return null;

  const order = uniqueOrdered([
    ...oursEntries.keys(),
    ...theirsEntries.keys(),
    ...baseEntries.keys(),
  ]);
  const lines: string[] = [];
  for (const fileName of order) {
    const oursHash = oursEntries.get(fileName);
    const theirsHash = theirsEntries.get(fileName);
    const baseHash = baseEntries.get(fileName);
    const chosenHash =
      theirsHash !== undefined && theirsHash !== baseHash
        ? theirsHash
        : (oursHash ?? theirsHash ?? baseHash);
    if (!chosenHash) continue;
    lines.push(`${chosenHash}  ${fileName}`);
  }

  return `${lines.join("\n")}\n`;
}

function parseSha256Side(text: string): Map<string, string> | null {
  const entries = new Map<string, string>();
  const lines = text.replace(/\n+$/g, "").split("\n").filter(Boolean);
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([^\n]+)$/.exec(line);
    if (!match) return null;
    const [, hash, fileName] = match;
    if (!hash || !fileName) return null;
    entries.set(fileName, hash);
  }
  return entries;
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}
