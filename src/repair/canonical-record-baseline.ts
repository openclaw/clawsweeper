import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CAPTURE_DIRECTORY = ".clawsweeper-canonical-record-baselines";
const REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ITEM_NUMBER_PATTERN = /^[1-9]\d*$/;

type CanonicalRecordBaselineSource = {
  section: "items" | "closed" | "plans" | "decision-packets";
  name: string;
  path: string;
};

export function captureCanonicalRecordBaseline(options: {
  baselineRoot: string;
  repositorySlug: string;
  itemNumber: number | string;
  sources: readonly CanonicalRecordBaselineSource[];
}): void {
  const repositorySlug = validatedRepositorySlug(options.repositorySlug);
  const itemNumber = validatedItemNumber(options.itemNumber);
  const markerPath = join(
    options.baselineRoot,
    CAPTURE_DIRECTORY,
    repositorySlug,
    `${itemNumber}.json`,
  );
  if (existsSync(markerPath)) return;

  for (const source of options.sources) {
    if (!existsSync(source.path)) continue;
    const destination = join(
      options.baselineRoot,
      "records",
      repositorySlug,
      source.section,
      source.name,
    );
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source.path, destination);
  }
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify({ schema_version: 1, repositorySlug, itemNumber })}\n`,
  );
}

export function capturedCanonicalRecordBaselineKeys(baselineRoot: string): Set<string> {
  const captureRoot = join(baselineRoot, CAPTURE_DIRECTORY);
  const keys = new Set<string>();
  if (!existsSync(captureRoot)) return keys;
  for (const repositoryEntry of readdirSync(captureRoot, { withFileTypes: true })) {
    if (!repositoryEntry.isDirectory() || !REPOSITORY_SLUG_PATTERN.test(repositoryEntry.name)) {
      continue;
    }
    const repositoryRoot = join(captureRoot, repositoryEntry.name);
    for (const itemEntry of readdirSync(repositoryRoot, { withFileTypes: true })) {
      if (!itemEntry.isFile()) continue;
      const match = /^([1-9]\d*)\.json$/.exec(itemEntry.name);
      if (!match?.[1]) continue;
      keys.add(`${repositoryEntry.name}/${match[1]}`);
    }
  }
  return keys;
}

function validatedRepositorySlug(value: string): string {
  if (!REPOSITORY_SLUG_PATTERN.test(value)) {
    throw new Error(`invalid canonical baseline repository slug: ${value}`);
  }
  return value;
}

function validatedItemNumber(value: number | string): string {
  const normalized = String(value);
  if (!ITEM_NUMBER_PATTERN.test(normalized)) {
    throw new Error(`invalid canonical baseline item number: ${normalized}`);
  }
  return normalized;
}
