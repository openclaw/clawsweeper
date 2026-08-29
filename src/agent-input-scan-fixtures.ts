import { createHash } from "node:crypto";
import { basename } from "node:path";

// Maintainer-reviewed malformed-config fixture introduced by d68b1861172120fc.
// This is host policy, never an allowlist loaded from the reviewed checkout.
export const REVIEWED_FIXTURE_SOURCE = "test/action-ledger-runtime.test.ts";
const FIXTURE_SHA256 = "a728de5dbbef23b8aa5ef2d99060835f4f2fb5a0fa2abb9fe249d08aa09bd09e";

interface ClassifiedFinding {
  blob: string;
  line: number;
  decoder: string;
  occurrences: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid scanner object");
  }
  return value as Record<string, unknown>;
}

function records(bytes: Buffer): Record<string, unknown>[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new Error("incomplete scanner output");
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => object(JSON.parse(line)));
}

/** Classify only complete native scans whose every finding is the reviewed fixture. */
export function classifyReviewedFixtureScan(
  stdout: Buffer,
  stderr: Buffer,
  sourceBlobs: ReadonlyMap<string, Buffer>,
):
  | { fixtureSha256: string; source: string; detector: string; findings: ClassifiedFinding[] }
  | undefined {
  try {
    const findings = records(stdout);
    const logs = records(stderr);
    // TruffleHog can log detector failures and still exit 183. Its exit status
    // alone therefore cannot establish that all detectors finished successfully.
    if (
      logs.some(
        (entry) =>
          entry.level !== "info-0" ||
          typeof entry.logger !== "string" ||
          typeof entry.msg !== "string" ||
          entry.error !== undefined ||
          entry.errors !== undefined,
      ) ||
      logs.filter((entry) => entry.msg === "finished scanning").length !== 1
    )
      return undefined;
    const completion = logs.at(-1)!;
    if (
      completion.logger !== "trufflehog" ||
      completion.msg !== "finished scanning" ||
      completion.trufflehog_version !== "3.97.1" ||
      typeof completion.chunks !== "number" ||
      !Number.isSafeInteger(completion.chunks) ||
      completion.chunks <= 0 ||
      typeof completion.bytes !== "number" ||
      !Number.isSafeInteger(completion.bytes) ||
      completion.bytes <= 0 ||
      completion.verified_secrets !== 0 ||
      completion.unverified_secrets !== findings.length
    )
      return undefined;

    const classified = new Map<string, ClassifiedFinding>();
    for (const finding of findings) {
      if (
        finding.DetectorType !== 17 ||
        finding.DetectorName !== "URI" ||
        finding.SourceType !== 15 ||
        finding.Verified !== false ||
        (finding.DecoderName !== "PLAIN" && finding.DecoderName !== "HTML") ||
        typeof finding.VerificationError !== "string" ||
        !finding.VerificationError ||
        typeof finding.Raw !== "string" ||
        // URI Raw omits the path; RawV2 must match the complete reviewed value.
        finding.RawV2 !== finding.Raw ||
        createHash("sha256").update(finding.Raw).digest("hex") !== FIXTURE_SHA256 ||
        finding.ExtraData !== null ||
        finding.StructuredData !== null
      )
        return undefined;
      const source = object(object(object(finding.SourceMetadata).Data).Filesystem);
      const bytes = typeof source.file === "string" ? sourceBlobs.get(source.file) : undefined;
      if (
        !bytes ||
        typeof source.line !== "number" ||
        !Number.isSafeInteger(source.line) ||
        source.line <= 0
      )
        return undefined;
      const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n")[
        source.line - 1
      ];
      // HTML may rediscover an unchanged literal. Encoded-only occurrences,
      // numeric staging files (prompt/schema/diff), and forged paths never qualify.
      if (!line?.includes(finding.Raw)) return undefined;
      const uri = new URL(finding.Raw);
      const parts = object(finding.SecretParts);
      if (
        Object.keys(parts).length !== 3 ||
        parts.host !== uri.host ||
        parts.username !== uri.username ||
        parts.password !== uri.password
      )
        return undefined;
      const blob = basename(source.file as string);
      const key = `${blob}:${source.line}:${finding.DecoderName}`;
      const previous = classified.get(key);
      classified.set(key, {
        blob,
        line: source.line,
        decoder: finding.DecoderName,
        occurrences: (previous?.occurrences ?? 0) + 1,
      });
    }
    return {
      fixtureSha256: FIXTURE_SHA256,
      source: REVIEWED_FIXTURE_SOURCE,
      detector: "URI",
      findings: [...classified.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value),
    };
  } catch {
    // Scanner output includes credential-shaped bytes; never expose parse errors.
    return undefined;
  }
}
