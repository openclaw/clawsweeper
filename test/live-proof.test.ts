import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

import { renderReviewCommentFromReport, reportLiveProofPlanForTest } from "../dist/clawsweeper.js";
import { createDecisionParser } from "../dist/clawsweeper-decision-parser.js";
import { mediaProofSpawnDetail } from "../dist/clawsweeper-media-proof.js";
import { LIVE_VERIFICATION_MARKER, REVIEW_SECTIONS } from "../dist/clawsweeper-policy.js";
import type { LiveProofPlan, MediaProofCommandRunner } from "../dist/clawsweeper-types.js";
import type { RepositoryProfile } from "../dist/repository-profiles.js";
import {
  attachReviewLiveProofArtifact,
  attachLiveProof,
  detachLiveProof,
  LiveProofArtifactValidationError,
  syncDetachedLiveProofComment,
  syncLiveProofComment,
} from "../dist/live-proof/attach.js";
import { createLiveProofCommands } from "../dist/live-proof/commands.js";
import {
  driveTerminal,
  generatePlaywrightScript,
  terminalCommandPlan,
} from "../dist/live-proof/drivers.js";
import { ensureLiveProofPackageManager, executeLiveProof } from "../dist/live-proof/execute.js";
import { liveProofSetupCommand } from "../dist/live-proof/setup.js";
import {
  assertLiveProofEnvironmentSanitized,
  sanitizedLiveProofEnvironment,
} from "../dist/live-proof/environment.js";
import { MediaProbeExecutionError, parseLiveProofManifest } from "../dist/live-proof/manifest.js";
import { publishReviewLiveProofArtifacts } from "../dist/live-proof/publication-artifacts.js";
import {
  buildLiveVerificationResult,
  encodeLiveVerificationReportPayload,
  liveProofPlanSha256,
  parseAttachedLiveVerification,
  parseLiveVerificationResult,
  renderLiveVerificationCommentBlock,
  sanitizeUntrustedOutput,
} from "../dist/live-proof/verification.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const liveProofPlanParser = createDecisionParser({
  isMaintainerAuthorAssociation: () => false,
  neutralizeOwnedSectionSpoofing: (value) => value,
  sanitizeArchitectureDiagram: (value) => value,
}).parseLiveProofPlan;

function recommendedPlan(surface: "browser" | "terminal" = "browser"): LiveProofPlan {
  return surface === "browser"
    ? {
        status: "recommended",
        surface,
        terminalCompletion: "not_applicable",
        reason: "The changed setting is visible.",
        payoff: {
          kind: "ui_interaction",
          justification:
            "The viewer sees the changed setting appear after interacting with the page.",
        },
        entry: "/settings",
        steps: [{ action: "expect_text", text: "Saved" }],
      }
    : {
        status: "recommended",
        surface,
        terminalCompletion: "exit_zero",
        reason: "The changed CLI output is visible.",
        payoff: {
          kind: "progressive_output",
          justification: "The viewer sees the CLI output stream as the command progresses.",
        },
        entry: "pnpm cli --help",
        steps: [{ action: "expect_output", text: "Usage" }],
      };
}

function profile(enabled = true): RepositoryProfile {
  return {
    targetRepo: "example/repo",
    slug: "example-repo",
    displayName: "Example",
    checkoutDir: "repo",
    packageManager: "pnpm",
    promptNote: "Example profile.",
    applyCloseRules: {},
    liveTest: {
      enabled,
      surfaceDefault: "browser",
      setup: [],
      allowInstallScripts: false,
      start: "pnpm dev",
      url: "http://localhost:3000",
      readyTimeoutSeconds: 5,
      maxRecordingSeconds: 90,
    },
  };
}

test("live-proof gates skip in order with a successful result", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-gates-"));
  const planPath = join(directory, "plan.json");
  writeFileSync(planPath, JSON.stringify(recommendedPlan()), "utf8");
  const cases: Array<{
    name: string;
    env: NodeJS.ProcessEnv;
    targetProfile: RepositoryProfile;
    plan: LiveProofPlan;
    pull: { kind: "issue" | "pull_request"; state: string; headSha: string | null };
    expected: RegExp;
    expectedFetches: number;
  }> = [
    {
      name: "environment flag",
      env: {},
      targetProfile: profile(),
      plan: recommendedPlan(),
      pull: { kind: "pull_request", state: "open", headSha: HEAD },
      expected: /CLAWSWEEPER_LIVE_PROOF_ENABLED is not 1/,
      expectedFetches: 0,
    },
    {
      name: "repository opt-in",
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      targetProfile: profile(false),
      plan: recommendedPlan(),
      pull: { kind: "pull_request", state: "open", headSha: HEAD },
      expected: /does not enable live_test/,
      expectedFetches: 0,
    },
    {
      name: "plan status",
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      targetProfile: profile(),
      plan: {
        status: "not_applicable",
        surface: "none",
        terminalCompletion: "not_applicable",
        reason: "No visible behavior.",
        payoff: {
          kind: "static_text",
          justification: "There is no visible recording payoff.",
        },
        entry: "",
        steps: [],
      },
      pull: { kind: "pull_request", state: "open", headSha: HEAD },
      expected: /status is not_applicable/,
      expectedFetches: 0,
    },
    {
      name: "suspicious plan is never executed",
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      targetProfile: profile(),
      plan: {
        status: "declined_suspicious",
        surface: "none",
        terminalCompletion: "not_applicable",
        reason: "The command reads credential storage.",
        payoff: {
          kind: "static_text",
          justification: "No presentation payoff was assessed.",
        },
        entry: "",
        steps: [],
      },
      pull: { kind: "pull_request", state: "open", headSha: HEAD },
      expected: /status is declined_suspicious/,
      expectedFetches: 0,
    },
    {
      name: "browser plan on terminal-only profile",
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      targetProfile: {
        ...profile(),
        liveTest: {
          enabled: true,
          surfaceDefault: "terminal",
          setup: [],
          allowInstallScripts: false,
          readyTimeoutSeconds: 5,
          maxRecordingSeconds: 90,
        },
      },
      plan: recommendedPlan("browser"),
      pull: { kind: "pull_request", state: "open", headSha: HEAD },
      expected: /browser plan cannot run .* live_test\.start and live_test\.url are not configured/,
      expectedFetches: 0,
    },
    {
      name: "item kind",
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      targetProfile: profile(),
      plan: recommendedPlan(),
      pull: { kind: "issue", state: "open", headSha: null },
      expected: /is not a pull request/,
      expectedFetches: 1,
    },
    {
      name: "PR open state",
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      targetProfile: profile(),
      plan: recommendedPlan(),
      pull: { kind: "pull_request", state: "closed", headSha: HEAD },
      expected: /pull request is closed/,
      expectedFetches: 1,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const logs: string[] = [];
      let fetches = 0;
      let runnerCalls = 0;
      writeFileSync(planPath, JSON.stringify(fixture.plan), "utf8");
      await executeLiveProof(
        {
          repo: "example/repo",
          item: 42,
          outputDir: join(directory, "output"),
          planPath,
        },
        {
          env: fixture.env,
          repositoryProfileFor: () => fixture.targetProfile,
          reportLiveProofPlan: () => fixture.plan,
          parseLiveProofPlan: () => fixture.plan,
          fetchPullRequest: async () => {
            fetches += 1;
            return fixture.pull;
          },
          runner: () => {
            runnerCalls += 1;
            return { status: 0 };
          },
          log: (message) => logs.push(message),
        },
      );
      assert.equal(fetches, fixture.expectedFetches);
      assert.equal(runnerCalls, 0);
      assert.match(logs.join("\n"), fixture.expected);
    });
  }
});

test("live-proof environments remove known and heuristic credential classes", () => {
  const sanitized = sanitizedLiveProofEnvironment({
    PATH: "/usr/bin",
    CLAWSWEEPER_LIVE_PROOF_ENABLED: "1",
    OPENAI_API_KEY: "openai",
    CLAWSWEEPER_OPENCLAW_OPENAI_KEY: "openclaw",
    GH_TOKEN: "gh",
    GITHUB_TOKEN: "github",
    CLAWSWEEPER_WEBHOOK_SECRET: "webhook",
    AWS_ACCESS_KEY_ID: "aws",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    CLAWSWEEPER_R2_TOKEN: "r2",
    ANTHROPIC_API_KEY: "anthropic",
    SERVICE_KEY: "service",
    NPM_TOKEN: "npm",
    DATABASE_PASSWORD: "database",
  });

  assert.deepEqual(sanitized, {
    PATH: "/usr/bin",
    CLAWSWEEPER_LIVE_PROOF_ENABLED: "1",
  });
  assert.doesNotThrow(() => assertLiveProofEnvironmentSanitized(sanitized));
  assert.throws(
    () => assertLiveProofEnvironmentSanitized({ GH_TOKEN: "still-present" }),
    /still exposes credentials: GH_TOKEN/,
  );
});

test("live-proof rejects an invalid recorded plan instead of treating it as a skip", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-invalid-live-proof-"));
  const planPath = join(directory, "plan.json");
  writeFileSync(planPath, "{}\n");
  let fetches = 0;
  await assert.rejects(
    executeLiveProof(
      {
        repo: "example/repo",
        item: 42,
        outputDir: join(directory, "output"),
        planPath,
      },
      {
        env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
        repositoryProfileFor: () => profile(),
        reportLiveProofPlan: () => recommendedPlan(),
        parseLiveProofPlan: () => ({
          status: "not_applicable",
          surface: "none",
          terminalCompletion: "not_applicable",
          invalid: true,
          reason:
            "The live-proof plan is missing or invalid; regenerate the review report before execution.",
          payoff: {
            kind: "static_text",
            justification: "Invalid report plans are non-runnable and fail closed.",
          },
          entry: "",
          steps: [],
        }),
        fetchPullRequest: async () => {
          fetches += 1;
          return { kind: "pull_request", state: "open", headSha: HEAD };
        },
      },
    ),
    /regenerate the review report before execution/,
  );
  assert.equal(fetches, 0);
  rmSync(directory, { force: true, recursive: true });
});

test("live-proof review child prints the sanitized-environment assertion", async () => {
  const logs: string[] = [];
  const plan: LiveProofPlan = {
    status: "not_applicable",
    surface: "none",
    terminalCompletion: "not_applicable",
    reason: "No executable behavior.",
    payoff: { kind: "static_text", justification: "Static result." },
    entry: "",
    steps: [],
  };
  const commands = createLiveProofCommands({
    repositoryProfileFor: () => profile(),
    reportLiveProofPlan: () => plan,
    parseLiveProofPlan: () => plan,
    attach: attachDependencies({
      runner: () => ({ status: 0 }),
      fetchPullRequest: async () => ({ kind: "pull_request", state: "open", headSha: HEAD }),
      upsertReviewComment: () => ({}),
      logs,
    }),
    fetchPullRequest: async () => ({ kind: "pull_request", state: "open", headSha: HEAD }),
    env: {
      CLAWSWEEPER_SANITIZED_LIVE_PROOF: "1",
      CLAWSWEEPER_LIVE_PROOF_ENABLED: "1",
    },
    log: (message) => logs.push(message),
  });
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-sanitized-assertion-"));
  const planPath = join(directory, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan));

  await commands.liveProofCommand({
    _: [],
    repo: "example/repo",
    item: "42",
    output: join(directory, "output"),
    plan: planPath,
  });

  assert.match(logs.join("\n"), /sanitized environment assertion passed: credentials=0/);
});

test("live-proof install setup disables lifecycle scripts unless the profile opts in", () => {
  for (const [command, expected] of [
    ["pnpm install --frozen-lockfile", "pnpm install --ignore-scripts --frozen-lockfile"],
    ["npm ci", "npm ci --ignore-scripts"],
    ["npm install --omit=dev", "npm install --ignore-scripts --omit=dev"],
    ["bun install", "bun install --ignore-scripts"],
    ["pnpm build", "pnpm build"],
  ]) {
    assert.equal(liveProofSetupCommand(command, false), expected);
  }
  assert.equal(
    liveProofSetupCommand("pnpm install --frozen-lockfile", true),
    "pnpm install --frozen-lockfile",
  );
  assert.equal(
    liveProofSetupCommand("pnpm install --ignore-scripts --frozen-lockfile", false),
    "pnpm install --ignore-scripts --frozen-lockfile",
  );
  assert.throws(
    () => liveProofSetupCommand("bun install --trust package", false),
    /allow_install_scripts: true/,
  );
  assert.throws(
    () => liveProofSetupCommand("npm install --ignore-scripts=false", false),
    /allow_install_scripts: true/,
  );
});

test("live-proof installs a missing Bun toolchain with the official installer", () => {
  const calls: Array<{ command: string; args: readonly string[]; path?: string }> = [];
  const logs: string[] = [];
  const environment: NodeJS.ProcessEnv = { HOME: "/tmp/live-proof-home", PATH: "/usr/bin" };
  let probes = 0;
  ensureLiveProofPackageManager(
    "bun",
    (command, args, options) => {
      calls.push({ command, args, path: options?.env?.PATH ?? environment.PATH });
      if (String(args[1]).startsWith("command -v bun")) {
        probes += 1;
        return { status: probes === 1 ? 1 : 0 };
      }
      return { status: 0 };
    },
    "/tmp/checkout",
    environment,
    (message) => logs.push(message),
  );

  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args].join(" ")),
    [
      "sh -lc command -v bun >/dev/null 2>&1",
      "sh -lc curl -fsSL https://bun.sh/install | bash",
      "sh -lc command -v bun >/dev/null 2>&1",
    ],
  );
  assert.match(environment.PATH ?? "", /^\/tmp\/live-proof-home\/\.bun\/bin:/);
  assert.match(logs.join("\n"), /installed target package manager bun/);
});

test("live-proof resolves pnpm from the configured PNPM_HOME bin directory", () => {
  const calls: Array<{ command: string; args: readonly string[]; path?: string }> = [];
  const environment: NodeJS.ProcessEnv = {
    HOME: "/tmp/live-proof-home",
    PATH: "/usr/bin",
    PNPM_HOME: "/tmp/live-proof-home/pnpm",
  };
  let probes = 0;
  ensureLiveProofPackageManager(
    "pnpm",
    (command, args, options) => {
      calls.push({ command, args, path: options?.env?.PATH ?? environment.PATH });
      if (String(args[1]).startsWith("command -v pnpm")) {
        probes += 1;
        return { status: probes === 1 ? 1 : 0 };
      }
      return { status: 0 };
    },
    "/tmp/checkout",
    environment,
  );

  assert.deepEqual(
    calls.map(({ command, args }) => [command, ...args].join(" ")),
    [
      "sh -lc command -v pnpm >/dev/null 2>&1",
      "sh -lc curl -fsSL https://get.pnpm.io/install.sh | sh -",
      "sh -lc command -v pnpm >/dev/null 2>&1",
    ],
  );
  assert.equal(
    calls.every(({ path }) => path?.startsWith("/tmp/live-proof-home/pnpm/bin:")),
    true,
  );
});

test("live-proof reports an unsupported package manager clearly", () => {
  assert.throws(
    () =>
      ensureLiveProofPackageManager("yarn", () => ({ status: 1 }), "/tmp/checkout", {
        HOME: "/tmp/live-proof-home",
        PATH: "/usr/bin",
      }),
    /unsupported live-proof package manager "yarn"; expected bun, pnpm, or npm/,
  );
});

test("Playwright generation keeps quotes, backticks, and newlines inside JSON data", () => {
  const script = generatePlaywrightScript([
    {
      action: "fill",
      target: 'textarea[data-name="x`"]',
      value: 'quote " and `tick`\nawait globalThis.pwned()',
    },
    { action: "expect_text", text: "line one\nline two" },
  ]);
  assert.match(script, /const steps = JSON\.parse\(/);
  assert.doesNotMatch(script, /const steps = \[\{/);
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-playwright-script-"));
  const path = join(directory, "driver.mjs");
  writeFileSync(path, script, "utf8");
  const checked = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("Playwright scrolls targets into view best effort, settles, and holds a six-second minimum", () => {
  const script = generatePlaywrightScript([
    { action: "click", target: "#save" },
    { action: "wait_for", target: "#result" },
    { action: "expect_text", text: "Saved" },
  ]);
  // Scrolling is best effort: continuously animated targets never settle, and a
  // failed scroll must not defeat the force-click fallback (openclaw/clawsweeper
  // Bay critters made every click time out before this).
  assert.equal(
    script.match(/scrollIntoViewIfNeeded\(\{ timeout: 2_000 \}\)\.catch\(\(\) => undefined\)/g)
      ?.length,
    3,
  );
  assert.match(script, /await page\.waitForTimeout\(700\)/);
  assert.match(script, /Math\.max\(3000, 6000 - elapsed\)/);
});

test("Playwright probes every expected text immediately after the initial navigation", () => {
  const script = generatePlaywrightScript([
    { action: "click", target: "#save" },
    { action: "expect_text", text: "Saved" },
  ]);
  const goto = script.indexOf("await page.goto(new URL(entry, baseUrl).href)");
  const probe = script.indexOf("const expectationPresentAtStart = new Map()", goto);
  const loop = "for (const [index, step] of steps.entries()) {";
  const probeLoop = script.indexOf(loop, probe);
  const actionLoop = script.indexOf(loop, probeLoop + loop.length);
  assert.ok(goto >= 0 && probe > goto && probeLoop > probe && actionLoop > probeLoop);
  assert.match(script, /await locator\.isVisible\(\)\.catch\(\(\) => false\)/);
  assert.match(script, /presentAtStart: expectationPresentAtStart\.get\(index\) === true/);
  assert.match(script, /satisfied: true/);
  assert.doesNotMatch(script, /locator\("body"\)\.innerText/);
  assert.match(script, /writeFile\(outputPath, "", "utf8"\)/);
});

test("terminal driver composes direct Xvfb, xterm, and bounded ffmpeg sessions", () => {
  const commands = terminalCommandPlan({
    sessionPrefix: "proof",
    maxRecordingSeconds: 90,
    rawVideoPath: "/tmp/live-proof.raw.webm",
    tmuxTmpDir: "/tmp/clawsweeper-tmux",
  });
  assert.deepEqual(commands[0], {
    command: "tmux",
    args: [
      "new-session",
      "-d",
      "-s",
      "proof-terminal",
      "-x",
      "160",
      "-y",
      "50",
      "/bin/bash --noprofile --norc",
    ],
  });
  assert.deepEqual(commands[1], {
    command: "tmux",
    args: ["set-option", "-t", "proof-terminal", "history-limit", "50000"],
  });
  assert.deepEqual(commands[2], {
    command: "tmux",
    args: ["set-option", "-t", "proof-terminal", "base-index", "0"],
  });
  assert.deepEqual(commands[3], {
    command: "tmux",
    args: ["move-window", "-r", "-t", "proof-terminal"],
  });
  assert.deepEqual(commands[4], {
    command: "tmux",
    args: ["new-window", "-d", "-t", "proof-terminal:", "/bin/bash --noprofile --norc"],
  });
  assert.deepEqual(commands[5], {
    command: "tmux",
    args: ["resize-window", "-t", "proof-terminal:1", "-x", "160", "-y", "50"],
  });
  assert.deepEqual(commands[6], {
    command: "tmux",
    args: ["kill-window", "-t", "proof-terminal:0"],
  });
  assert.deepEqual(commands[7], {
    command: "tmux",
    args: ["move-window", "-r", "-t", "proof-terminal"],
  });
  assert.deepEqual(commands[8], {
    command: "tmux",
    args: ["set-option", "-w", "-t", "proof-terminal:0", "pane-base-index", "0"],
  });
  assert.deepEqual(commands[9], {
    command: "tmux",
    args: ["set-option", "-w", "-t", "proof-terminal:0.0", "remain-on-exit", "on"],
  });
  assert.deepEqual(commands[10], {
    command: "tmux",
    args: ["set-option", "-w", "-t", "proof-terminal:0.0", "remain-on-exit-format", ""],
  });
  const display = commands.find((invocation) => invocation.args.includes("Xvfb"));
  const xterm = commands.find((invocation) => invocation.args.includes("xterm"));
  const recorder = commands.find((invocation) => invocation.args.includes("ffmpeg"));
  assert.deepEqual(display?.args.slice(4), [
    "Xvfb",
    ":99",
    "-screen",
    "0",
    "1280x800x24",
    "-nolisten",
    "tcp",
  ]);
  assert.equal(display?.waitAfter, "display");
  assert.deepEqual(xterm, {
    command: "tmux",
    args: [
      "new-session",
      "-d",
      "-s",
      "proof-xterm",
      "env",
      "-u",
      "TMUX",
      "-u",
      "TMUX_PANE",
      "DISPLAY=:99",
      "TMUX_TMPDIR=/tmp/clawsweeper-tmux",
      "xterm",
      "-fullscreen",
      "-geometry",
      "160x50+0+0",
      "-e",
      "tmux",
      "attach-session",
      "-t",
      "proof-terminal",
    ],
  });
  assert.equal(
    commands.some((invocation) => invocation.args.includes("xvfb-run")),
    false,
  );
  assert.deepEqual(recorder?.args.slice(4, 13), [
    "timeout",
    "90s",
    "ffmpeg",
    "-hide_banner",
    "-y",
    "-f",
    "x11grab",
    "-video_size",
    "1280x800",
  ]);
  assert.equal(recorder?.waitAfter, "recorder");
  assert.equal(
    commands.some((invocation) => invocation.command === "sleep"),
    false,
  );
});

test("terminal run waits for output and a successful final exit", () => {
  const calls: string[] = [];
  const result = runTerminalFixture(
    terminalLifecycleRunner(calls, {
      terminalCaptures: [
        "$ pnpm cli --help\n",
        "$ pnpm cli --help\n",
        "$ pnpm cli --help\nUsage\n",
      ],
    }),
  );
  assert.equal(result.status, "completed", `${result.output}\n\n${calls.join("\n")}`);
  const respawn = calls.findIndex((call) => call.startsWith("tmux respawn-pane"));
  assert.notEqual(respawn, -1);
  assert.match(result.output, /Usage/);
});

test("terminal keeps silent commands eligible for the full expectation window", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, {
      terminalCaptures: [...Array.from({ length: 21 }, () => ""), "Ready\n"],
    }),
  });

  assert.equal(result.status, "completed", JSON.stringify({ result, calls }, null, 2));
  assert.equal(result.steps[0]?.satisfied, true);
  assert.ok(calls.filter((call) => call === "sleep 1").length >= 21);
});

test("terminal expect_output polls until new command output appears", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    runner: terminalLifecycleRunner(calls, {
      terminalCaptures: ["$ demo\nstarting\n", "$ demo\nstarting\n", "$ demo\nstarting\nReady\n"],
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]?.status, "completed");
  assert.equal(result.steps[0]?.presentAtStart, false);
  assert.equal(result.steps[0]?.satisfied, true);
  assert.ok(calls.includes("sleep 1"));
});

test("terminal expect_output preserves leading and trailing marker whitespace", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "  indented result\n" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      commandExitStatus: 0,
      terminalCaptures: ["  indented result\n"],
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]?.satisfied, true);
});

test("terminal capture normalizes PTY control sequences and carriage returns", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready\nDone" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      terminalCaptures: ["\u001b[32mReady\u001b[0m\r\nDone\r"],
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]?.satisfied, true);
  assert.equal(result.output, "Ready\nDone");
});

test("terminal expect_output records text already present in the plan-start snapshot", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    runner: terminalLifecycleRunner(calls, {
      initialTerminalOutput: "$ Ready\n",
      terminalCaptures: ["$ demo\nReady\n"],
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]?.presentAtStart, true);
  assert.equal(result.steps[0]?.satisfied, true);
});

test("terminal command success cannot waive a missing output expectation", () => {
  const calls: string[] = [];
  const plan: LiveProofPlan = {
    ...recommendedPlan("terminal"),
    entry: "node scripts/run-vitest.mjs src/agents/code-mode.mcp.test.ts",
    steps: [{ action: "expect_output", text: "Code Mode MCP namespace" }],
  };
  const result = driveTerminal({
    plan,
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, {
      terminalCaptures: [
        "$ node scripts/run-vitest.mjs src/agents/code-mode.mcp.test.ts\nTests  10 passed (10)\nwrapper passed after 28.37 seconds\n",
      ],
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.status, "failed");
  assert.equal(result.steps[0]?.satisfied, false);
  assert.match(
    result.steps[0]?.detail ?? "",
    /proof-plan assertion mismatch: terminal command exited successfully.*verify the command\/wrapper\/reporter contract/,
  );
  assert.match(result.output, /Tests  10 passed \(10\)/);
  assert.doesNotMatch(result.output, /\.command-\d+-\d+\.|printf '%s'|mv -f|\/tmp\//);

  const verification = buildLiveVerificationResult({
    repo: "example/repo",
    item: 42,
    headSha: HEAD,
    plan,
    driveStatus: result.status,
    stepLog: result.steps,
    output: result.output,
    verifiedAt: "2026-08-23T12:00:00.000Z",
  });
  assert.equal(verification.overall_pass, false);
  assert.equal(verification.steps[0]?.satisfied, false);
  assert.deepEqual(parseLiveVerificationResult(verification), verification);
  assert.throws(
    () =>
      parseLiveVerificationResult({
        ...verification,
        failure: undefined,
        drive_status: "completed",
        steps: [{ ...verification.steps[0], status: "completed", satisfied: true }],
      }),
    /overall_pass does not match/,
  );
  assert.match(renderLiveVerificationCommentBlock(verification), /\*\*Result:\*\* FAIL/);
  assert.match(renderLiveVerificationCommentBlock(verification), /FAIL `expect_output`/);
  assert.match(renderLiveVerificationCommentBlock(verification), /proof-plan assertion mismatch/);
});

test("terminal command timeout remains a failed output expectation", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "timeout 5 demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, {
      terminalCaptures: [
        "$ timeout 5 demo\nwaiting for the command\n",
        "$ timeout 5 demo\nwaiting for the command\n",
        "$ timeout 5 demo\nwaiting for the command\n",
        "$ timeout 5 demo\nwaiting for the command\n",
      ],
      commandExitStatus: 124,
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.status, "failed");
  assert.equal(result.steps[0]?.satisfied, false);
  assert.match(result.steps[0]?.detail ?? "", /failed with exit status 124/);
  assert.equal(calls.filter((call) => call === "sleep 1").length, 3);
});

test("terminal seals rolling capture before rendering a still-running timeout", () => {
  const calls: string[] = [];
  const fixtureRunner = terminalLifecycleRunner(calls, {
    heldCommandKeepsRunning: true,
    terminalCaptures: ["EARLY_DIAGNOSTIC\n" + "tail\n".repeat(100)],
  });
  const runner: MediaProofCommandRunner = (tool, args, options) => {
    if (tool === "tmux" && args[0] === "capture-pane") {
      calls.push([tool, ...args].join(" "));
      return { status: 0, stdout: "tail only\n" };
    }
    return fixtureRunner(tool, args, options);
  };
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo-server",
      steps: [{ action: "expect_output", text: "never-ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner,
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /EARLY_DIAGNOSTIC/);
  const watchdog = calls.findIndex((call) => call.startsWith("tmux run-shell -b "));
  const target = calls.indexOf("target-start");
  const pipeClose = calls.findIndex((call) => call.startsWith("tmux pipe-pane -t "));
  assert.ok(watchdog < target);
  assert.ok(target < pipeClose);
});

test("terminal rejects a capture stream that does not seal with clean EOF", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      captureCompletion: "error",
      terminalCaptures: ["Ready\n"],
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /terminal capture helper ended unexpectedly: error/);
});

test("terminal nonzero and signal exits fail even when the expected marker is present", () => {
  for (const [exitStatus, reason] of [
    [7, /failed with exit status 7/],
    [143, /terminated by a signal with exit status 143/],
  ] as const) {
    const result = driveTerminal({
      plan: {
        ...recommendedPlan("terminal"),
        entry: "demo",
        steps: [{ action: "expect_output", text: "Ready" }],
      },
      checkout: "/tmp/checkout",
      rawVideoPath: "/tmp/live-proof.raw.webm",
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: terminalLifecycleRunner([], {
        ...(exitStatus === 143 ? { commandSignal: "SIGTERM" } : { commandExitStatus: exitStatus }),
        terminalCaptures: ["$ demo\nReady\n"],
      }),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.steps[0]?.status, "failed");
    assert.match(result.steps[0]?.detail ?? "", reason);
  }
});

test("terminal waits for tmux to publish a final zero exit", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      terminalPaneSequence: [{ status: "running" }, { status: "exited", exitStatus: 0 }],
      terminalCaptures: ["Ready\n", "Ready\n"],
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]?.satisfied, true);
});

test("held terminal cutover seals capture before controller-owned cleanup", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, { terminalCaptures: ["Ready\n"] }),
  });

  assert.equal(result.status, "completed");
  const respawn = calls.findIndex((call) => call.startsWith("tmux respawn-pane"));
  const pipeOpen = calls.findIndex((call) => call.startsWith("tmux pipe-pane -O"));
  const status = calls.findIndex((call) => call.startsWith("status "));
  const pipeClose = calls.findIndex((call) => call.startsWith("tmux pipe-pane -t "));
  const viewport = calls.findIndex(
    (call, index) =>
      index > pipeClose && call.startsWith("tmux capture-pane") && !call.includes(" -S "),
  );
  const cleanupArm = calls.findIndex((call) => call.startsWith("tmux run-shell -b "));
  const watchdogArmed = calls.indexOf("watchdog-armed");
  const targetStart = calls.indexOf("target-start");
  const cleanupRequest = calls.indexOf("cleanup-controller");
  assert.ok(respawn < pipeOpen);
  assert.ok(pipeOpen < cleanupArm);
  assert.ok(cleanupArm < watchdogArmed);
  assert.ok(watchdogArmed < targetStart);
  assert.ok(targetStart < status);
  assert.ok(status < pipeClose);
  assert.ok(pipeClose < viewport);
  assert.ok(viewport < cleanupRequest);
});

test("held terminal completion rejects malformed and missing status evidence", () => {
  for (const [options, expected] of [
    [{ recordedStatuses: ["invalid"] }, /status is malformed/],
    [{ recordedStatuses: [null], heldPaneExitsBeforeCleanup: true }, /before recording.*status/],
  ] as const) {
    const result = driveTerminal({
      plan: {
        ...recommendedPlan("terminal"),
        entry: "demo",
        steps: [{ action: "expect_output", text: "Ready" }],
      },
      checkout: "/tmp/checkout",
      rawVideoPath: "/tmp/live-proof.raw.webm",
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: terminalLifecycleRunner([], {
        ...options,
        terminalCaptures: ["Ready\n"],
      }),
    });

    assert.equal(result.status, "failed");
    assert.match(result.output, expected);
  }
});

test("terminal cleanup still runs after the pane wrapper exits", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, {
      recordedStatuses: [null],
      heldPaneExitsBeforeCleanup: true,
      terminalCaptures: ["Ready\n"],
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /before recording.*status/);
  assert.equal(
    calls.some((call) => call.startsWith("tmux run-shell -b ")),
    true,
  );
  assert.equal(calls.includes("cleanup-pane-death"), true);
});

test("terminal does not start the target without an exact watchdog arm receipt", () => {
  for (const options of [
    { watchdogNeverArms: true },
    { armedAcknowledgement: "v1|armed|stale|41001|/dev/ttys001|1:2|42001\n" },
  ]) {
    const calls: string[] = [];
    const result = driveTerminal({
      plan: {
        ...recommendedPlan("terminal"),
        entry: "demo",
        steps: [{ action: "expect_output", text: "Ready" }],
      },
      checkout: "/tmp/checkout",
      rawVideoPath: "/tmp/live-proof.raw.webm",
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: terminalLifecycleRunner(calls, {
        ...options,
        terminalCaptures: ["Ready\n"],
      }),
    });

    assert.equal(result.status, "failed");
    assert.equal(calls.includes("target-start"), false);
    assert.match(result.output, /cleanup watchdog/);
  }
});

test("held terminal completion rejects a non-regular status path without blocking", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-status-"));
  try {
    const fixtureRunner = terminalLifecycleRunner([], {
      terminalCaptures: ["Ready\n"],
    });
    const runner: MediaProofCommandRunner = (command, args, options) => {
      const result = fixtureRunner(command, args, options);
      if (command === "tmux" && args[0] === "respawn-pane") {
        const invocation = terminalCommandInvocation(args);
        if (invocation) {
          assert.equal(spawnSync("mkfifo", [invocation.status]).status, 0);
        }
      }
      return result;
    };
    const result = driveTerminal({
      plan: {
        ...recommendedPlan("terminal"),
        entry: "demo",
        steps: [{ action: "expect_output", text: "Ready" }],
      },
      checkout: "/tmp/checkout",
      rawVideoPath: join(directory, "proof.webm"),
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner,
    });

    assert.equal(result.status, "failed");
    assert.match(result.output, /terminal control path is not a regular file/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("held terminal completion observes output rendered after status publication", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "fast-demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      heldCommandKeepsRunning: true,
      terminalCaptures: ["starting\n"],
      recordStatusOnHistoryProbe: 1,
      terminalCaptureAfterStatus: "starting\nReady\n",
    }),
  });

  assert.equal(result.status, "completed", result.output);
  assert.equal(result.steps[0]?.satisfied, true);
  assert.match(result.output, /Ready/);
});

test("parsed finite terminal expectations wait for a summary after thirty seconds", async (t) => {
  for (const form of ["entry", "setup+run", "finite-before-ready"] as const) {
    await t.test(form, (t) => {
      let now = 1_000_000;
      t.mock.method(Date, "now", () => now);
      const parsed = liveProofPlanParser(
        {
          ...recommendedPlan("terminal"),
          terminalCompletion: form === "finite-before-ready" ? "ready_while_running" : "exit_zero",
          payoff: { kind: "static_text", justification: "The final summary is sufficient." },
          entry: form === "setup+run" ? "setup" : "finite-test",
          steps: [
            ...(form === "setup+run" ? [{ action: "run", command: "finite-test" }] : []),
            { action: "expect_output", text: "[test] passed" },
            { action: "expect_output", text: "Vitest shard" },
            ...(form === "finite-before-ready"
              ? [
                  { action: "run", command: "server" },
                  { action: "expect_output", text: "Listening" },
                ]
              : []),
          ],
        },
        "liveProofPlan",
      );
      const plan = reportLiveProofPlanForTest(`## Live Proof

Status: ${parsed.status}
Surface: ${parsed.surface}
Terminal completion: ${parsed.terminalCompletion}
Reason: ${parsed.reason}
Payoff: ${parsed.payoff.kind}
Payoff justification: ${parsed.payoff.justification}
Entry: ${parsed.entry}

Steps:

${parsed.steps.map((step) => `- ${JSON.stringify(step)}`).join("\n")}
`);
      assert.deepEqual(plan, parsed);
      const calls: string[] = [];
      const fixtureRunner = terminalLifecycleRunner(calls, {
        terminalCapturesByCommand: {
          setup: ["setup complete\n"],
          "finite-test": [
            ...Array<string>(35).fill("starting\n"),
            "starting\n[test] passed 1 Vitest shard in 35s\n",
          ],
          server: ["Listening\n"],
        },
        keepsRunningCommands: ["server"],
      });
      const driven = driveTerminal({
        plan,
        checkout: "/tmp/checkout",
        rawVideoPath: "/tmp/live-proof.raw.webm",
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: (command, args, options) => {
          const result = fixtureRunner(command, args, options);
          if (command === "sleep") now += Number(args[0]) * 1_000;
          return result;
        },
      });
      const verification = buildLiveVerificationResult({
        repo: "example/repo",
        item: 42,
        headSha: HEAD,
        plan,
        driveStatus: driven.status,
        stepLog: driven.steps,
        output: driven.output,
        verifiedAt: "2026-08-27T00:00:00.000Z",
      });
      assert.equal(verification.overall_pass, true, JSON.stringify(verification));
      assert.deepEqual(parseLiveVerificationResult(verification), verification);
      assert.equal(
        verification.steps.every((step) => step.status === "completed"),
        true,
      );
      assert.ok(now >= 1_035_000 && now < 1_090_000);
      const commandCount = form === "entry" ? 1 : 2;
      assert.equal(
        calls.filter((call) => call.startsWith("tmux pipe-pane -t ")).length,
        commandCount,
      );
      assert.equal(calls.filter((call) => call === "watchdog-armed").length, commandCount);
      assert.match(renderLiveVerificationCommentBlock(verification), /\*\*Result:\*\* PASS/);
    });
  }
});

test("terminal pane status corruption fails closed before controller cleanup", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, {
      malformedPaneStatus: "not-a-pane-status",
      malformedPaneStatusAfterProbe: 1,
      terminalCaptures: ["Ready\n"],
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /pane status is malformed/);
  assert.equal(
    calls.some((call) => call.startsWith("tmux run-shell -b ")),
    false,
  );
});

test("terminal cleanup waits for both tmux process status and PTY closure", () => {
  // tmux publishes waitpid status and closes the PTY in separate callbacks.
  for (const transition of ["0||KILL", "0|0|", "1||"]) {
    const calls: string[] = [];
    const fixtureRunner = terminalLifecycleRunner(calls, { terminalCaptures: ["Ready\n"] });
    let transitional = false;
    let polled = false;
    const finalState = transition === "0||KILL" ? "1||KILL" : "1|0|";
    const result = driveTerminal({
      plan: { ...recommendedPlan("terminal"), entry: "demo", steps: [] },
      checkout: "/tmp/checkout",
      rawVideoPath: "/tmp/live-proof.raw.webm",
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: (tool, args, options) => {
        const result = fixtureRunner(tool, args, options);
        if (transitional && tool === "sleep" && args[0] === "0.1") polled = true;
        if (
          tool === "tmux" &&
          args[0] === "display-message" &&
          String(result.stdout).endsWith("|1|0|\n")
        ) {
          const state = transitional ? finalState : transition;
          transitional = true;
          return { ...result, stdout: String(result.stdout).replace(/1\|0\|\n$/, `${state}\n`) };
        }
        return result;
      },
    });
    assert.equal(result.status, "completed", result.output);
    assert.equal(transitional, true, transition);
    assert.equal(polled, true, "a cleanup receipt alone must not waive the final pane state");
  }
});

test("terminal wrapper death owns failure status and seals capture after verified cleanup", () => {
  for (const childStatus of [143, undefined]) {
    const calls: string[] = [];
    const fixtureRunner = terminalLifecycleRunner(calls, {
      commandKeepsRunning: true,
      terminalCaptures: ["Ready\n"],
    });
    let invocation: ReturnType<typeof terminalCommandInvocation>;
    let cleanup: TerminalCleanupInvocation | undefined;
    let dead = false;
    let removed = false;
    const result = driveTerminal({
      plan: {
        ...recommendedPlan("terminal"),
        terminalCompletion: "ready_while_running",
        entry: "demo-server",
        steps: [{ action: "expect_output", text: "Ready" }],
      },
      checkout: "/tmp/checkout",
      rawVideoPath: "/tmp/live-proof.raw.webm",
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: (tool, args, options) => {
        if (tool === "tmux" && args[0] === "respawn-pane")
          invocation = terminalCommandInvocation(args);
        if (tool === "tmux" && args[0] === "run-shell") cleanup = terminalCleanupInvocation(args);
        if (tool === "sleep" && args[0] === "3") {
          dead = true;
          assert.ok(invocation);
          if (childStatus !== undefined) writeFileSync(invocation.status, `${childStatus}\n`);
        }
        if (dead && tool === "tmux" && args[0] === "pipe-pane" && !args.includes("-O")) {
          return { status: 1, stderr: "target pane has exited" };
        }
        if (tool === "tmux" && args[0] === "kill-pane") {
          assert.equal(dead, true);
          assert.ok(cleanup);
          assert.match(readFileSync(cleanup.result, "utf8"), /\|controller\|ok\|0\n$/);
          removed = true;
          // Destroying the pane closes tmux's pipe; only then can its reader see EOF.
          return fixtureRunner("tmux", ["pipe-pane", ...args.slice(1)], options);
        }
        const result = fixtureRunner(tool, args, options);
        if (
          dead &&
          tool === "tmux" &&
          args[0] === "display-message" &&
          String(result.stdout).includes("/dev/")
        ) {
          assert.equal(removed, false, "the original pane must be verified before it is removed");
          return {
            ...result,
            stdout: String(result.stdout).replace(/\|[01]\|[^|]*\|[^|]*\n$/, "|1||KILL\n"),
          };
        }
        return result;
      },
    });
    assert.equal(result.status, "failed", result.output);
    assert.match(result.output, /terminated by a signal with exit status 137/);
    assert.doesNotMatch(result.output, /terminal capture helper|cleanup failure/);
    assert.match(result.output, /\[command 1 combined output\]\nReady/);
    assert.equal(removed, true);
  }
});

test("finite terminal expectations cannot pass an early summary followed by a nonzero exit", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [
        { action: "expect_output", text: "Ready" },
        { action: "expect_output", text: "Ready" },
      ],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    runner: terminalLifecycleRunner(calls, {
      commandCompletionAfterProbe: 35,
      commandExitStatus: 7,
      terminalCaptures: ["$ demo\nReady\n", "$ demo\nReady\n"],
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.status, "failed");
  assert.equal(result.steps[0]?.satisfied, false);
  assert.equal(result.steps.length, 1);
  assert.match(result.steps[0]?.detail ?? "", /failed with exit status 7/);
});

test("terminal commands with no assertion or only a wait cannot hide a nonzero exit", () => {
  for (const steps of [[], [{ action: "wait", seconds: 2 }]] as const) {
    const result = driveTerminal({
      plan: { ...recommendedPlan("terminal"), entry: "demo", steps: [...steps] },
      checkout: "/tmp/checkout",
      rawVideoPath: "/tmp/live-proof.raw.webm",
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: terminalLifecycleRunner([], {
        commandSignal: "SIGTERM",
        terminalCaptures: ["$ demo\nworking\n"],
      }),
    });

    assert.equal(result.status, "failed");
    assert.match(
      steps.length ? (result.steps[0]?.detail ?? "") : result.output,
      /terminated by a signal with exit status 143/,
    );
  }
});

test("terminal finalization catches a prompt failure before cleanup", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "printf 'Ready\\n'; sleep 1; exit 7",
      steps: [],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      commandExitStatus: 7,
      terminalCaptures: ["$ printf 'Ready\\n'; sleep 1; exit 7\nReady\n"],
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /failed with exit status 7/);
});

test("terminal accepts a successful silent command", () => {
  const result = driveTerminal({
    plan: { ...recommendedPlan("terminal"), entry: "true", steps: [] },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      commandExitStatus: 0,
      terminalCaptures: ["$ true\n"],
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.output, "");
});

test("terminal artifact errors redact private command paths", () => {
  const fixtureRunner = terminalLifecycleRunner([], { terminalCaptures: ["command output\n"] });
  const runner: MediaProofCommandRunner = (tool, args, options) => {
    if (tool === "tmux" && args[0] === "respawn-pane") {
      const invocation = terminalCommandInvocation(args);
      if (!invocation) return fixtureRunner(tool, args, options);
      return { status: 1, stderr: `EACCES: cannot read ${invocation.command}` };
    }
    return fixtureRunner(tool, args, options);
  };
  const result = driveTerminal({
    plan: { ...recommendedPlan("terminal"), entry: "demo", steps: [] },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner,
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /<private path>/);
  assert.doesNotMatch(result.output, /live-proof\.raw\.webm\.command-/);
});

test("ready_while_running requires a satisfied marker and a live final command", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      terminalCompletion: "ready_while_running",
      entry: "demo-server",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, {
      commandKeepsRunning: true,
      terminalCaptures: ["$ demo-server\nReady\n"],
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps[0]?.satisfied, true);
  const finalLivenessProbe = calls.findLastIndex(
    (call) =>
      call.startsWith("tmux display-message") &&
      call.endsWith("#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"),
  );
  const pipeClose = calls.findLastIndex((call) => call.startsWith("tmux pipe-pane -t "));
  assert.equal(pipeClose < finalLivenessProbe, true);
  assert.equal(
    calls.some((call) => call.endsWith("sleep 30")),
    false,
  );
  assert.equal(calls.includes("sleep 3"), true);
});

test("terminal launch mode keeps intermediates and the final ready command supervised", () => {
  const launchModes: boolean[] = [];
  const fixtureRunner = terminalLifecycleRunner([], {
    keepsRunningCommands: ["server"],
    terminalCapturesByCommand: {
      prepare: ["prepared\n"],
      server: ["Ready\n"],
    },
  });
  const runner: MediaProofCommandRunner = (tool, args, options) => {
    if (tool === "tmux" && args[0] === "respawn-pane") {
      const invocation = terminalCommandInvocation(args);
      if (invocation) launchModes.push(invocation.held);
    }
    return fixtureRunner(tool, args, options);
  };
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      terminalCompletion: "ready_while_running",
      entry: "prepare",
      steps: [
        { action: "run", command: "server" },
        { action: "expect_output", text: "Ready" },
      ],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(launchModes, [true, true]);
});

test("ready_while_running rejects a command that exits during pipe shutdown", () => {
  const calls: string[] = [];
  const fixtureRunner = terminalLifecycleRunner(calls, {
    commandKeepsRunning: true,
    terminalCaptures: ["Ready\n"],
  });
  let pipeCloseFailed = false;
  let panePid = 0;
  const runner: MediaProofCommandRunner = (tool, args, options) => {
    if (
      pipeCloseFailed &&
      tool === "tmux" &&
      args[0] === "display-message" &&
      args.at(-1) === "#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"
    ) {
      calls.push([tool, ...args].join(" "));
      return { status: 0, stdout: `${panePid}|/dev/ttys001|1|0|\n` };
    }
    if (tool === "tmux" && args[0] === "pipe-pane" && !args.includes("-O") && !pipeCloseFailed) {
      calls.push([tool, ...args].join(" "));
      pipeCloseFailed = true;
      return { status: 1, stderr: "target pane has exited" };
    }
    const result = fixtureRunner(tool, args, options);
    if (
      tool === "tmux" &&
      args[0] === "display-message" &&
      args.at(-1) === "#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"
    ) {
      panePid = Number.parseInt(String(result.stdout), 10);
    }
    return result;
  };
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      terminalCompletion: "ready_while_running",
      entry: "demo-server",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner,
  });

  assert.equal(result.status, "failed", JSON.stringify({ result, calls }, null, 2));
  assert.match(result.steps[0]?.detail ?? "", /exited after satisfying its expectation/);
  assert.equal(pipeCloseFailed, true);
  assert.equal(
    calls.some((call) => call.endsWith("sleep 30")),
    false,
  );
  assert.equal(calls.filter((call) => call.startsWith("tmux pipe-pane -t ")).length, 1);
});

test("terminal rejects a pane identity change without scheduling tty cleanup", () => {
  const calls: string[] = [];
  const fixtureRunner = terminalLifecycleRunner(calls, {
    commandKeepsRunning: true,
    terminalCaptures: ["Ready\n"],
  });
  let stateProbe = 0;
  const runner: MediaProofCommandRunner = (tool, args, options) => {
    const result = fixtureRunner(tool, args, options);
    if (
      tool === "tmux" &&
      args[0] === "display-message" &&
      args.at(-1) === "#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"
    ) {
      stateProbe += 1;
      if (stateProbe > 1) return { ...result, stdout: "41999|/dev/ttys999|0||\n" };
    }
    return result;
  };
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      terminalCompletion: "ready_while_running",
      entry: "demo-server",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner,
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /pane identity changed from launch 41001\|\/dev\/ttys001/);
  assert.equal(
    calls.some((call) => call.startsWith("tmux run-shell -b ")),
    false,
  );
});

test("terminal cleanup requires the exact pane receipt and pane death", () => {
  const calls: string[] = [];
  let cleanupScript = "";
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      terminalCompletion: "ready_while_running",
      entry: "demo-server",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, {
      commandKeepsRunning: true,
      terminalCaptures: ["Ready\n"],
      inspectCleanupScript: (script) => {
        cleanupScript = script;
      },
    }),
  });

  assert.equal(result.status, "completed");
  assert.match(cleanupScript, /\/usr\/sbin\/lsof -t -X -- "\$lease_path"/);
  assert.match(cleanupScript, /\/usr\/sbin\/lsof -t -X -a -p "\$1" -- "\$lease_path"/);
  assert.match(cleanupScript, /stat -Lc '%d:%i' -- \/proc\/"\$1"\/fd\/9/);
  assert.match(
    cleanupScript,
    /find -L \/proc\/\[0-9\]\*\/fd\/9 -maxdepth 0 -samefile "\$lease_path"/,
  );
  assert.match(
    cleanupScript,
    /awk -F\/ 'NF == 4 && \$2 == "proc" && \$3 ~ \/\^\[0-9\]\+\$\/ && \$4 == "fd" \{ print \$3 \}'/,
  );
  assert.doesNotMatch(cleanupScript, /\/proc\/"\$1"\/fd\/\*/);
  assert.doesNotMatch(cleanupScript, /find -L \/proc\/\[0-9\]\*\/fd -/);
  assert.match(
    cleanupScript,
    /pane_owns_tty\(\) \{ holds_lease "\$pane_pid" && on_bound_tty "\$pane_pid"; \}/,
  );
  assert.match(
    cleanupScript,
    /tty_pids\(\) \{\s+pane_owns_tty \|\| return 0\s+\/bin\/ps -t "\$tty_name" -o pid=,tty=/,
  );
  assert.match(
    cleanupScript,
    /scan_bound_processes\(\) \{\s+: >"\$scan_file"\s+lease_pids >>"\$scan_file" \|\| return \$\?\s+tty_pids >>"\$scan_file"/,
  );
  assert.match(
    cleanupScript,
    /if ! holds_lease "\$candidate"; then\s+on_bound_tty "\$candidate" \|\| exit 0\s+pane_owns_tty \|\| exit 0\s+fi\s+\/bin\/kill/,
  );
  assert.match(cleanupScript, /pane_owns_tty \|\| finish startup error:pane-identity/);
  assert.match(cleanupScript, /elif ! pane_owns_tty; then\s+trigger=pane-death/);
  assert.doesNotMatch(
    cleanupScript,
    /holds_lease "\$candidate" \|\| on_bound_tty "\$candidate" \|\| continue/,
  );
  assert.match(cleanupScript, /signal_bound_processes TERM/);
  assert.match(cleanupScript, /signal_bound_processes KILL/);
  assert.match(cleanupScript, /stable_empty.*-ge 2/s);
  const respawn = calls.find((call) => call.startsWith("tmux respawn-pane"));
  assert.doesNotMatch(respawn ?? "", /tmux run-shell -b/);
  assert.match(respawn ?? "", /while :; do sleep 3600; done/);
  assert.match(respawn ?? "", /exec 9<"\$8"/);
  assert.match(respawn ?? "", /\) 9<&9 <"\$tty_path" >"\$tty_path" 2>&1/);
  assert.match(respawn ?? "", /read -r bound_pid bound_tty bound_nonce bound_lease bound_extra/);
  assert.match(respawn ?? "", /v1\|execute/);
  assert.equal(calls.filter((call) => call.startsWith("tmux run-shell -b ")).length, 1);
  assert.ok(calls.indexOf("watchdog-armed") < calls.indexOf("target-start"));
  assert.notEqual(calls.indexOf("cleanup-controller"), -1);
  assert.equal(
    calls.some((call) => call.startsWith("/bin/kill ") || call.startsWith("/bin/ps ")),
    false,
  );

  const leaseQueries = cleanupScript.slice(
    cleanupScript.indexOf('if [ "$(/usr/bin/uname -s)" = Darwin ]; then'),
    cleanupScript.indexOf("on_bound_tty()"),
  );
  assert.ok(leaseQueries);
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-lease-queries-"));
  const lease = join(root, "lease");
  writeFileSync(lease, "");
  try {
    for (const [descriptors, expected] of [
      ['exec 9<"$lease_path"', "yes"],
      ['exec 9<"$lease_path"; exec 8<&9; exec 9<&-', process.platform === "darwin" ? "yes" : "no"],
      ['exec 9<"$lease_path"; exec 9<&-', "no"],
      ['exec 9<"$2"', "no"],
    ]) {
      const query = spawnSync(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            "lease_path=$1",
            leaseQueries,
            "lease_identity=$(lease_identity_now)",
            descriptors,
            'if holds_lease "$$"; then echo yes; else echo no; fi',
            'if lease_pids | /usr/bin/grep -qx "$$"; then echo yes; else echo no; fi',
          ].join("\n"),
          "clawsweeper-lease-query",
          lease,
          root,
        ],
        { encoding: "utf8" },
      );
      assert.equal(query.status, 0, query.stderr);
      assert.equal(query.stdout, `${expected}\n${expected}\n`, descriptors);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal cleanup joins signal workers and retains early failures", () => {
  let cleanupScript = "";
  driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      terminalCaptures: ["Ready\n"],
      inspectCleanupScript: (script) => {
        cleanupScript = script;
      },
    }),
  });
  const signalWorkers = cleanupScript.slice(
    cleanupScript.indexOf("signal_bound_processes()"),
    cleanupScript.indexOf('[ "$(lease_identity_now)"'),
  );
  assert.equal(signalWorkers.match(/\/bin\/kill/g)?.length, 1);
  for (const fails of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-signal-workers-"));
    try {
      writeFileSync(
        join(root, "scan"),
        Array.from({ length: 12 }, (_, index) => `${index + 1}\n`).join(""),
      );
      const result = spawnSync(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          [
            'root=$1; fails=$2; scan_file="$root/scan"',
            'holds_lease() { builtin printf "checked\\n" >>"$root/checked-$1"; }',
            // Only signal delivery is replaced; execute the generated worker scheduler.
            'signal_probe() { [ "$2" -ne 12 ] || sleep 0.05; builtin printf "%s\\n" "$1" >>"$root/signal-$2"; if [ "$fails" = yes ] && [ "$2" -eq 1 ]; then return 2; fi; return 0; }',
            signalWorkers.replace("/bin/kill", "signal_probe"),
            "signal_bound_processes TERM; code=$?",
            'for ((index = 1; index <= 12; index += 1)); do [ -s "$root/signal-$index" ] || exit 99; done',
            'exit "$code"',
          ].join("\n"),
          "clawsweeper-signal-workers",
          root,
          fails ? "yes" : "no",
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, fails ? 1 : 0, result.stderr);
      for (let index = 1; index <= 12; index += 1) {
        assert.equal(readFileSync(join(root, `checked-${index}`), "utf8"), "checked\n");
        assert.equal(readFileSync(join(root, `signal-${index}`), "utf8"), "-TERM\n");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("terminal rejects a malformed pane readiness acknowledgement", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      readyAcknowledgement: "41001|/dev/ttys001|stale-nonce\n",
      terminalCaptures: ["Ready\n"],
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /readiness acknowledgement is malformed/);
});

test("terminal cleanup fails when the pane does not die after scheduling", () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      driveTerminal({
        plan: {
          ...recommendedPlan("terminal"),
          terminalCompletion: "ready_while_running",
          entry: "demo-server",
          steps: [{ action: "expect_output", text: "Ready" }],
        },
        checkout: "/tmp/checkout",
        rawVideoPath: "/tmp/live-proof.raw.webm",
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: terminalLifecycleRunner(calls, {
          commandKeepsRunning: true,
          terminalCaptures: ["Ready\n"],
          cleanupNeverCompletes: true,
        }),
      }),
    /terminal cleanup failed/,
  );
  assert.equal(calls.filter((call) => call.startsWith("tmux run-shell -b ")).length, 1);
});

test("terminal cleanup fails when tmux replaces the pane after scheduling", () => {
  assert.throws(
    () =>
      driveTerminal({
        plan: {
          ...recommendedPlan("terminal"),
          terminalCompletion: "ready_while_running",
          entry: "demo-server",
          steps: [{ action: "expect_output", text: "Ready" }],
        },
        checkout: "/tmp/checkout",
        rawVideoPath: "/tmp/live-proof.raw.webm",
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: terminalLifecycleRunner([], {
          commandKeepsRunning: true,
          terminalCaptures: ["Ready\n"],
          cleanupReplacementPid: 41_999,
        }),
      }),
    /terminal cleanup failed/,
  );
});

test("terminal cleanup rejects an operational error receipt after pane death", () => {
  assert.throws(
    () =>
      driveTerminal({
        plan: {
          ...recommendedPlan("terminal"),
          terminalCompletion: "ready_while_running",
          entry: "demo-server",
          steps: [{ action: "expect_output", text: "Ready" }],
        },
        checkout: "/tmp/checkout",
        rawVideoPath: "/tmp/live-proof.raw.webm",
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: terminalLifecycleRunner([], {
          commandKeepsRunning: true,
          terminalCaptures: ["Ready\n"],
          cleanupResult: "error:kill:2",
        }),
      }),
    /terminal cleanup failed/,
  );
});

test("terminal cleanup cannot accept success while lease survivors remain", () => {
  assert.throws(
    () =>
      driveTerminal({
        plan: {
          ...recommendedPlan("terminal"),
          terminalCompletion: "ready_while_running",
          entry: "demo-server",
          steps: [{ action: "expect_output", text: "Ready" }],
        },
        checkout: "/tmp/checkout",
        rawVideoPath: "/tmp/live-proof.raw.webm",
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: terminalLifecycleRunner([], {
          commandKeepsRunning: true,
          terminalCaptures: ["Ready\n"],
          cleanupSurvivors: 1,
        }),
      }),
    /terminal cleanup failed/,
  );
});

test("ready_while_running fails when the final command exits during the recording hold", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      terminalCompletion: "ready_while_running",
      entry: "demo-server",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    runner: terminalLifecycleRunner([], {
      terminalPaneSequence: [{ status: "running" }, { status: "exited", exitStatus: 0 }],
      terminalCaptures: ["Ready\n", "Ready\n"],
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.steps[0]?.detail ?? "", /exited after satisfying its expectation/);
});

test("ready_while_running fails when the final command exits during recorder finalization", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      terminalCompletion: "ready_while_running",
      entry: "demo-server",
      steps: [{ action: "expect_output", text: "Ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    runner: terminalLifecycleRunner(calls, {
      commandKeepsRunning: true,
      terminalCaptures: ["Ready\n"],
      paneStatusDuringFinalize: { status: "exited", exitStatus: 7 },
    }),
  });

  assert.equal(result.status, "failed");
  assert.match(result.steps[0]?.detail ?? "", /exited after satisfying its expectation/);
  assert.notEqual(
    calls.findIndex((call) => /tmux send-keys .* q$/.test(call)),
    -1,
  );
});

test("terminal output publishes only the final command viewport", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "first-command",
      steps: [
        { action: "run", command: "second-command" },
        { action: "expect_output", text: "second result" },
      ],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([], {
      commandExitStatus: 0,
      terminalCapturesByCommand: {
        "first-command": ["$ first-command\nfirst result\nfirst diagnostic\n"],
        "second-command": ["$ second-command\nsecond result\n"],
      },
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.output, "second result");
  assert.doesNotMatch(result.output, /first result/);
  assert.doesNotMatch(result.output, /first diagnostic/);
  assert.doesNotMatch(result.output, /\.wrapper|\.command|\.status|\/tmp\//);
});

test("parsed terminal repeats execute independently and retain failure gates", () => {
  const command = "proof-command";
  for (const failRepeat of [false, true]) {
    const executed: string[] = [];
    const fixtureRunner = terminalLifecycleRunner([], {
      terminalCaptures: ["Ready\n"],
      commandExitStatuses: failRepeat ? [0, 7, 0, 0] : [0, 0, 0, 0],
    });
    const plan = liveProofPlanParser(
      {
        ...recommendedPlan("terminal"),
        entry: command,
        steps: [
          { action: "run", command },
          { action: "run", command: "change-state" },
          { action: "run", command },
          { action: "expect_output", text: "Ready" },
        ],
      },
      "liveProofPlan",
    );
    const result = driveTerminal({
      plan,
      checkout: "/tmp/checkout",
      rawVideoPath: "/tmp/live-proof.raw.webm",
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: (tool, args, options) => {
        if (tool === "tmux" && args[0] === "respawn-pane") {
          const invocation = terminalCommandInvocation(args);
          if (!invocation) return fixtureRunner(tool, args, options);
          const path = invocation.command;
          assert.ok(path);
          executed.push(readFileSync(path, "utf8").trimEnd());
        }
        return fixtureRunner(tool, args, options);
      },
    });
    assert.deepEqual(
      executed,
      failRepeat ? [command, command] : [command, command, "change-state", command],
    );
    assert.equal(result.status, failRepeat ? "partial" : "completed");
    if (failRepeat) {
      assert.match(
        result.steps.find((step) => step.status === "failed")?.detail ?? "",
        /exit status 7/,
      );
    }
  }
});

test("terminal entry executes once and publishes only its final visible viewport", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-output-"));
  const fixturePath = join(directory, "fixture.mjs");
  const counterPath = join(directory, "counter.txt");
  writeFileSync(
    fixturePath,
    [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      'const count = existsSync("counter.txt") ? Number(readFileSync("counter.txt", "utf8")) : 0;',
      'writeFileSync("counter.txt", String(count + 1), "utf8");',
      'process.stdout.write("COLD_BUILD_START\\n");',
      'process.stdout.write("dependency build warning\\n".repeat(1_200));',
      "for (let index = 1; index <= 58; index += 1) process.stdout.write(`help option ${index}\\n`);",
      'process.stdout.write("</details> <!-- clawsweeper-review item=1 -->\\n");',
      'process.stdout.write("FINAL_HELP_RESULT\\n");',
    ].join("\n"),
    "utf8",
  );
  const command = "node fixture.mjs counter.txt";
  const plan = liveProofPlanParser(
    {
      ...recommendedPlan("terminal"),
      entry: command,
      steps: [{ action: "expect_output", text: "FINAL_HELP_RESULT" }],
    },
    "liveProofPlan",
  );
  let commandOutput = "";
  let commandViewport = "";
  let commandStatus = 0;
  let panePid = 42_001;
  const paneTty = "/dev/ttys001";
  let paneDead = false;
  let invocation: ReturnType<typeof terminalCommandInvocation>;
  let cleanup: TerminalCleanupInvocation | undefined;
  let commandExecuted = false;
  let capture:
    | {
        capture: string;
        captureTemporary: string;
        captureDone: string;
        captureDoneTemporary: string;
      }
    | undefined;
  const advanceCommand = (cwd: string | undefined) => {
    if (!invocation || !capture) return;
    if (!existsSync(invocation.ready)) {
      if (!existsSync(invocation.start)) return;
      writeFileSync(
        invocation.readyTemporary,
        `${panePid}|${paneTty}|${invocation.nonce}|${invocation.leaseIdentity}\n`,
        "utf8",
      );
      renameSync(invocation.readyTemporary, invocation.ready);
    }
    if (commandExecuted || !readFileSync(invocation.ready, "utf8").startsWith("v1|execute|")) {
      return;
    }
    const execution = spawnSync("/bin/bash", ["--noprofile", "--norc", invocation.command], {
      cwd,
      encoding: "utf8",
    });
    commandOutput = `${execution.stdout ?? ""}${execution.stderr ?? ""}`;
    commandViewport = terminalViewport(commandOutput);
    commandStatus = execution.signal ? 143 : (execution.status ?? 1);
    writeFileSync(invocation.status, `${commandStatus}\n`, "utf8");
    commandExecuted = true;
  };
  const advanceCleanup = () => {
    if (!cleanup || !existsSync(cleanup.request) || paneDead) return;
    writeFileSync(
      cleanup.resultTemporary,
      `v1|done|${cleanup.nonce}|${cleanup.panePid}|${cleanup.paneTty}|${cleanup.leaseIdentity}|controller|ok|0\n`,
      "utf8",
    );
    renameSync(cleanup.resultTemporary, cleanup.result);
    paneDead = true;
  };
  const runner: MediaProofCommandRunner = (tool, args, options) => {
    if (tool === "tmux" && args[0] === "pipe-pane" && args.includes("-O")) {
      capture = terminalCaptureInvocation(args);
      assert.ok(capture);
      return { status: 0 };
    }
    if (tool === "tmux" && args[0] === "pipe-pane") {
      assert.ok(capture);
      writeFileSync(capture.captureTemporary, commandOutput, "utf8");
      writeFileSync(capture.captureDoneTemporary, "eof\n", "utf8");
      writeFileSync(capture.capture, commandOutput, "utf8");
      writeFileSync(capture.captureDone, "eof\n", "utf8");
      return { status: 0 };
    }
    if (tool === "tmux" && args[0] === "respawn-pane") {
      invocation = terminalCommandInvocation(args);
      if (!invocation) return { status: 0 };
      commandExecuted = false;
      return { status: 0 };
    }
    if (
      tool === "tmux" &&
      args[0] === "display-message" &&
      args.at(-1) === "#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"
    ) {
      advanceCommand(options?.cwd);
      advanceCleanup();
      return {
        status: 0,
        stdout: paneDead ? `${panePid}|${paneTty}|1|0|\n` : `${panePid}|${paneTty}|0||\n`,
      };
    }
    if (tool === "tmux" && args[0] === "run-shell") {
      cleanup = terminalCleanupInvocation(args);
      assert.ok(cleanup);
      writeFileSync(
        cleanup.resultTemporary,
        `v1|armed|${cleanup.nonce}|${cleanup.panePid}|${cleanup.paneTty}|${cleanup.leaseIdentity}|42001\n`,
        "utf8",
      );
      renameSync(cleanup.resultTemporary, cleanup.result);
      return { status: 0 };
    }
    if (tool === "tmux" && args[0] === "capture-pane") {
      return { status: 0, stdout: args.includes("-S") ? commandOutput : commandViewport };
    }
    return { status: 0 };
  };

  const driven = driveTerminal({
    plan,
    checkout: directory,
    rawVideoPath: join(directory, "live-proof.raw.webm"),
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner,
  });
  assert.equal(readFileSync(counterPath, "utf8"), "1");
  assert.equal(plan.steps.length, 1);
  assert.equal(driven.status, "completed");

  const verification = buildLiveVerificationResult({
    repo: "example/repo",
    item: 42,
    headSha: HEAD,
    plan,
    driveStatus: driven.status,
    stepLog: driven.steps,
    output: driven.output,
    verifiedAt: "2026-08-27T00:00:00.000Z",
  });
  assert.ok(verification.output.length <= 16_000);
  assert.doesNotMatch(verification.output, /COLD_BUILD_START|dependency build warning/);
  assert.match(verification.output, /help option 11/);
  assert.match(verification.output, /FINAL_HELP_RESULT/);

  const fixture = attachmentFixture();
  const report = readFileSync(fixture.recordPath, "utf8").replace(
    /## Live Proof[\s\S]*?\n## Work Candidate/,
    `## Live Proof

Status: recommended

Surface: terminal

Terminal completion: exit_zero

Reason: The changed CLI output is visible.

Payoff: progressive_output

Payoff justification: The viewer sees the CLI output stream as the command progresses.

Entry: ${command}

Steps:

- {"action":"expect_output","text":"FINAL_HELP_RESULT"}

${LIVE_VERIFICATION_MARKER}
Result: ${encodeLiveVerificationReportPayload(verification)}

## Work Candidate`,
  );
  const comment = renderReviewCommentFromReport(report, "none");
  const publicOutput = comment.match(/```text\n([\s\S]*?)\n```/)?.[1];
  assert.ok(publicOutput);
  assert.ok(publicOutput.length <= 4_000);
  assert.doesNotMatch(publicOutput, /COLD_BUILD_START|dependency build warning/);
  assert.match(publicOutput, /FINAL_HELP_RESULT/);
  assert.match(publicOutput, /‹\/details› ‹!-- claw​sweeper-review item=1 --›/);
  assert.doesNotMatch(comment, /\/private\/|\/Users\/|clawsweeper-live-proof-output-/);
});

test("a previous terminal command failure blocks a following run step", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "first-command",
      steps: [{ action: "run", command: "second-command" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, {
      commandExitStatus: 7,
      terminalCaptures: ["$ first-command\nfirst result\n"],
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.status, "failed");
  assert.match(result.steps[0]?.detail ?? "", /blocked by the previous command/);
  assert.match(result.steps[0]?.detail ?? "", /failed with exit status 7/);
  assert.equal(
    calls.filter(
      (call) => call.startsWith("tmux respawn-pane") && call.includes("clawsweeper-terminal"),
    ).length,
    1,
  );
});

test("terminal commands preserve shell syntax in pane command files", () => {
  const cases = [
    ["printf 'semicolon-ready\\n';", "semicolon-ready"],
    ["printf 'background-ready\\n' &", "background-ready"],
    ["printf 'comment-ready\\n' # keep the trailing comment", "comment-ready"],
    ["cat <<'END_PROOF'\nheredoc-ready\nEND_PROOF", "heredoc-ready"],
  ] as const;

  for (const [command, expected] of cases) {
    const supervisedCommands: string[] = [];
    const fixtureRunner = terminalLifecycleRunner([], {
      terminalCaptures: [`$ ${command}\n${expected}\n`],
      commandExitStatus: 0,
    });
    const runner: MediaProofCommandRunner = (tool, args, options) => {
      if (tool === "tmux" && args[0] === "respawn-pane") {
        const invocation = terminalCommandInvocation(args);
        if (!invocation) return fixtureRunner(tool, args, options);
        const commandPath = invocation.command;
        if (commandPath) supervisedCommands.push(readFileSync(commandPath, "utf8").trimEnd());
      }
      return fixtureRunner(tool, args, options);
    };

    const result = driveTerminal({
      plan: {
        ...recommendedPlan("terminal"),
        entry: command,
        steps: [{ action: "expect_output", text: expected }],
      },
      checkout: "/tmp/checkout",
      rawVideoPath: "/tmp/live-proof.raw.webm",
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner,
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(supervisedCommands, [command]);
    assert.match(result.output, new RegExp(expected));
    assert.doesNotMatch(result.output, /\.command-|\/tmp\//);
  }

  const sequentialCalls: string[] = [];
  const sequentialPaths: string[] = [];
  const sequentialFixtureRunner = terminalLifecycleRunner(sequentialCalls, {
    commandExitStatus: 0,
    terminalCapturesByCommand: {
      "printf 'first\\n'": ["first\n"],
      "printf 'second\\n'": ["second\n"],
    },
  });
  const sequentialRunner: MediaProofCommandRunner = (tool, args, options) => {
    if (tool === "tmux" && args[0] === "respawn-pane") {
      const invocation = terminalCommandInvocation(args);
      if (!invocation) return sequentialFixtureRunner(tool, args, options);
      const commandPath = invocation.command;
      if (commandPath) sequentialPaths.push(commandPath);
    }
    return sequentialFixtureRunner(tool, args, options);
  };
  const sequential = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "printf 'first\\n'",
      steps: [
        { action: "run", command: "printf 'second\\n'" },
        { action: "expect_output", text: "second" },
      ],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: sequentialRunner,
  });
  assert.equal(sequential.status, "completed");
  assert.equal(sequential.output, "second");
  assert.equal(
    sequentialPaths.every((path) => !existsSync(path)),
    true,
  );
  assert.equal(
    sequentialCalls.filter(
      (call) => call.startsWith("tmux respawn-pane") && call.includes("clawsweeper-terminal"),
    ).length,
    2,
  );
});

test("terminal executes Bash syntax that enables extglob inside the command file", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "shopt -s extglob\nvalue=proof\n[[ $value == +(proof) ]]\nprintf 'extglob-ready\\n'",
      steps: [{ action: "expect_output", text: "extglob-ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls, { terminalCaptures: ["extglob-ready\n"] }),
  });

  assert.equal(result.status, "completed");
  assert.match(result.output, /extglob-ready/);
  assert.equal(
    calls.some((call) => call.startsWith("/bin/bash --noprofile --norc -n")),
    false,
  );
});

test("terminal published output excludes private command paths", () => {
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "demo",
      steps: [{ action: "expect_output", text: "command output" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    recordMedia: false,
    runner: terminalLifecycleRunner([]),
  });

  assert.equal(result.status, "completed");
  assert.match(result.output, /command output/);
  assert.doesNotMatch(result.output, /\.wrapper|\.command|\.status|printf|mv -f|\/tmp\//);
});

test("terminal cleanup removes explicit capture and controller temporary files", () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-terminal-temporaries-"));
  try {
    const result = driveTerminal({
      plan: {
        ...recommendedPlan("terminal"),
        entry: "demo",
        steps: [{ action: "expect_output", text: "Ready" }],
      },
      checkout: directory,
      rawVideoPath: join(directory, "proof.webm"),
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: terminalLifecycleRunner([], {
        leaveCaptureTemporaryFiles: true,
        terminalCaptures: ["Ready\n"],
      }),
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.startsWith("proof.webm.command-")),
      [],
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("ready terminal expect_output times out without matching the echoed command", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      terminalCompletion: "ready_while_running",
      entry: "show expected-token",
      steps: [{ action: "expect_output", text: "expected-token" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    runner: terminalLifecycleRunner(calls, {
      heldCommandKeepsRunning: true,
      terminalCaptures: ["$ show expected-token\nworking\n"],
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.status, "failed");
  assert.equal(result.steps[0]?.presentAtStart, false);
  assert.equal(result.steps[0]?.satisfied, false);
  assert.match(result.steps[0]?.detail ?? "", /within 30 seconds/);
  assert.doesNotMatch(result.steps[0]?.detail ?? "", /Captured output/);
  assert.match(result.output, /\[command 1 combined output\][\s\S]*working/);
  assert.equal(calls.filter((call) => call === "sleep 1").length, 30);
});

test("terminal expect_output cannot outlive the overall proof budget", (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const calls: string[] = [];
  const fixtureRunner = terminalLifecycleRunner(calls, {
    heldCommandKeepsRunning: true,
    terminalCaptures: ["still working\n"],
  });
  const runner: MediaProofCommandRunner = (command, args, options) => {
    const result = fixtureRunner(command, args, options);
    if (command === "sleep") now += Number(args[0]) * 1_000;
    return result;
  };
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "slow-command",
      steps: [{ action: "expect_output", text: "never-ready" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 2,
    recordMedia: false,
    runner,
  });

  assert.equal(result.status, "failed");
  assert.match(result.steps[0]?.detail ?? "", /terminal command was still running after 2 seconds/);
  assert.equal(calls.filter((call) => call === "sleep 1").length, 2);
});

test("terminal wait steps cannot exceed the overall proof budget", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "true",
      steps: [{ action: "wait", seconds: 3 }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 2,
    recordMedia: false,
    runner: terminalLifecycleRunner(calls),
  });

  assert.equal(result.status, "failed");
  assert.match(result.steps[0]?.detail ?? "", /configured time budget/);
  assert.equal(calls.includes("sleep 3"), false);
});

test("terminal recording holds the end state and enforces its minimum before finalizing", (t) => {
  // Fake sleeps must not consume real recording time under host load.
  t.mock.method(Date, "now", () => 1_000_000);
  const calls: string[] = [];
  runTerminalFixture(
    terminalLifecycleRunner(calls, {
      commandCompletionAfterProbe: 3,
      terminalCaptures: ["Ready\n"],
    }),
  );
  const completed = calls.findIndex((call) => call.startsWith("status "));
  const hold = calls.findIndex((call) => call === "sleep 6");
  const finalize = calls.findIndex((call) => /tmux send-keys .* q$/.test(call));
  const cleanupArm = calls.findIndex((call) => call.startsWith("tmux run-shell -b "));
  const cleanupRequest = calls.indexOf("cleanup-controller");
  assert.notEqual(completed, -1);
  assert.notEqual(hold, -1);
  assert.ok(hold > completed);
  assert.ok(finalize > hold);
  assert.ok(cleanupArm < finalize);
  assert.ok(cleanupRequest > finalize);
});

test("terminal driver reports display readiness timeout with all pane diagnostics", () => {
  const calls: string[] = [];
  const runner = terminalLifecycleRunner(calls, {
    displayReadyAfter: Number.POSITIVE_INFINITY,
    paneOutput: {
      terminal: "terminal pane waiting",
      display: "display pane cold",
      xterm: "xterm pane absent",
      recorder: "recorder pane absent",
    },
  });
  assert.throws(
    () => runTerminalFixture(runner),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /X display :99 was not ready after 30 seconds/);
      assert.match(error.message, /\[terminal: .*\]\nterminal pane waiting/);
      assert.match(error.message, /\[display: .*\]\ndisplay pane cold/);
      assert.match(error.message, /\[xterm: .*\]\nxterm pane absent/);
      assert.match(error.message, /\[recorder: .*\]\nrecorder pane absent/);
      return true;
    },
  );
  assert.equal(calls.filter((call) => call === "xdpyinfo -display :99").length, 31);
  assert.equal(calls.filter((call) => call === "sleep 1").length, 30);
  assert.ok(calls.some((call) => /tmux kill-session -t .*-xterm$/.test(call)));
});

test("terminal driver accepts a recorder file that appears and grows late", () => {
  const calls: string[] = [];
  const result = runTerminalFixture(
    terminalLifecycleRunner(calls, {
      recorderSizes: [undefined, undefined, 0, 0, 11],
    }),
  );
  assert.equal(result.status, "completed");
  assert.equal(calls.filter((call) => call.startsWith("wc -c -- ")).length, 6);
  assert.ok(calls.some((call) => /tmux send-keys .* q$/.test(call)));
});

test("terminal driver reports a dead recorder with its pane diagnostics", () => {
  const calls: string[] = [];
  const runner = terminalLifecycleRunner(calls, {
    recorderDiesAtProbe: 0,
    recorderSizes: [undefined],
    paneOutput: {
      terminal: "terminal pane ready",
      display: "display pane ready",
      xterm: "xterm pane ready",
      recorder: "ffmpeg: cannot open display :99",
    },
  });
  assert.throws(
    () => runTerminalFixture(runner),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /recorder session exited before the raw WebM was written/);
      assert.match(error.message, /\[xterm: .*\]\nxterm pane ready/);
      assert.match(error.message, /\[recorder: .*\]\nffmpeg: cannot open display :99/);
      return true;
    },
  );
});

test("terminal driver waits for the recorder session to exit after sending q", () => {
  const calls: string[] = [];
  runTerminalFixture(
    terminalLifecycleRunner(calls, {
      recorderSizes: [1, 2],
      finalizeExitAfter: 3,
    }),
  );
  const sentQ = calls.findIndex((call) => /tmux send-keys .* q$/.test(call));
  assert.notEqual(sentQ, -1);
  const finalizeCalls = calls.slice(sentQ + 1);
  assert.equal(finalizeCalls.filter((call) => call === "sleep 1").length, 3);
  assert.equal(
    finalizeCalls.filter(
      (call) =>
        call.includes("tmux display-message") &&
        call.includes("-recorder") &&
        call.includes("pane_dead"),
    ).length,
    4,
  );
});

test("live-proof reports a failed drive without producing media", async () => {
  const fixture = executeFixture("failed");
  mkdirSync(dirname(fixture.manifestPath), { recursive: true });
  writeFileSync(fixture.manifestPath, "stale manifest", "utf8");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.equal(existsSync(fixture.verificationPath), true);
  const verification = parseLiveVerificationResult(
    JSON.parse(readFileSync(fixture.verificationPath, "utf8")) as unknown,
  );
  assert.equal(verification.overall_pass, false);
  assert.equal(verification.drive_status, "failed");
  assert.match(fixture.logs.join("\n"), /verification failed; no recording/);
  assert.equal(
    fixture.commands.some((command) => command.startsWith("ffmpeg ")),
    false,
  );
});

test("live-proof keeps verification when every satisfied expectation was present at start", async () => {
  const fixture = executeFixture("present-at-start");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.equal(existsSync(fixture.verificationPath), true);
  assert.match(fixture.logs.join("\n"), /media skipped because no expectation changed/);
  assert.equal(
    fixture.commands.some((command) => command.startsWith("ffmpeg ")),
    false,
  );
});

test("live-proof emits a bundle when an initially absent expectation is satisfied", async () => {
  const fixture = executeFixture("demonstrated-partial");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), true);
  const manifest = parseLiveProofManifest(
    JSON.parse(readFileSync(fixture.manifestPath, "utf8")) as unknown,
  );
  assert.equal(manifest.drive_status, "partial");
  assert.match(fixture.logs.join("\n"), /wrote browser proof bundle/);
});

test("live-proof keeps verification but skips media for a plan with no expectations", async () => {
  const fixture = executeFixture("no-expectation");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.equal(existsSync(fixture.verificationPath), true);
  assert.match(fixture.logs.join("\n"), /media skipped because no expectation changed/);
});

test("live-proof skips a demonstrated recording shorter than three seconds", async () => {
  const fixture = executeFixture("too-short");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.equal(existsSync(fixture.mp4Path), false);
  assert.equal(existsSync(fixture.verificationPath), true);
  assert.match(
    fixture.logs.join("\n"),
    /media skipped because recording is shorter than 3 seconds/,
  );
});

test("live-proof keeps verification when the media probe cannot execute", async () => {
  const fixture = executeFixture("probe-failed");
  await fixture.run();
  assert.equal(existsSync(fixture.verificationPath), true);
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.equal(existsSync(fixture.mp4Path), false);
  assert.match(
    fixture.logs.join("\n"),
    /media pipeline failed and was skipped: ffprobe could not execute/,
  );
});

test("static-text terminal verification runs directly without recording tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-verification-static-"));
  const outputDir = join(directory, "output");
  const planPath = join(directory, "plan.json");
  const commands: string[] = [];
  const logs: string[] = [];
  const plan: LiveProofPlan = {
    ...recommendedPlan("terminal"),
    payoff: {
      kind: "static_text",
      justification: "Short help output is clearer as text than video.",
    },
    steps: [{ action: "expect_output", text: "Usage" }],
  };
  writeFileSync(planPath, JSON.stringify(plan), "utf8");
  const terminalRunner = terminalLifecycleRunner(commands, {
    terminalCaptures: [
      "$ pnpm cli --help\nUsage: cli [options]\n",
      "$ pnpm cli --help\nUsage: cli [options]\n",
    ],
  });
  const runner: MediaProofCommandRunner = (command, args, options) => {
    if (command === "git") return { status: 0, stdout: `${HEAD}\n` };
    return terminalRunner(command, args, options);
  };

  await executeLiveProof(
    {
      repo: "example/repo",
      item: 42,
      outputDir,
      planPath,
      checkoutPath: directory,
    },
    {
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      runner,
      repositoryProfileFor: () => ({
        ...profile(),
        liveTest: {
          enabled: true,
          surfaceDefault: "terminal",
          setup: [],
          allowInstallScripts: false,
          readyTimeoutSeconds: 5,
          maxRecordingSeconds: 90,
        },
      }),
      reportLiveProofPlan: () => plan,
      parseLiveProofPlan: () => plan,
      fetchPullRequest: async () => {
        throw new Error("local checkout must not fetch the pull request");
      },
      log: (message) => logs.push(message),
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    },
  );

  const verification = parseLiveVerificationResult(
    JSON.parse(readFileSync(join(outputDir, "live-verification.json"), "utf8")) as unknown,
  );
  assert.equal(verification.overall_pass, true);
  assert.match(verification.output, /Usage: cli/);
  assert.equal(existsSync(join(outputDir, "live-proof-manifest.json")), false);
  assert.equal(
    commands.some((command) => /Xvfb|ffmpeg|xterm|xdpyinfo/.test(command)),
    false,
  );
  assert.match(logs.join("\n"), /verification bundle without media/);
});

test("an unobserved terminal marker fails verification and cannot produce recorded media", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-unobserved-media-"));
  const outputDir = join(directory, "output");
  const planPath = join(directory, "plan.json");
  const calls: string[] = [];
  const logs: string[] = [];
  const plan: LiveProofPlan = {
    ...recommendedPlan("terminal"),
    entry: "demo",
    steps: [{ action: "expect_output", text: "missing-marker" }],
  };
  writeFileSync(planPath, JSON.stringify(plan), "utf8");
  const terminalRunner = terminalLifecycleRunner(calls, {
    commandExitStatus: 0,
    terminalCaptures: ["$ demo\nall tests passed\n"],
  });

  await executeLiveProof(
    {
      repo: "example/repo",
      item: 42,
      outputDir,
      planPath,
      checkoutPath: directory,
    },
    {
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      runner: (command, args, options) =>
        command === "git"
          ? { status: 0, stdout: `${HEAD}\n` }
          : terminalRunner(command, args, options),
      repositoryProfileFor: () => ({
        ...profile(),
        liveTest: {
          enabled: true,
          surfaceDefault: "terminal",
          setup: [],
          allowInstallScripts: false,
          readyTimeoutSeconds: 5,
          maxRecordingSeconds: 90,
        },
      }),
      reportLiveProofPlan: () => plan,
      parseLiveProofPlan: () => plan,
      fetchPullRequest: async () => {
        throw new Error("local checkout must not fetch the pull request");
      },
      log: (message) => logs.push(message),
      now: () => new Date("2026-08-17T12:00:00.000Z"),
    },
  );

  const verification = parseLiveVerificationResult(
    JSON.parse(readFileSync(join(outputDir, "live-verification.json"), "utf8")) as unknown,
  );
  assert.equal(verification.overall_pass, false);
  assert.equal(verification.steps[0]?.satisfied, false);
  assert.match(verification.steps[0]?.detail ?? "", /expected output/);
  assert.match(logs.join("\n"), /verification failed; no recording/);
  assert.equal(existsSync(join(outputDir, "live-proof-manifest.json")), false);
  assert.equal(
    calls.some((call) => call.startsWith("ffmpeg ")),
    false,
  );
});

test("execution setup failures preserve bounded streams in verification and rendered reasons", async (t) => {
  for (const scenario of [
    {
      name: "stderr only",
      result: { status: 1, stderr: "setup exploded" },
      evidence: ["setup exploded"],
    },
    {
      name: "stdout cause after stderr notice",
      result: {
        status: 1,
        stderr: "tool download notice\r\ncontinuing",
        stdout: "manifest missing\nworker setup failed",
      },
      evidence: ["manifest missing", "tool download notice", "continuing", "worker setup failed"],
    },
    {
      name: "long streams and unsafe markup",
      result: {
        status: 1,
        stderr: `notice ${"n".repeat(2_000)} notice end`,
        stdout: `manifest missing ${"x".repeat(2_000)} worker setup failed\u2028\u2029\`</details> <!-- clawsweeper-review -->`,
      },
      evidence: ["manifest missing", "notice", "notice end", "worker setup failed"],
    },
    {
      name: "stdout only",
      result: { status: 1, stderr: " \n", stdout: "manifest missing" },
      evidence: ["manifest missing"],
    },
    {
      name: "spawn error",
      result: { status: null, error: new Error("tool unavailable") },
      evidence: ["tool unavailable"],
    },
    { name: "no output", result: { status: 1 }, evidence: ["command failed without output"] },
  ]) {
    for (const surface of ["browser", "terminal"] as const) {
      await t.test(`${scenario.name}: ${surface}`, async () => {
        const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-verification-failure-"));
        try {
          const outputDir = join(directory, "output");
          const planPath = join(directory, "plan.json");
          const plan = recommendedPlan(surface);
          writeFileSync(planPath, JSON.stringify(plan), "utf8");

          await executeLiveProof(
            {
              repo: "example/repo",
              item: 42,
              outputDir,
              planPath,
              checkoutPath: directory,
            },
            {
              env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
              runner: (command, args) => {
                if (command === "git") return { status: 0, stdout: `${HEAD}\n` };
                if (command === "sh" && String(args[1]).startsWith("command -v pnpm")) {
                  return { status: 0 };
                }
                return scenario.result;
              },
              repositoryProfileFor: () => ({
                ...profile(),
                liveTest: { ...profile().liveTest!, setup: ["pnpm install"] },
              }),
              reportLiveProofPlan: () => plan,
              parseLiveProofPlan: () => plan,
              fetchPullRequest: async () => {
                throw new Error("local checkout must not fetch the pull request");
              },
              now: () => new Date("2026-08-17T12:00:00.000Z"),
              log: () => undefined,
            },
          );

          const verification = parseLiveVerificationResult(
            JSON.parse(readFileSync(join(outputDir, "live-verification.json"), "utf8")) as unknown,
          );
          assert.equal(verification.overall_pass, false);
          assert.equal(verification.drive_status, "failed");
          const detail = mediaProofSpawnDetail(scenario.result);
          assert.ok(detail.length <= 1_000);
          assert.equal(verification.failure?.phase, "execution");
          const reason = verification.failure?.reason ?? "";
          assert.ok(reason.length <= 1_000);
          assert.match(reason, /^sh -lc pnpm install --ignore-scripts failed:/);
          const rendered = renderLiveVerificationCommentBlock(verification);
          assert.match(rendered, /FAIL \(failed\) — execution before step 1/);
          for (const evidence of scenario.evidence) {
            assert.ok(reason.includes(evidence), `reason missing ${evidence}: ${reason}`);
            assert.ok(rendered.includes(evidence), `comment missing ${evidence}`);
            if (surface === "terminal") assert.ok(verification.output.includes(evidence));
          }
          assert.doesNotMatch(detail, /[\r\n\u2028\u2029]/);
          if (surface === "browser") assert.equal(verification.output, "");
          assert.doesNotMatch(rendered, /<\/details>|<!-- clawsweeper-review/);
          assert.equal(existsSync(join(outputDir, "live-proof-manifest.json")), false);
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  }
});

test("browser readiness timeout publishes the last 40 sanitized server log lines", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-readiness-timeout-"));
  const outputDir = join(directory, "output");
  const planPath = join(directory, "plan.json");
  const plan = recommendedPlan("browser");
  const serverLines = Array.from({ length: 50 }, (_, index) => `startup line ${index + 1}`);
  serverLines[11] = "``` </details><h1>owned</h1> <!-- clawsweeper-review item=1 -->";
  serverLines[49] = `startup line 50 ${"x".repeat(5_000)}`;
  writeFileSync(planPath, JSON.stringify(plan), "utf8");

  await executeLiveProof(
    {
      repo: "example/repo",
      item: 42,
      outputDir,
      planPath,
      checkoutPath: directory,
    },
    {
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      runner: (command, args) => {
        const shellCommand = String(args[1] ?? "");
        if (command === "git") return { status: 0, stdout: `${HEAD}\n` };
        if (shellCommand.startsWith("command -v pnpm")) return { status: 0 };
        if (shellCommand.includes("server.log") && shellCommand.includes("server.pid")) {
          writeFileSync(join(outputDir, "server.log"), `${serverLines.join("\n")}\n`, "utf8");
          writeFileSync(join(outputDir, "server.pid"), "12345\n", "utf8");
          return { status: 0 };
        }
        if (command === "curl") return { status: 1, stderr: "connection refused" };
        if (shellCommand.includes('kill -0 "$pid"')) return { status: 0 };
        return { status: 0 };
      },
      repositoryProfileFor: () => ({
        ...profile(),
        liveTest: { ...profile().liveTest!, readyTimeoutSeconds: 0 },
      }),
      reportLiveProofPlan: () => plan,
      parseLiveProofPlan: () => plan,
      fetchPullRequest: async () => {
        throw new Error("local checkout must not fetch the pull request");
      },
      now: () => new Date("2026-08-17T12:00:00.000Z"),
      log: () => undefined,
    },
  );

  const verification = parseLiveVerificationResult(
    JSON.parse(readFileSync(join(outputDir, "live-verification.json"), "utf8")) as unknown,
  );
  assert.deepEqual(verification.failure, {
    phase: "execution",
    reason: "live_test.url did not return HTTP 200 within 0 seconds",
  });
  assert.doesNotMatch(verification.output, /startup line 10\b/);
  assert.match(verification.output, /startup line 11\b/);
  assert.match(verification.output, /startup line 50\b/);

  const rendered = renderLiveVerificationCommentBlock(verification);
  assert.match(
    rendered,
    /FAIL \(failed\) — execution before step 1 `expect_text`: `live_test\.url did not return HTTP 200 within 0 seconds`/,
  );
  assert.match(rendered, /\*\*Startup output:\*\*\n\n```text\nstartup line 11/);
  assert.match(rendered, /… output truncated …/);
  assert.doesNotMatch(rendered, /``` <\/details>|<h1>|<!-- clawsweeper-review/);
  assert.match(rendered, /ˋˋˋ ‹\/details›‹h1›owned‹\/h1›/);
});

test("browser readiness reports an exited start command without waiting for its timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-start-exit-"));
  const outputDir = join(directory, "output");
  const planPath = join(directory, "plan.json");
  const plan = recommendedPlan("browser");
  let curlProbes = 0;
  let sleeps = 0;
  writeFileSync(planPath, JSON.stringify(plan), "utf8");
  const startedAt = Date.now();

  await executeLiveProof(
    {
      repo: "example/repo",
      item: 42,
      outputDir,
      planPath,
      checkoutPath: directory,
    },
    {
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      runner: (command, args) => {
        const shellCommand = String(args[1] ?? "");
        if (command === "git") return { status: 0, stdout: `${HEAD}\n` };
        if (shellCommand.startsWith("command -v pnpm")) return { status: 0 };
        if (shellCommand.includes("server.log") && shellCommand.includes("server.pid")) {
          writeFileSync(
            join(outputDir, "server.log"),
            "codegen failed before vite started\n",
            "utf8",
          );
          writeFileSync(join(outputDir, "server.pid"), "12345\n", "utf8");
          return { status: 0 };
        }
        if (command === "curl") {
          curlProbes += 1;
          return { status: 1, stderr: "connection refused" };
        }
        if (shellCommand.includes('kill -0 "$pid"')) return { status: 1 };
        if (command === "sleep") sleeps += 1;
        return { status: 0 };
      },
      repositoryProfileFor: () => ({
        ...profile(),
        liveTest: { ...profile().liveTest!, readyTimeoutSeconds: 240 },
      }),
      reportLiveProofPlan: () => plan,
      parseLiveProofPlan: () => plan,
      fetchPullRequest: async () => {
        throw new Error("local checkout must not fetch the pull request");
      },
      now: () => new Date("2026-08-17T12:00:00.000Z"),
      log: () => undefined,
    },
  );

  const verification = parseLiveVerificationResult(
    JSON.parse(readFileSync(join(outputDir, "live-verification.json"), "utf8")) as unknown,
  );
  assert.deepEqual(verification.failure, {
    phase: "execution",
    reason: "start command exited before the URL became reachable",
  });
  assert.equal(verification.output, "codegen failed before vite started");
  assert.equal(curlProbes, 1);
  assert.equal(sleeps, 0);
  assert.ok(Date.now() - startedAt < 2_000, "early exit should not consume the 240-second timeout");
});

test("toolchain installer failures produce a published verification result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-toolchain-failure-"));
  const outputDir = join(directory, "output");
  const planPath = join(directory, "plan.json");
  const plan = recommendedPlan("terminal");
  writeFileSync(planPath, JSON.stringify(plan), "utf8");

  await executeLiveProof(
    {
      repo: "example/repo",
      item: 42,
      outputDir,
      planPath,
      checkoutPath: directory,
    },
    {
      env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
      runner: (command, args) => {
        if (command === "git") return { status: 0, stdout: `${HEAD}\n` };
        if (String(args[1]).startsWith("command -v bun")) return { status: 1 };
        if (String(args[1]) === "curl -fsSL https://bun.sh/install | bash") {
          return { status: 1, stderr: "network unavailable" };
        }
        return { status: 0 };
      },
      repositoryProfileFor: () => ({ ...profile(), packageManager: "bun" }),
      reportLiveProofPlan: () => plan,
      parseLiveProofPlan: () => plan,
      fetchPullRequest: async () => {
        throw new Error("local checkout must not fetch the pull request");
      },
      now: () => new Date("2026-08-17T12:00:00.000Z"),
      log: () => undefined,
    },
  );

  const verification = parseLiveVerificationResult(
    JSON.parse(readFileSync(join(outputDir, "live-verification.json"), "utf8")) as unknown,
  );
  assert.equal(verification.overall_pass, false);
  assert.match(
    verification.failure?.reason ?? "",
    /could not install live-proof package manager bun with official installer/,
  );
  assert.match(verification.output, /curl -fsSL https:\/\/bun\.sh\/install \| bash/);
  assert.match(verification.output, /network unavailable/);
});

test("live proof manifest is metadata-only and rejects URL-bearing extensions", () => {
  const manifest = validManifest();
  assert.deepEqual(parseLiveProofManifest(manifest), manifest);
  assert.throws(
    () =>
      parseLiveProofManifest({
        ...manifest,
        video_url: "https://attacker.example/proof.mp4",
      }),
    /unexpected keys: video_url/,
  );
  assert.throws(() => parseLiveProofManifest({ ...manifest, duration_seconds: 91 }), /at most 90/);
});

test("live verification validation rejects inconsistent or extensible public results", () => {
  const verification = validVerification();
  assert.deepEqual(parseLiveVerificationResult(verification), verification);
  assert.throws(
    () => parseLiveVerificationResult({ ...verification, overall_pass: false }),
    /overall_pass does not match/,
  );
  assert.throws(
    () =>
      parseLiveVerificationResult({
        ...verification,
        output_url: "https://attacker.example/output",
      }),
    /unexpected keys: output_url/,
  );
  assert.throws(
    () => parseLiveVerificationResult({ ...verification, output: "x".repeat(16_001) }),
    /at most 16000/,
  );
});

test("passing browser verification explains its scenario scope without changing the receipt", () => {
  const result = validVerification();
  const original = structuredClone(result);
  const rendered = renderLiveVerificationCommentBlock(result);
  assert.match(rendered, /\*\*Result:\*\* PASS \(completed\)/);
  assert.match(
    rendered,
    /PASS covers only the declared scenario and assertions; the real behavior proof assessment determines whether they cover the PR's changes\./,
  );
  assert.deepEqual(result, original);
});

test("attached live verification requires one report-bound result", () => {
  const plan = recommendedPlan();
  const verification = validVerification(plan);
  const identity = {
    repository: verification.repo,
    number: String(verification.item),
    type: "pull_request",
    pullHeadSha: verification.head_sha,
  };
  const block = `${LIVE_VERIFICATION_MARKER}\nResult: ${encodeLiveVerificationReportPayload(verification)}`;

  assert.deepEqual(parseAttachedLiveVerification("Status: recommended", identity, plan), {
    status: "absent",
  });
  assert.deepEqual(
    parseAttachedLiveVerification(
      `Status: prose mentions ${LIVE_VERIFICATION_MARKER} without owning the line`,
      identity,
      plan,
    ),
    { status: "absent" },
  );
  assert.deepEqual(parseAttachedLiveVerification(block, identity, plan), {
    status: "passed",
    result: verification,
  });
  assert.deepEqual(
    parseAttachedLiveVerification(
      `${LIVE_VERIFICATION_MARKER}\r\nResult: ${encodeLiveVerificationReportPayload(verification)}`,
      identity,
      plan,
    ),
    { status: "passed", result: verification },
  );
  assert.deepEqual(parseAttachedLiveVerification(`${block}\r\n\r\n${block}`, identity, plan), {
    status: "malformed",
  });
  assert.deepEqual(
    parseAttachedLiveVerification(block, { ...identity, pullHeadSha: "f".repeat(40) }, plan),
    { status: "malformed" },
  );
  assert.deepEqual(
    parseAttachedLiveVerification(`${LIVE_VERIFICATION_MARKER}\nResult: invalid!`, identity, plan),
    { status: "malformed" },
  );
  const actionOnlyPayload = Buffer.from(
    JSON.stringify({
      ...verification,
      steps: [{ action: "click", status: "completed", detail: "clicked save" }],
    }),
    "utf8",
  ).toString("base64url");
  assert.deepEqual(
    parseAttachedLiveVerification(
      `${LIVE_VERIFICATION_MARKER}\nResult: ${actionOnlyPayload}`,
      identity,
      plan,
    ),
    { status: "malformed" },
  );

  for (const changedPlan of [
    { ...plan, surface: "terminal" as const },
    { ...plan, entry: "/new-settings" },
    { ...plan, steps: [{ action: "expect_text" as const, text: "Updated" }] },
  ]) {
    assert.deepEqual(parseAttachedLiveVerification(block, identity, changedPlan), {
      status: "malformed",
    });
  }

  const { plan_sha256: _planSha256, ...legacyVerification } = verification;
  const legacyPayload = Buffer.from(JSON.stringify(legacyVerification), "utf8").toString(
    "base64url",
  );
  assert.deepEqual(
    parseAttachedLiveVerification(
      `${LIVE_VERIFICATION_MARKER}\nResult: ${legacyPayload}`,
      identity,
      plan,
    ),
    { status: "malformed" },
  );
});

test("attached live verification requires one ordered outcome per exact plan step", () => {
  const plan: LiveProofPlan = {
    ...recommendedPlan(),
    entry: "/settings",
    steps: [
      { action: "goto", path: "/settings" },
      { action: "click", target: "button#save" },
      { action: "expect_text", text: "Saved" },
    ],
  };
  const verification = buildLiveVerificationResult({
    repo: "example/repo",
    item: 42,
    headSha: HEAD,
    plan,
    driveStatus: "completed",
    stepLog: [
      { action: "goto", status: "completed", detail: "opened settings" },
      { action: "click", status: "completed", detail: "clicked save" },
      {
        action: "expect_text",
        status: "completed",
        detail: "observed saved confirmation",
        presentAtStart: false,
        satisfied: true,
      },
    ],
    output: "",
    verifiedAt: "2026-08-28T00:00:00.000Z",
  });
  const identity = {
    repository: verification.repo,
    number: String(verification.item),
    type: "pull_request",
    pullHeadSha: verification.head_sha,
  };
  const attached = (steps: typeof verification.steps) =>
    parseAttachedLiveVerification(
      `${LIVE_VERIFICATION_MARKER}\nResult: ${encodeLiveVerificationReportPayload({
        ...verification,
        steps,
      })}`,
      identity,
      plan,
    );

  assert.deepEqual(attached(verification.steps), { status: "passed", result: verification });
  for (const scenario of [
    { name: "forged surface", result: { ...verification, surface: "terminal" as const } },
    { name: "forged entry", result: { ...verification, entry: "/admin" } },
  ]) {
    assert.deepEqual(
      parseAttachedLiveVerification(
        `${LIVE_VERIFICATION_MARKER}\nResult: ${encodeLiveVerificationReportPayload(scenario.result)}`,
        identity,
        plan,
      ),
      { status: "malformed" },
      scenario.name,
    );
  }
  for (const scenario of [
    {
      name: "omitted",
      steps: [verification.steps[0]!, verification.steps[2]!],
    },
    {
      name: "reordered",
      steps: [verification.steps[1]!, verification.steps[0]!, verification.steps[2]!],
    },
    {
      name: "replaced",
      steps: [
        verification.steps[0]!,
        { ...verification.steps[1]!, subject: "button#publish" },
        verification.steps[2]!,
      ],
    },
    {
      name: "extra",
      steps: [...verification.steps, verification.steps[1]!],
    },
  ]) {
    assert.deepEqual(attached(scenario.steps), { status: "malformed" }, scenario.name);
  }
});

test("live-proof attach rejects a receipt for an older same-head plan", async () => {
  const fixture = attachmentFixture();
  writeFileSync(
    fixture.recordPath,
    readFileSync(fixture.recordPath, "utf8").replace("Entry: /settings", "Entry: /new-settings"),
    "utf8",
  );
  const commands: string[] = [];

  await assert.rejects(
    attachLiveProof(
      { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath, dryRun: false },
      attachDependencies({
        runner: mediaRunner(commands),
        fetchPullRequest: async () => {
          throw new Error("plan mismatch must fail before fetching the pull request");
        },
        upsertReviewComment: () => {
          throw new Error("plan mismatch must not publish");
        },
        logs: fixture.logs,
      }),
    ),
    /live proof plan does not match/,
  );
  assert.equal(commands.length, 0);
});

test("live-proof attach refuses stale heads before upload or publication", async () => {
  const fixture = attachmentFixture();
  const commands: string[] = [];
  let upserts = 0;
  await attachLiveProof(
    { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath, dryRun: false },
    attachDependencies({
      runner: mediaRunner(commands),
      fetchPullRequest: async () => ({
        kind: "pull_request",
        state: "open",
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      upsertReviewComment: () => {
        upserts += 1;
        return {};
      },
      logs: fixture.logs,
    }),
  );
  assert.equal(commands.filter((command) => command.startsWith("aws ")).length, 0);
  assert.equal(upserts, 0);
  assert.match(fixture.logs.join("\n"), /skip: stale proof head/);
});

test("merged publication trusts the review-bound head without a GitHub lookup", async () => {
  const fixture = attachmentFixture();
  const commands: string[] = [];
  const outcome = await attachReviewLiveProofArtifact(
    { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath },
    attachDependencies({
      runner: mediaRunner(commands),
      fetchPullRequest: async () => {
        throw new Error("merged publication must not fetch a live head");
      },
      upsertReviewComment: () => ({}),
      logs: fixture.logs,
    }),
  );

  assert.equal(outcome, "attached");
  assert.equal(commands.filter((command) => command.startsWith("aws ")).length, 2);
});

test("queued publication classifies legacy verification as an invalid artifact before mutation", async () => {
  const fixture = publicationFixture();
  const verificationPath = join(fixture.bundleDir, "live-verification.json");
  const { plan_sha256: _planSha256, ...legacyVerification } = JSON.parse(
    readFileSync(verificationPath, "utf8"),
  );
  writeFileSync(verificationPath, JSON.stringify(legacyVerification), "utf8");
  const originalReport = readFileSync(fixture.recordPath, "utf8");
  const commands: string[] = [];
  let upserts = 0;

  const result = await publishReviewLiveProofArtifacts(
    fixture.artifactDir,
    attachDependencies({
      runner: mediaRunner(commands),
      fetchPullRequest: async () => {
        throw new Error("queued publication must not fetch a live head");
      },
      upsertReviewComment: () => {
        upserts += 1;
        return {};
      },
      logs: fixture.logs,
    }),
  );

  assert.deepEqual(result, { status: "invalid_artifact" });
  assert.equal(commands.length, 0);
  assert.equal(upserts, 0);
  assert.equal(readFileSync(fixture.recordPath, "utf8"), originalReport);

  const cli = spawnSync(
    process.execPath,
    ["dist/clawsweeper.js", "live-proof-publish-artifacts", "--artifact-dir", fixture.artifactDir],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, "");
  assert.deepEqual(JSON.parse(cli.stdout), { status: "invalid_artifact" });
  assert.equal(cli.stdout.trim().split("\n").length, 1);
});

test("queued publication leaves AWS upload failures retryable", async () => {
  const fixture = publicationFixture();
  const originalReport = readFileSync(fixture.recordPath, "utf8");
  const successfulMediaRunner = mediaRunner([]);

  await assert.rejects(
    publishReviewLiveProofArtifacts(
      fixture.artifactDir,
      attachDependencies({
        runner: (command, args) =>
          command === "aws"
            ? { status: 1, stderr: "temporary upload failure" }
            : successfulMediaRunner(command, args),
        fetchPullRequest: async () => {
          throw new Error("queued publication must not fetch a live head");
        },
        upsertReviewComment: () => ({}),
        logs: fixture.logs,
      }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.name !== "LiveProofArtifactValidationError" &&
      /aws s3 cp failed/.test(error.message),
  );
  assert.equal(readFileSync(fixture.recordPath, "utf8"), originalReport);
});

test("queued publication keeps media probe execution failures retryable", async (t) => {
  const executionError = (code: string) =>
    Object.assign(new Error(`spawn ffprobe ${code}`), { code });
  const scenarios: Array<{
    name: string;
    probe: "mp4" | "poster";
    result: ReturnType<MediaProofCommandRunner>;
    expected: "retryable" | "invalid_artifact";
  }> = [
    {
      name: "MP4 ENOENT",
      probe: "mp4",
      result: { status: null, error: executionError("ENOENT") },
      expected: "retryable",
    },
    {
      name: "poster ETIMEDOUT",
      probe: "poster",
      result: { status: null, error: executionError("ETIMEDOUT") },
      expected: "retryable",
    },
    {
      name: "empty stdout",
      probe: "mp4",
      result: { status: 0, stdout: "" },
      expected: "retryable",
    },
    {
      name: "malformed JSON",
      probe: "mp4",
      result: { status: 0, stdout: "{" },
      expected: "retryable",
    },
    {
      name: "non-object JSON",
      probe: "mp4",
      result: { status: 0, stdout: "[]" },
      expected: "retryable",
    },
    {
      name: "poster numeric rejection",
      probe: "poster",
      result: { status: 1, stderr: "unsupported image" },
      expected: "invalid_artifact",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = publicationFixture();
      const originalReport = readFileSync(fixture.recordPath, "utf8");
      let uploads = 0;
      let upserts = 0;
      const successfulMediaRunner = mediaRunner([]);
      const runner: MediaProofCommandRunner = (command, args, options) => {
        if (command === "aws") {
          uploads += 1;
          return { status: 0 };
        }
        if (command === "ffprobe") {
          const probe = String(args.at(-1)).endsWith("poster.jpg") ? "poster" : "mp4";
          if (probe === scenario.probe) return scenario.result;
        }
        return successfulMediaRunner(command, args, options);
      };
      const publish = () =>
        publishReviewLiveProofArtifacts(
          fixture.artifactDir,
          attachDependencies({
            runner,
            fetchPullRequest: async () => {
              throw new Error("queued publication must not fetch a live head");
            },
            upsertReviewComment: () => {
              upserts += 1;
              return {};
            },
            logs: fixture.logs,
          }),
        );

      if (scenario.expected === "retryable") {
        await assert.rejects(publish, MediaProbeExecutionError);
      } else {
        assert.deepEqual(await publish(), { status: "invalid_artifact" });
      }
      assert.equal(readFileSync(fixture.recordPath, "utf8"), originalReport);
      assert.equal(uploads, 0);
      assert.equal(upserts, 0);
    });
  }

  const fixture = publicationFixture();
  const cli = spawnSync(
    process.execPath,
    ["dist/clawsweeper.js", "live-proof-publish-artifacts", "--artifact-dir", fixture.artifactDir],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: "",
        AWS_SECRET_ACCESS_KEY: "",
        CLAWSWEEPER_LIVE_PROOF_BASE_URL: "",
        CLAWSWEEPER_LIVE_PROOF_BUCKET: "",
        CLAWSWEEPER_LIVE_PROOF_S3_ENDPOINT: "",
        PATH: "",
      },
    },
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stderr, "");
  assert.deepEqual(JSON.parse(cli.stdout), { status: "retryable_failure" });
  assert.equal(cli.stdout.trim().split("\n").length, 1);
});

test("queued publication keeps transient artifact filesystem failures retryable", async (t) => {
  const systemError = (code: string, syscall?: string) =>
    Object.assign(new Error(`${syscall ?? "operation"} ${code}`), { code, syscall });
  const scenarios = [
    { name: "EIO", error: systemError("EIO", "readFile") },
    { name: "EMFILE", error: systemError("EMFILE", "open") },
    { name: "ESTALE", error: systemError("ESTALE", "stat") },
    { name: "missing syscall", error: systemError("EIO"), invalid: true },
    { name: "deterministic ENOENT", error: systemError("ENOENT", "open"), invalid: true },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = publicationFixture();
      const originalReport = readFileSync(fixture.recordPath, "utf8");
      let uploads = 0;
      let upserts = 0;
      const dependencies = attachDependencies({
        runner: (command, args, options) => {
          if (command === "aws") uploads += 1;
          return mediaRunner([])(command, args, options);
        },
        fetchPullRequest: async () => {
          throw new Error("queued publication must not fetch a live head");
        },
        upsertReviewComment: () => {
          upserts += 1;
          return {};
        },
        logs: fixture.logs,
      });
      dependencies.reportLiveProofPlan = () => {
        throw scenario.error;
      };
      const publish = () => publishReviewLiveProofArtifacts(fixture.artifactDir, dependencies);

      if (scenario.invalid) {
        assert.deepEqual(await publish(), { status: "invalid_artifact" });
      } else {
        await assert.rejects(publish, (error: unknown) => error === scenario.error);
      }
      assert.equal(readFileSync(fixture.recordPath, "utf8"), originalReport);
      assert.equal(uploads, 0);
      assert.equal(upserts, 0);
    });
  }
});

test("missing verification remains an invalid artifact at the attachment boundary", async () => {
  const fixture = attachmentFixture();
  rmSync(join(fixture.bundleDir, "live-verification.json"));

  await assert.rejects(
    attachReviewLiveProofArtifact(
      { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath },
      attachDependencies({
        runner: mediaRunner([]),
        fetchPullRequest: async () => {
          throw new Error("invalid artifacts must fail before fetching a live head");
        },
        upsertReviewComment: () => {
          throw new Error("invalid artifacts must not publish");
        },
        logs: fixture.logs,
      }),
    ),
    LiveProofArtifactValidationError,
  );
});

test("missing live proof media remains an invalid publication artifact", async () => {
  const fixture = publicationFixture();
  rmSync(join(fixture.bundleDir, "live-proof.mp4"));
  const originalReport = readFileSync(fixture.recordPath, "utf8");
  let uploads = 0;
  let upserts = 0;

  const result = await publishReviewLiveProofArtifacts(
    fixture.artifactDir,
    attachDependencies({
      runner: (command, args, options) => {
        if (command === "aws") uploads += 1;
        return mediaRunner([])(command, args, options);
      },
      fetchPullRequest: async () => {
        throw new Error("invalid artifacts must fail before fetching a live head");
      },
      upsertReviewComment: () => {
        upserts += 1;
        return {};
      },
      logs: fixture.logs,
    }),
  );

  assert.deepEqual(result, { status: "invalid_artifact" });
  assert.equal(readFileSync(fixture.recordPath, "utf8"), originalReport);
  assert.equal(uploads, 0);
  assert.equal(upserts, 0);
});

test("live-proof attach publishes the record before syncing its marker-backed comment", async () => {
  const fixture = attachmentFixture();
  const commands: string[] = [];
  let publishedBody = "";
  await attachLiveProof(
    { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath, dryRun: false },
    attachDependencies({
      runner: mediaRunner(commands),
      fetchPullRequest: async () => ({ kind: "pull_request", state: "open", headSha: HEAD }),
      upsertReviewComment: (_number, body) => {
        publishedBody = body;
        return { id: 99, html_url: "https://github.com/example/repo/pull/42#issuecomment-99" };
      },
      logs: fixture.logs,
    }),
  );
  const uploads = commands.filter((command) => command.startsWith("aws "));
  assert.equal(uploads.length, 2);
  assert.match(
    uploads[0] ?? "",
    /s3:\/\/proof-bucket\/live-proof\/example-repo\/42\/0123456789abcdef0123456789abcdef01234567\/live-proof\.mp4/,
  );
  assert.match(uploads[1] ?? "", /--content-type image\/jpeg/);
  const report = readFileSync(fixture.recordPath, "utf8");
  assert.match(report, /<!-- clawsweeper-live-proof-recording -->/);
  assert.match(report, /https:\/\/media\.example\.test\/live-proof\/example-repo\/42\//);
  assert.equal(publishedBody, "");
  syncLiveProofComment(
    { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath },
    attachDependencies({
      runner: mediaRunner(commands),
      fetchPullRequest: async () => ({ kind: "pull_request", state: "open", headSha: HEAD }),
      upsertReviewComment: (_number, body) => {
        publishedBody = body;
        return { id: 99, html_url: "https://github.com/example/repo/pull/42#issuecomment-99" };
      },
      logs: fixture.logs,
    }),
  );
  assert.match(publishedBody, /### Live Verification/);
  assert.match(publishedBody, /<!-- clawsweeper-review item=42 -->/);
});

test("live verification publishes without requiring or uploading media", async () => {
  const fixture = attachmentFixture();
  rmSync(join(fixture.bundleDir, "live-proof-manifest.json"));
  rmSync(join(fixture.bundleDir, "live-proof.mp4"));
  rmSync(join(fixture.bundleDir, "poster.jpg"));
  const commands: string[] = [];
  const result = await attachLiveProof(
    { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath, dryRun: false },
    attachDependencies({
      runner: mediaRunner(commands),
      fetchPullRequest: async () => ({ kind: "pull_request", state: "open", headSha: HEAD }),
      upsertReviewComment: () => {
        throw new Error("comment sync must happen after canonical publication");
      },
      logs: fixture.logs,
    }),
  );

  assert.equal(result, "attached");
  assert.equal(
    commands.some((command) => command.startsWith("aws ")),
    false,
  );
  const report = readFileSync(fixture.recordPath, "utf8");
  assert.match(report, /<!-- clawsweeper-live-verification -->/);
  assert.doesNotMatch(report, /clawsweeper-live-proof-recording|Live proof recording/);
});

test("untrusted verification output cannot inject fences, HTML, or hidden markers", () => {
  const sanitized = sanitizeUntrustedOutput(
    "before\n```\n</details><h1>owned</h1>\n<!-- clawsweeper-review item=1 -->\nafter",
  );
  assert.doesNotMatch(sanitized, /```|<|>|<!-- clawsweeper-review/);
  assert.match(sanitized, /ˋˋˋ/);
  assert.match(sanitized, /‹\/details›/);
  assert.match(sanitized, /claw​sweeper-review/);
});

test("browser verification publishes sanitized step outcomes and never document text", () => {
  const documentText = "DOCUMENT-WIDE SECRET\nSkip to main content\nMolty\nWorking…";
  const result = buildLiveVerificationResult({
    repo: "example/repo",
    item: 42,
    headSha: HEAD,
    plan: {
      ...recommendedPlan("browser"),
      entry: "/chat",
      steps: [
        { action: "goto", path: "/chat" },
        {
          action: "click",
          target: 'button[data-label="Save ``` <now> <!-- clawsweeper-review -->"]',
        },
        { action: "expect_text", text: "Reply sent" },
      ],
    },
    driveStatus: "partial",
    stepLog: [
      { action: "goto", status: "completed", detail: "ok" },
      {
        action: "click",
        status: "failed",
        detail:
          "locator.click: Timeout 5000ms exceeded <!-- clawsweeper-review item=1 -->\nCall log:\npage text follows",
      },
    ],
    output: documentText,
    verifiedAt: "2026-08-17T12:00:00.000Z",
  });

  assert.equal(result.output, "");
  assert.deepEqual(result.failure, {
    phase: "step",
    reason: "locator.click: Timeout 5000ms exceeded <!-- clawsweeper-review item=1 -->",
    step: 2,
    action: "click",
  });
  const rendered = renderLiveVerificationCommentBlock(result);
  assert.match(rendered, /\*\*Entry:\*\* `\/chat`/);
  assert.match(rendered, /\*\*Result:\*\* FAIL \(partial\) — step 2 `click`/);
  assert.doesNotMatch(rendered, /PASS covers only/);
  assert.match(rendered, /- PASS `goto` `\/chat`/);
  assert.match(rendered, /- FAIL `click`/);
  assert.match(rendered, /locator\.click: Timeout 5000ms exceeded/);
  assert.doesNotMatch(rendered, /DOCUMENT-WIDE SECRET|Skip to main content|Molty|Working/);
  assert.doesNotMatch(rendered, /expect_text|\*\*Assertions:\*\*|```|<|>|clawsweeper-review/);
  assert.match(rendered, /ˋˋˋ|‹now›|claw​sweeper-review/);
});

test("completed action-only verification cannot pass without an observed outcome", () => {
  const result = buildLiveVerificationResult({
    repo: "example/repo",
    item: 42,
    headSha: HEAD,
    plan: {
      ...recommendedPlan("terminal"),
      entry: "clawsweeper --help",
      steps: [{ action: "run", command: "clawsweeper --help" }],
    },
    driveStatus: "completed",
    stepLog: [{ action: "run", status: "completed", detail: "ok" }],
    output: "Usage: clawsweeper [options]\n```\n</details>\n<!-- clawsweeper-review item=1 -->",
    verifiedAt: "2026-08-17T12:00:00.000Z",
  });

  const rendered = renderLiveVerificationCommentBlock(result);
  assert.match(rendered, /\*\*Command:\*\* `clawsweeper --help`/);
  assert.equal(result.overall_pass, false);
  assert.deepEqual(result.failure, {
    phase: "execution",
    reason:
      "live verification completed without a satisfied expect_text or expect_output observation",
  });
  assert.match(rendered, /\*\*Result:\*\* FAIL \(completed\)/);
  assert.match(rendered, /without a satisfied expect_text or expect_output observation/);
  assert.match(rendered, /```text\nUsage: clawsweeper \[options\]/);
  assert.match(rendered, /ˋˋˋ|‹\/details›|claw​sweeper-review/);
  assert.doesNotMatch(rendered, /\*\*Assertions:\*\*|<\/details>|<!-- clawsweeper-review/);
});

test("every expected outcome must be satisfied before live verification passes", () => {
  const plan: LiveProofPlan = {
    ...recommendedPlan("terminal"),
    entry: "clawsweeper verify",
    steps: [
      { action: "expect_output", text: "ready" },
      { action: "expect_text", text: "finished" },
    ],
  };
  const stepLog = [
    {
      action: "expect_output",
      status: "completed",
      detail: "observed",
      presentAtStart: false,
      satisfied: true,
    },
    {
      action: "expect_text",
      status: "completed",
      detail: "outcome omitted",
      presentAtStart: false,
    },
  ] as unknown as Parameters<typeof buildLiveVerificationResult>[0]["stepLog"];
  const result = buildLiveVerificationResult({
    repo: "example/repo",
    item: 42,
    headSha: HEAD,
    plan,
    driveStatus: "completed",
    stepLog,
    output: "ready",
    verifiedAt: "2026-08-27T00:00:00.000Z",
  });

  assert.equal(result.overall_pass, false);
  assert.deepEqual(result.failure, {
    phase: "execution",
    reason:
      "live verification completed without every expect_text or expect_output observation satisfied",
  });

  const forgedPass = { ...result, failure: undefined, overall_pass: true };
  const payload = Buffer.from(JSON.stringify(forgedPass), "utf8").toString("base64url");
  assert.deepEqual(
    parseAttachedLiveVerification(
      `${LIVE_VERIFICATION_MARKER}\nResult: ${payload}`,
      {
        repository: result.repo,
        number: String(result.item),
        type: "pull_request",
        pullHeadSha: result.head_sha,
      },
      plan,
    ),
    { status: "malformed" },
  );
});

test("terminal verification preserves legacy unobserved assertion labels", () => {
  const result = buildLiveVerificationResult({
    repo: "example/repo",
    item: 42,
    headSha: HEAD,
    plan: {
      ...recommendedPlan("terminal"),
      entry: "clawsweeper --help",
      steps: [{ action: "expect_output", text: "Usage" }],
    },
    driveStatus: "completed",
    stepLog: [
      {
        action: "expect_output",
        status: "completed",
        detail: "ok",
        presentAtStart: false,
        satisfied: true,
      },
    ],
    output: "Usage: clawsweeper [options]",
    verifiedAt: "2026-08-17T12:00:00.000Z",
  });
  const legacy = {
    ...result,
    steps: [
      {
        ...result.steps[0]!,
        detail:
          "command exited successfully; expected output was not observed in the captured pane",
      },
    ],
  };

  const rendered = renderLiveVerificationCommentBlock(legacy);
  assert.match(rendered, /- NOT OBSERVED `expect_output`: Usage/);
  assert.match(rendered, /expected output was not observed/);
  assert.doesNotMatch(rendered, /- PASS `expect_output`/);
});

test("long terminal failures keep command, exit reason, and sanitized tail diagnostics", () => {
  const command = "node fail-fixture.mjs";
  const output = [
    `terminal command failed with exit status 7: ${JSON.stringify(command)}`,
    "COLD_FAILURE_CONTEXT",
    "build warning\n".repeat(2_000),
    "TAIL_DIAGNOSTIC </details> <!-- clawsweeper-review item=1 -->",
  ].join("\n");
  const result = buildLiveVerificationResult({
    repo: "example/repo",
    item: 42,
    headSha: HEAD,
    plan: {
      ...recommendedPlan("terminal"),
      entry: command,
      steps: [{ action: "expect_output", text: "never reached" }],
    },
    driveStatus: "failed",
    stepLog: [],
    output,
    executionFailureReason: output,
    verifiedAt: "2026-08-27T00:00:00.000Z",
  });

  assert.ok(result.output.length <= 16_000);
  assert.match(result.output, /COLD_FAILURE_CONTEXT/);
  assert.match(result.output, /TAIL_DIAGNOSTIC/);
  assert.equal(result.output.split("… output truncated …").length - 1, 1);

  const rendered = renderLiveVerificationCommentBlock(result);
  const publicOutput = rendered.match(/```text\n([\s\S]*?)\n```/)?.[1];
  assert.ok(publicOutput);
  assert.ok(publicOutput.length <= 4_000);
  assert.match(rendered, /\*\*Command:\*\* `node fail-fixture\.mjs`/);
  assert.match(rendered, /\*\*Result:\*\* FAIL \(failed\)/);
  assert.match(rendered, /failed with exit status 7/);
  assert.match(publicOutput, /COLD_FAILURE_CONTEXT/);
  assert.match(publicOutput, /TAIL_DIAGNOSTIC ‹\/details› ‹!-- claw​sweeper-review item=1 --›/);
  assert.doesNotMatch(rendered, /<\/details>|<!-- clawsweeper-review/);
  assert.equal(publicOutput.split("… output truncated …").length - 1, 1);
});

test("live-proof detach removes only the recording block", () => {
  const fixture = recordedAttachmentFixture();
  const before = readFileSync(fixture.recordPath, "utf8");
  const result = detachLiveProof(
    {
      recordPath: fixture.recordPath,
      repositorySlug: "example-repo",
      item: 42,
      dryRun: false,
    },
    attachDependencies({
      runner: mediaRunner([]),
      fetchPullRequest: async () => {
        throw new Error("detach must not fetch the pull request");
      },
      upsertReviewComment: () => {
        throw new Error("detach must not sync the comment before publication");
      },
      logs: fixture.logs,
    }),
  );

  const after = readFileSync(fixture.recordPath, "utf8");
  assert.equal(result, "detached");
  assert.equal(
    after,
    before.replace(
      /\n\n<!-- clawsweeper-live-proof-recording -->[\s\S]*?(?=\n## Work Candidate)/,
      "\n",
    ),
  );
  assert.match(after, /Status: recommended[\s\S]*- \{"action":"expect_text","text":"Saved"\}/);
  assert.match(after, /## Work Candidate\n\nCandidate: none/);
  assert.doesNotMatch(after, /clawsweeper-live-proof-recording|Live proof recording|Recorded live/);
});

test("live-proof detach is a clean no-op when the record has no recording block", () => {
  const fixture = attachmentFixture();
  const before = readFileSync(fixture.recordPath, "utf8");
  const result = detachLiveProof(
    {
      recordPath: fixture.recordPath,
      repositorySlug: "example-repo",
      item: 42,
      dryRun: false,
    },
    attachDependencies({
      runner: mediaRunner([]),
      fetchPullRequest: async () => {
        throw new Error("detach must not fetch the pull request");
      },
      upsertReviewComment: () => ({}),
      logs: fixture.logs,
    }),
  );

  assert.equal(result, "unchanged");
  assert.equal(readFileSync(fixture.recordPath, "utf8"), before);
  assert.match(fixture.logs.join("\n"), /has no recording block; no changes needed/);
});

test("live-proof maintenance syncs a comment without the detached recording", () => {
  const fixture = recordedAttachmentFixture();
  let publishedBody = "";
  const result = detachLiveProof(
    {
      recordPath: fixture.recordPath,
      repositorySlug: "example-repo",
      item: 42,
      dryRun: false,
    },
    attachDependencies({
      runner: mediaRunner([]),
      fetchPullRequest: async () => {
        throw new Error("detach must not fetch the pull request");
      },
      upsertReviewComment: () => ({}),
      logs: fixture.logs,
    }),
  );
  syncDetachedLiveProofComment(
    { recordPath: fixture.recordPath, repositorySlug: "example-repo", item: 42 },
    attachDependencies({
      runner: mediaRunner([]),
      fetchPullRequest: async () => {
        throw new Error("detach must not fetch the pull request");
      },
      upsertReviewComment: (_number, body) => {
        publishedBody = body;
        return {};
      },
      logs: fixture.logs,
    }),
  );

  assert.equal(result, "detached");
  assert.match(publishedBody, /<!-- clawsweeper-review item=42 -->/);
  assert.doesNotMatch(publishedBody, /clawsweeper-live-proof-recording|Live proof recording/);
});

test("live-proof comment sync requires the exact published bundle result", () => {
  const fixture = recordedAttachmentFixture();
  writeFileSync(
    join(fixture.bundleDir, "live-verification.json"),
    JSON.stringify({ ...validVerification(), verified_at: "2026-08-17T12:00:01.000Z" }),
    "utf8",
  );

  assert.throws(
    () =>
      syncLiveProofComment(
        { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath },
        attachDependencies({
          runner: mediaRunner([]),
          fetchPullRequest: async () => {
            throw new Error("sync must not fetch the pull request");
          },
          upsertReviewComment: () => {
            throw new Error("mismatched verification must not publish");
          },
          logs: fixture.logs,
        }),
      ),
    /does not match the proof bundle/,
  );
});

test("live-proof comment sync rejects a receipt for an older same-head plan", () => {
  const fixture = recordedAttachmentFixture();
  writeFileSync(
    fixture.recordPath,
    readFileSync(fixture.recordPath, "utf8").replace("Entry: /settings", "Entry: /new-settings"),
    "utf8",
  );

  assert.throws(
    () =>
      syncLiveProofComment(
        { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath },
        attachDependencies({
          runner: mediaRunner([]),
          fetchPullRequest: async () => {
            throw new Error("sync must not fetch the pull request");
          },
          upsertReviewComment: () => {
            throw new Error("plan mismatch must not publish");
          },
          logs: fixture.logs,
        }),
      ),
    /live proof plan does not match/,
  );
});

test("live-proof detach dry-run prints mutations without changing the record", () => {
  const fixture = recordedAttachmentFixture();
  const before = readFileSync(fixture.recordPath, "utf8");
  const result = detachLiveProof(
    {
      recordPath: fixture.recordPath,
      repositorySlug: "example-repo",
      item: 42,
      dryRun: true,
    },
    attachDependencies({
      runner: mediaRunner([]),
      fetchPullRequest: async () => {
        throw new Error("detach dry-run must not fetch the pull request");
      },
      upsertReviewComment: () => {
        throw new Error("detach dry-run must not sync the comment");
      },
      logs: fixture.logs,
    }),
  );

  assert.equal(result, "dry-run");
  assert.equal(readFileSync(fixture.recordPath, "utf8"), before);
  const output = fixture.logs.join("\n");
  assert.match(output, /dry-run: replace ## Live Proof/);
  assert.match(output, /dry-run: publish .* then upsert marker-backed review comment/);
  assert.doesNotMatch(output, /Live proof recording/);
});

test("live-proof attach command accepts detach without a bundle", async () => {
  const fixture = recordedAttachmentFixture();
  const dependencies = attachDependencies({
    runner: mediaRunner([]),
    fetchPullRequest: async () => {
      throw new Error("detach must not fetch the pull request");
    },
    upsertReviewComment: () => ({}),
    logs: fixture.logs,
  });
  const commands = createLiveProofCommands({
    repositoryProfileFor: () => profile(),
    reportLiveProofPlan: () => recommendedPlan(),
    parseLiveProofPlan: () => recommendedPlan(),
    attach: dependencies,
    fetchPullRequest: dependencies.fetchPullRequest,
    log: dependencies.log,
  });

  const result = await commands.liveProofAttachCommand({
    _: ["live-proof-attach"],
    detach: true,
    record: fixture.recordPath,
    repo_slug: "example-repo",
    item: "42",
    dry_run: true,
  });

  assert.equal(result, "dry-run");
});

test("live-proof detach rejects record identity mismatches without requiring a manifest", () => {
  const fixture = recordedAttachmentFixture();
  const dependencies = attachDependencies({
    runner: mediaRunner([]),
    fetchPullRequest: async () => {
      throw new Error("detach must not fetch the pull request");
    },
    upsertReviewComment: () => ({}),
    logs: fixture.logs,
  });

  assert.throws(
    () =>
      detachLiveProof(
        {
          recordPath: fixture.recordPath,
          repositorySlug: "other-repo",
          item: 42,
          dryRun: false,
        },
        dependencies,
      ),
    /record repository does not match --repo-slug/,
  );
  assert.throws(
    () =>
      detachLiveProof(
        {
          recordPath: fixture.recordPath,
          repositorySlug: "example-repo",
          item: 41,
          dryRun: false,
        },
        dependencies,
      ),
    /record item number does not match --item/,
  );
  writeFileSync(
    fixture.recordPath,
    readFileSync(fixture.recordPath, "utf8").replace("type: pull_request", "type: issue"),
    "utf8",
  );
  assert.throws(
    () =>
      detachLiveProof(
        {
          recordPath: fixture.recordPath,
          repositorySlug: "example-repo",
          item: 42,
          dryRun: false,
        },
        dependencies,
      ),
    /live proof can only be detached from a pull request report/,
  );
});

test("live-proof attach dry-run prints exact uploads and mutations without performing them", async () => {
  const fixture = attachmentFixture();
  const commands: string[] = [];
  let upserts = 0;
  await attachLiveProof(
    { bundleDir: fixture.bundleDir, recordPath: fixture.recordPath, dryRun: true },
    attachDependencies({
      runner: mediaRunner(commands),
      fetchPullRequest: async () => {
        throw new Error("dry-run must not call GitHub");
      },
      upsertReviewComment: () => {
        upserts += 1;
        return {};
      },
      logs: fixture.logs,
    }),
  );
  assert.equal(commands.filter((command) => command.startsWith("aws ")).length, 0);
  assert.equal(upserts, 0);
  const output = fixture.logs.join("\n");
  assert.match(output, /dry-run: aws s3 cp .*live-proof\.mp4/);
  assert.match(output, /dry-run: replace ## Live Proof/);
  assert.match(output, /dry-run: upsert marker-backed review comment/);
});

// Workflow guard: historical proof is folded before publication, and maintenance stays manual.
test("automatic live proof is retired while historical artifact publication remains", () => {
  assert.throws(() => readFileSync(".github/workflows/live-proof.yml", "utf8"));
  assert.throws(() => readFileSync(".github/actions/dispatch-live-proofs/action.yml", "utf8"));
  const sweep = readFileSync(".github/workflows/sweep.yml", "utf8");
  const sweepWorkflow = YAML.parse(sweep) as {
    jobs: Record<
      string,
      {
        steps: Array<{
          name?: string;
          id?: string;
          if?: string;
          env?: Record<string, string>;
          run?: string;
          uses?: string;
          with?: Record<string, string>;
        }>;
      }
    >;
  };
  const assertOrdered = (steps: Array<{ name?: string }>, names: string[]) => {
    const indexes = names.map((name) => steps.findIndex((step) => step.name === name));
    assert.ok(
      indexes.every((index) => index >= 0),
      `${names.join(" -> ")}: ${indexes.join(",")}`,
    );
    assert.deepEqual(
      indexes,
      [...indexes].sort((left, right) => left - right),
    );
  };

  const exactReviewSteps = sweepWorkflow.jobs["event-review-apply"]?.steps ?? [];
  assertOrdered(exactReviewSteps, [
    "Review exact event item",
    "Create exact review artifact bundle",
    "Upload exact review artifact bundle",
  ]);
  for (const name of [
    "Inspect exact review live proof",
    "Resolve exact live-proof Go version",
    "Set up exact live-proof Go toolchain",
    "Enable exact live-proof automatic Go fallback",
    "Install exact live-proof terminal tools",
    "Install exact live-proof recording tools",
    "Execute exact review live proof",
  ]) {
    assert.equal(
      exactReviewSteps.some((step) => step.name === name),
      false,
    );
  }
  const exactBundle = exactReviewSteps.find(
    (step) => step.name === "Create exact review artifact bundle",
  );
  assert.equal(exactBundle?.env?.EXACT_REVIEW_LIVE_PROOF_DIR, undefined);
  assert.doesNotMatch(exactBundle?.if ?? "", /live-proof|live_proof|execute-exact/);
  const directSetup = exactReviewSteps.find((step) => step.id === "direct-setup-state");
  assert.doesNotMatch(directSetup?.if ?? "", /live-proof|live_proof|execute-exact/);

  const shardSteps = sweepWorkflow.jobs.review?.steps ?? [];
  for (const name of [
    "Inspect review-shard live proofs",
    "Resolve review-shard live-proof Go version",
    "Set up review-shard live-proof Go toolchain",
    "Enable review-shard live-proof automatic Go fallback",
    "Install review-shard terminal tools",
    "Install review-shard recording tools",
    "Execute review-shard live proofs",
  ]) {
    assert.equal(
      shardSteps.some((step) => step.name === name),
      false,
    );
  }
  const shardUpload = shardSteps.find(
    (step) => step.with?.name === "review-shard-${{ matrix.shard }}",
  );
  assert.match(shardUpload?.if ?? "", /review-shard\.outcome/);
  assert.doesNotMatch(JSON.stringify(shardUpload), /live-proof/);

  const exactPublishSteps = sweepWorkflow.jobs["event-review-publish"]?.steps ?? [];
  assertOrdered(exactPublishSteps, [
    "Validate exact review artifact bundle",
    "Fold exact live proof into the review artifact",
    "Publish event result and apply safe close",
  ]);
  const publishSteps = sweepWorkflow.jobs.publish?.steps ?? [];
  assertOrdered(publishSteps, [
    "Fold live proofs into review artifacts",
    "Apply review artifacts",
    "Commit review records",
  ]);
  assert.match(JSON.stringify(exactPublishSteps), /CLAWSWEEPER_LIVE_PROOF_AWS/);
  assert.match(JSON.stringify(publishSteps), /CLAWSWEEPER_LIVE_PROOF_AWS/);
  assert.doesNotMatch(
    sweep,
    /dispatch-live-proofs|clawsweeper_live_proof|live-proof-attach-publish/,
  );

  const batchWorkflow = YAML.parse(
    readFileSync(".github/workflows/exact-review-batch-publish.yml", "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        steps: Array<{
          name?: string;
          id?: string;
          env?: Record<string, string>;
          uses?: string;
          run?: string;
        }>;
      }
    >;
  };
  assert.deepEqual(Object.keys(batchWorkflow.jobs), ["publish"]);
  const batchPrepare = batchWorkflow.jobs.publish?.steps.find(
    (step) => step.name === "Prepare each item independently",
  );
  assert.match(JSON.stringify(batchPrepare?.env), /CLAWSWEEPER_LIVE_PROOF_AWS/);
  assert.match(
    readFileSync("scripts/prepare-exact-review-batch.mjs", "utf8"),
    /live-proof-publish-artifacts/,
  );

  const maintenance = readFileSync(".github/workflows/live-proof-maintenance.yml", "utf8");
  assert.match(maintenance, /workflow_dispatch:/);
  assert.doesNotMatch(maintenance, /repository_dispatch:/);
  assert.match(maintenance, /live-proof-attach[\s\S]*--detach/);
  assert.match(maintenance, /live-proof-comment[\s\S]*--detach/);
});

function validManifest() {
  return {
    schema_version: 1 as const,
    repo: "example/repo",
    item: 42,
    head_sha: HEAD,
    surface: "browser" as const,
    duration_seconds: 4,
    width: 1280,
    height: 800,
    drive_status: "completed" as const,
    steps_executed: ["expect_text"],
    recorded_at: "2026-08-16T12:00:00.000Z",
  };
}

function validVerification(plan = recommendedPlan()) {
  return {
    schema_version: 1 as const,
    repo: "example/repo",
    item: 42,
    head_sha: HEAD,
    plan_sha256: liveProofPlanSha256(plan),
    surface: "browser" as const,
    entry: "/settings",
    drive_status: "completed" as const,
    steps: [
      {
        action: "expect_text" as const,
        status: "completed" as const,
        detail: "ok",
        assertion: "Saved",
        present_at_start: false,
        satisfied: true,
      },
    ],
    output: "Settings saved successfully.",
    overall_pass: true,
    verified_at: "2026-08-16T12:00:00.000Z",
  };
}

function attachmentFixture() {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-attach-"));
  const bundleDir = join(directory, "bundle");
  const recordPath = join(directory, "42.md");
  const logs: string[] = [];
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, "live-proof-manifest.json"),
    JSON.stringify(validManifest()),
    "utf8",
  );
  writeFileSync(
    join(bundleDir, "live-verification.json"),
    JSON.stringify(validVerification()),
    "utf8",
  );
  writeFileSync(join(bundleDir, "live-proof.mp4"), "mp4", "utf8");
  writeFileSync(join(bundleDir, "poster.jpg"), "jpg", "utf8");
  writeFileSync(
    recordPath,
    `---
number: 42
repository: example/repo
type: pull_request
pull_head_sha: ${HEAD}
close_reason: none
---

## Live Proof

Status: recommended

Surface: browser

Terminal completion: not_applicable

Reason: The changed setting is visible.

Payoff: ui_interaction

Payoff justification: The viewer sees the changed setting appear after interacting with the page.

Entry: /settings

Steps:

- {"action":"expect_text","text":"Saved"}

## Work Candidate

Candidate: none
`,
    "utf8",
  );
  return { bundleDir, recordPath, logs };
}

function publicationFixture() {
  const fixture = attachmentFixture();
  const artifactDir = dirname(fixture.recordPath);
  const bundleDir = join(artifactDir, "live-proof", "42");
  const recordPath = join(artifactDir, "review", "42.md");
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(dirname(recordPath), { recursive: true });
  for (const filename of readdirSync(fixture.bundleDir)) {
    renameSync(join(fixture.bundleDir, filename), join(bundleDir, filename));
  }
  renameSync(fixture.recordPath, recordPath);
  rmSync(fixture.bundleDir, { recursive: true });
  return { ...fixture, artifactDir, bundleDir, recordPath };
}

function recordedAttachmentFixture() {
  const fixture = attachmentFixture();
  const report = readFileSync(fixture.recordPath, "utf8");
  writeFileSync(
    fixture.recordPath,
    report.replace(
      "\n## Work Candidate",
      `
${LIVE_VERIFICATION_MARKER}
Result: ${encodeLiveVerificationReportPayload(validVerification())}

<!-- clawsweeper-live-proof-recording -->

[![Live proof recording](https://media.example.test/poster.jpg)](https://media.example.test/proof.mp4)

*Recorded live on the PR head (\`${HEAD.slice(0, 12)}\`), 4s, browser surface.*

## Work Candidate`,
    ),
    "utf8",
  );
  return fixture;
}

function mediaRunner(commands: string[]): MediaProofCommandRunner {
  return (command, args) => {
    commands.push([command, ...args].join(" "));
    if (command === "ffprobe") {
      const image = String(args.at(-1)).endsWith("poster.jpg");
      return {
        status: 0,
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", width: image ? 640 : 1280, height: image ? 360 : 800 }],
          format: image ? {} : { duration: "4.000" },
        }),
      };
    }
    return { status: 0 };
  };
}

function runTerminalFixture(runner: MediaProofCommandRunner) {
  return driveTerminal({
    plan: { ...recommendedPlan("terminal"), steps: [] },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    runner,
  });
}

function terminalViewport(output: string): string {
  return output.trimEnd().split("\n").slice(-50).join("\n");
}

function terminalLifecycleRunner(
  calls: string[],
  options: {
    displayReadyAfter?: number;
    recorderSizes?: Array<number | undefined>;
    recorderDiesAtProbe?: number;
    finalizeExitAfter?: number;
    paneOutput?: Record<"terminal" | "display" | "xterm" | "recorder", string>;
    initialTerminalOutput?: string;
    terminalCaptures?: string[];
    terminalCapturesByCommand?: Record<string, string[]>;
    commandExitStatus?: number;
    commandExitStatuses?: number[];
    commandSignal?: string;
    commandKeepsRunning?: boolean;
    keepsRunningCommands?: string[];
    heldCommandKeepsRunning?: boolean;
    commandCompletionAfterProbe?: number;
    recordedStatuses?: Array<number | string | null>;
    captureCompletion?: string;
    paneStatusDuringFinalize?: { status: "exited"; exitStatus: number };
    terminalPaneSequence?: Array<{ status: "running" } | { status: "exited"; exitStatus: number }>;
    heldPaneExitsBeforeCleanup?: boolean;
    malformedPaneStatus?: string;
    malformedPaneStatusAfterProbe?: number;
    cleanupNeverCompletes?: boolean;
    cleanupReplacementPid?: number;
    cleanupResult?: string;
    cleanupSurvivors?: number;
    watchdogNeverArms?: boolean;
    armedAcknowledgement?: string;
    readyAcknowledgement?: string;
    inspectCleanupScript?: (script: string) => void;
    leaveCaptureTemporaryFiles?: boolean;
    recordStatusOnHistoryProbe?: number;
    terminalCaptureAfterStatus?: string;
  } = {},
): MediaProofCommandRunner {
  let displayProbe = 0;
  let recorderSizeProbe = 0;
  let recorderPaneProbe = 0;
  let finalizeProbe = 0;
  let finalizing = false;
  let typedCommand = "";
  let terminalCaptureProbe = 0;
  let terminalHistoryProbe = 0;
  let commandLaunch = 0;
  let terminalStateProbe = 0;
  let panePid = 41_000;
  let paneTty = "/dev/ttys001";
  let paneDead = false;
  let targetStarted = false;
  let forcedPaneState: { status: "exited"; exitStatus: number } | undefined;
  let activeCommand:
    | {
        command: string;
        held: boolean;
        status: string;
        start: string;
        ready: string;
        readyTemporary: string;
        leaseIdentity: string;
        nonce: string;
      }
    | undefined;
  let activeCleanup: TerminalCleanupInvocation | undefined;
  let activeFiles:
    | {
        capture: string;
        captureTemporary: string;
        captureDone: string;
        captureDoneTemporary: string;
      }
    | undefined;
  const recorderSizes = options.recorderSizes ?? [1, 2];
  const commandExitStatus = () =>
    options.commandExitStatuses?.[commandLaunch - 1] ??
    options.commandExitStatus ??
    (options.commandSignal ? 143 : 0);
  const writeRecordedStatus = () => {
    if (
      !activeCommand?.held ||
      options.heldCommandKeepsRunning ||
      options.commandKeepsRunning ||
      options.keepsRunningCommands?.includes(typedCommand) ||
      !existsSync(activeCommand.ready) ||
      !readFileSync(activeCommand.ready, "utf8").startsWith("v1|execute|") ||
      existsSync(activeCommand.status)
    ) {
      return;
    }
    const captures = options.terminalCapturesByCommand?.[typedCommand] ??
      options.terminalCaptures ?? ["command output\n"];
    const completionAfter = options.commandCompletionAfterProbe ?? captures.length - 1;
    if (terminalCaptureProbe < completionAfter) return;
    const configured = options.recordedStatuses?.[commandLaunch - 1];
    if (configured === null) return;
    const status = configured ?? commandExitStatus();
    writeFileSync(activeCommand.status, `${status}\n`, "utf8");
    calls.push(`status ${activeCommand.status}`);
  };
  const updateTerminalFiles = () => {
    if (!activeFiles) return;
    writeRecordedStatus();
  };
  const acknowledgeTerminalReady = () => {
    if (!activeCommand || !existsSync(activeCommand.start) || existsSync(activeCommand.ready)) {
      return;
    }
    writeFileSync(
      activeCommand.readyTemporary,
      options.readyAcknowledgement ??
        `${panePid}|${paneTty}|${activeCommand.nonce}|${activeCommand.leaseIdentity}\n`,
      "utf8",
    );
    renameSync(activeCommand.readyTemporary, activeCommand.ready);
  };
  const armTerminalCleanup = (cleanup: TerminalCleanupInvocation) => {
    activeCleanup = cleanup;
    options.inspectCleanupScript?.(readFileSync(cleanup.script, "utf8"));
    if (options.watchdogNeverArms) return;
    writeFileSync(
      cleanup.resultTemporary,
      options.armedAcknowledgement ??
        `v1|armed|${cleanup.nonce}|${cleanup.panePid}|${cleanup.paneTty}|${cleanup.leaseIdentity}|42001\n`,
      "utf8",
    );
    renameSync(cleanup.resultTemporary, cleanup.result);
    calls.push("watchdog-armed");
  };
  const completeTerminalCleanup = () => {
    const cleanup = activeCleanup;
    if (!cleanup || options.cleanupNeverCompletes) return;
    const controllerRequested = existsSync(cleanup.request);
    const paneDied =
      options.heldPaneExitsBeforeCleanup === true &&
      activeCommand !== undefined &&
      existsSync(activeCommand.ready) &&
      readFileSync(activeCommand.ready, "utf8").startsWith("v1|execute|");
    if (!controllerRequested && !paneDied) return;
    if (options.cleanupReplacementPid !== undefined) {
      panePid = options.cleanupReplacementPid;
      return;
    }
    const trigger = controllerRequested ? "controller" : "pane-death";
    calls.push(`cleanup-${trigger}`);
    writeFileSync(
      cleanup.resultTemporary,
      `v1|done|${cleanup.nonce}|${cleanup.panePid}|${cleanup.paneTty}|${cleanup.leaseIdentity}|${trigger}|${options.cleanupResult ?? "ok"}|${options.cleanupSurvivors ?? 0}\n`,
      "utf8",
    );
    renameSync(cleanup.resultTemporary, cleanup.result);
    paneDead = true;
  };
  const terminalPaneState = () => {
    if (commandLaunch === 0) return { status: "running" } as const;
    acknowledgeTerminalReady();
    if (
      activeCommand &&
      existsSync(activeCommand.ready) &&
      readFileSync(activeCommand.ready, "utf8").startsWith("v1|execute|")
    ) {
      if (!targetStarted) {
        targetStarted = true;
        calls.push("target-start");
      }
      updateTerminalFiles();
    }
    completeTerminalCleanup();
    if (forcedPaneState) return forcedPaneState;
    if (paneDead) return { status: "exited", exitStatus: 0 } as const;
    if (activeCommand?.held) {
      if (
        options.heldPaneExitsBeforeCleanup &&
        existsSync(activeCommand.ready) &&
        readFileSync(activeCommand.ready, "utf8").startsWith("v1|execute|")
      ) {
        return { status: "exited", exitStatus: commandExitStatus() } as const;
      }
      return { status: "running" } as const;
    }
    const explicitState =
      options.terminalPaneSequence?.[
        Math.min(terminalStateProbe, options.terminalPaneSequence.length - 1)
      ];
    if (explicitState) return explicitState;
    const captures = options.terminalCapturesByCommand?.[typedCommand] ??
      options.terminalCaptures ?? ["command output\n"];
    const finalCapture = terminalCaptureProbe >= captures.length - 1;
    return options.commandKeepsRunning || !finalCapture
      ? ({ status: "running" } as const)
      : ({
          status: "exited",
          exitStatus: commandExitStatus(),
        } as const);
  };
  return (command, args) => {
    const rendered = [command, ...args].join(" ");
    calls.push(rendered);
    if (command === "xdpyinfo") {
      const ready = displayProbe >= (options.displayReadyAfter ?? 0);
      displayProbe += 1;
      return ready ? { status: 0 } : { status: 1, stderr: "unable to open display :99" };
    }
    if (command === "wc") {
      const size = recorderSizes[Math.min(recorderSizeProbe, recorderSizes.length - 1)];
      recorderSizeProbe += 1;
      return size === undefined
        ? { status: 1, stderr: "No such file" }
        : { status: 0, stdout: `${size} /tmp/live-proof.raw.webm\n` };
    }
    if (command === "tmux" && args[0] === "send-keys" && args.at(-1) === "q") {
      finalizing = true;
      forcedPaneState = options.paneStatusDuringFinalize;
      terminalStateProbe += 1;
      updateTerminalFiles();
      return { status: 0 };
    }
    if (command === "tmux" && args[0] === "pipe-pane" && args.includes("-O")) {
      const invocation = terminalCaptureInvocation(args);
      assert.ok(invocation);
      activeFiles = invocation;
      return { status: 0 };
    }
    if (command === "tmux" && args[0] === "pipe-pane") {
      updateTerminalFiles();
      if (activeFiles) {
        const captures = options.terminalCapturesByCommand?.[typedCommand] ??
          options.terminalCaptures ?? ["command output\n"];
        const output = captures[Math.min(terminalCaptureProbe, captures.length - 1)] ?? "";
        const captured = output.replace(/^\$ [^\n]*\n/, "");
        writeFileSync(activeFiles.captureTemporary, captured, "utf8");
        writeFileSync(
          activeFiles.captureDoneTemporary,
          `${options.captureCompletion ?? "eof"}\n`,
          "utf8",
        );
        writeFileSync(activeFiles.capture, captured, "utf8");
        writeFileSync(activeFiles.captureDone, `${options.captureCompletion ?? "eof"}\n`, "utf8");
        if (!options.leaveCaptureTemporaryFiles) {
          rmSync(activeFiles.captureTemporary, { force: true });
          rmSync(activeFiles.captureDoneTemporary, { force: true });
        }
      }
      return { status: 0 };
    }
    if (command === "tmux" && args[0] === "respawn-pane") {
      const target = String(args[args.indexOf("-t") + 1] ?? "");
      if (!target.includes("-terminal")) return { status: 0 };
      const invocation = terminalCommandInvocation(args);
      assert.ok(invocation);
      typedCommand = readFileSync(invocation.command, "utf8").trimEnd();
      activeCommand = invocation;
      activeCleanup = undefined;
      commandLaunch += 1;
      panePid += 1;
      paneDead = false;
      targetStarted = false;
      forcedPaneState = undefined;
      terminalCaptureProbe = 0;
      terminalHistoryProbe = 0;
      terminalStateProbe = 0;
      return { status: 0 };
    }
    if (command === "tmux" && args[0] === "display-message") {
      const target = String(args[args.indexOf("-t") + 1] ?? "");
      if (
        target.includes("-terminal") &&
        args.at(-1) ===
          "#{pane_pid}|#{pane_tty}|#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}"
      ) {
        const malformed =
          options.malformedPaneStatus !== undefined &&
          terminalStateProbe >= (options.malformedPaneStatusAfterProbe ?? 0);
        terminalStateProbe += 1;
        if (malformed) {
          return { status: 0, stdout: `${options.malformedPaneStatus}\n` };
        }
        const state = terminalPaneState();
        terminalStateProbe += 1;
        return state.status === "running"
          ? { status: 0, stdout: `${panePid}|${paneTty}|0||\n` }
          : { status: 0, stdout: `${panePid}|${paneTty}|1|${state.exitStatus}|\n` };
      }
      if (finalizing) {
        const exited = finalizeProbe >= (options.finalizeExitAfter ?? 0);
        finalizeProbe += 1;
        return { status: 0, stdout: exited ? "1\n" : "0\n" };
      }
      const exited = recorderPaneProbe >= (options.recorderDiesAtProbe ?? Number.POSITIVE_INFINITY);
      recorderPaneProbe += 1;
      return { status: 0, stdout: exited ? "1\n" : "0\n" };
    }
    if (command === "tmux" && args[0] === "capture-pane") {
      const target = String(args[args.indexOf("-t") + 1] ?? "");
      const label = target.includes("-display")
        ? "display"
        : target.includes("-xterm")
          ? "xterm"
          : target.includes("-recorder")
            ? "recorder"
            : "terminal";
      if (label === "terminal" && !options.paneOutput?.terminal) {
        if (!typedCommand) return { status: 0, stdout: options.initialTerminalOutput ?? "$ \n" };
        const captures = options.terminalCapturesByCommand?.[typedCommand] ??
          options.terminalCaptures ?? ["command output\n"];
        const statusWasPresent = activeCommand ? existsSync(activeCommand.status) : false;
        const output =
          statusWasPresent && options.terminalCaptureAfterStatus !== undefined
            ? options.terminalCaptureAfterStatus
            : (captures[Math.min(terminalCaptureProbe, captures.length - 1)] ?? "");
        if (
          activeCommand?.held &&
          !statusWasPresent &&
          terminalHistoryProbe === options.recordStatusOnHistoryProbe
        ) {
          writeFileSync(activeCommand.status, `${commandExitStatus()}\n`, "utf8");
        }
        terminalHistoryProbe += 1;
        const viewport = terminalViewport(output.replace(/^\$ [^\n]*\n/, ""));
        return {
          status: 0,
          stdout: viewport ? `${viewport}\n` : "",
        };
      }
      return { status: 0, stdout: `${options.paneOutput?.[label] ?? `${label} pane`}\n` };
    }
    if (command === "tmux" && args[0] === "run-shell") {
      const cleanup = terminalCleanupInvocation(args);
      assert.ok(cleanup);
      armTerminalCleanup(cleanup);
      return { status: 0 };
    }
    if (command === "sleep" && activeFiles) {
      if (args[0] !== "0.1") terminalCaptureProbe += 1;
      updateTerminalFiles();
      completeTerminalCleanup();
    }
    return { status: 0 };
  };
}

function terminalCommandInvocation(args: readonly string[]):
  | {
      command: string;
      held: boolean;
      status: string;
      start: string;
      ready: string;
      readyTemporary: string;
      leaseIdentity: string;
      nonce: string;
    }
  | undefined {
  const target = String(args[args.indexOf("-t") + 1] ?? "");
  if (!target.includes("-terminal")) return undefined;
  const shellCommand = String(args.at(-1) ?? "");
  const quoted = [...shellCommand.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
  const invocation = quoted.slice(-10);
  if (invocation.length !== 10 || invocation[0] !== "clawsweeper-terminal") return undefined;
  return {
    command: invocation[1]!,
    held: shellCommand.includes("while :; do sleep 3600; done"),
    status: invocation[3]!,
    start: invocation[4]!,
    readyTemporary: invocation[5]!,
    ready: invocation[6]!,
    nonce: invocation[7]!,
    leaseIdentity: invocation[9]!,
  };
}

interface TerminalCleanupInvocation {
  script: string;
  paneTty: string;
  panePid: string;
  nonce: string;
  leaseIdentity: string;
  request: string;
  resultTemporary: string;
  result: string;
}

function terminalCleanupInvocation(args: readonly string[]): TerminalCleanupInvocation | undefined {
  const shellCommand = String(args.at(-1) ?? "");
  const quoted = [...shellCommand.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
  const invocation = quoted.slice(-10);
  if (invocation.length !== 10 || invocation[0] !== "/bin/bash") return undefined;
  return {
    script: invocation[1]!,
    paneTty: invocation[2]!,
    panePid: invocation[3]!,
    nonce: invocation[4]!,
    leaseIdentity: invocation[6]!,
    request: invocation[7]!,
    resultTemporary: invocation[8]!,
    result: invocation[9]!,
  };
}

function terminalCaptureInvocation(args: readonly string[]):
  | {
      capture: string;
      captureTemporary: string;
      captureDone: string;
      captureDoneTemporary: string;
    }
  | undefined {
  const target = String(args[args.indexOf("-t") + 1] ?? "");
  if (!target.includes("-terminal")) return undefined;
  const quoted = [...String(args.at(-1) ?? "").matchAll(/'([^']*)'/g)].map((match) => match[1]!);
  const files = quoted.slice(-5);
  if (files.length !== 5) return undefined;
  return {
    capture: files[1]!,
    captureTemporary: files[2]!,
    captureDone: files[3]!,
    captureDoneTemporary: files[4]!,
  };
}

function executeFixture(
  mode:
    | "failed"
    | "present-at-start"
    | "demonstrated-partial"
    | "no-expectation"
    | "too-short"
    | "probe-failed",
) {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-execute-"));
  const outputDir = join(directory, "output");
  const planPath = join(directory, "plan.json");
  const manifestPath = join(outputDir, "live-proof-manifest.json");
  const verificationPath = join(outputDir, "live-verification.json");
  const mp4Path = join(outputDir, "live-proof.mp4");
  const logs: string[] = [];
  const commands: string[] = [];
  const plan: LiveProofPlan = {
    ...recommendedPlan("browser"),
    steps:
      mode === "demonstrated-partial"
        ? [
            { action: "click", target: "#save" },
            { action: "expect_text", text: "Saved" },
            { action: "wait_for", target: "#never" },
          ]
        : mode === "no-expectation"
          ? [{ action: "click", target: "#save" }]
          : [
              { action: "click", target: "#save" },
              { action: "expect_text", text: "Saved" },
            ],
  };
  writeFileSync(planPath, JSON.stringify(plan), "utf8");

  const runner: MediaProofCommandRunner = (command, args, options) => {
    commands.push([command, ...args].join(" "));
    if (command === "git") return { status: 0, stdout: `${HEAD}\n` };
    if (command === "node") {
      const env = options?.env ?? {};
      writeFileSync(String(env.CLAWSWEEPER_LIVE_PROOF_RAW_VIDEO), "webm", "utf8");
      writeFileSync(String(env.CLAWSWEEPER_LIVE_PROOF_CAPTURED_OUTPUT), "Settings saved\n", "utf8");
      const steps =
        mode === "failed"
          ? [
              { action: "click", status: "failed", detail: "not visible" },
              {
                action: "expect_text",
                status: "failed",
                detail: "not visible",
                presentAtStart: false,
                satisfied: false,
              },
            ]
          : mode === "demonstrated-partial"
            ? [
                { action: "click", status: "completed", detail: "ok" },
                {
                  action: "expect_text",
                  status: "completed",
                  detail: "ok",
                  presentAtStart: false,
                  satisfied: true,
                },
                { action: "wait_for", status: "failed", detail: "not visible" },
              ]
            : mode === "no-expectation"
              ? [{ action: "click", status: "completed", detail: "ok" }]
              : [
                  { action: "click", status: "completed", detail: "ok" },
                  {
                    action: "expect_text",
                    status: "completed",
                    detail: "ok",
                    presentAtStart: mode === "present-at-start",
                    satisfied: true,
                  },
                ];
      writeFileSync(
        String(env.CLAWSWEEPER_LIVE_PROOF_STEPS_LOG),
        `${JSON.stringify(steps)}\n`,
        "utf8",
      );
      return {
        status: mode === "failed" || mode === "demonstrated-partial" ? 1 : 0,
        stderr: mode === "failed" ? "failed" : "",
      };
    }
    if (command === "ffprobe") {
      if (mode === "probe-failed") {
        return {
          status: null,
          error: Object.assign(new Error("spawn ffprobe ENOENT"), { code: "ENOENT" }),
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          streams: [{ codec_type: "video", width: 1280, height: 800 }],
          format: { duration: mode === "too-short" ? "2.999" : "7.000" },
        }),
      };
    }
    if (command === "ffmpeg") {
      const output = String(args.at(-1));
      writeFileSync(output, output.endsWith(".jpg") ? "jpg" : "mp4", "utf8");
      return { status: 0 };
    }
    return { status: 0 };
  };

  return {
    commands,
    logs,
    manifestPath,
    verificationPath,
    mp4Path,
    run: () =>
      executeLiveProof(
        {
          repo: "example/repo",
          item: 42,
          outputDir,
          planPath,
          checkoutPath: directory,
        },
        {
          env: { CLAWSWEEPER_LIVE_PROOF_ENABLED: "1" },
          runner,
          repositoryProfileFor: () => profile(),
          reportLiveProofPlan: () => plan,
          parseLiveProofPlan: () => plan,
          fetchPullRequest: async () => {
            throw new Error("local checkout must not fetch the pull request");
          },
          log: (message) => logs.push(message),
          now: () => new Date("2026-08-17T12:00:00.000Z"),
        },
      ),
  };
}

function attachDependencies(options: {
  runner: MediaProofCommandRunner;
  fetchPullRequest: () => Promise<{
    kind: "issue" | "pull_request";
    state: string;
    headSha: string | null;
  }>;
  upsertReviewComment: (number: number, body: string) => Record<string, unknown> | undefined;
  logs: string[];
}) {
  return {
    env: {
      CLAWSWEEPER_LIVE_PROOF_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      CLAWSWEEPER_LIVE_PROOF_BUCKET: "proof-bucket",
      CLAWSWEEPER_LIVE_PROOF_BASE_URL: "https://media.example.test",
    },
    runner: options.runner,
    fetchPullRequest: options.fetchPullRequest,
    reportLiveProofPlan: reportLiveProofPlanForTest,
    frontMatterValue,
    sectionValue,
    replaceSectionValue,
    reviewSections: REVIEW_SECTIONS,
    renderReviewCommentFromReport: (markdown: string) =>
      `Review comment\n\n### Live Verification\n\n${sectionValue(markdown, REVIEW_SECTIONS.liveProof)}`,
    markedReviewCommentBody: (number: number, body: string) =>
      `${body}\n\n<!-- clawsweeper-review item=${number} -->`,
    upsertReviewComment: options.upsertReviewComment,
    log: (message: string) => options.logs.push(message),
  };
}

function frontMatterValue(markdown: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*(.*)$`, "m").exec(markdown)?.[1]?.trim();
}

function sectionValue(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`(?:^|\\n)## ${escaped}\\n\\n([\\s\\S]*?)(?=\\n## |\\n?$)`)
      .exec(markdown)?.[1]
      ?.trim() ?? ""
  );
}

function replaceSectionValue(markdown: string, heading: string, value: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`((?:^|\\n)## ${escaped}\\n\\n)([\\s\\S]*?)(?=\\n## |\\n?$)`);
  return markdown.replace(pattern, `$1${value.trim()}\n`);
}
