import { createHash } from "node:crypto";
import {
  GITHUB_ETAG_CACHE_MAX_BODY_BYTES,
  type GithubEtagCacheKey,
} from "./github-etag-cache-contract.js";

export type GithubConditionalResponse = {
  status: number;
  body: string;
  etag?: string | undefined;
};

export type GithubEtagLookupResponse = {
  hit: boolean;
  entry?: {
    etag: string;
    bodyDigest: string;
  };
};

export type GithubEtagStoreResponse = {
  stored: boolean;
};

export type GithubEtagConfirmResponse = {
  confirmed: boolean;
  body?: string | undefined;
  entry?: {
    etag: string;
    bodyDigest: string;
  };
};

export type GithubEtagBrokerEvent =
  | { unit: "broker_lookup"; outcome: "cache_hit" | "cache_miss" | "cache_skip" }
  | {
      unit: "conditional_response";
      outcome: "cache_200_stored" | "cache_304_served";
      status: 200 | 304;
    };

export function durableGithubEtagReadSync(options: {
  key: GithubEtagCacheKey;
  lookup: (key: GithubEtagCacheKey) => GithubEtagLookupResponse;
  store200: (
    key: GithubEtagCacheKey,
    response: { etag: string } & (
      | { body: string; body_bytes?: never }
      | { body?: never; body_bytes: number }
    ),
  ) => GithubEtagStoreResponse;
  confirm304: (
    key: GithubEtagCacheKey,
    expected: { etag: string; bodyDigest: string },
  ) => GithubEtagConfirmResponse;
  githubRequest: (ifNoneMatch?: string) => GithubConditionalResponse;
  record: (event: GithubEtagBrokerEvent) => void;
}): string {
  let lookup: GithubEtagLookupResponse;
  try {
    lookup = options.lookup(options.key);
  } catch {
    options.record({ unit: "broker_lookup", outcome: "cache_skip" });
    return requireLive200(options.githubRequest());
  }
  if (!lookup.hit || !validLookupEntry(lookup.entry)) {
    options.record({ unit: "broker_lookup", outcome: "cache_miss" });
    return acceptLive200(options, options.githubRequest());
  }
  const expected = lookup.entry;
  options.record({ unit: "broker_lookup", outcome: "cache_hit" });
  const conditional = options.githubRequest(expected.etag);
  if (conditional.status === 200) return acceptLive200(options, conditional);
  if (conditional.status !== 304) return requireLive200(conditional);
  try {
    const confirmed = options.confirm304(options.key, expected);
    if (
      confirmed.confirmed &&
      typeof confirmed.body === "string" &&
      confirmed.entry?.etag === expected.etag &&
      confirmed.entry.bodyDigest === expected.bodyDigest &&
      sha256(confirmed.body) === expected.bodyDigest
    ) {
      options.record({
        unit: "conditional_response",
        outcome: "cache_304_served",
        status: 304,
      });
      return confirmed.body;
    }
  } catch {
    // A 304 alone is insufficient if the durable body cannot be confirmed.
  }
  options.record({ unit: "broker_lookup", outcome: "cache_skip" });
  return acceptLive200(options, options.githubRequest());
}

function acceptLive200(
  options: Parameters<typeof durableGithubEtagReadSync>[0],
  response: GithubConditionalResponse,
): string {
  const body = requireLive200(response);
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (!response.etag && bodyBytes <= GITHUB_ETAG_CACHE_MAX_BODY_BYTES) {
    options.record({ unit: "broker_lookup", outcome: "cache_skip" });
    return body;
  }
  try {
    const stored = options.store200(options.key, {
      etag: response.etag || "",
      ...(bodyBytes > GITHUB_ETAG_CACHE_MAX_BODY_BYTES ? { body_bytes: bodyBytes } : { body }),
    });
    if (stored.stored) {
      options.record({
        unit: "conditional_response",
        outcome: "cache_200_stored",
        status: 200,
      });
    } else {
      options.record({ unit: "broker_lookup", outcome: "cache_skip" });
    }
  } catch {
    options.record({ unit: "broker_lookup", outcome: "cache_skip" });
  }
  return body;
}

function requireLive200(response: GithubConditionalResponse): string {
  if (response.status !== 200) {
    throw new Error(`GitHub conditional read returned HTTP ${response.status}`);
  }
  return response.body;
}

function validLookupEntry(
  value: GithubEtagLookupResponse["entry"],
): value is NonNullable<GithubEtagLookupResponse["entry"]> {
  return Boolean(
    value?.etag && !/[\r\n]/.test(value.etag) && /^[0-9a-f]{64}$/.test(value.bodyDigest),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
