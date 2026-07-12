#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const artifactsRoot = join(repoRoot, ".artifacts");
const outputArgIndex = process.argv.indexOf("--output");
const outputArg = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : undefined;
if (!outputArg || outputArg.startsWith("--")) {
  throw new Error("Usage: node scripts/prepare-review-runtime.mjs --output <directory>");
}

const outputRoot = resolve(repoRoot, outputArg);
mkdirSync(artifactsRoot, { recursive: true });
const artifactsFromRepo = relative(realpathSync(repoRoot), realpathSync(artifactsRoot));
const outputFromArtifacts = relative(artifactsRoot, outputRoot);
if (
  !artifactsFromRepo ||
  artifactsFromRepo === ".." ||
  artifactsFromRepo.startsWith(`..${sep}`) ||
  isAbsolute(artifactsFromRepo) ||
  !outputFromArtifacts ||
  outputFromArtifacts === ".." ||
  outputFromArtifacts.startsWith(`..${sep}`) ||
  isAbsolute(outputFromArtifacts) ||
  outputFromArtifacts.includes(sep)
) {
  throw new Error("Review runtime output must be one direct child of the repository .artifacts.");
}
if (existsSync(outputRoot) && lstatSync(outputRoot).isSymbolicLink()) {
  throw new Error("Review runtime output must not be a symbolic link.");
}

const distSource = join(repoRoot, "dist");
const typescriptSource = realpathSync(join(repoRoot, "node_modules", "typescript"));
const yamlSource = realpathSync(join(repoRoot, "node_modules", "yaml"));

assertPackageName(typescriptSource, "typescript");
assertPackageName(yamlSource, "yaml");
if (!existsSync(distSource)) {
  throw new Error("Built runtime not found. Run the build before preparing the review artifact.");
}

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(join(outputRoot, "node_modules"), { recursive: true });
cpSync(distSource, join(outputRoot, "dist"), { dereference: true, recursive: true });
cpSync(typescriptSource, join(outputRoot, "node_modules", "typescript"), {
  dereference: true,
  recursive: true,
});
cpSync(yamlSource, join(outputRoot, "node_modules", "yaml"), {
  dereference: true,
  recursive: true,
});

console.log("Prepared architecture-neutral review runtime.");

function assertPackageName(directory, expectedName) {
  const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (packageJson.name !== expectedName) {
    throw new Error(`Expected ${expectedName}, found ${String(packageJson.name)}.`);
  }
}
