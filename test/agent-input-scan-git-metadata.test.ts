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

function fixture() {
  const from = "a".repeat(40);
  const to = "b".repeat(40);
  const source = "scripts/cloudflare/Dockerfile";
  const before = Buffer.from("FROM example:1\n");
  const after = Buffer.from("FROM example:2\n");
  const oid = (bytes: Buffer) =>
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const oldId = oid(before);
  const newId = oid(after);
  const file = "/private/scanner/patch";
  const patch = [
    `diff --git a/${source} b/${source}`,
    `index ${oldId}..${newId} 100644`,
    `--- a/${source}`,
    `+++ b/${source}`,
    "@@ -1 +1 @@",
    "-FROM example:1",
    "+FROM example:2",
    "",
  ].join("\n");
  const inputs = new Map<string, StagedScanInput>([
    [file, { kind: "patch", id: "patch", bytes: Buffer.from(patch), from, to }],
    [
      "/private/scanner/raw",
      {
        kind: "raw_diff",
        id: "raw",
        bytes: Buffer.from(`:100644 100644 ${oldId} ${newId} M\0${source}\0`),
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
      { kind: "blob", id, bytes, references: [{ source, mode: "100644", revision, role }] },
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
  return { finding, inputs, file, oldId, newId, source, from, to };
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

test("Git object metadata findings require full canonical patch, raw diff, and blob witnesses", () => {
  const f = fixture();
  for (const decoder of ["PLAIN", "HTML"]) {
    const result = classify([{ ...f.finding, DecoderName: decoder }], f.inputs);
    assert.equal(result.kind, "git_metadata_proof_required", decoder);
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
          references: [{ source: f.source, mode: "100644", revision: f.from, role: "index" }],
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
    const f = fixture();
    mutate(f);
    assert.equal(classify([f.finding], f.inputs).kind, "refused", name);
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

for (const outcome of [
  "clean",
  "decoded-content",
  "verified",
  "incomplete",
  "scan-error",
] as const) {
  test(`metadata admission requires a complete supplemental scan: ${outcome}`, (t) => {
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
    git("commit", "-qm", "fixture base");
    const baseSha = git("rev-parse", "HEAD");
    const key = git("hash-object", "cloudflare.txt");
    writeFileSync(join(cwd, "cloudflare.txt"), "after\n");
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
const primary = inputs.some(input => input.name === 'prompt');
fs.appendFileSync(${JSON.stringify(calls)}, primary ? 'primary\\n' : 'supplemental\\n');
const patch = inputs.find(input => input.bytes.toString().startsWith('diff --git '));
assert.ok(patch);
if (primary) {
  assert.ok(patch.bytes.includes(Buffer.from(key)));
  assert.ok(inputs.some(input => input.bytes.toString().startsWith(':100644')));
  assert.ok(inputs.some(input => input.bytes.toString() === 'before\\n'));
  assert.ok(inputs.some(input => input.bytes.toString() === 'after\\n'));
  fs.writeFileSync(${JSON.stringify(original)}, patch.bytes);
} else {
  assert.equal(inputs.length, 1);
  const before = fs.readFileSync(${JSON.stringify(original)}, 'utf8');
  assert.equal(patch.bytes.toString(), before.replace(key, '_'.repeat(key.length)));
}
const finding = primary || outcome === 'decoded-content' || outcome === 'verified';
const verified = !primary && outcome === 'verified';
if (finding) console.log(JSON.stringify({
  DetectorType:58, DetectorName:'CloudflareGlobalApiKey', DecoderName:primary ? 'PLAIN' : 'HTML',
  SourceType:15, Verified:verified, VerificationError:verified ? null : 'synthetic unavailable verifier',
  Raw:key, RawV2:key+'scanner@1.2.3', Redacted:'scanner@1.2.3', SecretParts:{key,email:'scanner@1.2.3'}, ExtraData:null, StructuredData:null,
  SourceMetadata:{Data:{Filesystem:{file:path.join(inputDir,patch.name),line:primary ? 2 : 10}}}
}));
if (primary || outcome !== 'incomplete') console.error(JSON.stringify({
  level:'info-0',logger:'trufflehog',msg:'finished scanning',trufflehog_version:'${TRUFFLEHOG_VERSION}',
  chunks:1,bytes:patch.bytes.length,verified_secrets:verified ? 1 : 0,unverified_secrets:finding && !verified ? 1 : 0,
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
            (outcome === "incomplete" || outcome === "scan-error" ? "scanner_failed" : "findings"),
      );
      assert.deepEqual(notices, []);
    }
    assert.equal(readFileSync(calls, "utf8"), "primary\nsupplemental\n");
  });
}
