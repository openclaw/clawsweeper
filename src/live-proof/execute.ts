import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  createVideoContactSheet,
  mediaProofCommandRunner,
  mediaProofSpawnDetail,
} from "../clawsweeper-media-proof.js";
import type { LiveProofPlan, MediaProofCommandRunner } from "../clawsweeper-types.js";
import type { RepositoryProfile } from "../repository-profiles.js";
import {
  driveBrowser,
  driveTerminal,
  TERMINAL_OUTPUT_NOT_OBSERVED_DETAIL,
  type LiveProofStepLogEntry,
  liveProofStepActions,
} from "./drivers.js";
import { LIVE_PROOF_MAX_MP4_BYTES, type LiveProofManifest, probeMedia } from "./manifest.js";
import {
  assertLiveProofEnvironmentSanitized,
  sanitizedLiveProofEnvironment,
} from "./environment.js";
import { buildLiveVerificationResult } from "./verification.js";

const SERVER_LOG_TAIL_LINES = 40;
const SERVER_LOG_TAIL_MAX_BYTES = 64 * 1024;

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
  const baseRunner = dependencies.runner ?? mediaProofCommandRunner;
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

  // Every command that can load target code receives the same denylist- and
  // heuristic-sanitized environment, even for local callers that did not come
  // through the production review child.
  const targetEnvironment = sanitizedLiveProofEnvironment(env);
  assertLiveProofEnvironmentSanitized(targetEnvironment);
  const runner: MediaProofCommandRunner = (command, args, runOptions = {}) =>
    baseRunner(command, args, {
      ...runOptions,
      env: sanitizedLiveProofEnvironment({
        ...targetEnvironment,
        ...runOptions.env,
      }),
    });

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
  const capturedOutputPath = join(outputDir, "captured-output.txt");
  const scriptPath = join(outputDir, "live-proof-playwright.mjs");
  const serverLogPath = join(outputDir, "server.log");
  const serverPidPath = join(outputDir, "server.pid");
  const manifestPath = join(outputDir, "live-proof-manifest.json");
  const verificationPath = join(outputDir, "live-verification.json");
  for (const stalePath of [
    rawVideoPath,
    mp4Path,
    posterPath,
    stepsLogPath,
    capturedOutputPath,
    scriptPath,
    serverLogPath,
    serverPidPath,
    manifestPath,
    verificationPath,
  ]) {
    rmSync(stalePath, { force: true });
  }
  const recordMedia = plan.payoff.kind !== "static_text";

  let serverStarted = false;
  try {
    let drive: ReturnType<typeof driveBrowser>;
    try {
      ensureLiveProofPackageManager(
        profile.packageManager,
        runner,
        checkout,
        targetEnvironment,
        log,
      );
      for (const configuredCommand of liveTest.setup) {
        const command = liveProofSetupCommand(configuredCommand, liveTest.allowInstallScripts);
        requireSuccess("sh", ["-lc", command], runner("sh", ["-lc", command], { cwd: checkout }));
      }
      if (plan.surface === "browser") {
        const startCommand = `${liveTest.start} >${shellQuote(serverLogPath)} 2>&1 & echo $! >${shellQuote(serverPidPath)}`;
        requireSuccess(
          "sh",
          ["-lc", startCommand],
          runner("sh", ["-lc", startCommand], { cwd: checkout }),
        );
        serverStarted = true;
        waitUntilReady(
          liveTest.url!,
          liveTest.readyTimeoutSeconds,
          runner,
          checkout,
          serverLogPath,
          serverPidPath,
        );
      }

      drive =
        plan.surface === "browser"
          ? driveBrowser({
              plan,
              checkout,
              scriptPath,
              rawVideoPath,
              stepsLogPath,
              outputPath: capturedOutputPath,
              baseUrl: liveTest.url!,
              recordMedia,
              runner,
            })
          : driveTerminal({
              plan,
              checkout,
              rawVideoPath,
              maxRecordingSeconds: liveTest.maxRecordingSeconds,
              recordMedia,
              runner,
            });
    } catch (error) {
      const verifiedAt = (dependencies.now ?? (() => new Date()))().toISOString();
      const failure = executionFailure(error, plan.surface);
      writeVerificationResult({
        path: verificationPath,
        repo: profile.targetRepo,
        item: options.item,
        headSha,
        plan,
        driveStatus: "failed",
        stepLog: [],
        output: failure.output,
        executionFailureReason: failure.reason,
        verifiedAt,
      });
      log("[live-proof] execution failed; wrote verification result without media");
      return;
    }

    writeFileSync(stepsLogPath, `${JSON.stringify(drive.steps, null, 2)}\n`, "utf8");
    const verifiedAt = (dependencies.now ?? (() => new Date()))().toISOString();
    writeVerificationResult({
      path: verificationPath,
      repo: profile.targetRepo,
      item: options.item,
      headSha,
      plan,
      driveStatus: drive.status,
      stepLog: drive.steps,
      output: drive.output,
      verifiedAt,
    });

    if (drive.status === "failed") {
      log("[live-proof] verification failed; no recording will be attached");
      return;
    }
    if (!recordMedia) {
      log(
        `[live-proof] wrote ${plan.surface} verification bundle without media for ${profile.targetRepo}#${options.item} at ${headSha}`,
      );
      return;
    }
    if (!demonstratedChange(drive.steps)) {
      log("[live-proof] verification completed; media skipped because no expectation changed");
      return;
    }

    try {
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
      if (media.durationSeconds < 3) {
        rmSync(mp4Path, { force: true });
        log(
          "[live-proof] verification completed; media skipped because recording is shorter than 3 seconds",
        );
        return;
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
        recorded_at: verifiedAt,
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      log(
        `[live-proof] wrote ${plan.surface} proof bundle for ${profile.targetRepo}#${options.item} at ${headSha}`,
      );
    } catch (error) {
      for (const mediaPath of [mp4Path, posterPath, manifestPath]) {
        rmSync(mediaPath, { force: true });
      }
      log(
        `[live-proof] verification completed; media pipeline failed and was skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    if (serverStarted) stopBackgroundServer(serverPidPath, runner, checkout);
  }
}

export function liveProofSetupCommand(command: string, allowInstallScripts: boolean): string {
  // Repository live_test setup is maintainer-authored. Its direct package
  // manager installs are rewritten so a dependency lockfile bump cannot run a
  // postinstall that was never visible in the reviewed diff.
  const install = /^(\s*(?:pnpm|bun)\s+(?:install|i)\b|\s*npm\s+(?:install|i|ci)\b)/.exec(command);
  if (!install || allowInstallScripts) return command;
  if (/(?:^|\s)--(?:no-ignore-scripts|ignore-scripts=(?:false|0)|trust)(?:\s|$)/.test(command)) {
    throw new Error(
      "live_test.setup cannot enable install scripts without allow_install_scripts: true",
    );
  }
  if (/(?:^|\s)--ignore-scripts(?:=true)?(?:\s|$)/.test(command)) return command;
  return command.replace(install[0], `${install[0]} --ignore-scripts`);
}

export function liveProofPackageManagerInstallCommand(packageManager: string): string {
  switch (packageManager) {
    case "bun":
      return "curl -fsSL https://bun.sh/install | bash";
    case "pnpm":
      return "curl -fsSL https://get.pnpm.io/install.sh | sh -";
    case "npm":
      return "curl -fsSL https://www.npmjs.com/install.sh | sh";
    default:
      throw new Error(
        `unsupported live-proof package manager ${JSON.stringify(packageManager)}; expected bun, pnpm, or npm`,
      );
  }
}

export function ensureLiveProofPackageManager(
  packageManager: string,
  runner: MediaProofCommandRunner,
  checkout: string,
  environment: NodeJS.ProcessEnv,
  log: (message: string) => void = console.log,
): void {
  const installCommand = liveProofPackageManagerInstallCommand(packageManager);
  addPackageManagerToPath(packageManager, environment);
  const probe = () =>
    runner("sh", ["-lc", `command -v ${packageManager} >/dev/null 2>&1`], { cwd: checkout });
  if (probe().status === 0) return;

  const installed = runner("sh", ["-lc", installCommand], {
    cwd: checkout,
    timeoutMs: 2 * 60_000,
  });
  if (installed.status !== 0) {
    throw new Error(
      `could not install live-proof package manager ${packageManager} with official installer (${installCommand}): ${mediaProofSpawnDetail(installed)}`,
    );
  }
  addPackageManagerToPath(packageManager, environment);
  const verified = probe();
  if (verified.status !== 0) {
    throw new Error(
      `live-proof package manager ${packageManager} is unavailable after its official installer (${installCommand}): ${mediaProofSpawnDetail(verified)}`,
    );
  }
  log(`[live-proof] installed target package manager ${packageManager}: ${installCommand}`);
}

function addPackageManagerToPath(packageManager: string, environment: NodeJS.ProcessEnv): void {
  const home = environment.HOME?.trim();
  if (!home) return;
  const directory =
    packageManager === "bun"
      ? join(home, ".bun", "bin")
      : packageManager === "pnpm"
        ? environment.PNPM_HOME?.trim()
          ? join(environment.PNPM_HOME.trim(), "bin")
          : join(home, ".local", "share", "pnpm")
        : undefined;
  if (!directory) return;
  const path = environment.PATH ?? "";
  if (!path.split(":").includes(directory))
    environment.PATH = path ? `${directory}:${path}` : directory;
}

function writeVerificationResult(
  options: Parameters<typeof buildLiveVerificationResult>[0] & { path: string },
): void {
  const { path, ...resultOptions } = options;
  const verification = buildLiveVerificationResult(resultOptions);
  writeFileSync(path, `${JSON.stringify(verification, null, 2)}\n`, "utf8");
}

class StartupReadinessError extends Error {
  constructor(
    message: string,
    readonly logTail: string,
  ) {
    super(message);
    this.name = "StartupReadinessError";
  }
}

function executionFailure(
  error: unknown,
  surface: LiveProofPlan["surface"],
): { reason: string; output: string } {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof StartupReadinessError) {
    return { reason, output: error.logTail || "<no start command output captured>" };
  }
  return { reason, output: surface === "terminal" ? reason : "" };
}

function demonstratedChange(steps: readonly LiveProofStepLogEntry[]): boolean {
  return steps.some(
    (step) =>
      (step.action === "expect_text" || step.action === "expect_output") &&
      !step.presentAtStart &&
      step.satisfied &&
      step.detail !== TERMINAL_OUTPUT_NOT_OBSERVED_DETAIL,
  );
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
  serverLogPath: string,
  serverPidPath: string,
): void {
  const deadline = Date.now() + timeoutSeconds * 1000;
  do {
    const result = runner(
      "curl",
      ["--fail", "--silent", "--show-error", "--max-time", "3", "--output", "/dev/null", url],
      { cwd: checkout },
    );
    if (result.status === 0) return;
    if (!startCommandIsRunning(serverPidPath, runner, checkout)) {
      throw new StartupReadinessError(
        "start command exited before the URL became reachable",
        readServerLogTail(serverLogPath),
      );
    }
    if (Date.now() >= deadline) break;
    runner("sleep", ["1"]);
  } while (Date.now() < deadline);
  throw new StartupReadinessError(
    `live_test.url did not return HTTP 200 within ${timeoutSeconds} seconds`,
    readServerLogTail(serverLogPath),
  );
}

function startCommandIsRunning(
  serverPidPath: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): boolean {
  const command = `if [ -s ${shellQuote(serverPidPath)} ]; then pid=$(cat ${shellQuote(serverPidPath)}); kill -0 "$pid" 2>/dev/null; else exit 1; fi`;
  return runner("sh", ["-lc", command], { cwd: checkout }).status === 0;
}

function readServerLogTail(serverLogPath: string): string {
  if (!existsSync(serverLogPath)) return "";
  try {
    const size = statSync(serverLogPath).size;
    if (size === 0) return "";
    const length = Math.min(size, SERVER_LOG_TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const descriptor = openSync(serverLogPath, "r");
    let bytesRead: number;
    try {
      bytesRead = readSync(descriptor, buffer, 0, length, size - length);
    } finally {
      closeSync(descriptor);
    }
    const lines = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .replaceAll("\r\n", "\n")
      .replace(/\r/g, "\n")
      .split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-SERVER_LOG_TAIL_LINES).join("\n");
  } catch {
    return "<start command output unavailable>";
  }
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
