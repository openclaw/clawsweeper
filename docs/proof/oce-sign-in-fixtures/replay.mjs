import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

try {
  const [mode, classifierFile, ...captures] = process.argv.slice(2);
  assert.ok(
    (mode === "baseline" || mode === "candidate") && classifierFile && captures.length > 0,
    "usage: replay.mjs baseline|candidate <compiled-classifier.js> <native-capture-directory> [...]",
  );
  const { classifyReviewedFixtureScan, validateReviewedAttributionPolicy } = await import(
    pathToFileURL(resolve(classifierFile)).href
  );
  const source = "tests/integration/sign-in-chart-parity.test.mjs";
  const identities = [
    [
      "d51f4eae74f8a56cb0851482c6175f75c26c067b",
      "436f584bec32e8609ff5534ba172b90b4955b32fde3bb6a4a4117e7ce3979bee",
      "288ced18523c897c1752b4338a59f2b9aad7d8ad",
      "base",
    ],
    [
      "708e8b9af0e78f0c4d6a41a7883155f9e08fbe4e",
      "3dc7c2044c566407e91e8983c040e2dfe9255484a18cce82de320042059e56fd",
      "3e29a60b00d2a4c6eb15d4ea2f1f283113592f74",
      "head",
    ],
  ];
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const records = (bytes) => {
    try {
      return bytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error("invalid native JSON; values withheld");
    }
  };
  const encode = (values) =>
    Buffer.from(values.map((value) => JSON.stringify(value)).join("\n") + "\n");
  validateReviewedAttributionPolicy();
  const results = [];
  const captureIdentities = new Set();
  const fixtureDigests = [
    "80604187b394765a0db26f0ce735ae373dcd6e40f275a1f6492bccd3988fe925",
    "80867135981e495d05f129ebfdc5b945fe8f6d532000571afaf68371867b8b5b",
  ];
  const observed = new Map();
  for (const capture of captures) {
    const receipt = JSON.parse(readFileSync(join(capture, "receipt.json"), "utf8"));
    assert.equal(receipt.exitCode, 183);
    assert.equal(
      receipt.binarySha256,
      "70b9108715250b19518b03acea56b2f4907a36dcfaaf77693444bdc007a761b1",
    );
    assert.deepEqual(receipt.argv.slice(3), [
      "--results=verified,unknown",
      "--fail",
      "--fail-on-scan-errors",
      "--no-update",
      "--json",
      "--no-color",
    ]);
    const stdout = readFileSync(join(capture, "native.stdout.jsonl"));
    const stderr = readFileSync(join(capture, "native.stderr.jsonl"));
    assert.ok(stdout.length <= 1048576 && stderr.length <= 1048576);
    const captureIdentity = `${hash(stdout)}:${hash(stderr)}`;
    assert.ok(!captureIdentities.has(captureIdentity), "duplicate native capture identity");
    captureIdentities.add(captureIdentity);
    const findings = records(stdout);
    const logs = records(stderr);
    assert.equal(findings.length, 4);
    const inputs = new Map();
    for (const [blob, digest, revision, role] of identities) {
      const file = join(receipt.argv[2], blob);
      const bytes = readFileSync(file);
      assert.equal(hash(bytes), digest);
      assert.equal(
        createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
        blob,
      );
      inputs.set(file, {
        kind: "blob",
        id: blob,
        bytes,
        references: [{ source, mode: "100644", revision, role }],
      });
    }
    // Positive proof always consumes the complete, unchanged native output streams.
    const result = classifyReviewedFixtureScan(receipt.exitCode, stdout, stderr, inputs);
    if (mode === "baseline") {
      assert.equal(result.kind, "refused");
      assert.equal(result.diagnostic.reason, "literal_not_reviewed");
    } else {
      assert.equal(result.kind, "classified");
      assert.equal(result.notices.length, 2);
      assert.equal(
        result.notices
          .flatMap((notice) => notice.findings)
          .reduce((sum, entry) => sum + entry.occurrences, 0),
        4,
      );
    }
    for (const finding of findings) {
      const fixtureDigest = hash(finding.RawV2);
      const input = inputs.get(finding.SourceMetadata?.Data?.Filesystem?.file);
      // Never include an unknown source value or decoder in proof output or failures.
      assert.ok(fixtureDigests.includes(fixtureDigest), "unexpected fixture digest");
      assert.ok(input, "finding does not identify an inspected source blob");
      assert.ok(["PLAIN", "ESCAPED_UNICODE"].includes(finding.DecoderName), "unexpected decoder");
      const key = `${fixtureDigest}:${input.id}:${finding.DecoderName}`;
      observed.set(key, (observed.get(key) ?? 0) + 1);
    }
    const controls = [];
    if (mode === "candidate") {
      const refuse = (name, change) => {
        const context = {
          status: receipt.exitCode,
          findings: structuredClone(findings),
          logs: structuredClone(logs),
          inputs: new Map(
            [...inputs].map(([key, value]) => [
              key,
              {
                ...value,
                bytes: Buffer.from(value.bytes),
                references: value.references.map((reference) => ({ ...reference })),
              },
            ]),
          ),
        };
        // Only negative controls mutate copies; the native positive records stay untouched.
        change(context);
        const denied = classifyReviewedFixtureScan(
          context.status,
          encode(context.findings),
          encode(context.logs),
          context.inputs,
        );
        assert.equal(denied.kind, "refused", `${name} must remain blocked`);
        controls.push({ name, reason: denied.diagnostic.reason });
      };
      const firstInput = (context) =>
        context.inputs.get(context.findings[0].SourceMetadata.Data.Filesystem.file);
      refuse("changed URI", ({ findings }) => {
        findings[0].Raw += "x";
        findings[0].RawV2 += "x";
      });
      refuse("changed Raw identity", ({ findings }) => {
        findings[0].Raw += "x";
      });
      refuse("changed complete blob", (context) => {
        const entry = firstInput(context);
        entry.bytes = Buffer.concat([entry.bytes, Buffer.from("\n")]);
      });
      refuse("changed complete source line", (context) => {
        const entry = firstInput(context);
        entry.bytes = Buffer.from(
          entry.bytes
            .toString()
            .split("\n")
            .map((line) => (line.includes(context.findings[0].RawV2) ? line + " // changed" : line))
            .join("\n"),
        );
      });
      refuse("foreign source", (context) => {
        firstInput(context).references[0].source = "test/other.test.mjs";
      });
      refuse("additional foreign reference", (context) => {
        const entry = firstInput(context);
        entry.references.push({ ...entry.references[0], source: "test/other.test.mjs" });
      });
      refuse("executable mode", (context) => {
        firstInput(context).references[0].mode = "100755";
      });
      refuse("worktree role", (context) => {
        firstInput(context).references[0].role = "worktree";
      });
      refuse("missing source blob", (context) => {
        context.inputs.delete(context.findings[0].SourceMetadata.Data.Filesystem.file);
      });
      for (const decoder of ["HTML", "BASE64"]) {
        refuse(`unobserved ${decoder} decoder`, ({ findings }) => {
          findings[0].DecoderName = decoder;
        });
      }
      refuse("verified credential", ({ findings, logs }) => {
        findings[0].Verified = true;
        logs.at(-1).verified_secrets = 1;
        logs.at(-1).unverified_secrets = 3;
      });
      refuse("missing verification error", ({ findings }) => {
        delete findings[0].VerificationError;
      });
      refuse("mismatched secret parts", ({ findings }) => {
        findings[0].SecretParts.password += "x";
      });
      refuse("structured data", ({ findings }) => {
        findings[0].StructuredData = {};
      });
      refuse("duplicate finding", ({ findings, logs }) => {
        findings.push(structuredClone(findings[0]));
        logs.at(-1).unverified_secrets++;
      });
      refuse("additional unqualified finding", ({ findings, logs }) => {
        const extra = structuredClone(findings[0]);
        extra.Raw += "x";
        extra.RawV2 += "x";
        findings.push(extra);
        logs.at(-1).unverified_secrets++;
      });
      refuse("incomplete scan", ({ logs }) => {
        logs.pop();
      });
      refuse("detector failure", ({ logs }) => {
        logs[0].error = "controlled failure";
      });
      refuse("wrong completion count", ({ logs }) => {
        logs.at(-1).unverified_secrets++;
      });
      refuse("wrong native exit", (context) => {
        context.status = 0;
      });
    }
    assert.equal(hash(readFileSync(join(capture, "native.stdout.jsonl"))), hash(stdout));
    assert.equal(hash(readFileSync(join(capture, "native.stderr.jsonl"))), hash(stderr));
    results.push({
      nativeStdoutSha256: hash(stdout),
      nativeStderrSha256: hash(stderr),
      result,
      controls,
    });
  }
  const matrix = fixtureDigests.flatMap((fixtureDigest, fixtureIndex) =>
    identities.flatMap(([blob], blobIndex) =>
      ["PLAIN", "ESCAPED_UNICODE"].map((decoder) => {
        const count = observed.get(`${fixtureDigest}:${blob}:${decoder}`) ?? 0;
        const expectedCount =
          blobIndex === 1
            ? decoder === "PLAIN"
              ? 0
              : 3
            : decoder === "PLAIN"
              ? 2 - fixtureIndex
              : 1 + fixtureIndex;
        return { fixtureDigest, blob, decoder, count, expectedCount };
      }),
    ),
  );
  for (const fixtureDigest of fixtureDigests) {
    for (const decoder of ["PLAIN", "ESCAPED_UNICODE"]) {
      assert.ok(
        matrix.some(
          (entry) =>
            entry.fixtureDigest === fixtureDigest && entry.decoder === decoder && entry.count > 0,
        ),
        "native captures do not cover both decoders for each fixture",
      );
    }
  }
  assert.ok(
    matrix.every(({ count, expectedCount }) => count === expectedCount),
    "native capture matrix differs from the documented observations",
  );
  const qualificationMatrix = matrix.map(({ fixtureDigest, blob, decoder, count }) => ({
    fixtureDigest,
    blob,
    decoder,
    count,
    qualified: count > 0 || (blob === identities[1][0] && decoder === "PLAIN"),
    evidence:
      count > 0
        ? "direct native observation"
        : "separate committed-range capture; see range-results.json",
  }));
  console.log(
    JSON.stringify(
      {
        mode,
        qualificationMatrix,
        classifierSha256: hash(readFileSync(classifierFile)),
        scope: "Captured native scanner output and real classifier; not hosted target review",
        results,
      },
      null,
      2,
    ),
  );
} catch {
  console.error("Fixture proof failed; private input values withheld.");
  process.exitCode = 1;
}
