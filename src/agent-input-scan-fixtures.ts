import { createHash } from "node:crypto";
import { basename } from "node:path";

interface ReviewedFixture {
  fixtureSha256: string;
  rawSha256?: string;
  sources: readonly string[];
}

// This is host policy, never an allowlist loaded from the reviewed checkout.
const REVIEWED_FIXTURES: readonly ReviewedFixture[] = [
  {
    // Maintainer-reviewed malformed-config fixture introduced by d68b1861172120fc.
    fixtureSha256: "a728de5dbbef23b8aa5ef2d99060835f4f2fb5a0fa2abb9fe249d08aa09bd09e",
    sources: ["test/action-ledger-runtime.test.ts"],
  },
  {
    // Explicitly approved autoreview negative-test fixture, including its vendored path.
    fixtureSha256: "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83",
    sources: [
      "skills/autoreview/tests/test_autoreview_hardening.py",
      ".agents/skills/autoreview/tests/test_autoreview_hardening.py",
    ],
  },
  {
    // OpenClaw Browser local-CDP authentication fixture introduced by 8e03b0c62e76.
    fixtureSha256: "d69d650dc6c312f3e1071f8613df780323fadd01b8c40e6edd02715cd731ae60",
    sources: ["extensions/browser/src/browser/chrome.test.ts"],
  },
  {
    // OpenClaw Browser remote-CDP redaction fixtures introduced by 58da2f5897 and 4b5987829.
    fixtureSha256: "60267342b1ab046bd8c42e2226fdfce2aa081e7f18e17c35c9c013d7b1de5720",
    sources: [
      "extensions/browser/src/browser/chrome.test.ts",
      "extensions/browser/src/browser/server-context.ensure-browser-available.waits-for-cdp-ready.test.ts",
    ],
  },
  {
    // OpenClaw remote-CDP documentation example introduced by bf15c87d2b12.
    fixtureSha256: "e6907dddaccdec944b0f02e14fe9186293e2d513ff753db0a95b3460aa5dc1d9",
    sources: ["docs/tools/browser.md"],
  },
  {
    // OpenClaw credentialed-page rejection fixture introduced by d5fb4903f1b1.
    fixtureSha256: "d8996b8fdec57910e379c720611bc37f9433f1cb7027b6f6262d785f1506e9ff",
    rawSha256: "8d3331ee208c72c30fba199e4e2b8a65d69a5034e49875a2f20dbea3a4f2f976",
    sources: ["extensions/browser/src/browser-tool.test.ts"],
  },
];

export interface ReviewedFixtureBlob {
  bytes: Buffer;
  references: readonly { source: string; mode: string }[];
}

interface ClassifiedFinding {
  blob: string;
  scannerLine: number;
  literalLine: number;
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

/** Classify only complete native scans whose every finding matches host fixture policy. */
export function classifyReviewedFixtureScan(
  stdout: Buffer,
  stderr: Buffer,
  sourceBlobs: ReadonlyMap<string, ReviewedFixtureBlob>,
):
  | { fixtureSha256: string; source: string; detector: string; findings: ClassifiedFinding[] }[]
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

    const literalLines = new Map<string, number>();
    const classified = new Map<
      string,
      { fixtureSha256: string; source: string; findings: Map<string, ClassifiedFinding> }
    >();
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
        typeof finding.RawV2 !== "string" ||
        finding.ExtraData !== null ||
        finding.StructuredData !== null
      )
        return undefined;
      // URI Raw omits the path; bind both outputs to the complete reviewed value.
      const digest = createHash("sha256").update(finding.RawV2).digest("hex");
      const rawDigest = createHash("sha256").update(finding.Raw).digest("hex");
      const fixture = REVIEWED_FIXTURES.find(
        (entry) =>
          entry.fixtureSha256 === digest && (entry.rawSha256 ?? entry.fixtureSha256) === rawDigest,
      );
      if (!fixture) return undefined;
      const source = object(object(object(finding.SourceMetadata).Data).Filesystem);
      const file = source.file;
      if (typeof file !== "string") return undefined;
      const staged = sourceBlobs.get(file);
      if (
        !staged ||
        !staged.references.length ||
        staged.references.some(
          ({ source, mode }) =>
            mode !== "100644" || !fixture.sources.some((path) => path === source),
        ) ||
        typeof source.line !== "number" ||
        !Number.isSafeInteger(source.line) ||
        source.line <= 0
      )
        return undefined;
      const uri = new URL(finding.RawV2);
      const parts = object(finding.SecretParts);
      if (
        Object.keys(parts).length !== 3 ||
        parts.host !== uri.host ||
        parts.username !== uri.username ||
        parts.password !== uri.password
      )
        return undefined;
      const valueKey = `${file}:${digest}`;
      let literalLine = literalLines.get(valueKey);
      if (literalLine === undefined) {
        // Decoding can shift coordinates, and deduplication can drop the plain
        // finding. Bind to staged bytes and record one literal witness separately
        // from the scanner's location, without allocating unbounded line lists.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(staged.bytes);
        const offset = text.indexOf(finding.RawV2);
        if (offset < 0) return undefined;
        literalLine = 1;
        for (
          let newline = text.indexOf("\n");
          newline !== -1 && newline < offset;
          newline = text.indexOf("\n", newline + 1)
        ) {
          literalLine++;
        }
        literalLines.set(valueKey, literalLine);
      }
      const blob = basename(file);
      const key = `${blob}:${source.line}:${finding.DecoderName}`;
      const sources = new Set(staged.references.map(({ source }) => source));
      for (const path of sources) {
        const groupKey = `${digest}:${path}`;
        const group = classified.get(groupKey) ?? {
          fixtureSha256: digest,
          source: path,
          findings: new Map<string, ClassifiedFinding>(),
        };
        const previous = group.findings.get(key);
        group.findings.set(key, {
          blob,
          scannerLine: source.line,
          literalLine,
          decoder: finding.DecoderName,
          occurrences: (previous?.occurrences ?? 0) + 1,
        });
        classified.set(groupKey, group);
      }
    }
    return [...classified.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => ({
        fixtureSha256: group.fixtureSha256,
        source: group.source,
        detector: "URI",
        findings: [...group.findings.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, value]) => value),
      }));
  } catch {
    // Scanner output includes credential-shaped bytes; never expose parse errors.
    return undefined;
  }
}
