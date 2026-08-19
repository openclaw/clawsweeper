#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";
import { redactInternalCodexModel } from "../codex-env.js";

type CollectOptions = {
  outDir: string;
  label: string;
  sinceMinutes: number;
  maxBytes: number;
  homeDir: string;
  codexHome?: string;
  repairRunsDir?: string;
  redactValues?: string[];
};

type ManifestEntry = {
  source: string;
  artifact_path: string;
  bytes: number;
  redacted_bytes: number;
  modified_at: string;
  sha256: string;
};

type SkippedEntry = {
  source: string;
  reason: string;
};

const DEFAULT_SINCE_MINUTES = 240;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

export function collectCodexDebug(options: CollectOptions) {
  const codexHome = resolveCodexHome(options);
  const roots = codexDebugRoots(options, codexHome);
  const redactValues = [
    ...(options.redactValues ?? []),
    process.env.CLAWSWEEPER_INTERNAL_MODEL ?? "",
  ];
  const since = Date.now() - options.sinceMinutes * 60 * 1000;
  const manifest: ManifestEntry[] = [];
  const skipped: SkippedEntry[] = [];

  fs.rmSync(options.outDir, { recursive: true, force: true });
  fs.mkdirSync(options.outDir, { recursive: true });

  for (const root of roots) {
    if (!fs.existsSync(root.path)) {
      skipped.push({ source: root.path, reason: "missing" });
      continue;
    }
    for (const filePath of listFiles(root.path)) {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < since) continue;
      if (!isAllowedCodexDebugFile(filePath, root.kind)) {
        skipped.push({ source: filePath, reason: "not-codex-debug" });
        continue;
      }
      if (stat.size > options.maxBytes) {
        skipped.push({ source: filePath, reason: `over ${options.maxBytes} bytes` });
        continue;
      }
      const relative = safeRelative(root.path, filePath);
      const artifactPath = path.join(options.outDir, root.name, relative);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      const raw = fs.readFileSync(filePath, "utf8");
      const redacted = redactSecrets(raw, redactValues, codexHome);
      fs.writeFileSync(artifactPath, redacted);
      manifest.push({
        source: path.join(root.name, relative),
        artifact_path: path.relative(options.outDir, artifactPath),
        bytes: stat.size,
        redacted_bytes: Buffer.byteLength(redacted),
        modified_at: stat.mtime.toISOString(),
        sha256: crypto.createHash("sha256").update(redacted).digest("hex"),
      });
    }
  }

  const manifestPath = path.join(options.outDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        label: options.label,
        collected_at: new Date().toISOString(),
        since_minutes: options.sinceMinutes,
        files: manifest,
        skipped,
      },
      null,
      2,
    )}\n`,
  );

  return { manifest, skipped, manifestPath };
}

export function redactSecrets(text: string, redactValues: string[] = [], codexHome?: string) {
  let redacted = redactInternalCodexModel(text, codexHome);
  for (const value of redactValues.map((entry) => entry.trim()).filter(Boolean)) {
    redacted = redacted.replaceAll(value, "[REDACTED_INTERNAL_MODEL]");
  }
  return redacted
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(OPENAI_API_KEY|CODEX_API_KEY|GH_TOKEN|GITHUB_TOKEN)=([^\s"']+)/g, "$1=[REDACTED]")
    .replace(
      /"((?:OPENAI_API_KEY|CODEX_API_KEY|GH_TOKEN|GITHUB_TOKEN))"\s*:\s*"[^"]*"/g,
      '"$1":"[REDACTED]"',
    );
}

function resolveCodexHome(options: CollectOptions): string {
  return (
    options.codexHome || process.env.CODEX_HOME?.trim() || path.join(options.homeDir, ".codex")
  );
}

function codexDebugRoots(options: CollectOptions, codexHome = resolveCodexHome(options)) {
  const repairRunsDir =
    options.repairRunsDir || path.join(process.cwd(), ".clawsweeper-repair", "runs");
  return [
    { name: "sessions", path: path.join(codexHome, "sessions"), kind: "codex-home" },
    { name: "log", path: path.join(codexHome, "log"), kind: "codex-home" },
    { name: "repair-runs", path: repairRunsDir, kind: "repair-runs" },
  ];
}

function isAllowedCodexDebugFile(filePath: string, kind = "codex-home") {
  const base = path.basename(filePath).toLowerCase();
  if (base === "auth.json" || base === "config.toml" || base === "config.json") return false;
  if (kind === "repair-runs" && !base.includes("codex")) return false;
  return /\.(json|jsonl|ndjson|log|txt)$/i.test(base);
}

function* listFiles(root: string): Generator<string> {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) yield* listFiles(filePath);
    else if (entry.isFile()) yield filePath;
  }
}

function safeRelative(root: string, filePath: string) {
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to copy file outside root: ${filePath}`);
  }
  return relative;
}

function parseArgs(argv: string[]) {
  const normalized: string[] = [];
  const known = new Set([
    "--out",
    "--label",
    "--since-minutes",
    "--max-bytes",
    "--codex-home",
    "--repair-runs-dir",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!known.has(value) || !next || next.startsWith("--")) {
      if (next && !next.startsWith("--")) index += 1;
      continue;
    }
    normalized.push(`${value}=${next}`);
    index += 1;
  }
  return parseNodeArgs({
    args: normalized,
    options: {
      out: { type: "string" },
      label: { type: "string" },
      "since-minutes": { type: "string" },
      "max-bytes": { type: "string" },
      "codex-home": { type: "string" },
      "repair-runs-dir": { type: "string" },
    },
  }).values;
}

function numberArg(value: string | boolean | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(value: string | boolean | undefined, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  const outDir = stringArg(args.out, ".clawsweeper-repair/codex-debug");
  const codexHome =
    typeof args["codex-home"] === "string" ? args["codex-home"] : process.env.CODEX_HOME;
  const repairRunsDir =
    typeof args["repair-runs-dir"] === "string" ? args["repair-runs-dir"] : undefined;
  const result = collectCodexDebug({
    outDir,
    label: stringArg(args.label, "codex"),
    sinceMinutes: numberArg(args["since-minutes"], DEFAULT_SINCE_MINUTES),
    maxBytes: numberArg(args["max-bytes"], DEFAULT_MAX_BYTES),
    homeDir: os.homedir(),
    ...(codexHome ? { codexHome } : {}),
    ...(repairRunsDir ? { repairRunsDir } : {}),
  });
  console.log(
    JSON.stringify({
      out_dir: outDir,
      files: result.manifest.length,
      skipped: result.skipped.length,
      manifest: result.manifestPath,
    }),
  );
}
