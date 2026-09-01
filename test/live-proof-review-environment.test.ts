import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import type { LiveProofPlan, MediaProofCommandRunner } from "../dist/clawsweeper-types.js";
import { mediaProofCommandRunner } from "../dist/clawsweeper-media-proof.js";
import { driveTerminal } from "../dist/live-proof/drivers.js";
import {
  executeReviewLiveProofs,
  inspectReviewLiveProofs,
  reviewLiveProofGoEnvironment,
} from "../dist/live-proof/review-artifacts.js";
import { sanitizedLiveProofEnvironment } from "../dist/live-proof/environment.js";
import { parseLiveVerificationResult } from "../dist/live-proof/verification.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";

const softWrapMarker = "prepares pruned esm output with an actual peerDependencies host";
// End peerD at the driver's existing 160-column boundary.
const softWrapLine = " ".repeat(160 - softWrapMarker.indexOf("ependencies")) + softWrapMarker;

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
          entry: "CI=1 pnpm --reporter=append-only run proof",
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
  "terminal proof preserves inherited PTY descriptors in a detached Node child",
  { timeout: 30_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-detached-stdio-"));
    const processToken = `clawsweeper-detached-stdio-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(
        join(root, "detached-stdio.mjs"),
        [
          'import assert from "node:assert/strict";',
          'import { spawn } from "node:child_process";',
          'import { fstatSync, writeFileSync } from "node:fs";',
          'if (process.argv[3] === "child") {',
          "  for (const fd of [0, 1, 2]) assert.equal(fstatSync(fd).isCharacterDevice(), true);",
          "  const terminals = [process.stdin.isTTY, process.stdout.isTTY, process.stderr.isTTY];",
          "  assert.deepEqual(terminals, [true, true, true]);",
          '  console.log("DETACHED_CHILD_TTY", ...terminals);',
          '  console.error("DETACHED_CHILD_STDERR");',
          "} else {",
          '  writeFileSync("parent.pid", String(process.pid));',
          '  const child = spawn(process.execPath, [import.meta.filename, process.argv[2], "child"], { detached: true, stdio: "inherit" });',
          '  if (child.pid) writeFileSync("child.pid", String(child.pid));',
          '  child.on("error", (error) => { throw error; });',
          '  child.on("exit", (code, signal) => {',
          '    writeFileSync("child-exit.json", JSON.stringify({ code, signal }));',
          "    if (signal) process.kill(process.pid, signal);",
          "    else process.exitCode = code ?? 1;",
          "  });",
          "}",
        ].join("\n"),
      );
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "A detached Node child must retain usable inherited terminal descriptors.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: `node detached-stdio.mjs ${processToken}`,
          steps: [
            { action: "expect_output", text: "DETACHED_CHILD_TTY true true true" },
            { action: "expect_output", text: "DETACHED_CHILD_STDERR" },
          ],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.equal(
        result.steps.every((step) => step.satisfied === true),
        true,
      );
      assert.match(result.output, /DETACHED_CHILD_TTY true true true/);
      assert.match(result.output, /DETACHED_CHILD_STDERR/);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "child-exit.json"), "utf8")), {
        code: 0,
        signal: null,
      });
      assert.deepEqual(processesContaining(processToken), []);
      assert.deepEqual(
        readdirSync(root).filter((name) => name.startsWith("proof.webm.")),
        [],
      );
    } finally {
      for (const name of ["child.pid", "parent.pid"]) {
        const path = join(root, name);
        if (!existsSync(path)) continue;
        const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
        if (processesContaining(processToken).some((line) => line.startsWith(`${pid} `))) {
          killProcess(pid);
        }
      }
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
          entry:
            'test -z "${TMUX-}" && test -z "${TMUX_PANE-}" && test -z "${TMUX_TMPDIR-}" && printf \'TMUX_ENV_CLEAN\\n\'',
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
  "terminal proof cleanup terminates signal-resistant descendants in distinct process groups",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-cleanup-"));
    const processToken = `clawsweeper-proof-child-${process.pid}-${Date.now()}`;
    const childCount = 16;
    try {
      writeFileSync(
        join(root, "background.mjs"),
        [
          'import { writeFileSync } from "node:fs";',
          "const [pidPath] = process.argv.slice(2);",
          "writeFileSync(pidPath, String(process.pid));",
          'process.on("SIGHUP", () => {});',
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1_000);",
        ].join("\n"),
      );
      for (const terminalCompletion of ["exit_zero", "ready_while_running"] as const) {
        const pidPath = `${terminalCompletion}.pid`;
        const shellGroupPath = `${terminalCompletion}.shell-pgid`;
        const childGroupPath = `${terminalCompletion}.child-pgid`;
        const entry = [
          "set -m",
          `/bin/ps -o pgid= -p "$$" | /usr/bin/tr -d '[:space:]' >${shellGroupPath}`,
          `for ((index = 0; index < ${childCount}; index += 1)); do`,
          `  node background.mjs ${pidPath}.$index ${processToken} >/dev/null 2>&1 &`,
          "done",
          `for ((index = 0; index < ${childCount}; index += 1)); do`,
          `  while [ ! -s ${pidPath}.$index ]; do sleep 0.01; done`,
          `  child=$(<${pidPath}.$index)`,
          `  /bin/ps -o pgid= -p "$child" >>${childGroupPath}`,
          "done",
          `printf 'cleanup-ready\\n%s\\n' '${softWrapLine}'`,
          ...(terminalCompletion === "ready_while_running" ? ["while :; do sleep 1; done"] : []),
        ].join("\n");
        const result = driveTerminal({
          plan: {
            status: "recommended",
            surface: "terminal",
            terminalCompletion,
            reason:
              terminalCompletion === "exit_zero"
                ? "The command exits successfully after printing its result."
                : "The command remains live after printing its readiness result.",
            payoff: { kind: "static_text", justification: "Text is sufficient." },
            entry,
            steps: [{ action: "expect_output", text: softWrapMarker }],
          },
          checkout: root,
          rawVideoPath: join(root, `${terminalCompletion}.webm`),
          maxRecordingSeconds: 90,
          recordMedia: false,
          runner: mediaProofCommandRunner,
        });

        assert.equal(result.status, "completed", `${terminalCompletion}: ${result.output}`);
        assert.equal(result.steps[0]?.satisfied, true);
        assert.match(result.output, /peerD\nependencies host/);
        const backgroundPids = Array.from({ length: childCount }, (_, index) =>
          Number.parseInt(readFileSync(join(root, `${pidPath}.${index}`), "utf8"), 10),
        );
        const shellGroup = readFileSync(join(root, shellGroupPath), "utf8").trim();
        const childGroups = readFileSync(join(root, childGroupPath), "utf8").trim().split(/\s+/);
        assert.equal(new Set(childGroups).size, childCount);
        assert.equal(childGroups.includes(shellGroup), false, terminalCompletion);
        let matches = processesContaining(processToken);
        const deadline = Date.now() + 2_000;
        while (matches.length > 0 && Date.now() < deadline) {
          execFileSync("sleep", ["0.05"]);
          matches = processesContaining(processToken);
        }
        assert.deepEqual(matches, []);
        for (const pid of backgroundPids) {
          assert.equal(Number.isSafeInteger(pid), true);
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        }
      }
    } finally {
      for (const processLine of processesContaining(processToken)) {
        killProcess(Number.parseInt(processLine, 10));
      }
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof cleanup survives target-triggered pane wrapper death",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-wrapper-death-"));
    let backgroundPid: number | undefined;
    let processToken = "";
    const pidPath = "wrapper-death.pid";
    const releasePath = join(root, "release-wrapper-death");
    try {
      const shellGroupPath = "wrapper-death.shell-pgid";
      const childGroupPath = "wrapper-death.child-pgid";
      processToken = `clawsweeper-proof-wrapper-death-${process.pid}-${Date.now()}`;
      writeFileSync(
        join(root, "background.mjs"),
        [
          'import { writeFileSync } from "node:fs";',
          "const [pidPath] = process.argv.slice(2);",
          'process.on("SIGHUP", () => {});',
          'process.on("SIGTERM", () => {});',
          "writeFileSync(pidPath, String(process.pid));",
          "setInterval(() => {}, 1_000);",
        ].join("\n"),
      );
      const entry = [
        "set -m",
        `node background.mjs ${pidPath} ${processToken} >/dev/null 2>&1 &`,
        "child=$!",
        `while [ ! -s ${pidPath} ]; do sleep 0.01; done`,
        `/bin/ps -o pgid= -p "$$" | /usr/bin/tr -d '[:space:]' >${shellGroupPath}`,
        `/bin/ps -o pgid= -p "$child" | /usr/bin/tr -d '[:space:]' >${childGroupPath}`,
        'pane_wrapper=$(/bin/ps -o ppid= -p "$PPID" | /usr/bin/tr -d "[:space:]")',
        'case "$pane_wrapper" in ""|*[!0-9]*) exit 125 ;; esac',
        'printf "%s\\n" "$pane_wrapper" >wrapper-death.wrapper-pid',
        "printf 'wrapper-death-ready\\n'",
        "while [ ! -e release-wrapper-death ]; do sleep 0.01; done",
        '/bin/kill -KILL "$pane_wrapper"',
        "while :; do sleep 1; done",
      ].join("\n");
      let observedDeath = false;
      const runner: MediaProofCommandRunner = (command, args, options = {}) => {
        const result = mediaProofCommandRunner(command, args, options);
        if (
          !observedDeath &&
          command === "tmux" &&
          args[0] === "capture-pane" &&
          String(result.stdout ?? "").includes("wrapper-death-ready")
        ) {
          const pane = args[args.indexOf("-t") + 1]!;
          const stateArgs = [
            "display-message",
            "-p",
            "-t",
            pane,
            "#{pane_pid}|#{pane_dead_signal}",
          ];
          const before = mediaProofCommandRunner("tmux", stateArgs, options);
          assert.equal(before.status, 0, String(before.stderr));
          const wrapperPid = readFileSync(join(root, "wrapper-death.wrapper-pid"), "utf8").trim();
          assert.equal(String(before.stdout).trim(), `${wrapperPid}|`);
          writeFileSync(releasePath, "release\n");
          const deadline = Date.now() + 5_000;
          do {
            const state = mediaProofCommandRunner("tmux", stateArgs, options);
            assert.equal(state.status, 0, String(state.stderr));
            // tmux builds can report numeric signals or platform signal names.
            const paneStatus = String(state.stdout).trim().toUpperCase();
            if (paneStatus === `${wrapperPid}|KILL` || paneStatus === `${wrapperPid}|9`) {
              observedDeath = true;
              break;
            }
            execFileSync("sleep", ["0.01"]);
          } while (Date.now() < deadline);
          assert.equal(
            observedDeath,
            true,
            "target must kill the original pane before finalization",
          );
        }
        return result;
      };
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "ready_while_running",
          reason: "The command remains live after reporting readiness.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry,
          steps: [{ action: "expect_output", text: "wrapper-death-ready" }],
        },
        checkout: root,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner,
      });

      assert.equal(observedDeath, true, result.output);
      assert.equal(result.status, "failed", result.output);
      assert.match(result.output, /terminated by a signal with exit status 137/);
      assert.doesNotMatch(result.output, /cleanup failure/);
      assert.doesNotMatch(result.output, /terminal capture helper/);
      backgroundPid = Number.parseInt(readFileSync(join(root, pidPath), "utf8"), 10);
      assert.notEqual(
        readFileSync(join(root, childGroupPath), "utf8"),
        readFileSync(join(root, shellGroupPath), "utf8"),
        "wrapper-death fixture did not create a distinct child process group",
      );
      let matches = processesContaining(processToken);
      const deadline = Date.now() + 2_000;
      while (matches.length > 0 && Date.now() < deadline) {
        execFileSync("sleep", ["0.05"]);
        matches = processesContaining(processToken);
      }
      assert.deepEqual(matches, []);
      assert.throws(() => process.kill(backgroundPid, 0), { code: "ESRCH" });
    } finally {
      if (backgroundPid === undefined && existsSync(join(root, pidPath))) {
        backgroundPid = Number.parseInt(readFileSync(join(root, pidPath), "utf8"), 10);
      }
      if (
        Number.isSafeInteger(backgroundPid) &&
        processesContaining(processToken).some((line) => line.startsWith(`${backgroundPid} `))
      ) {
        killProcess(backgroundPid);
      }
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "terminal proof cleanup ignores an unrelated process holding a checkout directory descriptor",
  { timeout: 60_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-directory-fd-"));
    const helperSource = [
      'import { fstatSync } from "node:fs";',
      "if (!fstatSync(9).isDirectory()) process.exit(2);",
      "if (process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY) process.exit(2);",
      "process.stdout.write('ready\\n');",
      "setInterval(() => {}, 1_000);",
    ].join("\n");
    const checkout = root;
    const helper = (() => {
      const checkoutFd = openSync(checkout, "r");
      try {
        return spawn(process.execPath, ["--input-type=module", "--eval", helperSource], {
          detached: true,
          stdio: [
            "ignore",
            "pipe",
            "pipe",
            "ignore",
            "ignore",
            "ignore",
            "ignore",
            "ignore",
            "ignore",
            checkoutFd,
          ],
        });
      } finally {
        closeSync(checkoutFd);
      }
    })();
    try {
      const ready = new Promise<string>((resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error("directory descriptor helper did not become ready")),
          5_000,
        );
        helper.once("error", (error) => {
          clearTimeout(timeout);
          rejectReady(error);
        });
        helper.once("exit", (code, signal) => {
          clearTimeout(timeout);
          rejectReady(
            new Error(
              `directory descriptor helper exited before readiness: code=${String(code)} signal=${String(signal)}`,
            ),
          );
        });
        helper.stdout.once("data", (chunk) => {
          clearTimeout(timeout);
          resolveReady(String(chunk));
        });
      });
      assert.equal(await ready, "ready\n");
      const helperPid = helper.pid;
      assert.ok(helperPid);

      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The command prints a deterministic result.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: "printf 'directory-fd-ready\\n'",
          steps: [{ action: "expect_output", text: "directory-fd-ready" }],
        },
        checkout,
        rawVideoPath: join(root, "proof.webm"),
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner: mediaProofCommandRunner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.doesNotThrow(() => process.kill(helperPid, 0));
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) {
        const exited = once(helper, "exit");
        helper.kill("SIGKILL");
        await exited;
      }
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
    let terminalSession = "";
    let privateTmuxEnvironment: NodeJS.ProcessEnv | undefined;
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
      let diversionCreated = false;
      const runner: MediaProofCommandRunner = (command, args, options = {}) => {
        const result = mediaProofCommandRunner(command, args, options);
        if (
          !diversionCreated &&
          command === "tmux" &&
          args[0] === "capture-pane" &&
          String(result.stdout ?? "").includes("original-pane-ready")
        ) {
          const target = String(args[args.indexOf("-t") + 1] ?? "");
          terminalSession = target.slice(0, target.indexOf(":"));
          privateTmuxEnvironment = { ...options.env };
          assert.ok(terminalSession);
          assert.ok(privateTmuxEnvironment.TMUX_TMPDIR);
          const create = mediaProofCommandRunner(
            "tmux",
            [
              "new-window",
              "-d",
              "-t",
              `${terminalSession}:`,
              "-n",
              "diversion",
              "-c",
              root,
              `node linger.mjs diversion.pid ${processToken}`,
            ],
            { cwd: root, env: privateTmuxEnvironment },
          );
          assert.equal(create.status, 0, String(create.stderr ?? create.error ?? ""));
          const deadline = Date.now() + 2_000;
          while (!existsSync(join(root, "diversion.pid")) && Date.now() < deadline) {
            execFileSync("sleep", ["0.05"]);
          }
          assert.equal(existsSync(join(root, "diversion.pid")), true);
          const select = mediaProofCommandRunner(
            "tmux",
            ["select-window", "-t", `${terminalSession}:diversion`],
            { cwd: root, env: privateTmuxEnvironment },
          );
          assert.equal(select.status, 0, String(select.stderr ?? select.error ?? ""));
          diversionCreated = true;
        }
        return result;
      };
      const result = driveTerminal({
        plan: {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "The controller changes the selected tmux window after observing target output.",
          payoff: { kind: "static_text", justification: "Text is sufficient." },
          entry: [
            `node linger.mjs original.pid ${processToken} >/dev/null 2>&1 &`,
            "while [ ! -s original.pid ]; do sleep 0.01; done",
            "printf 'original-pane-ready\\n'",
          ].join("\n"),
          steps: [{ action: "expect_output", text: "original-pane-ready" }],
        },
        checkout: root,
        rawVideoPath,
        maxRecordingSeconds: 90,
        recordMedia: false,
        runner,
      });

      assert.equal(result.status, "completed", result.output);
      assert.equal(result.steps[0]?.satisfied, true);
      assert.match(result.output, /original-pane-ready/);
      assert.equal(diversionCreated, true);

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
      assert.notEqual(
        mediaProofCommandRunner("tmux", ["has-session", "-t", terminalSession], {
          cwd: root,
          env: privateTmuxEnvironment,
        }).status,
        0,
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
    writeFileSync(join(root, "initial.sh"), `printf '%s\\n' '${softWrapLine}'\n`);
    const runner: MediaProofCommandRunner = (command, args, options = {}) => {
      if (command === "tmux" && args[0] === "capture-pane" && args.at(-1) === "-200") {
        const target = args[args.indexOf("-t") + 1]!;
        const seed = mediaProofCommandRunner(
          "tmux",
          [
            "send-keys",
            "-t",
            target,
            "source ./initial.sh; tmux wait-for -S initial-ready",
            "Enter",
          ],
          options,
        );
        assert.equal(seed.status, 0, String(seed.stderr));
        const ready = mediaProofCommandRunner("tmux", ["wait-for", "initial-ready"], {
          ...options,
          timeoutMs: 5_000,
        });
        assert.equal(ready.status, 0, String(ready.stderr));
      }
      return mediaProofCommandRunner(command, args, options);
    };
    const result = driveTerminal({
      plan: {
        status: "recommended",
        surface: "terminal",
        terminalCompletion: "exit_zero",
        reason: "Each proof command must complete and preserve its own output.",
        payoff: { kind: "static_text", justification: "Text is sufficient." },
        entry: `printf 'FIRST_OK\\n%s\\n' '${softWrapLine}'`,
        steps: [
          { action: "expect_output", text: softWrapMarker },
          { action: "expect_output", text: "FIRST_OK" },
          { action: "run", command: `printf 'SECOND_OK\\n%s\\n' '${softWrapLine}'` },
          { action: "expect_output", text: softWrapMarker },
          { action: "expect_output", text: "SECOND_OK" },
        ],
      },
      checkout: root,
      rawVideoPath: join(root, "proof.webm"),
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner,
    });

    assert.equal(result.status, "completed", result.output);
    assert.deepEqual(
      result.steps.map((step) => step.status),
      ["completed", "completed", "completed", "completed", "completed"],
    );
    for (const index of [0, 3]) {
      assert.equal(result.steps[index]?.satisfied, true);
      assert.equal(result.steps[index]?.presentAtStart, true);
    }
    assert.match(result.output, /peerD\nependencies host/);
    assert.equal(result.output.includes(softWrapMarker), false);
    assert.match(result.output, /SECOND_OK/);
    assert.doesNotMatch(result.output, /FIRST_OK/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("terminal proof preserves hard newlines and exact whitespace", { timeout: 30_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-hard-lines-"));
  const hardLineOutput = `${softWrapLine.replace("peerD", "peerD\n")}  \n`;
  try {
    const result = driveTerminal({
      plan: {
        status: "recommended",
        surface: "terminal",
        terminalCompletion: "exit_zero",
        reason: "Only soft wraps may be joined; hard boundaries and whitespace remain literal.",
        payoff: { kind: "static_text", justification: "Text is sufficient." },
        entry: `printf '\\033[32m%s\\033[0m' '${hardLineOutput}'`,
        steps: [
          { action: "expect_output", text: hardLineOutput },
          { action: "expect_output", text: softWrapMarker },
        ],
      },
      checkout: root,
      rawVideoPath: join(root, "proof.webm"),
      maxRecordingSeconds: 90,
      recordMedia: false,
      runner: mediaProofCommandRunner,
    });

    assert.equal(result.status, "partial", result.output);
    assert.equal(result.steps[0]?.satisfied, true);
    assert.equal(result.steps[1]?.satisfied, false);
    assert.match(result.steps[1]?.detail ?? "", /command exited successfully/);
    assert.match(result.output, /peerD\nependencies host/);
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
          entry: `printf '%s\\n' '${softWrapLine}'`,
          steps: [
            { action: "run", command: "printf 'SECOND_ONLY\\n'" },
            { action: "expect_output", text: softWrapMarker },
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
      assert.match(result.output, /proof-plan assertion mismatch:/);
      assert.ok(result.steps[1]?.detail.includes(JSON.stringify(softWrapMarker)));
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test(
  "Crabbox profile bootstraps a trusted synthetic Go-root/nested npm fixture through the review child",
  { timeout: 60_000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-nested-npm-"));
    const target = join(root, "target");
    const records = join(root, "records");
    const output = join(root, "output");
    const repo = "openclaw/crabbox";
    const dependency = { name: "fixture-dependency", version: "1.0.0", main: "index.cjs" };
    const worker = {
      name: "synthetic-worker",
      version: "1.0.0",
      private: true,
      scripts: {
        preinstall: "node ../hook.cjs",
        postinstall: "node ../hook.cjs",
        test: "node ../verify.cjs worker",
      },
      dependencies: { "fixture-dependency": "file:../dependency" },
    };
    const lock = JSON.stringify({
      name: worker.name,
      version: worker.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: worker.name,
          version: worker.version,
          hasInstallScript: true,
          dependencies: worker.dependencies,
        },
        "../dependency": { version: dependency.version },
        "node_modules/fixture-dependency": { resolved: "../dependency", link: true },
      },
    });
    // Only trusted synthetic code runs here, not Crabbox source, tests, or services.
    const files = {
      "go.mod": "module example.invalid/synthetic-fixture\n\ngo 1.24\n",
      ".node-version": "24\n",
      "fixture-head.txt": "reviewed fixture",
      "hook.cjs":
        "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'install-script-ran'), 'hook ran');\n",
      "dependency/package.json": JSON.stringify(dependency),
      "dependency/index.cjs": "module.exports = 'installed local dependency';\n",
      "worker/package.json": JSON.stringify(worker),
      "worker/package-lock.json": lock,
      "worker/.npmrc": "offline=true\naudit=false\nfund=false\nupdate-notifier=false\n",
      "verify.cjs": `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = __dirname;
const mode = process.argv[2];
assert.equal(fs.realpathSync(process.cwd()), path.join(root, ...(mode === 'worker' ? ['worker'] : [])));
assert.equal(fs.existsSync(path.join(root, 'package.json')), false);
assert.equal(fs.existsSync(path.join(root, 'go.mod')), true);
assert.equal(fs.readFileSync(path.join(root, 'fixture-head.txt'), 'utf8'), 'reviewed fixture');
assert.equal(fs.existsSync(path.join(root, 'install-script-ran')), false);
for (const name of ['OPENAI_API_KEY', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CLAWSWEEPER_R2_TOKEN', 'DATABASE_PASSWORD', 'PACKAGE_KEY']) {
  assert.equal(process.env[name], undefined, name);
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(fs.readFileSync(path.join(root, 'worker/package-lock.json'), 'utf8'), git('show', 'HEAD:worker/package-lock.json'));
assert.equal(require(path.join(root, 'worker/node_modules/fixture-dependency')), 'installed local dependency');
assert.equal(fs.realpathSync(process.env.HOME), path.join(path.dirname(root), 'profile'));
assert.equal(process.env.npm_config_cache, path.join(process.env.HOME, 'npm-cache'));
if (mode === 'worker') assert.equal(fs.realpathSync(process.env.INIT_CWD), root);
console.log('synthetic ' + mode + ' checks passed head=' + git('rev-parse', 'HEAD'));
process.exit(process.argv.includes('fail') ? 7 : 0);
`,
    };
    try {
      for (const [name, content] of Object.entries(files)) {
        const path = join(target, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
      mkdirSync(records);
      git(target, "init", "-b", "main");
      git(target, "config", "user.name", "ClawSweeper Test");
      git(target, "config", "user.email", "test@example.com");
      git(target, "add", ".");
      git(
        target,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "synthetic fixture",
      );
      const head = git(target, "rev-parse", "HEAD").trim();
      writeFileSync(join(target, "fixture-head.txt"), "unreviewed checkout must not execute");
      assert.equal(existsSync(join(target, "worker", "node_modules")), false);
      for (const fails of [false, true]) {
        const item = fails ? 43 : 42;
        const plan: LiveProofPlan = {
          status: "recommended",
          surface: "terminal",
          terminalCompletion: "exit_zero",
          reason: "Verify trusted synthetic nested npm setup.",
          payoff: { kind: "static_text", justification: "No recording needed." },
          entry: `node verify.cjs root && npm test --prefix worker -- ${fails ? "fail" : "pass"}`,
          steps: [{ action: "expect_output", text: "synthetic worker checks passed" }],
        };
        writeFileSync(
          join(records, `${item}.md`),
          `---\nnumber: ${item}\nrepository: ${repo}\ntype: pull_request\npull_head_sha: ${head}\n---\n\n## Live Proof\n\nStatus: recommended\n\nSurface: terminal\n\nTerminal completion: exit_zero\n\nReason: ${plan.reason}\n\nPayoff: static_text\n\nPayoff justification: ${plan.payoff.justification}\n\nEntry: ${plan.entry}\n\nSteps:\n\n- ${JSON.stringify(plan.steps[0])}\n\n## Work Candidate\n\nCandidate: none\n`,
        );
        const logs: string[] = [];
        const inspection = executeReviewLiveProofs(
          {
            checkoutPath: target,
            entrypoint: resolve("dist/clawsweeper.js"),
            itemNumbers: [item],
            outputRoot: output,
            recordsDir: records,
            repo,
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
            repositoryProfileFor,
            log: (message) => logs.push(message),
          },
        );
        const verification = parseLiveVerificationResult(
          JSON.parse(
            readFileSync(join(output, String(item), "live-verification.json"), "utf8"),
          ) as unknown,
        );
        assert.deepEqual(inspection.candidates, [item]);
        assert.equal(verification.head_sha, head);
        assert.equal(verification.repo, repo);
        assert.equal(verification.overall_pass, !fails, JSON.stringify(verification));
        assert.equal(verification.drive_status, fails ? "failed" : "completed");
        assert.ok(
          verification.output.includes(`synthetic root checks passed head=${head}`),
          verification.output,
        );
        assert.ok(
          verification.output.includes(`synthetic worker checks passed head=${head}`),
          verification.output,
        );
        if (fails) assert.match(verification.failure?.reason ?? "", /failed with exit status 7:/);
        assert.equal(existsSync(join(output, String(item), "live-proof-manifest.json")), false);
        assert.match(logs.join("\n"), /execution=unsandboxed credentials=0/);
        assert.equal(
          (JSON.stringify(verification) + logs.join("\n")).includes("must-not-cross"),
          false,
        );
        console.log(`[live-proof synthetic nested npm] ${JSON.stringify(verification)}`);
      }
      assert.equal(existsSync(join(target, "worker", "node_modules")), false);
      assert.equal(readFileSync(join(target, "worker", "package-lock.json"), "utf8"), lock);
      assert.equal(
        readFileSync(join(target, "fixture-head.txt"), "utf8"),
        "unreviewed checkout must not execute",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function processesContaining(fragment: string): string[] {
  // Filter before capture so unrelated long command lines cannot overflow the test buffer.
  const pattern = fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const result = spawnSync("pgrep", ["-fl", pattern], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
