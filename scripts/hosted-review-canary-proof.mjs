import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const HOSTED_REVIEW_ROLLOUT_MAX_BYTES = 4 * 1024 * 1024;
const ROLLOUT_RECORD_MAX_BYTES = 512 * 1024;
const ROLLOUT_MAX_RECORDS = 4096;
const CODEX_VERSION = "0.153.3";

export function assertMatchesJsonSchema(value, schema, path = "$") {
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((candidate) => {
      try {
        assertMatchesJsonSchema(value, candidate, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(matches.length > 0, `${path} did not match any allowed schema`);
  }
  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
    assert.ok(
      allowedTypes.includes(actualType) ||
        (actualType === "integer" && allowedTypes.includes("number")),
      `${path} has invalid type`,
    );
  }
  if (schema.const !== undefined)
    assert.deepEqual(value, schema.const, `${path} has invalid value`);
  if (schema.enum) {
    assert.ok(
      schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)),
      `${path} has invalid enum value`,
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${path}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) assertMatchesJsonSchema(value[key], child, `${path}.${key}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined)
      assert.ok(value.length >= schema.minItems, `${path} has too few items`);
    if (schema.maxItems !== undefined)
      assert.ok(value.length <= schema.maxItems, `${path} has too many items`);
    if (schema.items) {
      value.forEach((entry, index) =>
        assertMatchesJsonSchema(entry, schema.items, `${path}[${index}]`),
      );
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined)
      assert.ok(value.length >= schema.minLength, `${path} is too short`);
    if (schema.maxLength !== undefined)
      assert.ok(value.length <= schema.maxLength, `${path} is too long`);
    if (schema.pattern !== undefined)
      assert.match(value, new RegExp(schema.pattern, "u"), `${path} does not match its pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined)
      assert.ok(value >= schema.minimum, `${path} is below its minimum`);
    if (schema.maximum !== undefined)
      assert.ok(value <= schema.maximum, `${path} is above its maximum`);
    if (schema.exclusiveMinimum !== undefined)
      assert.ok(value > schema.exclusiveMinimum, `${path} is below its exclusive minimum`);
  }
}

export function snapshotHostedReviewRollouts(codexHome) {
  assert.ok(codexHome, "canary requires its isolated CODEX_HOME");
  const home = resolve(codexHome);
  assert.equal(realpathSync(home), home, "canary CODEX_HOME must not traverse a symlink");
  assert.ok(lstatSync(home).isDirectory(), "canary CODEX_HOME must be a directory");
  const root = join(home, "sessions");
  try {
    lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const paths = [];
  let entries = 0;
  const visit = (path, depth) => {
    assert.ok(depth <= 4, "canary rollout directory depth exceeded");
    const info = lstatSync(path);
    assert.ok(info.isDirectory() && !info.isSymbolicLink(), "unsafe canary rollout directory");
    const directory = opendirSync(path);
    try {
      for (let entry; (entry = directory.readSync()) !== null;) {
        assert.ok(++entries <= 512, "canary rollout path inventory exceeded");
        const child = join(path, entry.name);
        assert.ok(!entry.isSymbolicLink(), "canary rollout path is a symlink");
        if (entry.isDirectory()) visit(child, depth + 1);
        else {
          assert.ok(entry.isFile() && entry.name.endsWith(".jsonl"), "unexpected rollout path");
          paths.push(child);
        }
      }
    } finally {
      directory.closeSync();
    }
  };
  visit(root, 0);
  return paths.sort();
}

export function readHostedReviewRollout(codexHome, before) {
  const after = snapshotHostedReviewRollouts(codexHome);
  assert.ok(
    before.every((path) => after.includes(path)),
    "existing rollout paths changed",
  );
  const added = after.filter((path) => !before.includes(path));
  assert.equal(added.length, 1, "canary must create exactly one new rollout");
  const path = added[0];
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(file);
    assert.ok(initial.isFile(), "canary rollout must be a regular file");
    assert.ok(initial.size <= HOSTED_REVIEW_ROLLOUT_MAX_BYTES, "canary rollout bytes exceeded");
    const buffer = Buffer.alloc(initial.size + 1);
    let bytes = 0;
    for (;;) {
      const count = readSync(file, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
      assert.ok(bytes <= initial.size, "canary rollout changed while reading");
    }
    const final = lstatSync(path);
    assert.ok(
      final.isFile() &&
        final.dev === initial.dev &&
        final.ino === initial.ino &&
        final.size === bytes &&
        bytes === initial.size &&
        final.mtimeMs === initial.mtimeMs,
      "canary rollout changed while reading",
    );
    return { path, bytes: buffer.subarray(0, bytes) };
  } finally {
    closeSync(file);
  }
}

export function summarizeHostedReviewTrace({
  rollout,
  cwd,
  marker,
  expectedCommand,
  finalDecisionText,
  checkoutUnchanged,
}) {
  // The pinned CLI persists typed completed items in paginated rollouts.
  // Human stderr includes untrusted tool text and cannot establish tool success.
  assert.ok(
    rollout.bytes.length <= HOSTED_REVIEW_ROLLOUT_MAX_BYTES,
    "canary rollout bytes exceeded",
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(rollout.bytes);
  assert.ok(text.endsWith("\n"), "canary rollout is incomplete");
  const lines = text.slice(0, -1).split("\n");
  assert.ok(lines.length <= ROLLOUT_MAX_RECORDS, "canary rollout record count exceeded");
  const records = lines.map((line, index) => {
    assert.ok(
      Buffer.byteLength(line) <= ROLLOUT_RECORD_MAX_BYTES,
      "canary rollout record bytes exceeded",
    );
    const record = JSON.parse(line);
    assert.equal(record.ordinal, index, "canary rollout order is incomplete");
    assert.ok(
      [
        "session_meta",
        "event_msg",
        "response_item",
        "world_state",
        "turn_context",
        "token_usage_record",
      ].includes(record.type),
      "canary rollout contains an unexpected record",
    );
    return { ...record, index };
  });
  const metadata = records.filter((record) => record.type === "session_meta");
  assert.equal(metadata.length, 1, "canary rollout session is ambiguous");
  assert.equal(metadata[0].index, 0);
  const session = metadata[0].payload;
  assert.match(session.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(session.session_id, session.id);
  assert.ok(rollout.path.endsWith(`-${session.id}.jsonl`), "canary rollout session path mismatch");
  assert.equal(session.cli_version, CODEX_VERSION, "canary rollout version mismatch");
  assert.equal(session.source, "exec");
  assert.equal(session.originator, "codex_exec");
  assert.equal(session.history_mode, "paginated");
  assert.equal(session.cwd, cwd, "canary rollout cwd mismatch");
  const events = records.filter((record) => record.type === "event_msg");
  assert.ok(
    events.every((record) =>
      ["task_started", "item_completed", "token_count", "task_complete"].includes(
        record.payload.type,
      ),
    ),
    "canary rollout contains an unexpected event or abort",
  );
  const starts = events.filter((record) => record.payload.type === "task_started");
  const ends = events.filter((record) => record.payload.type === "task_complete");
  assert.equal(starts.length, 1, "canary must start exactly one turn");
  assert.equal(ends.length, 1, "canary must complete exactly one turn");
  const turn = starts[0].payload.turn_id;
  assert.match(turn, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(ends[0].payload.turn_id, turn);
  assert.ok(!Object.hasOwn(ends[0].payload, "error"), "canary terminal turn failed");
  assert.equal(ends[0].index, records.length - 1, "canary terminal record is not last");

  const responses = records.filter((record) => record.type === "response_item");
  assert.ok(
    responses.every((record) =>
      ["message", "reasoning", "function_call", "function_call_output"].includes(
        record.payload.type,
      ),
    ),
    "canary attempted an additional tool",
  );
  const calls = responses.filter((record) => record.payload.type === "function_call");
  const results = responses.filter((record) => record.payload.type === "function_call_output");
  assert.equal(calls.length, 1, "canary must attempt exactly one review tool");
  assert.equal(results.length, 1, "canary must receive exactly one tool result");
  const call = calls[0];
  assert.equal(call.payload.name, "exec_command", "canary must use the native command tool");
  assert.ok(typeof call.payload.call_id === "string" && call.payload.call_id.length > 0);
  assert.equal(call.payload.internal_chat_message_metadata_passthrough?.turn_id, turn);
  const args = JSON.parse(call.payload.arguments);
  assert.equal(
    args.cmd,
    expectedCommand,
    "canary command did not match the required diff inspection",
  );
  if (args.workdir !== undefined) assert.equal(args.workdir, cwd);
  if (Object.hasOwn(args, "login")) {
    assert.equal(typeof args.login, "boolean", "canary command login must be a boolean");
  }
  assert.equal(results[0].payload.call_id, call.payload.call_id);
  assert.equal(results[0].payload.internal_chat_message_metadata_passthrough?.turn_id, turn);
  assert.ok(
    typeof results[0].payload.output === "string" && results[0].payload.output.includes(marker),
    "canary model-facing tool result did not contain the fixture marker",
  );

  const completed = events.filter((record) => record.payload.type === "item_completed");
  for (const record of completed) {
    assert.equal(record.payload.thread_id, session.id, "canary item thread mismatch");
    assert.equal(record.payload.turn_id, turn, "canary item turn mismatch");
    assert.ok(
      ["UserMessage", "Reasoning", "AgentMessage", "CommandExecution"].includes(
        record.payload.item.type,
      ),
      "canary attempted an additional tool",
    );
  }
  const commands = completed.filter((record) => record.payload.item.type === "CommandExecution");
  assert.equal(commands.length, 1, "canary must complete exactly one review command");
  const command = commands[0];
  assert.equal(command.payload.item.id, call.payload.call_id, "canary completed a different call");
  // The isolated canary keeps the pinned CLI's login-enabled default.
  // An explicit login:false must match the native non-login invocation.
  assert.deepEqual(
    command.payload.item.command,
    ["/bin/bash", args.login === false ? "-c" : "-lc", expectedCommand],
    "canary executed different command arguments",
  );
  assert.equal(command.payload.item.cwd, pathToFileURL(cwd).href, "canary command cwd mismatch");
  assert.equal(command.payload.item.status, "completed", "canary command did not complete");
  assert.equal(command.payload.item.exit_code, 0, "canary command failed");
  assert.ok(
    typeof command.payload.item.aggregated_output === "string" &&
      command.payload.item.aggregated_output.includes(marker),
    "canary command did not return the fixture marker",
  );
  assert.ok(
    starts[0].index < call.index && call.index < command.index && command.index < results[0].index,
    "canary command and result order is invalid",
  );
  assert.equal(
    ends[0].payload.last_agent_message,
    finalDecisionText,
    "canary terminal answer mismatch",
  );
  // The pinned CLI selects the terminal answer from completed messages without
  // requiring phase metadata, which some providers omit.
  const finals = completed.filter((record) => {
    const item = record.payload.item;
    return (
      record.index > results[0].index &&
      item.type === "AgentMessage" &&
      Array.isArray(item.content) &&
      item.content.length === 1 &&
      item.content[0]?.type === "Text" &&
      item.content[0].text === finalDecisionText
    );
  });
  assert.equal(finals.length, 1, "canary final review is ambiguous");
  const final = finals[0];
  assert.ok(
    results[0].index < final.index && final.index < ends[0].index,
    "final review was not emitted after the command",
  );
  assert.ok(
    String(JSON.parse(finalDecisionText).summary ?? "").includes(marker),
    "final review did not use the fixture marker",
  );

  return {
    eventCount: records.length,
    toolAttemptCount: calls.length,
    completedToolCount: commands.length,
    fixtureToolCount: 1,
    reviewAfterToolCount: 1,
    terminalTurnCount: ends.length,
    checkoutUnchanged: Boolean(checkoutUnchanged),
  };
}

export function assertBooleanCountArtifact(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  for (const entry of Object.values(value)) {
    assert.ok(
      typeof entry === "boolean" || (typeof entry === "number" && Number.isInteger(entry)),
      "hosted canary artifacts may contain only booleans and integer counts",
    );
  }
}

export function runWithWithheldDiagnostics(message, operation) {
  try {
    return operation();
  } catch {
    throw new Error(message);
  }
}
