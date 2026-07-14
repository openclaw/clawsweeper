import { createHash } from "node:crypto";

import {
  ACTION_EVENT_TYPES,
  actionLedgerJson,
  readActionEventShardAt,
  type ActionEvent,
} from "../action-ledger.js";
import {
  ACTION_EVENT_SHARD_IMPORT_LIMITS,
  workflowActionProducer,
} from "../action-ledger-runtime.js";
import { flushDispatchActionEvents } from "./dispatch-action-receipts.js";
import { repoRoot } from "./paths.js";

const DISPATCH_ACTION_LEDGER_MANIFEST_SCHEMA = "clawsweeper.dispatch-action-ledger-manifest";
const DISPATCH_ACTION_LEDGER_MANIFEST_VERSION = 1;
const DISPATCH_ACTION_LEDGER_MANIFEST_MAX_BYTES = 256 * 1024;
const DISPATCH_ACTION_LEDGER_LANE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type DispatchActionLedgerManifestIdentity = {
  schema: typeof DISPATCH_ACTION_LEDGER_MANIFEST_SCHEMA;
  schema_version: typeof DISPATCH_ACTION_LEDGER_MANIFEST_VERSION;
  lane: string;
  repository: string;
  sha: string;
  workflow: string;
  job: string;
  run_id: string;
  run_attempt: number;
  event_paths: string[];
};

export type DispatchActionLedgerManifest = DispatchActionLedgerManifestIdentity & {
  manifest_sha256: string;
};

export async function finalizeDispatchActionLedgerManifest(
  lane: string,
  options: { allowEmpty?: boolean } = {},
): Promise<DispatchActionLedgerManifest | null> {
  assertDispatchActionLedgerLane(lane);
  const outputRoot = dispatchActionLedgerOutputRoot();
  const finalizedPaths = await flushDispatchActionEvents();
  const dispatchShards = finalizedPaths
    .map((relativePath) => ({
      relativePath,
      events: readActionEventShardAt(outputRoot, relativePath),
    }))
    .filter(({ events }) => events.some(dispatchActionEvent));
  if (dispatchShards.length === 0) {
    if (options.allowEmpty) return null;
    throw new Error(`dispatch action ledger lane ${lane} finalized no dispatch event shards`);
  }
  for (const shard of dispatchShards) {
    if (!shard.events.every(dispatchActionEvent)) {
      throw new Error(
        `dispatch action ledger shard mixes dispatch and non-dispatch events: ${shard.relativePath}`,
      );
    }
  }

  const producer = dispatchShards[0]!.events[0]!.producer;
  for (const event of dispatchShards.flatMap((shard) => shard.events)) {
    assertManifestProducerIdentity(event, producer);
  }
  const eventPaths = dispatchShards.map((shard) => shard.relativePath).sort();
  if (eventPaths.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles) {
    throw new Error(
      `dispatch action ledger manifest exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles} event paths`,
    );
  }
  const identity: DispatchActionLedgerManifestIdentity = {
    schema: DISPATCH_ACTION_LEDGER_MANIFEST_SCHEMA,
    schema_version: DISPATCH_ACTION_LEDGER_MANIFEST_VERSION,
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
    manifest_sha256: dispatchActionLedgerManifestSha256(identity),
  };
}

export function parseDispatchActionLedgerManifest(
  content: string,
  expectedLane: string,
  env: NodeJS.ProcessEnv = process.env,
): DispatchActionLedgerManifest {
  assertDispatchActionLedgerLane(expectedLane);
  if (Buffer.byteLength(content, "utf8") > DISPATCH_ACTION_LEDGER_MANIFEST_MAX_BYTES) {
    throw new Error(
      `dispatch action ledger manifest exceeds ${DISPATCH_ACTION_LEDGER_MANIFEST_MAX_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("dispatch action ledger manifest is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dispatch action ledger manifest must be an object");
  }
  const manifest = value as Partial<DispatchActionLedgerManifest>;
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
    throw new Error("dispatch action ledger manifest keys are invalid");
  }
  if (
    manifest.schema !== DISPATCH_ACTION_LEDGER_MANIFEST_SCHEMA ||
    manifest.schema_version !== DISPATCH_ACTION_LEDGER_MANIFEST_VERSION ||
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
    throw new Error("dispatch action ledger manifest identity is invalid");
  }
  const eventPaths = manifest.event_paths as string[];
  const canonicalPaths = [...new Set(eventPaths)].sort();
  if (
    canonicalPaths.length !== eventPaths.length ||
    canonicalPaths.some((relativePath, index) => relativePath !== eventPaths[index])
  ) {
    throw new Error("dispatch action ledger manifest paths must be sorted and unique");
  }
  const parsed = manifest as DispatchActionLedgerManifest;
  const { manifest_sha256: manifestSha256, ...identity } = parsed;
  if (
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    dispatchActionLedgerManifestSha256(identity) !== manifestSha256
  ) {
    throw new Error("dispatch action ledger manifest digest is invalid");
  }
  if (`${actionLedgerJson(parsed)}\n` !== content) {
    throw new Error("dispatch action ledger manifest is not canonical");
  }

  const currentProducer = workflowActionProducer("dispatch_manifest", env);
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
      `dispatch action ledger manifest identity mismatch for ${mismatched[0]}: expected ${mismatched[2]}, got ${mismatched[1]}`,
    );
  }
  return parsed;
}

export function serializeDispatchActionLedgerManifest(
  manifest: DispatchActionLedgerManifest,
): string {
  return `${actionLedgerJson(manifest)}\n`;
}

function dispatchActionLedgerOutputRoot(): string {
  return (
    process.env.CLAWSWEEPER_ACTION_LEDGER_OUTPUT_ROOT?.trim() ||
    `${repoRoot()}/.clawsweeper-repair/action-ledger-state`
  );
}

function dispatchActionEvent(event: ActionEvent): boolean {
  return event.event_type === ACTION_EVENT_TYPES.dispatchLifecycle;
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
      `dispatch action ledger finalized mixed producer runs for ${mismatched[0]}: ${mismatched[1]} != ${mismatched[2]}`,
    );
  }
}

function assertDispatchActionLedgerLane(lane: string): void {
  if (!DISPATCH_ACTION_LEDGER_LANE_PATTERN.test(lane)) {
    throw new Error(`invalid dispatch action ledger lane: ${lane}`);
  }
}

function dispatchActionLedgerManifestSha256(
  identity: DispatchActionLedgerManifestIdentity,
): string {
  return createHash("sha256").update(actionLedgerJson(identity)).digest("hex");
}
