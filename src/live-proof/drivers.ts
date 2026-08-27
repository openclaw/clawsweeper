import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { stripVTControlCharacters } from "node:util";
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
const TERMINAL_COMMAND_START_TIMEOUT_SECONDS = 10;
const TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS = 30;
const TERMINAL_READY_STABILITY_SECONDS = 3;
const STEP_SETTLE_MILLISECONDS = 700;
const END_STATE_HOLD_MILLISECONDS = 3_000;
const MINIMUM_RECORDING_MILLISECONDS = 6_000;
const TERMINAL_STREAM_MAX_BYTES = 1_000_000;
const TERMINAL_HISTORY_LINES = 50_000;
const TERMINAL_CAPTURE_CHUNK_BYTES = 64 * 1024;

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
  // Browser publication is step telemetry only. Never serialize document text
  // into the bundle: arbitrary rendered application content is not proof.
  await writeFile(outputPath, "", "utf8");
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
  const terminalPane = `${terminalSession}:0.0`;
  const displaySession = `${options.sessionPrefix}-display`;
  const xtermSession = `${options.sessionPrefix}-xterm`;
  const recorderSession = `${options.sessionPrefix}-recorder`;
  const commands: TerminalCommandInvocation[] = [
    {
      command: "tmux",
      args: [
        "new-session",
        "-d",
        "-s",
        terminalSession,
        "-x",
        "160",
        "-y",
        "50",
        "/bin/bash --noprofile --norc",
      ],
    },
    {
      command: "tmux",
      args: ["set-option", "-t", terminalSession, "history-limit", String(TERMINAL_HISTORY_LINES)],
    },
    {
      command: "tmux",
      args: ["set-option", "-t", terminalSession, "base-index", "0"],
    },
    {
      command: "tmux",
      args: ["move-window", "-r", "-t", terminalSession],
    },
    {
      command: "tmux",
      args: ["new-window", "-d", "-t", `${terminalSession}:`, "/bin/bash --noprofile --norc"],
    },
    {
      command: "tmux",
      args: ["resize-window", "-t", `${terminalSession}:1`, "-x", "160", "-y", "50"],
    },
    {
      command: "tmux",
      args: ["kill-window", "-t", `${terminalSession}:0`],
    },
    {
      command: "tmux",
      args: ["move-window", "-r", "-t", terminalSession],
    },
    {
      command: "tmux",
      args: ["set-option", "-w", "-t", `${terminalSession}:0`, "pane-base-index", "0"],
    },
    {
      command: "tmux",
      args: ["set-option", "-w", "-t", terminalPane, "remain-on-exit", "on"],
    },
    {
      command: "tmux",
      args: ["set-option", "-w", "-t", terminalPane, "remain-on-exit-format", ""],
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
      args: ["set-option", "-w", "-t", displaySession, "remain-on-exit", "on"],
    },
    {
      command: "tmux",
      args: [
        "respawn-pane",
        "-k",
        "-t",
        displaySession,
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
      args: ["set-option", "-w", "-t", recorderSession, "remain-on-exit", "on"],
    },
    {
      command: "tmux",
      args: [
        "respawn-pane",
        "-k",
        "-t",
        recorderSession,
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
  command: string;
  files: TerminalCommandFiles;
  launchMode: TerminalLaunchMode;
  chunks: Buffer[];
  expectations: readonly string[];
  observedExpectations: Set<string>;
  panePid?: number;
  frozenExit?: Extract<TerminalPaneState, { status: "exited" }>;
  finalizedExitStatus?: number;
  captureOpen: boolean;
  processGroupCleaned: boolean;
  finalViewport?: string;
}

interface TerminalCommandFiles {
  command: string;
  captureScript: string;
  capture: string;
  captureTemporary: string;
  captureDone: string;
  captureDoneTemporary: string;
  status: string;
  statusTemporary: string;
  release: string;
  releaseTemporary: string;
  start: string;
  startTemporary: string;
  ready: string;
  readyTemporary: string;
}

type TerminalLaunchMode = "held" | "direct";

interface TerminalStepResult {
  outputWindow: TerminalOutputWindow | undefined;
  expectationSatisfied?: boolean;
  detail?: string;
}

class TerminalCommandExecutionError extends Error {
  constructor(
    message: string,
    readonly window: TerminalOutputWindow,
  ) {
    super(message);
    this.name = "TerminalCommandExecutionError";
  }
}

type TerminalPaneState =
  | { status: "running"; pid: number }
  | { status: "exited"; pid: number; exitStatus: number };

function generateTerminalCaptureScript(): string {
  return `import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";

const [capturePath, captureTemporaryPath, donePath, doneTemporaryPath] = process.argv.slice(2);
if (!capturePath || !captureTemporaryPath || !donePath || !doneTemporaryPath) {
  throw new Error("missing terminal capture paths");
}
const maxBytes = ${TERMINAL_STREAM_MAX_BYTES};
const chunks = [];
let byteLength = 0;
let finished = false;

function retain(chunk) {
  chunks.push(chunk);
  byteLength += chunk.length;
  while (byteLength > maxBytes && chunks.length > 0) {
    const excess = byteLength - maxBytes;
    const first = chunks[0];
    if (first.length <= excess) {
      chunks.shift();
      byteLength -= first.length;
    } else {
      chunks[0] = first.subarray(excess);
      byteLength -= excess;
    }
  }
}

function writeAtomic(path, temporaryPath, value) {
  const fd = openSync(temporaryPath, "w", 0o600);
  try {
    writeSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporaryPath, path);
}

function finish(completion = "eof") {
  if (finished) return;
  finished = true;
  writeAtomic(capturePath, captureTemporaryPath, Buffer.concat(chunks, byteLength));
  writeAtomic(donePath, doneTemporaryPath, completion + "\\n");
}

process.stdin.on("data", (chunk) => {
  const bytes = Buffer.from(chunk);
  retain(bytes);
});
process.stdin.on("end", finish);
process.stdin.on("close", finish);
process.stdin.on("error", (error) => {
  process.stderr.write(String(error) + "\\n");
  process.exitCode = 1;
  finish("error");
});
process.stdin.resume();
`;
}

export function driveTerminal(options: {
  plan: LiveProofPlan;
  checkout: string;
  rawVideoPath: string;
  maxRecordingSeconds: number;
  recordMedia?: boolean;
  runner: MediaProofCommandRunner;
}): LiveProofDriveResult {
  const sessionPrefix = `clawsweeper-live-proof-${process.pid}-${randomUUID()}`;
  const terminalSession = `${sessionPrefix}-terminal`;
  const terminalPane = `${terminalSession}:0.0`;
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
  let failureReason = "";
  const recordMedia = options.recordMedia !== false;
  const privatePaths: string[] = [];
  const commandWindows: TerminalOutputWindow[] = [];
  let commandIndex = 0;
  let terminalDeadline = 0;
  const totalCommands = 1 + options.plan.steps.filter((step) => step.action === "run").length;
  const nextCommand = (): { files: TerminalCommandFiles; launchMode: TerminalLaunchMode } => {
    const prefix = `${options.rawVideoPath}.command-${process.pid}-${commandIndex}`;
    const isFinalCommand = commandIndex === totalCommands - 1;
    commandIndex += 1;
    const files = {
      command: `${prefix}.sh`,
      captureScript: `${prefix}.capture.mjs`,
      capture: `${prefix}.combined.log`,
      captureTemporary: `${prefix}.combined.tmp`,
      captureDone: `${prefix}.capture.done`,
      captureDoneTemporary: `${prefix}.capture.done.tmp`,
      status: `${prefix}.status`,
      statusTemporary: `${prefix}.status.tmp`,
      release: `${prefix}.release`,
      releaseTemporary: `${prefix}.release.tmp`,
      start: `${prefix}.start`,
      startTemporary: `${prefix}.start.tmp`,
      ready: `${prefix}.ready`,
      readyTemporary: `${prefix}.ready.tmp`,
    };
    privatePaths.push(...Object.values(files));
    return {
      files,
      launchMode:
        isFinalCommand && options.plan.terminalCompletion === "ready_while_running"
          ? "direct"
          : "held",
    };
  };
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
    const expectations = terminalExpectations(options.plan);
    terminalDeadline = Date.now() + options.maxRecordingSeconds * 1_000;
    initialPaneSnapshot = captureTerminalPane(options.runner, options.checkout, terminalPane);
    try {
      const command = nextCommand();
      outputWindow = runTerminalCommand(
        options.plan.entry,
        terminalPane,
        options.runner,
        options.checkout,
        command.files,
        expectations,
        command.launchMode,
        terminalDeadline,
      );
      commandWindows.push(outputWindow);
    } catch (error) {
      failed = true;
      if (error instanceof TerminalCommandExecutionError) {
        outputWindow = error.window;
        commandWindows.push(error.window);
      }
      failureReason = terminalPrivateErrorMessage(error, privatePaths);
    }
    if (!failed) {
      for (const step of options.plan.steps as LiveProofTerminalStep[]) {
        try {
          const result = runTerminalStep(
            step,
            terminalPane,
            options.runner,
            options.checkout,
            outputWindow,
            nextCommand,
            expectations,
            terminalDeadline,
          );
          if (result.outputWindow && result.outputWindow !== outputWindow) {
            commandWindows.push(result.outputWindow);
          }
          outputWindow = result.outputWindow;
          log.push(
            step.action === "expect_output"
              ? {
                  action: step.action,
                  status: "completed",
                  detail: result.detail ?? "ok",
                  presentAtStart: initialPaneSnapshot.includes(step.text),
                  satisfied: result.expectationSatisfied === true,
                }
              : { action: step.action, status: "completed", detail: "ok" },
          );
        } catch (error) {
          failed = true;
          if (error instanceof TerminalCommandExecutionError) {
            outputWindow = error.window;
            commandWindows.push(error.window);
          }
          failureReason = terminalPrivateErrorMessage(error, privatePaths);
          log.push(
            step.action === "expect_output"
              ? {
                  action: step.action,
                  status: "failed",
                  detail: failureReason,
                  presentAtStart: initialPaneSnapshot.includes(step.text),
                  satisfied: false,
                }
              : {
                  action: step.action,
                  status: "failed",
                  detail: failureReason,
                },
          );
          break;
        }
      }
    }
    const validateCurrentCommand = (cutover: boolean) => {
      if (!outputWindow || failed) return;
      try {
        validateFinalTerminalCommand(
          outputWindow,
          options.plan.terminalCompletion,
          terminalPane,
          options.runner,
          options.checkout,
          cutover,
          terminalDeadline,
        );
      } catch (error) {
        failed = true;
        failureReason = terminalPrivateErrorMessage(error, privatePaths);
        const previousStep = log.at(-1);
        if (previousStep) {
          previousStep.status = "failed";
          previousStep.detail = failureReason;
          if (previousStep.action === "expect_output" || previousStep.action === "expect_text") {
            previousStep.satisfied = false;
          }
        }
      }
    };
    if (!recordMedia && !failed && options.plan.terminalCompletion === "ready_while_running") {
      sleepWithinTerminalBudget(options.runner, TERMINAL_READY_STABILITY_SECONDS, terminalDeadline);
    }
    validateCurrentCommand(!recordMedia);
    if (recordMedia) {
      if (!failed) holdEndState(options.runner, recordingStartedAt, terminalDeadline);
      validateCurrentCommand(false);
      finalizeRecorder(options.runner, options.checkout, recorderSession);
      validateCurrentCommand(true);
      requireRecording(options.runner, options.checkout, options.rawVideoPath);
    }
    if (failed) {
      for (const window of commandWindows) {
        try {
          if (window.captureOpen) {
            refreshTerminalCommandOutput(window, options.runner, options.checkout, terminalPane);
            closeTerminalCapture(window, options.runner, options.checkout, terminalPane);
          }
        } catch (error) {
          const captureFailure = terminalPrivateErrorMessage(error, privatePaths);
          failureReason = failureReason ? `${failureReason}; ${captureFailure}` : captureFailure;
        }
      }
      capturedOutput = terminalPrivateErrorMessage(
        renderFailedTerminalOutput(commandWindows, failureReason),
        privatePaths,
      );
    } else {
      const viewport =
        outputWindow?.finalViewport ??
        captureTerminalViewport(options.runner, options.checkout, terminalPane);
      capturedOutput = terminalPrivateErrorMessage(
        viewport.trim() ? viewport.replace(/\n$/, "") : "",
        privatePaths,
      );
    }
  } catch (error) {
    const diagnosticError = terminalErrorWithDiagnostics(error, options.runner, options.checkout, {
      terminal: terminalPane,
      display: displaySession,
      xterm: xtermSession,
      recorder: recorderSession,
    });
    thrown = new Error(terminalPrivateErrorMessage(diagnosticError, privatePaths));
  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    for (const window of commandWindows) {
      cleanup(() => closeTerminalCapture(window, options.runner, options.checkout, terminalPane));
      cleanup(() => cleanupTerminalWindow(window, options.runner, options.checkout));
    }
    if (recordMedia) {
      cleanup(() => {
        options.runner("tmux", ["kill-session", "-t", recorderSession]);
      });
      cleanup(() => {
        options.runner("tmux", ["kill-session", "-t", xtermSession]);
      });
      cleanup(() => {
        options.runner("tmux", ["kill-session", "-t", displaySession]);
      });
    }
    cleanup(() => {
      options.runner("tmux", ["kill-session", "-t", terminalSession]);
    });
    for (const privatePath of privatePaths) {
      cleanup(() => rmSync(privatePath, { force: true }));
    }
    if (cleanupErrors.length > 0) {
      thrown = new AggregateError(
        thrown ? [thrown, ...cleanupErrors] : cleanupErrors,
        thrown ? "terminal proof and cleanup failed" : "terminal cleanup failed",
      );
    }
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
  const target = recorderSession;
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
  const result = runner("tmux", ["display-message", "-p", "-t", recorderSession, "#{pane_dead}"], {
    cwd: checkout,
  });
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
      const result = runner("tmux", ["capture-pane", "-p", "-t", session, "-S", "-40"], {
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
  terminalPane: string,
  runner: MediaProofCommandRunner,
  checkout: string,
  outputWindow: TerminalOutputWindow | undefined,
  nextCommand: () => { files: TerminalCommandFiles; launchMode: TerminalLaunchMode },
  expectations: readonly string[],
  terminalDeadline: number,
): TerminalStepResult {
  if (step.action === "run") {
    if (outputWindow) {
      try {
        requireTerminalCommandExitZero(
          outputWindow,
          terminalPane,
          runner,
          checkout,
          terminalDeadline,
          true,
        );
        cleanupTerminalWindow(outputWindow, runner, checkout);
      } catch (error) {
        throw new Error(
          `terminal run was blocked by the previous command: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    const command = nextCommand();
    return {
      outputWindow: runTerminalCommand(
        step.command,
        terminalPane,
        runner,
        checkout,
        command.files,
        expectations,
        command.launchMode,
        terminalDeadline,
      ),
    };
  }
  if (step.action === "wait") {
    sleepWithinTerminalBudget(runner, step.seconds, terminalDeadline);
    return { outputWindow };
  }
  if (!outputWindow) {
    throw new Error("expected terminal output without a preceding command");
  }
  for (let elapsed = 0; elapsed <= TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS; elapsed += 1) {
    refreshTerminalCommandOutput(outputWindow, runner, checkout, terminalPane);
    if (outputWindow.observedExpectations.has(step.text)) {
      return { outputWindow, expectationSatisfied: true };
    }
    if (outputWindow.launchMode === "held") {
      const status = readHeldTerminalStatus(outputWindow);
      if (status !== undefined) {
        finalizeHeldTerminalCommand(outputWindow, status, terminalPane, runner, checkout);
        if (outputWindow.observedExpectations.has(step.text)) {
          return { outputWindow, expectationSatisfied: true };
        }
        if (status !== 0) throw terminalCommandFailure(outputWindow, status);
        throw new Error(
          `terminal command exited successfully before expected output appeared: ${JSON.stringify(step.text)}`,
        );
      }
      const state = readTerminalCommandState(outputWindow, runner, checkout, terminalPane);
      if (state?.status === "exited") {
        throw new Error("held terminal command exited before recording its completion status");
      }
    } else {
      const state = readTerminalCommandState(outputWindow, runner, checkout, terminalPane);
      if (state?.status !== "exited") {
        if (elapsed < TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS) {
          pollTerminalSleep(runner, terminalDeadline);
        }
        continue;
      }
      refreshTerminalCommandOutput(outputWindow, runner, checkout, terminalPane);
      closeTerminalCapture(outputWindow, runner, checkout, terminalPane);
      observeTerminalSnapshot(
        outputWindow,
        captureTerminalHistory(runner, checkout, terminalPane).replaceAll(
          outputWindow.files.command,
          "<private command>",
        ),
      );
      if (outputWindow.observedExpectations.has(step.text)) {
        return { outputWindow, expectationSatisfied: true };
      }
      if (state.exitStatus !== 0) throw terminalCommandFailure(outputWindow, state.exitStatus);
      throw new Error(
        `terminal command exited successfully before expected output appeared: ${JSON.stringify(step.text)}`,
      );
    }
    if (elapsed < TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS) {
      pollTerminalSleep(runner, terminalDeadline);
    }
  }
  refreshTerminalCommandOutput(outputWindow, runner, checkout, terminalPane);
  if (outputWindow.observedExpectations.has(step.text)) {
    return { outputWindow, expectationSatisfied: true };
  }
  throw new Error(
    `expected terminal output was not visible within ${TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS} seconds: ${JSON.stringify(step.text)}`,
  );
}

function runTerminalCommand(
  command: string,
  terminalPane: string,
  runner: MediaProofCommandRunner,
  checkout: string,
  files: TerminalCommandFiles,
  expectations: readonly string[],
  launchMode: TerminalLaunchMode,
  terminalDeadline: number,
): TerminalOutputWindow {
  const target = terminalPane;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const path of Object.values(files)) rmSync(path, { force: true });
  writeFileSync(files.command, command.endsWith("\n") ? command : `${command}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(files.captureScript, generateTerminalCaptureScript(), {
    encoding: "utf8",
    mode: 0o600,
  });
  const window: TerminalOutputWindow = {
    command,
    files,
    launchMode,
    chunks: [],
    expectations,
    observedExpectations: new Set(),
    captureOpen: false,
    processGroupCleaned: false,
  };
  const clearHistoryArgs = ["clear-history", "-t", target];
  requireSuccess("tmux", clearHistoryArgs, runner("tmux", clearHistoryArgs, { cwd: checkout }));
  try {
    // The start gate keeps the pane alive while capture attaches, so fast
    // commands cannot emit before pipe-pane owns their output.
    const commandRunner =
      launchMode === "held"
        ? [
            'while [ ! -e "$5" ]; do sleep 0.05; done',
            "builtin printf '\\033[2J\\033[H'",
            'builtin printf "ready\\n" >"$6"',
            'mv -f -- "$6" "$7"',
            '/bin/bash --noprofile --norc "$1"',
            "status=$?",
            'builtin printf "%s\\n" "$status" >"$2"',
            'mv -f -- "$2" "$3"',
            'while [ ! -e "$4" ]; do sleep 0.05; done',
            'exit "$status"',
          ].join("; ")
        : [
            'while [ ! -e "$5" ]; do sleep 0.05; done',
            "builtin printf '\\033[2J\\033[H'",
            'builtin printf "ready\\n" >"$6"',
            'mv -f -- "$6" "$7"',
            'exec /bin/bash --noprofile --norc "$1"',
          ].join("; ");
    const shellCommand =
      `/usr/bin/env -u TMUX -u TMUX_PANE /bin/bash --noprofile --norc -c ${quote(commandRunner)} ` +
      [
        "clawsweeper-terminal",
        files.command,
        files.statusTemporary,
        files.status,
        files.release,
        files.start,
        files.readyTemporary,
        files.ready,
      ]
        .map(quote)
        .join(" ");
    const respawnArgs = ["respawn-pane", "-k", "-t", target, "-c", checkout, shellCommand];
    requireSuccess("tmux", respawnArgs, runner("tmux", respawnArgs, { cwd: checkout }));
    const captureCommand =
      `/usr/bin/env -u TMUX -u TMUX_PANE node ${quote(files.captureScript)} ` +
      [files.capture, files.captureTemporary, files.captureDone, files.captureDoneTemporary]
        .map(quote)
        .join(" ");
    const pipeArgs = ["pipe-pane", "-O", "-t", target, captureCommand];
    requireSuccess("tmux", pipeArgs, runner("tmux", pipeArgs, { cwd: checkout }));
    window.captureOpen = true;
    writeFileSync(files.startTemporary, "start\n", { encoding: "utf8", mode: 0o600 });
    renameSync(files.startTemporary, files.start);
  } catch (error) {
    throw new TerminalCommandExecutionError(
      error instanceof Error ? error.message : String(error),
      window,
    );
  }
  for (let elapsed = 0; elapsed <= TERMINAL_COMMAND_START_TIMEOUT_SECONDS; elapsed += 1) {
    const panePid = readTerminalPanePid(runner, checkout, terminalPane);
    if (panePid) {
      window.panePid = panePid;
      try {
        const state = readTerminalCommandState(window, runner, checkout, terminalPane);
        const readiness = readBoundedTerminalFile(files.ready, 64);
        if (readiness !== undefined) {
          if (readiness !== "ready\n") {
            throw new Error("terminal command readiness acknowledgement is malformed");
          }
          refreshTerminalCommandOutput(window, runner, checkout, terminalPane);
          return window;
        }
        if (state?.status === "exited") {
          throw new Error("terminal command exited before clearing its pane");
        }
      } catch (error) {
        throw new TerminalCommandExecutionError(
          error instanceof Error ? error.message : String(error),
          window,
        );
      }
    }
    if (elapsed < TERMINAL_COMMAND_START_TIMEOUT_SECONDS) {
      pollTerminalSleep(runner, terminalDeadline);
    }
  }
  throw new TerminalCommandExecutionError(
    `terminal command pane did not start within ${TERMINAL_COMMAND_START_TIMEOUT_SECONDS} seconds: ${JSON.stringify(command)}`,
    window,
  );
}

function validateFinalTerminalCommand(
  window: TerminalOutputWindow,
  completion: LiveProofPlan["terminalCompletion"],
  terminalPane: string,
  runner: MediaProofCommandRunner,
  checkout: string,
  cutover: boolean,
  terminalDeadline: number,
): void {
  if (completion === "exit_zero") {
    if (window.launchMode !== "held") {
      throw new Error("exit_zero terminal proof did not use held command supervision");
    }
    requireTerminalCommandExitZero(
      window,
      terminalPane,
      runner,
      checkout,
      terminalDeadline,
      cutover,
    );
    return;
  }
  if (completion !== "ready_while_running") {
    throw new Error("terminal proof is missing a terminal completion contract");
  }
  if (window.launchMode !== "direct") {
    throw new Error("ready_while_running terminal proof did not execute the target directly");
  }
  if (window.observedExpectations.size === 0) {
    throw new Error("ready_while_running terminal proof requires a satisfied output expectation");
  }
  refreshTerminalCommandOutput(window, runner, checkout, terminalPane);
  const state = readTerminalCommandState(window, runner, checkout, terminalPane);
  if (state?.status === "running") {
    if (cutover) {
      try {
        closeTerminalCapture(window, runner, checkout, terminalPane);
      } catch (error) {
        const sealedState = readTerminalCommandState(window, runner, checkout, terminalPane);
        if (sealedState?.status === "exited") {
          throw new Error(
            `ready_while_running terminal command exited after satisfying its expectation: ${terminalCommandFailure(window, sealedState.exitStatus).message}`,
            { cause: error },
          );
        }
        throw error;
      }
      window.finalViewport = captureTerminalViewport(runner, checkout, terminalPane);
      const sealedState = readTerminalCommandState(window, runner, checkout, terminalPane);
      if (sealedState?.status === "exited") {
        throw new Error(
          `ready_while_running terminal command exited after satisfying its expectation: ${terminalCommandFailure(window, sealedState.exitStatus).message}`,
        );
      }
      if (sealedState?.status !== "running") {
        throw new Error("ready_while_running terminal command has no authoritative process state");
      }
    }
    return;
  }
  if (state?.status === "exited") {
    throw new Error(
      `ready_while_running terminal command exited after satisfying its expectation: ${terminalCommandFailure(window, state.exitStatus).message}`,
    );
  }
  throw new Error("ready_while_running terminal command has no authoritative process state");
}

function requireTerminalCommandExitZero(
  window: TerminalOutputWindow,
  terminalPane: string,
  runner: MediaProofCommandRunner,
  checkout: string,
  terminalDeadline: number,
  cutover: boolean,
): void {
  if (window.launchMode !== "held") {
    throw new Error("terminal command is not using held supervision");
  }
  if (window.finalizedExitStatus !== undefined) {
    if (window.finalizedExitStatus !== 0) {
      throw terminalCommandFailure(window, window.finalizedExitStatus);
    }
    return;
  }
  const timeoutSeconds = remainingTerminalBudgetSeconds(terminalDeadline);
  for (let elapsed = 0; elapsed <= timeoutSeconds; elapsed += 1) {
    refreshTerminalCommandOutput(window, runner, checkout, terminalPane);
    const status = readHeldTerminalStatus(window);
    if (status !== undefined) {
      if (cutover) {
        finalizeHeldTerminalCommand(window, status, terminalPane, runner, checkout);
      }
      if (status !== 0) throw terminalCommandFailure(window, status);
      return;
    }
    const state = readTerminalCommandState(window, runner, checkout, terminalPane);
    if (state?.status === "exited") {
      throw new Error("held terminal command exited before recording its completion status");
    }
    if (elapsed < timeoutSeconds) pollTerminalSleep(runner, terminalDeadline);
  }
  refreshTerminalCommandOutput(window, runner, checkout, terminalPane);
  const status = readHeldTerminalStatus(window);
  if (status !== undefined) {
    if (cutover) {
      finalizeHeldTerminalCommand(window, status, terminalPane, runner, checkout);
    }
    if (status !== 0) throw terminalCommandFailure(window, status);
    return;
  }
  const state = readTerminalCommandState(window, runner, checkout, terminalPane);
  if (state?.status === "exited") {
    throw new Error("held terminal command exited before recording its completion status");
  }
  throw new Error(
    `terminal command was still running after ${timeoutSeconds} seconds: ${JSON.stringify(window.command)}`,
  );
}

function readHeldTerminalStatus(window: TerminalOutputWindow): number | undefined {
  const statusText = readBoundedTerminalFile(window.files.status, 64);
  if (statusText === undefined) return undefined;
  const raw = statusText.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error("held terminal command status is malformed");
  }
  const status = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(status) || status < 0 || status > 255) {
    throw new Error("held terminal command status is malformed");
  }
  return status;
}

function finalizeHeldTerminalCommand(
  window: TerminalOutputWindow,
  recordedStatus: number,
  terminalPane: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  const heldState = readTerminalCommandState(window, runner, checkout, terminalPane);
  if (heldState?.status !== "running") {
    throw new Error("held terminal command wrapper exited before controller release");
  }
  // The wrapper remains the live pane owner until the stream and viewport are
  // frozen; only then may tmux publish the child's recorded exit status.
  closeTerminalCapture(window, runner, checkout, terminalPane);
  observeTerminalSnapshot(
    window,
    captureTerminalHistory(runner, checkout, terminalPane).replaceAll(
      window.files.command,
      "<private command>",
    ),
  );
  window.finalViewport = captureTerminalViewport(runner, checkout, terminalPane);
  releaseHeldTerminalCommand(window);
  for (let elapsed = 0; elapsed <= TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10; elapsed += 1) {
    const state = readTerminalCommandState(window, runner, checkout, terminalPane);
    if (state?.status === "exited") {
      if (state.exitStatus !== recordedStatus) {
        throw new Error(
          `held terminal command status mismatch: recorded ${recordedStatus}, tmux reported ${state.exitStatus}`,
        );
      }
      window.finalizedExitStatus = recordedStatus;
      return;
    }
    if (!state) {
      throw new Error("held terminal command lost its authoritative pane after release");
    }
    if (elapsed < TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10) {
      requireSuccess("sleep", ["0.1"], runner("sleep", ["0.1"]));
    }
  }
  throw new Error(
    `held terminal command did not exit within ${TERMINAL_COMMAND_START_TIMEOUT_SECONDS} seconds after release`,
  );
}

function releaseHeldTerminalCommand(window: TerminalOutputWindow): void {
  writeFileSync(window.files.releaseTemporary, "release\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(window.files.releaseTemporary, window.files.release);
}

function refreshTerminalCommandOutput(
  window: TerminalOutputWindow,
  runner: MediaProofCommandRunner,
  checkout: string,
  terminalPane: string,
): void {
  if (!window.captureOpen) return;
  const snapshot = captureTerminalHistory(runner, checkout, terminalPane).replaceAll(
    window.files.command,
    "<private command>",
  );
  observeTerminalSnapshot(window, snapshot);
}

function observeTerminalSnapshot(window: TerminalOutputWindow, snapshot: string): void {
  for (const expectation of window.expectations) {
    if (snapshot.includes(expectation)) window.observedExpectations.add(expectation);
  }
  storeTerminalSnapshot(window, snapshot);
}

function terminalExpectations(plan: LiveProofPlan): string[] {
  return [
    ...new Set(plan.steps.flatMap((step) => (step.action === "expect_output" ? [step.text] : []))),
  ];
}

function storeTerminalSnapshot(window: TerminalOutputWindow, snapshot: string): void {
  const bytes = Buffer.from(snapshot);
  const bounded = bytes.subarray(Math.max(0, bytes.length - TERMINAL_STREAM_MAX_BYTES));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bounded.length; offset += TERMINAL_CAPTURE_CHUNK_BYTES) {
    chunks.push(bounded.subarray(offset, offset + TERMINAL_CAPTURE_CHUNK_BYTES));
  }
  window.chunks = chunks;
}

function closeTerminalCapture(
  window: TerminalOutputWindow,
  runner: MediaProofCommandRunner,
  checkout: string,
  terminalPane: string,
): void {
  if (!window.captureOpen) return;
  const args = ["pipe-pane", "-t", terminalPane];
  const result = runner("tmux", args, { cwd: checkout });
  if (result.status !== 0) {
    const state = readTerminalCommandState(window, runner, checkout, terminalPane);
    if (state?.status !== "exited") requireSuccess("tmux", args, result);
  }
  window.captureOpen = false;
  for (let elapsed = 0; elapsed <= TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10; elapsed += 1) {
    const completionText = readBoundedTerminalFile(window.files.captureDone, 64);
    if (completionText !== undefined) {
      const completion = completionText.trim();
      if (completion !== "eof") {
        throw new Error(`terminal capture helper ended unexpectedly: ${completion || "empty"}`);
      }
      const capture = readBoundedTerminalFile(window.files.capture, TERMINAL_STREAM_MAX_BYTES);
      if (capture !== undefined) {
        const output = normalizeTerminalOutput(
          capture.replaceAll(window.files.command, "<private command>"),
        );
        storeTerminalSnapshot(window, output);
      }
      return;
    }
    if (elapsed < TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10) {
      requireSuccess("sleep", ["0.1"], runner("sleep", ["0.1"]));
    }
  }
  throw new Error(
    `terminal capture helper did not finish after tmux pipe EOF within ${TERMINAL_COMMAND_START_TIMEOUT_SECONDS} seconds`,
  );
}

function readBoundedTerminalFile(path: string, maximumBytes: number): string | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error("terminal control path is not a regular file");
    }
    if (stat.size > maximumBytes) {
      throw new Error("terminal control file exceeds its size limit");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes) {
      throw new Error("terminal control file exceeds its size limit");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function remainingTerminalBudgetSeconds(deadline: number): number {
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
}

function pollTerminalSleep(runner: MediaProofCommandRunner, deadline: number): void {
  const remainingMilliseconds = deadline - Date.now();
  if (remainingMilliseconds <= 0) {
    throw new Error("terminal proof exceeded its configured time budget");
  }
  const seconds = Math.min(1, remainingMilliseconds / 1_000);
  const duration = String(seconds);
  requireSuccess("sleep", [duration], runner("sleep", [duration]));
}

function sleepWithinTerminalBudget(
  runner: MediaProofCommandRunner,
  seconds: number,
  deadline: number,
): void {
  if (seconds * 1_000 > deadline - Date.now()) {
    throw new Error("terminal proof step would exceed its configured time budget");
  }
  const duration = String(seconds);
  requireSuccess("sleep", [duration], runner("sleep", [duration]));
}

function terminalWindowOutput(window: TerminalOutputWindow): string {
  return Buffer.concat(window.chunks).toString("utf8");
}

function normalizeTerminalOutput(value: string): string {
  return stripVTControlCharacters(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function terminalSignalExitStatus(signal: string): number {
  const numericSignal = /^\d+$/.test(signal) ? Number.parseInt(signal, 10) : undefined;
  if (numericSignal !== undefined && numericSignal > 0 && numericSignal < 128) {
    return 128 + numericSignal;
  }
  const signalNumber =
    osConstants.signals[
      (signal.startsWith("SIG")
        ? signal
        : `SIG${signal.toUpperCase()}`) as keyof typeof osConstants.signals
    ];
  return 128 + (signalNumber ?? 127);
}

function terminalCommandFailure(window: TerminalOutputWindow, status: number): Error {
  const detail = status > 128 ? "terminated by a signal" : "failed";
  return new Error(
    `terminal command ${detail} with exit status ${status}: ${JSON.stringify(window.command)}`,
  );
}

function renderFailedTerminalOutput(
  windows: readonly TerminalOutputWindow[],
  failureReason: string,
): string {
  const sections = failureReason ? [`[failure]\n${failureReason}`] : [];
  for (const [index, window] of windows.entries()) {
    const output = terminalWindowOutput(window);
    if (output.trim()) {
      sections.push(`[command ${index + 1} combined output]\n${output.trim()}`);
    }
  }
  return sections.join("\n\n");
}

function terminateTerminalProcessGroup(
  runner: MediaProofCommandRunner,
  checkout: string,
  panePid: number | undefined,
): void {
  if (!panePid) return;
  const signalErrors: unknown[] = [];
  const runSignal = (signal: "-TERM" | "-KILL") => {
    try {
      const result = runner("/bin/kill", [signal, `-${panePid}`], { cwd: checkout });
      if (result.status !== 0) {
        signalErrors.push(
          new Error(`/bin/kill ${signal} -${panePid} failed: ${mediaProofSpawnDetail(result)}`),
        );
      }
    } catch (error) {
      signalErrors.push(error);
    }
  };
  const processGroupExists = (): boolean => {
    const result = runner("/bin/kill", ["-0", `-${panePid}`], { cwd: checkout });
    return result.status === 0;
  };
  // Signal command status is advisory because the group may disappear between
  // calls. Only the final liveness probe decides whether cleanup succeeded.
  runSignal("-TERM");
  requireSuccess("sleep", ["0.1"], runner("sleep", ["0.1"]));
  if (!processGroupExists()) return;
  runSignal("-KILL");
  for (let attempt = 0; attempt <= TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10; attempt += 1) {
    if (!processGroupExists()) return;
    if (attempt < TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10) {
      requireSuccess("sleep", ["0.1"], runner("sleep", ["0.1"]));
    }
  }
  const surviving = new Error(`terminal process group ${panePid} survived SIGKILL`);
  throw signalErrors.length > 0
    ? new AggregateError(
        [...signalErrors, surviving],
        `failed to clean terminal process group ${panePid}`,
      )
    : surviving;
}

function cleanupTerminalWindow(
  window: TerminalOutputWindow,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  const errors: unknown[] = [];
  if (!window.processGroupCleaned) {
    try {
      terminateTerminalProcessGroup(runner, checkout, window.panePid);
      window.processGroupCleaned = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to clean terminal process group");
  }
}

function readTerminalCommandState(
  window: TerminalOutputWindow,
  runner: MediaProofCommandRunner,
  checkout: string,
  terminalPane: string,
): TerminalPaneState | undefined {
  if (window.frozenExit) return window.frozenExit;
  const state = readTerminalPaneState(runner, checkout, terminalPane);
  if (state && window.panePid !== undefined && state.pid !== window.panePid) {
    throw new Error(
      `terminal pane identity changed from launch pid ${window.panePid} to ${state.pid}`,
    );
  }
  if (state?.status === "exited") window.frozenExit = state;
  return state;
}

function readTerminalPaneState(
  runner: MediaProofCommandRunner,
  checkout: string,
  terminalPane: string,
): TerminalPaneState | undefined {
  const args = [
    "display-message",
    "-p",
    "-t",
    terminalPane,
    "#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}",
  ];
  const result = runner("tmux", args, { cwd: checkout });
  if (result.status !== 0) return undefined;
  const match = /^(\d+)\|(0|1)\|([^|]*)\|([^|]*)$/.exec(String(result.stdout ?? "").trim());
  if (!match) throw new Error("terminal pane status is malformed");
  const pid = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("terminal pane status is malformed");
  if (match[2] === "0") {
    if (match[3] || match[4]) throw new Error("terminal pane status is malformed");
    return { status: "running", pid };
  }
  const status = match[3]!;
  const signal = match[4]!;
  if (/^\d+$/.test(status) && !signal) {
    const exitStatus = Number.parseInt(status, 10);
    if (exitStatus >= 0 && exitStatus <= 255) return { status: "exited", pid, exitStatus };
  } else if (!status && signal) {
    return { status: "exited", pid, exitStatus: terminalSignalExitStatus(signal) };
  }
  throw new Error("terminal pane status is malformed");
}

function readTerminalPanePid(
  runner: MediaProofCommandRunner,
  checkout: string,
  terminalPane: string,
): number | undefined {
  const args = ["display-message", "-p", "-t", terminalPane, "#{pane_pid}"];
  const result = runner("tmux", args, { cwd: checkout });
  if (result.status !== 0) return undefined;
  const pid = Number.parseInt(String(result.stdout ?? "").trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("terminal pane pid is malformed");
  }
  return pid;
}

function terminalPrivateErrorMessage(error: unknown, privatePaths: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const privatePath of [...privatePaths].sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(privatePath, "<private path>");
  }
  return message;
}

function captureTerminalPane(
  runner: MediaProofCommandRunner,
  checkout: string,
  target: string,
): string {
  const args = ["capture-pane", "-p", "-t", target, "-S", "-200"];
  const capture = runner("tmux", args, { cwd: checkout });
  requireSuccess("tmux", args, capture);
  return normalizeTerminalOutput(String(capture.stdout ?? ""));
}

function captureTerminalHistory(
  runner: MediaProofCommandRunner,
  checkout: string,
  target: string,
): string {
  const args = ["capture-pane", "-p", "-t", target, "-S", `-${TERMINAL_HISTORY_LINES}`];
  const capture = runner("tmux", args, { cwd: checkout });
  requireSuccess("tmux", args, capture);
  return normalizeTerminalOutput(String(capture.stdout ?? ""));
}

function captureTerminalViewport(
  runner: MediaProofCommandRunner,
  checkout: string,
  target: string,
): string {
  const args = ["capture-pane", "-p", "-t", target];
  const capture = runner("tmux", args, { cwd: checkout });
  requireSuccess("tmux", args, capture);
  return normalizeTerminalOutput(String(capture.stdout ?? ""));
}

function holdEndState(
  runner: MediaProofCommandRunner,
  recordingStartedAt: number,
  terminalDeadline: number,
): void {
  const elapsed = Math.max(0, Date.now() - recordingStartedAt);
  const holdMilliseconds = Math.max(
    END_STATE_HOLD_MILLISECONDS,
    MINIMUM_RECORDING_MILLISECONDS - elapsed,
  );
  sleepWithinTerminalBudget(runner, Math.ceil(holdMilliseconds / 1000), terminalDeadline);
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
