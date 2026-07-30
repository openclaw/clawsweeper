import { readFileSync } from "node:fs";

export const WORKER_RECORDS_MANIFEST_SCHEMA_VERSION = 3;

export function coverageTrackedItemIdsFromManifest(
  manifestPath: string,
  repoSlug: string,
): Set<number> {
  const repository = readManifestRepositories(manifestPath)[repoSlug];
  if (!isRecord(repository) || !Array.isArray(repository.coverageTrackedItemIds)) {
    throw new Error(`Worker records manifest has no coverage identities for ${repoSlug}`);
  }
  return coverageItemIds(repository.coverageTrackedItemIds, repoSlug);
}

export function coverageTrackedCountsFromManifest(
  manifestPath: string,
): ReadonlyMap<string, number> {
  const repositories = readManifestRepositories(manifestPath);
  const counts = new Map<string, number>();
  for (const [repoSlug, value] of Object.entries(repositories)) {
    if (!isRecord(value) || !Array.isArray(value.coverageTrackedItemIds)) {
      throw new Error(`Worker records manifest has no coverage identities for ${repoSlug}`);
    }
    counts.set(repoSlug, coverageItemIds(value.coverageTrackedItemIds, repoSlug).size);
  }
  return counts;
}

function readManifestRepositories(manifestPath: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Worker records manifest must be an object");
  if (
    parsed.schemaVersion !== WORKER_RECORDS_MANIFEST_SCHEMA_VERSION ||
    parsed.source !== "worker" ||
    !isRecord(parsed.repositories)
  ) {
    throw new Error("Worker records manifest has an unsupported schema");
  }
  return parsed.repositories;
}

function coverageItemIds(values: unknown[], repoSlug: string): Set<number> {
  const ids = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || ids.has(Number(value))) {
      throw new Error(`Worker records manifest has invalid coverage identities for ${repoSlug}`);
    }
    ids.add(Number(value));
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
