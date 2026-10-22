import { runTextConcurrently } from "./command.js";
import { AgentInputScanError } from "./agent-input-scan.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { SWEEPER_COMMAND_MAX_BUFFER_BYTES } from "./command.js";
import { dirname, join, resolve, sep } from "node:path";
import { ReviewSourcePreparationError } from "./review-source-preparation.js";

const OPENCLAW_REPOSITORY = "openclaw/openclaw";
const DEFAULT_CODEX_SOURCE_URL = "https://github.com/openai/codex.git";

type Spawn = (
  command: string,
  args: string[],
) => { error?: Error; status: number | null; stderr: string };

export const OPENCLAW_CODEX_SOURCE_INCOMPATIBLE_EXIT_CODE = 80;
export function prepareOpenClawCodexSourceForReview(options: {
  targetRepo: string;
  reviewDir: string;
  reviewTreeRoot?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
  deadlineAt?: number;
}): string | undefined {
  if (options.targetRepo.toLowerCase() !== OPENCLAW_REPOSITORY) return;
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
    throw new AgentInputScanError("deadline");
  const env = options.env ?? process.env;
  const script = env.CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT;
  if (!script) return;

  const targetDir = requiredEnvironmentPath(env, "CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR");
  const cacheDir = requiredEnvironmentPath(env, "CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR");
  const sourceUrl = env.CLAWSWEEPER_OPENCLAW_CODEX_SOURCE_URL?.trim() || DEFAULT_CODEX_SOURCE_URL;
  const run: Spawn =
    options.spawn ??
    ((command, args) => {
      if (options.deadlineAt === undefined)
        return spawnSync(command, args, { encoding: "utf8", env });
      const result = runTextConcurrently(
        [
          {
            command,
            args,
            options: {
              env,
              deadlineAt: options.deadlineAt,
              managedProcessGroup: true,
              maxBuffer: 1024 * 1024,
            },
          },
        ],
        1,
      )[0];
      if (result && "output" in result) return { status: 0, stderr: "" };
      if (!result || "expired" in result) throw new AgentInputScanError("deadline");
      const error = result.error as Error & { status?: number; stderr?: string };
      return { status: error.status ?? null, error, stderr: error.stderr ?? "" };
    });
  const result = run("bash", [
    script,
    OPENCLAW_REPOSITORY,
    targetDir,
    cacheDir,
    sourceUrl,
    options.reviewDir,
    options.reviewTreeRoot ?? "",
  ]);
  if (result.error || result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || result.error?.message || `exit ${result.status}`;
    throw new ReviewSourcePreparationError(
      result.status === OPENCLAW_CODEX_SOURCE_INCOMPATIBLE_EXIT_CODE
        ? "source_incompatible"
        : "setup_script_failed",
      `Could not prepare the PR-pinned Codex source: ${detail}`,
    );
  }
  // Only successful host-owned setup may authorize its pinned source sibling.
  return options.reviewTreeRoot ? join(dirname(resolve(targetDir)), "codex") : undefined;
}

export function openClawCodexSourcePreparationFailureRetryable(error: unknown): boolean {
  return !(
    error instanceof ReviewSourcePreparationError &&
    error.diagnosticReason === "source_incompatible"
  );
}

function requiredEnvironmentPath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ReviewSourcePreparationError(
      "configuration_missing",
      `Missing ${name} for OpenClaw Codex source setup.`,
    );
  }
  return value;
}

// Host-owned clone only: include Git metadata and ignored/untracked files without
// running Git callbacks. Streaming reads share the review deadline and path budget.
export function snapshotOpenClawCodexSource(root: string, deadlineAt: number): string {
  if (!lstatSync(root).isDirectory() || !lstatSync(join(root, ".git")).isDirectory())
    throw new Error("Pinned Codex source requires an owned Git directory.");
  const canonicalRoot = realpathSync(root);
  const digest = createHash("sha256"),
    buffer = Buffer.alloc(64 * 1024);
  let pathBytes = 0;
  const check = () => {
    if (Date.now() >= deadlineAt || pathBytes > SWEEPER_COMMAND_MAX_BUFFER_BYTES)
      throw new Error("Pinned Codex source snapshot exceeded the review budget.");
  };
  const visit = (file: string, relative: string) => {
    check();
    const stat = lstatSync(file, { bigint: true });
    const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : "file";
    digest.update(
      JSON.stringify([
        relative,
        kind,
        String(stat.dev),
        String(stat.ino),
        String(stat.mode),
        String(stat.size),
        String(stat.mtimeNs),
        String(stat.ctimeNs),
      ]),
    );
    if (stat.isSymbolicLink()) {
      const target = realpathSync(file);
      if (target !== canonicalRoot && !target.startsWith(canonicalRoot + sep))
        throw new Error("Pinned Codex source has an escaping symbolic link.");
      digest.update(JSON.stringify(readlinkSync(file)));
    } else if (stat.isDirectory()) {
      const directory = opendirSync(file),
        names: string[] = [];
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          pathBytes += Buffer.byteLength(relative) + Buffer.byteLength(entry.name) + 64;
          check();
          names.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      for (const name of names.sort()) visit(join(file, name), relative + "/" + name);
    } else {
      if (!stat.isFile()) throw new Error("Pinned Codex source contains a non-file entry.");
      const fd = openSync(
        file,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
          throw new Error("Pinned Codex source changed during inspection.");
        for (let size = readSync(fd, buffer); size; size = readSync(fd, buffer)) {
          check();
          digest.update(buffer.subarray(0, size));
        }
        const after = fstatSync(fd, { bigint: true });
        if (
          after.size !== stat.size ||
          after.mtimeNs !== stat.mtimeNs ||
          after.ctimeNs !== stat.ctimeNs
        )
          throw new Error("Pinned Codex source changed during inspection.");
      } finally {
        closeSync(fd);
      }
    }
    digest.update("\0");
  };
  visit(root, ".");
  return digest.digest("hex");
}
