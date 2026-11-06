import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, classifierFile, ...captures] = process.argv.slice(2);
assert.ok(
  (mode === "baseline" || mode === "candidate") && classifierFile && captures.length === 2,
  "usage: replay.mjs baseline|candidate <compiled-classifier.js> <base-capture> <head-capture>",
);
const { classifyReviewedFixtureScan, validateReviewedAttributionPolicy } = await import(
  pathToFileURL(resolve(classifierFile)).href
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (records) =>
  Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON in proof input; values withheld.");
  }
};
const source = "tests/integration/configuration-controller.test.mjs";
const identities = [
  [
    "a47ca824f479fc37a2fa63aa9205cf953cdc11a0",
    "4fb0781a6e0e4663293fe38f5cb2a8919d934f071f1c6d0e4087550aa3583248",
    "0c7126dc16df1a01e2242e9bd35f9e742d6cee56",
    "base",
    5448,
  ],
  [
    "f0e927f8cc0be7876b2ed845c5d5c9a95cf478c8",
    "e635d55d005c55600ef11b138a739497728bb5fcdd314ca5f064be6e76c57010",
    "35189c5da21389a6ce85255ee65d8e979e26a8e9",
    "head",
    5451,
  ],
];
validateReviewedAttributionPolicy();
const results = [];
for (const [index, capture] of captures.entries()) {
  const [blob, sourceHash, revision, role, line] = identities[index];
  const receipt = parse(readFileSync(join(capture, "receipt.json"), "utf8"));
  assert.equal(receipt.exitCode, 183);
  assert.equal(
    receipt.binarySha256,
    "70b9108715250b19518b03acea56b2f4907a36dcfaaf77693444bdc007a761b1",
  );
  assert.deepEqual(receipt.argv.slice(1, 2), ["filesystem"]);
  assert.deepEqual(receipt.argv.slice(3), [
    "--results=verified,unknown",
    "--fail",
    "--fail-on-scan-errors",
    "--no-update",
    "--json",
    "--no-color",
  ]);
  const file = join(receipt.argv[2], blob);
  const bytes = readFileSync(file);
  assert.equal(hash(bytes), sourceHash);
  assert.equal(
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    blob,
  );
  const stdout = readFileSync(join(capture, "native.stdout.jsonl"));
  const stderr = readFileSync(join(capture, "native.stderr.jsonl"));
  assert.equal(hash(stdout), receipt["native.stdout.jsonl"].sha256);
  assert.equal(hash(stderr), receipt["native.stderr.jsonl"].sha256);
  const findings = stdout.toString().trimEnd().split("\n").map(parse);
  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.equal(
    hash(finding.Raw),
    "7f73c5b7c4cb379bbcc944971cff2c6a15ac0b0398b4c66ded6c8fb5db2c1833",
  );
  assert.equal(finding.SourceMetadata.Data.Filesystem.file, file);
  assert.equal(finding.SourceMetadata.Data.Filesystem.line, line);
  const input = {
    kind: "blob",
    id: blob,
    bytes,
    references: [{ source, mode: "100644", revision, role }],
  };
  const inputs = new Map([[file, input]]);
  // Positive proof consumes the complete native streams without altering either.
  const result = classifyReviewedFixtureScan(receipt.exitCode, stdout, stderr, inputs);
  assert.equal(result.kind, mode === "baseline" ? "refused" : "classified");
  if (mode === "baseline") assert.equal(result.diagnostic.reason, "finding_not_reviewed");
  else {
    assert.equal(result.notices.length, 1);
    assert.deepEqual(result.notices[0].findings, [
      { blob, scannerLine: line, literalLine: line, decoder: "PLAIN", role, occurrences: 1 },
    ]);
  }
  const refused = [];
  const reject = (name, records = findings, staged = input, logs = stderr, status = 183) => {
    assert.equal(
      classifyReviewedFixtureScan(status, encode(records), logs, new Map([[file, staged]])).kind,
      "refused",
      name,
    );
    refused.push(name);
  };
  if (mode === "candidate") {
    // Mutated copies prove refusal boundaries; they never stand in for native positive evidence.
    for (const [name, change] of [
      ["unobserved decoder", { DecoderName: "HTML" }],
      ["wrong detector", { DetectorType: 17 }],
      ["wrong detector name", { DetectorName: "URI" }],
      ["foreign source type", { SourceType: 1 }],
      ["changed raw", { Raw: finding.Raw + "x" }],
      ["nonempty rawV2", { RawV2: finding.Raw }],
      ["missing verification error", { VerificationError: undefined }],
      ["different verification failure", { VerificationError: "connection refused" }],
      ["extra data", { ExtraData: {} }],
      ["structured data", { StructuredData: {} }],
      ["changed connection string", { SecretParts: { connection_string: finding.Raw + "x" } }],
      [
        "additional credential part",
        { SecretParts: { ...finding.SecretParts, password: "synthetic" } },
      ],
      ["wrong source line", { SourceMetadata: { Data: { Filesystem: { file, line: line + 1 } } } }],
    ])
      reject(name, [{ ...finding, ...change }]);
    for (const [name, change] of [
      ["changed complete source", { bytes: Buffer.concat([bytes, Buffer.from("\n")]) }],
      [
        "changed literal",
        { bytes: Buffer.from(bytes.toString().replace(finding.Raw, finding.Raw + "x")) },
      ],
      ["worktree material", { kind: "worktree" }],
      ["foreign path", { references: [{ ...input.references[0], source: "test/other.ts" }] }],
      ["executable source", { references: [{ ...input.references[0], mode: "100755" }] }],
      ["uncommitted role", { references: [{ ...input.references[0], role: "worktree" }] }],
      [
        "additional foreign reference",
        { references: [...input.references, { ...input.references[0], source: "test/other.ts" }] },
      ],
      ["missing provenance", { references: [] }],
    ])
      reject(name, findings, { ...input, ...change });
    const logs = stderr.toString().trimEnd().split("\n").map(parse);
    const completed = (counts) =>
      encode(
        logs.map((entry) => (entry.msg === "finished scanning" ? { ...entry, ...counts } : entry)),
      );
    reject(
      "verified finding",
      [{ ...finding, Verified: true }],
      input,
      completed({ verified_secrets: 1, unverified_secrets: 0 }),
    );
    reject("duplicate finding", [finding, finding], input, completed({ unverified_secrets: 2 }));
    reject(
      "additional unknown finding",
      [finding, { ...finding, Raw: finding.Raw + "x" }],
      input,
      completed({ unverified_secrets: 2 }),
    );
    reject("incomplete native scan", findings, input, Buffer.alloc(0));
    reject(
      "detector error",
      findings,
      input,
      encode([{ level: "error", logger: "trufflehog", msg: "detector failed" }, ...logs]),
    );
    reject("wrong exit", findings, input, stderr, 0);
  }
  const rejectedPolicyChanges = [];
  if (mode === "candidate" && index === 0) {
    const policy = [
      10,
      "JDBC",
      "PLAIN",
      hash(finding.Raw),
      hash(""),
      hash(bytes.toString().split("\n")[line - 1]),
      source,
      "100644",
      identities.map((entry) => entry[1]),
    ];
    // Adding JDBC must not inherit another detector's broader source policy.
    for (const [name, change] of [
      ["foreign logging source", { 6: "src/logging/redact.test.ts" }],
      ["additional source hash", { 8: [...policy[8], hash("other source")] }],
      ["changed raw hash", { 3: hash("other value") }],
      ["unobserved decoder", { 2: "HTML" }],
    ]) {
      assert.throws(
        () =>
          classifyReviewedFixtureScan(183, stdout, stderr, inputs, [
            Object.assign([...policy], change),
          ]),
        /invalid reviewed attribution policy/,
        name,
      );
      rejectedPolicyChanges.push(name);
    }
  }
  results.push({
    blob,
    sourceHash,
    role,
    line,
    stdoutSha256: hash(stdout),
    stderrSha256: hash(stderr),
    result: result.kind,
    refused,
    rejectedPolicyChanges,
  });
}
console.log(
  JSON.stringify({ mode, classifierSha256: hash(readFileSync(classifierFile)), results }, null, 2),
);
