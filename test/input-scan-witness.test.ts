import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";
import { AgentInputScanError, agentInputScanFailureExitCode } from "../dist/agent-input-scan.js";
import { writeExactReviewFailureDiagnostics } from "../dist/clawsweeper-review-failure-diagnostics.js";
import { inspectInputScanDiagnostic } from "../scripts/inspect-input-scan-diagnostic.mjs";

// Injected classifier records, NOT native detections; real native proof is separate.
const a = "OPAQUE_CANARY_ALPHA";
const b = "OPAQUE_CANARY_BETA";
const file = "/staged/PRIVATE_PATH_CANARY";
const patchFile = "/staged/PRIVATE_PATCH_CANARY";
const text = `{"PRIVATE_KEY_CANARY":{"first":"${a}","second":"${b}"}}\n`;
function blob(content = text, algorithm = "sha1"): StagedScanInput {
  const bytes = Buffer.from(content);
  return {
    kind: "blob",
    bytes,
    id: createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    references: [
      {
        revision: "a".repeat(algorithm === "sha1" ? 40 : 64),
        source: "PRIVATE_SOURCE_CANARY",
        mode: "100644",
        role: "head",
      },
    ],
  };
}
const patch: StagedScanInput = {
  kind: "patch",
  id: "0",
  from: "b".repeat(40),
  to: "c".repeat(40),
  bytes: Buffer.from(`+${a}\n+${b}\n`),
};
const finding = (value = a, path = file, overrides = {}) => ({
  SourceType: 15,
  DetectorType: 17,
  DetectorName: "URI",
  DecoderName: "PLAIN",
  Verified: false,
  VerificationError: "PRIVATE_ERROR_CANARY",
  Raw: value,
  RawV2: value,
  ExtraData: null,
  StructuredData: null,
  SourceMetadata: { Data: { Filesystem: { file: path, line: 1 } } },
  ...overrides,
});
function scan(records = [finding()], input = blob(), patchInput = patch) {
  const result = classifyReviewedFixtureScan(
    183,
    Buffer.from(records.map((record) => JSON.stringify(record) + "\n").join("")),
    Buffer.from(
      JSON.stringify({
        level: "info-0",
        logger: "trufflehog",
        msg: "finished scanning",
        trufflehog_version: "3.99.4",
        chunks: 1,
        bytes: 1,
        verified_secrets: 0,
        unverified_secrets: records.length,
      }) + "\n",
    ),
    new Map([
      [file, input],
      [patchFile, patchInput],
    ]),
  );
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused" || result.diagnostic.kind !== "unclassified_finding")
    throw new Error("Expected refusal");
  assert.equal(result.reason, "findings");
  return result;
}
const witnesses = (records = [finding()], input = blob(), patchInput = patch) =>
  scan(records, input, patchInput).diagnostic.inventory.entries.map((entry) => entry.witness!);

test("two fields on one line have distinct byte starts, no field names or match lengths", () => {
  for (const algorithm of ["sha1", "sha256"]) {
    const result = scan([finding(), finding(b)], blob(text, algorithm));
    const entries = result.diagnostic.inventory.entries;
    assert.equal(result.diagnostic.reason, "literal_not_reviewed");
    assert.equal(result.diagnostic.findingIndex, 0);
    assert.deepEqual(
      entries.map((entry) => entry.witness!.location),
      [a, b].map((value) => ({
        status: "unique_blob_start",
        line: 1,
        byteColumn: Buffer.byteLength(text.slice(0, text.indexOf(value))) + 1,
      })),
    );
    assert.deepEqual(
      entries.map((entry) => entry.witness!.correlation),
      [0, 1].map((group) => ({ status: "scan_local_identity", group })),
    );
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      a,
      b,
      file,
      patchFile,
      "PRIVATE_",
      "Raw",
      "rawV2",
      "length",
      "exception",
      createHash("sha256").update(a).digest("hex"),
    ])
      assert.equal(serialized.includes(forbidden), false);
  }
  const utf8 = `é${a}\n`;
  assert.deepEqual(witnesses([finding()], blob(utf8))[0]!.location, {
    status: "unique_blob_start",
    line: 1,
    byteColumn: 3,
  });
});

test("scan-local raw tuple equality correlates blob/patch without claiming occurrence identity", () => {
  const records = [
    finding(),
    finding(a, patchFile),
    finding(b, patchFile),
    finding(b),
    finding(a, patchFile),
  ];
  const relations = witnesses(records);
  assert.deepEqual(
    relations.map((w) => w.correlation),
    [0, 0, 2, 2, 0].map((group) => ({ status: "scan_local_identity", group })),
  );
  assert.deepEqual(relations[1]!.location, {
    status: "unavailable",
    reason: "patch_source_unproven",
  });
  const reversed = witnesses([...records].reverse());
  for (let i = 0; i < records.length; i++)
    for (let j = 0; j < records.length; j++) {
      const relation = (items: typeof relations, x: number, y: number) => {
        const first = items[x]!.correlation,
          second = items[y]!.correlation;
        return (
          first.status === "scan_local_identity" &&
          second.status === "scan_local_identity" &&
          first.group === second.group
        );
      };
      assert.equal(
        relation(relations, i, j),
        relation(reversed, records.length - i - 1, records.length - j - 1),
      );
    }
  // Same RawV2, different Raw: different native identity, not a shared group.
  assert.deepEqual(
    witnesses([finding(), finding(a, patchFile, { Raw: b })]).map((w) => w.correlation),
    [0, 1].map((group) => ({ status: "scan_local_identity", group })),
  );
  const repeated = witnesses([finding()], blob(`${a} ${a}\n`))[0]!;
  assert.deepEqual(repeated.location, { status: "unavailable", reason: "repeated_literal" });
  assert.equal(repeated.correlation.status, "scan_local_identity");
});

test("witness hashing/search work stops when the ordered inventory sample fills", () => {
  const input = blob(a + "x".repeat(1024 * 1024 - a.length));
  const bytes = input.bytes!;
  let reads = 0;
  Object.defineProperty(input, "bytes", {
    get() {
      reads++;
      return bytes;
    },
  });
  const result = scan(
    Array.from({ length: 512 }, () => finding()),
    input,
  );
  const inventory = result.diagnostic.inventory;
  assert.ok(inventory.omittedCount > 0);
  assert.equal(inventory.totalCount, 512);
  assert.equal(inventory.retainedCount + inventory.omittedCount, 512);
  assert.ok(reads <= inventory.retainedCount + 1);
  assert.ok(reads <= 17);
});

test("unknown, decoded, ambiguous, changed identities and unsupported material remain unavailable", () => {
  const cases: [Record<string, unknown>, StagedScanInput, string][] = [
    [finding(a, "UNKNOWN_PATH_CANARY"), blob(), "unknown_material"],
    [finding(a, file, { DecoderName: "BASE64" }), blob(), "decoded"],
    [finding(a, file, { DecoderName: "HTML" }), blob(), "decoded"],
    [finding(), { ...blob(), id: "a".repeat(40) }, "material_identity_mismatch"],
    [finding(), { ...blob(), bytes: Buffer.from(`changed ${a}\n`) }, "material_identity_mismatch"],
    [finding(b), blob(`${a}\n`), "unbound_identity"],
    [finding(a, file, { RawV2: null }), blob(), "unbound_identity"],
    [finding(a, file, { SourceType: 0 }), blob(), "unbound_identity"],
    [finding(a, file, { Raw: "x".repeat(65537) }), blob(), "unbound_identity"],
    [finding(), blob("x".repeat(1048577)), "not_proven"],
    [
      finding(a, file, { SourceMetadata: { Data: { Filesystem: { file, line: 2 } } } }),
      blob(),
      "scanner_line_mismatch",
    ],
    [finding(), { kind: "prompt", id: "prompt", bytes: Buffer.from(a) }, "unsupported_material"],
    [
      finding(),
      { kind: "blob", id: blob().id, bytes: Buffer.from(text), references: [] },
      "ambiguous",
    ],
  ];
  const input = blob();
  if (input.kind !== "blob") throw new Error("Expected blob");
  cases.push([
    finding(),
    { ...input, references: [...input.references, ...input.references] },
    "ambiguous",
  ]);
  cases.push([
    finding(),
    { ...input, references: [{ ...input.references[0]!, mode: "120000" }] },
    "unsupported_material",
  ]);
  for (const [record, material, reason] of cases) {
    const witness = witnesses([record], material)[0]!;
    assert.deepEqual(witness.location, { status: "unavailable", reason });
    assert.deepEqual(witness.correlation, { status: "unavailable", reason });
  }
  const invalidUtf8 = blob();
  invalidUtf8.bytes = Buffer.from([255]);
  invalidUtf8.id = createHash("sha1").update("blob 1\0").update(invalidUtf8.bytes).digest("hex");
  assert.equal(witnesses([finding()], invalidUtf8)[0]!.location.status, "unavailable");
});

test("bounded witness inventory round trips production writer/inspector; legacy optional witness remains readable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "witness-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = scan([
    finding(),
    finding(a, patchFile),
    finding(b),
    ...Array.from({ length: 30 }, () => finding()),
  ]);
  const error = new AgentInputScanError(result.reason, result.diagnostic);
  assert.equal(agentInputScanFailureExitCode(error), 79);
  const dir = writeExactReviewFailureDiagnostics({
    artifactDir: root,
    error,
    prompt: "",
    model: "",
    classification: "agent_input_scan",
    repo: "openclaw/clawsweeper",
    itemKind: "pull_request",
    itemNumber: 1,
    sourceSha: "a".repeat(40),
    retryable: false,
    workflowExit: 79,
    env: {
      GITHUB_REPOSITORY: "example/diagnostic-proof",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
    },
  });
  const path = join(dir, "manifest.json");
  const read = () =>
    inspectInputScanDiagnostic({
      manifestPath: path,
      repository: "openclaw/clawsweeper",
      itemKind: "pull_request",
      itemNumber: 1,
      sourceSha: "a".repeat(40),
      runRepository: "example/diagnostic-proof",
      runId: "1",
      runAttempt: "1",
    });
  const output = read();
  const inventory = output.diagnostic.failure.scan.inventory;
  assert.ok(inventory.omittedCount > 0);
  assert.equal(inventory.retainedCount + inventory.omittedCount, 33);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ failure: { scan: { inventory: result.diagnostic.inventory } } }, null, 2),
    ) <= 6144,
  );
  assert.equal(inventory.entries[0].findingIndex, 0);
  assert.deepEqual(output, read());
  const original = JSON.parse(readFileSync(path, "utf8"));
  for (const mutate of [
    (w: any) => {
      w.version = 2;
    },
    (w: any) => {
      w.location.byteColumn = -1;
    },
    (w: any) => {
      w.location.line = 2;
    },
    (w: any) => {
      w.location.byteColumn = 1048577;
    },
    (w: any) => {
      w.location.key = "PRIVATE_KEY_CANARY";
    },
    (w: any) => {
      w.correlation.group = 16;
    },
    (w: any) => {
      w.correlation.fingerprint = "PRIVATE_CANARY";
    },
    (w: any) => {
      w.location = { status: "unavailable", reason: "PRIVATE_CANARY" };
    },
  ]) {
    const value = structuredClone(original);
    mutate(value.failure.scan.inventory.entries[0].witness);
    writeFileSync(path, JSON.stringify(value));
    assert.throws(read, /Malformed/);
  }
  for (const mutate of [
    (entries: any[]) => {
      entries[1].witness.correlation.group = 1;
      entries[1].witness.location = { status: "unique_blob_start", line: 1, byteColumn: 1 };
    },
    (entries: any[]) => {
      entries[1].detectorType = 18;
    },
    (entries: any[]) => {
      entries[1].witness.correlation.group = 2;
    },
    (entries: any[]) => {
      entries[0].decoder = "HTML";
      entries[0].attributionReason = "decoded";
    },
  ]) {
    const value = structuredClone(original);
    mutate(value.failure.scan.inventory.entries);
    writeFileSync(path, JSON.stringify(value));
    assert.throws(read, /Malformed/);
  }
  for (const entry of original.failure.scan.inventory.entries) delete entry.witness;
  writeFileSync(path, JSON.stringify(original));
  assert.equal(read().diagnostic.failure.scan.inventory.entries[0].witness, undefined);
  delete original.failure.scan.inventory;
  writeFileSync(path, JSON.stringify(original));
  assert.equal(read().diagnostic.failure.scan.inventory, undefined);
});
