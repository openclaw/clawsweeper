import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

try {
  const [mode, classifier, target, ...captures] = process.argv.slice(2);
  assert.ok(
    (mode === "baseline" || mode === "candidate") && classifier && target && captures.length,
  );
  const { classifyReviewedFixtureScan } = await import(pathToFileURL(resolve(classifier)));
  const base = "288ced18523c897c1752b4338a59f2b9aad7d8ad";
  const head = "3e29a60b00d2a4c6eb15d4ea2f1f283113592f74";
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const git = (...args) =>
    execFileSync("git", ["-C", target, ...args], {
      maxBuffer: 16777216,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=none",
    base,
    head,
  ];
  const raw = git(...args, "--raw", "--no-abbrev", "-z", "--");
  const patch = git(...args, "--patch", "--binary", "--full-index", "--");
  const references = new Map();
  const fields = raw.toString().split("\0");
  assert.equal(fields.pop(), "");
  for (let i = 0; i < fields.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [AMDT]$/.exec(fields[i]);
    assert.ok(match);
    for (const [mode, id, revision, role] of [
      [match[1], match[3], base, "base"],
      [match[2], match[4], head, "head"],
    ]) {
      if (mode === "000000") continue;
      const rows = references.get(id) ?? [];
      rows.push({ source: fields[i + 1], mode, revision, role });
      references.set(id, rows);
    }
  }
  const reports = [];
  const capturedStreams = new Set();
  for (const capture of captures) {
    const receipt = JSON.parse(readFileSync(join(capture, "receipt.json")));
    assert.equal(receipt.exitCode, 183);
    assert.equal(
      receipt.binarySha256,
      "70b9108715250b19518b03acea56b2f4907a36dcfaaf77693444bdc007a761b1",
    );
    assert.deepEqual(receipt.argv.slice(1), [
      "filesystem",
      join(capture, "input"),
      "--results=verified,unknown",
      "--fail",
      "--fail-on-scan-errors",
      "--no-update",
      "--json",
      "--no-color",
    ]);
    const inputs = new Map();
    const add = (id, expected, origin) => {
      const file = join(capture, "input", id);
      const bytes = readFileSync(file);
      assert.deepEqual(bytes, expected);
      inputs.set(file, { id, bytes, ...origin });
    };
    add("prompt", Buffer.from("Read-only OCE sign-in enrollment source review."), {
      kind: "prompt",
    });
    add("0", raw, { kind: "raw_diff", from: base, to: head });
    add("1", patch, { kind: "patch", from: base, to: head });
    for (const [id, rows] of references)
      add(id, git("cat-file", "blob", id), { kind: "blob", references: rows });
    assert.equal(inputs.size, 47);
    assert.equal(readdirSync(join(capture, "input")).length, inputs.size);
    const stdout = readFileSync(join(capture, "stdout"));
    const stderr = readFileSync(join(capture, "stderr"));
    assert.equal(hash(stdout), receipt.stdoutSha256);
    assert.ok(!capturedStreams.has(hash(stdout)), "duplicate native stream");
    capturedStreams.add(hash(stdout));
    assert.equal(hash(stderr), receipt.stderrSha256);
    const findings = stdout.toString().trim().split("\n").map(JSON.parse);
    const logs = stderr.toString().trim().split("\n").map(JSON.parse);
    assert.equal(findings.length, 4);
    const observed = findings.map((f) => {
      const input = inputs.get(f.SourceMetadata.Data.Filesystem.file);
      assert.ok(input?.kind === "blob");
      assert.ok(
        [
          "d51f4eae74f8a56cb0851482c6175f75c26c067b",
          "708e8b9af0e78f0c4d6a41a7883155f9e08fbe4e",
        ].includes(input.id),
      );
      assert.ok(["PLAIN", "ESCAPED_UNICODE"].includes(f.DecoderName));
      assert.ok(Number.isSafeInteger(f.SourceMetadata.Data.Filesystem.line));
      assert.ok(f.SourceMetadata.Data.Filesystem.line > 0);
      assert.ok(
        [
          "80604187b394765a0db26f0ce735ae373dcd6e40f275a1f6492bccd3988fe925",
          "80867135981e495d05f129ebfdc5b945fe8f6d532000571afaf68371867b8b5b",
        ].includes(hash(f.Raw)),
      );
      assert.equal(hash(f.Raw), hash(f.RawV2));
      return {
        blob: input.id,
        line: f.SourceMetadata.Data.Filesystem.line,
        rawSha256: hash(f.Raw),
        rawV2Sha256: hash(f.RawV2),
        decoder: f.DecoderName,
      };
    });
    assert.equal(
      new Set(observed.map((finding) => `${finding.blob}:${finding.rawSha256}`)).size,
      4,
    );
    const result = classifyReviewedFixtureScan(183, stdout, stderr, inputs);
    const newTuple = observed.some(
      (f) => f.blob === "708e8b9af0e78f0c4d6a41a7883155f9e08fbe4e" && f.decoder === "PLAIN",
    );
    assert.equal(result.kind, mode === "baseline" && newTuple ? "refused" : "classified");
    if (result.kind === "refused") assert.equal(result.diagnostic.reason, "source_not_reviewed");
    const controls = [];
    if (result.kind === "classified") {
      const encode = (rows) =>
        Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      const refuse = (name, mutate) => {
        const context = {
          findings: structuredClone(findings),
          logs: structuredClone(logs),
          inputs: new Map(
            [...inputs].map(([key, value]) => [
              key,
              { ...structuredClone(value), bytes: Buffer.from(value.bytes) },
            ]),
          ),
        };
        mutate(context);
        const denied = classifyReviewedFixtureScan(
          183,
          encode(context.findings),
          encode(context.logs),
          context.inputs,
        );
        assert.equal(denied.kind, "refused");
        controls.push({ name, reason: denied.diagnostic.reason });
      };
      for (const fixtureDigest of [
        "80604187b394765a0db26f0ce735ae373dcd6e40f275a1f6492bccd3988fe925",
        "80867135981e495d05f129ebfdc5b945fe8f6d532000571afaf68371867b8b5b",
      ]) {
        const changed = (context) =>
          context.findings.find(
            (f) =>
              hash(f.Raw) === fixtureDigest &&
              context.inputs.get(f.SourceMetadata.Data.Filesystem.file)?.id ===
                "708e8b9af0e78f0c4d6a41a7883155f9e08fbe4e",
          );
        refuse("changed complete source", (c) => {
          const f = changed(c);
          const input = c.inputs.get(f.SourceMetadata.Data.Filesystem.file);
          input.bytes = Buffer.concat([input.bytes, Buffer.from("\n")]);
        });
        refuse("invalid scanner line", (c) => {
          changed(c).SourceMetadata.Data.Filesystem.line = 0;
        });
        refuse("unknown decoder", (c) => {
          changed(c).DecoderName = "HTML";
        });
        refuse("verified credential", (c) => {
          changed(c).Verified = true;
          c.logs.at(-1).verified_secrets = 1;
          c.logs.at(-1).unverified_secrets = 3;
        });
        refuse("changed raw identity", (c) => {
          changed(c).Raw += "x";
        });
        refuse("missing verification error", (c) => {
          delete changed(c).VerificationError;
        });
        refuse("foreign source", (c) => {
          const f = changed(c);
          c.inputs.get(f.SourceMetadata.Data.Filesystem.file).references[0].source =
            "test/other.mjs";
        });
        refuse("executable source", (c) => {
          const f = changed(c);
          c.inputs.get(f.SourceMetadata.Data.Filesystem.file).references[0].mode = "100755";
        });
        refuse("duplicate finding", (c) => {
          c.findings.push(structuredClone(changed(c)));
          c.logs.at(-1).unverified_secrets++;
        });
        refuse("additional unknown finding", (c) => {
          const extra = structuredClone(changed(c));
          extra.Raw += "x";
          extra.RawV2 += "x";
          c.findings.push(extra);
          c.logs.at(-1).unverified_secrets++;
        });
      }
    }
    reports.push({
      inputs: inputs.size,
      stdoutSha256: hash(stdout),
      stderrSha256: hash(stderr),
      observed,
      result,
      controls,
    });
  }
  const hasHeadWitness = (report, rawSha256, decoder) =>
    report.observed.some(
      (finding) =>
        finding.blob === "708e8b9af0e78f0c4d6a41a7883155f9e08fbe4e" &&
        finding.rawSha256 === rawSha256 &&
        finding.decoder === decoder,
    );
  for (const rawSha256 of [
    "80604187b394765a0db26f0ce735ae373dcd6e40f275a1f6492bccd3988fe925",
    "80867135981e495d05f129ebfdc5b945fe8f6d532000571afaf68371867b8b5b",
  ]) {
    assert.ok(
      reports.some(
        (plain) =>
          hasHeadWitness(plain, rawSha256, "PLAIN") &&
          reports.some(
            (escaped) =>
              plain.stdoutSha256 !== escaped.stdoutSha256 &&
              hasHeadWitness(escaped, rawSha256, "ESCAPED_UNICODE"),
          ),
      ),
      "missing distinct native decoder observations",
    );
  }

  console.log(
    JSON.stringify(
      { mode, base, head, classifierSha256: hash(readFileSync(classifier)), reports },
      null,
      2,
    ),
  );
} catch {
  console.error("Range proof failed; private input values withheld.");
  process.exitCode = 1;
}
