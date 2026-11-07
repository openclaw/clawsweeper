import { createHash } from "node:crypto";
import type { StagedScanInput } from "./agent-input-scan-fixtures.js";

// Additive to inventory v1. No source text, field names, lengths or match digests.
export type ScanWitnessUnavailableReason =
  | "unknown_material"
  | "decoded"
  | "ambiguous"
  | "unsupported_material"
  | "material_identity_mismatch"
  | "unbound_identity"
  | "not_proven"
  | "repeated_literal"
  | "scanner_line_mismatch"
  | "patch_source_unproven";
export interface ScanFindingWitness {
  version: 1;
  location:
    | { status: "unique_blob_start"; line: number; byteColumn: number }
    | { status: "unavailable"; reason: ScanWitnessUnavailableReason };
  // Equality of native (detector, Raw, RawV2) only, NOT occurrence/credential identity.
  // Ordinals are allocated among retained entries only and have no cross-scan meaning.
  correlation:
    | { status: "scan_local_identity"; group: number }
    | { status: "unavailable"; reason: ScanWitnessUnavailableReason };
}

interface NativeIdentity {
  detector: number;
  raw: string;
  rawV2: string;
}
export interface WitnessCandidate {
  location: ScanFindingWitness["location"];
  unavailable?: ScanWitnessUnavailableReason;
  identity?: NativeIdentity;
}
const MAX_MATERIAL_BYTES = 1024 * 1024;
const MAX_IDENTITY_BYTES = 64 * 1024;

/** Used only after the complete native scan contract and staged metadata validate. */
export function findingWitnessCandidate(
  finding: Record<string, unknown>,
  staged: StagedScanInput | undefined,
  validatedMaterial: boolean,
  scannerLine: number | null,
): WitnessCandidate {
  const unavailable = (reason: ScanWitnessUnavailableReason): WitnessCandidate => ({
    location: { status: "unavailable", reason },
    unavailable: reason,
  });
  if (!staged || !validatedMaterial) return unavailable("unknown_material");
  if (finding.DecoderName !== "PLAIN") return unavailable("decoded");
  if ("references" in staged && staged.references.length !== 1) return unavailable("ambiguous");
  if (staged.kind !== "blob" && staged.kind !== "patch") return unavailable("unsupported_material");
  if (
    (staged.kind === "blob" && !["100644", "100755"].includes(staged.references[0]!.mode)) ||
    (staged.kind === "patch" && staged.metadataProof)
  )
    return unavailable("unsupported_material");
  const bytes = staged.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_MATERIAL_BYTES)
    return unavailable("not_proven");
  if (staged.kind === "blob") {
    const hash = createHash(staged.id.length === 40 ? "sha1" : "sha256")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (hash !== staged.id) return unavailable("material_identity_mismatch");
  }
  const { Raw: raw, RawV2: rawV2, DetectorType: detector } = finding;
  if (
    finding.SourceType !== 15 ||
    scannerLine === null ||
    !Number.isInteger(detector) ||
    (detector as number) < 0 ||
    (detector as number) > 2_147_483_647 ||
    typeof raw !== "string" ||
    typeof rawV2 !== "string" ||
    !raw ||
    !rawV2 ||
    Buffer.byteLength(raw) > MAX_IDENTITY_BYTES ||
    Buffer.byteLength(rawV2) > MAX_IDENTITY_BYTES ||
    /[\r\n\0]/.test(rawV2) ||
    Buffer.from(rawV2).toString("utf8") !== rawV2
  )
    return unavailable("unbound_identity");
  // Fatal decoding excludes binary/invalid UTF-8; never echo decoder exceptions.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return unavailable("not_proven");
  }
  const literal = Buffer.from(rawV2);
  const offset = bytes.indexOf(literal);
  if (offset < 0) return unavailable("unbound_identity");
  const identity = { detector: detector as number, raw, rawV2 };
  if (staged.kind === "patch")
    return { location: { status: "unavailable", reason: "patch_source_unproven" }, identity };
  if (bytes.indexOf(literal, offset + 1) !== -1)
    return { location: { status: "unavailable", reason: "repeated_literal" }, identity };
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index++) {
    if (bytes[index] === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  if (line !== scannerLine) return unavailable("scanner_line_mismatch");
  // Start only: an end column or span length would disclose the match length.
  return {
    location: { status: "unique_blob_start", line, byteColumn: offset - lineStart + 1 },
    identity,
  };
}

/** Holds at most the retained inventory's identities; nothing secret-derived is serialized. */
export function retainFindingWitness(
  candidate: WitnessCandidate,
  retained: readonly WitnessCandidate[],
): ScanFindingWitness {
  const identity = candidate.identity;
  const previous = identity
    ? retained.findIndex(
        (other) =>
          other.identity?.detector === identity.detector &&
          other.identity.raw === identity.raw &&
          other.identity.rawV2 === identity.rawV2,
      )
    : -1;
  return {
    version: 1,
    location: candidate.location,
    correlation: identity
      ? { status: "scan_local_identity", group: previous < 0 ? retained.length : previous }
      : { status: "unavailable", reason: candidate.unavailable ?? "not_proven" },
  };
}
