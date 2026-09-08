import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { errorMessage } from "../value-coerce.js";
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
const TERMINAL_LEASE_FD = 9;

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
  tmuxTmpDir: string;
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
        "-u",
        "TMUX",
        "-u",
        "TMUX_PANE",
        "DISPLAY=:99",
        `TMUX_TMPDIR=${options.tmuxTmpDir}`,
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
  output: string;
  expectations: readonly string[];
  observedExpectations: Set<string>;
  panePid?: number;
  paneTty?: string;
  leaseIdentity: string;
  cleanupArmedReceipt?: string;
  nonce: string;
  frozenExit?: Extract<TerminalPaneState, { status: "exited" }>;
  finalizedExitStatus?: number;
  captureOpen: boolean;
  paneCleaned: boolean;
  finalViewport?: string;
}

interface TerminalCommandFiles {
  command: string;
  captureScript: string;
  capture: string;
  captureTemporary: string;
  captureDone: string;
  captureDoneTemporary: string;
  cleanupScript: string;
  cleanupResult: string;
  cleanupResultTemporary: string;
  lease: string;
  status: string;
  statusTemporary: string;
  start: string;
  startTemporary: string;
  ready: string;
  readyTemporary: string;
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
  | { status: "running"; pid: number; tty: string }
  | { status: "exiting"; pid: number; tty: string }
  | { status: "exited"; pid: number; tty: string; exitStatus: number; drained: boolean };

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

function generateTerminalCleanupScript(): string {
  return `#!/bin/bash
set +m
tty_path=$1
pane_pid=$2
nonce=$3
lease_path=$4
lease_identity=$5
request=$6
result_temporary=$7
result=$8
scan_file="$result_temporary.scan.$$"
receipt() { builtin printf "%s\\n" "$1" >"$result_temporary" && mv -f -- "$result_temporary" "$result" || exit 125; }
finish() {
  # The controller can tear down the watchdog as soon as it observes done.
  /bin/rm -f -- "$scan_file" || set -- "$1" error:scan-cleanup "$3" 125
  receipt "v1|done|$nonce|$pane_pid|$tty_path|$lease_identity|$1|$2|$3"
  exit "$4"
}
case "$tty_path" in /dev/*) tty_name=\${tty_path#/dev/} ;; *) finish startup error:tty 0 125 ;; esac
case "$pane_pid" in ""|*[!0-9]*) finish startup error:pane-pid 0 125 ;; esac
case "$lease_identity" in *[!0-9:]*|:*|*:|*:*:*|"") finish startup error:lease-identity 0 125 ;; *:*) ;; *) finish startup error:lease-identity 0 125 ;; esac
if [ "$(/usr/bin/uname -s)" = Darwin ]; then
  lease_identity_now() { /usr/bin/stat -f '%d:%i' -- "$lease_path" 2>/dev/null; }
  # The lease is an inherited open file, not a mapped image or working directory.
  # Darwin -X skips those expensive scans without excluding duplicated descriptors.
  lease_pids() { /usr/sbin/lsof -t -X -- "$lease_path" 2>/dev/null; status=$?; [ "$status" -le 1 ]; }
  holds_lease() { /usr/sbin/lsof -t -X -a -p "$1" -- "$lease_path" 2>/dev/null | /usr/bin/grep -qx "$1"; }
else
  lease_identity_now() { /usr/bin/stat -Lc '%d:%i' -- "$lease_path" 2>/dev/null; }
  holds_lease() { [ "$(/usr/bin/stat -Lc '%d:%i' -- /proc/"$1"/fd/${TERMINAL_LEASE_FD} 2>/dev/null)" = "$lease_identity" ]; }
  lease_pids() { /usr/bin/find -L /proc/[0-9]*/fd/${TERMINAL_LEASE_FD} -maxdepth 0 -samefile "$lease_path" -printf '%h\\n' 2>/dev/null | /usr/bin/awk -F/ 'NF == 4 && $2 == "proc" && $3 ~ /^[0-9]+$/ && $4 == "fd" { print $3 }'; }
fi
on_bound_tty() { [ "$(/bin/ps -o tty= -p "$1" 2>/dev/null | /usr/bin/tr -d '[:space:]')" = "$tty_name" ]; }
pane_owns_tty() { holds_lease "$pane_pid" && on_bound_tty "$pane_pid"; }
tty_pids() {
  pane_owns_tty || return 0
  /bin/ps -t "$tty_name" -o pid=,tty= | /usr/bin/awk -v tty="$tty_name" '$2 == tty { print $1 }'
}
scan_bound_processes() {
  : >"$scan_file"
  lease_pids >>"$scan_file" || return $?
  tty_pids >>"$scan_file" || return $?
  /usr/bin/sort -n -u -o "$scan_file" "$scan_file"
}
signal_bound_processes() {
  local workers=() worker result=0
  while IFS= read -r candidate; do
    case "$candidate" in ""|*[!0-9]*) continue ;; esac
    (
      if ! holds_lease "$candidate"; then
        on_bound_tty "$candidate" || exit 0
        pane_owns_tty || exit 0
      fi
      /bin/kill "-$1" "$candidate" 2>/dev/null || [ "$?" -eq 1 ]
    ) &
    workers+=("$!")
    # Bound independent Darwin lookups without caching identity across signals.
    if [ "\${#workers[@]}" -ge 8 ]; then
      wait "\${workers[0]}" || result=1
      workers=("\${workers[@]:1}")
    fi
  done <"$scan_file"
  for worker in "\${workers[@]}"; do wait "$worker" || result=1; done
  return "$result"
}
[ "$(lease_identity_now)" = "$lease_identity" ] || finish startup error:lease-identity 0 125
pane_owns_tty || finish startup error:pane-identity 0 125
receipt "v1|armed|$nonce|$pane_pid|$tty_path|$lease_identity|$$"
trigger=
while [ -z "$trigger" ]; do
  if [ -e "$request" ]; then
    IFS= read -r cleanup_request <"$request" || finish controller error:request 0 125
    [ "$cleanup_request" = "v1|cleanup|$nonce|$pane_pid|$tty_path|$lease_identity" ] || finish controller error:request 0 125
    trigger=controller
  elif ! pane_owns_tty; then
    trigger=pane-death
  else
    sleep 0.05
  fi
done
# Repeating TERM multiplies Darwin's per-PID lease scans before escalation.
# Keep the same total grace; the KILL phase rediscovers and verifies survivors.
scan_bound_processes || finish "$trigger" error:scan 0 125
signal_bound_processes TERM || finish "$trigger" error:term 0 125
sleep 0.15
stable_empty=0
for ((sweep = 1; sweep <= 100; sweep += 1)); do
  scan_bound_processes || finish "$trigger" error:scan 0 125
  survivors=$(/usr/bin/wc -l <"$scan_file")
  if [ "$survivors" -eq 0 ]; then
    stable_empty=$((stable_empty + 1))
    if [ "$stable_empty" -ge 2 ]; then finish "$trigger" ok 0 0; fi
  else
    stable_empty=0
    signal_bound_processes KILL || finish "$trigger" error:kill "$survivors" 125
  fi
  sleep 0.05
done
scan_bound_processes || finish "$trigger" error:scan 0 125
survivors=$(/usr/bin/wc -l <"$scan_file")
finish "$trigger" error:survivors "$survivors" 124
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
  // tmux Unix sockets have a small path cap on macOS; /tmp is the shared
  // cross-platform short root, while mkdtemp keeps each proof private.
  const tmuxTmpDir = mkdtempSync("/tmp/clawsweeper-tmux-");
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
  const privatePaths: string[] = [tmuxTmpDir];
  const commandWindows: TerminalOutputWindow[] = [];
  let commandIndex = 0;
  let terminalDeadline = 0;
  const runner: MediaProofCommandRunner = (command, args, runOptions = {}) => {
    if (command !== "tmux") return options.runner(command, args, runOptions);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...runOptions.env,
      TMUX_TMPDIR: tmuxTmpDir,
    };
    delete env.TMUX;
    delete env.TMUX_PANE;
    return options.runner(command, args, { ...runOptions, env });
  };
  const nextCommand = (): TerminalCommandFiles => {
    const prefix = `${options.rawVideoPath}.command-${process.pid}-${commandIndex}`;
    commandIndex += 1;
    const files = {
      command: `${prefix}.sh`,
      captureScript: `${prefix}.capture.mjs`,
      capture: `${prefix}.combined.log`,
      captureTemporary: `${prefix}.combined.tmp`,
      captureDone: `${prefix}.capture.done`,
      captureDoneTemporary: `${prefix}.capture.done.tmp`,
      cleanupScript: `${prefix}.cleanup.sh`,
      cleanupResult: `${prefix}.cleanup.result`,
      cleanupResultTemporary: `${prefix}.cleanup.result.tmp`,
      lease: `${prefix}.lease`,
      status: `${prefix}.status`,
      statusTemporary: `${prefix}.status.tmp`,
      start: `${prefix}.start`,
      startTemporary: `${prefix}.start.tmp`,
      ready: `${prefix}.ready`,
      readyTemporary: `${prefix}.ready.tmp`,
    };
    privatePaths.push(...Object.values(files));
    return files;
  };
  try {
    for (const invocation of terminalCommandPlan({
      sessionPrefix,
      maxRecordingSeconds: options.maxRecordingSeconds,
      rawVideoPath: options.rawVideoPath,
      tmuxTmpDir,
      recordMedia,
    })) {
      requireSuccess(
        invocation.command,
        invocation.args,
        runner(invocation.command, invocation.args, { cwd: options.checkout }),
      );
      if (invocation.waitAfter === "display") {
        waitForDisplay(runner, options.checkout);
      } else if (invocation.waitAfter === "recorder") {
        waitForRecorder(runner, options.checkout, recorderSession, options.rawVideoPath);
        recordingStartedAt = Date.now();
      }
    }
    const expectations = terminalExpectations(options.plan);
    terminalDeadline = Date.now() + options.maxRecordingSeconds * 1_000;
    initialPaneSnapshot = captureTerminalPane(runner, options.checkout, terminalPane, 200);
    try {
      outputWindow = runTerminalCommand(
        options.plan.entry,
        terminalPane,
        runner,
        options.checkout,
        nextCommand(),
        expectations,
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
      const steps = options.plan.steps as LiveProofTerminalStep[];
      for (const [index, step] of steps.entries()) {
        const completion = steps.slice(index + 1).some((later) => later.action === "run")
          ? "exit_zero"
          : options.plan.terminalCompletion;
        try {
          const result = runTerminalStep(
            step,
            terminalPane,
            runner,
            options.checkout,
            outputWindow,
            nextCommand,
            expectations,
            terminalDeadline,
            completion,
          );
          if (result && result !== outputWindow) {
            commandWindows.push(result);
          }
          outputWindow = result;
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
          runner,
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
      sleepWithinTerminalBudget(runner, TERMINAL_READY_STABILITY_SECONDS, terminalDeadline);
    }
    validateCurrentCommand(!recordMedia);
    if (recordMedia) {
      if (!failed) holdEndState(runner, recordingStartedAt, terminalDeadline);
      validateCurrentCommand(false);
      finalizeRecorder(runner, options.checkout, recorderSession);
      validateCurrentCommand(true);
      requireRecording(runner, options.checkout, options.rawVideoPath);
    }
    if (failed) {
      for (const window of commandWindows) {
        try {
          if (window.captureOpen) {
            refreshTerminalCommandOutput(window, runner, options.checkout, terminalPane);
            closeTerminalCapture(window, runner, options.checkout, terminalPane);
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
        outputWindow?.finalViewport ?? captureTerminalPane(runner, options.checkout, terminalPane);
      capturedOutput = terminalPrivateErrorMessage(
        viewport.trim() ? viewport.replace(/\n$/, "") : "",
        privatePaths,
      );
    }
  } catch (error) {
    const diagnosticError = terminalErrorWithDiagnostics(error, runner, options.checkout, {
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
      cleanup(() => closeTerminalCapture(window, runner, options.checkout, terminalPane));
      cleanup(() => cleanupTerminalWindow(window, terminalPane, runner, options.checkout));
    }
    for (const session of [
      ...(recordMedia ? [recorderSession, xtermSession, displaySession] : []),
      terminalSession,
    ]) {
      cleanup(() => {
        runner("tmux", ["kill-session", "-t", session]);
      });
    }
    for (const privatePath of privatePaths) {
      cleanup(() => rmSync(privatePath, { force: true, recursive: privatePath === tmuxTmpDir }));
    }
    if (cleanupErrors.length > 0) {
      if (failed && !thrown) {
        const cleanupFailure = cleanupErrors
          .map((error) => terminalPrivateErrorMessage(error, privatePaths))
          .join("; ");
        capturedOutput = [capturedOutput, `[cleanup failure]\n${cleanupFailure}`]
          .filter(Boolean)
          .join("\n\n");
      } else {
        thrown = new AggregateError(
          thrown ? [thrown, ...cleanupErrors] : cleanupErrors,
          thrown ? "terminal proof and cleanup failed" : "terminal cleanup failed",
        );
      }
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
  const message = errorMessage(error);
  const diagnostics = Object.entries(sessions).map(([label, session]) => {
    const result = runner("tmux", ["capture-pane", "-p", "-t", session, "-S", "-40"], {
      cwd: checkout,
    });
    const output =
      result.status === 0
        ? lastLines(String(result.stdout ?? ""), 40) || "<empty>"
        : `<capture failed: ${mediaProofSpawnDetail(result)}>`;
    return `[${label}: ${session}]\n${output}`;
  });
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
  nextCommand: () => TerminalCommandFiles,
  expectations: readonly string[],
  terminalDeadline: number,
  completion: LiveProofPlan["terminalCompletion"],
): TerminalOutputWindow | undefined {
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
        cleanupTerminalWindow(outputWindow, terminalPane, runner, checkout);
      } catch (error) {
        throw new Error(
          `terminal run was blocked by the previous command: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    return runTerminalCommand(
      step.command,
      terminalPane,
      runner,
      checkout,
      nextCommand(),
      expectations,
      terminalDeadline,
    );
  }
  if (step.action === "wait") {
    sleepWithinTerminalBudget(runner, step.seconds, terminalDeadline);
    return outputWindow;
  }
  if (!outputWindow) {
    throw new Error("expected terminal output without a preceding command");
  }
  if (completion === "exit_zero") {
    // Finite reporters may emit only a final summary; readiness's 30-second
    // window would reject healthy commands before their output can be observed.
    requireTerminalCommandExitZero(
      outputWindow,
      terminalPane,
      runner,
      checkout,
      terminalDeadline,
      true,
    );
    if (!outputWindow.observedExpectations.has(step.text)) {
      throw new Error(
        `proof-plan assertion mismatch: terminal command exited successfully but expected output was not observed; verify the command/wrapper/reporter contract: ${JSON.stringify(step.text)}`,
      );
    }
    return outputWindow;
  }
  for (let elapsed = 0; elapsed <= TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS; elapsed += 1) {
    refreshTerminalCommandOutput(outputWindow, runner, checkout, terminalPane);
    if (outputWindow.observedExpectations.has(step.text)) {
      return outputWindow;
    }
    const status = readHeldTerminalStatus(outputWindow);
    if (status !== undefined) {
      finalizeHeldTerminalCommand(outputWindow, status, terminalPane, runner, checkout);
      if (outputWindow.observedExpectations.has(step.text)) {
        return outputWindow;
      }
      if (status !== 0) throw terminalCommandFailure(outputWindow, status);
      throw new Error(
        `terminal command exited successfully before expected output appeared: ${JSON.stringify(step.text)}`,
      );
    }
    const state = readTerminalCommandState(outputWindow, runner, checkout, terminalPane);
    if (state && state.status !== "running") {
      throw new Error("held terminal command exited before recording its completion status");
    }
    if (elapsed < TERMINAL_EXPECT_OUTPUT_TIMEOUT_SECONDS) {
      pollTerminalSleep(runner, terminalDeadline);
    }
  }
  refreshTerminalCommandOutput(outputWindow, runner, checkout, terminalPane);
  if (outputWindow.observedExpectations.has(step.text)) {
    return outputWindow;
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
  terminalDeadline: number,
): TerminalOutputWindow {
  const target = terminalPane;
  const quote = quoteTerminalShellArgument;
  for (const path of Object.values(files)) rmSync(path, { force: true });
  writeFileSync(files.command, command.endsWith("\n") ? command : `${command}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(files.captureScript, generateTerminalCaptureScript(), {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFileSync(files.cleanupScript, generateTerminalCleanupScript(), {
    encoding: "utf8",
    mode: 0o700,
  });
  writeFileSync(files.lease, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const leaseStat = statSync(files.lease);
  const window: TerminalOutputWindow = {
    command,
    files,
    output: "",
    expectations,
    observedExpectations: new Set(),
    leaseIdentity: `${leaseStat.dev}:${leaseStat.ino}`,
    nonce: randomUUID(),
    captureOpen: false,
    paneCleaned: false,
  };
  const clearHistoryArgs = ["clear-history", "-t", target];
  requireSuccess("tmux", clearHistoryArgs, runner("tmux", clearHistoryArgs, { cwd: checkout }));
  try {
    // The start gate keeps the pane alive while capture attaches, so fast
    // commands cannot emit before pipe-pane owns their output.
    const commandRunner = [
      "set +m",
      "trap ':' HUP TERM",
      "tty_path=$(/usr/bin/tty)",
      'case "$tty_path" in /dev/*) ;; *) exit 125 ;; esac',
      `exec ${TERMINAL_LEASE_FD}<"$8" || exit 125`,
      'while [ ! -e "$4" ]; do sleep 0.05; done',
      'IFS="|" read -r bound_pid bound_tty bound_nonce bound_lease bound_extra <"$4" || exit 125',
      '[ "$bound_pid" = "$$" ] && [ "$bound_tty" = "$tty_path" ] && [ "$bound_nonce" = "$7" ] && [ "$bound_lease" = "$9" ] && [ -z "${bound_extra-}" ] || exit 125',
      "builtin printf '\\033[2J\\033[H'",
      'builtin printf "%s|%s|%s|%s\\n" "$$" "$tty_path" "$7" "$9" >"$5"',
      'mv -f -- "$5" "$6"',
      'while :; do IFS= read -r execute_gate <"$6" || exit 125; [ "$execute_gate" = "v1|execute|$7|$$|$tty_path|$9" ] && break; sleep 0.05; done',
      // Concrete PTY descriptors survive detached child sessions. Inherited
      // /dev/tty descriptors lose their controlling terminal on macOS.
      `( /usr/bin/env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR /bin/bash --noprofile --norc "$1"; status=$?; builtin printf "%s\\n" "$status" >"$2"; mv -f -- "$2" "$3" ) ${TERMINAL_LEASE_FD}<&${TERMINAL_LEASE_FD} <"$tty_path" >"$tty_path" 2>&1 &`,
      "while :; do sleep 3600; done",
    ].join("\n");
    const shellCommand =
      `/bin/bash --noprofile --norc -c ${quote(commandRunner)} ` +
      [
        "clawsweeper-terminal",
        files.command,
        files.statusTemporary,
        files.status,
        files.start,
        files.readyTemporary,
        files.ready,
        window.nonce,
        files.lease,
        window.leaseIdentity,
      ]
        .map(quote)
        .join(" ");
    const respawnArgs = ["respawn-pane", "-k", "-t", target, "-c", checkout, shellCommand];
    requireSuccess("tmux", respawnArgs, runner("tmux", respawnArgs, { cwd: checkout }));
    const launchedState = readTerminalPaneState(runner, checkout, terminalPane);
    if (launchedState?.status !== "running") {
      throw new Error("terminal command pane did not remain live after respawn");
    }
    window.panePid = launchedState.pid;
    window.paneTty = launchedState.tty;
    const captureCommand =
      `/usr/bin/env -u TMUX -u TMUX_PANE -u TMUX_TMPDIR node ${quote(files.captureScript)} ` +
      [files.capture, files.captureTemporary, files.captureDone, files.captureDoneTemporary]
        .map(quote)
        .join(" ");
    const pipeArgs = ["pipe-pane", "-O", "-t", target, captureCommand];
    requireSuccess("tmux", pipeArgs, runner("tmux", pipeArgs, { cwd: checkout }));
    window.captureOpen = true;
    writeTerminalControlFile(
      files.startTemporary,
      files.start,
      `${launchedState.pid}|${launchedState.tty}|${window.nonce}|${window.leaseIdentity}\n`,
    );
  } catch (error) {
    throw new TerminalCommandExecutionError(errorMessage(error), window);
  }
  for (let elapsed = 0; elapsed <= TERMINAL_COMMAND_START_TIMEOUT_SECONDS; elapsed += 1) {
    try {
      const state = readTerminalCommandState(window, runner, checkout, terminalPane);
      const readiness = readBoundedTerminalFile(files.ready, 256);
      if (readiness !== undefined) {
        if (
          readiness !==
          `${window.panePid}|${window.paneTty}|${window.nonce}|${window.leaseIdentity}\n`
        ) {
          throw new Error("terminal command readiness acknowledgement is malformed");
        }
        armTerminalCleanupWatchdog(window, terminalPane, runner, checkout);
        refreshTerminalCommandOutput(window, runner, checkout, terminalPane);
        return window;
      }
      if (state && state.status !== "running") {
        throw new Error("terminal command exited before clearing its pane");
      }
    } catch (error) {
      throw new TerminalCommandExecutionError(errorMessage(error), window);
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

function armTerminalCleanupWatchdog(
  window: TerminalOutputWindow,
  terminalPane: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  const identity = terminalCleanupIdentity(window);
  rmSync(window.files.start, { force: true });
  const cleanupCommand = [
    "/bin/bash",
    window.files.cleanupScript,
    window.paneTty!,
    String(window.panePid!),
    window.nonce,
    window.files.lease,
    window.leaseIdentity,
    window.files.start,
    window.files.cleanupResultTemporary,
    window.files.cleanupResult,
  ]
    .map(quoteTerminalShellArgument)
    .join(" ");
  const cleanupArgs = ["run-shell", "-b", cleanupCommand];
  requireSuccess("tmux", cleanupArgs, runner("tmux", cleanupArgs, { cwd: checkout }));
  for (let elapsed = 0; elapsed <= TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10; elapsed += 1) {
    const state = readTerminalCommandState(window, runner, checkout, terminalPane);
    if (state && state.status !== "running") {
      throw new Error("terminal pane exited before its cleanup watchdog armed");
    }
    const receipt = readBoundedTerminalFile(window.files.cleanupResult, 512);
    if (receipt !== undefined) {
      if (receipt.startsWith("v1|done|")) {
        throw new Error(
          `terminal cleanup watchdog failed before arming: ${receipt.trim() || "empty result"}`,
        );
      }
      const fields = receipt.trimEnd().split("|");
      const watchdogPid = Number.parseInt(fields[6] ?? "", 10);
      if (
        receipt !== `v1|armed|${identity}|${watchdogPid}\n` ||
        !Number.isSafeInteger(watchdogPid) ||
        watchdogPid <= 0
      ) {
        throw new Error("terminal cleanup watchdog acknowledgement is malformed");
      }
      window.cleanupArmedReceipt = receipt;
      const armedState = readTerminalCommandState(window, runner, checkout, terminalPane);
      if (armedState?.status !== "running") {
        throw new Error("terminal pane exited after its cleanup watchdog armed");
      }
      writeTerminalControlFile(
        window.files.startTemporary,
        window.files.ready,
        `v1|execute|${identity}\n`,
      );
      return;
    }
    if (elapsed < TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10) {
      requireSuccess("sleep", ["0.1"], runner("sleep", ["0.1"]));
    }
  }
  throw new Error("terminal cleanup watchdog did not arm before target execution");
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
  if (window.observedExpectations.size === 0) {
    throw new Error("ready_while_running terminal proof requires a satisfied output expectation");
  }
  refreshTerminalCommandOutput(window, runner, checkout, terminalPane);
  const state = readTerminalCommandState(window, runner, checkout, terminalPane);
  // A watchdog can record the child's cleanup signal after the pane owner dies.
  // Preserve the original wrapper failure rather than that secondary status.
  if (state?.status === "exited") {
    throw new Error(
      `ready_while_running terminal command exited after satisfying its expectation: ${terminalCommandFailure(window, state.exitStatus).message}`,
    );
  }
  const status = readHeldTerminalStatus(window);
  if (status !== undefined) {
    throw new Error(
      `ready_while_running terminal command exited after satisfying its expectation: ${terminalCommandFailure(window, status).message}`,
    );
  }
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
      window.finalViewport ??= captureTerminalPane(runner, checkout, terminalPane);
      const sealedState = readTerminalCommandState(window, runner, checkout, terminalPane);
      if (sealedState?.status === "exited") {
        throw new Error(
          `ready_while_running terminal command exited after satisfying its expectation: ${terminalCommandFailure(window, sealedState.exitStatus).message}`,
        );
      }
      if (sealedState?.status !== "running") {
        throw new Error("ready_while_running terminal command has no authoritative process state");
      }
      const sealedStatus = readHeldTerminalStatus(window);
      if (sealedStatus !== undefined) {
        throw new Error(
          `ready_while_running terminal command exited after satisfying its expectation: ${terminalCommandFailure(window, sealedStatus).message}`,
        );
      }
    }
    return;
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
    if (state && state.status !== "running") {
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
  if (state && state.status !== "running") {
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
    throw new Error("held terminal command wrapper exited before controller cleanup");
  }
  // The wrapper remains the live pane owner until tty-scoped cleanup finishes.
  // The recorded child status is authoritative; pane exit is cleanup.
  closeTerminalCapture(window, runner, checkout, terminalPane);
  observeTerminalSnapshot(
    window,
    captureTerminalPane(runner, checkout, terminalPane, TERMINAL_HISTORY_LINES).replaceAll(
      window.files.command,
      "<private command>",
    ),
  );
  window.finalViewport = captureTerminalPane(runner, checkout, terminalPane);
  window.finalizedExitStatus = recordedStatus;
}

function refreshTerminalCommandOutput(
  window: TerminalOutputWindow,
  runner: MediaProofCommandRunner,
  checkout: string,
  terminalPane: string,
): void {
  if (!window.captureOpen) return;
  const snapshot = captureTerminalPane(
    runner,
    checkout,
    terminalPane,
    TERMINAL_HISTORY_LINES,
  ).replaceAll(window.files.command, "<private command>");
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
  window.output = bytes
    .subarray(Math.max(0, bytes.length - TERMINAL_STREAM_MAX_BYTES))
    .toString("utf8");
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
    if (!state || state.status === "running") requireSuccess("tmux", args, result);
    // tmux refuses pipe-pane on an exited pane without closing its pipe.
    // Verify original-pane death and the watchdog receipt before removing it;
    // pane destruction then delivers real EOF to the capture helper.
    cleanupTerminalWindow(window, terminalPane, runner, checkout);
    const removeArgs = ["kill-pane", "-t", terminalPane];
    requireSuccess("tmux", removeArgs, runner("tmux", removeArgs, { cwd: checkout }));
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

function writeTerminalControlFile(temporaryPath: string, path: string, value: string): void {
  writeFileSync(temporaryPath, value, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
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
    const output = window.output;
    if (output.trim()) {
      sections.push(`[command ${index + 1} combined output]\n${output.trim()}`);
    }
  }
  return sections.join("\n\n");
}

function terminalCleanupIdentity(window: TerminalOutputWindow): string {
  if (window.panePid === undefined || window.paneTty === undefined || !window.leaseIdentity) {
    throw new Error("terminal cleanup watchdog is missing its launch identity");
  }
  return `${window.nonce}|${window.panePid}|${window.paneTty}|${window.leaseIdentity}`;
}

function cleanupTerminalWindow(
  window: TerminalOutputWindow,
  terminalPane: string,
  runner: MediaProofCommandRunner,
  checkout: string,
): void {
  if (window.paneCleaned) return;
  const identity = terminalCleanupIdentity(window);
  const state = readTerminalPaneState(runner, checkout, terminalPane);
  if (!state) throw new Error("terminal pane disappeared before controller cleanup");
  assertTerminalPaneIdentity(window, state);
  window.finalViewport ??= captureTerminalPane(runner, checkout, terminalPane);
  if (!existsSync(window.files.start)) {
    writeTerminalControlFile(
      window.files.readyTemporary,
      window.files.start,
      `v1|cleanup|${identity}\n`,
    );
  }
  // The watchdog was armed before target execution and survives pane death.
  // Its exact receipt and the original pane's death are both authoritative.
  let cleanupAcknowledged = false;
  for (let elapsed = 0; elapsed <= TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10; elapsed += 1) {
    const cleanupResult = readBoundedTerminalFile(window.files.cleanupResult, 512);
    if (cleanupResult !== undefined && cleanupResult !== window.cleanupArmedReceipt) {
      if (
        !["controller", "pane-death"].some(
          (trigger) => cleanupResult === `v1|done|${identity}|${trigger}|ok|0\n`,
        )
      ) {
        throw new Error(`terminal pane cleanup failed: ${cleanupResult.trim() || "empty result"}`);
      }
      cleanupAcknowledged = true;
    }
    const releasedState = readTerminalPaneState(runner, checkout, terminalPane);
    if (!releasedState) {
      throw new Error("terminal pane disappeared before cleanup completion was observed");
    }
    assertTerminalPaneIdentity(window, releasedState);
    if (releasedState.status === "exited" && releasedState.drained && cleanupAcknowledged) {
      window.frozenExit ??= releasedState;
      window.paneCleaned = true;
      return;
    }
    if (elapsed < TERMINAL_COMMAND_START_TIMEOUT_SECONDS * 10) {
      requireSuccess("sleep", ["0.1"], runner("sleep", ["0.1"]));
    }
  }
  throw new Error(
    `terminal pane cleanup did not finish within ${TERMINAL_COMMAND_START_TIMEOUT_SECONDS} seconds`,
  );
}

function readTerminalCommandState(
  window: TerminalOutputWindow,
  runner: MediaProofCommandRunner,
  checkout: string,
  terminalPane: string,
): TerminalPaneState | undefined {
  if (window.frozenExit) return window.frozenExit;
  const state = readTerminalPaneState(runner, checkout, terminalPane);
  if (state) assertTerminalPaneIdentity(window, state);
  if (state?.status === "exited") window.frozenExit = state;
  return state;
}

function assertTerminalPaneIdentity(window: TerminalOutputWindow, state: TerminalPaneState): void {
  if (
    window.panePid === undefined ||
    window.paneTty === undefined ||
    state.pid !== window.panePid ||
    state.tty !== window.paneTty
  ) {
    throw new Error(
      `terminal pane identity changed from launch ${window.panePid ?? "unknown"}|${window.paneTty ?? "unknown"} to ${state.pid}|${state.tty}`,
    );
  }
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
    "#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}",
  ];
  const result = runner("tmux", args, { cwd: checkout });
  if (result.status !== 0) return undefined;
  const match = /^(\d+)\|(\/dev\/[^|]+)\|(0|1)\|([^|]*)\|([^|]*)$/.exec(
    String(result.stdout ?? "").trim(),
  );
  if (!match) throw new Error("terminal pane status is malformed");
  const pid = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("terminal pane status is malformed");
  const tty = match[2]!;
  const drained = match[3] === "1";
  const status = match[4]!;
  const signal = match[5]!;
  // PTY closure and waitpid status arrive independently (in either order).
  if (!status && !signal) return { status: drained ? "exiting" : "running", pid, tty };
  if (/^\d+$/.test(status) && !signal) {
    const exitStatus = Number.parseInt(status, 10);
    if (exitStatus >= 0 && exitStatus <= 255) {
      return { status: "exited", pid, tty, exitStatus, drained };
    }
  } else if (!status && signal) {
    return { status: "exited", pid, tty, exitStatus: terminalSignalExitStatus(signal), drained };
  }
  throw new Error("terminal pane status is malformed");
}

function quoteTerminalShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function terminalPrivateErrorMessage(error: unknown, privatePaths: readonly string[]): string {
  let message = errorMessage(error);
  for (const privatePath of [...privatePaths].sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(privatePath, "<private path>");
  }
  return message;
}

// Assertion captures join soft wraps; the final viewport keeps visual screen rows.
function captureTerminalPane(
  runner: MediaProofCommandRunner,
  checkout: string,
  target: string,
  historyLines?: number,
): string {
  const args = ["capture-pane", "-p", ...(historyLines === undefined ? [] : ["-J"]), "-t", target];
  if (historyLines !== undefined) args.push("-S", `-${historyLines}`);
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
