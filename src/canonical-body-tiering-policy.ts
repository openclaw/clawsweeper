import { stableJson } from "./stable-json.ts";

// The dashboard's existing STATE_SNAPSHOTS binding owns canonical bodies too.
export const CANONICAL_BODY_BUCKET = "clawsweeper-state-snapshots";
export const CANONICAL_BODY_PREFIX = "records/bodies/v1/sha256/";

// R2 lifecycle rules use a prefix condition and an optional object-deletion
// transition. A rule covering any canonical digest must never delete its body.
export function canonicalBodyLifecycleRules(value: unknown): string {
  const input = (typeof value === "string" ? JSON.parse(value) : value) as Record<
    string,
    unknown
  > | null;
  if (!input || typeof input !== "object" || Array.isArray(input) || !Array.isArray(input.rules))
    throw new Error("bucket lifecycle rules required");
  for (const rule of input.rules) {
    if (
      !rule ||
      typeof rule !== "object" ||
      typeof rule.enabled !== "boolean" ||
      !rule.conditions ||
      typeof rule.conditions.prefix !== "string"
    )
      throw new Error("invalid bucket lifecycle rule");
    const prefix = rule.conditions.prefix;
    if (
      rule.enabled &&
      rule.deleteObjectsTransition &&
      (CANONICAL_BODY_PREFIX.startsWith(prefix) || prefix.startsWith(CANONICAL_BODY_PREFIX))
    )
      throw new Error("canonical bodies must not expire");
  }
  const serialized = stableJson(input);
  if (serialized.length > 4096) throw new Error("bucket lifecycle evidence too large");
  return serialized;
}

export async function verifyCanonicalBodyLifecycle(
  attestation: unknown,
  account: string,
  token: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const lifecycle = (
    attestation as { bucketLifecycle?: { bucketIdentity?: string; rulesJson?: string } }
  )?.bucketLifecycle;
  if (
    lifecycle?.bucketIdentity !== CANONICAL_BODY_BUCKET ||
    !/^[a-f0-9]{32}$/.test(account) ||
    !token
  )
    throw new Error("canonical bucket lifecycle identity required");
  const expected = canonicalBodyLifecycleRules(lifecycle.rulesJson);
  const response = await request(
    "https://api.cloudflare.com/client/v4/accounts/" +
      account +
      "/r2/buckets/" +
      CANONICAL_BODY_BUCKET +
      "/lifecycle",
    {
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    },
  );
  if (!response.ok) throw new Error("bucket lifecycle inspection failed");
  const evidence = (await response.json()) as { success?: boolean; result?: unknown };
  if (evidence.success !== true || canonicalBodyLifecycleRules(evidence.result) !== expected)
    throw new Error("bucket lifecycle policy differs from reviewed evidence");
}
