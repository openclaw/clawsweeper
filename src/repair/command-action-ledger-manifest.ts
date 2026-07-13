import { createHash } from "node:crypto";

import { actionLedgerJson, readActionEventShardAt, type ActionEvent } from "../action-ledger.js";
import {
  ACTION_EVENT_SHARD_IMPORT_LIMITS,
  workflowActionProducer,
} from "../action-ledger-runtime.js";
import { flushCommandActionEvents } from "./command-action-ledger.js";
import { repoRoot } from "./paths.js";

const COMMAND_ACTION_LEDGER_MANIFEST_SCHEMA = "clawsweeper.command-action-ledger-manifest";
const COMMAND_ACTION_LEDGER_MANIFEST_VERSION = 1;
const COMMAND_ACTION_LEDGER_MANIFEST_MAX_BYTES = 256 * 1024;
const COMMAND_ACTION_LEDGER_LANE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMAND_EVENT_TYPE_PREFIX = "command.";

type CommandActionLedgerManifestIdentity = {
  schema: typeof COMMAND_ACTION_LEDGER_MANIFEST_SCHEMA;
  schema_version: typeof COMMAND_ACTION_LEDGER_MANIFEST_VERSION;
  lane: string;
  repository: string;
  sha: string;
  workflow: string;
  job: string;
  run_id: string;
  run_attempt: number;
  event_paths: string[];
};

export type CommandActionLedgerManifest = CommandActionLedgerManifestIdentity & {
  manifest_sha256: string;
};

export async function finalizeCommandActionLedgerManifest(
  lane: string,
  options: { allowEmpty?: boolean } = {},
): Promise<CommandActionLedgerManifest | null> {
  assertCommandActionLedgerLane(lane);
  const outputRoot = commandActionLedgerOutputRoot();
  const finalizedPaths = await flushCommandActionEvents();
  const commandShards = finalizedPaths
    .map((relativePath) => ({
      relativePath,
      events: readActionEventShardAt(outputRoot, relativePath),
    }))
    .filter(({ events }) => events.some(commandActionEvent));
  if (commandShards.length === 0) {
    if (options.allowEmpty) return null;
    throw new Error(`command action ledger lane ${lane} finalized no command event shards`);
  }
  for (const shard of commandShards) {
    if (!shard.events.every(commandActionEvent)) {
      throw new Error(
        `command action ledger shard mixes command and non-command events: ${shard.relativePath}`,
      );
    }
  }

  const producer = commandShards[0]!.events[0]!.producer;
  for (const event of commandShards.flatMap((shard) => shard.events)) {
    assertManifestProducerIdentity(event, producer);
  }
  const eventPaths = commandShards.map((shard) => shard.relativePath).sort();
  if (eventPaths.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles) {
    throw new Error(
      `command action ledger manifest exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles} event paths`,
    );
  }
  const identity: CommandActionLedgerManifestIdentity = {
    schema: COMMAND_ACTION_LEDGER_MANIFEST_SCHEMA,
    schema_version: COMMAND_ACTION_LEDGER_MANIFEST_VERSION,
    lane,
    repository: producer.repository,
    sha: producer.sha,
    workflow: producer.workflow,
    job: producer.job,
    run_id: producer.run_id,
    run_attempt: producer.run_attempt,
    event_paths: eventPaths,
  };
  return {
    ...identity,
    manifest_sha256: commandActionLedgerManifestSha256(identity),
  };
}

export function parseCommandActionLedgerManifest(
  content: string,
  expectedLane: string,
  env: NodeJS.ProcessEnv = process.env,
): CommandActionLedgerManifest {
  assertCommandActionLedgerLane(expectedLane);
  if (Buffer.byteLength(content, "utf8") > COMMAND_ACTION_LEDGER_MANIFEST_MAX_BYTES) {
    throw new Error(
      `command action ledger manifest exceeds ${COMMAND_ACTION_LEDGER_MANIFEST_MAX_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("command action ledger manifest is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("command action ledger manifest must be an object");
  }
  const manifest = value as Partial<CommandActionLedgerManifest>;
  const keys = Object.keys(manifest).sort();
  const expectedKeys = [
    "event_paths",
    "job",
    "lane",
    "manifest_sha256",
    "repository",
    "run_attempt",
    "run_id",
    "schema",
    "schema_version",
    "sha",
    "workflow",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error("command action ledger manifest keys are invalid");
  }
  if (
    manifest.schema !== COMMAND_ACTION_LEDGER_MANIFEST_SCHEMA ||
    manifest.schema_version !== COMMAND_ACTION_LEDGER_MANIFEST_VERSION ||
    manifest.lane !== expectedLane ||
    typeof manifest.repository !== "string" ||
    typeof manifest.sha !== "string" ||
    typeof manifest.workflow !== "string" ||
    typeof manifest.job !== "string" ||
    typeof manifest.run_id !== "string" ||
    !Number.isSafeInteger(manifest.run_attempt) ||
    !Array.isArray(manifest.event_paths) ||
    manifest.event_paths.length === 0 ||
    manifest.event_paths.some((relativePath) => typeof relativePath !== "string") ||
    typeof manifest.manifest_sha256 !== "string"
  ) {
    throw new Error("command action ledger manifest identity is invalid");
  }
  const eventPaths = manifest.event_paths as string[];
  const canonicalPaths = [...new Set(eventPaths)].sort();
  if (
    canonicalPaths.length !== eventPaths.length ||
    canonicalPaths.some((relativePath, index) => relativePath !== eventPaths[index])
  ) {
    throw new Error("command action ledger manifest paths must be sorted and unique");
  }
  const parsed = manifest as CommandActionLedgerManifest;
  const { manifest_sha256: manifestSha256, ...identity } = parsed;
  if (
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    commandActionLedgerManifestSha256(identity) !== manifestSha256
  ) {
    throw new Error("command action ledger manifest digest is invalid");
  }
  if (`${actionLedgerJson(parsed)}\n` !== content) {
    throw new Error("command action ledger manifest is not canonical");
  }

  const currentProducer = workflowActionProducer("command_manifest", env);
  const mismatched = (
    [
      ["repository", parsed.repository, currentProducer.repository],
      ["sha", parsed.sha, currentProducer.sha],
      ["workflow", parsed.workflow, currentProducer.workflow],
      ["job", parsed.job, currentProducer.job],
      ["run_id", parsed.run_id, currentProducer.runId],
      ["run_attempt", parsed.run_attempt, currentProducer.runAttempt],
    ] as const
  ).find(([, actual, expected]) => actual !== expected);
  if (mismatched) {
    throw new Error(
      `command action ledger manifest identity mismatch for ${mismatched[0]}: expected ${mismatched[2]}, got ${mismatched[1]}`,
    );
  }
  return parsed;
}

export function serializeCommandActionLedgerManifest(
  manifest: CommandActionLedgerManifest,
): string {
  return `${actionLedgerJson(manifest)}\n`;
}

function commandActionLedgerOutputRoot(): string {
  return (
    process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim() ||
    `${repoRoot()}/.clawsweeper-repair/action-ledger-state`
  );
}

function commandActionEvent(event: ActionEvent): boolean {
  return event.event_type.startsWith(COMMAND_EVENT_TYPE_PREFIX);
}

function assertManifestProducerIdentity(
  event: ActionEvent,
  expected: ActionEvent["producer"],
): void {
  const mismatched = (
    [
      ["repository", event.producer.repository, expected.repository],
      ["sha", event.producer.sha, expected.sha],
      ["workflow", event.producer.workflow, expected.workflow],
      ["job", event.producer.job, expected.job],
      ["run_id", event.producer.run_id, expected.run_id],
      ["run_attempt", event.producer.run_attempt, expected.run_attempt],
    ] as const
  ).find(([, actual, wanted]) => actual !== wanted);
  if (mismatched) {
    throw new Error(
      `command action ledger finalized mixed producer runs for ${mismatched[0]}: ${mismatched[1]} != ${mismatched[2]}`,
    );
  }
}

function assertCommandActionLedgerLane(lane: string): void {
  if (!COMMAND_ACTION_LEDGER_LANE_PATTERN.test(lane)) {
    throw new Error(`invalid command action ledger lane: ${lane}`);
  }
}

function commandActionLedgerManifestSha256(identity: CommandActionLedgerManifestIdentity): string {
  return createHash("sha256").update(actionLedgerJson(identity)).digest("hex");
}
