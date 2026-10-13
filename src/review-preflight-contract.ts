export interface ReviewPreflightPayload {
  v: 1;
  repo: string;
  base: string;
  head: string;
  tool: { name: string; version: string };
  completion: "complete" | "partial" | "failed";
  summary: string;
  report_sha256?: string;
}

const utf8 = new TextEncoder();
export const PREFLIGHT_BLOCK_LIMIT = 4096;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    // eslint-disable-next-line no-control-regex -- Reject controls and unpaired surrogates in advisory text.
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value) &&
    utf8.encode(value).length <= limit
  );
}

/** A self-reported display payload, never review authority or execution proof. */
export function validReviewPreflight(value: unknown): value is ReviewPreflightPayload {
  if (!object(value) || !object(value.tool)) return false;
  const required = ["v", "repo", "base", "head", "tool", "completion", "summary"];
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && key !== "report_sha256") ||
    Object.keys(value.tool).length !== 2 ||
    !Object.hasOwn(value.tool, "name") ||
    !Object.hasOwn(value.tool, "version")
  )
    return false;
  return (
    value.v === 1 &&
    boundedText(value.repo, 256) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo) &&
    typeof value.base === "string" &&
    /^[0-9a-f]{40}$/.test(value.base) &&
    typeof value.head === "string" &&
    /^[0-9a-f]{40}$/.test(value.head) &&
    boundedText(value.tool.name, 64) &&
    boundedText(value.tool.version, 64) &&
    typeof value.completion === "string" &&
    ["complete", "partial", "failed"].includes(value.completion) &&
    boundedText(value.summary, 512) &&
    (!Object.hasOwn(value, "report_sha256") ||
      (typeof value.report_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.report_sha256)))
  );
}

export function serializeReviewPreflightPayload(payload: ReviewPreflightPayload): string {
  const closed = {
    v: payload.v,
    repo: payload.repo,
    base: payload.base,
    head: payload.head,
    tool: { name: payload.tool.name, version: payload.tool.version },
    completion: payload.completion,
    summary: payload.summary,
    ...(payload.report_sha256 === undefined ? {} : { report_sha256: payload.report_sha256 }),
  };
  if (!validReviewPreflight(closed)) throw new Error("Invalid preflight fields or byte limit.");
  const json = JSON.stringify(closed).replace(
    /[<>&]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const block = `<!-- openclaw-preflight:v1\n${json}\n-->`;
  if (utf8.encode(block).length > PREFLIGHT_BLOCK_LIMIT)
    throw new Error("Preflight block exceeds 4096 bytes.");
  return block;
}
