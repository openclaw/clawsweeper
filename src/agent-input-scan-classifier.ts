import { sha256 } from "./content-hash.js";
import { APPROVED_SYNTHETIC_VALUES } from "./agent-input-scan-approved-values.js";
import { TRUFFLEHOG_VERSION } from "./review-tool-bootstrap.js";
import { resolveGitObjectMetadata } from "./agent-input-scan-git-metadata.js";

export type ScanSourceRole = "base" | "head" | "index" | "tree" | "worktree";

export interface ScanSourceReference {
  source: string;
  mode: string;
  revision: string;
  role: ScanSourceRole;
}

export type ScanInputOrigin =
  | { kind: "prompt" | "schema" | "additional" }
  | { kind: "raw_diff"; from: string; to: string }
  | { kind: "patch" | "metadata_proof"; from: string; to: string }
  | { kind: "worktree" | "blob"; references: readonly ScanSourceReference[] };

export type StagedScanInput = ScanInputOrigin & { id: string; bytes?: Buffer };

interface ScanMaterialDiagnostic {
  kind: ScanInputOrigin["kind"];
  id: string;
  from?: string;
  to?: string;
  referenceCount?: number;
  references?: { revision: string; pathSha256: string; mode: string; role: ScanSourceRole }[];
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
      reason: "finding_not_reviewed" | "material_not_reviewed" | "metadata_mismatch";
      findingCount: number;
      findingIndex: number;
      detectorType: number | null;
      decoder: "PLAIN" | "HTML" | "ESCAPED_UNICODE" | "OTHER";
      verified: boolean | null;
      scannerLine: number | null;
      material?: ScanMaterialDiagnostic;
    };

export interface ScanClassificationNotice {
  classification: "git_object_id" | "approved_value";
  detector: string;
  findings: { blob: string; scannerLine: number; decoder: string; occurrences: number }[];
}

interface RefusedScan {
  kind: "refused";
  reason: "scanner_failed" | "findings";
  diagnostic: ScanRefusalDiagnostic;
}

type ClassifiedScan =
  | { kind: "classified"; notices: ScanClassificationNotice[] }
  | {
      kind: "git_metadata_proof_required";
      notices: ScanClassificationNotice[];
      proofInputs: ReadonlyMap<string, Buffer>;
    };

/**
 * Serialize prompt context. Source patches are scanned with their committed
 * provenance; copying them into prompt text loses that attribution, so only
 * their identities are kept.
 */
export function serializeReviewContext(
  context: object,
  sourcePatchRecords: readonly unknown[] = [],
): string {
  const sourceRecords = new Set(sourcePatchRecords);
  return JSON.stringify(
    context,
    function (this: unknown, key: string, value: unknown) {
      if (sourceRecords.has(this) && (key === "patch" || key === "patchComplete")) return undefined;
      return value;
    },
    2,
  );
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

function exactStringRecord(value: unknown, keys: readonly string[]): boolean {
  const record = object(value);
  return (
    record !== undefined &&
    Object.keys(record).sort().join("\0") === [...keys].sort().join("\0") &&
    keys.every((key) => typeof record[key] === "string" && record[key].length > 0)
  );
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
          references: input.references.slice(0, 4).map(({ source, mode, revision, role }) => ({
            revision,
            pathSha256: sha256(source),
            mode,
            role,
          })),
        }
      : {}),
  };
}

// A reserved/local hostname is not evidence that the credential is synthetic:
// JDBC properties can name a different destination, and loopback can proxy a
// real database. Admit only complete values already reviewed as synthetic.
function isApprovedSyntheticValue(finding: Record<string, unknown>): boolean {
  if (
    finding.SourceType !== 15 ||
    finding.Verified !== false ||
    typeof finding.VerificationError !== "string" ||
    !finding.VerificationError ||
    finding.StructuredData !== null ||
    typeof finding.Raw !== "string" ||
    typeof finding.RawV2 !== "string"
  )
    return false;
  const raw = finding.Raw;
  const rawV2 = finding.RawV2;
  const rawDigest = sha256(raw);
  const rawV2Digest = sha256(rawV2);
  if (
    !APPROVED_SYNTHETIC_VALUES.some(
      ([type, name, decoders, expectedRaw, expectedRawV2]) =>
        finding.DetectorType === type &&
        finding.DetectorName === name &&
        decoders.includes(String(finding.DecoderName)) &&
        rawDigest === expectedRaw &&
        rawV2Digest === expectedRawV2,
    )
  )
    return false;
  const parts = object(finding.SecretParts);
  switch (finding.DetectorType) {
    case 17: {
      try {
        const uri = new URL(rawV2);
        const authority = /^[^:]+:\/\/([^/?#]*)/.exec(rawV2)?.[1];
        return (
          finding.ExtraData === null &&
          exactStringRecord(parts, ["host", "username", "password"]) &&
          parts!.host === authority?.slice(authority.lastIndexOf("@") + 1) &&
          parts!.username === decodeURIComponent(uri.username) &&
          parts!.password === uri.password
        );
      } catch {
        return false;
      }
    }
    case 10:
      return (
        rawV2 === "" &&
        exactStringRecord(parts, ["connection_string"]) &&
        parts!.connection_string === raw &&
        finding.ExtraData === null &&
        finding.VerificationError === "missing host or password in connection string"
      );
    case 895:
    case 899:
      return (
        rawV2 === "" &&
        exactStringRecord(parts, ["key"]) &&
        parts!.key === raw &&
        (finding.DetectorType === 899
          ? finding.ExtraData === null
          : exactStringRecord(finding.ExtraData, [
              "database",
              "host",
              "rotation_guide",
              "username",
            ]))
      );
    case 968:
      return (
        raw === rawV2 &&
        exactStringRecord(parts, ["connection_string"]) &&
        parts!.connection_string === raw &&
        exactStringRecord(finding.ExtraData, ["database", "host", "sslmode", "username"])
      );
    case 938:
      return (
        rawV2 === "" &&
        exactStringRecord(parts, ["key"]) &&
        parts!.key === raw &&
        finding.ExtraData === null
      );
    default:
      return false;
  }
}

/** Classify a complete native scan. Any finding not explained here refuses. */
export function classifyScan(
  status: number,
  stdout: Buffer,
  stderr: Buffer,
  inputs: ReadonlyMap<string, StagedScanInput>,
): ClassifiedScan | RefusedScan {
  const nativeFailure = (
    reason: Extract<ScanRefusalDiagnostic, { kind: "native_contract" }>["reason"],
  ): RefusedScan => ({
    kind: "refused",
    reason: "scanner_failed",
    diagnostic: { kind: "native_contract", reason },
  });
  if (status !== 183 && (status !== 0 || stdout.length)) return nativeFailure("unexpected_exit");
  const findings = records(stdout);
  if (!findings || (status === 183 && !findings.length)) return nativeFailure("invalid_stdout");
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
    completion.trufflehog_version !== TRUFFLEHOG_VERSION ||
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
  return classifyFindings(findings, inputs);
}

function classifyFindings(
  findings: Record<string, unknown>[],
  inputs: ReadonlyMap<string, StagedScanInput>,
): ClassifiedScan | RefusedScan {
  const groups = new Map<
    string,
    {
      classification: ScanClassificationNotice["classification"];
      detector: string;
      findings: Map<string, ScanClassificationNotice["findings"][number]>;
    }
  >();
  const record = (
    classification: ScanClassificationNotice["classification"],
    detector: string,
    blob: string,
    scannerLine: number,
    decoder: string,
  ) => {
    const key = `${classification}:${detector}`;
    const group = groups.get(key) ?? { classification, detector, findings: new Map() };
    const findingKey = `${blob}:${scannerLine}:${decoder}`;
    const occurrences = (group.findings.get(findingKey)?.occurrences ?? 0) + 1;
    group.findings.set(findingKey, { blob, scannerLine, decoder, occurrences });
    groups.set(key, group);
  };
  const objectWitnesses = new Set<string>();
  const proofInputs = new Map<string, Buffer>();
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
          finding.DecoderName === "PLAIN" ||
          finding.DecoderName === "HTML" ||
          finding.DecoderName === "ESCAPED_UNICODE"
            ? finding.DecoderName
            : "OTHER",
        verified: typeof finding.Verified === "boolean" ? finding.Verified : null,
        scannerLine,
        ...(staged ? { material: materialDiagnostic(staged) } : {}),
      },
    });
    if (typeof file !== "string" || !staged || scannerLine === null)
      return refuse("metadata_mismatch");
    const decoder = String(finding.DecoderName);

    if (isApprovedSyntheticValue(finding)) {
      record("approved_value", String(finding.DetectorName), staged.id, scannerLine, decoder);
      continue;
    }

    // Host-generated diff `index` lines contain Git object IDs that the
    // Cloudflare global-key detector mistakes for keys. Prove each one is that
    // metadata, then require a masked re-scan to clear everything else.
    if (finding.DetectorType === 58 && (staged.kind === "patch" || staged.kind === "raw_diff")) {
      const raw = typeof finding.Raw === "string" ? finding.Raw : undefined;
      const parts = object(finding.SecretParts);
      if (
        finding.DetectorName !== "CloudflareGlobalApiKey" ||
        (staged.kind === "raw_diff" && scannerLine !== 1) ||
        finding.SourceType !== 15 ||
        finding.Verified !== false ||
        typeof finding.VerificationError !== "string" ||
        !finding.VerificationError ||
        (decoder !== "PLAIN" && decoder !== "HTML") ||
        finding.ExtraData !== null ||
        finding.StructuredData !== null ||
        !raw ||
        !exactStringRecord(parts, ["key", "email"]) ||
        parts?.key !== raw ||
        finding.RawV2 !== raw + parts.email ||
        finding.Redacted !== parts.email
      )
        return refuse("metadata_mismatch");
      const witnessKey = `${file}:${raw}`;
      if (!objectWitnesses.has(witnessKey)) {
        if (!resolveGitObjectMetadata(staged, raw, inputs)) return refuse("material_not_reviewed");
        objectWitnesses.add(witnessKey);
      }
      // Only proven metadata fields change in the re-scan input; the original
      // complete patch remains part of the primary native scan.
      const proof = proofInputs.get(file) ?? Buffer.from(staged.bytes!);
      const literal = Buffer.from(raw);
      for (
        let offset = proof.indexOf(literal);
        offset !== -1;
        offset = proof.indexOf(literal, offset + literal.length)
      )
        proof.fill("_", offset, offset + literal.length);
      proofInputs.set(file, proof);
      record("git_object_id", "CloudflareGlobalApiKey", staged.id, scannerLine, decoder);
      continue;
    }

    return refuse("finding_not_reviewed");
  }
  const notices = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => ({
      classification: group.classification,
      detector: group.detector,
      findings: [...group.findings.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, value]) => value),
    }));
  return proofInputs.size
    ? { kind: "git_metadata_proof_required", notices, proofInputs }
    : { kind: "classified", notices };
}
