import { spawnSync } from "node:child_process";
import { ReviewSourcePreparationError } from "./review-source-preparation.js";

const OPENCLAW_REPOSITORY = "openclaw/openclaw";
const DEFAULT_CODEX_SOURCE_URL = "https://github.com/openai/codex.git";

type Spawn = (
  command: string,
  args: string[],
) => { error?: Error; status: number | null; stderr: string };

export function prepareOpenClawCodexSourceForReview(options: {
  targetRepo: string;
  reviewDir: string;
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
}): void {
  if (options.targetRepo.toLowerCase() !== OPENCLAW_REPOSITORY) return;
  const env = options.env ?? process.env;
  const script = env.CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT;
  if (!script) return;

  const targetDir = requiredEnvironmentPath(env, "CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR");
  const artifactDir = requiredEnvironmentPath(env, "CLAWSWEEPER_OPENCLAW_CODEX_ARTIFACT_DIR");
  const cacheDir = requiredEnvironmentPath(env, "CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR");
  const sourceUrl = env.CLAWSWEEPER_OPENCLAW_CODEX_SOURCE_URL?.trim() || DEFAULT_CODEX_SOURCE_URL;
  const run = options.spawn ?? ((command, args) => spawnSync(command, args, { encoding: "utf8" }));
  const result = run("bash", [
    script,
    OPENCLAW_REPOSITORY,
    targetDir,
    artifactDir,
    cacheDir,
    sourceUrl,
    options.reviewDir,
  ]);
  if (result.error || result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || `exit ${result.status}`;
    throw new ReviewSourcePreparationError(
      "setup_script_failed",
      `Could not prepare the PR-pinned Codex source: ${detail}`,
    );
  }
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
