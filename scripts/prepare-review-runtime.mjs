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
const usage =
  "Usage: node scripts/prepare-review-runtime.mjs --output <directory> --plan <plan.json> --state-root <directory> --records-path records/<repo-slug>/items";
const outputArg = requiredArg("--output");
const planArg = requiredArg("--plan");
const stateRootArg = requiredArg("--state-root");
const recordsPath = requiredArg("--records-path");

const outputRoot = resolve(repoRoot, outputArg);
const planPath = resolve(repoRoot, planArg);
const stateRoot = resolve(repoRoot, stateRootArg);
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
if (!/^records\/[A-Za-z0-9][A-Za-z0-9._-]*\/items$/.test(recordsPath)) {
  throw new Error("Review records path must match records/<repo-slug>/items.");
}
if (!existsSync(planPath) || !lstatSync(planPath).isFile()) {
  throw new Error(`Review plan not found: ${planPath}`);
}
if (!existsSync(stateRoot) || !lstatSync(stateRoot).isDirectory()) {
  throw new Error(`State root not found: ${stateRoot}`);
}
if (lstatSync(stateRoot).isSymbolicLink()) {
  throw new Error("State root must not be a symbolic link.");
}

const distSource = join(repoRoot, "dist");
const typescriptSource = realpathSync(join(repoRoot, "node_modules", "typescript"));
const yamlSource = realpathSync(join(repoRoot, "node_modules", "yaml"));
const itemNumbers = plannedItemNumbers(planPath);

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
copySelectedReports({
  itemNumbers,
  outputRoot,
  recordsPath,
  stateRoot,
});

console.log(
  `Prepared architecture-neutral review runtime with ${itemNumbers.length} report slots.`,
);

function assertPackageName(directory, expectedName) {
  const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (packageJson.name !== expectedName) {
    throw new Error(`Expected ${expectedName}, found ${String(packageJson.name)}.`);
  }
}

function copySelectedReports({ itemNumbers, outputRoot, recordsPath, stateRoot }) {
  const recordsSource = join(stateRoot, ...recordsPath.split("/"));
  assertNoSymlinkPath(stateRoot, recordsPath);
  if (!existsSync(recordsSource)) return;
  if (!lstatSync(recordsSource).isDirectory()) {
    throw new Error(`Review records path is not a directory: ${recordsPath}`);
  }

  const recordsOutput = join(outputRoot, ...recordsPath.split("/"));
  for (const itemNumber of itemNumbers) {
    const filename = `${itemNumber}.md`;
    const source = join(recordsSource, filename);
    if (!existsSync(source)) continue;
    const sourceStat = lstatSync(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error(`Review report must be a regular file: ${recordsPath}/${filename}`);
    }
    mkdirSync(recordsOutput, { recursive: true });
    cpSync(source, join(recordsOutput, filename));
  }
}

function assertNoSymlinkPath(root, pathFromRoot) {
  let current = root;
  for (const segment of pathFromRoot.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Review records path must not contain symbolic links: ${pathFromRoot}`);
    }
  }
}

function plannedItemNumbers(path) {
  const plan = JSON.parse(readFileSync(path, "utf8"));
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.shards)) {
    throw new Error("Review plan must contain a shards array.");
  }

  const numbers = new Set();
  for (const shard of plan.shards) {
    if (!shard || typeof shard !== "object" || !Array.isArray(shard.itemNumbers)) {
      throw new Error("Every review plan shard must contain an itemNumbers array.");
    }
    for (const itemNumber of shard.itemNumbers) {
      if (!Number.isSafeInteger(itemNumber) || itemNumber <= 0) {
        throw new Error(`Invalid review plan item number: ${String(itemNumber)}`);
      }
      numbers.add(itemNumber);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(usage);
  return value;
}
