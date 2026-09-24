import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";
import { TRUFFLEHOG_VERSION } from "../dist/review-tool-bootstrap.js";
import { AgentInputScanError, scanAgentInput } from "../dist/agent-input-scan.js";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";

const reviewedUri = "https://fixture-user:fixture-password@example.invalid";
const reviewedUriLines = [`      "${reviewedUri}/",`, `      { "${reviewedUri}/": "route" },`];
const reviewedUriSource = "ui/src/pages/custodian/custodian-session-store.test.ts";

function fixture(withUri = false, mode: "100644" | "100755" | "120000" = "100644") {
  const from = "a".repeat(40);
  const to = "b".repeat(40);
  const source = withUri ? reviewedUriSource : "scripts/cloudflare/Dockerfile";
  const beforeLine = withUri ? "// before" : "FROM example:1";
  const afterLine = withUri ? "// after" : "FROM example:2";
  const context = withUri ? reviewedUriLines : [];
  const before = Buffer.from([beforeLine, ...context, ""].join("\n"));
  const after = Buffer.from([afterLine, ...context, ""].join("\n"));
  const oid = (bytes: Buffer) =>
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const oldId = oid(before);
  const newId = oid(after);
  const file = "/private/scanner/patch";
  const patch = [
    `diff --git a/${source} b/${source}`,
    `index ${oldId}..${newId} ${mode}`,
    `--- a/${source}`,
    `+++ b/${source}`,
    withUri ? "@@ -1,3 +1,3 @@" : "@@ -1 +1 @@",
    `-${beforeLine}`,
    `+${afterLine}`,
    ...context.map((line) => ` ${line}`),
    "",
  ].join("\n");
  const inputs = new Map<string, StagedScanInput>([
    [file, { kind: "patch", id: "patch", bytes: Buffer.from(patch), from, to }],
    [
      "/private/scanner/raw",
      {
        kind: "raw_diff",
        id: "raw",
        bytes: Buffer.from(`:${mode} ${mode} ${oldId} ${newId} M\0${source}\0`),
        from,
        to,
      },
    ],
    [
      "/private/scanner/prompt",
      { kind: "prompt", id: "prompt", bytes: Buffer.from("Review dependencies.") },
    ],
    ...(
      [
        [oldId, before, from, "base"],
        [newId, after, to, "head"],
      ] as const
    ).map(([id, bytes, revision, role]): [string, StagedScanInput] => [
      `/private/scanner/${id}`,
      { kind: "blob", id, bytes, references: [{ source, mode, revision, role }] },
    ]),
  ]);
  const email = "scan@example.invalid";
  const finding: Record<string, unknown> = {
    DetectorType: 58,
    DetectorName: "CloudflareGlobalApiKey",
    DecoderName: "PLAIN",
    SourceType: 15,
    Verified: false,
    VerificationError: "synthetic unavailable verifier",
    Raw: oldId,
    RawV2: oldId + email,
    Redacted: email,
    SecretParts: { key: oldId, email },
    ExtraData: null,
    StructuredData: null,
    SourceMetadata: { Data: { Filesystem: { file, line: 2 } } },
  };
  const uriFinding = {
    ...finding,
    DetectorType: 17,
    DetectorName: "URI",
    Raw: reviewedUri,
    RawV2: reviewedUri,
    Redacted: "",
    SecretParts: {
      host: "example.invalid",
      username: "fixture-user",
      password: "fixture-password",
    },
    SourceMetadata: { Data: { Filesystem: { file, line: 8 } } },
  };
  return { finding, uriFinding, inputs, file, oldId, newId, source, from, to, mode };
}

function classify(
  findings: Record<string, unknown>[],
  inputs: Map<string, StagedScanInput>,
  failed = false,
) {
  const completion = {
    level: "info-0",
    logger: "trufflehog",
    msg: "finished scanning",
    trufflehog_version: TRUFFLEHOG_VERSION,
    chunks: 1,
    bytes: 1,
    verified_secrets: findings.filter((finding) => finding.Verified === true).length,
    unverified_secrets: findings.filter((finding) => finding.Verified !== true).length,
    ...(failed ? { error: "synthetic detector failure" } : {}),
  };
  return classifyReviewedFixtureScan(
    183,
    Buffer.from(findings.map((row) => JSON.stringify(row)).join("\n") + "\n"),
    Buffer.from(JSON.stringify(completion) + "\n"),
    inputs,
  );
}

function rawMetadataFixture(change: "M" | "A" | "D", mode: "100644" | "100755" = "100644") {
  const f = fixture(false, mode);
  const rawFile = "/private/scanner/raw";
  const zero = "0".repeat(40);
  if (change !== "M") {
    const added = change === "A";
    const oldId = added ? zero : f.oldId;
    const newId = added ? f.newId : zero;
    f.inputs.delete(`/private/scanner/${added ? f.oldId : f.newId}`);
    f.inputs.set(rawFile, {
      kind: "raw_diff",
      id: "raw",
      from: f.from,
      to: f.to,
      bytes: Buffer.from(
        `:${added ? `000000 ${mode}` : `${mode} 000000`} ${oldId} ${newId} ${change}\0${f.source}\0`,
      ),
    });
    f.inputs.set(f.file, {
      kind: "patch",
      id: "patch",
      from: f.from,
      to: f.to,
      bytes: Buffer.from(
        [
          `diff --git a/${f.source} b/${f.source}`,
          `${added ? "new" : "deleted"} file mode ${mode}`,
          `index ${oldId}..${newId}`,
          added ? "--- /dev/null" : `--- a/${f.source}`,
          added ? `+++ b/${f.source}` : "+++ /dev/null",
          added ? "@@ -0,0 +1 @@" : "@@ -1 +0,0 @@",
          added ? "+FROM example:2" : "-FROM example:1",
          "",
        ].join("\n"),
      ),
    });
  }
  const key = change === "A" ? f.newId : f.oldId;
  const email = "vitest@5.0.1.patch";
  return {
    ...f,
    rawFile,
    key,
    finding: {
      ...f.finding,
      Raw: key,
      RawV2: key + email,
      Redacted: email,
      SecretParts: { key, email },
      SourceMetadata: { Data: { Filesystem: { file: rawFile, line: 1 } } },
    },
  };
}

test("Git object metadata in raw diffs requires header-only replay for modified, added, and deleted files", () => {
  for (const change of ["M", "A", "D"] as const) {
    const f = rawMetadataFixture(change);
    const original = Buffer.from(f.inputs.get(f.rawFile)!.bytes!);
    const result = classify([f.finding], f.inputs);
    assert.equal(result.kind, "git_metadata_proof_required", change);
    if (result.kind !== "git_metadata_proof_required") throw new Error("expected metadata proof");
    assert.deepEqual(
      result.proofInputs.get(f.rawFile),
      Buffer.from(original.toString().replaceAll(f.key, "_".repeat(f.key.length))),
    );
    assert.deepEqual(f.inputs.get(f.rawFile)!.bytes, original);
    assert.equal(result.notices[0]?.source, f.source);
    assert.equal(result.notices[0]?.findings[0]?.literalLine, 1);
  }
});

test("Git object metadata raw diffs reject ambiguous records and unproven absent endpoints", () => {
  type Fixture = ReturnType<typeof rawMetadataFixture>;
  const cases: Array<[string, (f: Fixture) => void]> = [
    [
      "duplicate raw record",
      (f) => {
        const raw = f.inputs.get(f.rawFile)!;
        raw.bytes = Buffer.concat([raw.bytes!, raw.bytes!]);
      },
    ],
    [
      "invalid unrelated raw record",
      (f) => {
        const raw = f.inputs.get(f.rawFile)!;
        raw.bytes = Buffer.concat([raw.bytes!, Buffer.from("invalid\0other.txt\0")]);
      },
    ],
    [
      "missing patch",
      (f) => {
        f.inputs.delete(f.file);
      },
    ],
    [
      "wrong reported line",
      (f) => {
        f.finding.SourceMetadata.Data.Filesystem.line = 2;
      },
    ],
    [
      "unexpected file mode",
      (f) => {
        const raw = f.inputs.get(f.rawFile)!;
        raw.bytes = Buffer.from(raw.bytes!.toString().replace("100644", "100755"));
      },
    ],
    [
      "missing raw terminator",
      (f) => {
        const raw = f.inputs.get(f.rawFile)!;
        raw.bytes = raw.bytes!.subarray(0, -1);
      },
    ],
  ];
  for (const change of ["M", "A", "D"] as const) {
    for (const [name, mutate] of cases) {
      const f = rawMetadataFixture(change);
      mutate(f);
      assert.equal(classify([f.finding], f.inputs).kind, "refused", `${change}: ${name}`);
    }
    if (change !== "M") {
      const f = rawMetadataFixture(change);
      f.inputs.set("/private/scanner/unexpected-endpoint", {
        kind: "blob",
        id: "unexpected-endpoint",
        bytes: Buffer.from("unexpected"),
        references: [
          {
            source: f.source,
            mode: "100644",
            revision: change === "A" ? f.from : f.to,
            role: change === "A" ? "base" : "head",
          },
        ],
      });
      assert.equal(classify([f.finding], f.inputs).kind, "refused", `${change}: false absence`);
    }
  }
});

test("Git object metadata findings require full canonical patch, raw diff, and blob witnesses", () => {
  for (const mode of ["100644", "100755"] as const) {
    const f = fixture(false, mode);
    for (const decoder of ["PLAIN", "HTML"]) {
      for (const material of ["patch", "raw_diff"]) {
        const finding = {
          ...f.finding,
          DecoderName: decoder,
          SourceMetadata: {
            Data: {
              Filesystem: {
                file: material === "patch" ? f.file : "/private/scanner/raw",
                line: material === "patch" ? 2 : 1,
              },
            },
          },
        };
        const result = classify([finding], f.inputs);
        assert.equal(
          result.kind,
          "git_metadata_proof_required",
          `${mode}: ${material}: ${decoder}`,
        );
        if (result.kind === "git_metadata_proof_required") {
          assert.equal(result.notices.length, 1);
          assert.equal(result.notices[0]?.source, f.source);
          assert.equal(
            JSON.stringify(result).includes(f.oldId),
            false,
            "matched bytes are never emitted",
          );
        }
      }
    }
  }
});

test("executable metadata support does not qualify symlinks, executable creation/deletion, or URI content", () => {
  const symlink = fixture(false, "120000");
  assert.equal(classify([symlink.finding], symlink.inputs).kind, "refused");
  for (const change of ["A", "D"] as const) {
    const f = rawMetadataFixture(change, "100755");
    assert.equal(classify([f.finding], f.inputs).kind, "refused", change);
  }
  const executableUri = fixture(true, "100755");
  assert.equal(classify([executableUri.uriFinding], executableUri.inputs).kind, "refused");
});

test("Git object metadata never clears content occurrences or incomplete provenance", () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ...(["prompt", "schema", "additional", "worktree", "blob"] as const).map(
      (kind): [string, (f: ReturnType<typeof fixture>) => void] => [
        kind,
        (f) => {
          const bytes = Buffer.from(`cloudflare key=${f.oldId}`);
          f.inputs.set(
            "/private/scanner/other",
            kind === "blob" || kind === "worktree"
              ? { kind, id: "other", bytes, references: [] }
              : { kind, id: "other", bytes },
          );
        },
      ],
    ),
    [
      "missing input bytes",
      (f) => f.inputs.set("/private/scanner/prompt", { kind: "prompt", id: "prompt" }),
    ],
    [
      "missing raw diff",
      (f) => {
        f.inputs.delete("/private/scanner/raw");
      },
    ],
    [
      "wrong raw endpoint",
      (f) =>
        f.inputs.set("/private/scanner/raw", {
          ...f.inputs.get("/private/scanner/raw")!,
          kind: "raw_diff",
          from: "c".repeat(40),
          to: f.to,
        }),
    ],
    [
      "wrong raw path",
      (f) => {
        const input = f.inputs.get("/private/scanner/raw")!;
        f.inputs.set("/private/scanner/raw", {
          ...input,
          bytes: Buffer.from(input.bytes!.toString().replace(f.source, "other.txt")),
        });
      },
    ],
    [
      "OID inside raw path",
      (f) => {
        const input = f.inputs.get("/private/scanner/raw")!;
        f.inputs.set("/private/scanner/raw", {
          ...input,
          bytes: Buffer.from(input.bytes!.toString().replace(f.source, f.oldId)),
        });
      },
    ],
    [
      "raw mode mismatch",
      (f) => {
        const raw = f.inputs.get("/private/scanner/raw")!;
        const other = f.mode === "100644" ? "100755" : "100644";
        raw.bytes = Buffer.from(raw.bytes!.toString().replace(`:${f.mode}`, `:${other}`));
      },
    ],
    [
      "patch mode mismatch",
      (f) => {
        const patch = f.inputs.get(f.file)!;
        const other = f.mode === "100644" ? "100755" : "100644";
        patch.bytes = Buffer.from(patch.bytes!.toString().replace(` ${f.mode}\n`, ` ${other}\n`));
      },
    ],
    [
      "blob mode mismatch",
      (f) => {
        const blob = f.inputs.get(`/private/scanner/${f.oldId}`)!;
        assert.equal(blob.kind, "blob");
        if (blob.kind !== "blob") throw new Error("expected blob");
        blob.references[0]!.mode = f.mode === "100644" ? "100755" : "100644";
      },
    ],
    [
      "missing blob",
      (f) => {
        f.inputs.delete(`/private/scanner/${f.newId}`);
      },
    ],
    [
      "corrupt blob",
      (f) => {
        const key = `/private/scanner/${f.newId}`;
        f.inputs.set(key, { ...f.inputs.get(key)!, bytes: Buffer.from("changed bytes") });
      },
    ],
    [
      "uncommitted blob",
      (f) => {
        const key = `/private/scanner/${f.oldId}`;
        f.inputs.set(key, {
          ...f.inputs.get(key)!,
          kind: "blob",
          references: [{ source: f.source, mode: f.mode, revision: f.from, role: "index" }],
        });
      },
    ],
    [
      "missing blob reference",
      (f) => {
        const key = `/private/scanner/${f.oldId}`;
        f.inputs.set(key, { ...f.inputs.get(key)!, kind: "blob", references: [] });
      },
    ],
    ...["+credential=", " credential=", "-credential=", "@@ credential=", "diff --git a/"].map(
      (prefix): [string, (f: ReturnType<typeof fixture>) => void] => [
        prefix,
        (f) => {
          const input = f.inputs.get(f.file)!;
          f.inputs.set(f.file, {
            ...input,
            bytes: Buffer.concat([input.bytes!, Buffer.from(`${prefix}${f.oldId}\n`)]),
          });
        },
      ],
    ),
    [
      "mismatched patch path",
      (f) => {
        const input = f.inputs.get(f.file)!;
        f.inputs.set(f.file, {
          ...input,
          bytes: Buffer.from(
            input.bytes!.toString().replace(`+++ b/${f.source}`, "+++ b/other.txt"),
          ),
        });
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    for (const mode of ["100644", "100755"] as const) {
      for (const material of ["patch", "raw_diff"]) {
        const f = fixture(false, mode);
        mutate(f);
        const finding =
          material === "patch"
            ? f.finding
            : {
                ...f.finding,
                SourceMetadata: { Data: { Filesystem: { file: "/private/scanner/raw", line: 1 } } },
              };
        assert.equal(
          classify([finding], f.inputs).kind,
          "refused",
          `${mode}: ${material}: ${name}`,
        );
      }
    }
  }
});

test("Git object metadata keeps verified, unknown-contract, and failed native scans closed", () => {
  const f = fixture();
  for (const change of [
    { Verified: true },
    { VerificationError: null },
    { DetectorType: 17 },
    { DetectorName: "Other" },
    { DecoderName: "BASE64" },
    { SourceType: 1 },
    { RawV2: "other" },
    { Raw: f.oldId.slice(0, 39) },
    { ExtraData: {} },
    { StructuredData: {} },
    { SecretParts: { key: f.oldId, email: "other" } },
    { SourceMetadata: { Data: { Filesystem: { file: "/private/scanner/prompt", line: 1 } } } },
  ])
    assert.equal(
      classify([{ ...f.finding, ...change }], f.inputs).kind,
      "refused",
      JSON.stringify(Object.keys(change)),
    );
  assert.equal(classify([f.finding], f.inputs, true).kind, "refused");
  assert.equal(classify([f.finding, { ...f.finding, DetectorType: 17 }], f.inputs).kind, "refused");
});

for (const material of ["patch", "raw_diff"] as const) {
  for (const outcome of [
    "clean",
    "decoded-content",
    "verified",
    "incomplete",
    "scan-error",
  ] as const) {
    test(`metadata admission requires a complete supplemental scan: ${material} ${outcome}`, (t) => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-metadata-owner-test-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const cwd = join(root, "target");
      mkdirSync(cwd);
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      git("init", "-q");
      git("config", "user.name", "Scanner fixture");
      git("config", "user.email", "scanner@example.invalid");
      git("config", "commit.gpgsign", "false");
      writeFileSync(join(cwd, "cloudflare.txt"), "before\n");
      git("add", ".");
      const mode = material === "raw_diff" ? "100755" : "100644";
      if (mode === "100755") git("update-index", "--chmod=+x", "cloudflare.txt");
      git("commit", "-qm", "fixture base");
      const baseSha = git("rev-parse", "HEAD");
      const key = git("hash-object", "cloudflare.txt");
      writeFileSync(join(cwd, "cloudflare.txt"), "after\n");
      git("add", ".");
      if (mode === "100755") git("update-index", "--chmod=+x", "cloudflare.txt");
      git("commit", "-qm", "fixture head");
      const headSha = git("rev-parse", "HEAD");
      const calls = join(root, "calls");
      const original = join(root, "original.patch");
      useFakeScanner(
        t,
        `
const key = ${JSON.stringify(key)};
const outcome = ${JSON.stringify(outcome)};
const material = ${JSON.stringify(material)};
const primary = inputs.some(input => input.name === 'prompt');
fs.appendFileSync(${JSON.stringify(calls)}, primary ? 'primary\\n' : 'supplemental\\n');
const metadata = inputs.find(input => input.bytes.toString().startsWith(material === 'patch' ? 'diff --git ' : ':${mode}'));
assert.ok(metadata);
if (primary) {
  assert.ok(metadata.bytes.includes(Buffer.from(key)));
  assert.ok(inputs.some(input => input.bytes.toString().startsWith('diff --git ')));
  assert.ok(inputs.some(input => input.bytes.toString().startsWith(':${mode}')));
  assert.ok(inputs.some(input => input.bytes.toString() === 'before\\n'));
  assert.ok(inputs.some(input => input.bytes.toString() === 'after\\n'));
  fs.writeFileSync(${JSON.stringify(original)}, metadata.bytes);
} else {
  assert.equal(inputs.length, 1);
  const before = fs.readFileSync(${JSON.stringify(original)}, 'utf8');
  assert.equal(metadata.bytes.toString(), before.replace(key, '_'.repeat(key.length)));
}
const finding = primary || outcome === 'decoded-content' || outcome === 'verified';
const verified = !primary && outcome === 'verified';
if (finding) console.log(JSON.stringify({
  DetectorType:58, DetectorName:'CloudflareGlobalApiKey', DecoderName:primary ? 'PLAIN' : 'HTML',
  SourceType:15, Verified:verified, VerificationError:verified ? null : 'synthetic unavailable verifier',
  Raw:key, RawV2:key+'scanner@1.2.3', Redacted:'scanner@1.2.3', SecretParts:{key,email:'scanner@1.2.3'}, ExtraData:null, StructuredData:null,
  SourceMetadata:{Data:{Filesystem:{file:path.join(inputDir,metadata.name),line:material === 'raw_diff' ? 1 : primary ? 2 : 10}}}
}));
if (primary || outcome !== 'incomplete') console.error(JSON.stringify({
  level:'info-0',logger:'trufflehog',msg:'finished scanning',trufflehog_version:'${TRUFFLEHOG_VERSION}',
  chunks:1,bytes:metadata.bytes.length,verified_secrets:verified ? 1 : 0,unverified_secrets:finding && !verified ? 1 : 0,
  ...(!primary && outcome === 'scan-error' ? {error:'synthetic scan failure'} : {})
}));
process.exit(finding ? 183 : 0);
`,
      );
      const notices: unknown[] = [];
      t.mock.method(console, "error", (value: unknown) => notices.push(value));
      const scan = () =>
        scanAgentInput({
          cwd,
          prompt: "Review dependencies.",
          source: { kind: "committed", baseSha, headSha },
          timeoutMs: 30_000,
        });
      if (outcome === "clean") {
        scan();
        assert.equal(notices.length, 1);
      } else {
        assert.throws(
          scan,
          (error: unknown) =>
            error instanceof AgentInputScanError &&
            error.reason ===
              (outcome === "incomplete" || outcome === "scan-error"
                ? "scanner_failed"
                : "findings"),
        );
        assert.deepEqual(notices, []);
      }
      assert.equal(readFileSync(calls, "utf8"), "primary\nsupplemental\n");
    });
  }
}

function supplementalFixture() {
  const f = fixture(true);
  const primary = classify([f.finding, f.uriFinding], f.inputs);
  assert.equal(primary.kind, "git_metadata_proof_required");
  if (primary.kind !== "git_metadata_proof_required") throw new Error("expected metadata proof");
  const original = f.inputs.get(f.file)!;
  const bytes = primary.proofInputs.get(f.file)!;
  const proofFile = "/private/metadata-proof/patch";
  const proof = {
    kind: "patch" as const,
    id: original.id,
    from: f.from,
    to: f.to,
    bytes: Buffer.from(bytes),
    metadataProof: { file: proofFile, originalFile: f.file, original, bytes: Buffer.from(bytes) },
  };
  f.inputs.set(proofFile, proof);
  const finding = {
    ...f.uriFinding,
    SourceMetadata: { Data: { Filesystem: { file: proofFile, line: 8 } } },
  };
  return { ...f, proofFile, proof, original, finding };
}

test("metadata replay retains original URI witnesses in either primary detector order", () => {
  for (const uriFirst of [false, true]) {
    const f = fixture(true);
    const findings = uriFirst ? [f.uriFinding, f.finding] : [f.finding, f.uriFinding];
    assert.equal(classify(findings, f.inputs).kind, "git_metadata_proof_required");
  }
  const f = supplementalFixture();
  const masked = Buffer.from(f.proof.bytes);
  assert.equal(classify([f.finding], f.inputs).kind, "classified");
  assert.deepEqual(f.proof.bytes, masked);
  assert.equal(f.proof.bytes.includes(Buffer.from(f.oldId)), false);
  assert.equal(f.original.bytes!.includes(Buffer.from(f.oldId)), true);
});

test("metadata replay rejects stale, unrelated, or altered original-patch associations", () => {
  type Fixture = ReturnType<typeof supplementalFixture>;
  const cases: Array<[string, (f: Fixture) => void]> = [
    [
      "missing original",
      (f) => {
        f.inputs.delete(f.file);
      },
    ],
    [
      "replaced original identity",
      (f) => {
        f.inputs.set(f.file, { ...f.original });
      },
    ],
    [
      "wrong original path",
      (f) => {
        f.proof.metadataProof.originalFile = "/private/other";
      },
    ],
    [
      "wrong proof path",
      (f) => {
        f.proof.metadataProof.file = "/private/other";
      },
    ],
    [
      "same proof/original path",
      (f) => {
        f.proof.metadataProof.file = f.file;
      },
    ],
    [
      "wrong proof id",
      (f) => {
        f.proof.id = "other";
      },
    ],
    [
      "wrong base",
      (f) => {
        f.proof.from = "c".repeat(40);
      },
    ],
    [
      "wrong head",
      (f) => {
        f.proof.to = "c".repeat(40);
      },
    ],
    [
      "missing original bytes",
      (f) => {
        f.original.bytes = undefined;
      },
    ],
    [
      "wrong original kind",
      (f) => {
        Object.assign(f.original, { kind: "raw_diff" });
      },
    ],
    [
      "nested proof",
      (f) => {
        Object.assign(f.original, { metadataProof: f.proof.metadataProof });
      },
    ],
    [
      "changed hunk",
      (f) => {
        f.proof.bytes = Buffer.from(f.proof.bytes.toString().replace("+// after", "+// other"));
      },
    ],
    [
      "changed expected proof",
      (f) => {
        f.proof.metadataProof.bytes = Buffer.from("other");
      },
    ],
    [
      "changed original hunk",
      (f) => {
        f.original.bytes = Buffer.from(
          f.original.bytes!.toString().replace("+// after", "+// other"),
        );
      },
    ],
    [
      "missing original blob",
      (f) => {
        f.inputs.delete(`/private/scanner/${f.newId}`);
      },
    ],
    [
      "no association",
      (f) => {
        Reflect.deleteProperty(f.proof, "metadataProof");
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const f = supplementalFixture();
    mutate(f);
    assert.equal(classify([f.finding], f.inputs).kind, "refused", name);
  }
});

test("metadata replay still rejects unknown, verified, residual, and incomplete findings", () => {
  const f = supplementalFixture();
  for (const change of [
    { Verified: true, VerificationError: null },
    { Raw: "unreviewed", RawV2: "https://other:unknown@example.invalid" },
    { DecoderName: "BASE64" },
    {
      ...fixture().finding,
      SourceMetadata: { Data: { Filesystem: { file: f.proofFile, line: 2 } } },
    },
  ]) {
    assert.equal(classify([{ ...f.finding, ...change }], f.inputs).kind, "refused");
  }
  assert.equal(classify([f.finding], f.inputs, true).kind, "refused");
  assert.equal(
    classifyReviewedFixtureScan(
      183,
      Buffer.from(JSON.stringify(f.finding)),
      Buffer.alloc(0),
      f.inputs,
    ).kind,
    "refused",
  );
});

for (const uriFirst of [false, true]) {
  for (const outcome of ["reviewed", "unknown", "verified"] as const) {
    test(`metadata owner replays same-patch URI: ${outcome}, URI first=${uriFirst}`, (t) => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-mixed-owner-test-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const cwd = join(root, "target");
      mkdirSync(join(cwd, "ui/src/pages/custodian"), { recursive: true });
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      git("init", "-q");
      git("config", "user.name", "Scanner fixture");
      git("config", "user.email", "scanner@example.invalid");
      git("config", "commit.gpgsign", "false");
      const before = ["// before", ...reviewedUriLines, ""].join("\n");
      const after = ["// after", ...reviewedUriLines, ""].join("\n");
      writeFileSync(join(cwd, reviewedUriSource), before);
      git("add", ".");
      git("commit", "-qm", "fixture base");
      const baseSha = git("rev-parse", "HEAD");
      const key = git("hash-object", reviewedUriSource);
      writeFileSync(join(cwd, reviewedUriSource), after);
      git("add", ".");
      git("commit", "-qm", "fixture head");
      const headSha = git("rev-parse", "HEAD");
      const calls = join(root, "calls");
      const original = join(root, "original.patch");
      useFakeScanner(
        t,
        `
const key = ${JSON.stringify(key)};
const outcome = ${JSON.stringify(outcome)};
const uriFirst = ${uriFirst};
const primary = inputs.some(input => input.name === 'prompt');
fs.appendFileSync(${JSON.stringify(calls)}, primary ? 'primary\\n' : 'supplemental\\n');
const patch = inputs.find(input => input.bytes.toString().startsWith('diff --git '));
assert.ok(patch);
if (primary) {
  assert.ok(inputs.some(input => input.bytes.toString() === ${JSON.stringify(before)}));
  assert.ok(inputs.some(input => input.bytes.toString() === ${JSON.stringify(after)}));
  assert.ok(inputs.some(input => input.bytes.toString().startsWith(':100644')));
  fs.writeFileSync(${JSON.stringify(original)}, patch.bytes);
} else {
  assert.equal(inputs.length, 1);
  const original = fs.readFileSync(${JSON.stringify(original)}, 'utf8');
  assert.equal(patch.bytes.toString(), original.replace(key, '_'.repeat(key.length)));
}
const metadata = {
  DetectorType:58, DetectorName:'CloudflareGlobalApiKey', DecoderName:'PLAIN',
  SourceType:15, Verified:false, VerificationError:'synthetic unavailable verifier',
  Raw:key, RawV2:key+'scanner@1.2.3', Redacted:'scanner@1.2.3',
  SecretParts:{key,email:'scanner@1.2.3'}, ExtraData:null, StructuredData:null,
  SourceMetadata:{Data:{Filesystem:{file:path.join(inputDir,patch.name),line:2}}}
};
const uri = {
  ...metadata, DetectorType:17, DetectorName:'URI', DecoderName:primary ? 'PLAIN' : 'HTML',
  Raw:${JSON.stringify(reviewedUri)}, RawV2:${JSON.stringify(reviewedUri)}, Redacted:'',
  SecretParts:{host:'example.invalid',username:'fixture-user',password:'fixture-password'},
  SourceMetadata:{Data:{Filesystem:{file:path.join(inputDir,patch.name),line:8}}}
};
if (!primary && outcome === 'unknown') uri.Raw = uri.RawV2 = 'https://other:unknown@example.invalid';
if (!primary && outcome === 'verified') {
  uri.Verified = true;
  uri.VerificationError = null;
}
const findings = primary ? (uriFirst ? [uri,metadata] : [metadata,uri]) : [uri];
for (const finding of findings) console.log(JSON.stringify(finding));
console.error(JSON.stringify({
  level:'info-0',logger:'trufflehog',msg:'finished scanning',trufflehog_version:'${TRUFFLEHOG_VERSION}',
  chunks:1,bytes:patch.bytes.length,verified_secrets:findings.filter(x => x.Verified).length,
  unverified_secrets:findings.filter(x => !x.Verified).length
}));
process.exit(183);
`,
      );
      const notices: unknown[] = [];
      t.mock.method(console, "error", (value: unknown) => notices.push(value));
      const scan = () =>
        scanAgentInput({
          cwd,
          prompt: "Review dependencies.",
          source: { kind: "committed", baseSha, headSha },
          timeoutMs: 30_000,
        });
      if (outcome === "reviewed") {
        scan();
        assert.equal(notices.length, 2);
      } else {
        assert.throws(
          scan,
          (error: unknown) => error instanceof AgentInputScanError && error.reason === "findings",
        );
        assert.deepEqual(notices, []);
      }
      assert.equal(readFileSync(calls, "utf8"), "primary\nsupplemental\n");
    });
  }
}
