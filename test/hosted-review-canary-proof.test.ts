import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { codexHumanFailureDetail, codexHumanRetryHint } from "../dist/codex-transient.js";
import {
  assertBooleanCountArtifact,
  assertHostedBlobStarts,
  assertHostedMultilineRequest,
  assertHostedNativeQuiescent,
  assertHostedProcessGroupGone,
  assertHostedTerminalDone,
  assertHostedTerminalQuiescent,
  assertMatchesJsonSchema,
  HOSTED_MULTILINE_PROVIDER_ERROR,
  HOSTED_MULTILINE_RETRY_HINT,
  HOSTED_REVIEW_ROLLOUT_MAX_BYTES,
  hostedBlobPreloadSource,
  hostedProcessIdentity,
  hostedTerminalObserverSource,
  readHostedLifecycle,
  recordHostedLifecycle,
  readHostedReviewRollout,
  runWithWithheldDiagnostics,
  snapshotHostedReviewRollouts,
  stopHostedNativeGroup,
  stopHostedTerminal,
  summarizeHostedReviewTrace,
  summarizeHostedMultilineFailure,
} from "../scripts/hosted-review-canary-proof.mjs";

test("hosted review canary explicitly supplies the canonical transient result limit", () => {
  const source = readFileSync(
    new URL("../scripts/hosted-review-scan-smoke.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /import \{ TRANSIENT_REVIEW_RESULT_MAX_BYTES \} from "\.\.\/dist\/review-output-policy\.js";/,
  );
  assert.match(
    source,
    /runCodexForTest\(\{[\s\S]*?\bresultFileBytes: TRANSIENT_REVIEW_RESULT_MAX_BYTES,/,
  );
});

function nativeTraceFixture() {
  const marker = "9ccfabf3-8158-437d-a168-173ee10d102a";
  const session = "11111111-1111-1111-1111-111111111111";
  const turn = "22222222-2222-2222-2222-222222222222";
  const cwd = join(tmpdir(), "synthetic-canary-checkout");
  const expectedCommand = "git diff --no-ext-diff --unified=0 base head -- review-fixture.js";
  const finalDecisionText = JSON.stringify({
    summary: `Hosted review canary observed marker ${marker}.`,
  });
  const records: { ordinal: number; type: string; payload: Record<string, unknown> }[] = [
    {
      type: "session_meta",
      payload: {
        id: session,
        session_id: session,
        cli_version: "0.153.3",
        cwd,
        source: "exec",
        originator: "codex_exec",
        history_mode: "paginated",
      },
    },
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "canary-command",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: expectedCommand,
          max_output_tokens: 1000,
          yield_time_ms: 1000,
        }),
        internal_chat_message_metadata_passthrough: { turn_id: turn },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: session,
        turn_id: turn,
        item: {
          id: "canary-command",
          type: "CommandExecution",
          command: ["/bin/bash", "-lc", expectedCommand],
          cwd: pathToFileURL(cwd).href,
          aggregated_output: `synthetic output ${marker}\n`,
          exit_code: 0,
          status: "completed",
        },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "canary-command",
        output: `Chunk ID: fixture\nWall time: 0.0000 seconds\nProcess exited with code 0\nOutput:\n${marker}\n`,
        internal_chat_message_metadata_passthrough: { turn_id: turn },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: session,
        turn_id: turn,
        item: {
          type: "AgentMessage",
          id: "canary-answer",
          phase: "final_answer",
          content: [{ type: "Text", text: finalDecisionText }],
        },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: turn,
        last_agent_message: finalDecisionText,
      },
    },
  ].map((record, ordinal) => ({ ...record, ordinal }));
  const options = {
    cwd,
    marker,
    expectedCommand,
    finalDecisionText,
    checkoutUnchanged: true,
  };
  const rollout = () => ({
    path: join(tmpdir(), `rollout-fixture-${session}.jsonl`),
    bytes: Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n"),
  });
  const item = (index: number) => records[index]!.payload.item as Record<string, unknown>;
  const invoke = () => summarizeHostedReviewTrace({ ...options, rollout: rollout() });
  return { records, item, options, rollout, invoke };
}

test("hosted review trace proves the pinned native command, final answer, and terminal turn", () => {
  const fixture = nativeTraceFixture();
  const proof = fixture.invoke();
  assert.deepEqual(proof, {
    eventCount: 7,
    toolAttemptCount: 1,
    completedToolCount: 1,
    fixtureToolCount: 1,
    reviewAfterToolCount: 1,
    terminalTurnCount: 1,
    checkoutUnchanged: true,
  });
  assertBooleanCountArtifact(proof);
  assert.doesNotMatch(
    JSON.stringify(proof),
    /private|9ccfabf3|command":|output|prompt|transcript/i,
  );
});

test("hosted review trace binds the terminal answer independently of optional message phase", () => {
  for (const phase of [undefined, "commentary"]) {
    const fixture = nativeTraceFixture();
    if (phase === undefined) delete fixture.item(5).phase;
    else fixture.item(5).phase = phase;
    assert.equal(fixture.invoke().reviewAfterToolCount, 1);
  }
});

for (const login of [undefined, true, false]) {
  test(`hosted review trace binds native shell arguments to login=${String(login)}`, () => {
    const fixture = nativeTraceFixture();
    const args = JSON.parse(String(fixture.records[2]!.payload.arguments));
    if (login !== undefined) args.login = login;
    fixture.records[2]!.payload.arguments = JSON.stringify(args);
    const flag = login === false ? "-c" : "-lc";
    const command = ["/bin/bash", flag, fixture.options.expectedCommand];
    fixture.item(3).command = command;
    assert.equal(fixture.invoke().completedToolCount, 1);

    fixture.item(3).command = [
      "/bin/bash",
      flag === "-c" ? "-lc" : "-c",
      fixture.options.expectedCommand,
    ];
    assert.throws(fixture.invoke, /different command arguments/);
    fixture.item(3).command = [...command, "extra"];
    assert.throws(fixture.invoke, /different command arguments/);
  });
}

test("hosted review trace rejects nonboolean supplied login arguments", () => {
  for (const login of [null, 0, 1, "false", "true", [], {}]) {
    const fixture = nativeTraceFixture();
    const args = JSON.parse(String(fixture.records[2]!.payload.arguments));
    fixture.records[2]!.payload.arguments = JSON.stringify({ ...args, login });
    assert.throws(fixture.invoke, /login must be a boolean/);
  }
});

const traceMutations: [string, (fixture: ReturnType<typeof nativeTraceFixture>) => void][] = [
  [
    "wrong native version",
    (f) => {
      f.records[0]!.payload.cli_version = "0.153.4";
    },
  ],
  [
    "legacy history",
    (f) => {
      f.records[0]!.payload.history_mode = "legacy";
    },
  ],
  [
    "different session",
    (f) => {
      f.records[0]!.payload.session_id = "other";
    },
  ],
  [
    "different source",
    (f) => {
      f.records[0]!.payload.source = "app-server";
    },
  ],
  [
    "different checkout",
    (f) => {
      f.records[0]!.payload.cwd = "/different";
    },
  ],
  [
    "missing ordinal",
    (f) => {
      f.records[3]!.ordinal = 7;
    },
  ],
  [
    "different function",
    (f) => {
      f.records[2]!.payload.name = "shell_command";
    },
  ],
  [
    "different requested command",
    (f) => {
      f.records[2]!.payload.arguments = '{"cmd":"cat review-fixture.js"}';
    },
  ],
  [
    "different requested workdir",
    (f) => {
      f.records[2]!.payload.arguments = JSON.stringify({
        cmd: f.options.expectedCommand,
        workdir: "/different",
      });
    },
  ],
  [
    "different call turn",
    (f) => {
      f.records[2]!.payload.internal_chat_message_metadata_passthrough = { turn_id: "other" };
    },
  ],
  [
    "different command thread",
    (f) => {
      f.records[3]!.payload.thread_id = "other";
    },
  ],
  [
    "different command turn",
    (f) => {
      f.records[3]!.payload.turn_id = "other";
    },
  ],
  [
    "different completed call",
    (f) => {
      f.item(3).id = "other-call";
    },
  ],
  [
    "different executed argv",
    (f) => {
      f.item(3).command = ["/bin/bash", "-lc", "cat review-fixture.js"];
    },
  ],
  [
    "extra executed argument",
    (f) => {
      f.item(3).command = ["/bin/bash", "-lc", f.options.expectedCommand, "extra"];
    },
  ],
  [
    "different command cwd",
    (f) => {
      f.item(3).cwd = "file:///different";
    },
  ],
  [
    "failed command despite spoofed success text",
    (f) => {
      f.item(3).status = "failed";
      f.item(3).aggregated_output = `Process exited with code 0\nOutput:\n${f.options.marker}`;
    },
  ],
  [
    "nonzero command exit",
    (f) => {
      f.item(3).exit_code = 1;
    },
  ],
  [
    "missing command marker",
    (f) => {
      f.item(3).aggregated_output = "no fixture output";
    },
  ],
  [
    "different result call",
    (f) => {
      f.records[4]!.payload.call_id = "other-call";
    },
  ],
  [
    "different result turn",
    (f) => {
      f.records[4]!.payload.internal_chat_message_metadata_passthrough = { turn_id: "other" };
    },
  ],
  [
    "missing model-facing result body",
    (f) => {
      delete f.records[4]!.payload.output;
    },
  ],
  [
    "empty model-facing result body",
    (f) => {
      f.records[4]!.payload.output = "";
    },
  ],
  [
    "truncated model-facing fixture marker",
    (f) => {
      f.records[4]!.payload.output = `Output:\n${f.options.marker.slice(0, -1)}`;
    },
  ],
  [
    "stale agent answer",
    (f) => {
      f.item(5).content = [{ type: "Text", text: '{"summary":"stale"}' }];
    },
  ],
  [
    "payload whitespace mismatch",
    (f) => {
      f.item(5).content = [{ type: "Text", text: ` ${f.options.finalDecisionText}` }];
    },
  ],
  [
    "different final thread",
    (f) => {
      f.records[5]!.payload.thread_id = "other";
    },
  ],
  [
    "different terminal turn",
    (f) => {
      f.records[6]!.payload.turn_id = "other";
    },
  ],
  [
    "failed terminal turn",
    (f) => {
      f.records[6]!.payload.error = { message: "failed" };
    },
  ],
  [
    "ambiguous terminal error field",
    (f) => {
      f.records[6]!.payload.error = null;
    },
  ],
  [
    "stale terminal answer",
    (f) => {
      f.records[6]!.payload.last_agent_message = '{"summary":"stale"}';
    },
  ],
];

for (const [name, mutate] of traceMutations) {
  test(`hosted review trace rejects ${name}`, () => {
    const fixture = nativeTraceFixture();
    mutate(fixture);
    assert.throws(fixture.invoke);
  });
}

for (const [name, index] of [
  ["session", 0],
  ["turn start", 1],
  ["call", 2],
  ["command", 3],
  ["result", 4],
  ["final answer", 5],
  ["terminal turn", 6],
] as const) {
  test(`hosted review trace rejects a missing or duplicate ${name}`, () => {
    for (const duplicate of [false, true]) {
      const fixture = nativeTraceFixture();
      fixture.records.splice(
        index,
        duplicate ? 0 : 1,
        ...(duplicate ? [structuredClone(fixture.records[index]!)] : []),
      );
      fixture.records.forEach((record, ordinal) => {
        record.ordinal = ordinal;
      });
      assert.throws(fixture.invoke);
    }
  });
}

test("hosted review trace rejects extra tools, aborts, and reordered evidence", () => {
  for (const kind of ["Plan", "McpToolCall", "FileChange", "WebSearch"]) {
    const fixture = nativeTraceFixture();
    const extra = structuredClone(fixture.records[3]!);
    extra.payload.item = { type: kind, id: "additional-tool" };
    fixture.records.splice(3, 0, extra);
    fixture.records.forEach((record, ordinal) => {
      record.ordinal = ordinal;
    });
    assert.throws(fixture.invoke, /additional tool/);
  }
  const aborted = nativeTraceFixture();
  aborted.records[6]!.payload.type = "turn_aborted";
  assert.throws(aborted.invoke, /unexpected event or abort/);

  for (const type of ["custom_tool_call", "local_shell_call", "web_search_call"]) {
    const fixture = nativeTraceFixture();
    const extra = structuredClone(fixture.records[2]!);
    extra.payload.type = type;
    fixture.records.splice(3, 0, extra);
    fixture.records.forEach((record, ordinal) => {
      record.ordinal = ordinal;
    });
    assert.throws(fixture.invoke, /additional tool/);
  }

  for (const [first, second] of [
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
  ]) {
    const fixture = nativeTraceFixture();
    [fixture.records[first!], fixture.records[second!]] = [
      fixture.records[second!]!,
      fixture.records[first!]!,
    ];
    fixture.records.forEach((record, ordinal) => {
      record.ordinal = ordinal;
    });
    assert.throws(fixture.invoke);
  }
});

test("hosted review trace rejects incomplete, oversized, invalid, or stale rollout bytes", () => {
  const fixture = nativeTraceFixture();
  const valid = fixture.rollout();
  for (const bytes of [
    valid.bytes.subarray(0, -1),
    Buffer.concat([valid.bytes, Buffer.from("{broken}\n")]),
    Buffer.from([0xff, 0x0a]),
    Buffer.from("x".repeat(HOSTED_REVIEW_ROLLOUT_MAX_BYTES + 1)),
    Buffer.from(JSON.stringify({ ordinal: 0, text: "x".repeat(512 * 1024) }) + "\n"),
    Buffer.from("{}\n".repeat(4097)),
  ]) {
    assert.throws(() =>
      summarizeHostedReviewTrace({ ...fixture.options, rollout: { ...valid, bytes } }),
    );
  }
  assert.throws(
    () =>
      summarizeHostedReviewTrace({
        ...fixture.options,
        rollout: { ...valid, path: "stale.jsonl" },
      }),
    /session path mismatch/,
  );
});

test("hosted rollout discovery accepts exactly one new regular file and leaves prior state alone", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hosted-rollout-test-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(snapshotHostedReviewRollouts(home), []);
  const sessions = join(home, "sessions", "2026", "09", "09");
  mkdirSync(sessions, { recursive: true });
  const oldPath = join(sessions, "rollout-old.jsonl");
  writeFileSync(oldPath, "retained prior session\n");
  const before = snapshotHostedReviewRollouts(home);
  assert.throws(() => readHostedReviewRollout(home, before), /exactly one new rollout/);
  const candidate = join(sessions, "rollout-new.jsonl");
  writeFileSync(candidate, "new native session\n");
  const rollout = readHostedReviewRollout(home, before);
  assert.equal(rollout.path, candidate);
  assert.equal(rollout.bytes.toString(), "new native session\n");
  assert.equal(readFileSync(oldPath, "utf8"), "retained prior session\n");
  writeFileSync(join(sessions, "rollout-extra.jsonl"), "ambiguous\n");
  assert.throws(() => readHostedReviewRollout(home, before), /exactly one new rollout/);
  rmSync(oldPath);
  assert.throws(() => readHostedReviewRollout(home, before), /existing rollout paths changed/);
});

test("hosted rollout discovery refuses oversized files without reading them", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hosted-rollout-size-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "sessions"));
  const path = join(home, "sessions", "rollout-large.jsonl");
  writeFileSync(path, "");
  truncateSync(path, HOSTED_REVIEW_ROLLOUT_MAX_BYTES + 1);
  assert.throws(() => readHostedReviewRollout(home, []), /rollout bytes exceeded/);
});

test("hosted rollout discovery bounds directory depth and path inventory", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hosted-rollout-inventory-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sessions = join(home, "sessions");
  mkdirSync(join(sessions, "a", "b", "c", "d", "e"), { recursive: true });
  assert.throws(() => snapshotHostedReviewRollouts(home), /directory depth exceeded/);
  rmSync(sessions, { recursive: true });
  mkdirSync(sessions);
  for (let index = 0; index < 513; index += 1)
    writeFileSync(join(sessions, `rollout-${index}.jsonl`), "");
  assert.throws(() => snapshotHostedReviewRollouts(home), /path inventory exceeded/);
});

test(
  "hosted rollout discovery refuses symlinked homes, directories, and files",
  { skip: process.platform === "win32" },
  (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hosted-rollout-links-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const outside = join(root, "outside");
    mkdirSync(home);
    mkdirSync(outside);
    symlinkSync(home, join(root, "home-link"));
    assert.throws(() => snapshotHostedReviewRollouts(join(root, "home-link")), /symlink/);
    symlinkSync(outside, join(home, "sessions"));
    assert.throws(() => snapshotHostedReviewRollouts(home), /unsafe canary rollout directory/);
    rmSync(join(home, "sessions"));
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(outside, "existing.jsonl"), "preserve\n");
    symlinkSync(join(outside, "existing.jsonl"), join(home, "sessions", "rollout-link.jsonl"));
    assert.throws(() => readHostedReviewRollout(home, []), /symlink/);
    assert.equal(readFileSync(join(outside, "existing.jsonl"), "utf8"), "preserve\n");
  },
);

test("hosted review output must match the checked-in schema", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["nextStep", "score"],
    properties: {
      nextStep: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "text"],
            properties: {
              kind: { type: "string", const: "none" },
              text: { type: "string", const: "" },
            },
          },
        ],
      },
      score: { type: "number", exclusiveMinimum: 0, maximum: 1 },
    },
  };
  assertMatchesJsonSchema({ nextStep: { kind: "none", text: "" }, score: 0.75 }, schema);
  assert.throws(() => assertMatchesJsonSchema({ score: 0.75 }, schema), /nextStep is required/);
  assert.throws(
    () => assertMatchesJsonSchema({ nextStep: { kind: "none", text: "" }, score: 2 }, schema),
    /above its maximum/,
  );
});

test("hosted review artifacts reject string payloads", () => {
  assert.throws(
    () => assertBooleanCountArtifact({ safe: true, leaked: "raw transcript" }),
    /only booleans and integer counts/,
  );
});

test("hosted review failures withhold private diagnostics", () => {
  const privateMarker = "a36a5710-0818-4680-969c-86496901b59f";
  assert.throws(
    () =>
      runWithWithheldDiagnostics("Hosted review failed; diagnostics withheld.", () => {
        throw new Error(`provider output ${privateMarker}`);
      }),
    (error: Error) => {
      assert.equal(error.message, "Hosted review failed; diagnostics withheld.");
      assert.doesNotMatch(error.message, new RegExp(privateMarker));
      return true;
    },
  );
});

test("hosted multiline provider accepts one bounded plain or gzip Responses request", async () => {
  for (const compressed of [false, true]) {
    const body = Buffer.from(JSON.stringify({ model: "gpt-5.4" }));
    const request = Object.assign(Readable.from([compressed ? gzipSync(body) : body]), {
      method: "POST",
      url: "/v1/responses",
      headers: compressed ? { "content-encoding": "gzip" } : {},
    });
    await assertHostedMultilineRequest(request, 1);
  }
});

test("hosted multiline provider rejects invalid requests before native proof can pass", async () => {
  const body = Buffer.from(JSON.stringify({ model: "gpt-5.4" }));
  for (const change of [
    { method: "GET" },
    { url: "/other" },
    { headers: { authorization: "fixture-credential" } },
    { headers: { "content-encoding": "deflate" } },
    { count: 2 },
    { bytes: Buffer.alloc(1024 * 1024 + 1) },
    { bytes: gzipSync(Buffer.alloc(1024 * 1024 + 1)), headers: { "content-encoding": "gzip" } },
    { bytes: Buffer.from([0xff]) },
    { bytes: Buffer.from("{invalid") },
    { bytes: Buffer.from('{"model":"unexpected"}') },
  ]) {
    const request = Object.assign(Readable.from([change.bytes ?? body]), {
      method: "POST",
      url: "/v1/responses",
      headers: {},
      ...change,
    });
    await assert.rejects(assertHostedMultilineRequest(request, change.count ?? 1));
  }
});

function multilineFailureFixture() {
  class CodexReviewError extends Error {
    name = "CodexReviewError";
    status = 1;
    signal: string | null = null;
    errorCode: string | null = null;
    stdout = "";
    stderr = `ERROR: rate limit exceeded: ${HOSTED_MULTILINE_PROVIDER_ERROR}\n`;
    diagnostic = codexHumanFailureDetail(this.stderr);
    retryHint = codexHumanRetryHint(this.stderr);
    retryable = true;
  }
  return {
    error: new CodexReviewError("Codex review failed with exit 1."),
    decision: {
      codexTerminalFailure: false,
      summary: "Codex review failed: retryable codex transport failure (capacity) (exit 1).",
      evidence: [{ label: "codex retry hint", detail: "Non-authoritative; see stderr evidence." }],
    },
    observations: { resultExists: false, checkoutUnchanged: true },
  };
}

test("hosted multiline proof accepts the pinned native formatter and emits only counts and booleans", () => {
  const { error, decision, observations } = multilineFailureFixture();
  assert.equal(error.retryHint, HOSTED_MULTILINE_RETRY_HINT);
  assert.equal(error.diagnostic, "");
  const proof = summarizeHostedMultilineFailure(error, decision, observations);
  assertBooleanCountArtifact(proof);
  assert.equal(proof.nativeMultilineFailureCount, 1);
  assert.equal(proof.nativeMultilineTerminalDenial, false);
});

test("hosted multiline proof rejects incomplete, terminal, or synthetic failure evidence", () => {
  for (const change of [
    { status: 0 },
    { signal: "SIGTERM" },
    { errorCode: "ETIMEDOUT" },
    { stdout: "{}" },
    { diagnostic: "trusted terminal denial" },
    { retryHint: "" },
    { retryHint: HOSTED_MULTILINE_RETRY_HINT.replace(/^ERROR: /, "") },
    { retryHint: HOSTED_MULTILINE_PROVIDER_ERROR },
    { stderr: "" },
    { retryable: false },
    { message: HOSTED_MULTILINE_PROVIDER_ERROR },
  ]) {
    const { error, decision, observations } = multilineFailureFixture();
    Object.assign(error, change);
    assert.throws(() => summarizeHostedMultilineFailure(error, decision, observations));
  }
  const { error, decision, observations } = multilineFailureFixture();
  assert.throws(() => summarizeHostedMultilineFailure({ ...error }, decision, observations));
  assert.throws(() =>
    summarizeHostedMultilineFailure(new Error(error.message), decision, observations),
  );
  for (const change of [
    { codexTerminalFailure: true },
    { summary: "model unavailable or access denied" },
    { evidence: [] },
    { evidence: [...decision.evidence, { label: "codex terminal error", detail: "denied" }] },
  ]) {
    assert.throws(() =>
      summarizeHostedMultilineFailure(error, { ...decision, ...change }, observations),
    );
  }
  for (const change of [{ resultExists: true }, { checkoutUnchanged: false }]) {
    assert.throws(() =>
      summarizeHostedMultilineFailure(error, decision, { ...observations, ...change }),
    );
  }
});

test("hosted blob proof requires the real outer CLI and exact sanitized child starts", () => {
  const repo = "steipete/camsnap";
  const item = 990_001;
  const temporaryRoot = "/tmp/fixture-owned-tmp";
  const outer = {
    command: "live-proof-review",
    args: ["--repo", repo, "--item", String(item)],
    temporaryRoot,
  };
  const scratch = join(temporaryRoot, `clawsweeper-live-proof-${item}-fixture`);
  const child = {
    command: "live-proof",
    args: [...outer.args, "--output", join(scratch, "bundle")],
    temporaryRoot: join(scratch, "profile", "tmp"),
  };
  assertHostedBlobStarts([outer], repo, item, 0, temporaryRoot);
  assertHostedBlobStarts([outer, child], repo, item, 1, temporaryRoot);
  for (const starts of [
    [],
    [child],
    [outer],
    [outer, child, child],
    [child, outer],
    [outer, { ...child, args: ["--repo", "other/repo", "--item", String(item)] }],
    [outer, { ...child, args: ["--repo", repo, "--item", "1"] }],
    [outer, { ...child, temporaryRoot: "/tmp/other-fixture" }],
    [outer, { ...child, temporaryRoot }],
    [outer, { ...child, args: [...outer.args, "--output", "/tmp/other-fixture/bundle"] }],
    [outer, { ...child, args: [...outer.args, "--output", join(scratch, "other")] }],
    [{ ...outer, temporaryRoot: "/tmp/other-fixture" }, child],
  ]) {
    assert.throws(() => assertHostedBlobStarts(starts, repo, item, 1, temporaryRoot));
  }
  assert.throws(() => assertHostedBlobStarts([outer, child], repo, item, 0, temporaryRoot));
});

test("hosted changed-surface proof keeps native execution and passive blob observations", () => {
  const source = readFileSync(
    new URL("../scripts/hosted-review-scan-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /sandboxMode: "read-only"/);
  assert.match(source, /await assertHostedMultilineRequest\(request, \+\+requests\)/);
  assert.match(source, /summarizeHostedMultilineFailure\(failure, decision/);
  assert.match(source, /NODE_OPTIONS: `--import=\$\{pathToFileURL\(preload\)\.href\}`/);
  assert.match(source, /env: sanitizedLiveProofEnvironment\(env\)/);
  assert.match(source, /for \(const truncated of \[true, false\]\)/);
  assert.match(source, /const child = spawn\(process\.execPath, args,/);
  assert.match(
    source,
    /assertHostedBlobStarts\(starts, repo, itemNumber, truncated \? 0 : 1, temporaryRoot\)/,
  );
  assert.match(source, /TMPDIR: temporaryRoot/);
  assert.match(source, /GIT_NO_LAZY_FETCH: "1"/);
  assert.match(
    source,
    /execFileSync\(\s*gitExecutable,\s*\[\s*"clone",[\s\S]*?pathToFileURL\(origin\)\.href,[\s\S]*?GIT_NO_LAZY_FETCH: "0"/,
  );
  assert.match(source, /"fetch",[\s\S]*?assert\.equal\(missing\(\), true\)/);
  assert.match(source, /if \(fixtureQuiescent\) rmSync\(root/);
  assert.doesNotMatch(source, /process\.kill\(-child\.pid, "SIGKILL"\)/);
  assert.match(
    source,
    /return withHostedFixtureSignals\(refuse, async \(\) => \{[\s\S]*?child = spawn\(/,
  );
  assert.match(
    source,
    /await withHostedFixtureSignals\(refuse, async \(\) => \{\s*const child = spawn\(/,
  );
});

async function hostedSentinel() {
  const child = spawn(
    process.execPath,
    [
      "--eval",
      `
process.on("SIGTERM", () => {});
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const closed = once(child, "close");
  await once(child.stdout, "data");
  const identity = hostedProcessIdentity(child.pid);
  assert.ok(identity);
  return { child, closed, identity };
}

async function finishHostedSentinel(sentinel: Awaited<ReturnType<typeof hostedSentinel>>) {
  if (sentinel.child.exitCode === null && sentinel.child.signalCode === null) {
    process.kill(-sentinel.identity.pid, "SIGKILL");
  }
  await sentinel.closed;
}

for (const scenario of [
  { signal: "SIGINT", late: false, unknown: false },
  { signal: "SIGTERM", late: false, unknown: false },
  { signal: "SIGTERM", late: true, unknown: false },
  { signal: "SIGINT", late: false, unknown: true },
] as const) {
  test(
    `hosted controller ${scenario.signal} latches through cleanup late=${scenario.late} unknown=${scenario.unknown}`,
    { skip: process.platform !== "linux", timeout: 15_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "hosted-signal-lifecycle-"));
      const foreign = await hostedSentinel();
      const helper = new URL("../scripts/hosted-review-canary-proof.mjs", import.meta.url).href;
      const source = `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostedProcessIdentity, stopHostedNativeGroup, withHostedFixtureSignals } from ${JSON.stringify(helper)};
const root = ${JSON.stringify(root)};
const scenario = ${JSON.stringify(scenario)};
const artifact = join(root, "proof.json");
let finishCleanup, releaseController, resolveAbort;
const cleanupReleased = new Promise(resolve => { finishCleanup = resolve; });
const controllerReleased = new Promise(resolve => { releaseController = resolve; });
const aborted = new Promise(resolve => { resolveAbort = resolve; });
process.on("message", message => {
  if (message === "finish-cleanup") finishCleanup();
  if (message === "release-controller") releaseController();
});
const unrelatedInt = () => process.send({ event: "signal", signal: "SIGINT" });
const unrelatedTerm = () => process.send({ event: "signal", signal: "SIGTERM" });
process.on("SIGINT", unrelatedInt);
process.on("SIGTERM", unrelatedTerm);
let owned, identity, closed, cleanupCount = 0, refusals = 0, quiescent = false;
try {
  const proof = await withHostedFixtureSignals(() => {
    refusals += 1;
    resolveAbort();
    process.send({ event: "refused" });
  }, async () => {
    owned = spawn(process.execPath, ["--eval", "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000);"], {
      detached: true, stdio: ["ignore", "pipe", "ignore"],
    });
    closed = once(owned, "close");
    await once(owned.stdout, "data");
    identity = hostedProcessIdentity(owned.pid);
    process.send({ event: "ready", identity });
    try {
      if (!scenario.late) await aborted;
      return { passed: true };
    } finally {
      cleanupCount += 1;
      process.send({ event: "cleanup" });
      await cleanupReleased;
      await stopHostedNativeGroup(scenario.unknown ? { ...identity, start: "mismatched" } : identity);
      await closed;
      quiescent = true;
    }
  });
  writeFileSync(artifact, JSON.stringify(proof));
} catch {
  process.exitCode = 1;
} finally {
  if (quiescent) rmSync(root, { recursive: true, force: true });
  process.send({
    event: "finished", cleanupCount, refusals,
    rootRetained: existsSync(root), artifactExists: existsSync(artifact),
    unrelatedListenersPreserved: process.listeners("SIGINT").includes(unrelatedInt) &&
      process.listeners("SIGTERM").includes(unrelatedTerm),
    ownListenersRemoved: process.listenerCount("SIGINT") === 1 && process.listenerCount("SIGTERM") === 1,
  });
  if (!quiescent) await controllerReleased;
  process.disconnect();
}
`;
      const controller = spawn(process.execPath, ["--input-type=module", "--eval", source], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const closed = once(controller, "close");
      const controllerIdentity = hostedProcessIdentity(controller.pid);
      assert.ok(controllerIdentity);
      type SignalMessage = {
        event: string;
        identity?: NonNullable<ReturnType<typeof hostedProcessIdentity>>;
        cleanupCount?: number;
        refusals?: number;
        artifactExists?: boolean;
        rootRetained?: boolean;
        unrelatedListenersPreserved?: boolean;
        ownListenersRemoved?: boolean;
      };
      const messages: SignalMessage[] = [];
      controller.on("message", (message) => messages.push(message as SignalMessage));
      const waitFor = async (predicate: () => boolean) => {
        const deadline = Date.now() + 10_000;
        while (!predicate()) {
          assert.ok(Date.now() < deadline, "hosted signal controller did not reach its checkpoint");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      let ownedIdentity;
      try {
        await waitFor(() => messages.some((message) => message.event === "ready"));
        ownedIdentity = messages.find((message) => message.event === "ready")!.identity;
        assert.ok(ownedIdentity);
        if (scenario.late) {
          await waitFor(() => messages.some((message) => message.event === "cleanup"));
        }
        process.kill(controller.pid!, scenario.signal);
        await waitFor(() => messages.some((message) => message.event === "cleanup"));
        await waitFor(() => messages.some((message) => message.event === "refused"));
        process.kill(controller.pid!, "SIGINT");
        process.kill(controller.pid!, "SIGTERM");
        await waitFor(() => messages.filter((message) => message.event === "signal").length === 3);
        controller.send("finish-cleanup");
        await waitFor(() => messages.some((message) => message.event === "finished"));
        const finished = messages.find((message) => message.event === "finished")!;
        assert.equal(finished.cleanupCount, 1);
        assert.equal(finished.refusals, 1);
        assert.equal(finished.artifactExists, false);
        assert.equal(finished.rootRetained, scenario.unknown);
        assert.equal(finished.unrelatedListenersPreserved, true);
        assert.equal(finished.ownListenersRemoved, true);
        if (scenario.unknown) {
          assert.deepEqual(hostedProcessIdentity(ownedIdentity.pid), ownedIdentity);
          await stopHostedNativeGroup(ownedIdentity);
          controller.send("release-controller");
        }
        assert.deepEqual(await closed, [1, null]);
        assertHostedProcessGroupGone(ownedIdentity);
        assert.deepEqual(hostedProcessIdentity(foreign.identity.pid), foreign.identity);
      } finally {
        if (ownedIdentity && hostedProcessIdentity(ownedIdentity.pid)) {
          await stopHostedNativeGroup(ownedIdentity);
        }
        if (controller.connected) controller.send("release-controller");
        if (controller.exitCode === null && controller.signalCode === null) {
          await stopHostedNativeGroup(controllerIdentity);
        }
        await closed;
        await finishHostedSentinel(foreign);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

test(
  "hosted native abort revalidates its launch and reaps only its recorded group",
  {
    skip: process.platform !== "linux",
    timeout: 10_000,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-native-lifecycle-"));
    const owned = await hostedSentinel();
    const foreign = await hostedSentinel();
    const nonce = randomUUID();
    const path = join(root, "launches.jsonl");
    try {
      recordHostedLifecycle(path, {
        kind: "native",
        fixtureNonce: nonce,
        identity: owned.identity,
      });
      const records = readHostedLifecycle(path, nonce);
      assert.throws(() => assertHostedNativeQuiescent(records));
      await assert.rejects(stopHostedNativeGroup({ ...owned.identity, start: "1" }));
      assert.deepEqual(hostedProcessIdentity(owned.identity.pid), owned.identity);
      await stopHostedNativeGroup(records[0].identity);
      await owned.closed;
      assertHostedNativeQuiescent(records);
      assertHostedProcessGroupGone(owned.identity);
      assert.deepEqual(hostedProcessIdentity(foreign.identity.pid), foreign.identity);
    } finally {
      await finishHostedSentinel(owned);
      await finishHostedSentinel(foreign);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("hosted lifecycle readers refuse missing, symlinked, mismatched, and incomplete receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "hosted-receipts-"));
  const path = join(root, "receipt.jsonl");
  const nonce = randomUUID();
  try {
    assert.throws(() => readHostedLifecycle(path, nonce));
    recordHostedLifecycle(path, { fixtureNonce: nonce, kind: "native" });
    assert.throws(() => readHostedLifecycle(path, randomUUID()));
    const link = join(root, "link");
    symlinkSync(path, link);
    assert.throws(() => readHostedLifecycle(link, nonce));
    for (const text of ["", "{", '{"fixtureNonce":"' + nonce + '"}', "x".repeat(16 * 1024 + 1)]) {
      writeFileSync(path, text);
      assert.throws(() => readHostedLifecycle(path, nonce));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function hostedTerminalRecords() {
  const fixtureNonce = randomUUID();
  const nonce = randomUUID();
  const identity = `${nonce}|123|/dev/pts/1|1:2`;
  const shared = {
    kind: "terminal",
    fixtureNonce,
    socket: "/tmp/fixture-owned-socket",
    socketIdentity: "3:4",
    server: { pid: 321, pgid: 321, start: "10" },
    session: "$0",
    lease: "/tmp/fixture-owned-lease",
    request: "/tmp/fixture-owned-request",
    result: "/tmp/fixture-owned-result",
  };
  return [
    {
      ...shared,
      publication: `v1|armed|${identity}|456\n`,
      watchdog: { pid: 456, pgid: 456, start: "20" },
    },
    { ...shared, publication: `v1|done|${identity}|controller|ok|0\n` },
  ];
}

test("hosted terminal cleanup requires its exact armed and successful done publications", () => {
  const records = hostedTerminalRecords();
  assert.equal(assertHostedTerminalDone(records), records[0]);
  for (const changed of [
    [],
    [records[0]],
    [records[1], records[0]],
    [records[0], { ...records[1], fixtureNonce: randomUUID() }],
    [records[0], { ...records[1], session: "$1" }],
    [records[0], { ...records[1], socketIdentity: "3:5" }],
    [
      records[0],
      { ...records[1], publication: records[1].publication.replace("|ok|0", "|error:survivors|1") },
    ],
    [records[0], { ...records[1], publication: records[1].publication.replace("|1:2|", "|1:3|") }],
    [{ ...records[0], watchdog: null }, records[1]],
  ])
    assert.throws(() => assertHostedTerminalDone(changed));
});

test(
  "hosted done observation follows the original published-result read before immediate teardown",
  {
    skip: process.platform !== "linux",
    timeout: 10_000,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-read-observer-"));
    const receipt = join(root, "receipt.jsonl");
    const entrypoint = join(root, "controller.mjs");
    const preload = join(root, "preload.mjs");
    const startsPath = join(root, "starts.jsonl");
    const [armed, done] = hostedTerminalRecords();
    armed.result = join(root, "proof.cleanup.result");
    done.result = armed.result;
    try {
      recordHostedLifecycle(receipt, armed);
      writeFileSync(
        preload,
        hostedBlobPreloadSource({
          entrypoint,
          startsPath,
          terminalReceipts: receipt,
          nonce: armed.fixtureNonce,
        }),
      );
      writeFileSync(
        entrypoint,
        `
import assert from "node:assert/strict";
import fs from "node:fs";
const receipt = ${JSON.stringify(receipt)};
const result = ${JSON.stringify(armed.result)};
const publication = ${JSON.stringify(done.publication)};
const count = () => fs.readFileSync(receipt, "utf8").trim().split("\\n").length;
const read = (path) => {
  const fd = fs.openSync(path, "r");
  try {
    const buffer = Buffer.alloc(513);
    const bytes = fs.readSync(fd, buffer, 0, 513, 0);
    assert.equal(buffer.subarray(0, bytes).toString(), fs.readFileSync(path, "utf8"));
    return bytes;
  } finally { fs.closeSync(fd); }
};
fs.writeFileSync(result + ".tmp", publication);
read(result + ".tmp");
assert.equal(count(), 1, "temporary intent is not publication");
assert.throws(() => fs.renameSync(result + ".absent", result));
assert.equal(count(), 1, "failed rename is not publication");
fs.writeFileSync(result + ".wrong", publication);
read(result + ".wrong");
assert.equal(count(), 1, "wrong path is not publication");
fs.writeFileSync(result, publication.replace("|1:2|", "|1:3|"));
read(result);
assert.equal(count(), 1, "wrong identity is not publication");
fs.renameSync(result + ".tmp", result);
assert.equal(read(result), Buffer.byteLength(publication));
assert.equal(count(), 2);
read(result);
assert.equal(count(), 2, "publication must be recorded once");
fs.rmSync(result);
assert.equal(count(), 2, "immediate owner teardown must not erase the observation");
const closed = fs.openSync(receipt, "r");
fs.closeSync(closed);
assert.throws(() => fs.readSync(closed, Buffer.alloc(513), 0, 513, 0), { code: "EBADF" });
`,
      );
      execFileSync(process.execPath, [entrypoint, "live-proof"], {
        env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
        timeout: 5000,
        maxBuffer: 4096,
      });
      assertHostedTerminalDone(readHostedLifecycle(receipt, armed.fixtureNonce));
      assert.equal(existsSync(armed.result), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "hosted actual review CLI keeps its TMPDIR and waits for the watchdog before ending its private session",
  {
    skip: process.platform !== "linux",
    timeout: 30_000,
  },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-terminal-lifecycle-"));
    const receiptPath = join(root, "terminal.jsonl");
    const observer = join(root, "observer.sh");
    const preload = join(root, "preload.mjs");
    const startsPath = join(root, "starts.jsonl");
    const temporaryRoot = join(root, "tmp");
    const checkout = join(root, "checkout");
    const recordsDir = join(root, "records");
    const output = join(root, "output");
    const entrypoint = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));
    for (const directory of [temporaryRoot, checkout, recordsDir]) mkdirSync(directory);
    const nonce = randomUUID();
    const foreign = await hostedSentinel();
    writeFileSync(observer, hostedTerminalObserverSource(receiptPath, nonce));
    writeFileSync(
      preload,
      hostedBlobPreloadSource({
        entrypoint,
        startsPath,
        terminalReceipts: receiptPath,
        nonce,
      }),
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: checkout,
        encoding: "utf8",
      }).trim();
    git("init", "-q", "--initial-branch=main");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    const head = git("rev-parse", "HEAD");
    writeFileSync(
      join(recordsDir, "990001.md"),
      `---\nnumber: 990001\nrepository: steipete/camsnap\ntype: pull_request\npull_head_sha: ${head}\n---\n\n## Live Proof\n\nStatus: recommended\n\nSurface: terminal\n\nTerminal completion: exit_zero\n\nReason: Exercise cleanup.\n\nPayoff: static_text\n\nPayoff justification: Text is sufficient.\n\nEntry: sleep 60\n\nSteps:\n\n- {"action":"expect_output","text":"never"}\n\n## Work Candidate\n\nCandidate: none\n`,
    );
    const child = spawn(
      process.execPath,
      [
        entrypoint,
        "live-proof-review",
        "--repo",
        "steipete/camsnap",
        "--records-dir",
        recordsDir,
        "--checkout",
        checkout,
        "--output",
        output,
        "--item",
        "990001",
      ],
      {
        env: {
          ...process.env,
          TMPDIR: temporaryRoot,
          BASH_ENV: observer,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const closed = once(child, "close");
    let records;
    try {
      const end = Date.now() + 10_000;
      while (!existsSync(receiptPath)) {
        assert.ok(Date.now() < end, "unchanged watchdog did not publish its armed identity");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      records = readHostedLifecycle(receiptPath, nonce);
      assert.equal(records.length, 1);
      assertHostedBlobStarts(
        readFileSync(startsPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
        "steipete/camsnap",
        990001,
        1,
        temporaryRoot,
      );
      assert.ok(records[0].lease.startsWith(temporaryRoot + "/"));
      const original = readFileSync(receiptPath);
      const mismatched = { ...records[0], socketIdentity: "0:0" };
      writeFileSync(receiptPath, JSON.stringify(mismatched) + "\n");
      const tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
      await assert.rejects(stopHostedTerminal({ path: receiptPath, nonce, tmux }));
      assert.equal(existsSync(records[0].request), false);
      assert.deepEqual(hostedProcessIdentity(foreign.identity.pid), foreign.identity);
      writeFileSync(receiptPath, original);
      await stopHostedTerminal({ path: receiptPath, nonce, tmux });
      await closed;
      records = readHostedLifecycle(receiptPath, nonce);
      assertHostedTerminalDone(records);
      await assertHostedTerminalQuiescent(records);
      assert.deepEqual(hostedProcessIdentity(foreign.identity.pid), foreign.identity);
    } finally {
      await finishHostedSentinel(foreign);
      // An unproven terminal lifecycle must keep its exact fixture for diagnosis.
      if (child.exitCode !== null || child.signalCode !== null) {
        await closed;
        if (records?.length === 2) rmSync(root, { recursive: true, force: true });
      } else child.unref();
    }
  },
);
