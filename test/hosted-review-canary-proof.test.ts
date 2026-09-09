import assert from "node:assert/strict";
import {
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
import { pathToFileURL } from "node:url";

import {
  assertBooleanCountArtifact,
  assertMatchesJsonSchema,
  HOSTED_REVIEW_ROLLOUT_MAX_BYTES,
  readHostedReviewRollout,
  runWithWithheldDiagnostics,
  snapshotHostedReviewRollouts,
  summarizeHostedReviewTrace,
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
