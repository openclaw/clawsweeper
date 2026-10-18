import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  utimesSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { appendReviewUsage, readReviewRolloutUsage } from "../dist/review-usage.js";

const usage = {
  input_tokens: 100,
  cached_input_tokens: 20,
  cache_write_input_tokens: 30,
  output_tokens: 10,
  reasoning_output_tokens: 5,
};
const tokenEvent = (input = usage.input_tokens) =>
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          ...usage,
          input_tokens: input,
          total_tokens: input + usage.output_tokens,
        },
        last_token_usage: { input_tokens: 99999 },
      },
    },
  });

function fixture(t: TestContext) {
  const codexHome = mkdtempSync(join(tmpdir(), "review-usage-"));
  t.after(() => rmSync(codexHome, { recursive: true, force: true }));
  const directory = join(codexHome, "sessions", "2026", "10", "13");
  mkdirSync(directory, { recursive: true });
  const startedAt = Date.now() - 1000;
  const finishedAt = Date.now() + 1000;
  return { codexHome, directory, startedAt, finishedAt };
}

test("rollout usage takes each session's last cumulative total, not notification or repair-turn sums", (t) => {
  const options = fixture(t);
  writeFileSync(
    join(options.directory, "rollout-one.jsonl"),
    [
      JSON.stringify({ type: "session_meta", payload: { model: "never-send-this-model" } }),
      JSON.stringify({ type: "turn_context", payload: {} }),
      tokenEvent(80),
      tokenEvent(100),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
    ].join("\n") + "\n",
  );
  writeFileSync(join(options.directory, "rollout-two.jsonl"), tokenEvent(200) + "\n");
  writeFileSync(join(options.directory, "not-a-rollout.jsonl"), "not JSON");
  assert.deepEqual(readReviewRolloutUsage(options), {
    input_tokens: 300,
    cached_input_tokens: 40,
    cache_write_input_tokens: 60,
    output_tokens: 20,
    reasoning_output_tokens: 10,
  });
});

test("rollout attribution excludes both older and subsequent sequential reviews", (t) => {
  const options = fixture(t);
  const current = join(options.directory, "rollout-current.jsonl");
  writeFileSync(current, tokenEvent() + "\n");
  for (const [name, time] of [
    ["old", options.startedAt - 10000],
    ["future", options.finishedAt + 10000],
  ] as const) {
    const path = join(options.directory, `rollout-${name}.jsonl`);
    writeFileSync(path, tokenEvent(10000) + "\n");
    utimesSync(path, time / 1000, time / 1000);
  }
  assert.deepEqual(readReviewRolloutUsage(options), usage);
});

test("missing home, sessions, matching files, or usage produces null", (t) => {
  const options = fixture(t);
  assert.equal(readReviewRolloutUsage({ ...options, codexHome: undefined }), null);
  assert.equal(
    readReviewRolloutUsage({ ...options, codexHome: join(options.codexHome, "missing") }),
    null,
  );
  assert.equal(readReviewRolloutUsage(options), null);
  writeFileSync(join(options.directory, "rollout-empty.jsonl"), '{"type":"session_meta"}\n');
  assert.equal(readReviewRolloutUsage(options), null);
});

test("receiver compatibility does not enable omitted or null cache writes in the producer", (t) => {
  const options = fixture(t);
  const { cache_write_input_tokens: _cacheWrite, ...core } = usage;
  for (const counters of [core, { ...core, cache_write_input_tokens: null }]) {
    writeFileSync(
      join(options.directory, "rollout-strict.jsonl"),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: counters } },
      }) + "\n",
    );
    assert.equal(readReviewRolloutUsage(options), null);
  }
});

for (const scenario of ["oversized", "malformed", "unreadable", "invalid-counter"] as const) {
  test(`a ${scenario} rollout invalidates the complete sum instead of returning partial usage`, (t) => {
    const options = fixture(t);
    writeFileSync(join(options.directory, "rollout-valid.jsonl"), tokenEvent() + "\n");
    const path = join(options.directory, "rollout-bad.jsonl");
    if (scenario === "unreadable") mkdirSync(path);
    else {
      writeFileSync(
        path,
        scenario === "malformed"
          ? tokenEvent() + '\n{"type":"event_msg","payload":{"type":"token_count","info":\n'
          : scenario === "invalid-counter"
            ? JSON.stringify({
                type: "event_msg",
                payload: {
                  type: "token_count",
                  info: { total_token_usage: { ...usage, output_tokens: -1 } },
                },
              }) + "\n"
            : "",
      );
      if (scenario === "oversized") truncateSync(path, 64 * 1024 * 1024 + 1);
    }
    assert.equal(readReviewRolloutUsage(options), null);
  });
}

test("runtime appends one token-only rollout record without credentials or network access", (t) => {
  const options = fixture(t);
  writeFileSync(join(options.directory, "rollout-one.jsonl"), tokenEvent() + "\n");
  const path = join(options.codexHome, "usage.jsonl");
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("No network in review runtime");
  });
  const record = {
    target_repo: "openclaw/openclaw",
    item_number: 1,
    item_kind: "issue" as const,
    service_tier: "",
    reasoning_effort: "high",
    outcome: "ok" as const,
    duration_ms: 123,
  };
  appendReviewUsage({
    ...options,
    record,
    env: { CLAWSWEEPER_REVIEW_USAGE_PATH: path, GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" },
  });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    ...record,
    schema: 1,
    run_id: "42",
    run_attempt: 2,
    usage,
  });
  assert.equal(fetch.mock.callCount(), 0);
  appendReviewUsage({ ...options, record, env: {} });
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
});

test("local usage handoff bounds records/files and swallows filesystem failures", (t) => {
  const options = fixture(t);
  const path = join(options.codexHome, "usage.jsonl");
  const record = {
    target_repo: "openclaw/openclaw",
    item_number: 1,
    item_kind: "issue" as const,
    service_tier: "",
    reasoning_effort: "high",
    outcome: "failed" as const,
    duration_ms: 123,
  };
  const env = { CLAWSWEEPER_REVIEW_USAGE_PATH: path, GITHUB_RUN_ID: "42" };
  assert.doesNotThrow(() =>
    appendReviewUsage({ ...options, record: { ...record, target_repo: "x".repeat(17000) }, env }),
  );
  assert.equal(existsSync(path), false);
  writeFileSync(path, "");
  truncateSync(path, 1024 * 1024);
  assert.doesNotThrow(() => appendReviewUsage({ ...options, record, env }));
  assert.equal(statSync(path).size, 1024 * 1024);
  assert.doesNotThrow(() =>
    appendReviewUsage({
      ...options,
      record,
      env: {
        ...env,
        CLAWSWEEPER_REVIEW_USAGE_PATH: join(options.codexHome, "missing", "usage.jsonl"),
      },
    }),
  );
});

test("backward rollout reads reconstruct token events across 64 KiB chunks", (t) => {
  const options = fixture(t);
  const event = JSON.stringify({
    type: "event_msg",
    padding: "雪".repeat(23000),
    payload: { type: "token_count", info: { total_token_usage: usage } },
  });
  const tail = JSON.stringify({ type: "response_item", payload: { text: "雪".repeat(25000) } });
  writeFileSync(
    join(options.directory, "rollout-boundary.jsonl"),
    `${tokenEvent(99999)}\n${event}\n${tail}\n`,
  );
  assert.deepEqual(readReviewRolloutUsage(options), usage);
});

test("usage is on disk before a child immediately exits synchronously", (t) => {
  const options = fixture(t);
  writeFileSync(join(options.directory, "rollout-one.jsonl"), tokenEvent() + "\n");
  const path = join(options.codexHome, "usage.jsonl");
  const submission = {
    ...options,
    record: {
      target_repo: "openclaw/openclaw",
      item_number: 1,
      item_kind: "issue",
      service_tier: "",
      reasoning_effort: "high",
      outcome: "failed",
      duration_ms: 123,
    },
    env: { CLAWSWEEPER_REVIEW_USAGE_PATH: path, GITHUB_RUN_ID: "42" },
  };
  const moduleUrl = new URL("../dist/review-usage.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { appendReviewUsage } from ${JSON.stringify(moduleUrl)};
appendReviewUsage(${JSON.stringify(submission)});
process.exit(1);`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const record: Record<string, unknown> = JSON.parse(lines[0]!);
  assert.equal(record.outcome, "failed");
  assert.deepEqual(record.usage, usage);
});
