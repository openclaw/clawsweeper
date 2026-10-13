import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localRangeReviewPreflight, serializeReviewPreflight } from "../dist/review-preflight.js";
import { emitReviewOutput, reviewOutputSelection } from "../dist/review-output-policy.js";
import { parseArgs } from "../dist/clawsweeper-args.js";

const basePayload = {
  v: 1 as const,
  repo: "example-owner/example-repo",
  base: "a".repeat(40),
  head: "b".repeat(40),
  tool: { name: "clawsweeper" as const, version: "1.2.3" },
  completion: "complete" as const,
  summary: "Native completion is self-reported, not a clean verdict.",
};

test("preflight has a fixed bounded shape and cannot escape its HTML comment", () => {
  const block = serializeReviewPreflight({ ...basePayload, summary: "</script> --> & <x>" });
  assert.equal(block.split("-->").length, 2);
  assert.equal(block.includes("<x>"), false);
  assert.ok(Buffer.byteLength(block) <= 4096);
  assert.deepEqual(JSON.parse(block.split("\n")[1]!), {
    ...basePayload,
    summary: "</script> --> & <x>",
  });
  assert.throws(() => serializeReviewPreflight({ ...basePayload, head: "b".repeat(64) }));
  assert.throws(() => serializeReviewPreflight({ ...basePayload, repo: "https://host/a/b" }));
  assert.ok(serializeReviewPreflight({ ...basePayload, summary: "💥".repeat(128) }));
  assert.ok(serializeReviewPreflight({ ...basePayload, summary: "<".repeat(512) }));
  assert.throws(() => serializeReviewPreflight({ ...basePayload, summary: "💥".repeat(129) }));
  const withPrivateExtra = {
    ...basePayload,
    privatePath: "/private/example",
    tool: { ...basePayload.tool, model: "private" },
  };
  const parsed = JSON.parse(serializeReviewPreflight(withPrivateExtra).split("\n")[1]!);
  assert.equal(parsed.privatePath, undefined);
  assert.equal(parsed.tool.model, undefined);
});

test("local preflight preserves native failure semantics and rejects changed source", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "review-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Example Author");
  git("config", "user.email", "author@example.com");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "source.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("branch", "review-base");
  writeFileSync(join(dir, "source.txt"), "head\n");
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD");
  const input = {
    targetDir: dir,
    baseRef: "review-base",
    repo: basePayload.repo,
    base,
    head,
    decision: {
      localCheckoutAccess: "verified" as const,
      summary: "Native result",
      reviewFindings: [],
    },
  };
  const complete = localRangeReviewPreflight(input);
  assert.ok(complete.block);
  const payload = JSON.parse(complete.block.split("\n")[1]!);
  assert.equal(payload.completion, "complete");
  assert.equal(payload.base, base);
  assert.equal(payload.head, head);
  assert.equal(
    payload.tool.version,
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  );
  assert.match(payload.summary, /not a clean verdict/);
  const failed = localRangeReviewPreflight({
    ...input,
    decision: { ...input.decision, summary: "Codex review failed: native failure" },
  });
  assert.ok(failed.block);
  const failedPayload = JSON.parse(failed.block.split("\n")[1]!);
  assert.equal(failedPayload.completion, "failed");
  assert.match(failedPayload.summary, /may be incomplete/);
  assert.equal(localRangeReviewPreflight({ ...input, decision: undefined }).block, null);
  assert.equal(localRangeReviewPreflight({ ...input, head: base }).block, null);
  git("branch", "-f", "review-base", head);
  assert.equal(localRangeReviewPreflight(input).block, null);
  git("branch", "-f", "review-base", base);
  writeFileSync(join(dir, "untracked.txt"), "unreviewed\n");
  assert.equal(localRangeReviewPreflight(input).block, null);
  rmSync(join(dir, "untracked.txt"));
  writeFileSync(join(dir, "source.txt"), "unreviewed\n");
  assert.equal(localRangeReviewPreflight(input).block, null);
  git("add", "source.txt");
  assert.equal(localRangeReviewPreflight(input).block, null);
});

test("optional export failure preserves the native JSON report", (t) => {
  let output = "";
  t.mock.method(console, "log", (value: string) => {
    output = value;
  });
  const selection = reviewOutputSelection(parseArgs(["--result-format", "json"]), {
    destinationFlag: "artifact_dir",
  });
  const reports = [{ itemNumber: 0, path: null, markdown: "native report" }];
  emitReviewOutput(selection, "completed", reports);
  assert.equal(JSON.parse(output).preflight, undefined);
  emitReviewOutput(selection, "completed", reports, { block: null, error: "Source changed" });
  assert.deepEqual(JSON.parse(output), {
    status: "completed",
    retention: "none",
    reports: [{ item_number: 0, artifact_path: null, report: "native report" }],
    preflight: { block: null, error: "Source changed" },
  });
});

test("preflight invalid combinations and help exit without a review", () => {
  // A guard regression must fail against Node, never launch the operator's reviewer.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_BIN: process.execPath,
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
  };
  delete env.EXACT_REVIEW_DECISION;
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/clawsweeper.js", "review", ...args], {
      encoding: "utf8",
      env,
      timeout: 10_000,
    });
  for (const args of [
    ["--preflight", "--result-format", "json"],
    ["--preflight", "--local-range"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /--preflight requires/);
  }
  const help = run(["--preflight", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /No GitHub writes/);
});
