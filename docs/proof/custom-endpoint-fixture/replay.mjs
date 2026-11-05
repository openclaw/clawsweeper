import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  classifyReviewedFixtureScan,
  validateReviewedAttributionPolicy,
} from "../../../dist/agent-input-scan-fixtures.js";
validateReviewedAttributionPolicy();
// Supply immutable public blobs and the checksum-verified scanner in this directory.
const root = resolve(process.env.FIXTURE_PROOF_INPUT_DIR ?? ".openclaw/tmp/fixture-proof");
const source = "src/gateway/server-methods/config-custom-endpoint.test.ts";
assert.equal(
  execFileSync(join(root, "trufflehog"), ["--version"], { encoding: "utf8" }).trim(),
  "trufflehog 3.99.4",
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const first = readFileSync(join(root, "custom-endpoint.test.ts"));
const second = readFileSync(join(root, "stacked-custom-endpoint.test.ts"));
const gitBlob = (bytes) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from("blob " + bytes.length + String.fromCharCode(0)), bytes]))
    .digest("hex");
assert.equal(gitBlob(first), "391a45d1d6ea176b2d9771346e39ab39a9ba4f2b");
assert.equal(gitBlob(second), "29bbe924be29281295c8c52d114818341de75d22");
const summary = [];
for (const [name, before, after] of [
  ["first", null, first],
  ["stacked", first, second],
]) {
  const cwd = mkdtempSync(join(root, "repo-" + name + "-"));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.name", "roboclaw-bot");
  git("config", "user.email", "309084314+roboclaw-bot@users.noreply.github.com");
  git("config", "commit.gpgsign", "false");
  const refs = [];
  for (const [i, bytes] of [before, after].entries()) {
    if (bytes) {
      mkdirSync(join(cwd, "src/gateway/server-methods"), { recursive: true });
      writeFileSync(join(cwd, source), bytes);
    } else writeFileSync(join(cwd, "README.md"), "Controlled scanner fixture replay.\n");
    git("add", ".");
    git(
      "commit",
      "-qm",
      "Controlled replay " +
        i +
        "\n\nCo-authored-by: jacobtomlinson <1610850+jacobtomlinson@users.noreply.github.com>",
    );
    refs.push(git("rev-parse", "HEAD").toString().trim());
  }
  const [from, to] = refs;
  const directory = mkdtempSync(join(root, "scan-" + name + "-"));
  const inputs = new Map();
  const raw = git("diff", "--raw", "--no-abbrev", "-z", "--no-renames", from, to);
  const rawFile = join(directory, "raw-diff");
  writeFileSync(rawFile, raw);
  inputs.set(rawFile, { kind: "raw_diff", id: "raw-diff", bytes: raw, from, to });
  const patch = git(
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--binary",
    "--full-index",
    from,
    to,
  );
  const patchFile = join(directory, "patch");
  writeFileSync(patchFile, patch);
  inputs.set(patchFile, { kind: "patch", id: "patch", bytes: patch, from, to });
  for (const [i, bytes] of [before, after].entries()) {
    if (!bytes) continue;
    const oid = git("rev-parse", refs[i] + ":" + source)
      .toString()
      .trim();
    const file = join(directory, oid);
    writeFileSync(file, bytes);
    const old = inputs.get(file);
    inputs.set(file, {
      kind: "blob",
      id: oid,
      bytes,
      references: [
        ...(old?.references ?? []),
        { source, mode: "100644", revision: refs[i], role: i === 0 ? "base" : "head" },
      ],
    });
  }
  const native = spawnSync(
    join(root, "trufflehog"),
    [
      "filesystem",
      directory,
      "--results=verified,unknown",
      "--fail",
      "--fail-on-scan-errors",
      "--no-update",
      "--json",
    ],
    { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
  );
  writeFileSync(join(root, name + "-native.stdout.jsonl"), native.stdout);
  writeFileSync(join(root, name + "-native.stderr.jsonl"), native.stderr);
  assert.equal(native.status, 183);
  const findings = native.stdout.toString().trim().split("\n").map(JSON.parse);
  const classify = (f = findings, ins = inputs) =>
    classifyReviewedFixtureScan(
      183,
      Buffer.from(f.map((x) => JSON.stringify(x)).join("\n") + "\n"),
      native.stderr,
      ins,
    );
  const result = classify();
  assert.equal(result.kind, "classified", JSON.stringify(result));
  assert.equal(findings.length, 2, "Both native findings must be individually inspected");
  assert.equal(new Set(findings.map((x) => hash(x.RawV2))).size, 1);
  const negatives = [];
  const reject = (label, fs = findings, ins = inputs) => {
    const r = classify(fs, ins);
    assert.equal(r.kind, "refused", label);
    negatives.push({ label, reason: r.diagnostic?.reason ?? r.reason });
  };
  reject(
    "different full URI path",
    findings.map((f, i) => (i ? f : { ...f, RawV2: f.RawV2 + "/different" })),
  );
  reject(
    "changed dummy password",
    findings.map((f, i) => {
      if (i) return f;
      const uri = new URL(f.RawV2);
      uri.password = "outside-reviewed-control-4c84e9f0";
      return { ...f, RawV2: uri.href };
    }),
  );
  reject(
    "nonreserved host",
    findings.map((f, i) => {
      if (i) return f;
      const uri = new URL(f.RawV2);
      uri.host = "control.invalid";
      return { ...f, RawV2: uri.href };
    }),
  );
  reject(
    "different raw identity",
    findings.map((f, i) => (i ? f : { ...f, Raw: f.Raw + "x" })),
  );
  for (const decoder of ["BASE64", "ESCAPED_UNICODE"])
    reject(
      "unobserved decoder " + decoder,
      findings.map((f) => ({ ...f, DecoderName: decoder })),
    );
  reject(
    "verified material",
    findings.map((f) => ({ ...f, Verified: true })),
  );
  for (const mode of ["wrong path", "edited line", "nonfixture material", "nonregular mode"]) {
    const ins = new Map(
      [...inputs].map(([file, input]) => {
        if (input.kind !== "blob") return [file, input];
        if (mode === "nonfixture material")
          return [file, { kind: "additional", bytes: input.bytes }];
        if (mode === "edited line")
          return [
            file,
            {
              ...input,
              bytes: Buffer.from(
                input.bytes
                  .toString()
                  .split("\n")
                  .map((l) => (l.includes(findings[0].RawV2) ? l + " " : l))
                  .join("\n"),
              ),
            },
          ];
        return [
          file,
          {
            ...input,
            references: input.references.map((r) => ({
              ...r,
              ...(mode === "wrong path"
                ? { source: "src/gateway/server-methods/other.test.ts" }
                : { mode: "100755" }),
            })),
          },
        ];
      }),
    );
    reject(mode, findings, ins);
  }
  reject(
    "second finding differs",
    findings.map((f, i) => (i ? { ...f, RawV2: f.RawV2 + "/unreviewed" } : f)),
  );
  const report = {
    name,
    status: native.status,
    scanner: "3.99.4",
    findings: findings.map((f) => ({
      detector: f.DetectorType,
      decoder: f.DecoderName,
      verified: f.Verified,
      fixtureSha256: hash(f.RawV2),
      line: f.SourceMetadata.Data.Filesystem.line,
      material: inputs.get(f.SourceMetadata.Data.Filesystem.file)?.kind,
    })),
    result,
    negatives,
  };
  summary.push(report);
}
writeFileSync(join(root, "scenarios-result.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  JSON.stringify(
    summary.map(({ name, findings, result, negatives }) => ({
      name,
      findings,
      result: result.kind,
      negativeControls: negatives.length,
    })),
    null,
    2,
  ),
);
