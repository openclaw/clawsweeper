import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveSpawnCommand } from "../command.js";
import { terminateCodexProcessTree } from "../codex-spawn.js";
import { githubCommandTimeoutMs } from "./github-cli.js";
import { repoRoot } from "./paths.js";
import type { LooseRecord } from "./json-types.js";

export async function prepareTargetCheckout(
  job: LooseRecord,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit =
    typeof job.frontmatter.target_checkout === "string"
      ? job.frontmatter.target_checkout.trim()
      : "";
  if (explicit) return explicit;
  const fromEnv = env.CLAWSWEEPER_TARGET_CHECKOUT?.trim();
  if (fromEnv) return fromEnv;
  const targetRepo = String(job.frontmatter.repo ?? "");
  if (env.GITHUB_REPOSITORY === targetRepo) return repoRoot();

  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-target-"));
  const targetDir = path.join(targetRoot, targetRepo.replace(/[^A-Za-z0-9_.-]+/g, "-"));
  try {
    await cloneTarget(targetRepo, targetDir, env);
    return targetDir;
  } catch (error) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
    throw error;
  }
}

async function cloneTarget(
  targetRepo: string,
  targetDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const invocation = resolveSpawnCommand(
    "gh",
    ["repo", "clone", targetRepo, targetDir, "--", "--depth=1"],
    { cwd: repoRoot(), env },
  );
  const timeoutMs = githubCommandTimeoutMs(env, 180_000);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repoRoot(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    let failure = "";
    let output = "";
    let bytes = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      // gh delegates to git; kill the whole group/tree before removing its checkout.
      killTimer = terminateCodexProcessTree(child, "SIGKILL", 0);
    };
    const shutdown = {
      SIGINT: () => stop("interrupted by SIGINT"),
      SIGTERM: () => stop("interrupted by SIGTERM"),
      SIGHUP: () => stop("interrupted by SIGHUP"),
    };
    const onExit = () => stop("worker exited during clone");
    for (const [signal, handler] of Object.entries(shutdown)) process.once(signal, handler);
    process.once("exit", onExit);
    const timer = setTimeout(() => stop(`ETIMEDOUT after ${timeoutMs}ms`), timeoutMs);
    const capture = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) stop("command output exceeded 1 MiB");
      else output += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      failure ||= error.message;
    });
    child.on("close", (code, signal) => {
      for (const [signal, handler] of Object.entries(shutdown)) process.off(signal, handler);
      process.off("exit", onExit);
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failure || code !== 0)
        reject(
          new Error(`gh repo clone ${targetRepo} failed: ${failure || output || signal || code}`),
        );
      else resolve();
    });
  });
}
