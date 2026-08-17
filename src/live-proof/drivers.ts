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

export interface LiveProofStepLogEntry {
  action: string;
  status: "completed" | "failed";
  detail: string;
}

export interface LiveProofDriveResult {
  status: LiveProofDriveStatus;
  steps: LiveProofStepLogEntry[];
  rawVideoPath: string;
}

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
const useBundledChromium = process.env.CLAWSWEEPER_LIVE_PROOF_BROWSER === "chromium";
const headless = process.env.CLAWSWEEPER_LIVE_PROOF_HEADED !== "1";
if (!baseUrl || !entry || !output || !logPath) throw new Error("missing live proof driver environment");

const log = [];
let browser;
let context;
let page;
let video;
let failed = false;
try {
  browser = await chromium.launch(useBundledChromium ? { headless } : { headless, channel: "chrome" });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: output + ".videos", size: { width: 1280, height: 800 } } });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  video = page.video();
  await page.goto(new URL(entry, baseUrl).href);
  for (const step of steps) {
    try {
      switch (step.action) {
        case "goto": await page.goto(new URL(step.path, baseUrl).href); break;
        case "click": {
          const locator = page.locator(step.target);
          // Fall back to a force click so continuously animated targets (whose
          // position never stabilizes) can still be demonstrated.
          try { await locator.click({ timeout: 5_000 }); }
          catch { await locator.click({ force: true }); }
          break;
        }
        case "fill": await page.locator(step.target).fill(step.value); break;
        case "press": await page.keyboard.press(step.key); break;
        case "wait_for": await page.locator(step.target).waitFor({ state: "visible" }); break;
        case "wait": await page.waitForTimeout(step.seconds * 1000); break;
        case "expect_text": await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible" }); break;
        default: throw new Error("unsupported browser action");
      }
      log.push({ action: step.action, status: "completed", detail: "ok" });
    } catch (error) {
      failed = true;
      log.push({ action: step.action, status: "failed", detail: error instanceof Error ? error.message : String(error) });
      break;
    }
  }
} finally {
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
  baseUrl: string;
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
  if (!existsSync(options.rawVideoPath)) {
    throw new Error(`Playwright did not finalize a recording: ${mediaProofSpawnDetail(result)}`);
  }
  return {
    status: driveStatus(result.status, stepLog),
    steps: stepLog,
    rawVideoPath: options.rawVideoPath,
  };
}

export function terminalCommandPlan(options: {
  sessionPrefix: string;
  entry: string;
  maxRecordingSeconds: number;
  rawVideoPath: string;
}): Array<{ command: string; args: string[] }> {
  const terminalSession = `${options.sessionPrefix}-terminal`;
  const displaySession = `${options.sessionPrefix}-display`;
  const recorderSession = `${options.sessionPrefix}-recorder`;
  return [
    {
      command: "tmux",
      args: ["new-session", "-d", "-s", terminalSession, "-x", "160", "-y", "50"],
    },
    {
      command: "tmux",
      args: [
        "new-session",
        "-d",
        "-s",
        displaySession,
        "xvfb-run",
        "--server-num=99",
        "--server-args=-screen 0 1280x800x24",
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
    { command: "sleep", args: ["1"] },
    {
      command: "tmux",
      args: [
        "new-session",
        "-d",
        "-s",
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
        options.rawVideoPath,
      ],
    },
    {
      command: "tmux",
      args: ["send-keys", "-t", `${terminalSession}:0.0`, "-l", "--", options.entry],
    },
    {
      command: "tmux",
      args: ["send-keys", "-t", `${terminalSession}:0.0`, "Enter"],
    },
  ];
}

export function driveTerminal(options: {
  plan: LiveProofPlan;
  checkout: string;
  rawVideoPath: string;
  maxRecordingSeconds: number;
  runner: MediaProofCommandRunner;
}): LiveProofDriveResult {
  const sessionPrefix = `clawsweeper-live-proof-${process.pid}`;
  const terminalSession = `${sessionPrefix}-terminal`;
  const displaySession = `${sessionPrefix}-display`;
  const recorderSession = `${sessionPrefix}-recorder`;
  const log: LiveProofStepLogEntry[] = [];
  let failed = false;
  try {
    for (const invocation of terminalCommandPlan({
      sessionPrefix,
      entry: options.plan.entry,
      maxRecordingSeconds: options.maxRecordingSeconds,
      rawVideoPath: options.rawVideoPath,
    })) {
      requireSuccess(
        invocation.command,
        invocation.args,
        options.runner(invocation.command, invocation.args, { cwd: options.checkout }),
      );
    }
    requireSuccess("sleep", ["1"], options.runner("sleep", ["1"]));
    for (const step of options.plan.steps as LiveProofTerminalStep[]) {
      try {
        runTerminalStep(step, terminalSession, options.runner, options.checkout);
        log.push({ action: step.action, status: "completed", detail: "ok" });
      } catch (error) {
        failed = true;
        log.push({
          action: step.action,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
  } finally {
    options.runner("tmux", ["send-keys", "-t", `${recorderSession}:0.0`, "q"]);
    options.runner("sleep", ["1"]);
    options.runner("tmux", ["kill-session", "-t", recorderSession]);
    options.runner("tmux", ["kill-session", "-t", displaySession]);
    options.runner("tmux", ["kill-session", "-t", terminalSession]);
  }
  if (!existsSync(options.rawVideoPath))
    throw new Error("terminal driver did not finalize a recording");
  return {
    status: failed ? (log.length > 1 ? "partial" : "failed") : "completed",
    steps: log,
    rawVideoPath: options.rawVideoPath,
  };
}

function runTerminalStep(
  step: LiveProofTerminalStep,
  terminalSession: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  const target = `${terminalSession}:0.0`;
  if (step.action === "run") {
    requireSuccess(
      "tmux",
      ["send-keys", "-t", target, "-l", "--", step.command],
      runner("tmux", ["send-keys", "-t", target, "-l", "--", step.command], {
        cwd: checkout,
      }),
    );
    requireSuccess(
      "tmux",
      ["send-keys", "-t", target, "Enter"],
      runner("tmux", ["send-keys", "-t", target, "Enter"], { cwd: checkout }),
    );
    return;
  }
  if (step.action === "wait") {
    const seconds = String(step.seconds);
    requireSuccess("sleep", [seconds], runner("sleep", [seconds]));
    return;
  }
  const capture = runner("tmux", ["capture-pane", "-p", "-t", target, "-S", "-200"], {
    cwd: checkout,
  });
  requireSuccess("tmux", ["capture-pane"], capture);
  if (!String(capture.stdout ?? "").includes(step.text)) {
    throw new Error(`expected terminal output was not visible: ${JSON.stringify(step.text)}`);
  }
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
        typeof record.detail === "string"
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
