import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyReviewedFixtureScan,
  type ReviewedAttribution,
  type StagedScanInput,
} from "../dist/agent-input-scan-fixtures.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const source = ".grilltrack/events.jsonl";
const uuid = ["12345678", "1234", "4234", "8234", "123456789abc"].join("-");
const line = JSON.stringify({
  action: "decision_reopened",
  at: "2026-10-09T00:00:00+00:00",
  data: { reason: "public privacy decision", affected: [] },
  event_id: uuid,
});

function fixture(t: test.TestContext, change: "add" | "remove" | "context" = "add") {
  const root = mkdtempSync(join(tmpdir(), "reviewed-event-uuid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", devNull);
  mkdirSync(join(root, ".grilltrack"));
  const refs = [0, 1].map((i) => {
    const body = change === "context" || (change === "add") === (i === 1) ? line + "\n" : "";
    writeFileSync(join(root, source), body);
    writeFileSync(join(root, "other"), String(i));
    git("add", ".");
    git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD").toString().trim();
  });
  const [from, to] = refs as [string, string];
  const inputs = new Map<string, StagedScanInput>();
  for (const [i, revision] of refs.entries()) {
    const id = git("rev-parse", `${revision}:${source}`).toString().trim();
    const file = `/scanner/${id}`;
    const previous = inputs.get(file);
    inputs.set(file, {
      kind: "blob",
      id,
      bytes: git("show", `${revision}:${source}`),
      references: [
        ...(previous?.kind === "blob" ? previous.references : []),
        { source, mode: "100644", revision, role: i ? "head" : "base" },
      ],
    });
  }
  inputs.set("/scanner/patch", {
    kind: "patch",
    id: "patch",
    from,
    to,
    bytes: git("diff", "--binary", "--full-index", from, to),
  });
  const policy = [
    [
      938,
      "Privacy",
      "PLAIN",
      hash(uuid),
      hash(""),
      hash(line),
      source,
      "100644",
      [hash(line + "\n")],
    ],
  ] as unknown as ReviewedAttribution[];
  const findings = [...inputs]
    .filter(([, v]) => v.bytes?.includes(uuid))
    .map(([file, v]) => ({
      SourceType: 15,
      DetectorType: 938,
      DetectorName: "Privacy",
      DecoderName: "PLAIN",
      Verified: false,
      Raw: uuid,
      RawV2: "",
      SecretParts: { key: uuid },
      ExtraData: null,
      StructuredData: null,
      SourceMetadata: {
        Data: {
          Filesystem: {
            file,
            line:
              v
                .bytes!.toString()
                .split("\n")
                .findIndex((s) => s.includes(uuid)) + 1,
          },
        },
      },
    }));
  const scan = (rows: Record<string, unknown>[] = findings, policies = policy) =>
    classifyReviewedFixtureScan(
      183,
      Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"),
      Buffer.from(
        JSON.stringify({
          level: "info-0",
          logger: "trufflehog",
          msg: "finished scanning",
          trufflehog_version: "3.97.4",
          chunks: 1,
          bytes: 1,
          verified_secrets: rows.filter((r) => r.Verified === true).length,
          unverified_secrets: rows.filter((r) => r.Verified !== true).length,
        }) + "\n",
      ),
      inputs,
      policies,
    );
  return { inputs, findings, policy, scan };
}

for (const change of ["add", "remove", "context"] as const)
  test(`reviewed event UUID admits exact ${change} blob and patch witnesses`, (t) => {
    const f = fixture(t, change);
    const r = f.scan();
    assert.equal(r.kind, "classified", JSON.stringify(r));
    if (r.kind === "classified")
      assert.ok(r.notices.every((n) => n.detector === "Privacy" && n.source === source));
  });

for (const [name, override] of Object.entries({
  verified: { Verified: true },
  decoder: { DecoderName: "HTML" },
  detector: { DetectorType: 17 },
  name: { DetectorName: "URI" },
  raw: { Raw: uuid.replace("abc", "abd") },
  rawV2: { RawV2: uuid },
  parts: { SecretParts: { key: "other" } },
  extraData: { ExtraData: {} },
  structured: { StructuredData: {} },
  nullError: { VerificationError: null },
}))
  test(`reviewed event UUID rejects changed ${name}`, (t) => {
    const f = fixture(t);
    assert.equal(f.scan(f.findings.map((r) => ({ ...r, ...override }))).kind, "refused");
  });

for (const variant of [
  "line",
  "extra occurrence",
  "path",
  "mode",
  "role",
  "extra reference",
  "blob identity",
] as const)
  test(`reviewed event UUID rejects changed ${variant}`, (t) => {
    const f = fixture(t);
    for (const input of f.inputs.values())
      if (input.kind === "blob" && input.bytes?.includes(uuid)) {
        if (variant === "line") input.bytes = Buffer.from(line.replace("public", "private") + "\n");
        if (variant === "extra occurrence") input.bytes = Buffer.from(line + "\n" + line + "\n");
        if (variant === "blob identity") input.id = "0".repeat(40);
        if (variant === "path") input.references[0]!.source = "other/events.jsonl";
        if (variant === "mode") input.references[0]!.mode = "100755";
        if (variant === "role") input.references[0]!.role = "worktree";
        if (variant === "extra reference")
          input.references.push({ ...input.references[0]!, source: "unreviewed.jsonl" });
      }
    assert.equal(f.scan().kind, "refused");
  });

test("reviewed event UUID rejects an unknown UUID with no policy", (t) => {
  const f = fixture(t);
  assert.equal(f.scan(f.findings, []).kind, "refused");
});

test("reviewed event UUID still refuses a second unknown secret finding", (t) => {
  const f = fixture(t);
  assert.equal(
    f.scan([
      ...f.findings,
      { ...f.findings[0], Raw: "unreviewed-value", SecretParts: { key: "unreviewed-value" } },
    ]).kind,
    "refused",
  );
});

for (const variant of ["path", "source hash", "decoder"] as const)
  test(`reviewed event UUID rejects broadened policy ${variant}`, (t) => {
    const f = fixture(t);
    const row = [...f.policy[0]!];
    if (variant === "path") row[6] = "src/logging/redact.test.ts";
    if (variant === "source hash") row.pop();
    if (variant === "decoder") row[2] = "HTML";
    assert.throws(
      () => f.scan(f.findings, [row as unknown as ReviewedAttribution]),
      /invalid reviewed attribution policy/,
    );
  });
