import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { postOpenClawAgentHook } from "../../../../dist/repair/openclaw-hook.js";

const root = process.cwd();
const baseRef = process.env.PROOF_BASE_REF || "origin/main";
const sourcePath = "src/repair/notify-merge.ts";
const baseSource = gitShow(sourcePath);
const oldFunction = extractBetween(
  baseSource,
  "async function postHookNotification(",
  "\nfunction readHookRunId(",
);
const oldPostHookNotification = compileOldFunction(oldFunction);
const idempotencyKey = "merge:openclaw/openclaw#123:merge_canonical:abc123";
const config = {
  hookUrl: "https://claw.example/hooks/agent",
  token: "proof-token",
  agentId: "clawsweeper",
  channel: "discord",
  discordTarget: "channel:123",
  thinking: "low",
  timeoutSeconds: 1,
};
const notification = {
  idempotencyKey,
  repo: "openclaw/openclaw",
  target: "#123",
};

const oldCalls = [];
await assert.rejects(
  oldPostHookNotification({
    config,
    notification,
    fetcher: async (_input, init) => {
      oldCalls.push(new Headers(init?.headers).get("idempotency-key"));
      return new Response("transient", { status: 502 });
    },
  }),
  /OpenClaw hook returned 502/,
);

const newCalls = [];
const result = await postOpenClawAgentHook({
  config: { ...config, retryAttempts: 2 },
  fetcher: async (_input, init) => {
    newCalls.push(new Headers(init?.headers).get("idempotency-key"));
    return newCalls.length === 1
      ? new Response("transient", { status: 502 })
      : new Response(JSON.stringify({ runId: "proof-run" }), { status: 200 });
  },
  post: {
    name: "ClawSweeper merged openclaw/openclaw#123",
    message: "proof message",
    idempotencyKey,
    deliver: true,
  },
  retryDelaysMs: [0],
});

assert.equal(oldCalls.length, 1);
assert.deepEqual(newCalls, [idempotencyKey, idempotencyKey]);
assert.equal(result.runId, "proof-run");

const siblingNotifiers = [
  "src/repair/notify-events.ts",
  "src/repair/notify-github-activity.ts",
  "src/repair/notify-maintainer-report.ts",
].map((file) => {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert.match(source, /postOpenClawAgentHook/);
  assert.match(source, /resolveOpenClawHookConfig/);
  return file;
});

const artifact = {
  base_ref: baseRef,
  base_sha: execFileSync("git", ["rev-parse", baseRef], { encoding: "utf8" }).trim(),
  extracted_source: sourcePath,
  extracted_source_sha256: createHash("sha256").update(oldFunction).digest("hex"),
  scenario: "first hook response is transient HTTP 502",
  old: { requests: oldCalls.length, outcome: "failed" },
  new: {
    requests: newCalls.length,
    idempotency_keys: newCalls,
    outcome: "succeeded",
    run_id: result.runId,
  },
  sibling_notifier_precedent: siblingNotifiers,
};

const outputPath = path.join(
  root,
  "docs/proof/repair-duplication-merges/merge-1/artifacts/retry-adoption.json",
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact, null, 2));

function gitShow(file) {
  return execFileSync("git", ["show", `${baseRef}:${file}`], { encoding: "utf8" });
}

function extractBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert(startIndex >= 0 && endIndex > startIndex, `could not extract ${start}`);
  return source.slice(startIndex, endIndex);
}

function compileOldFunction(source) {
  const compiled = source.replace(/}: \{[\s\S]*?\}\): Promise<HookPostResult> \{/, "}) {");
  const context = {
    exports: {},
    AbortController,
    clearTimeout,
    console,
    JSON,
    renderNotificationMessage: () => "proof message",
    setTimeout,
  };
  vm.runInNewContext(`${compiled}\nexports.proof = postHookNotification;`, context);
  return context.exports.proof;
}
