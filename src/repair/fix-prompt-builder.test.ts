import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFixPrompt,
  buildRepositoryContext,
  renderFixArtifactForPrompt,
} from "./fix-prompt-builder.js";
import type { LooseRecord } from "./json-types.js";

function promptFor(fixArtifact: LooseRecord): string {
  return buildFixPrompt({
    fixArtifact,
    branch: "clawsweeper/automerge-openclaw-openclaw-74506",
    mode: "replacement",
    attempt: 1,
    maxEditAttempts: 3,
    repositoryContext: "candidate_files (1):\nCHANGELOG.md (100)",
  });
}

test("fix prompt treats changelog-required artifacts as release-note context", () => {
  const prompt = promptFor({
    repair_strategy: "replace_uneditable_branch",
    pr_title: "fix(discord): document mention formatting guidance",
    summary: "Add Discord mention formatting guidance.",
    source_prs: ["https://github.com/openclaw/openclaw/pull/74506"],
    changelog_required: true,
    likely_files: ["CHANGELOG.md"],
    credit_notes: ["Preserve @steipete as source PR author."],
  });

  assert.match(prompt, /changelog_required is true/);
  assert.match(prompt, /preserve the user-facing change summary/);
  assert.match(
    prompt,
    /never add forbidden `Thanks @codex`, `Thanks @openclaw`, or `Thanks @steipete`/,
  );
  assert.match(prompt, /do not edit CHANGELOG\.md during normal repair work/);
  assert.match(prompt, /do not leave release-note context for a later repair pass/);
});

test("fix prompt still asks Codex to preserve discovered release-note context", () => {
  const prompt = promptFor({
    repair_strategy: "repair_contributor_branch",
    pr_title: "fix(discord): document mention formatting guidance",
    summary: "Add Discord mention formatting guidance.",
    source_prs: ["https://github.com/openclaw/openclaw/pull/74506"],
    changelog_required: false,
    likely_files: ["extensions/discord/src/message.ts"],
  });

  assert.match(prompt, /repair_contributor_branch never edits CHANGELOG\.md/);
  assert.match(prompt, /preserve release-note context/);
  assert.match(prompt, /preserve contributor credit in the PR body or commit history/);
});

test("contributor branch repairs never edit release-owned changelogs", () => {
  const prompt = promptFor({
    repair_strategy: "repair_contributor_branch",
    pr_title: "feat(slides): add native tables",
    summary: "Repair a generated contributor branch.",
    source_prs: ["https://github.com/openclaw/gogcli/pull/834"],
    changelog_required: true,
    likely_files: ["CHANGELOG.md", "internal/cmd/slides_table.go"],
  });

  assert.match(prompt, /repair_contributor_branch never edits CHANGELOG\.md/);
  assert.match(prompt, /even if changelog_required is true/);
  assert.match(prompt, /existing PR body or commit history instead/);
});

test("fix prompt makes Codex own the validation loop", () => {
  const prompt = buildFixPrompt({
    fixArtifact: {
      summary: "Repair the stuck automerge branch.",
      changelog_required: false,
      validation_commands: ["pnpm test:repair"],
    },
    branch: "clawsweeper/automerge-openclaw-openclaw-74506",
    mode: "repair",
    attempt: 1,
    maxEditAttempts: 3,
    repositoryContext: "candidate_files (1):\nsrc/repair.ts (100)",
    validationCommands: ["pnpm check:changed"],
  });

  assert.match(prompt, /Validation loop:/);
  assert.match(prompt, /establish one base snapshot for this Codex edit pass/);
  assert.match(prompt, /pin that base SHA while editing and validating/);
  assert.match(
    prompt,
    /do not refetch, rebase, or rerun validation solely because origin\/main advances/,
  );
  assert.match(prompt, /ClawSweeper performs one deterministic final base sync/);
  assert.match(prompt, /use one repair loop against the pinned base/);
  assert.doesNotMatch(prompt, /always fetch latest origin\/main/);
  assert.match(prompt, /run the changed-surface validation in this checkout before returning/);
  assert.match(prompt, /expected validation commands: pnpm check:changed ; pnpm test:repair/);
  assert.match(prompt, /fix the failure and rerun until it passes/);
  assert.match(prompt, /do not report validation as passed unless it passed after your last edit/);
});

test("automerge fix prompt makes Codex own PR repair, rebase, and CI discovery", () => {
  const prompt = buildFixPrompt({
    fixArtifact: {
      repair_strategy: "repair_contributor_branch",
      summary: "Repair the stuck automerge branch.",
      changelog_required: false,
      validation_commands: ["pnpm build", "pnpm test src/config/schema.base.generated.test.ts"],
    },
    branch: "clawsweeper/automerge-openclaw-openclaw-75976",
    mode: "repair",
    attempt: 1,
    maxEditAttempts: 3,
    repositoryContext: "candidate_files (1):\nsrc/config/schema.base.generated.test.ts (100)",
    validationCommands: ["pnpm check:changed"],
    isAutomergeRepair: true,
  });

  assert.match(prompt, /automerge repair loop: treat this as direct PR repair work/);
  assert.match(prompt, /read-only `gh` commands are allowed/);
  assert.match(prompt, /if no successful deterministic pre-edit rebase was supplied/);
  assert.match(prompt, /fetch origin\/main and rebase this branch once/);
  assert.match(prompt, /fix failing CI\/checks for this PR/);
  assert.match(prompt, /failed exact-head checks are repair scope for automerge/);
  assert.match(prompt, /outside likely_files/);
  assert.match(prompt, /fix the narrow failure against the pinned base/);
  assert.doesNotMatch(prompt, /first rebase to latest main/);
  assert.match(prompt, /validation command hints: pnpm check:changed ; pnpm build/);
  assert.match(prompt, /treat artifact validation commands as hints/);
  assert.doesNotMatch(prompt, /do not push, open PRs, close PRs, or call gh/);
});

test("fix prompt includes rebase and previous no-diff recovery details", () => {
  const prompt = buildFixPrompt({
    fixArtifact: {
      summary: "Repair the stuck automerge branch.",
      changelog_required: false,
    },
    branch: "clawsweeper/automerge-openclaw-openclaw-74506",
    mode: "repair",
    fallbackReason: "source branch is stale",
    previousNoDiff: true,
    previousSummary: "Analyzed without editing files.".repeat(100),
    repositoryContext: "candidate_files (0):\nnone matched",
    reconcileWithBase: true,
    sourceHead: "abc123",
    rebaseResult: {
      status: "conflicts",
      base_ref: "origin/main",
      base_sha: "def456",
      detail: "CONFLICT (content): CHANGELOG.md",
      unmerged_paths: ["src/index.ts", "CHANGELOG.md"],
    },
    maxEditAttempts: 5,
  });

  assert.match(prompt, /Edit attempt: 1 of 5/);
  assert.match(prompt, /use the supplied deterministic pre-edit rebase when it already succeeded/);
  assert.match(prompt, /otherwise fetch origin\/main once and rebase or otherwise sync once/);
  assert.doesNotMatch(prompt, /always fetch latest origin\/main/);
  assert.match(prompt, /Existing repair branch detected/);
  assert.match(prompt, /Source head before edit: abc123/);
  assert.match(prompt, /Deterministic pre-edit rebase: conflicts onto origin\/main \(def456\)/);
  assert.match(prompt, /Conflict-first mode/);
  assert.match(prompt, /resolve only the active rebase conflicts/);
  assert.match(prompt, /Unmerged conflict paths: src\/index\.ts, CHANGELOG\.md/);
  assert.match(prompt, /Rebase output: CONFLICT \(content\): CHANGELOG\.md/);
  assert.match(prompt, /Previous attempt produced no target repo diff/);
  assert.match(prompt, /Previous no-diff summary: Analyzed without editing files/);
  assert.match(prompt, /Fallback reason: source branch is stale/);
});

test("fix prompt compacts oversized artifacts before sending them to Codex", () => {
  const hugeBody = "Codex review evidence with repeated context.\n".repeat(4000);
  const prompt = buildFixPrompt({
    fixArtifact: {
      repo: "openclaw/openclaw",
      repair_strategy: "repair_contributor_branch",
      summary: "Fix a durable status comment lifecycle regression.",
      source_prs: ["https://github.com/openclaw/openclaw/pull/77205"],
      likely_files: ["src/clawsweeper.ts"],
      validation_commands: ["pnpm check:changed"],
      pr_body: hugeBody,
      comments: Array.from({ length: 50 }, (_, index) => ({
        author: `reviewer-${index}`,
        body: hugeBody,
      })),
    },
    branch: "clawsweeper/automerge-openclaw-openclaw-77205",
    mode: "repair",
    attempt: 1,
    maxEditAttempts: 3,
    repositoryContext: "candidate_files (1):\nsrc/clawsweeper.ts (100)",
    isAutomergeRepair: true,
  });
  const artifactJson = renderFixArtifactForPrompt({
    summary: "Fix a durable status comment lifecycle regression.",
    pr_body: hugeBody,
  });

  assert.ok(prompt.length < 80_000, `prompt was ${prompt.length} chars`);
  assert.ok(artifactJson.length <= 36_000, `artifact was ${artifactJson.length} chars`);
  assert.match(prompt, /Original fix artifact was \d+ characters/);
  assert.match(prompt, /source_prs/);
  assert.match(prompt, /https:\/\/github\.com\/openclaw\/openclaw\/pull\/77205/);
  assert.match(prompt, /pnpm check:changed/);
  assert.match(prompt, /entries omitted/);
  assert.match(prompt, /truncated \d+ chars/);
});

test("artifact compaction falls back to critical fields for pathological payloads", () => {
  const tooManyKeys: LooseRecord = {
    repo: "openclaw/openclaw",
    source_prs: ["https://github.com/openclaw/openclaw/pull/77205"],
    summary: "Keep the critical summary.",
    validation_commands: ["pnpm check:changed"],
    comments: Array.from({ length: 17 }, (_, index) => `comment ${index}`),
    nested: { a: { b: { c: { d: { e: { f: "too deep" } } } } } },
  };
  for (let index = 0; index < 70; index += 1) {
    tooManyKeys[`html_url_${index}`] =
      `https://github.com/openclaw/openclaw/pull/77205#${"x".repeat(6000)}`;
  }

  const rendered = renderFixArtifactForPrompt(tooManyKeys);
  const scalar = renderFixArtifactForPrompt("scalar context ".repeat(4000));

  assert.ok(rendered.length < 8000, `artifact was ${rendered.length} chars`);
  assert.match(rendered, /critical fields only/);
  assert.match(rendered, /Keep the critical summary/);
  assert.match(rendered, /pnpm check:changed/);
  assert.match(scalar, /value was truncated/);
  assert.match(scalar, /scalar context/);

  const array = renderFixArtifactForPrompt(
    Array.from({ length: 1000 }, (_, index) => ({
      body: `array entry ${index} ${"x".repeat(200)}`,
    })),
  );
  assert.match(array, /value was truncated/);
  assert.match(array, /entries omitted/);

  const hugeArray = renderFixArtifactForPrompt(
    Array.from({ length: 1000 }, () => "x".repeat(10_000)),
  );
  assert.match(hugeArray, /critical fields only/);
  assert.match(hugeArray, /prompt artifact hit/);
});

test("repository context ranks likely files and renders focused excerpts", () => {
  const tmp = makeGitRepo({
    "package.json": JSON.stringify({
      scripts: {
        test: "node --test",
        build: "tsgo -p tsconfig.json",
      },
    }),
    "src/discord-message.ts": [
      "export function renderMention(id: string) {",
      "  return `<@${id}>`;",
      "}",
    ].join("\n"),
    "src/discord-message.test.ts": "renderMention('123');\n",
    "docs/mentions.md": "Discord mention formatting guidance.\n",
    "ignored.bin": "binary-ish\n",
  });

  const context = buildRepositoryContext({
    targetDir: tmp,
    fixArtifact: {
      summary: "Fix Discord mention formatting.",
      pr_title: "fix(discord): document mention formatting guidance",
      affected_surfaces: ["discord messages"],
      likely_files: ["src/discord-message.ts", "src/**/*.test.ts"],
      validation_commands: ["pnpm test:repair"],
    },
  });

  assert.match(context, /candidate_files \(\d+\):/);
  assert.match(context, /src\/discord-message\.ts \(\d+\)/);
  assert.match(context, /src\/discord-message\.test\.ts/);
  assert.match(context, /candidate_file_excerpts:/);
  assert.match(context, /--- src\/discord-message\.ts ---/);
  assert.match(context, /renderMention/);
  assert.match(context, /validation_commands: pnpm test:repair/);
  assert.match(context, /package_scripts: build, test/);
});

test("repository context handles missing candidates, huge files, and invalid packages", () => {
  const tmp = makeGitRepo({
    "package.json": "{not json",
    "notes.bin": "no supported extension\n",
    "docs/huge.md": "mention\n".repeat(40_000),
  });

  const context = buildRepositoryContext({
    targetDir: tmp,
    fixArtifact: {
      summary: "",
      pr_title: "",
      likely_files: ["docs/huge.md"],
    },
  });

  assert.match(context, /candidate_files \(2\):/);
  assert.match(context, /docs\/huge\.md \(\d+\)/);
  assert.match(context, /package\.json \(1\)/);
  assert.doesNotMatch(context, /--- docs\/huge\.md ---/);
  assert.match(context, /--- package\.json ---/);
  assert.match(context, /package_scripts: none/);
});

test("repository context renders first lines when discovery has no tokens", () => {
  const tmp = makeGitRepo({
    "package.json": JSON.stringify({ private: true }),
    "README.md": Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n"),
  });

  const context = buildRepositoryContext({
    targetDir: tmp,
    fixArtifact: {},
  });

  assert.match(context, /--- README\.md ---/);
  assert.match(context, /1: line 1/);
  assert.match(context, /80: line 80/);
  assert.doesNotMatch(context, /120: line 120/);
});

test("repository context reports no candidates when nothing scores", () => {
  const tmp = makeGitRepo({
    "notes.bin": "no supported extension\n",
  });

  const context = buildRepositoryContext({
    targetDir: tmp,
    fixArtifact: {},
  });

  assert.match(context, /candidate_files \(0\):/);
  assert.match(
    context,
    /none matched; use rg across the repo to find the real implementation files/,
  );
});

function makeGitRepo(files: Record<string, string>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fix-prompt-"));
  execFileSync("git", ["init", "-q"], { cwd: tmp });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(tmp, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  execFileSync("git", ["add", "."], { cwd: tmp });
  return tmp;
}
