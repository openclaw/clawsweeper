#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
const relatedTitleStopWords = new Set([
  "about",
  "after",
  "allow",
  "already",
  "also",
  "and",
  "are",
  "because",
  "being",
  "bug",
  "cannot",
  "claw",
  "clawhub",
  "claws",
  "codex",
  "does",
  "doesn",
  "don",
  "error",
  "fails",
  "feat",
  "feature",
  "fix",
  "for",
  "from",
  "has",
  "have",
  "into",
  "issue",
  "main",
  "not",
  "openclaw",
  "pr",
  "request",
  "should",
  "that",
  "the",
  "this",
  "through",
  "using",
  "when",
  "with",
  "without",
]);

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
const plannedItems = readPlannedItems(planPath);
const itemNumbers = plannedItems.map((item) => item.number);

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
const relatedReportCount = copyRelatedReports({
  outputRoot,
  plannedItems,
  recordsPath,
  stateRoot,
});

console.log(
  `Prepared architecture-neutral review runtime with ${itemNumbers.length} report slots and ${relatedReportCount} bounded relation reports.`,
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

function copyRelatedReports({ outputRoot, plannedItems, recordsPath, stateRoot }) {
  if (plannedItems.length === 0) return 0;
  const recordsRootPath = recordsPath.slice(0, -"/items".length);
  const selectedNumbers = new Set(plannedItems.map((item) => item.number));
  const candidates = [];
  for (const location of ["items", "closed"]) {
    const relativeDirectory = `${recordsRootPath}/${location}`;
    const directory = join(stateRoot, ...relativeDirectory.split("/"));
    assertNoSymlinkPath(stateRoot, relativeDirectory);
    if (!existsSync(directory)) continue;
    if (!lstatSync(directory).isDirectory()) {
      throw new Error(`Review records path is not a directory: ${relativeDirectory}`);
    }
    for (const filename of readDirectoryNames(directory)) {
      if (!/^[1-9][0-9]*\.md$/.test(filename)) continue;
      const source = join(directory, filename);
      const sourceStat = lstatSync(source);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new Error(`Review report must be a regular file: ${relativeDirectory}/${filename}`);
      }
      const markdown = readFileSync(source, "utf8");
      const number = Number(filename.slice(0, -3));
      const repository = frontMatterValue(markdown, "repository");
      const title = displayTitle(frontMatterValue(markdown, "title") ?? "");
      if (!Number.isSafeInteger(number) || !title) continue;
      candidates.push({
        filename,
        location,
        number,
        repository,
        source,
        title,
      });
    }
  }

  const selectedReportKeys = new Set(
    itemNumbersWithLocations(outputRoot, recordsRootPath).map(
      ({ location, number }) => `${location}:${number}`,
    ),
  );
  const related = new Map();
  for (const item of plannedItems) {
    const terms = relatedTitleSearchTerms(item.title);
    if (terms.length < 2) continue;
    const matches = candidates
      .flatMap((candidate) => {
        if (candidate.number === item.number || selectedNumbers.has(candidate.number)) return [];
        if (candidate.repository && candidate.repository !== item.repo) return [];
        const candidateTerms = new Set(relatedTitleSearchTerms(candidate.title, 12));
        const overlap = terms.filter((term) => candidateTerms.has(term)).length;
        return overlap >= 2 ? [{ candidate, overlap }] : [];
      })
      .sort(
        (left, right) =>
          right.overlap - left.overlap || left.candidate.number - right.candidate.number,
      )
      .slice(0, 5);
    for (const { candidate } of matches) {
      related.set(`${candidate.location}:${candidate.number}`, candidate);
    }
  }

  let copied = 0;
  for (const [key, candidate] of related) {
    if (selectedReportKeys.has(key)) continue;
    const outputDirectory = join(outputRoot, ...recordsRootPath.split("/"), candidate.location);
    mkdirSync(outputDirectory, { recursive: true });
    cpSync(candidate.source, join(outputDirectory, candidate.filename));
    copied += 1;
  }
  return copied;
}

function itemNumbersWithLocations(outputRoot, recordsRootPath) {
  const entries = [];
  for (const location of ["items", "closed"]) {
    const directory = join(outputRoot, ...recordsRootPath.split("/"), location);
    if (!existsSync(directory)) continue;
    for (const filename of readDirectoryNames(directory)) {
      if (!/^[1-9][0-9]*\.md$/.test(filename)) continue;
      entries.push({ location, number: Number(filename.slice(0, -3)) });
    }
  }
  return entries;
}

function readDirectoryNames(directory) {
  return readdirSync(directory).sort();
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

function readPlannedItems(path) {
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
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const planned = new Map();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Every review plan candidate must be an object.");
    }
    if (!numbers.has(candidate.number)) continue;
    if (
      !Number.isSafeInteger(candidate.number) ||
      candidate.number <= 0 ||
      typeof candidate.title !== "string" ||
      typeof candidate.repo !== "string"
    ) {
      throw new Error(`Invalid review plan candidate: ${String(candidate.number)}`);
    }
    planned.set(candidate.number, {
      number: candidate.number,
      repo: candidate.repo,
      title: candidate.title,
    });
  }
  return [...numbers]
    .sort((left, right) => left - right)
    .map((number) => planned.get(number) ?? { number, repo: "", title: "" });
}

function frontMatterValue(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return match?.[1]?.trim();
}

function displayTitle(value) {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function relatedTitleSearchTerms(title, limit = 6) {
  const seen = new Set();
  return (
    String(title)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g)
      ?.map((term) => term.replace(/^_+|_+$/g, ""))
      .filter((term) => {
        if (!term || relatedTitleStopWords.has(term) || /^[0-9]+$/.test(term) || seen.has(term)) {
          return false;
        }
        seen.add(term);
        return true;
      })
      .slice(0, limit) ?? []
  );
}

function requiredArg(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(usage);
  return value;
}
