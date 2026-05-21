import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendUsageEventJsonl,
  buildUsageTelemetryEvent,
  emitUsageEventOtlpHttp,
  emitUsageTelemetry,
  parseClaudeTokenUsageFromMessage,
  parseCodexTokenUsageFromJsonl,
} from "../src/usage-telemetry.ts";

function tokenCount(totalUsage: Record<string, number>): string {
  return JSON.stringify({
    type: "token_count",
    payload: {
      info: {
        last_token_usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        total_token_usage: totalUsage,
      },
    },
  });
}

test("parses a single Codex token_count event", () => {
  const result = parseCodexTokenUsageFromJsonl(
    tokenCount({
      input_tokens: 10,
      cached_input_tokens: 4,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      total_tokens: 21,
    }),
  );

  assert.deepEqual(result?.totalTokenUsage, {
    input_tokens: 10,
    cached_input_tokens: 4,
    output_tokens: 5,
    reasoning_output_tokens: 2,
    total_tokens: 21,
  });
  assert.deepEqual(result?.tokens, {
    input: 10,
    cache_read: 4,
    cache_creation: 0,
    output: 5,
    reasoning_output: 2,
    total: 21,
  });
});

test("chooses the last total_token_usage from multiple token_count events", () => {
  const result = parseCodexTokenUsageFromJsonl(
    [
      tokenCount({ input_tokens: 1, output_tokens: 2, total_tokens: 3 }),
      JSON.stringify({ type: "message", payload: { text: "ignored" } }),
      tokenCount({ input_tokens: 10, output_tokens: 20, total_tokens: 30 }),
    ].join("\n"),
  );

  assert.equal(result?.tokens.input, 10);
  assert.equal(result?.tokens.output, 20);
  assert.equal(result?.tokens.total, 30);
});

test("maps cached_input_tokens to cache_read", () => {
  const result = parseCodexTokenUsageFromJsonl(
    tokenCount({ input_tokens: 10, cached_input_tokens: 99, output_tokens: 1, total_tokens: 110 }),
  );

  assert.equal(result?.tokens.cache_read, 99);
});

test("parses Claude message usage with cache creation and cache reads", () => {
  const tokens = parseClaudeTokenUsageFromMessage({
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 34,
      cache_read_input_tokens: 56,
      output_tokens: 7,
    },
  });

  assert.deepEqual(tokens, {
    input: 12,
    cache_read: 56,
    cache_creation: 34,
    output: 7,
    reasoning_output: 0,
    total: 109,
  });
});

test("ignores malformed JSONL and non-usage lines", () => {
  const result = parseCodexTokenUsageFromJsonl(
    [
      "not json",
      JSON.stringify({ type: "message", payload: { text: "ignored" } }),
      "{ also not json",
      tokenCount({ input_tokens: 7, output_tokens: 8, total_tokens: 15 }),
    ].join("\n"),
  );

  assert.equal(result?.tokens.total, 15);
});

test("returns null when no usage is present", () => {
  assert.equal(parseCodexTokenUsageFromJsonl(""), null);
  assert.equal(parseCodexTokenUsageFromJsonl('{"type":"message"}\nnot json'), null);
  assert.equal(parseCodexTokenUsageFromJsonl('{"type":"token_count","payload":{"info":{}}}'), null);
});

test("buildUsageTelemetryEvent only includes explicit sanitized metadata", () => {
  const event = buildUsageTelemetryEvent(
    {
      workflow: "repair-worker",
      mode: "plan",
      phase: "primary",
      target_repo: "openclaw/openclaw",
      cluster_id: "cluster-1",
      item_number: 123,
      commit_sha: "abc123",
      job_path: "records/openclaw/jobs/123.md",
      model: "gpt-5.1-codex-max",
      reasoning_effort: "high",
      service_tier: "flex",
      sandbox: "read-only",
      timeout_ms: 1000,
      elapsed_ms: 42,
      transcript_path: "codex.jsonl",
      stderr_path: "codex.stderr.log",
      output_path: "result.json",
      status: "success",
      tokens: {
        input: 1,
        cache_read: 2,
        cache_creation: 0,
        output: 3,
        reasoning_output: 4,
        total: 10,
      },
      prompt: "must not leak",
      output: "must not leak",
      transcript: "must not leak",
      authorization: "must not leak",
      github_token: "must not leak",
      issue_body: "must not leak",
      comment_body: "must not leak",
    } as Parameters<typeof buildUsageTelemetryEvent>[0],
    {
      emittedAt: new Date("2026-05-18T00:00:00.000Z"),
      env: {
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        GITHUB_RUN_ID: "100",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_JOB: "repair",
        RUNNER_NAME: "runner-1",
        GITHUB_TOKEN: "must not leak",
      },
    },
  );

  assert.deepEqual(event, {
    surface: "clawsweeper",
    emitted_at: "2026-05-18T00:00:00.000Z",
    github_repository: "openclaw/clawsweeper",
    github_run_id: "100",
    github_run_attempt: "2",
    github_job: "repair",
    runner_name: "runner-1",
    workflow: "repair-worker",
    mode: "plan",
    phase: "primary",
    provider: "openai-codex",
    session_id: "github:openclaw/clawsweeper:100",
    turn_id: "repair-worker:primary:openclaw/openclaw:item:123",
    target_repo: "openclaw/openclaw",
    cluster_id: "cluster-1",
    item_number: 123,
    commit_sha: "abc123",
    job_path: "records/openclaw/jobs/123.md",
    model: "gpt-5.1-codex-max",
    reasoning_effort: "high",
    service_tier: "flex",
    sandbox: "read-only",
    timeout_ms: 1000,
    elapsed_ms: 42,
    transcript_path: "codex.jsonl",
    stderr_path: "codex.stderr.log",
    output_path: "result.json",
    status: "success",
    tokens: {
      input: 1,
      cache_read: 2,
      cache_creation: 0,
      output: 3,
      reasoning_output: 4,
      total: 10,
    },
  });
});

test("appendUsageEventJsonl writes local JSONL and fails soft", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-usage-"));
  try {
    const path = join(dir, "nested", "usage-events.jsonl");
    const event = buildUsageTelemetryEvent(
      { status: "failed", tokens: null },
      { emittedAt: new Date(0), env: {} },
    );

    assert.equal(appendUsageEventJsonl(path, event), true);
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(event)}\n`);
    assert.equal(appendUsageEventJsonl(dir, event), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitUsageEventOtlpHttp only broadcasts sanitized OTLP attributes", () => {
  const dir = mkdtempSync(join(tmpdir(), "clawsweeper-otlp-"));
  try {
    const binDir = join(dir, "bin");
    const argsPath = join(dir, "curl-args.json");
    mkdirSync(binDir, { recursive: true });
    const curlPath = join(binDir, "curl");
    writeFileSync(
      curlPath,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    chmodSync(curlPath, 0o755);

    const event = buildUsageTelemetryEvent(
      {
        workflow: "repair-worker",
        phase: "primary",
        model: "gpt-5.5",
        transcript_path: "transcripts/raw-codex.jsonl",
        stderr_path: "stderr.log",
        output_path: "raw-output.json",
        status: "success",
        tokens: {
          input: 11,
          cache_read: 2,
          cache_creation: 5,
          output: 3,
          reasoning_output: 4,
          total: 25,
        },
      },
      { emittedAt: new Date("2026-05-18T00:00:00.000Z"), env: {} },
    );

    assert.equal(
      emitUsageEventOtlpHttp(event, {
        CLAWSWEEPER_USAGE_TELEMETRY: "1",
        CLAWSWEEPER_USAGE_OTLP_ENDPOINT: "http://collector.test/v1/traces",
        CLAWSWEEPER_USAGE_SERVICE_NAME: "clawsweeper-runner",
        CLAWSWEEPER_USAGE_SERVICE_NAMESPACE: "mac-mini",
        PATH: `${binDir}:${process.env.PATH}`,
      }),
      true,
    );

    const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    const payload = args[args.indexOf("--data-binary") + 1];
    assert.match(payload, /clawsweeper-runner/);
    assert.match(payload, /clawsweeper\.repair-worker\.primary/);
    assert.match(payload, /gen_ai\.usage\.total_tokens/);
    assert.match(payload, /gen_ai\.usage\.cache_creation_input_tokens/);
    assert.match(payload, /gen_ai\.usage\.cache_read_ratio/);
    assert.doesNotMatch(payload, /transcript_path|stderr_path|output_path/);
    assert.doesNotMatch(payload, /raw-codex|raw-output|stderr\.log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitUsageEventOtlpHttp is opt-in and skips zero-token events", () => {
  const event = buildUsageTelemetryEvent(
    {
      status: "success",
      tokens: {
        input: 0,
        cache_read: 0,
        cache_creation: 0,
        output: 0,
        reasoning_output: 0,
        total: 0,
      },
    },
    { emittedAt: new Date(0), env: {} },
  );

  assert.equal(
    emitUsageEventOtlpHttp(event, {
      CLAWSWEEPER_USAGE_TELEMETRY: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9",
    }),
    false,
  );
  assert.equal(
    emitUsageEventOtlpHttp(
      buildUsageTelemetryEvent(
        {
          status: "success",
          tokens: {
            input: 1,
            cache_read: 0,
            cache_creation: 0,
            output: 0,
            reasoning_output: 0,
            total: 1,
          },
        },
        { emittedAt: new Date(0), env: {} },
      ),
      { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" },
    ),
    false,
  );
});

test("emitUsageTelemetry swallows emitter failures", async () => {
  const event = buildUsageTelemetryEvent(
    { status: "success", tokens: null },
    { emittedAt: new Date(0), env: {} },
  );

  await assert.doesNotReject(
    emitUsageTelemetry(event, [
      {
        emit() {
          throw new Error("opik unavailable");
        },
      },
    ]),
  );
});
