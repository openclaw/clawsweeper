import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

import { REVIEW_SECTIONS } from "../dist/clawsweeper-policy.js";
import type { LiveProofPlan, MediaProofCommandRunner } from "../dist/clawsweeper-types.js";
import type { RepositoryProfile } from "../dist/repository-profiles.js";
import {
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
import { executeLiveProof } from "../dist/live-proof/execute.js";
import { parseLiveProofManifest } from "../dist/live-proof/manifest.js";
import {
  captureLiveProofCanonicalBaseline,
  isCanonicalPublicationConflict,
  publishLiveProofAttachment,
} from "../dist/live-proof/publication.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function recommendedPlan(surface: "browser" | "terminal" = "browser"): LiveProofPlan {
  return surface === "browser"
    ? {
        status: "recommended",
        surface,
        reason: "The changed setting is visible.",
        entry: "/settings",
        steps: [{ action: "expect_text", text: "Saved" }],
      }
    : {
        status: "recommended",
        surface,
        reason: "The changed CLI output is visible.",
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
    promptNote: "Example profile.",
    applyCloseRules: {},
    liveTest: {
      enabled,
      surfaceDefault: "browser",
      setup: [],
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
        entry: "",
        steps: [],
      },
      pull: { kind: "pull_request", state: "open", headSha: HEAD },
      expected: /status is not_applicable/,
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

test("Playwright steps scroll targets into view, settle, and hold a six-second minimum", () => {
  const script = generatePlaywrightScript([
    { action: "click", target: "#save" },
    { action: "wait_for", target: "#result" },
    { action: "expect_text", text: "Saved" },
  ]);
  assert.equal(script.match(/scrollIntoViewIfNeeded\(\)/g)?.length, 3);
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

test("live-proof skips a failed drive without producing a manifest", async () => {
  const fixture = executeFixture("failed");
  mkdirSync(dirname(fixture.manifestPath), { recursive: true });
  writeFileSync(fixture.manifestPath, "stale manifest", "utf8");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.match(fixture.logs.join("\n"), /skip: demonstration did not complete/);
  assert.equal(
    fixture.commands.some((command) => command.startsWith("ffmpeg ")),
    false,
  );
});

test("live-proof skips when every satisfied expectation was present at start", async () => {
  const fixture = executeFixture("present-at-start");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.match(fixture.logs.join("\n"), /skip: plan verified nothing that changed/);
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

test("live-proof skips a plan with no expectation steps", async () => {
  const fixture = executeFixture("no-expectation");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.match(fixture.logs.join("\n"), /skip: plan verified nothing that changed/);
});

test("live-proof skips a demonstrated recording shorter than three seconds", async () => {
  const fixture = executeFixture("too-short");
  await fixture.run();
  assert.equal(existsSync(fixture.manifestPath), false);
  assert.match(fixture.logs.join("\n"), /skip: recording is shorter than 3 seconds/);
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
  assert.match(publishedBody, /### Live Proof/);
  assert.match(publishedBody, /<!-- clawsweeper-review item=42 -->/);
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

test("live-proof detach syncs the marker-backed comment only after publication", async () => {
  const fixture = recordedAttachmentFixture();
  const calls: string[] = [];
  const result = await publishLiveProofAttachment({
    hydrateRecord: () => calls.push("hydrate"),
    attachRecord: async () => {
      calls.push("detach");
      return detachLiveProof(
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
    },
    publishRecord: () => calls.push("publish"),
    syncComment: () => {
      calls.push("comment");
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
    },
    isCanonicalConflict: isCanonicalPublicationConflict,
  });

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

test("live-proof publication retries from a lagged hydration and publishes the fresh canonical baseline", async () => {
  const calls: string[] = [];
  const hydratedRevisions = ["revision-5", "revision-6"];
  let hydratedRevision = "";
  let publications = 0;
  let commentUpserts = 0;
  const result = await publishLiveProofAttachment({
    hydrateRecord: (attempt) => {
      hydratedRevision = hydratedRevisions[attempt - 1] ?? "";
      calls.push(`hydrate:${hydratedRevision}`);
    },
    attachRecord: async (attempt) => {
      calls.push(`attach:${attempt}`);
      return "attached";
    },
    publishRecord: (attempt) => {
      calls.push(`publish:${attempt}:${hydratedRevision}`);
      publications += 1;
      if (publications === 1) throw canonicalPublicationConflict();
    },
    syncComment: () => {
      calls.push("comment");
      commentUpserts += 1;
    },
    isCanonicalConflict: isCanonicalPublicationConflict,
    delay: async () => undefined,
    log: () => undefined,
  });

  assert.equal(result, "attached");
  assert.deepEqual(calls, [
    "hydrate:revision-5",
    "attach:1",
    "publish:1:revision-5",
    "hydrate:revision-6",
    "attach:2",
    "publish:2:revision-6",
    "comment",
  ]);
  assert.equal(commentUpserts, 1);
});

test("live-proof publication captures each hydrated canonical revision in a fresh baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-baseline-"));
  const recordPath = join(root, "records", "openclaw-openclaw", "items", "42.md");
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, "canonical revision 5\n");

  const first = captureLiveProofCanonicalBaseline({
    root,
    repositorySlug: "openclaw-openclaw",
    itemNumber: 42,
    attempt: 1,
  });
  writeFileSync(recordPath, "canonical revision 6\n");
  const second = captureLiveProofCanonicalBaseline({
    root,
    repositorySlug: "openclaw-openclaw",
    itemNumber: 42,
    attempt: 2,
  });

  assert.notEqual(first, second);
  assert.equal(
    readFileSync(join(first, "records", "openclaw-openclaw", "items", "42.md"), "utf8"),
    "canonical revision 5\n",
  );
  assert.equal(
    readFileSync(join(second, "records", "openclaw-openclaw", "items", "42.md"), "utf8"),
    "canonical revision 6\n",
  );
});

test("live-proof publication fails loudly after three canonical conflicts", async () => {
  let hydrations = 0;
  let attachments = 0;
  let publications = 0;
  let commentUpserts = 0;

  await assert.rejects(
    publishLiveProofAttachment({
      hydrateRecord: () => {
        hydrations += 1;
      },
      attachRecord: async () => {
        attachments += 1;
        return "attached";
      },
      publishRecord: () => {
        publications += 1;
        throw canonicalPublicationConflict();
      },
      syncComment: () => {
        commentUpserts += 1;
      },
      isCanonicalConflict: isCanonicalPublicationConflict,
      delay: async () => undefined,
      log: () => undefined,
    }),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      String(error.stderr).includes("Canonical publication conflicted for all 1 item(s)"),
  );
  assert.equal(hydrations, 3);
  assert.equal(attachments, 3);
  assert.equal(publications, 3);
  assert.equal(commentUpserts, 0);
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

test("live-proof workflow keeps execute secretless and attach trusted", () => {
  const source = readFileSync(".github/workflows/live-proof.yml", "utf8");
  const workflow = YAML.parse(source) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    env: Record<string, string>;
    jobs: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["repo", "item"]);
  assert.equal(workflow.env.CLAWSWEEPER_APP_CLIENT_ID, "Iv23liOECG0slfuhz093");
  assert.deepEqual(workflow.jobs.execute?.permissions, {});
  assert.doesNotMatch(JSON.stringify(workflow.jobs.execute), /secrets\./);
  assert.match(source, /uses: \.\/\.github\/actions\/create-target-write-token/);
  assert.match(source, /CLAWSWEEPER_LIVE_PROOF_S3_ENDPOINT: \$\{\{ secrets\./);
  assert.match(source, /setsid timeout --kill-after=30s 1500s/);
  assert.match(source, /apt-get install --yes ffmpeg tmux x11-utils xfonts-base xvfb xterm/);
  assert.match(source, /--record \.\.\/live-proof-report\.md/);
  assert.doesNotMatch(source, /--plan \.\.\/live-proof/);
  assert.match(source, /live-proof-attach-publish/);
  assert.match(source, /--repo-slug "\$\{\{ needs\.execute\.outputs\.repo_slug \}\}"/);

  const dispatchActionSource = readFileSync(
    ".github/actions/dispatch-live-proofs/action.yml",
    "utf8",
  );
  const dispatchAction = YAML.parse(dispatchActionSource) as {
    inputs: Record<string, { required?: boolean }>;
    runs: {
      steps: Array<{
        id?: string;
        if?: string;
        uses?: string;
        with?: Record<string, string>;
        run?: string;
      }>;
    };
  };
  assert.deepEqual(Object.keys(dispatchAction.inputs), [
    "target-repo",
    "item-numbers",
    "records-root",
    "client-id",
    "private-key",
  ]);
  assert.ok(Object.values(dispatchAction.inputs).every((input) => input.required === true));
  const candidateStep = dispatchAction.runs.steps.find((step) => step.id === "candidates");
  const tokenStep = dispatchAction.runs.steps.find((step) => step.id === "dispatch-token");
  const dispatchStep = dispatchAction.runs.steps.at(-1);
  assert.match(candidateStep?.run ?? "", /\[ ! -d "\$RECORDS_ROOT" \]/);
  assert.match(candidateStep?.run ?? "", /\[ -z "\$\{ITEM_NUMBERS\/\//);
  assert.match(
    candidateStep?.run ?? "",
    /\[ ! -f dist\/repair\/live-proof-dispatch-candidates\.js \]/,
  );
  assert.match(candidateStep?.run ?? "", /pnpm run --silent repair:live-proof-candidates/);
  assert.equal(tokenStep?.uses, "./.github/actions/create-target-write-token");
  assert.equal(tokenStep?.with?.owner, "openclaw");
  assert.equal(tokenStep?.with?.repository, "clawsweeper");
  assert.match(dispatchStep?.run ?? "", /event_type: "clawsweeper_live_proof"/);
  assert.match(dispatchStep?.run ?? "", /repos\/\$GITHUB_REPOSITORY\/dispatches/);
  const noOpFixture = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-dispatch-noop-"));
  const runCandidateStep = (recordsRoot: string, itemNumbers: string, outputName: string) => {
    const outputPath = join(noOpFixture, outputName);
    const result = spawnSync("bash", ["-c", candidateStep?.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        ITEM_NUMBERS: itemNumbers,
        RECORDS_ROOT: recordsRoot,
        RUNNER_TEMP: noOpFixture,
        TARGET_REPO: "openclaw/clawsweeper",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(outputPath, "utf8"), /available=false/);
  };
  runCandidateStep(join(noOpFixture, "missing-records"), "42", "missing-root-output.txt");
  const emptyRecords = join(noOpFixture, "records");
  mkdirSync(emptyRecords);
  runCandidateStep(emptyRecords, " , ", "missing-items-output.txt");

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
  const directSteps = sweepWorkflow.jobs["event-review-apply"]?.steps ?? [];
  const directDeliveryIndex = directSteps.findIndex(
    (step) => step.name === "Deliver GitHub effects and prepare direct state mutation",
  );
  const directDispatchIndex = directSteps.findIndex(
    (step) => step.name === "Dispatch recommended live proofs",
  );
  const directDispatch = directSteps[directDispatchIndex];
  assert.ok(directDeliveryIndex >= 0);
  assert.ok(directDispatchIndex > directDeliveryIndex);
  assert.equal(directDispatch?.uses, "./.github/actions/dispatch-live-proofs");
  assert.match(
    directDispatch?.if ?? "",
    /prepare-direct-exact-review-publication\.outcome == 'success'/,
  );
  assert.equal(directDispatch?.with?.["target-repo"], "${{ steps.target.outputs.target_repo }}");
  assert.equal(directDispatch?.with?.["item-numbers"], "${{ steps.target.outputs.item_number }}");

  const fallbackSteps = sweepWorkflow.jobs["event-review-publish"]?.steps ?? [];
  const fallbackPublicationIndex = fallbackSteps.findIndex(
    (step) => step.name === "Publish event result and apply safe close",
  );
  const fallbackDispatchIndex = fallbackSteps.findIndex(
    (step) => step.uses === "./.github/actions/dispatch-live-proofs",
  );
  assert.ok(fallbackPublicationIndex >= 0);
  assert.ok(fallbackDispatchIndex > fallbackPublicationIndex);
  assert.match(fallbackSteps[fallbackDispatchIndex]?.if ?? "", /remote_tuple_verified/);

  const scheduledSteps = sweepWorkflow.jobs.publish?.steps ?? [];
  const scheduledPublicationIndex = scheduledSteps.findIndex(
    (step) => step.id === "commit-review-records",
  );
  const scheduledDispatchIndex = scheduledSteps.findIndex(
    (step) => step.uses === "./.github/actions/dispatch-live-proofs",
  );
  assert.ok(scheduledPublicationIndex >= 0);
  assert.ok(scheduledDispatchIndex > scheduledPublicationIndex);
  assert.equal(
    scheduledSteps[scheduledDispatchIndex]?.with?.["item-numbers"],
    "${{ steps.published-review-items.outputs.item_numbers }}",
  );
  assert.equal(
    Object.values(sweepWorkflow.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.uses === "./.github/actions/dispatch-live-proofs").length,
    3,
  );

  const batchWorkflow = YAML.parse(
    readFileSync(".github/workflows/exact-review-batch-publish.yml", "utf8"),
  ) as {
    jobs: Record<
      string,
      {
        needs?: string;
        strategy?: { matrix?: string };
        steps: Array<{ id?: string; uses?: string; run?: string; with?: Record<string, string> }>;
      }
    >;
  };
  const matrixStep = batchWorkflow.jobs.publish?.steps.find(
    (step) => step.id === "live-proof-dispatch-matrix",
  );
  assert.match(matrixStep?.run ?? "", /\.outcome == "accepted" or \.outcome == "deduped"/);
  assert.match(matrixStep?.run ?? "", /group_by\(\.target_repo\)/);
  const matrixFixture = mkdtempSync(join(tmpdir(), "clawsweeper-live-proof-matrix-"));
  const matrixOutput = join(matrixFixture, "github-output.txt");
  writeFileSync(
    join(matrixFixture, "state-receipt.json"),
    JSON.stringify({
      outcomes: [
        { outcome: "accepted", canonicalTargetKey: "openclaw/second#10" },
        { outcome: "retryable", canonicalTargetKey: "openclaw/ignored#3" },
        { outcome: "deduped", canonicalTargetKey: "openclaw/second#2" },
        { outcome: "accepted", canonicalTargetKey: "openclaw/first#7" },
      ],
    }),
  );
  const matrixResult = spawnSync("bash", ["-c", matrixStep?.run ?? ""], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXACT_REVIEW_BATCH_MANIFEST: join(matrixFixture, "manifest.json"),
      GITHUB_OUTPUT: matrixOutput,
    },
  });
  assert.equal(matrixResult.status, 0, matrixResult.stderr);
  assert.deepEqual(JSON.parse(readFileSync(matrixOutput, "utf8").trim().slice("matrix=".length)), {
    include: [
      {
        target_repo: "openclaw/first",
        target_slug: "openclaw-first",
        item_numbers: "7",
      },
      {
        target_repo: "openclaw/second",
        target_slug: "openclaw-second",
        item_numbers: "2,10",
      },
    ],
  });
  const batchDispatchJob = batchWorkflow.jobs["dispatch-live-proofs"];
  assert.equal(batchDispatchJob?.needs, "publish");
  assert.equal(
    batchDispatchJob?.strategy?.matrix,
    "${{ fromJSON(needs.publish.outputs.live_proof_matrix) }}",
  );
  const batchDispatch = batchDispatchJob?.steps.find(
    (step) => step.uses === "./.github/actions/dispatch-live-proofs",
  );
  assert.equal(batchDispatch?.with?.["target-repo"], "${{ matrix.target_repo }}");
  assert.equal(batchDispatch?.with?.["item-numbers"], "${{ matrix.item_numbers }}");

  const candidateSource = readFileSync("src/repair/live-proof-dispatch-candidates.ts", "utf8");
  assert.match(candidateSource, /profile\.liveTest\?\.enabled/);
  assert.match(candidateSource, /plan\.status === "recommended"/);
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
      `Review comment\n\n### Live Proof\n\n${sectionValue(markdown, REVIEW_SECTIONS.liveProof)}`,
    markedReviewCommentBody: (number: number, body: string) =>
      `${body}\n\n<!-- clawsweeper-review item=${number} -->`,
    upsertReviewComment: options.upsertReviewComment,
    log: (message: string) => options.logs.push(message),
  };
}

function canonicalPublicationConflict(): Error & { stderr: string } {
  return Object.assign(new Error("publish-main failed"), {
    stderr: "Canonical publication conflicted for all 1 item(s); see per-item warnings above",
  });
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
