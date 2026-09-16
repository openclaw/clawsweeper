import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanAgentInput } from "../../../dist/agent-input-scan.js";
import { TRUFFLEHOG_VERSION } from "../../../dist/review-tool-bootstrap.js";

const [output, target, baseSha, headSha] = process.argv.slice(2);
if (!output || (target && (!baseSha || !headSha)))
  throw new Error(
    "Pass output JSON, optionally followed by target checkout, base SHA, and head SHA.",
  );
const cases = [];
const report = {
  scanner: TRUFFLEHOG_VERSION,
  cases,
  limits:
    "Controlled source and prompt; no model execution. Hosted review must scan its own complete inputs.",
};
function scan(name, cwd, base, head, additionalBytes) {
  const entry = { name, result: "pending", notices: [] };
  const previous = console.error;
  try {
    console.error = (value) => {
      const notice = JSON.parse(String(value));
      if (notice.event !== "agent_input_scan_classified")
        throw new Error("Unexpected scan notice.");
      entry.notices.push(notice);
    };
    scanAgentInput({
      cwd,
      prompt: "Read-only dependency source review.",
      source: { kind: "committed", baseSha: base, headSha: head },
      timeoutMs: 180_000,
      ...(additionalBytes ? { additionalBytes } : {}),
    });
    entry.result = "admitted";
  } catch (error) {
    entry.result = "refused";
    entry.failure = { reason: error.reason, diagnostic: error.scanDiagnostic };
  } finally {
    console.error = previous;
    cases.push(entry);
  }
  return entry;
}
try {
  if (target) {
    const entry = scan("original-source-range", resolve(target), baseSha, headSha);
    entry.base = baseSha;
    entry.head = headSha;
    if (entry.result !== "admitted") process.exitCode = 1;
  }
  for (const form of [
    "metadata",
    "tag-split",
    "hex-entity",
    "decimal-entity",
    "url-attribute",
    "zero-width",
    "additional-copy",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-git-metadata-proof-"));
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
      const file = join(root, "cloudflare", "x");
      writeFileSync(file, "<p>one</p>\n");
      git("add", ".");
      git("commit", "-qm", "fixture base");
      const base = git("rev-parse", "HEAD");
      const oid = git("hash-object", "cloudflare/x");
      const encodings = {
        "tag-split": oid.slice(0, 20) + "<span></span>" + oid.slice(20),
        "hex-entity": [...oid].map((char) => `&#x${char.charCodeAt(0).toString(16)};`).join(""),
        "decimal-entity": [...oid].map((char) => `&#${char.charCodeAt(0)};`).join(""),
        "zero-width": oid.slice(0, 20) + "\u200B" + oid.slice(20),
      };
      const content =
        form === "url-attribute"
          ? `<p title="${[...oid].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("")}">scanner@1.2.3</p>\n`
          : `<p>${encodings[form] ?? "two"} scanner@1.2.3</p>\n`;
      writeFileSync(file, content);
      git("add", ".");
      git("commit", "-qm", "fixture content");
      const head = git("rev-parse", "HEAD");
      const entry = scan(
        form,
        root,
        base,
        head,
        form === "additional-copy"
          ? [Buffer.from(`Synthetic content collision: ${oid}`)]
          : undefined,
      );
      entry.rawOidAbsentFromBlob = !readFileSync(file).includes(Buffer.from(oid));
      entry.objectIdSha256 = createHash("sha256").update(oid).digest("hex");
      entry.expected = form === "metadata" ? "admitted" : "refused";
      if (
        entry.result !== entry.expected ||
        (entry.result === "refused" && entry.failure?.reason !== "findings")
      )
        process.exitCode = 1;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
} finally {
  writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
console.log(
  JSON.stringify({
    output: resolve(output),
    passed: process.exitCode !== 1,
    cases: cases.map(({ name, result }) => ({ name, result })),
  }),
);
