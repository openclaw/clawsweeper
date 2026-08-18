import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  LiveProofBrowserStep,
  LiveProofPlan,
  LiveProofStep,
  LiveProofTerminalStep,
  MediaProofCommandRunner,
} from "../clawsweeper-types.js";
import { mediaProofSpawnDetail } from "../clawsweeper-media-proof.js";
import type { LiveProofDriveStatus } from "./manifest.js";

interface LiveProofBaseStepLogEntry {
  action: string;
  status: "completed" | "failed";
  detail: string;
}

export type LiveProofStepLogEntry =
  | (LiveProofBaseStepLogEntry & {
      action: "expect_text" | "expect_output";
      presentAtStart: boolean;
      satisfied: boolean;
    })
  | (LiveProofBaseStepLogEntry & {
      action: Exclude<LiveProofStep["action"], "expect_text" | "expect_output">;
    });

export interface LiveProofDriveResult {
  status: LiveProofDriveStatus;
  steps: LiveProofStepLogEntry[];
  rawVideoPath: string;
  output: string;
}

const DISPLAY_READY_TIMEOUT_SECONDS = 30;
const RECORDER_READY_TIMEOUT_SECONDS = 15;
const RECORDER_FINALIZE_TIMEOUT_SECONDS = 20;
const TERMINAL_RUN_OUTPUT_TIMEOUT_SECONDS = 20;
const TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS = 30;
const STEP_SETTLE_MILLISECONDS = 700;
const END_STATE_HOLD_MILLISECONDS = 3_000;
const MINIMUM_RECORDING_MILLISECONDS = 6_000;

type TerminalCommandInvocation = {
  command: string;
  args: string[];
  waitAfter?: "display" | "recorder";
};

export function generatePlaywrightScript(steps: readonly LiveProofBrowserStep[]): string {
  const serializedSteps = JSON.stringify(JSON.stringify(steps))
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  // Resolve playwright-core from ClawSweeper's own installation: the generated
  // script lives in the output bundle and runs with the target checkout as cwd,
  // so bare-specifier resolution from either location would be placement luck.
  const requireBase = JSON.stringify(new URL("../../package.json", import.meta.url).href)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `import { copyFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const { chromium } = createRequire(new URL(${requireBase}))("playwright-core");

const steps = JSON.parse(${serializedSteps});
const baseUrl = process.env.CLAWSWEEPER_LIVE_PROOF_URL;
const entry = process.env.CLAWSWEEPER_LIVE_PROOF_ENTRY;
const output = process.env.CLAWSWEEPER_LIVE_PROOF_RAW_VIDEO;
const logPath = process.env.CLAWSWEEPER_LIVE_PROOF_STEPS_LOG;
const outputPath = process.env.CLAWSWEEPER_LIVE_PROOF_CAPTURED_OUTPUT;
const recordMedia = process.env.CLAWSWEEPER_LIVE_PROOF_RECORD_MEDIA === "1";
const useBundledChromium = process.env.CLAWSWEEPER_LIVE_PROOF_BROWSER === "chromium";
const headless = process.env.CLAWSWEEPER_LIVE_PROOF_HEADED !== "1";
if (!baseUrl || !entry || !output || !logPath || !outputPath) throw new Error("missing live proof driver environment");

const log = [];
let browser;
let context;
let page;
let video;
let failed = false;
let recordingStartedAt = 0;
try {
  browser = await chromium.launch(useBundledChromium ? { headless } : { headless, channel: "chrome" });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(recordMedia ? { recordVideo: { dir: output + ".videos", size: { width: 1280, height: 800 } } } : {}) });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  video = recordMedia ? page.video() : null;
  recordingStartedAt = Date.now();
  await page.goto(new URL(entry, baseUrl).href);
  const expectationPresentAtStart = new Map();
  for (const [index, step] of steps.entries()) {
    if (step.action !== "expect_text") continue;
    const locator = page.getByText(step.text, { exact: false }).first();
    expectationPresentAtStart.set(index, await locator.isVisible().catch(() => false));
  }
  for (const [index, step] of steps.entries()) {
    try {
      switch (step.action) {
        case "goto": await page.goto(new URL(step.path, baseUrl).href); break;
        case "click": {
          const locator = page.locator(step.target);
          // Best-effort framing only: continuously animated targets never
          // settle, and a failed scroll must not defeat the force-click below.
          await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
          // Fall back to a force click so continuously animated targets (whose
          // position never stabilizes) can still be demonstrated.
          try { await locator.click({ timeout: 5_000 }); }
          catch { await locator.click({ force: true }); }
          break;
        }
        case "fill": await page.locator(step.target).fill(step.value); break;
        case "press": await page.keyboard.press(step.key); break;
        case "wait_for": {
          const locator = page.locator(step.target);
          await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
          await locator.waitFor({ state: "visible" });
          break;
        }
        case "wait": await page.waitForTimeout(step.seconds * 1000); break;
        case "expect_text": {
          const locator = page.getByText(step.text, { exact: false }).first();
          await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
          await locator.waitFor({ state: "visible" });
          break;
        }
        default: throw new Error("unsupported browser action");
      }
      await page.waitForTimeout(${STEP_SETTLE_MILLISECONDS});
      log.push(step.action === "expect_text"
        ? { action: step.action, status: "completed", detail: "ok", presentAtStart: expectationPresentAtStart.get(index) === true, satisfied: true }
        : { action: step.action, status: "completed", detail: "ok" });
    } catch (error) {
      failed = true;
      log.push(step.action === "expect_text"
        ? { action: step.action, status: "failed", detail: error instanceof Error ? error.message : String(error), presentAtStart: expectationPresentAtStart.get(index) === true, satisfied: false }
        : { action: step.action, status: "failed", detail: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
  const elapsed = Date.now() - recordingStartedAt;
  await page.waitForTimeout(Math.max(${END_STATE_HOLD_MILLISECONDS}, ${MINIMUM_RECORDING_MILLISECONDS} - elapsed));
} finally {
  const capturedOutput = page ? await page.locator("body").innerText().catch(() => "") : "";
  await writeFile(outputPath, capturedOutput, "utf8");
  if (context) await context.close().catch(() => undefined);
  if (video) {
    const videoPath = await video.path().catch(() => "");
    if (videoPath) await copyFile(videoPath, output);
  }
  if (browser) await browser.close().catch(() => undefined);
  await writeFile(logPath, JSON.stringify(log, null, 2) + "\\n", "utf8");
}
if (failed) process.exitCode = 1;
`;
}

export function driveBrowser(options: {
  plan: LiveProofPlan;
  checkout: string;
  scriptPath: string;
  rawVideoPath: string;
  stepsLogPath: string;
  outputPath: string;
  baseUrl: string;
  recordMedia: boolean;
  runner: MediaProofCommandRunner;
}): LiveProofDriveResult {
  const steps = options.plan.steps as LiveProofBrowserStep[];
  writeFileSync(options.scriptPath, generatePlaywrightScript(steps), "utf8");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAWSWEEPER_LIVE_PROOF_URL: options.baseUrl,
    CLAWSWEEPER_LIVE_PROOF_ENTRY: options.plan.entry,
    CLAWSWEEPER_LIVE_PROOF_RAW_VIDEO: options.rawVideoPath,
    CLAWSWEEPER_LIVE_PROOF_STEPS_LOG: options.stepsLogPath,
    CLAWSWEEPER_LIVE_PROOF_CAPTURED_OUTPUT: options.outputPath,
    CLAWSWEEPER_LIVE_PROOF_RECORD_MEDIA: options.recordMedia ? "1" : "0",
  };
  let result = options.runner("node", [options.scriptPath], {
    cwd: options.checkout,
    env,
  });
  if (result.status !== 0 && browserLaunchUnavailable(result)) {
    const install = options.runner("npx", ["playwright", "install", "chromium"], {
      cwd: options.checkout,
    });
    if (install.status !== 0) {
      throw new Error(
        `Playwright Chromium fallback install failed: ${mediaProofSpawnDetail(install)}`,
      );
    }
    result = options.runner("node", [options.scriptPath], {
      cwd: options.checkout,
      env: { ...env, CLAWSWEEPER_LIVE_PROOF_BROWSER: "chromium" },
    });
  }
  const stepLog = readStepLog(options.stepsLogPath);
  if (options.recordMedia && !existsSync(options.rawVideoPath)) {
    throw new Error(`Playwright did not finalize a recording: ${mediaProofSpawnDetail(result)}`);
  }
  return {
    status: driveStatus(result.status, stepLog),
    steps: stepLog,
    rawVideoPath: options.rawVideoPath,
    output: existsSync(options.outputPath) ? readFileSync(options.outputPath, "utf8") : "",
  };
}

export function terminalCommandPlan(options: {
  sessionPrefix: string;
  maxRecordingSeconds: number;
  rawVideoPath: string;
  recordMedia?: boolean;
}): TerminalCommandInvocation[] {
  const terminalSession = `${options.sessionPrefix}-terminal`;
  const displaySession = `${options.sessionPrefix}-display`;
  const xtermSession = `${options.sessionPrefix}-xterm`;
  const recorderSession = `${options.sessionPrefix}-recorder`;
  const commands: TerminalCommandInvocation[] = [
    {
      command: "tmux",
      args: ["new-session", "-d", "-s", terminalSession, "-x", "160", "-y", "50"],
    },
  ];
  if (options.recordMedia === false) return commands;
  return [
    ...commands,
    {
      command: "tmux",
      args: ["new-session", "-d", "-s", displaySession],
    },
    {
      command: "tmux",
      args: ["set-option", "-w", "-t", `${displaySession}:0`, "remain-on-exit", "on"],
    },
    {
      command: "tmux",
      args: [
        "respawn-pane",
        "-k",
        "-t",
        `${displaySession}:0.0`,
        "Xvfb",
        ":99",
        "-screen",
        "0",
        "1280x800x24",
        "-nolisten",
        "tcp",
      ],
      waitAfter: "display",
    },
    {
      command: "tmux",
      args: [
        "new-session",
        "-d",
        "-s",
        xtermSession,
        "env",
        "DISPLAY=:99",
        "xterm",
        "-fullscreen",
        "-geometry",
        "160x50+0+0",
        "-e",
        "tmux",
        "attach-session",
        "-t",
        terminalSession,
      ],
    },
    {
      command: "tmux",
      args: ["new-session", "-d", "-s", recorderSession],
    },
    {
      command: "tmux",
      args: ["set-option", "-w", "-t", `${recorderSession}:0`, "remain-on-exit", "on"],
    },
    {
      command: "tmux",
      args: [
        "respawn-pane",
        "-k",
        "-t",
        `${recorderSession}:0.0`,
        "timeout",
        `${options.maxRecordingSeconds}s`,
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-f",
        "x11grab",
        "-video_size",
        "1280x800",
        "-framerate",
        "30",
        "-i",
        ":99.0",
        "-c:v",
        "libvpx-vp9",
        // Realtime tuning: default VP9 encoding cannot hold 30fps on a
        // two-core hosted runner and buffers output for seconds at a time.
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        // The WebM muxer buffers whole clusters in memory; flush packets so
        // the output file reflects capture progress immediately.
        "-flush_packets",
        "1",
        options.rawVideoPath,
      ],
      waitAfter: "recorder",
    },
  ];
}

interface TerminalOutputWindow {
  echoSnapshot: string;
}

export function driveTerminal(options: {
  plan: LiveProofPlan;
  checkout: string;
  rawVideoPath: string;
  maxRecordingSeconds: number;
  recordMedia?: boolean;
  runner: MediaProofCommandRunner;
}): LiveProofDriveResult {
  const sessionPrefix = `clawsweeper-live-proof-${process.pid}`;
  const terminalSession = `${sessionPrefix}-terminal`;
  const displaySession = `${sessionPrefix}-display`;
  const xtermSession = `${sessionPrefix}-xterm`;
  const recorderSession = `${sessionPrefix}-recorder`;
  const log: LiveProofStepLogEntry[] = [];
  let failed = false;
  let thrown: Error | undefined;
  let recordingStartedAt = 0;
  let outputWindow: TerminalOutputWindow | undefined;
  let initialPaneSnapshot = "";
  let capturedOutput = "";
  const recordMedia = options.recordMedia !== false;
  try {
    for (const invocation of terminalCommandPlan({
      sessionPrefix,
      maxRecordingSeconds: options.maxRecordingSeconds,
      rawVideoPath: options.rawVideoPath,
      recordMedia,
    })) {
      requireSuccess(
        invocation.command,
        invocation.args,
        options.runner(invocation.command, invocation.args, { cwd: options.checkout }),
      );
      if (invocation.waitAfter === "display") {
        waitForDisplay(options.runner, options.checkout);
      } else if (invocation.waitAfter === "recorder") {
        waitForRecorder(options.runner, options.checkout, recorderSession, options.rawVideoPath);
        recordingStartedAt = Date.now();
      }
    }
    initialPaneSnapshot = captureTerminalPane(
      options.runner,
      options.checkout,
      `${terminalSession}:0.0`,
    );
    try {
      outputWindow = runTerminalCommand(
        options.plan.entry,
        terminalSession,
        options.runner,
        options.checkout,
      );
    } catch {
      failed = true;
    }
    if (!failed) {
      for (const step of options.plan.steps as LiveProofTerminalStep[]) {
        try {
          outputWindow = runTerminalStep(
            step,
            terminalSession,
            options.runner,
            options.checkout,
            outputWindow,
          );
          log.push(
            step.action === "expect_output"
              ? {
                  action: step.action,
                  status: "completed",
                  detail: "ok",
                  presentAtStart: initialPaneSnapshot.includes(step.text),
                  satisfied: true,
                }
              : { action: step.action, status: "completed", detail: "ok" },
          );
        } catch (error) {
          failed = true;
          log.push(
            step.action === "expect_output"
              ? {
                  action: step.action,
                  status: "failed",
                  detail: error instanceof Error ? error.message : String(error),
                  presentAtStart: initialPaneSnapshot.includes(step.text),
                  satisfied: false,
                }
              : {
                  action: step.action,
                  status: "failed",
                  detail: error instanceof Error ? error.message : String(error),
                },
          );
          break;
        }
      }
    }
    capturedOutput = captureTerminalPane(
      options.runner,
      options.checkout,
      `${terminalSession}:0.0`,
    );
    if (recordMedia) {
      holdEndState(options.runner, recordingStartedAt);
      finalizeRecorder(options.runner, options.checkout, recorderSession);
      requireRecording(options.runner, options.checkout, options.rawVideoPath);
    }
  } catch (error) {
    thrown = terminalErrorWithDiagnostics(error, options.runner, options.checkout, {
      terminal: terminalSession,
      display: displaySession,
      xterm: xtermSession,
      recorder: recorderSession,
    });
  } finally {
    if (recordMedia) {
      options.runner("tmux", ["kill-session", "-t", recorderSession]);
      options.runner("tmux", ["kill-session", "-t", xtermSession]);
      options.runner("tmux", ["kill-session", "-t", displaySession]);
    }
    options.runner("tmux", ["kill-session", "-t", terminalSession]);
  }
  if (thrown) throw thrown;
  return {
    status: failed ? (log.length > 1 ? "partial" : "failed") : "completed",
    steps: log,
    rawVideoPath: options.rawVideoPath,
    output: capturedOutput,
  };
}

function waitForDisplay(runner: MediaProofCommandRunner, checkout: string): void {
  let lastResult: ReturnType<MediaProofCommandRunner> | undefined;
  for (let elapsed = 0; elapsed <= DISPLAY_READY_TIMEOUT_SECONDS; elapsed += 1) {
    lastResult = runner("xdpyinfo", ["-display", ":99"], { cwd: checkout });
    if (lastResult.status === 0) return;
    if (elapsed < DISPLAY_READY_TIMEOUT_SECONDS) pollSleep(runner);
  }
  throw new Error(
    `X display :99 was not ready after ${DISPLAY_READY_TIMEOUT_SECONDS} seconds: ${mediaProofSpawnDetail(lastResult!)}`,
  );
}

function waitForRecorder(
  runner: MediaProofCommandRunner,
  checkout: string,
  recorderSession: string,
  rawVideoPath: string,
): void {
  for (let elapsed = 0; elapsed <= RECORDER_READY_TIMEOUT_SECONDS; elapsed += 1) {
    const size = recordingSize(runner, checkout, rawVideoPath);
    if (recorderExited(runner, checkout, recorderSession)) {
      throw new Error("recorder session exited before the raw WebM was written");
    }
    if (size !== undefined && size > 0) return;
    // A live recorder session is sufficient: the WebM muxer may buffer whole
    // clusters in memory, so an empty file with ffmpeg alive is healthy. The
    // finalize wait plus ffprobe and the duration cap validate substance.
    if (elapsed >= RECORDER_READY_TIMEOUT_SECONDS) return;
    pollSleep(runner);
  }
  throw new Error(`raw WebM was not written within ${RECORDER_READY_TIMEOUT_SECONDS} seconds`);
}

function finalizeRecorder(
  runner: MediaProofCommandRunner,
  checkout: string,
  recorderSession: string,
): void {
  if (recorderExited(runner, checkout, recorderSession)) {
    throw new Error("recorder session exited before finalization");
  }
  const target = `${recorderSession}:0.0`;
  requireSuccess(
    "tmux",
    ["send-keys", "-t", target, "q"],
    runner("tmux", ["send-keys", "-t", target, "q"], { cwd: checkout }),
  );
  for (let elapsed = 0; elapsed <= RECORDER_FINALIZE_TIMEOUT_SECONDS; elapsed += 1) {
    if (recorderExited(runner, checkout, recorderSession)) return;
    if (elapsed < RECORDER_FINALIZE_TIMEOUT_SECONDS) pollSleep(runner);
  }
  throw new Error(
    `recorder session did not exit within ${RECORDER_FINALIZE_TIMEOUT_SECONDS} seconds after ffmpeg received q`,
  );
}

function recorderExited(
  runner: MediaProofCommandRunner,
  checkout: string,
  recorderSession: string,
): boolean {
  const result = runner(
    "tmux",
    ["display-message", "-p", "-t", `${recorderSession}:0.0`, "#{pane_dead}"],
    { cwd: checkout },
  );
  return result.status !== 0 || String(result.stdout ?? "").trim() === "1";
}

function recordingSize(
  runner: MediaProofCommandRunner,
  checkout: string,
  rawVideoPath: string,
): number | undefined {
  const result = runner("wc", ["-c", "--", rawVideoPath], { cwd: checkout });
  if (result.status !== 0) return undefined;
  const size = Number.parseInt(String(result.stdout ?? "").trim(), 10);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function requireRecording(
  runner: MediaProofCommandRunner,
  checkout: string,
  rawVideoPath: string,
): void {
  const size = recordingSize(runner, checkout, rawVideoPath);
  if (size === undefined || size === 0) {
    throw new Error("terminal driver did not finalize a recording");
  }
}

function pollSleep(runner: MediaProofCommandRunner): void {
  requireSuccess("sleep", ["1"], runner("sleep", ["1"]));
}

function terminalErrorWithDiagnostics(
  error: unknown,
  runner: MediaProofCommandRunner,
  checkout: string,
  sessions: Record<"terminal" | "display" | "xterm" | "recorder", string>,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = (Object.entries(sessions) as Array<[keyof typeof sessions, string]>).map(
    ([label, session]) => {
      const result = runner("tmux", ["capture-pane", "-p", "-t", `${session}:0.0`, "-S", "-40"], {
        cwd: checkout,
      });
      const output =
        result.status === 0
          ? lastLines(String(result.stdout ?? ""), 40) || "<empty>"
          : `<capture failed: ${mediaProofSpawnDetail(result)}>`;
      return `[${label}: ${session}]\n${output}`;
    },
  );
  return new Error(
    `${message}\n\nTerminal session diagnostics (last 40 lines):\n\n${diagnostics.join("\n\n")}`,
  );
}

function lastLines(value: string, count: number): string {
  return value.trimEnd().split("\n").slice(-count).join("\n");
}

function runTerminalStep(
  step: LiveProofTerminalStep,
  terminalSession: string,
  runner: MediaProofCommandRunner,
  checkout: string,
  outputWindow: TerminalOutputWindow | undefined,
): TerminalOutputWindow | undefined {
  if (step.action === "run") {
    return runTerminalCommand(step.command, terminalSession, runner, checkout);
  }
  if (step.action === "wait") {
    const seconds = String(step.seconds);
    requireSuccess("sleep", [seconds], runner("sleep", [seconds]));
    return outputWindow;
  }
  if (!outputWindow) {
    throw new Error("expected terminal output without a preceding command");
  }
  const target = `${terminalSession}:0.0`;
  let capturedPane = "";
  for (let elapsed = 0; elapsed <= TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS; elapsed += 1) {
    capturedPane = captureTerminalPane(runner, checkout, target);
    const output = paneContentAfterSnapshot(outputWindow.echoSnapshot, capturedPane);
    if (output.includes(step.text)) return outputWindow;
    if (elapsed < TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS) pollSleep(runner);
  }
  throw new Error(
    `expected terminal output was not visible within ${TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS} seconds: ${JSON.stringify(step.text)}\n\nCaptured pane:\n${capturedPane || "<empty>"}`,
  );
}

function runTerminalCommand(
  command: string,
  terminalSession: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): TerminalOutputWindow {
  const target = `${terminalSession}:0.0`;
  captureTerminalPane(runner, checkout, target);
  requireSuccess(
    "tmux",
    ["send-keys", "-t", target, "-l", "--", command],
    runner("tmux", ["send-keys", "-t", target, "-l", "--", command], { cwd: checkout }),
  );
  const echoSnapshot = captureTerminalPane(runner, checkout, target);
  requireSuccess(
    "tmux",
    ["send-keys", "-t", target, "Enter"],
    runner("tmux", ["send-keys", "-t", target, "Enter"], { cwd: checkout }),
  );
  let capturedPane = echoSnapshot;
  for (let elapsed = 0; elapsed <= TERMINAL_RUN_OUTPUT_TIMEOUT_SECONDS; elapsed += 1) {
    capturedPane = captureTerminalPane(runner, checkout, target);
    if (paneContentAfterSnapshot(echoSnapshot, capturedPane).trim()) {
      return { echoSnapshot };
    }
    if (elapsed < TERMINAL_RUN_OUTPUT_TIMEOUT_SECONDS) pollSleep(runner);
  }
  throw new Error(
    `terminal command did not produce output within ${TERMINAL_RUN_OUTPUT_TIMEOUT_SECONDS} seconds: ${JSON.stringify(command)}\n\nCaptured pane:\n${capturedPane || "<empty>"}`,
  );
}

function captureTerminalPane(
  runner: MediaProofCommandRunner,
  checkout: string,
  target: string,
): string {
  const args = ["capture-pane", "-p", "-t", target, "-S", "-200"];
  const capture = runner("tmux", args, { cwd: checkout });
  requireSuccess("tmux", args, capture);
  return String(capture.stdout ?? "");
}

function paneContentAfterSnapshot(snapshot: string, current: string): string {
  const before = snapshot.split("\n");
  const after = current.split("\n");
  let firstChangedLine = 0;
  while (
    firstChangedLine < before.length &&
    firstChangedLine < after.length &&
    before[firstChangedLine] === after[firstChangedLine]
  ) {
    firstChangedLine += 1;
  }
  return after.slice(firstChangedLine).join("\n");
}

function holdEndState(runner: MediaProofCommandRunner, recordingStartedAt: number): void {
  const elapsed = Math.max(0, Date.now() - recordingStartedAt);
  const holdMilliseconds = Math.max(
    END_STATE_HOLD_MILLISECONDS,
    MINIMUM_RECORDING_MILLISECONDS - elapsed,
  );
  const holdSeconds = String(Math.ceil(holdMilliseconds / 1000));
  requireSuccess("sleep", [holdSeconds], runner("sleep", [holdSeconds]));
}

function readStepLog(path: string): LiveProofStepLogEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is LiveProofStepLogEntry => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as Record<string, unknown>;
      return (
        typeof record.action === "string" &&
        (record.status === "completed" || record.status === "failed") &&
        typeof record.detail === "string" &&
        (record.action !== "expect_text" && record.action !== "expect_output"
          ? true
          : typeof record.presentAtStart === "boolean" && typeof record.satisfied === "boolean")
      );
    });
  } catch {
    return [];
  }
}

function browserLaunchUnavailable(result: ReturnType<MediaProofCommandRunner>): boolean {
  return /executable.*(?:doesn.t exist|not found)|chrome.*not found|browserType\.launch/i.test(
    `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`,
  );
}

function driveStatus(
  status: number | null,
  steps: readonly LiveProofStepLogEntry[],
): LiveProofDriveStatus {
  if (status === 0 && steps.every((step) => step.status === "completed")) return "completed";
  return steps.some((step) => step.status === "completed") ? "partial" : "failed";
}

function requireSuccess(
  command: string,
  args: readonly string[],
  result: ReturnType<MediaProofCommandRunner>,
): void {
  if (result.status === 0) return;
  throw new Error(`${command} ${args.join(" ")} failed: ${mediaProofSpawnDetail(result)}`);
}

export function liveProofStepActions(steps: readonly LiveProofStep[]): string[] {
  return steps.map((step) => step.action);
}
