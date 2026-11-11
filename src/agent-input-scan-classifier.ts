import { sha256 } from "./content-hash.js";
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
  classification: "git_object_id" | "reserved_host" | "approved_value";
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

// Credential detectors whose value names the host it would unlock:
// JDBC, URI, MongoDB, FTP and Postgres.
const HOST_CREDENTIAL_DETECTORS = new Set([10, 17, 895, 899, 968]);
const STRICT_HOST = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

// RFC 2606/6761 names and loopback addresses never route to a reachable server.
export function isReservedHost(hostPort: string): boolean {
  if (!STRICT_HOST.test(hostPort)) return false;
  const host = (
    hostPort.startsWith("[") ? hostPort.slice(1, hostPort.indexOf("]")) : hostPort.split(":")[0]!
  )
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "::1" || /^127(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}$/.test(host))
    return true;
  return (
    [".test", ".example", ".invalid", ".localhost"].some((suffix) => host.endsWith(suffix)) ||
    ["localhost", "example.com", "example.net", "example.org"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  );
}

/**
 * TruffleHog reports "unknown" when it cannot test a credential, which for
 * test values is almost always because the host does not exist. A credential
 * whose every target host is reserved or loopback cannot unlock anything
 * reachable. Verified findings, other detectors, and any public or
 * unparseable host still refuse.
 */
function isReservedHostCredential(finding: Record<string, unknown>): boolean {
  if (
    finding.SourceType !== 15 ||
    finding.Verified !== false ||
    typeof finding.VerificationError !== "string" ||
    !finding.VerificationError ||
    typeof finding.DetectorType !== "number" ||
    !HOST_CREDENTIAL_DETECTORS.has(finding.DetectorType)
  )
    return false;
  const hosts: string[] = [];
  for (const value of [finding.Raw, finding.RawV2]) {
    if (typeof value !== "string" || !value) continue;
    // Read the authority up to the path, query, or fragment like a URL parser
    // would; anything odd inside it (quotes, spaces) then fails STRICT_HOST.
    const authorities = [...value.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/g)];
    // A credential value without a parseable authority has no host to judge.
    if (authorities.length === 0) return false;
    for (const [, authority] of authorities) {
      if (authority!.includes("\\")) return false;
      // Like URL parsers, the host follows the last @; MongoDB lists seed hosts.
      hosts.push(...authority!.slice(authority!.lastIndexOf("@") + 1).split(","));
    }
  }
  const parts = object(finding.SecretParts);
  if (typeof parts?.host === "string") hosts.push(parts.host);
  return hosts.length > 0 && hosts.every(isReservedHost);
}

// Previously reviewed synthetic values whose test needs a real hostname, so the
// reserved-host rule cannot judge them. Bound to the exact native value pair
// ("Raw:RawV2" SHA-256), not to a file: editing the surrounding file is fine.
const APPROVED_SYNTHETIC_VALUES = new Set([
  // Azure dynamic sessions test (azurecontainerapps.io)
  "18b8a05caad228f56cfded41e0ce2f513f859be0da13c3a688b169ded93637d1:18b8a05caad228f56cfded41e0ce2f513f859be0da13c3a688b169ded93637d1",
  // GrillTrack generated event UUID (Privacy detector)
  "6e31751daf97832583d6877d6f79a17eb9b74188d3916d1668d136af36a9ea45:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  // OCE Kubernetes compute test (10.42.0.15)
  "fde443718383531e2fc52a8324fc644f1c45c1c766afd11da028368831e0f457:fde443718383531e2fc52a8324fc644f1c45c1c766afd11da028368831e0f457",
  "18e186031a746783f43d3002e63b775b6e28acef5d60825a82c418ad3e603b5b:18e186031a746783f43d3002e63b775b6e28acef5d60825a82c418ad3e603b5b",
  // OpenClaw GitHub detail tests (github.com)
  "902e57fd9767d172abc419455669b173ffe3b1d1e06b45dd190c86b8082a1b2e:a9ff2e4d2ef22693a1505cfa8939988fed4a345e9c86a3df3a5a2cbd53cddf47",
  "902e57fd9767d172abc419455669b173ffe3b1d1e06b45dd190c86b8082a1b2e:237992038e2f8635133fc70c6372f4fd2cbb8a6d01433d243a3056670966ca43",
  "1aa166a254353a56288ad1942fdac6d92342f9ca53ca6690247bae6cc0ac3738:99c6ba8a9fbc40225ed3839f4cadf69924aa66ca191aa2bc647d0a18aaabe731",
  // OpenClaw config-patch test (browserless.io)
  "3699f73147f6969e1a3273a5809e2dd7886b95fad51315008b75bb20c4c9832f:3699f73147f6969e1a3273a5809e2dd7886b95fad51315008b75bb20c4c9832f",
  // autoreview negative tests (bare host)
  "7b8ee01b06a7e5b375164f2c45249bb258c75726a60b27e20a0ba6e42d5d0b27:7b8ee01b06a7e5b375164f2c45249bb258c75726a60b27e20a0ba6e42d5d0b27",
  "662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83:662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83",
  "6c529e5b9845e7f41a5406cea40dc9dc98bfc8da6a330c3cdb34554f2dc0317f:eebab8ec3df3ff0426c28021cce68ab7d2391e32d3040b128210e9df7ad3e092",
  "2d082b79ad4da55704d07af5754a91f9a677bfbbdc626d93a58291f11edf53c5:2d082b79ad4da55704d07af5754a91f9a677bfbbdc626d93a58291f11edf53c5",
  "b12f4f7ee1e8ec1c544b81f14b0252734d816bd79ced79d342dbca650c4f6c31:b12f4f7ee1e8ec1c544b81f14b0252734d816bd79ced79d342dbca650c4f6c31",
  "05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1:05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1",
  "80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2:80842079cf4e73add753d25a74646356617b39c399e77d38b34bb21818e303d2",
  "fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736:fe36092bead3bd47192a05374917c4614ce7642137dc83b9685ab6b5a37d8736",
]);

function isApprovedSyntheticValue(finding: Record<string, unknown>): boolean {
  return (
    finding.SourceType === 15 &&
    finding.Verified === false &&
    typeof finding.Raw === "string" &&
    typeof finding.RawV2 === "string" &&
    APPROVED_SYNTHETIC_VALUES.has(`${sha256(finding.Raw)}:${sha256(finding.RawV2)}`)
  );
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

    if (isReservedHostCredential(finding)) {
      record("reserved_host", String(finding.DetectorName), staged.id, scannerLine, decoder);
      continue;
    }
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
