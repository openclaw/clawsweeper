import { sha256 } from "./content-hash.js";
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

/** A body this process already validated for one cache key, with its ETag. */
export type GithubEtagRetainedResponse = {
  etag: string;
  body: string;
};

export type GithubEtagRetainedResponses = {
  get: (key: GithubEtagCacheKey) => GithubEtagRetainedResponse | undefined;
  set: (key: GithubEtagCacheKey, response: GithubEtagRetainedResponse | null) => void;
};

/**
 * Bounded same-process memory for durable ETag reads. It only chooses the
 * If-None-Match value for the next live request: a retained body is served
 * again only after GitHub answers that request with 304.
 */
export function createRetainedGithubEtagResponses(
  options: { maxEntries?: number; maxBytes?: number } = {},
): GithubEtagRetainedResponses {
  const maxEntries = options.maxEntries ?? 128;
  const maxBytes = options.maxBytes ?? 16 * 1_024 * 1_024;
  const entries = new Map<string, GithubEtagRetainedResponse & { bytes: number }>();
  let totalBytes = 0;
  const remove = (cacheKey: string): void => {
    const previous = entries.get(cacheKey);
    if (!previous) return;
    entries.delete(cacheKey);
    totalBytes -= previous.bytes;
  };
  return {
    get: (key) => {
      const entry = entries.get(key.cacheKey);
      return entry ? { etag: entry.etag, body: entry.body } : undefined;
    },
    set: (key, response) => {
      remove(key.cacheKey);
      if (!response?.etag || /[\r\n]/.test(response.etag)) return;
      const bytes = Buffer.byteLength(response.body, "utf8");
      if (bytes > maxBytes) return;
      entries.set(key.cacheKey, { etag: response.etag, body: response.body, bytes });
      totalBytes += bytes;
      for (const cacheKey of entries.keys()) {
        if (entries.size <= maxEntries && totalBytes <= maxBytes) break;
        remove(cacheKey);
      }
    },
  };
}

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
  retained?: GithubEtagRetainedResponses | undefined;
}): string {
  const retained = options.retained?.get(options.key);
  if (retained) {
    // This process already validated this exact body for this ETag, so it
    // revalidates directly instead of paying two more Worker round trips for a
    // lookup and confirmation. GitHub still answers every read live, and only
    // its 304 lets the retained body be served again.
    const conditional = options.githubRequest(retained.etag);
    if (conditional.status === 304) {
      options.record({
        unit: "conditional_response",
        outcome: "cache_304_served",
        status: 304,
      });
      return retained.body;
    }
    options.retained?.set(options.key, null);
    return acceptLive200(options, conditional);
  }
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
      options.retained?.set(options.key, { etag: expected.etag, body: confirmed.body });
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
  options.retained?.set(options.key, response.etag ? { etag: response.etag, body } : null);
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
