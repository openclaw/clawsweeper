import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { LiveProofPlan } from "../dist/clawsweeper-types.js";
import { mediaProofCommandRunner } from "../dist/clawsweeper-media-proof.js";
import { driveTerminal } from "../dist/live-proof/drivers.js";
import {
  executeReviewLiveProofs,
  inspectReviewLiveProofs,
  reviewLiveProofGoEnvironment,
} from "../dist/live-proof/review-artifacts.js";
import { sanitizedLiveProofEnvironment } from "../dist/live-proof/environment.js";
import { parseLiveVerificationResult } from "../dist/live-proof/verification.js";

test("review live proof composes inherited Go environment settings", () => {
  const profile = join("scratch", "profile");
  const environment = sanitizedLiveProofEnvironment({
    GOFLAGS: "-trimpath -modcacherw=false",
    GOMODCACHE: join("shared", "go", "pkg", "mod"),
    GOTOOLCHAIN: "local",
    GH_TOKEN: "must-not-cross",
  });
  Object.assign(environment, reviewLiveProofGoEnvironment(environment, profile));

  assert.equal(environment.GOTOOLCHAIN, "local");
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.GOFLAGS, "-trimpath -modcacherw=false -modcacherw");
  assert.equal(environment.GOMODCACHE, join(profile, "go-mod-cache"));
});

test("review live proof inspection rejects invalid persisted plans", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-invalid-live-proof-review-"));
  const records = join(root, "records");
  mkdirSync(records);
  writeFileSync(
    join(records, "42.md"),
    "---\ntype: pull_request\n---\n\n## Live Proof\n\nStatus: recommended\n",
  );
  try {
    assert.throws(
      () =>
        inspectReviewLiveProofs(
          { itemNumbers: [42], recordsDir: records, repo: "example/repo" },
          {
            frontMatterValue: (markdown, key) =>
              new RegExp(`^${key}:\\s*(.*)$`, "m").exec(markdown)?.[1]?.trim(),
            reportLiveProofPlan: () => ({
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
            repositoryProfileFor: () => ({
              targetRepo: "example/repo",
              slug: "example-repo",
              displayName: "Example",
              checkoutDir: "example",
              packageManager: "pnpm",
              promptNote: "Example.",
              applyCloseRules: {},
              liveTest: {
                enabled: true,
                surfaceDefault: "terminal",
                setup: [],
                allowInstallScripts: false,
                readyTimeoutSeconds: 5,
                maxRecordingSeconds: 90,
              },
            }),
          },
        ),
      /live proof plan for 42 is invalid.*regenerate the review report/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  "review live proof runs an unsandboxed static plan with a sanitized child environment",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-review-"));
    const target = join(root, "target");
    const records = join(root, "records");
    const output = join(root, "output");
    mkdirSync(target);
    mkdirSync(records);
    const plan: LiveProofPlan = {
      status: "recommended",
      surface: "terminal",
      terminalCompletion: "exit_zero",
      reason: "The command prints a deterministic result.",
      payoff: { kind: "static_text", justification: "A recording adds no value." },
      entry:
        "test ! -e install-script-ran && test -z \"${OPENAI_API_KEY-}${GH_TOKEN-}${AWS_SECRET_ACCESS_KEY-}${CLAWSWEEPER_R2_TOKEN-}${DATABASE_PASSWORD-}${PACKAGE_KEY-}\" && printf 'sanitized-ready\\n'",
      steps: [{ action: "expect_output", text: "sanitized-ready" }],
    };
    try {
      writeFileSync(
        join(target, "package.json"),
        `${JSON.stringify({
          name: "sanitized-fixture",
          private: true,
          scripts: {
            preinstall:
              "node -e \"require('node:fs').writeFileSync('install-script-ran', 'unsafe')\"",
          },
        })}\n`,
      );
      writeFileSync(
        join(target, "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
      );
      git(target, "init", "-b", "main");
      git(target, "config", "user.name", "ClawSweeper Test");
      git(target, "config", "user.email", "test@example.com");
      git(target, "add", ".");
      git(target, "commit", "-m", "fixture");
      const head = git(target, "rev-parse", "HEAD").trim();
      writeFileSync(
        join(records, "42.md"),
        `---\nnumber: 42\nrepository: openclaw/sanitized-fixture\ntype: pull_request\npull_head_sha: ${head}\n---\n\n## Live Proof\n\nStatus: recommended\n\nSurface: terminal\n\nTerminal completion: exit_zero\n\nReason: The command prints a deterministic result.\n\nPayoff: static_text\n\nPayoff justification: A recording adds no value.\n\nEntry: ${plan.entry}\n\nSteps:\n\n- {"action":"expect_output","text":"sanitized-ready"}\n\n## Work Candidate\n\nCandidate: none\n`,
      );
      const logs: string[] = [];
      executeReviewLiveProofs(
        {
          checkoutPath: target,
          entrypoint: resolve("dist/clawsweeper.js"),
          itemNumbers: [42],
          outputRoot: output,
          recordsDir: records,
          repo: "openclaw/sanitized-fixture",
        },
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: "must-not-cross",
            GH_TOKEN: "must-not-cross",
            AWS_SECRET_ACCESS_KEY: "must-not-cross",
            CLAWSWEEPER_R2_TOKEN: "must-not-cross",
            DATABASE_PASSWORD: "must-not-cross",
            PACKAGE_KEY: "must-not-cross",
          },
          frontMatterValue: (markdown, key) =>
            new RegExp(`^${key}:\\s*(.*)$`, "m").exec(markdown)?.[1]?.trim(),
          reportLiveProofPlan: () => plan,
          repositoryProfileFor: () => ({
            targetRepo: "openclaw/sanitized-fixture",
            slug: "openclaw-sanitized-fixture",
            displayName: "fixture",
            checkoutDir: "fixture",
            packageManager: "pnpm",
            promptNote: "fixture",
            applyCloseRules: {},
            liveTest: {
              enabled: true,
              surfaceDefault: "terminal",
              setup: ["pnpm install --frozen-lockfile"],
              allowInstallScripts: false,
              readyTimeoutSeconds: 10,
              maxRecordingSeconds: 90,
            },
          }),
          log: (message) => logs.push(message),
        },
      );

      const verification = parseLiveVerificationResult(
        JSON.parse(readFileSync(join(output, "42", "live-verification.json"), "utf8")) as unknown,
      );
      assert.equal(verification.overall_pass, true, JSON.stringify(verification));
      assert.equal(verification.output.includes("sanitized-ready"), true);
      assert.match(logs.join("\n"), /sanitized environment assertion passed: credentials=0/);
      assert.match(logs.join("\n"), /execution=unsandboxed credentials=0/);
      assert.equal(logs.join("\n").includes("must-not-cross"), false);
      console.log(logs.join("\n"));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof cannot pass from package-manager echo before a nonzero exit",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-package-echo-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify({
          name: "package-echo-fixture",
          private: true,
          scripts: { proof: "node fail.mjs ECHO_ONLY_MARKER" },
        })}\n`,
      );
      writeFileSync(
        join(root, "fail.mjs"),
        'process.stderr.write("real command failed\\n"); process.exit(7);\n',
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The package script prints a deterministic marker.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "pnpm run proof",
          steps: [{ action: "expect_output", text: "ECHO_ONLY_MARKER" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "failed");
      assert.equal(result.steps[0]?.status, "failed");
      assert.match(result.steps[0]?.detail ?? "", /exit status 7/);
      assert.match(result.output, /\[command 1 combined output\][\s\S]*ECHO_ONLY_MARKER/);
      assert.match(result.output, /ECHO_ONLY_MARKER[\s\S]*real command failed/);
      assert.doesNotMatch(result.output, /\[command 1 (?:stdout|stderr)\]/);
      assert.equal(result.output.match(/real command failed/g)?.length, 1);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof publishes the clean final viewport across stdout and stderr",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-streams-"));
    try {
      writeFileSync(
        join(root, "help.mjs"),
        [
          "for (let index = 1; index <= 75; index += 1) process.stdout.write(`BUILD_WARNING_${index}\\n`);",
          "for (let index = 1; index <= 59; index += 1) process.stdout.write(`help option ${index}\\n`);",
          'process.stderr.write("FINAL_HELP_RESULT\\n");',
        ].join("\n"),
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command prints help after build diagnostics.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "node help.mjs",
          steps: [{ action: "expect_output", text: "FINAL_HELP_RESULT" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.equal(result.steps[0]?.satisfied, true);
      assert.match(result.output, /help option 12/);
      assert.match(result.output, /FINAL_HELP_RESULT/);
      assert.doesNotMatch(result.output, /BUILD_WARNING_/);
      assert.equal(result.output.split("\n").length, 50);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof retains the end of successful output beyond the stream cap",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-tail-"));
    try {
      writeFileSync(
        join(root, "verbose.mjs"),
        [
          'process.stdout.write("STALE_PREFIX_0123456789abcdef\\n".repeat(40_000));',
          "for (let index = 1; index <= 59; index += 1) process.stdout.write(`final option ${index}\\n`);",
          'process.stdout.write("FINAL_TAIL_RESULT\\n");',
        ].join("\n"),
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command prints its result after verbose setup output.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "node verbose.mjs",
          steps: [{ action: "expect_output", text: "FINAL_TAIL_RESULT" }],
        },
        checkout: root,
        rawVideoPath: join(root, "tail-proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed");
      assert.equal(result.steps[0]?.satisfied, true);
      assert.match(result.output, /final option 12/);
      assert.match(result.output, /FINAL_TAIL_RESULT/);
      assert.doesNotMatch(result.output, /STALE_PREFIX/);
      assert.equal(result.output.split("\n").length, 50);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof preserves an observed marker after later history eviction",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-observed-"));
    try {
      writeFileSync(
        join(root, "evict-marker.mjs"),
        [
          'process.stdout.write("\\u001b[32mEARLY_OBSERVED\\u001b[0m\\nMARKER\\n");',
          "await new Promise((resolve) => setTimeout(resolve, 1_100));",
          'process.stdout.write("EVICTING_OUTPUT_0123456789abcdef\\n".repeat(60_000));',
          "for (let index = 1; index <= 59; index += 1) process.stdout.write(`final result ${index}\\n`);",
          'process.stdout.write("FINAL_AFTER_EVICTION\\n");',
        ].join("\n"),
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command prints an early marker before verbose final output.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "node evict-marker.mjs",
          steps: [{ action: "expect_output", text: "EARLY_OBSERVED\nMARKER" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.equal(result.steps[0]?.satisfied, true);
      assert.doesNotMatch(result.output, /EARLY_OBSERVED|MARKER|EVICTING_OUTPUT_/);
      assert.match(result.output, /final result 12/);
      assert.match(result.output, /FINAL_AFTER_EVICTION/);
      assert.equal(result.output.split("\n").length, 50);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof retains a burst marker beyond the default tmux history",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-history-"));
    try {
      writeFileSync(
        join(root, "history-burst.mjs"),
        [
          'process.stdout.write("EARLY_BURST_MARKER\\n");',
          'process.stdout.write("BURST_LINE\\n".repeat(3_000));',
          'process.stdout.write("FINAL_BURST_RESULT\\n");',
        ].join("\n"),
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command emits its marker before a burst larger than tmux's default history.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "node history-burst.mjs",
          steps: [{ action: "expect_output", text: "EARLY_BURST_MARKER" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.equal(result.steps[0]?.satisfied, true);
      assert.match(result.output, /FINAL_BURST_RESULT/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof preserves its PTY and seals immediate mixed-stream output in order",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-pty-"));
    try {
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command requires a real controlling terminal.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry:
            "test -t 0 && test -t 1 && test -t 2 && " +
            "printf 'TTY_WRITE\\n' >/dev/tty && " +
            "printf 'OUT_ONE\\n'; printf 'ERR_TWO\\n' >&2; printf 'IMMEDIATE_FINAL\\n'",
          steps: [{ action: "expect_output", text: "IMMEDIATE_FINAL" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.equal(result.steps[0]?.satisfied, true);
      assert.match(result.output, /TTY_WRITE/);
      assert.ok(result.output.indexOf("OUT_ONE") < result.output.indexOf("ERR_TWO"));
      assert.ok(result.output.indexOf("ERR_TWO") < result.output.indexOf("IMMEDIATE_FINAL"));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof preserves direct /dev/tty output through held cutover",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-dev-tty-"));
    try {
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command requires a real PTY and writes its result directly to the terminal.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "test -t 0 && test -t 1 && test -t 2 && printf 'TTY_READY\\n' >/dev/tty",
          steps: [{ action: "expect_output", text: "TTY_READY" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.equal(result.steps[0]?.satisfied, true);
      assert.match(result.output, /TTY_READY/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("terminal proof executes extglob enabled inside the command file", { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-extglob-"));
  try {
    const result = driveTerminal({
      plan: {
        status: "recommended",
        surface: "terminal",
        terminalCompletion: "exit_zero",
        reason: "The command enables Bash extended glob syntax at runtime.",
        payoff: { kind: "static_text", justification: "Text is sufficient." },
        entry: "shopt -s extglob\nvalue=proof\n[[ $value == +(proof) ]]\nprintf 'EXTGLOB_READY\\n'",
        steps: [{ action: "expect_output", text: "EXTGLOB_READY" }],
      },
      checkout: root,
      rawVideoPath: join(root, "proof.webm"),
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: mediaProofCommandRunner,
    });

    assert.equal(result.status, "completed", result.output);
    assert.match(result.output, /EXTGLOB_READY/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  "terminal proof isolates tmux control variables from the target command",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-tmux-env-"));
    try {
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The target command must not inherit ClawSweeper's tmux control session.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: 'test -z "${TMUX-}" && test -z "${TMUX_PANE-}" && printf \'TMUX_ENV_CLEAN\\n\'',
          steps: [{ action: "expect_output", text: "TMUX_ENV_CLEAN" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.match(result.output, /TMUX_ENV_CLEAN/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof publishes tmux-rendered clear, erase, overwrite, cursor, and reset states",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-viewport-"));
    try {
      for (const [name, entry, expected, stale] of [
        [
          "clear",
          "printf 'STALE_BEFORE_CLEAR\\n\\033[2J\\033[HFINAL_CLEAR\\n'",
          "FINAL_CLEAR",
          "STALE_BEFORE_CLEAR",
        ],
        [
          "erase-line",
          "printf 'STALE_ERASE\\r\\033[2KFINAL_ERASE\\n'",
          "FINAL_ERASE",
          "STALE_ERASE",
        ],
        ["carriage-return", "printf 'STALE\\rFINAL\\n'", "FINAL", "STALE"],
        [
          "cursor-move",
          "printf 'STALE_CURSOR\\nKEEP\\n\\033[2A\\033[2KFINAL_CURSOR\\n'",
          "FINAL_CURSOR",
          "STALE_CURSOR",
        ],
        ["reset", "printf 'STALE_RESET\\n\\033cFINAL_RESET\\n'", "FINAL_RESET", "STALE_RESET"],
      ] as const) {
        const result = driveTerminal({
          plan: {
            status: "recommended",
            surface: "terminal",
            terminalCompletion: "exit_zero",
            reason: `The final ${name} state replaces transient output.`,
            payoff: { kind: "static_text", justification: "Text is sufficient." },
            entry,
            steps: [{ action: "expect_output", text: expected }],
          },
          checkout: root,
          rawVideoPath: join(root, `${name}.webm`),
          maxRecordingSeconds: 90,
          recordMedia: false,
          runner: mediaProofCommandRunner,
        });

        assert.equal(result.status, "completed", `${name}: ${result.output}`);
        assert.match(result.output, new RegExp(expected));
        assert.doesNotMatch(result.output, new RegExp(stale));
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof cleanup terminates a background process in the pane group",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-cleanup-"));
    const rawVideoPath = join(root, `cleanup-${process.pid}-${Date.now()}.webm`);
    const processToken = `clawsweeper-proof-child-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(
        join(root, "background.mjs"),
        [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync("background.pid", String(process.pid));',
          "setTimeout(() => process.exit(0), 10_000);",
          "setInterval(() => {}, 1_000);",
        ].join("\n"),
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command exits successfully after printing its result.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry:
            `node background.mjs ${processToken} >/dev/null 2>&1 & ` +
            "while [ ! -s background.pid ]; do sleep 0.01; done; printf 'cleanup-ready\\n'",
          steps: [{ action: "expect_output", text: "cleanup-ready" }],
        },
        checkout: root,
        rawVideoPath,
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed");
      const backgroundPid = Number.parseInt(readFileSync(join(root, "background.pid"), "utf8"), 10);
      assert.equal(Number.isSafeInteger(backgroundPid), true);
      let matches = processesContaining(processToken);
      const deadline = Date.now() + 2_000;
      while (matches.length > 0 && Date.now() < deadline) {
        execFileSync("sleep", ["0.05"]);
        matches = processesContaining(processToken);
      }
      assert.deepEqual(matches, []);
      assert.throws(() => process.kill(backgroundPid, 0), { code: "ESRCH" });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "non-recorded ready proof rejects a command that exits during the stability hold",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-ready-stability-"));
    try {
      writeFileSync(
        join(root, "short-server.mjs"),
        "console.log('READY_MARKER'); setTimeout(() => process.exit(7), 2_000);\n",
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "ready_while_running",
          reason: "The server must remain live after reporting readiness.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "node short-server.mjs",
          steps: [{ action: "expect_output", text: "READY_MARKER" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "failed");
      assert.match(result.steps[0]?.detail ?? "", /exit status 7/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof stays pinned to its original pane after another window is selected",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-window-"));
    const rawVideoPath = join(root, "window-proof.webm");
    const processToken = `clawsweeper-proof-window-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(
        join(root, "linger.mjs"),
        [
          'import { writeFileSync } from "node:fs";',
          "const [pidPath] = process.argv.slice(2);",
          "writeFileSync(pidPath, String(process.pid));",
          "setInterval(() => {}, 1_000);",
        ].join("\n"),
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command changes the selected tmux window before producing its result.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: [
            "terminal_session=$(tmux display-message -p '#S')",
            "printf '%s' \"$terminal_session\" > terminal.session",
            `node linger.mjs original.pid ${processToken} >/dev/null 2>&1 &`,
            "while [ ! -s original.pid ]; do sleep 0.01; done",
            `tmux new-window -d -t "$terminal_session:" -n diversion "node linger.mjs diversion.pid ${processToken}"`,
            "while [ ! -s diversion.pid ]; do sleep 0.01; done",
            `tmux select-window -t "$terminal_session:diversion"`,
            "printf 'original-pane-ready\\n'",
          ].join("\n"),
          steps: [{ action: "expect_output", text: "original-pane-ready" }],
        },
        checkout: root,
        rawVideoPath,
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.equal(result.steps[0]?.satisfied, true);
      assert.match(result.output, /original-pane-ready/);

      const terminalSession = readFileSync(join(root, "terminal.session"), "utf8");
      const originalPid = Number.parseInt(readFileSync(join(root, "original.pid"), "utf8"), 10);
      const diversionPid = Number.parseInt(readFileSync(join(root, "diversion.pid"), "utf8"), 10);
      let matches = processesContaining(processToken);
      const deadline = Date.now() + 2_000;
      while (matches.length > 0 && Date.now() < deadline) {
        execFileSync("sleep", ["0.05"]);
        matches = processesContaining(processToken);
      }
      assert.deepEqual(matches, []);
      assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(diversionPid, 0), { code: "ESRCH" });
      assert.throws(() =>
        execFileSync("tmux", ["has-session", "-t", terminalSession], { stdio: "ignore" }),
      );
      assert.deepEqual(
        readdirSync(root).filter((name) => name.startsWith("window-proof.webm.")),
        [],
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("terminal proof supervises consecutive commands in the same pane", { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-consecutive-"));
  try {
    const result = driveTerminal({
      plan: {
        status: "recommended",
        surface: "terminal",
        terminalCompletion: "exit_zero",
        reason: "Each proof command must complete and preserve its own output.",
        payoff: { kind: "static_text", justification: "Text is sufficient." },
        entry: "printf 'FIRST_OK\\n'",
        steps: [
          { action: "expect_output", text: "FIRST_OK" },
          { action: "run", command: "printf 'SECOND_OK\\n'" },
          { action: "expect_output", text: "SECOND_OK" },
        ],
      },
      checkout: root,
      rawVideoPath: join(root, "proof.webm"),
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: mediaProofCommandRunner,
    });

    assert.equal(result.status, "completed", result.output);
    assert.deepEqual(
      result.steps.map((step) => step.status),
      ["completed", "completed", "completed"],
    );
    assert.match(result.output, /SECOND_OK/);
    assert.doesNotMatch(result.output, /FIRST_OK/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test(
  "terminal proof does not satisfy a command from the previous pane state",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-stale-pane-"));
    try {
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "Each command must satisfy assertions from its own rendered output.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "printf 'STALE_FROM_FIRST\\n'",
          steps: [
            { action: "run", command: "printf 'SECOND_ONLY\\n'" },
            { action: "expect_output", text: "STALE_FROM_FIRST" },
          ],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "partial", result.output);
      assert.equal(result.steps[1]?.satisfied, false);
      assert.match(result.output, /SECOND_ONLY/);
      assert.match(result.output, /before expected output appeared: "STALE_FROM_FIRST"/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function processesContaining(fragment: string): string[] {
  return execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(fragment));
}
