import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  appendFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { AGENT_INPUT_SCAN_FAILURE_REASONS } from "../dist/exact-review-failure-reason.js";

const MAX_BYTES = 24 * 1024;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const DECIMAL = /^[1-9][0-9]{0,19}$/;
const NATIVE_REASONS = [
  "invalid_stdout",
  "invalid_stderr",
  "scan_error",
  "incomplete_scan",
  "completion_mismatch",
  "unexpected_exit",
];
const FINDING_REASONS = [
  "finding_not_reviewed",
  "literal_not_reviewed",
  "material_not_reviewed",
  "source_not_reviewed",
  "metadata_mismatch",
  "literal_mismatch",
  "duplicate_finding",
];
const MATERIAL_KINDS = [
  "prompt",
  "schema",
  "additional",
  "raw_diff",
  "raw_diff_proof",
  "patch",
  "worktree",
  "blob",
];
function requireValue(condition, message = "Malformed input-scan diagnostic metadata.") {
  if (!condition) throw new Error(message);
}
function matches(value, pattern) {
  return typeof value === "string" && pattern.test(value) && !/[\s\p{C}]/u.test(value);
}
function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
function scanProjection(scan) {
  if (scan === undefined) return null;
  requireValue(scan && typeof scan === "object");
  if (scan.kind === "native_contract") {
    requireValue(NATIVE_REASONS.includes(scan.reason));
    return { kind: scan.kind, reason: scan.reason };
  }
  requireValue(scan.kind === "unclassified_finding" && FINDING_REASONS.includes(scan.reason));
  requireValue(
    integer(scan.findingCount, 1) &&
      integer(scan.findingIndex) &&
      scan.findingIndex < scan.findingCount,
  );
  requireValue(scan.detectorType === null || integer(scan.detectorType, 0, 2147483647));
  requireValue(["PLAIN", "HTML", "ESCAPED_UNICODE", "OTHER"].includes(scan.decoder));
  requireValue(scan.verified === null || typeof scan.verified === "boolean");
  requireValue(scan.scannerLine === null || integer(scan.scannerLine, 1));
  const result = {
    kind: scan.kind,
    reason: scan.reason,
    findingCount: scan.findingCount,
    findingIndex: scan.findingIndex,
    detectorType: scan.detectorType,
    decoder: scan.decoder,
    verified: scan.verified,
    scannerLine: scan.scannerLine,
    sourceCoordinates: "not_proven",
    material: null,
  };
  if (scan.material !== undefined) {
    const m = scan.material;
    requireValue(
      m &&
        MATERIAL_KINDS.includes(m.kind) &&
        (m.kind === "blob"
          ? matches(m.id, SHA)
          : m.kind === "prompt" || m.kind === "schema"
            ? m.id === m.kind
            : matches(m.id, /^(?:0|[1-9][0-9]{0,15})$/)),
    );
    result.material = { kind: m.kind, id: m.id };
    if (["raw_diff", "raw_diff_proof", "patch"].includes(m.kind)) {
      requireValue(matches(m.from, SHA) && matches(m.to, SHA));
      Object.assign(result.material, { from: m.from, to: m.to });
    }
    if (["worktree", "blob"].includes(m.kind)) {
      requireValue(
        integer(m.referenceCount) &&
          Array.isArray(m.references) &&
          m.references.length <= 4 &&
          m.references.length <= m.referenceCount,
      );
      Object.assign(result.material, {
        referenceCount: m.referenceCount,
        references: m.references.map((ref) => {
          requireValue(
            ref &&
              matches(ref.revision, SHA) &&
              matches(ref.pathSha256, /^[a-f0-9]{64}$/) &&
              ["100644", "100755", "120000"].includes(ref.mode) &&
              ["base", "head", "index", "tree", "worktree"].includes(ref.role),
          );
          return {
            revision: ref.revision,
            pathSha256: ref.pathSha256,
            mode: ref.mode,
            role: ref.role,
          };
        }),
      });
    }
  }
  return result;
}
function readManifest(path) {
  let fd;
  try {
    if (!lstatSync(path).isFile()) throw new Error("Not a regular file.");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error("Diagnostic manifest unavailable or not a regular file.");
  }
  try {
    const stat = fstatSync(fd);
    requireValue(stat.isFile(), "Diagnostic manifest must be a regular file.");
    requireValue(
      stat.size > 0 && stat.size <= MAX_BYTES,
      "Diagnostic manifest size exceeds the supported bound.",
    );
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    requireValue(length <= MAX_BYTES, "Diagnostic manifest size exceeds the supported bound.");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
      );
    } catch {
      throw new Error("Diagnostic manifest is malformed.");
    }
  } finally {
    closeSync(fd);
  }
}

/** Read only the existing manifest; never scanner logs, source, or environment contents. */
export function inspectInputScanDiagnostic(options) {
  const {
    repository,
    itemKind,
    itemNumber,
    sourceSha,
    runRepository,
    runId,
    runAttempt,
    artifactUrl,
  } = options;
  requireValue(
    matches(repository, REPO) &&
      matches(runRepository, REPO) &&
      ["issue", "pull_request"].includes(itemKind) &&
      integer(itemNumber, 1) &&
      (itemKind === "issue" ? matches(sourceSha, /^[a-f0-9]{64}$/) : matches(sourceSha, SHA)) &&
      matches(runId, DECIMAL) &&
      matches(runAttempt, DECIMAL),
    "Invalid expected diagnostic identity.",
  );
  const runUrl = `https://github.com/${runRepository}/actions/runs/${runId}/attempts/${runAttempt}`;
  if (artifactUrl !== undefined) {
    const prefix = `https://github.com/${runRepository}/actions/runs/${runId}/artifacts/`;
    requireValue(
      typeof artifactUrl === "string" &&
        artifactUrl.startsWith(prefix) &&
        matches(artifactUrl.slice(prefix.length), DECIMAL),
      "Invalid diagnostic artifact URL.",
    );
  }
  const m = readManifest(options.manifestPath);
  requireValue(
    m &&
      m.version === 1 &&
      m.classification === "agent_input_scan" &&
      m.retryable === false &&
      m.failure?.stage === "agent_input_scan" &&
      AGENT_INPUT_SCAN_FAILURE_REASONS.includes(m.failure.reason_code),
    "Manifest is not a supported terminal input-scan refusal.",
  );
  requireValue(
    m.source?.repository === repository &&
      m.source?.item_kind === itemKind &&
      m.source?.item_number === itemNumber &&
      m.source?.sha === sourceSha &&
      m.run?.repository === runRepository &&
      m.run?.id === runId &&
      m.run?.attempt === runAttempt,
    "Diagnostic identity mismatch or missing run provenance; do not use a stale artifact.",
  );
  const diagnostic = {
    source: { repository, itemKind, itemNumber, sourceSha },
    run: { repository: runRepository, id: runId, attempt: runAttempt },
    retryable: false,
    failure: {
      stage: "agent_input_scan",
      reason: m.failure.reason_code,
      scan: scanProjection(m.failure.scan),
    },
  };
  const name = `exact-review-failure-diagnostics-${runId}-${runAttempt}`;
  const summary = [
    "### Input-scan refusal diagnostics",
    "",
    `The review remains refused. [Open the exact workflow attempt](${runUrl}).`,
    artifactUrl
      ? `[Download diagnostic artifact](${artifactUrl}) (\`${name}\`).`
      : `Find artifact \`${name}\` on that run.`,
    "Use the [authenticated inspection recipe](https://github.com/openclaw/clawsweeper/blob/main/docs/input-scan-diagnostics.md) to verify its identity and read sanitized metadata.",
    "Diagnostic contents are intentionally omitted here. Inspection does not authorize a retry or a fixture exemption.",
    "",
  ].join("\n");
  return { diagnostic, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [
      mode,
      manifestPath,
      repository,
      itemKind,
      number,
      sourceSha,
      runRepository,
      runId,
      runAttempt,
    ] = process.argv.slice(2);
    requireValue(
      ["--inspect", "--summary"].includes(mode) &&
        process.argv.length === 11 &&
        matches(number, DECIMAL),
      "Usage: inspect-input-scan-diagnostic.mjs --inspect|--summary MANIFEST REPO KIND NUMBER SHA RUN_REPO RUN_ID ATTEMPT",
    );
    const result = inspectInputScanDiagnostic({
      manifestPath,
      repository,
      itemKind,
      itemNumber: Number(number),
      sourceSha,
      runRepository,
      runId,
      runAttempt,
      ...(mode === "--summary" ? { artifactUrl: process.env.DIAGNOSTIC_ARTIFACT_URL } : {}),
    });
    if (mode === "--summary") appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary);
    else process.stdout.write(`${JSON.stringify(result.diagnostic, null, 2)}\n`);
  } catch (error) {
    // All errors at this boundary use fixed messages, never filesystem/parser detail.
    process.stderr.write(
      `Input-scan diagnostic inspection failed: ${error instanceof Error && /^(?:Invalid |Malformed |Diagnostic |Manifest |Usage:)/.test(error.message) ? error.message : "Diagnostic unavailable."}\n`,
    );
    process.exitCode = 1;
  }
}
