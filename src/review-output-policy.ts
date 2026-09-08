import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Args } from "./clawsweeper-args.js";
import { stringArg } from "./clawsweeper-args.js";
import { UserFacingCommandError } from "./command.js";

export type ReviewOutputRetention = "none" | "summary" | "debug";
export type ReviewResultFormat = "text" | "json";

export interface ReviewOutputSelection {
  retention: ReviewOutputRetention;
  resultFormat: ReviewResultFormat;
  explicitDestination: boolean;
  compatibilityRetention: boolean;
}

export interface TransientReviewOutput {
  path: string;
  cleanup: () => void;
  addCleanup: (cleanup: () => void) => void;
}

export interface RetainedReviewOutput {
  path: string;
  retention: Exclude<ReviewOutputRetention, "none">;
  ownerToken: string | null;
}

export interface ReviewOutputResult {
  itemNumber?: number;
  path: string | null;
  markdown: string;
}

const SUMMARY_MAX_FILES = 128;
const SUMMARY_MAX_BYTES = 16 * 1024 * 1024;
const SUMMARY_OWNER_FILE = ".clawsweeper-output-owner";
export const TRANSIENT_REVIEW_OUTPUT_MAX_FILES = 256;
export const TRANSIENT_REVIEW_OUTPUT_MAX_BYTES = 96 * 1024 * 1024;
export const TRANSIENT_REVIEW_STREAM_MAX_BYTES = 16 * 1024 * 1024;
export const TRANSIENT_REVIEW_RESULT_MAX_BYTES = 4 * 1024 * 1024;
export const TRANSIENT_REVIEW_REPORTS_MAX_BYTES = 16 * 1024 * 1024;
export const DEBUG_REVIEW_OUTPUT_MAX_FILES = 4096;
export const DEBUG_REVIEW_OUTPUT_MAX_BYTES = 1024 * 1024 * 1024;
const REVIEW_OUTPUT_MAX_ITEMS = 128;
const DEBUG_REVIEW_STREAM_POOL_BYTES = 480 * 1024 * 1024;
const DEBUG_REVIEW_PROMPT_POOL_BYTES = 256 * 1024 * 1024;
const DEBUG_REVIEW_RESULT_POOL_BYTES = 64 * 1024 * 1024;
const DEBUG_REVIEW_REPORTS_MAX_BYTES = 64 * 1024 * 1024;
const PRIVATE_REVIEW_STREAM_POOL_BYTES = 56 * 1024 * 1024;
const PRIVATE_REVIEW_RESULT_POOL_BYTES = 12 * 1024 * 1024;
const REVIEW_OUTPUT_GLOBAL_MAX_FILES = 7;
const REVIEW_OUTPUT_SUMMARY_OWNER_FILES = 1;
const REVIEW_OUTPUT_PRIVATE_ITEM_MAX_FILES = 20;
const REVIEW_OUTPUT_DEBUG_ITEM_MAX_FILES = 21;

export function reviewOutputSelection(
  args: Args,
  options: {
    destinationFlag: "artifact_dir" | "report_dir";
    hostedEvidenceRequired?: boolean;
  },
): ReviewOutputSelection {
  const requestedRetention = stringArg(args.output_retention, "").trim();
  const explicitDestination = stringArg(args[options.destinationFlag], "").trim().length > 0;
  const compatibilityRetention = !requestedRetention && explicitDestination;
  const retention = compatibilityRetention ? "debug" : requestedRetention || "none";
  if (!["none", "summary", "debug"].includes(retention)) {
    throw new UserFacingCommandError(
      `--output-retention must be one of: none, summary, debug (received ${JSON.stringify(retention)}).`,
    );
  }
  if (retention === "none" && explicitDestination) {
    throw new UserFacingCommandError(
      `--output-retention none cannot be combined with --${options.destinationFlag.replaceAll("_", "-")}.`,
    );
  }
  if (retention === "debug" && !explicitDestination) {
    throw new UserFacingCommandError(
      `--output-retention debug requires an explicit --${options.destinationFlag.replaceAll("_", "-")}.`,
    );
  }
  if (options.hostedEvidenceRequired && retention !== "debug") {
    throw new UserFacingCommandError(
      "Hosted review requires --output-retention debug and an explicit --artifact-dir so required CI, security, and canonical publication evidence has a validated destination.",
    );
  }
  if (options.hostedEvidenceRequired && !explicitDestination) {
    throw new UserFacingCommandError(
      "Hosted review requires an explicit --artifact-dir for required CI, security, and canonical publication evidence.",
    );
  }
  const resultFormat = stringArg(args.result_format, "text").trim();
  if (resultFormat !== "text" && resultFormat !== "json") {
    throw new UserFacingCommandError(
      `--result-format must be text or json (received ${JSON.stringify(resultFormat)}).`,
    );
  }
  return {
    retention: retention as ReviewOutputRetention,
    resultFormat,
    explicitDestination,
    compatibilityRetention,
  };
}

export function createTransientReviewOutput(
  prefix: string,
  owner?: TransientReviewOutput,
): TransientReviewOutput {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  let cleaned = false;
  const ownedCleanups: Array<() => void> = [];
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const ownedCleanup of ownedCleanups.splice(0).reverse()) ownedCleanup();
    rmSync(path, { recursive: true, force: true });
  };
  if (owner) owner.addCleanup(cleanup);
  return {
    path,
    cleanup,
    addCleanup: (ownedCleanup) => {
      if (cleaned) ownedCleanup();
      else ownedCleanups.push(ownedCleanup);
    },
  };
}

export function prepareRetainedReviewOutput(
  path: string,
  retention: Exclude<ReviewOutputRetention, "none">,
): RetainedReviewOutput {
  const destination = resolve(path);
  if (retention === "summary") {
    if (existsSync(destination)) {
      throw new UserFacingCommandError(
        `Summary output destination must not already exist: ${destination}`,
      );
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(destination, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new UserFacingCommandError(
          `Summary output destination must be created exclusively: ${destination}`,
        );
      }
      throw error;
    }
    const ownerToken = randomUUID();
    try {
      writeFileSync(join(destination, SUMMARY_OWNER_FILE), ownerToken, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    return { path: destination, retention, ownerToken };
  }
  if (existsSync(destination)) {
    const metadata = lstatSync(destination);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new UserFacingCommandError(
        `Review output destination must be a real directory: ${destination}`,
      );
    }
  } else {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
  }
  chmodSync(destination, 0o700);
  return { path: destination, retention, ownerToken: null };
}

export function finalizeSummaryReviewOutput(
  output: RetainedReviewOutput,
  retainedPaths: readonly string[],
): void {
  const destination = resolve(output.path);
  assertSummaryOutputOwner(output);
  const retained = new Set(
    retainedPaths
      .map((path) => resolve(path))
      .filter((path) => path === destination || path.startsWith(`${destination}${sep}`)),
  );
  for (const name of readdirSync(destination)) {
    if (name === SUMMARY_OWNER_FILE) continue;
    const entry = join(destination, name);
    const keep = [...retained].some((path) => path === entry || path.startsWith(`${entry}${sep}`));
    if (!keep) rmSync(entry, { recursive: true, force: true });
  }
  let files = 0;
  let bytes = 0;
  for (const path of retained) {
    if (!existsSync(path)) continue;
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      rmSync(destination, { recursive: true, force: true });
      throw new UserFacingCommandError("Summary review output contained an unsafe file type.");
    }
    files += 1;
    bytes += statSync(path).size;
    chmodSync(path, 0o600);
  }
  if (files > SUMMARY_MAX_FILES || bytes > SUMMARY_MAX_BYTES) {
    rmSync(destination, { recursive: true, force: true });
    throw new UserFacingCommandError(
      `Summary review output exceeded its ${SUMMARY_MAX_FILES}-file or ${SUMMARY_MAX_BYTES}-byte limit.`,
    );
  }
  removeEmptyParents(retained, destination);
  rmSync(join(destination, SUMMARY_OWNER_FILE), { force: true });
  if (existsSync(destination) && readdirSync(destination).length === 0) {
    rmdirSync(destination);
  }
}

export function discardOwnedSummaryOutput(output: RetainedReviewOutput | null): void {
  if (!output || output.retention !== "summary") return;
  assertSummaryOutputOwner(output);
  rmSync(output.path, { recursive: true, force: true });
}

export function assertTransientReviewOutputBudget(root: string): void {
  const totals = reviewOutputTotals(resolve(root));
  if (
    totals.files > TRANSIENT_REVIEW_OUTPUT_MAX_FILES ||
    totals.bytes > TRANSIENT_REVIEW_OUTPUT_MAX_BYTES
  ) {
    throw new UserFacingCommandError(
      `Transient review output exceeded its ${TRANSIENT_REVIEW_OUTPUT_MAX_FILES}-file or ${TRANSIENT_REVIEW_OUTPUT_MAX_BYTES}-byte limit.`,
    );
  }
}

export function assertReviewReportsBudget(
  results: readonly ReviewOutputResult[],
  retention: ReviewOutputRetention,
): void {
  const bytes = results.reduce((total, result) => total + Buffer.byteLength(result.markdown), 0);
  const maxBytes =
    retention === "debug" ? DEBUG_REVIEW_REPORTS_MAX_BYTES : TRANSIENT_REVIEW_REPORTS_MAX_BYTES;
  if (bytes > maxBytes) {
    throw new UserFacingCommandError(`Review reports exceeded their ${maxBytes}-byte limit.`);
  }
}

export function reviewOutputItemBudget(
  retention: ReviewOutputRetention,
  itemCount: number,
): { promptFileBytes: number; resultFileBytes: number; streamFileBytes: number } {
  if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > REVIEW_OUTPUT_MAX_ITEMS) {
    throw new UserFacingCommandError(
      `Review output budgets support 1-${REVIEW_OUTPUT_MAX_ITEMS} items per invocation.`,
    );
  }
  if (retention === "debug") {
    return {
      promptFileBytes: Math.floor(DEBUG_REVIEW_PROMPT_POOL_BYTES / itemCount),
      resultFileBytes: Math.floor(DEBUG_REVIEW_RESULT_POOL_BYTES / itemCount),
      streamFileBytes: Math.min(
        128 * 1024 * 1024,
        Math.floor(DEBUG_REVIEW_STREAM_POOL_BYTES / (itemCount * 2)),
      ),
    };
  }
  return {
    promptFileBytes: 0,
    resultFileBytes: Math.min(
      TRANSIENT_REVIEW_RESULT_MAX_BYTES,
      Math.floor(PRIVATE_REVIEW_RESULT_POOL_BYTES / itemCount),
    ),
    streamFileBytes: Math.min(
      TRANSIENT_REVIEW_STREAM_MAX_BYTES,
      Math.floor(PRIVATE_REVIEW_STREAM_POOL_BYTES / (itemCount * 2)),
    ),
  };
}

export function reviewOutputFilePeak(retention: ReviewOutputRetention, itemCount: number): number {
  if (!Number.isInteger(itemCount) || itemCount < 1 || itemCount > REVIEW_OUTPUT_MAX_ITEMS) {
    throw new UserFacingCommandError(
      `Review output budgets support 1-${REVIEW_OUTPUT_MAX_ITEMS} items per invocation.`,
    );
  }
  if (retention === "debug") {
    return REVIEW_OUTPUT_GLOBAL_MAX_FILES + REVIEW_OUTPUT_DEBUG_ITEM_MAX_FILES * itemCount;
  }
  if (retention === "summary") {
    return (
      REVIEW_OUTPUT_GLOBAL_MAX_FILES +
      REVIEW_OUTPUT_SUMMARY_OWNER_FILES +
      REVIEW_OUTPUT_PRIVATE_ITEM_MAX_FILES +
      itemCount -
      1
    );
  }
  return REVIEW_OUTPUT_GLOBAL_MAX_FILES + REVIEW_OUTPUT_PRIVATE_ITEM_MAX_FILES;
}

export function assertReviewOutputFilePeak(
  retention: ReviewOutputRetention,
  itemCount: number,
): void {
  const peak = reviewOutputFilePeak(retention, itemCount);
  const maxFiles =
    retention === "debug" ? DEBUG_REVIEW_OUTPUT_MAX_FILES : TRANSIENT_REVIEW_OUTPUT_MAX_FILES;
  if (peak > maxFiles) {
    throw new UserFacingCommandError(
      `${retention === "debug" ? "Debug" : "Transient"} review output can require ${peak} live files, exceeding its ${maxFiles}-file limit.`,
    );
  }
}

export function pruneReviewOutputItem(options: {
  artifactDir: string;
  codexWorkDir: string;
  proofScratchDir: string;
  reportPath: string;
  itemNumber: number;
  retention: ReviewOutputRetention;
}): void {
  if (options.retention === "debug") return;
  const artifactDir = resolve(options.artifactDir);
  const codexWorkDir = assertOwnedOutputPath(artifactDir, options.codexWorkDir);
  const proofScratchDir = assertOwnedOutputPath(artifactDir, options.proofScratchDir);
  const reportPath = assertOwnedOutputPath(artifactDir, options.reportPath);
  const itemPrefix = join(codexWorkDir, String(options.itemNumber));
  for (const path of [
    `${itemPrefix}.prompt.md`,
    `${itemPrefix}.json`,
    `${itemPrefix}.1.codex.stdout.log`,
    `${itemPrefix}.1.codex.stderr.log`,
    `${itemPrefix}.review-thread.json`,
  ]) {
    rmSync(path, { force: true });
  }
  rmSync(proofScratchDir, { recursive: true, force: true });
  if (options.retention === "none") rmSync(reportPath, { force: true });
  removeDirectoryIfEmpty(dirname(proofScratchDir));
  removeDirectoryIfEmpty(codexWorkDir);
}

export function assertActiveReviewOutputBudget(output: RetainedReviewOutput): void {
  const totals = reviewOutputTotals(output.path, {
    maxFiles:
      output.retention === "debug"
        ? DEBUG_REVIEW_OUTPUT_MAX_FILES
        : TRANSIENT_REVIEW_OUTPUT_MAX_FILES,
    maxBytes:
      output.retention === "debug"
        ? DEBUG_REVIEW_OUTPUT_MAX_BYTES
        : TRANSIENT_REVIEW_OUTPUT_MAX_BYTES,
  });
  const maxFiles =
    output.retention === "debug"
      ? DEBUG_REVIEW_OUTPUT_MAX_FILES
      : TRANSIENT_REVIEW_OUTPUT_MAX_FILES;
  const maxBytes =
    output.retention === "debug"
      ? DEBUG_REVIEW_OUTPUT_MAX_BYTES
      : TRANSIENT_REVIEW_OUTPUT_MAX_BYTES;
  if (totals.files > maxFiles || totals.bytes > maxBytes) {
    throw new UserFacingCommandError(
      `${output.retention === "debug" ? "Debug" : "Summary"} review output exceeded its ${maxFiles}-file or ${maxBytes}-byte limit.`,
    );
  }
}

export function readBoundedReviewResult(path: string, maxBytes: number): string {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new UserFacingCommandError("Review result output was not a regular file.");
  }
  if (metadata.size > maxBytes) {
    throw new UserFacingCommandError(`Review result output exceeded its ${maxBytes}-byte limit.`);
  }
  return readFileSync(path, "utf8");
}

export function emitReviewOutput(
  selection: ReviewOutputSelection,
  status: "completed" | "failed",
  results: readonly ReviewOutputResult[],
): void {
  if (selection.resultFormat === "json") {
    console.log(
      JSON.stringify({
        status,
        retention: selection.retention,
        reports: results.map((result) => ({
          ...(result.itemNumber === undefined ? {} : { item_number: result.itemNumber }),
          artifact_path: result.path,
          report: result.markdown,
        })),
      }),
    );
    return;
  }
  for (const result of results) {
    console.log(
      selection.compatibilityRetention && result.path ? result.path : result.markdown.trimEnd(),
    );
  }
}

export function emitReviewFailureJson(args: Args, error: unknown): boolean {
  if (stringArg(args.result_format, "text").trim() !== "json") return false;
  const requestedRetention = stringArg(args.output_retention, "").trim();
  const compatibilityRetention =
    !requestedRetention &&
    [stringArg(args.artifact_dir, ""), stringArg(args.report_dir, "")].some(
      (path) => path.trim().length > 0,
    );
  console.log(
    JSON.stringify({
      status: "failed",
      retention: compatibilityRetention
        ? "debug"
        : ["none", "summary", "debug"].includes(requestedRetention)
          ? requestedRetention
          : "none",
      reports: [],
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
  return true;
}

function removeEmptyParents(retained: ReadonlySet<string>, root: string): void {
  const parents = new Set<string>();
  for (const path of retained) {
    let current = dirname(path);
    while (current.startsWith(`${root}${sep}`)) {
      parents.add(current);
      current = dirname(current);
    }
  }
  for (const path of [...parents].sort((left, right) => right.length - left.length)) {
    if (existsSync(path) && readdirSync(path).length === 0) rmSync(path, { recursive: true });
  }
}

function assertOwnedOutputPath(root: string, path: string): string {
  const candidate = resolve(path);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new UserFacingCommandError("Review output cleanup refused a path outside its run.");
  }
  return candidate;
}

function removeDirectoryIfEmpty(path: string): void {
  if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
}

function assertSummaryOutputOwner(output: RetainedReviewOutput): void {
  const destination = resolve(output.path);
  if (output.retention !== "summary" || !output.ownerToken) {
    throw new UserFacingCommandError("Summary output finalization requires its owner token.");
  }
  const metadata = lstatSync(destination);
  const marker = join(destination, SUMMARY_OWNER_FILE);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !existsSync(marker) ||
    lstatSync(marker).isSymbolicLink() ||
    readFileSync(marker, "utf8") !== output.ownerToken
  ) {
    throw new UserFacingCommandError("Summary output ownership changed before finalization.");
  }
}

function reviewOutputTotals(
  root: string,
  limits: {
    maxFiles: number;
    maxBytes: number;
  } = {
    maxFiles: TRANSIENT_REVIEW_OUTPUT_MAX_FILES,
    maxBytes: TRANSIENT_REVIEW_OUTPUT_MAX_BYTES,
  },
): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new UserFacingCommandError("Transient review output contained a symbolic link.");
      }
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) {
        files += 1;
        bytes += metadata.size;
      } else {
        throw new UserFacingCommandError("Transient review output contained an unsafe file type.");
      }
      if (files > limits.maxFiles || bytes > limits.maxBytes) {
        return { files, bytes };
      }
    }
  }
  return { files, bytes };
}
