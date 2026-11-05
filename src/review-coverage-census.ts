import type { ReviewCoverageOpenItem } from "./review-coverage.ts";

export const CENSUS = {
  version: 2,
  policy: "observational-identity-fields-v2-2",
  refreshMs: 20 * 60_000,
  observationMaxAgeMs: 12 * 60 * 60_000,
  queries: 25,
  controlSteps: 200,
  pageNodes: 100,
  pagesPerConnection: 10,
  repositories: 512,
  identities: 20_000,
  chunkBytes: 64 * 1024,
  wireBytes: 1_900_000,
  copyBytes: 32 * 1024 * 1024,
  receipts: 1024,
  cursors: 1024,
  leaseMs: 5 * 60_000,
  retentionMs: 7 * 24 * 60 * 60_000,
  cleanupRows: 128,
  projectionRows: 100,
  projectionPages: 200,
} as const;
export const CENSUS_PATHS = [
  "/internal/review-coverage/census/start",
  "/internal/review-coverage/census/next",
  "/internal/review-coverage/census/accept",
  "/internal/review-coverage/census/fail",
] as const;
export type CensusKind = "issue" | "pull_request";
export type CensusRepository = {
  repo: string;
  id: string;
  revision: string;
  visibility: "public" | "unknown";
  scope: "eligible" | "observed";
  issues: number;
  pulls: number;
  countsAt: string;
};
export type CensusWork = {
  repo: string;
  id: string;
  revision: string;
  generation: string;
  revisionNumber: number;
  pass: number;
  kind: CensusKind;
  cursor: string | null;
};
export type CensusPage = CensusWork & {
  items: ReviewCoverageOpenItem[];
  total: number;
  next: string | null;
  hasNext: boolean;
  sourcePageInfo?: { hasNextPage: boolean; endCursor: string | null };
  observedAt: string;
};
export function censusRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid census object");
  return value as Record<string, unknown>;
}
export function censusInteger(value: unknown, max: number = CENSUS.identities): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error("census integer bound");
  return value;
}
export function censusDate(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("invalid census date");
  return value;
}
export function censusToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    value.split("").some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("invalid census token");
  return value;
}
export function censusIdentifier(value: unknown): string {
  const token = censusToken(value);
  if (token.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(token))
    throw new Error("census identifier bound");
  return token;
}
export function censusCursor(value: unknown): string | null {
  return value === null ? null : censusToken(value);
}
export function censusBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
// Accidental-storage-corruption check only; never an authentication/witness hash.
export function censusChecksum(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
}
export async function censusDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function censusSignatureInput(path: string, body: string): string {
  if (!(CENSUS_PATHS as readonly string[]).includes(path)) throw new Error("invalid census path");
  return "clawsweeper-coverage-checkpoint-v2\nPOST\n" + path + "\n" + body;
}
export function censusRepository(value: unknown): CensusRepository {
  const v = censusRecord(value),
    repo = censusToken(v.repo);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo !== repo.toLowerCase())
    throw new Error("invalid canonical census repository");
  if (v.scope !== "eligible" && v.scope !== "observed") throw new Error("invalid census scope");
  if (v.visibility !== "public" && v.visibility !== "unknown")
    throw new Error("invalid census visibility");
  return {
    repo,
    id: censusToken(v.id),
    revision: censusToken(v.revision),
    visibility: v.visibility,
    scope: v.scope,
    // Count witnesses describe upstream state, not allocated identity capacity.
    issues: censusInteger(v.issues, Number.MAX_SAFE_INTEGER),
    pulls: censusInteger(v.pulls, Number.MAX_SAFE_INTEGER),
    countsAt: censusDate(censusToken(v.countsAt)),
  };
}
export function censusItem(value: unknown, kind: CensusKind): ReviewCoverageOpenItem {
  const v = censusRecord(value),
    number = censusInteger(v.number, Number.MAX_SAFE_INTEGER);
  if (!number || v.kind !== kind || !Array.isArray(v.labels) || v.labels.length > 100)
    throw new Error("incomplete census identity");
  const labels = v.labels
    .map((x) => {
      if (typeof x !== "string" || x.length > 100) throw new Error("invalid census label");
      return x;
    })
    .sort();
  if (new Set(labels).size !== labels.length) throw new Error("duplicate census label");
  const item: ReviewCoverageOpenItem = {
    number,
    kind,
    updated_at: censusDate(v.updated_at),
    reopened_at: v.reopened_at === null ? null : censusDate(v.reopened_at),
    labels,
  };
  if (kind === "pull_request") {
    if (typeof v.head_sha !== "string" || !/^[a-f0-9]{40}$/i.test(v.head_sha))
      throw new Error("incomplete census head");
    item.head_sha = v.head_sha.toLowerCase();
  }
  if (censusBytes(item) > CENSUS.chunkBytes) throw new Error("census chunk byte bound");
  return item;
}
export function censusPage(value: unknown): CensusPage {
  const v = censusRecord(value);
  if (v.kind !== "issue" && v.kind !== "pull_request") throw new Error("invalid census kind");
  if (
    !Array.isArray(v.items) ||
    v.items.length > CENSUS.pageNodes ||
    typeof v.hasNext !== "boolean"
  )
    throw new Error("invalid census page");
  const items = v.items.map((x) => censusItem(x, v.kind as CensusKind));
  if (new Set(items.map((x) => x.number)).size !== items.length)
    throw new Error("duplicate census identity");
  const observedAt = censusDate(v.observedAt);
  if (
    items.some(
      (item) =>
        Date.parse(item.updated_at) > Date.parse(observedAt) ||
        (item.reopened_at != null && Date.parse(item.reopened_at) > Date.parse(observedAt)),
    )
  )
    throw new Error("future census identity");
  const next = censusCursor(v.next),
    cursor = censusCursor(v.cursor);
  let sourcePageInfo: CensusPage["sourcePageInfo"];
  if (v.sourcePageInfo !== undefined) {
    const raw = censusRecord(v.sourcePageInfo);
    const endCursor = censusCursor(raw.endCursor);
    if (raw.hasNextPage !== v.hasNext || (v.hasNext && endCursor !== next))
      throw new Error("invalid census source pagination");
    sourcePageInfo = { hasNextPage: v.hasNext as boolean, endCursor };
  }
  if (v.hasNext ? !next || next === cursor || !items.length : next !== null)
    throw new Error("invalid census pagination");
  if (v.hasNext && items.length !== CENSUS.pageNodes) throw new Error("incomplete census page");
  return {
    repo: censusToken(v.repo),
    id: censusToken(v.id),
    revision: censusToken(v.revision),
    generation: censusToken(v.generation),
    revisionNumber: censusInteger(v.revisionNumber, Number.MAX_SAFE_INTEGER),
    pass: censusInteger(v.pass, Number.MAX_SAFE_INTEGER),
    kind: v.kind,
    cursor,
    items,
    total: censusInteger(v.total),
    next,
    hasNext: v.hasNext,
    observedAt,
    ...(sourcePageInfo ? { sourcePageInfo } : {}),
  };
}
