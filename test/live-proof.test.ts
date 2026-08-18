import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

import { LIVE_VERIFICATION_MARKER, REVIEW_SECTIONS } from "../dist/clawsweeper-policy.js";
import type { LiveProofPlan, MediaProofCommandRunner } from "../dist/clawsweeper-types.js";
import type { RepositoryProfile } from "../dist/repository-profiles.js";
import {
  attachReviewLiveProofArtifact,
  attachLiveProof,
  detachLiveProof,
  syncDetachedLiveProofComment,
  syncLiveProofComment,
} from "../dist/live-proof/attach.js";
import { createLiveProofCommands } from "../dist/live-proof/commands.js";
import {
  driveTerminal,
  generatePlaywrightScript,
  terminalCommandPlan,
} from "../dist/live-proof/drivers.js";
import {
  ensureLiveProofPackageManager,
  executeLiveProof,
  liveProofPackageManagerInstallCommand,
  liveProofSetupCommand,
} from "../dist/live-proof/execute.js";
import {
  assertLiveProofEnvironmentSanitized,
  sanitizedLiveProofEnvironment,
} from "../dist/live-proof/environment.js";
import { parseLiveProofManifest } from "../dist/live-proof/manifest.js";
import {
  buildLiveVerificationResult,
  encodeLiveVerificationReportPayload,
  parseLiveVerificationResult,
  renderLiveVerificationCommentBlock,
  sanitizeUntrustedOutput,
} from "../dist/live-proof/verification.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function recommendedPlan(surface: "browser" | "terminal" = "browser"): LiveProofPlan {
  return surface === "browser"
    ? {
        status: "recommended",
        surface,
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

test("live-proof review child prints the sanitized-environment assertion", async () => {
  const logs: string[] = [];
  const plan: LiveProofPlan = {
    status: "not_applicable",
    surface: "none",
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

test("live-proof reports an unsupported package manager clearly", () => {
  assert.throws(
    () =>
      ensureLiveProofPackageManager("yarn", () => ({ status: 1 }), "/tmp/checkout", {
        HOME: "/tmp/live-proof-home",
        PATH: "/usr/bin",
      }),
    /unsupported live-proof package manager "yarn"; expected bun, pnpm, or npm/,
  );
  assert.equal(
    liveProofPackageManagerInstallCommand("bun"),
    "curl -fsSL https://bun.sh/install | bash",
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
  });
  assert.deepEqual(commands[0], {
    command: "tmux",
    args: ["new-session", "-d", "-s", "proof-terminal", "-x", "160", "-y", "50"],
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
      "DISPLAY=:99",
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

test("terminal run waits for pane content beyond the echoed command", () => {
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
  assert.equal(result.status, "completed");
  const enter = calls.findIndex((call) => /tmux send-keys .* Enter$/.test(call));
  const hold = calls.findIndex((call, index) => index > enter && call === "sleep 6");
  assert.notEqual(enter, -1);
  assert.notEqual(hold, -1);
  assert.equal(calls.slice(enter + 1, hold).filter((call) => call === "sleep 1").length, 2);
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

test("terminal expect_output times out without matching the echoed command", () => {
  const calls: string[] = [];
  const result = driveTerminal({
    plan: {
      ...recommendedPlan("terminal"),
      entry: "show expected-token",
      steps: [{ action: "expect_output", text: "expected-token" }],
    },
    checkout: "/tmp/checkout",
    rawVideoPath: "/tmp/live-proof.raw.webm",
    maxRecordingSeconds: 90,
    runner: terminalLifecycleRunner(calls, {
      terminalCaptures: ["$ show expected-token\nworking\n"],
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.steps[0]?.status, "failed");
  assert.equal(result.steps[0]?.presentAtStart, false);
  assert.equal(result.steps[0]?.satisfied, false);
  assert.match(result.steps[0]?.detail ?? "", /within 30 seconds/);
  assert.match(result.steps[0]?.detail ?? "", /Captured pane:\n\$ show expected-token/);
  assert.equal(calls.filter((call) => call === "sleep 1").length, 30);
});

test("terminal recording holds the end state and enforces its minimum before finalizing", () => {
  const calls: string[] = [];
  runTerminalFixture(terminalLifecycleRunner(calls));
  const hold = calls.findIndex((call) => call === "sleep 6");
  const finalize = calls.findIndex((call) => /tmux send-keys .* q$/.test(call));
  assert.notEqual(hold, -1);
  assert.ok(finalize > hold);
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
      (call) => call.includes("tmux display-message") && call.includes("pane_dead"),
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

test("execution setup failures still produce a failed verification result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "clawsweeper-live-verification-failure-"));
  const outputDir = join(directory, "output");
  const planPath = join(directory, "plan.json");
  const plan = recommendedPlan("browser");
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
        return { status: 1, stderr: "setup exploded" };
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
  assert.equal(verification.output, "");
  assert.deepEqual(verification.failure, {
    phase: "execution",
    reason: "sh -lc pnpm install --ignore-scripts failed: setup exploded",
  });
  assert.match(
    renderLiveVerificationCommentBlock(verification),
    /FAIL \(failed\) — execution before step 1 `expect_text`: `sh -lc pnpm install --ignore-scripts failed: setup exploded`/,
  );
  assert.equal(existsSync(join(outputDir, "live-proof-manifest.json")), false);
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
  assert.match(rendered, /- PASS `goto` `\/chat`/);
  assert.match(rendered, /- FAIL `click`/);
  assert.match(rendered, /locator\.click: Timeout 5000ms exceeded/);
  assert.doesNotMatch(rendered, /DOCUMENT-WIDE SECRET|Skip to main content|Molty|Working/);
  assert.doesNotMatch(rendered, /expect_text|\*\*Assertions:\*\*|```|<|>|clawsweeper-review/);
  assert.match(rendered, /ˋˋˋ|‹now›|claw​sweeper-review/);
});

test("terminal verification keeps sanitized captured output and omits empty assertions", () => {
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
  assert.match(rendered, /\*\*Result:\*\* PASS \(completed\)/);
  assert.match(rendered, /```text\nUsage: clawsweeper \[options\]/);
  assert.match(rendered, /ˋˋˋ|‹\/details›|claw​sweeper-review/);
  assert.doesNotMatch(rendered, /\*\*Assertions:\*\*|<\/details>|<!-- clawsweeper-review/);
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

test("live-proof maintenance syncs the marker-backed comment only after publication", () => {
  const fixture = recordedAttachmentFixture();
  const calls: string[] = [];
  calls.push("hydrate");
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
  calls.push("detach", "publish", "comment");
  syncDetachedLiveProofComment(
    { recordPath: fixture.recordPath, repositorySlug: "example-repo", item: 42 },
    attachDependencies({
      runner: mediaRunner([]),
      fetchPullRequest: async () => {
        throw new Error("detach must not fetch the pull request");
      },
      upsertReviewComment: (_number, body) => {
        assert.doesNotMatch(body, /clawsweeper-live-proof-recording|Live proof recording/);
        return {};
      },
      logs: fixture.logs,
    }),
  );

  assert.equal(result, "detached");
  assert.deepEqual(calls, ["hydrate", "detach", "publish", "comment"]);
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

test("live proof executes in review jobs and publishes through existing artifact lanes", () => {
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
    "Inspect exact review live proof",
    "Execute exact review live proof",
    "Create exact review artifact bundle",
    "Upload exact review artifact bundle",
  ]);
  const directSetup = exactReviewSteps.find((step) => step.id === "direct-setup-state");
  assert.match(directSetup?.if ?? "", /execute-exact-live-proof\.outputs\.produced != 'true'/);
  assert.doesNotMatch(JSON.stringify(exactReviewSteps), /CLAWSWEEPER_LIVE_PROOF_AWS/);
  assert.doesNotMatch(JSON.stringify(exactReviewSteps), /containment|unshare/);

  const shardSteps = sweepWorkflow.jobs.review?.steps ?? [];
  assertOrdered(shardSteps, [
    "Review shard",
    "Inspect review-shard live proofs",
    "Execute review-shard live proofs",
  ]);
  const recordingInstall = shardSteps.find(
    (step) => step.name === "Install review-shard recording tools",
  );
  assert.match(recordingInstall?.if ?? "", /record_media == 'true'/);
  const shardUpload = shardSteps.find((step) => step.uses === "actions/upload-artifact@v7");
  assert.match(JSON.stringify(shardUpload), /live-verification\.json/);
  assert.doesNotMatch(JSON.stringify(shardSteps), /containment|unshare/);

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

function validVerification() {
  return {
    schema_version: 1 as const,
    repo: "example/repo",
    item: 42,
    head_sha: HEAD,
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
  } = {},
): MediaProofCommandRunner {
  let displayProbe = 0;
  let recorderSizeProbe = 0;
  let recorderPaneProbe = 0;
  let finalizeProbe = 0;
  let finalizing = false;
  let typedCommand = "";
  let commandRunning = false;
  let terminalCaptureProbe = 0;
  const recorderSizes = options.recorderSizes ?? [1, 2];
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
      return { status: 0 };
    }
    if (command === "tmux" && args[0] === "send-keys" && args.includes("-l")) {
      typedCommand = String(args.at(-1) ?? "");
      return { status: 0 };
    }
    if (command === "tmux" && args[0] === "send-keys" && args.at(-1) === "Enter") {
      commandRunning = true;
      return { status: 0 };
    }
    if (command === "tmux" && args[0] === "display-message") {
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
        if (!typedCommand) {
          return { status: 0, stdout: options.initialTerminalOutput ?? "$ \n" };
        }
        if (!commandRunning) return { status: 0, stdout: `$ ${typedCommand}\n` };
        const captures = options.terminalCaptures ?? [`$ ${typedCommand}\ncommand output\n`];
        const output = captures[Math.min(terminalCaptureProbe, captures.length - 1)] ?? "";
        terminalCaptureProbe += 1;
        return { status: 0, stdout: output };
      }
      return { status: 0, stdout: `${options.paneOutput?.[label] ?? `${label} pane`}\n` };
    }
    return { status: 0 };
  };
}

function executeFixture(
  mode: "failed" | "present-at-start" | "demonstrated-partial" | "no-expectation" | "too-short",
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
