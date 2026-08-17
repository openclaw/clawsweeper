import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createVideoContactSheet,
  mediaProofCommandRunner,
  mediaProofSpawnDetail,
} from "../clawsweeper-media-proof.js";
import type { LiveProofPlan, MediaProofCommandRunner } from "../clawsweeper-types.js";
import type { RepositoryProfile } from "../repository-profiles.js";
import { driveBrowser, driveTerminal, liveProofStepActions } from "./drivers.js";
import { LIVE_PROOF_MAX_MP4_BYTES, type LiveProofManifest, probeMedia } from "./manifest.js";

export interface LiveProofPullRequestState {
  kind: "issue" | "pull_request";
  state: string;
  headSha: string | null;
}

export interface LiveProofExecuteOptions {
  repo: string;
  item: number;
  outputDir: string;
  recordPath?: string;
  planPath?: string;
  checkoutPath?: string;
}

export interface LiveProofExecuteDependencies {
  env?: NodeJS.ProcessEnv;
  runner?: MediaProofCommandRunner;
  repositoryProfileFor: (repo: string) => RepositoryProfile;
  reportLiveProofPlan: (markdown: string) => LiveProofPlan;
  parseLiveProofPlan: (value: unknown) => LiveProofPlan;
  fetchPullRequest: (repo: string, item: number) => Promise<LiveProofPullRequestState>;
  log?: (message: string) => void;
  now?: () => Date;
}

export async function executeLiveProof(
  options: LiveProofExecuteOptions,
  dependencies: LiveProofExecuteDependencies,
): Promise<void> {
  const env = dependencies.env ?? process.env;
  const runner = dependencies.runner ?? mediaProofCommandRunner;
  const log = dependencies.log ?? console.log;
  if (env.CLAWSWEEPER_LIVE_PROOF_ENABLED !== "1") {
    log("[live-proof] skip: CLAWSWEEPER_LIVE_PROOF_ENABLED is not 1");
    return;
  }

  const profile = dependencies.repositoryProfileFor(options.repo);
  const liveTest = profile.liveTest;
  if (!liveTest?.enabled) {
    log(`[live-proof] skip: ${profile.targetRepo} does not enable live_test`);
    return;
  }

  const plan = readPlan(options, dependencies);
  if (plan.status !== "recommended") {
    log(`[live-proof] skip: liveProofPlan status is ${plan.status}`);
    return;
  }
  if (plan.surface === "none") {
    throw new Error("recommended live proof plan is missing a browser or terminal surface");
  }
  if (plan.surface === "browser" && (!liveTest.start || !liveTest.url)) {
    log(
      `[live-proof] skip: browser plan cannot run for ${profile.targetRepo} because live_test.start and live_test.url are not configured`,
    );
    return;
  }

  const checkout = resolve(options.checkoutPath ?? process.cwd());
  let headSha: string;
  if (options.checkoutPath) {
    log("[live-proof] local --checkout supplied; skipping the live PR kind/open check");
    headSha = gitHeadSha(checkout, runner);
  } else {
    const item = await dependencies.fetchPullRequest(profile.targetRepo, options.item);
    if (item.kind !== "pull_request") {
      log(`[live-proof] skip: ${profile.targetRepo}#${options.item} is not a pull request`);
      return;
    }
    if (item.state.toLowerCase() !== "open") {
      log(`[live-proof] skip: pull request is ${item.state || "not open"}`);
      return;
    }
    if (!item.headSha || !/^[0-9a-f]{40}$/i.test(item.headSha)) {
      throw new Error("live pull request head SHA is unavailable");
    }
    headSha = item.headSha.toLowerCase();
  }

  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const rawVideoPath = join(outputDir, "live-proof.raw.webm");
  const mp4Path = join(outputDir, "live-proof.mp4");
  const posterPath = join(outputDir, "poster.jpg");
  const stepsLogPath = join(outputDir, "steps-log.json");
  const scriptPath = join(outputDir, "live-proof-playwright.mjs");
  const serverPidPath = join(outputDir, "server.pid");

  for (const command of liveTest.setup) {
    requireSuccess("sh", ["-lc", command], runner("sh", ["-lc", command], { cwd: checkout }));
  }

  let serverStarted = false;
  try {
    if (plan.surface === "browser") {
      const startCommand = `${liveTest.start} >${shellQuote(join(outputDir, "server.log"))} 2>&1 & echo $! >${shellQuote(serverPidPath)}`;
      requireSuccess(
        "sh",
        ["-lc", startCommand],
        runner("sh", ["-lc", startCommand], { cwd: checkout }),
      );
      serverStarted = true;
      waitUntilReady(liveTest.url!, liveTest.readyTimeoutSeconds, runner, checkout);
    }

    const drive =
      plan.surface === "browser"
        ? driveBrowser({
            plan,
            checkout,
            scriptPath,
            rawVideoPath,
            stepsLogPath,
            baseUrl: liveTest.url!,
            runner,
          })
        : driveTerminal({
            plan,
            checkout,
            rawVideoPath,
            maxRecordingSeconds: liveTest.maxRecordingSeconds,
            runner,
          });

    transcodeToMp4(rawVideoPath, mp4Path, runner, checkout);
    enforceMp4SizeCap(mp4Path, runner, checkout);
    const media = probeMedia(mp4Path, runner);
    if (
      media.durationSeconds === null ||
      media.durationSeconds > liveTest.maxRecordingSeconds + 0.05
    ) {
      throw new Error(
        `live proof recording exceeds configured ${liveTest.maxRecordingSeconds}-second cap`,
      );
    }
    // The contact-sheet tile needs ~100 seconds of sampled video before some
    // ffmpeg builds emit a frame, so short recordings fall back to a single
    // poster frame near the start of the demonstration.
    createVideoContactSheet(mp4Path, posterPath, runner);
    if (!existsSync(posterPath)) {
      for (const offset of ["1", "0"]) {
        const frame = runner(
          "ffmpeg",
          [
            "-hide_banner",
            "-y",
            "-ss",
            offset,
            "-i",
            mp4Path,
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-1",
            posterPath,
          ],
          { cwd: checkout },
        );
        if (frame.status === 0 && existsSync(posterPath)) break;
      }
    }
    if (!existsSync(posterPath)) throw new Error("ffmpeg did not create poster.jpg");

    writeFileSync(stepsLogPath, `${JSON.stringify(drive.steps, null, 2)}\n`, "utf8");
    const manifest: LiveProofManifest = {
      schema_version: 1,
      repo: profile.targetRepo,
      item: options.item,
      head_sha: headSha,
      surface: plan.surface,
      duration_seconds: Number(media.durationSeconds.toFixed(3)),
      width: media.width,
      height: media.height,
      drive_status: drive.status,
      steps_executed: liveProofStepActions(plan.steps),
      recorded_at: (dependencies.now ?? (() => new Date()))().toISOString(),
    };
    writeFileSync(
      join(outputDir, "live-proof-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    log(
      `[live-proof] wrote ${plan.surface} proof bundle for ${profile.targetRepo}#${options.item} at ${headSha}`,
    );
  } finally {
    if (serverStarted) stopBackgroundServer(serverPidPath, runner, checkout);
  }
}

function readPlan(
  options: LiveProofExecuteOptions,
  dependencies: LiveProofExecuteDependencies,
): LiveProofPlan {
  if (options.planPath) {
    const parsed = JSON.parse(readFileSync(resolve(options.planPath), "utf8")) as unknown;
    const value =
      parsed && typeof parsed === "object" && "liveProofPlan" in parsed
        ? (parsed as { liveProofPlan: unknown }).liveProofPlan
        : parsed;
    return dependencies.parseLiveProofPlan(value);
  }
  if (!options.recordPath) {
    throw new Error("live-proof requires --record or the local --plan override");
  }
  return dependencies.reportLiveProofPlan(readFileSync(resolve(options.recordPath), "utf8"));
}

function waitUntilReady(
  url: string,
  timeoutSeconds: number,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  const deadline = Date.now() + timeoutSeconds * 1000;
  do {
    const result = runner(
      "curl",
      ["--fail", "--silent", "--show-error", "--max-time", "3", "--output", "/dev/null", url],
      { cwd: checkout },
    );
    if (result.status === 0) return;
    if (Date.now() >= deadline) break;
    runner("sleep", ["1"]);
  } while (Date.now() < deadline);
  throw new Error(`live_test.url did not return HTTP 200 within ${timeoutSeconds} seconds`);
}

function transcodeToMp4(
  rawVideoPath: string,
  mp4Path: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    rawVideoPath,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4Path,
  ];
  requireSuccess("ffmpeg", args, runner("ffmpeg", args, { cwd: checkout }));
}

function enforceMp4SizeCap(
  mp4Path: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  if (statSync(mp4Path).size <= LIVE_PROOF_MAX_MP4_BYTES) return;
  const smallerPath = `${mp4Path}.smaller.mp4`;
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    mp4Path,
    "-c:v",
    "libx264",
    "-b:v",
    "1200k",
    "-maxrate",
    "1500k",
    "-bufsize",
    "2400k",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    smallerPath,
  ];
  requireSuccess("ffmpeg", args, runner("ffmpeg", args, { cwd: checkout }));
  renameSync(smallerPath, mp4Path);
  if (statSync(mp4Path).size > LIVE_PROOF_MAX_MP4_BYTES) {
    throw new Error("live-proof.mp4 still exceeds 50 MB after one lower-bitrate encode");
  }
}

function gitHeadSha(checkout: string, runner: MediaProofCommandRunner): string {
  const result = runner("git", ["rev-parse", "HEAD"], { cwd: checkout });
  requireSuccess("git", ["rev-parse", "HEAD"], result);
  const sha = String(result.stdout ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("local checkout HEAD is not a full commit SHA");
  return sha;
}

function stopBackgroundServer(
  serverPidPath: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  // Kill the whole descendant tree: the pid file holds the launcher shell, and
  // killing only that pid orphans the server it spawned (observed with a
  // wrangler dev child surviving its parent script).
  const command = [
    `kill_tree() { for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done; kill "$1" 2>/dev/null || true; }`,
    `if [ -s ${shellQuote(serverPidPath)} ]; then kill_tree "$(cat ${shellQuote(serverPidPath)})"; fi`,
  ].join("; ");
  runner("sh", ["-lc", command], { cwd: checkout });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireSuccess(
  command: string,
  args: readonly string[],
  result: ReturnType<MediaProofCommandRunner>,
): void {
  if (result.status === 0) return;
  throw new Error(`${command} ${args.join(" ")} failed: ${mediaProofSpawnDetail(result)}`);
}
