#!/usr/bin/env node
import fs from "node:fs";

import { runCommand as run } from "./command-runner.js";
import type { LooseRecord } from "./json-types.js";
import { resolveRunArtifact } from "./run-artifact.js";

const args = parseArgs(process.argv.slice(2));
const repository = requiredArg(args, "repository");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("repository is invalid");
}
const runId = requiredArg(args, "run-id");
const pages = JSON.parse(
  run("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  ]),
);
if (!Array.isArray(pages)) throw new Error("workflow artifact response is invalid");
const artifacts = pages.flatMap((page) => {
  const values = (page as LooseRecord)?.artifacts;
  if (!Array.isArray(values)) throw new Error("workflow artifact page is invalid");
  return values as LooseRecord[];
});
const artifact = resolveRunArtifact({
  artifacts,
  prefix: requiredArg(args, "prefix"),
  runId,
  currentAttempt: Number(requiredArg(args, "current-attempt")),
  expectedArtifactId: args.get("expected-artifact-id") ?? null,
  expectedArtifactDigest: args.get("expected-artifact-digest") ?? null,
  fallbackPrefixes: args.has("fallback-prefix") ? [requiredArg(args, "fallback-prefix")] : [],
});

writeOutputs({
  artifact_id: String(artifact.id),
  artifact_name: artifact.name,
  producer_attempt: String(artifact.producerAttempt),
  artifact_digest: artifact.digest,
});

function parseArgs(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    parsed.set(name.slice(2), value);
  }
  return parsed;
}

function requiredArg(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function writeOutputs(outputs: Record<string, string>) {
  const outputPath = process.env.GITHUB_OUTPUT;
  const text = Object.entries(outputs)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
  if (outputPath) fs.appendFileSync(outputPath, text);
  else process.stdout.write(text);
}
