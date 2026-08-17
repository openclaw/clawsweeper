import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";

import { REVIEW_SECTIONS } from "../dist/clawsweeper-policy.js";
import type { LiveProofPlan, MediaProofCommandRunner } from "../dist/clawsweeper-types.js";
import type { RepositoryProfile } from "../dist/repository-profiles.js";
import { attachLiveProof } from "../dist/live-proof/attach.js";
import { generatePlaywrightScript, terminalCommandPlan } from "../dist/live-proof/drivers.js";
import { executeLiveProof } from "../dist/live-proof/execute.js";
import { parseLiveProofManifest } from "../dist/live-proof/manifest.js";

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

test("terminal driver composes tmux, xvfb-run, and bounded ffmpeg x11grab", () => {
  const commands = terminalCommandPlan({
    sessionPrefix: "proof",
    entry: "pnpm cli --help",
    maxRecordingSeconds: 90,
    rawVideoPath: "/tmp/live-proof.raw.webm",
  });
  assert.deepEqual(commands[0], {
    command: "tmux",
    args: ["new-session", "-d", "-s", "proof-terminal", "-x", "160", "-y", "50"],
  });
  assert.deepEqual(commands[1]?.args.slice(4, 8), [
    "xvfb-run",
    "--server-num=99",
    "--server-args=-screen 0 1280x800x24",
    "xterm",
  ]);
  assert.deepEqual(commands[2], { command: "sleep", args: ["1"] });
  assert.deepEqual(commands[3]?.args.slice(4, 13), [
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
  assert.deepEqual(commands.at(-2)?.args.slice(-2), ["--", "pnpm cli --help"]);
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

test("live-proof attach constructs trusted URLs, uploads, rewrites the report, and re-upserts", async () => {
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
  assert.match(report, /<!-- comment metadata updated -->/);
  assert.match(publishedBody, /### Live Proof/);
  assert.match(publishedBody, /<!-- clawsweeper-review item=42 -->/);
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
    jobs: Record<string, Record<string, unknown>>;
  };
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["repo", "item"]);
  assert.deepEqual(workflow.jobs.execute?.permissions, {});
  assert.doesNotMatch(JSON.stringify(workflow.jobs.execute), /secrets\./);
  assert.match(source, /uses: \.\/\.github\/actions\/create-target-write-token/);
  assert.match(source, /CLAWSWEEPER_LIVE_PROOF_S3_ENDPOINT: \$\{\{ secrets\./);
  assert.match(source, /setsid timeout --kill-after=30s 1500s/);
  assert.match(source, /--record \.\.\/live-proof-report\.md/);
  assert.doesNotMatch(source, /--plan \.\.\/live-proof/);
  const sweep = readFileSync(".github/workflows/sweep.yml", "utf8");
  assert.match(sweep, /event_type: "clawsweeper_live_proof"/);
  assert.match(sweep, /profile\.liveTest\?\.enabled/);
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
    updateReviewCommentMetadata: (markdown: string) =>
      `${markdown.trimEnd()}\n\n<!-- comment metadata updated -->\n`,
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
