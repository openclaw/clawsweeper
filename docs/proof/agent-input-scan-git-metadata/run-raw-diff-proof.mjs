import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scanAgentInput } from "../../../dist/agent-input-scan.js";
import {
  ensureManagedTruffleHog,
  TRUFFLEHOG_VERSION,
} from "../../../dist/review-tool-bootstrap.js";

const [output, baseline] = process.argv.slice(2);
if (!output || !baseline)
  throw new Error("Pass output JSON and a built trusted baseline checkout.");
const { scanAgentInput: baselineScan } = await import(
  pathToFileURL(resolve(baseline, "dist/agent-input-scan.js")).href
);
const scanner = await ensureManagedTruffleHog({ timeoutMs: 120_000 });
process.env.PATH = `${dirname(scanner)}${delimiter}${process.env.PATH ?? ""}`;
const root = mkdtempSync(join(tmpdir(), "clawsweeper-raw-metadata-proof-"));
const report = {
  scanner: TRUFFLEHOG_VERSION,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  results: [],
  limits:
    "Controlled Git source and prompt; verification enabled; no model or public mutation. Hosted review must scan its own complete inputs.",
};
try {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull },
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Scanner fixture");
  git("config", "user.email", "scanner@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "cloudflare"));
  const file = join(root, "cloudflare", "scanner@1.2.3");
  writeFileSync(file, "<p>one</p>\n");
  git("add", ".");
  git("commit", "-qm", "fixture base");
  const baseSha = git("rev-parse", "HEAD");
  const objectId = git("hash-object", file);
  writeFileSync(file, "<p>two</p>\n");
  renameSync(file, join(root, "cloudflare", "moved@1.2.3"));
  git("add", ".");
  git("commit", "-qm", "fixture head");
  const headSha = git("rev-parse", "HEAD");
  Object.assign(report, {
    baseSha,
    headSha,
    objectIdSha256: createHash("sha256").update(objectId).digest("hex"),
  });
  const tagSplit = `${objectId.slice(0, 20)}<span></span>${objectId.slice(20)}`;
  const entities = [...objectId].map((char) => `&#x${char.charCodeAt(0).toString(16)};`).join("");
  for (const [name, scan, content] of [
    ["baseline", baselineScan],
    ["candidate", scanAgentInput],
    ["literal-additional", scanAgentInput, `Retained content collision: ${objectId}`],
    ["tag-split-additional", scanAgentInput, `cloudflare <p>${tagSplit} scanner@1.2.3</p>`],
    ["entities-additional", scanAgentInput, `cloudflare <p>${entities} scanner@1.2.3</p>`],
  ]) {
    const notices = [];
    const previous = console.error;
    const started = Date.now();
    const entry = { name, result: "pending", notices };
    try {
      console.error = (value) => notices.push(JSON.parse(String(value)));
      scan({
        cwd: root,
        prompt: "Read-only source review.",
        source: { kind: "committed", baseSha, headSha },
        timeoutMs: 180_000,
        ...(content ? { additionalBytes: [Buffer.from(content)] } : {}),
      });
      entry.result = "admitted";
    } catch (error) {
      entry.result = "refused";
      entry.failure = { reason: error.reason, diagnostic: error.scanDiagnostic };
    } finally {
      console.error = previous;
      entry.elapsedMs = Date.now() - started;
      report.results.push(entry);
    }
    assert.equal(entry.result, name === "candidate" ? "admitted" : "refused", name);
    if (name === "baseline") {
      assert.equal(entry.failure?.diagnostic?.material?.kind, "raw_diff");
      assert.equal(entry.failure?.diagnostic?.detectorType, 58);
    } else if (name === "candidate") {
      assert.ok(
        notices.some((notice) => notice.findings.some((finding) => finding.blob === "0")),
        "native raw-diff finding must exercise the changed admission path",
      );
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
console.log(
  JSON.stringify({
    output: resolve(output),
    results: report.results.map(({ name, result, elapsedMs }) => ({ name, result, elapsedMs })),
  }),
);
