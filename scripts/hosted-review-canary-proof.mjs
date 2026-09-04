import assert from "node:assert/strict";

function parseJsonl(jsonl) {
  return jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

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

function posixShellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hasExactShellPayload(serializedCommand, expectedCommand) {
  const quotedPayloads = [posixShellQuote(expectedCommand), JSON.stringify(expectedCommand)];
  const suffixes = quotedPayloads.flatMap((payload) => [` -c ${payload}`, ` -lc ${payload}`]);
  return suffixes.some((suffix) => {
    if (!serializedCommand.endsWith(suffix)) return false;
    return /^\S+$/.test(serializedCommand.slice(0, -suffix.length));
  });
}

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
  "todo_list",
]);

export function summarizeHostedReviewTrace({
  jsonl,
  marker,
  expectedCommand,
  finalDecisionText,
  checkoutUnchanged,
}) {
  const events = parseJsonl(jsonl);
  const toolEvents = events.flatMap((event, index) => {
    if (
      !["item.started", "item.completed"].includes(event?.type) ||
      !TOOL_ITEM_TYPES.has(event.item?.type)
    ) {
      return [];
    }
    return [{ event, index }];
  });
  const toolAttemptIds = new Set(toolEvents.map(({ event }) => event.item.id));
  assert.ok(!toolAttemptIds.has(undefined), "canary tool attempt did not have an id");
  assert.equal(toolAttemptIds.size, 1, "canary must attempt exactly one review tool");
  const completedCommands = toolEvents.filter(
    ({ event }) =>
      event.type === "item.completed" &&
      event.item.type === "command_execution" &&
      event.item.status === "completed" &&
      event.item.exit_code === 0,
  );
  assert.equal(completedCommands.length, 1, "canary must complete exactly one review command");
  assert.ok(
    hasExactShellPayload(String(completedCommands[0].event.item.command ?? ""), expectedCommand),
    "canary command did not match the required diff inspection",
  );
  const markerCommands = completedCommands.filter(({ event }) =>
    String(event.item.aggregated_output ?? "").includes(marker),
  );
  assert.ok(markerCommands.length > 0, "no completed command returned the fixture marker");

  const markerCommandIndex = markerCommands.at(-1).index;
  const finalReviewIndex = events.findIndex(
    (event, index) =>
      index > markerCommandIndex &&
      event?.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      event.item.text.trim() === finalDecisionText.trim(),
  );
  assert.ok(
    finalReviewIndex > markerCommandIndex,
    "final review was not emitted after the command",
  );

  const finalReview = JSON.parse(finalDecisionText);
  assert.ok(
    String(finalReview.summary ?? "").includes(marker),
    "final review did not use the fixture marker",
  );
  const turnCompletions = events.filter((event) => event?.type === "turn.completed");
  assert.equal(turnCompletions.length, 1, "canary must complete exactly one turn");
  assert.ok(
    events.findIndex(
      (event, index) => index > finalReviewIndex && event?.type === "turn.completed",
    ) > finalReviewIndex,
    "turn.completed was not emitted after the final review",
  );

  return {
    eventCount: events.length,
    toolAttemptCount: toolAttemptIds.size,
    completedToolCount: completedCommands.length,
    fixtureToolCount: markerCommands.length,
    reviewAfterToolCount: 1,
    terminalTurnCount: turnCompletions.length,
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
