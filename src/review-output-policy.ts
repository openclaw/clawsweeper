import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
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
}

export interface ReviewOutputResult {
  itemNumber?: number;
  path: string | null;
  markdown: string;
}

const SUMMARY_MAX_FILES = 128;
const SUMMARY_MAX_BYTES = 16 * 1024 * 1024;

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

export function createTransientReviewOutput(prefix: string): TransientReviewOutput {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  let cleaned = false;
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handlers = new Map<NodeJS.Signals, () => void>();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    rmSync(path, { recursive: true, force: true });
  };
  for (const signal of signals) {
    const handler = () => {
      cleanup();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return { path, cleanup };
}

export function prepareRetainedReviewOutput(
  path: string,
  retention: Exclude<ReviewOutputRetention, "none">,
): void {
  const destination = resolve(path);
  if (existsSync(destination)) {
    const metadata = lstatSync(destination);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new UserFacingCommandError(
        `Review output destination must be a real directory: ${destination}`,
      );
    }
    if (retention === "summary" && readdirSync(destination).length > 0) {
      throw new UserFacingCommandError(
        `Summary output destination must be empty before review: ${destination}`,
      );
    }
  } else {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
  }
  chmodSync(destination, 0o700);
}

export function finalizeSummaryReviewOutput(root: string, retainedPaths: readonly string[]): void {
  const destination = resolve(root);
  const retained = new Set(
    retainedPaths
      .map((path) => resolve(path))
      .filter((path) => path === destination || path.startsWith(`${destination}${sep}`)),
  );
  for (const name of readdirSync(destination)) {
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
  if (existsSync(destination) && readdirSync(destination).length === 0) {
    rmSync(destination, { recursive: true, force: true });
  }
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
