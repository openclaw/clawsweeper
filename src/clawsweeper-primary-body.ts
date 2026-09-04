import { createHash } from "node:crypto";

interface BodyRange {
  start: number;
  end: number;
}

export interface PrimaryBodyContext {
  body: string;
  bodyCoverage?: {
    originalUnits: number;
    sourceBodySha256: string;
    prefix: BodyRange;
    excerpts: (BodyRange & { text: string })[];
    omittedUnits: number;
    complete: false;
  };
}

/** Source identity from host-created primary-body context, never from model output. */
export function primaryBodySourceSha256(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.body !== "string" && body.body !== null) return null;
  if (Object.hasOwn(body, "bodyCoverage")) {
    const coverage = body.bodyCoverage;
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return null;
    const source = coverage as Record<string, unknown>;
    if (
      source.complete !== false ||
      !Number.isSafeInteger(source.originalUnits) ||
      Number(source.originalUnits) <= String(body.body ?? "").length ||
      typeof source.sourceBodySha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(source.sourceBodySha256)
    )
      return null;
    return source.sourceBodySha256;
  }
  return createHash("sha256")
    .update(body.body ?? "")
    .digest("hex");
}

const BODY_BUDGET = 12_000;
const MAX_CANDIDATES = 64;

function safeEnd(text: string, end: number): number {
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? end - 1 : end;
}

function fittingEnd(start: number, end: number, fits: (end: number) => boolean): number {
  let low = start;
  let high = end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Navigation only: anchors never establish authenticity or proof sufficiency. */
export function compactPrimaryBody(value: unknown): PrimaryBodyContext {
  const source = typeof value === "string" ? value : "";
  if (source.length <= BODY_BUDGET) return { body: source };

  const textEnd = (start: number, end: number, budget: number) =>
    safeEnd(
      source,
      fittingEnd(
        start,
        end,
        (candidate) => JSON.stringify(source.slice(start, candidate)).length <= budget,
      ),
    );
  const openingEnd = textEnd(0, source.length, 4000);
  const outputAnchors: number[] = [];
  const proofAnchors: number[] = [];
  for (let start = 0; start < source.length;) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    if (start >= openingEnd && end - start <= 300) {
      const line = source.slice(start, end).trim();
      const heading = /^(?:#{1,6}\s|<summary\b)/i.test(line);
      const output =
        (/\b(?:trace|output)\b/i.test(line) &&
          (heading || /\b(?:follows|below)\b|:\s*$/i.test(line))) ||
        /^HTTP\/\d(?:\.\d)?\s+\d{3}\b/i.test(line);
      if (output && outputAnchors.length < MAX_CANDIDATES) outputAnchors.push(start);
      else if (heading && /\b(?:proof|evidence)\b/i.test(line)) {
        if (proofAnchors.length < MAX_CANDIDATES) proofAnchors.push(start);
      }
    }
    start = end + 1;
  }

  const precedingProofAnchors = outputAnchors.flatMap((output) => {
    const preceding = proofAnchors.findLast((start) => start < output);
    return preceding === undefined ? [] : [preceding];
  });
  const excerpts: NonNullable<PrimaryBodyContext["bodyCoverage"]>["excerpts"] = [];
  for (const start of [...outputAnchors, ...precedingProofAnchors, ...proofAnchors]) {
    if (excerpts.some((range) => start >= range.start && start < range.end)) continue;
    const nextStart = Math.min(
      source.length,
      ...excerpts.filter((range) => range.start > start).map((range) => range.start),
    );
    // Reserve the largest window for actual output, not just its heading.
    const end = textEnd(start, nextStart, excerpts.length === 0 ? 3800 : 1400);
    excerpts.push({ start, end, text: source.slice(start, end) });
    if (excerpts.length === 3) break;
  }
  excerpts.sort((left, right) => left.start - right.start);
  const sourceBodySha256 = createHash("sha256").update(source).digest("hex");
  const supplementalUnits = excerpts.reduce((total, range) => total + range.end - range.start, 0);
  const resultAt = (end: number): PrimaryBodyContext => ({
    body: source.slice(0, end),
    bodyCoverage: {
      originalUnits: source.length,
      sourceBodySha256,
      prefix: { start: 0, end },
      excerpts,
      omittedUnits: source.length - end - supplementalUnits,
      complete: false,
    },
  });
  const prefixEnd = fittingEnd(0, excerpts[0]?.start ?? source.length, (end) => {
    const serialized = JSON.stringify(resultAt(end), null, 2);
    // Account for the four extra indentation spaces in the real context JSON.
    return serialized.length + serialized.split("\n").length * 4 <= BODY_BUDGET;
  });
  return resultAt(safeEnd(source, prefixEnd));
}
