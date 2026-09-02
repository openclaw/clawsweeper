import { createHash } from "node:crypto";
import { basename } from "node:path";

interface ReviewedFixture {
  fixtureSha256: string;
  rawSha256?: string;
  lineSha256s?: readonly string[];
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
  {
    // Mattermost slash-error sanitization fixtures introduced by 9c0975c1c20e.
    fixtureSha256: "f2c5cfd2b711577ed9048f9bd0e6c97ae88097b8eba8c1ff37deb33ed910f5a7",
    rawSha256: "7d765bfa6e81c336a916aaf71eab28f5c0c4ae47a359ec3adf2d4f175645456d",
    lineSha256s: ["38c08c0f567b2d663fb72a8b41170a233f5baeb499a2205143a873df9e21a43d"],
    sources: ["extensions/mattermost/src/mattermost/slash-http.test.ts"],
  },
  {
    fixtureSha256: "fd79d243a5d942979882ca621cfa8bd240a2fce9ca400cdd6b2b1bfab4c5cf6a",
    rawSha256: "014a5653f93da5c53f9a09313e7aa32753fbdf0de02314af39a65af9a1dde664",
    lineSha256s: ["0506dfed6fa918c830a5e0d4d1bad503960438d01d5ff9e2cc80cd6654a69033"],
    sources: ["extensions/mattermost/src/mattermost/slash-http.test.ts"],
  },
  {
    fixtureSha256: "14947662dc4356637571038e47cd3f37a8911d37d41688a2f6c6b2b54c209c41",
    rawSha256: "7d765bfa6e81c336a916aaf71eab28f5c0c4ae47a359ec3adf2d4f175645456d",
    lineSha256s: ["d94c393a7704eab6d2e6ac822bd495a27299d353260c9edc85e852b706a54de3"],
    sources: ["extensions/mattermost/src/mattermost/slash-http.test.ts"],
  },
  {
    fixtureSha256: "0c2d147cb7b70169ceb0302b40bceaa60abc15263c4dcfb7f1746cc93e3c87d3",
    rawSha256: "014a5653f93da5c53f9a09313e7aa32753fbdf0de02314af39a65af9a1dde664",
    lineSha256s: ["ae6d199d9d7983df3024f5615dc243efd1e6988e1afddb79da0b99183cab8552"],
    sources: ["extensions/mattermost/src/mattermost/slash-http.test.ts"],
  },
];

export interface ScanSourceReference {
  source: string;
  mode: string;
  revision: string;
}

export type ScanInputOrigin =
  | { kind: "prompt" | "schema" | "additional" }
  | { kind: "raw_diff" | "patch"; from: string; to: string }
  | { kind: "worktree" | "blob"; references: readonly ScanSourceReference[] };

export type StagedScanInput = ScanInputOrigin & { id: string; bytes?: Buffer };

interface ScanMaterialDiagnostic {
  kind: ScanInputOrigin["kind"];
  id: string;
  from?: string;
  to?: string;
  referenceCount?: number;
  references?: { revision: string; pathSha256: string; mode: string }[];
}

export type ScanRefusalDiagnostic =
  | {
      kind: "native_contract";
      reason:
        | "invalid_stdout"
        | "invalid_stderr"
        | "scan_error"
        | "incomplete_scan"
        | "completion_mismatch"
        | "unexpected_exit";
    }
  | {
      kind: "unclassified_finding";
      reason:
        | "finding_not_reviewed"
        | "literal_not_reviewed"
        | "material_not_reviewed"
        | "source_not_reviewed"
        | "metadata_mismatch"
        | "literal_mismatch";
      findingCount: number;
      findingIndex: number;
      detectorType: number | null;
      decoder: "PLAIN" | "HTML" | "OTHER";
      verified: boolean | null;
      scannerLine: number | null;
      material?: ScanMaterialDiagnostic;
    };

export interface ReviewedFixtureNotice {
  fixtureSha256: string;
  source: string;
  detector: string;
  findings: ClassifiedFinding[];
}

interface RefusedScan {
  kind: "refused";
  reason: "scanner_failed" | "findings";
  diagnostic: ScanRefusalDiagnostic;
}

interface ClassifiedFinding {
  blob: string;
  scannerLine: number;
  literalLine: number;
  decoder: string;
  occurrences: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function records(bytes: Buffer): Record<string, unknown>[] | undefined {
  try {
    if (!bytes.length) return [];
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) return undefined;
    return text
      .slice(0, -1)
      .split("\n")
      .map((line) => {
        const value = object(JSON.parse(line));
        if (!value) throw new Error("invalid scanner object");
        return value;
      });
  } catch {
    // Parser errors can contain credential-shaped input; retain only a closed reason.
    return undefined;
  }
}

function materialDiagnostic(input: StagedScanInput): ScanMaterialDiagnostic {
  // Only host-staged identities leave the scanner boundary. Bound reference
  // fanout and hash paths; raw finding values and provider strings never leave.
  return {
    kind: input.kind,
    id: input.id,
    ...("from" in input ? { from: input.from, to: input.to } : {}),
    ...("references" in input
      ? {
          referenceCount: input.references.length,
          references: input.references.slice(0, 4).map(({ source, mode, revision }) => ({
            revision,
            pathSha256: createHash("sha256").update(source).digest("hex"),
            mode,
          })),
        }
      : {}),
  };
}

/** Classify only complete native scans whose every finding matches host fixture policy. */
export function classifyReviewedFixtureScan(
  status: number,
  stdout: Buffer,
  stderr: Buffer,
  inputs: ReadonlyMap<string, StagedScanInput>,
): { kind: "classified"; notices: ReviewedFixtureNotice[] } | RefusedScan {
  const nativeFailure = (
    reason: Extract<ScanRefusalDiagnostic, { kind: "native_contract" }>["reason"],
  ): RefusedScan => ({
    kind: "refused",
    reason: "scanner_failed",
    diagnostic: { kind: "native_contract", reason },
  });
  if (status !== 183) return nativeFailure("unexpected_exit");
  const findings = records(stdout);
  if (!findings?.length) return nativeFailure("invalid_stdout");
  const logs = records(stderr);
  if (!logs) return nativeFailure("invalid_stderr");
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
    )
  )
    return nativeFailure("scan_error");
  const completion = logs.at(-1)!;
  if (
    logs.filter((entry) => entry.msg === "finished scanning").length !== 1 ||
    completion?.logger !== "trufflehog" ||
    completion.msg !== "finished scanning"
  )
    return nativeFailure("incomplete_scan");
  const verifiedCount = findings.filter((finding) => finding.Verified === true).length;
  if (
    completion.trufflehog_version !== "3.97.1" ||
    typeof completion.chunks !== "number" ||
    !Number.isSafeInteger(completion.chunks) ||
    completion.chunks <= 0 ||
    typeof completion.bytes !== "number" ||
    !Number.isSafeInteger(completion.bytes) ||
    completion.bytes <= 0 ||
    completion.verified_secrets !== verifiedCount ||
    completion.unverified_secrets !== findings.length - verifiedCount
  )
    return nativeFailure("completion_mismatch");

  const literalLines = new Map<string, number>();
  const classified = new Map<
    string,
    { fixtureSha256: string; source: string; findings: Map<string, ClassifiedFinding> }
  >();
  for (const [findingIndex, finding] of findings.entries()) {
    const source = object(object(object(finding.SourceMetadata)?.Data)?.Filesystem);
    const file = source?.file;
    const staged = typeof file === "string" ? inputs.get(file) : undefined;
    const scannerLine =
      typeof source?.line === "number" && Number.isSafeInteger(source.line) && source.line > 0
        ? source.line
        : null;
    const refuse = (
      reason: Extract<ScanRefusalDiagnostic, { kind: "unclassified_finding" }>["reason"],
    ): RefusedScan => ({
      kind: "refused",
      reason: "findings",
      diagnostic: {
        kind: "unclassified_finding",
        reason,
        findingCount: findings.length,
        findingIndex,
        detectorType:
          typeof finding.DetectorType === "number" &&
          Number.isInteger(finding.DetectorType) &&
          finding.DetectorType >= 0 &&
          finding.DetectorType <= 2_147_483_647
            ? finding.DetectorType
            : null,
        decoder:
          finding.DecoderName === "PLAIN" || finding.DecoderName === "HTML"
            ? finding.DecoderName
            : "OTHER",
        verified: typeof finding.Verified === "boolean" ? finding.Verified : null,
        scannerLine,
        ...(staged ? { material: materialDiagnostic(staged) } : {}),
      },
    });
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
      return refuse("finding_not_reviewed");
    // URI Raw omits the path; bind both native outputs to the reviewed match.
    const digest = createHash("sha256").update(finding.RawV2).digest("hex");
    const rawDigest = createHash("sha256").update(finding.Raw).digest("hex");
    const fixture = REVIEWED_FIXTURES.find(
      (entry) =>
        entry.fixtureSha256 === digest && (entry.rawSha256 ?? entry.fixtureSha256) === rawDigest,
    );
    if (!fixture) return refuse("literal_not_reviewed");
    if (typeof file !== "string" || scannerLine === null) return refuse("metadata_mismatch");
    if (staged?.kind !== "blob" || !staged.bytes) return refuse("material_not_reviewed");
    if (
      !staged.references.length ||
      staged.references.some(
        ({ source, mode }) => mode !== "100644" || !fixture.sources.some((path) => path === source),
      )
    )
      return refuse("source_not_reviewed");
    const uri = new URL(finding.RawV2);
    const parts = object(finding.SecretParts);
    if (
      !parts ||
      Object.keys(parts).length !== 3 ||
      parts.host !== uri.host ||
      parts.username !== uri.username ||
      parts.password !== uri.password
    )
      return refuse("metadata_mismatch");
    const valueKey = `${file}:${digest}`;
    let literalLine = literalLines.get(valueKey);
    if (literalLine === undefined) {
      // Decoding can shift coordinates, and deduplication can drop the plain
      // finding. Bind to staged bytes and record one literal witness separately
      // from the scanner's location, without allocating unbounded line lists.
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(staged.bytes);
      } catch {
        return refuse("literal_mismatch");
      }
      let lineStart = 0;
      let lineNumber = 1;
      let literalOccurrences = 0;
      while (lineStart <= text.length) {
        const newline = text.indexOf("\n", lineStart);
        const lineEnd = newline === -1 ? text.length : newline;
        const line = text.slice(lineStart, lineEnd);
        if (line.includes(finding.RawV2)) {
          let occurrence = line.indexOf(finding.RawV2);
          while (occurrence !== -1) {
            literalOccurrences++;
            occurrence = line.indexOf(finding.RawV2, occurrence + finding.RawV2.length);
          }
          if (
            fixture.lineSha256s &&
            !fixture.lineSha256s.includes(createHash("sha256").update(line).digest("hex"))
          )
            return refuse("literal_mismatch");
          literalLine ??= lineNumber;
        }
        if (newline === -1) break;
        lineStart = newline + 1;
        lineNumber++;
      }
      if (
        literalLine === undefined ||
        (fixture.lineSha256s !== undefined && literalOccurrences !== 1)
      )
        return refuse("literal_mismatch");
      literalLines.set(valueKey, literalLine);
    }
    const blob = basename(file);
    const key = `${blob}:${scannerLine}:${finding.DecoderName}`;
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
        scannerLine,
        literalLine,
        decoder: finding.DecoderName,
        occurrences: (previous?.occurrences ?? 0) + 1,
      });
      classified.set(groupKey, group);
    }
  }
  return {
    kind: "classified",
    notices: [...classified.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, group]) => ({
        fixtureSha256: group.fixtureSha256,
        source: group.source,
        detector: "URI",
        findings: [...group.findings.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, value]) => value),
      })),
  };
}
