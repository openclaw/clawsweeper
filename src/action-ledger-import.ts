import path from "node:path";
import { mkdtempSync, renameSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { sha256 } from "./content-hash.ts";
import {
  isNotFoundError,
  prepareSafeReadRoot,
  prepareSafeReadTarget,
  prepareSafeWriteTarget,
  readUtf8FileIfExistsNoFollow,
  readUtf8FileNoFollow,
  type SafeReadRoot,
} from "./action-ledger-files.ts";
import {
  ACTION_EVENT_SHARD_FILE_LIMITS,
  actionEventShardsReplayEquivalent,
  actionEventShardImportBindingRelativePaths,
  actionEventShardRelativePath,
  actionEventReplayJson,
  actionLedgerJson,
  parseActionEventShardContent,
  parseActionEventShardImportReservation,
  parseActionEventShardImportCompletion,
  sortActionEventsCausally,
  splitActionEventShardEvents,
  type ActionEvent,
  type ActionEventShardIdentity,
} from "./action-ledger.ts";

const ACTION_EVENT_SHARD_PATH_PATTERN =
  /^ledger\/v1\/events\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.jsonl$/;
export const ACTION_EVENT_IMPORT_BINDING_MAX_BYTES = 1024 * 1024;

export const ACTION_EVENT_SHARD_IMPORT_LIMITS = {
  maxDepth: 6,
  maxEntriesPerDirectory: 512,
  maxDirectories: 512,
  maxFiles: 256,
  maxFileBytes: ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes,
  maxFileLines: 2_048,
  maxFileEvents: ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents,
  maxTotalBytes: 16 * 1024 * 1024,
  maxTotalEvents: 256 * ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents,
  maxCausalBindings: 256 * ACTION_EVENT_SHARD_FILE_LIMITS.maxEvents,
} as const;

export const ACTION_EVENT_SHARD_IMPORT_MAX_PUBLISH_PATHS =
  ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalEvents + ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles * 4;

export type ImportedActionEventShard = {
  relativePath: string;
  content: string;
  events: ActionEvent[];
  identity: ActionEventShardIdentity;
  shardIndex: number | undefined;
  shardCount: number | undefined;
};

export type ActionEventShardImportBinding = {
  relativePath: string;
  content: string;
  label: string;
  kind: "reservation" | "completion";
};

export type ImportedActionEventIdentityBinding = {
  schema: "clawsweeper.action-ledger-import-event";
  schema_version: 1;
  event_id: string;
  semantic_sha256: string;
  parent_event_id: string | null;
};

export function actionEventShardImportBindings(
  shards: readonly ImportedActionEventShard[],
): ActionEventShardImportBinding[] {
  const producerRuns = new Map<string, ActionEventShardImportBinding>();
  const eventIdentities = new Map<string, ActionEventShardImportBinding>();
  const shardSets = new Map<string, ImportedActionEventShard[]>();
  for (const shard of shards) {
    const { partitionDate, ...producerIdentity } = shard.identity;
    const producerKey = actionLedgerJson(producerIdentity);
    const producerDigest = sha256(producerKey);
    const producerContent = `${actionLedgerJson({
      schema: "clawsweeper.action-ledger-import-producer-run",
      schema_version: 1,
      producer: producerIdentity,
      partition_date: partitionDate,
    })}\n`;
    const existingProducer = producerRuns.get(producerKey);
    if (existingProducer && existingProducer.content !== producerContent) {
      throw new Error("action event shard batch splits one producer run across partition dates");
    }
    producerRuns.set(producerKey, {
      relativePath: path.posix.join(
        "ledger",
        "v1",
        "import-bindings",
        "producer-runs",
        `${producerDigest}.json`,
      ),
      content: producerContent,
      label: "action event shard import producer partition binding",
      kind: "reservation",
    });

    for (const event of shard.events) {
      const content = `${actionLedgerJson(importedActionEventIdentityBinding(event))}\n`;
      const existingEvent = eventIdentities.get(event.event_id);
      if (existingEvent && existingEvent.content !== content) {
        throw new Error(`action event shard import event identity conflict: ${event.event_id}`);
      }
      eventIdentities.set(event.event_id, {
        relativePath: importedActionEventIdentityBindingRelativePath(event.event_id),
        content,
        label: "action event shard import event identity binding",
        kind: "reservation",
      });
    }

    const shardSetKey = actionLedgerJson(shard.identity);
    const group = shardSets.get(shardSetKey) ?? [];
    group.push(shard);
    shardSets.set(shardSetKey, group);
  }

  const bindings = [...producerRuns.values(), ...eventIdentities.values()];
  for (const group of shardSets.values()) {
    const ordered = [...group].sort((left, right) =>
      left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
    );
    const bindingPaths = actionEventShardImportBindingRelativePaths(ordered[0]!.identity);
    const reservation = {
      schema: "clawsweeper.action-ledger-import-shard-set",
      schema_version: 1,
      producer: ordered[0]!.identity,
      shards: ordered.map((shard) => ({
        path: shard.relativePath,
        replay_sha256: sha256(
          `${shard.events.map((event) => actionEventReplayJson(event)).join("\n")}\n`,
        ),
      })),
    };
    const reservationContent = `${actionLedgerJson(reservation)}\n`;
    bindings.push({
      relativePath: bindingPaths.reservation,
      content: reservationContent,
      label: "action event shard import producer shard-set binding",
      kind: "reservation",
    });
    bindings.push({
      relativePath: bindingPaths.completion,
      content: `${actionLedgerJson({
        schema: "clawsweeper.action-ledger-import-shard-set-completion",
        schema_version: 1,
        producer: ordered[0]!.identity,
        reservation_sha256: sha256(reservationContent),
      })}\n`,
      label: "action event shard import producer shard-set completion binding",
      kind: "completion",
    });
  }
  return bindings.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "reservation" ? -1 : 1;
    return left.relativePath < right.relativePath
      ? -1
      : left.relativePath > right.relativePath
        ? 1
        : 0;
  });
}

export function importedActionEventIdentityBinding(
  event: ActionEvent,
): ImportedActionEventIdentityBinding {
  return {
    schema: "clawsweeper.action-ledger-import-event",
    schema_version: 1,
    event_id: event.event_id,
    semantic_sha256: event.semantic_sha256,
    parent_event_id: event.parent_event_id,
  };
}

export function importedActionEventIdentityBindingRelativePath(eventId: string): string {
  return path.posix.join("ledger", "v1", "import-bindings", "events", `${eventId}.json`);
}

export function readImportedActionEventShards(
  source: SafeReadRoot,
  relativePaths: readonly string[],
  options: { requireManifestPaths?: boolean; partial?: boolean } = {},
): ImportedActionEventShard[] {
  if (relativePaths.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles)
    throw new Error("action event shard import exceeds file limit");
  let totalBytes = 0;
  const contents = relativePaths.map((relativePath) => {
    if (!ACTION_EVENT_SHARD_PATH_PATTERN.test(relativePath)) {
      throw new Error(`invalid action event shard path: ${relativePath}`);
    }
    const target = prepareSafeReadTarget(source, relativePath, "action event shard import source");
    let content: string;
    try {
      content = readUtf8FileNoFollow(target, ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileBytes);
    } catch (error) {
      if (options.requireManifestPaths && isNotFoundError(error)) {
        throw new Error(`action event shard manifest path is missing: ${relativePath}`, {
          cause: error,
        });
      }
      throw error;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    if (totalBytes > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes) {
      throw new Error(
        `action event shard import exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes} total byte limit`,
      );
    }
    assertImportedShardLineLimit(relativePath, content);
    if (!content.endsWith("\n")) {
      throw new Error(`action event shard must end with a newline: ${relativePath}`);
    }
    return { relativePath, content };
  });

  let totalEvents = 0;
  const parsed = contents.map(({ relativePath, content }) => {
    const events = parseActionEventShardContent(content, relativePath);
    assertImportedShardEventLimit(relativePath, events);
    totalEvents += events.length;
    if (totalEvents > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalEvents) {
      throw new Error(
        `action event shard import exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalEvents} total event limit`,
      );
    }
    return { relativePath, content, events };
  });
  const validated = parsed.map((shard) => ({
    ...shard,
    ...validateCanonicalImportedShard(shard.relativePath, shard.events, shard.content),
  }));
  if (!options.partial) validateCanonicalImportedShardBatch(validated);
  return validated;
}

export function validateExpectedActionEventPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    throw new Error("action event shard manifest is empty");
  }
  if (paths.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles) {
    throw new Error(
      `action event shard manifest exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles} event paths`,
    );
  }
  const canonical = [...new Set(paths)].sort();
  if (
    canonical.length !== paths.length ||
    canonical.some((value, index) => value !== paths[index])
  ) {
    throw new Error("action event shard manifest paths must be sorted and unique");
  }
  for (const relativePath of canonical) {
    if (!ACTION_EVENT_SHARD_PATH_PATTERN.test(relativePath)) {
      throw new Error(`invalid action event shard manifest path: ${relativePath}`);
    }
  }
  return canonical;
}

export function importedShardReplayEquivalent(
  content: string,
  candidate: ImportedActionEventShard,
  filePath: string,
): boolean {
  assertImportedShardLineLimit(candidate.relativePath, content);
  const parsed = parseActionEventShardContent(content, filePath);
  assertImportedShardEventLimit(candidate.relativePath, parsed);
  validateCanonicalImportedShard(candidate.relativePath, parsed, content);
  return actionEventShardsReplayEquivalent(parsed, candidate.events);
}

function assertImportedShardLineLimit(relativePath: string, content: string): void {
  let lineCount = content.length === 0 ? 0 : content.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lineCount += 1;
  }
  if (lineCount > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileLines) {
    throw new Error(
      `action event shard exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileLines} line limit: ${relativePath}`,
    );
  }
}

function assertImportedShardEventLimit(relativePath: string, events: readonly ActionEvent[]): void {
  if (events.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileEvents) {
    throw new Error(
      `action event shard exceeds ${ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFileEvents} event limit: ${relativePath}`,
    );
  }
}

function validateCanonicalImportedShard(
  relativePath: string,
  events: readonly ActionEvent[],
  content: string,
): Pick<ImportedActionEventShard, "identity" | "shardIndex" | "shardCount"> {
  const match =
    /^ledger\/v1\/events\/(\d{4})\/(\d{2})\/(\d{2})\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.jsonl$/.exec(
      relativePath,
    );
  const first = events[0];
  if (!match || !first) {
    throw new Error(`action event shard is empty or has an invalid path: ${relativePath}`);
  }
  const seen = new Set<string>();
  const firstProducer = actionLedgerJson(first.producer);
  for (const event of events) {
    if (seen.has(event.event_id)) {
      throw new Error(`action event shard contains duplicate events: ${relativePath}`);
    }
    seen.add(event.event_id);
    if (actionLedgerJson(event.producer) !== firstProducer) {
      throw new Error(`action event shard mixes producer identities: ${relativePath}`);
    }
  }
  const sorted = sortActionEventsCausally(events);
  const canonicalContent = `${sorted.map((event) => actionLedgerJson(event)).join("\n")}\n`;
  if (content !== canonicalContent) {
    throw new Error(`action event shard content is not canonical: ${relativePath}`);
  }
  const identity = {
    repository: first.producer.repository,
    sha: first.producer.sha,
    producer: first.producer.component,
    workflow: first.producer.workflow,
    job: first.producer.job,
    runId: first.producer.run_id,
    runAttempt: first.producer.run_attempt,
    partitionDate: `${match[1]}-${match[2]}-${match[3]}`,
  };
  const { shardIndex, shardCount } = importedShardPart(relativePath);
  const expectedPath = actionEventShardRelativePath(
    identity,
    sorted,
    shardIndex,
    shardCount,
  ).replaceAll(path.sep, "/");
  if (expectedPath !== relativePath) {
    throw new Error(
      `action event shard path does not match canonical identity: ${relativePath} != ${expectedPath}`,
    );
  }
  return { identity, shardIndex, shardCount };
}

function validateCanonicalImportedShardBatch(shards: readonly ImportedActionEventShard[]): void {
  const allEvents = shards.flatMap((shard) => shard.events);
  const seen = new Set<string>();
  for (const event of allEvents) {
    if (seen.has(event.event_id)) {
      throw new Error(`action event shard batch contains duplicate event: ${event.event_id}`);
    }
    seen.add(event.event_id);
  }
  sortActionEventsCausally(allEvents);

  const producerPartitions = new Map<string, string>();
  for (const shard of shards) {
    const { partitionDate, ...producerIdentity } = shard.identity;
    const key = actionLedgerJson(producerIdentity);
    const existing = producerPartitions.get(key);
    if (existing !== undefined && existing !== partitionDate) {
      throw new Error("action event shard batch splits one producer run across partition dates");
    }
    producerPartitions.set(key, partitionDate);
  }

  const groups = new Map<string, ImportedActionEventShard[]>();
  for (const shard of shards) {
    const key = actionLedgerJson(shard.identity);
    const group = groups.get(key) ?? [];
    group.push(shard);
    groups.set(key, group);
  }
  for (const group of groups.values()) validateCanonicalImportedShardGroup(group);
}

function validateCanonicalImportedShardGroup(group: readonly ImportedActionEventShard[]): void {
  const numbered = group.filter((shard) => shard.shardIndex !== undefined);
  if (numbered.length === 0) {
    if (group.length !== 1) {
      throw new Error("action event shard batch contains repeated unnumbered producer shards");
    }
    return;
  }
  if (numbered.length !== group.length) {
    throw new Error("action event shard batch mixes numbered and unnumbered producer shards");
  }

  const shardCount = numbered[0]!.shardCount!;
  if (numbered.some((shard) => shard.shardCount !== shardCount) || numbered.length !== shardCount) {
    throw new Error("action event shard batch is incomplete");
  }
  const ordered = [...group].sort((left, right) => left.shardIndex! - right.shardIndex!);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]!.shardIndex !== index + 1) {
      throw new Error("action event shard batch is incomplete");
    }
  }
  const events = sortActionEventsCausally(ordered.flatMap((shard) => shard.events));
  const packed = splitActionEventShardEvents(events);
  if (packed.length !== ordered.length) {
    throw new Error("action event shard batch is not deterministically packed");
  }
  const identity = ordered[0]!.identity;
  for (let index = 0; index < packed.length; index += 1) {
    const eventsForPart = packed[index]!;
    const shard = ordered[index]!;
    const expectedPath = actionEventShardRelativePath(
      identity,
      eventsForPart,
      index + 1,
      shardCount,
    ).replaceAll(path.sep, "/");
    const expectedContent = `${eventsForPart.map((event) => actionLedgerJson(event)).join("\n")}\n`;
    if (shard.relativePath !== expectedPath || shard.content !== expectedContent) {
      throw new Error("action event shard batch is not deterministically packed");
    }
  }
}

function importedShardPart(relativePath: string): {
  shardIndex: number | undefined;
  shardCount: number | undefined;
} {
  const match = /-part-(\d{6})-of-(\d{6})\.jsonl$/.exec(relativePath);
  return match
    ? { shardIndex: Number(match[1]), shardCount: Number(match[2]) }
    : { shardIndex: undefined, shardCount: undefined };
}

/** Validate the same closed transaction that the local importer publishes. */
export function actionEventPublicationPaths(root: string, paths: readonly string[]): string[] {
  const source = prepareSafeReadRoot(root, "action event publication");
  const events = validateExpectedActionEventPaths(
    paths.filter((entry) => entry.startsWith("ledger/v1/events/")),
  );
  const shards = readImportedActionEventShards(source, events, { requireManifestPaths: true });
  const bindings = actionEventShardImportBindings(shards);
  const expected = [...events, ...bindings.map((binding) => binding.relativePath)].sort();
  if (expected.length !== paths.length || expected.some((entry, index) => entry !== paths[index])) {
    throw new Error(
      "action event publish manifest does not contain the complete import transaction",
    );
  }
  for (const binding of bindings) assertImportBinding(source, binding);
  return [
    ...bindings
      .filter((binding) => binding.kind === "reservation")
      .map((binding) => binding.relativePath),
    ...events,
    ...bindings
      .filter((binding) => binding.kind === "completion")
      .map((binding) => binding.relativePath),
  ];
}

function readImportFile(root: SafeReadRoot, relativePath: string): string | null {
  try {
    return readUtf8FileIfExistsNoFollow(
      prepareSafeReadTarget(root, relativePath, "action event import transaction"),
      relativePath.startsWith("ledger/v1/events/")
        ? ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes
        : ACTION_EVENT_IMPORT_BINDING_MAX_BYTES,
    );
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

function assertImportBinding(root: SafeReadRoot, binding: ActionEventShardImportBinding): void {
  if (readImportFile(root, binding.relativePath) !== binding.content) {
    throw new Error(`invalid or missing action event import binding: ${binding.relativePath}`);
  }
}

function readImportReservation(root: SafeReadRoot, relativePath: string) {
  const content = readImportFile(root, relativePath);
  if (content === null) throw new Error(`missing action event import reservation: ${relativePath}`);
  const reservation = parseActionEventShardImportReservation(content, null, relativePath);
  if (
    reservation.shards.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles ||
    actionEventShardImportBindingRelativePaths(reservation.identity).reservation !== relativePath
  ) {
    throw new Error(`invalid action event import reservation: ${relativePath}`);
  }
  return { ...reservation, content };
}

/** Called only after all listing pages have finished into an exclusively owned stage. */
export async function verifyHydratedActionEventImports(
  stagingRoot: string,
  ensurePath: (relativePath: string) => Promise<boolean>,
) {
  const root = prepareSafeReadRoot(stagingRoot, "hydrated action events");
  const omitted = {
    omittedProducers: 0,
    omittedPayloads: 0,
    omittedBytes: 0,
    omittedProducerExamples: [] as string[],
  };
  let excludedRoot: string | undefined;
  for await (const relativePath of importFiles(root, "ledger/v1/events")) {
    let shard: ImportedActionEventShard;
    try {
      shard = readImportedActionEventShards(root, [relativePath], { partial: true })[0]!;
    } catch (error) {
      // A buffered directory entry may name a sibling already moved by this pass.
      if (
        isNotFoundError(error) &&
        excludedRoot &&
        readImportFile(prepareSafeReadRoot(excludedRoot, "excluded imports"), relativePath) !== null
      )
        continue;
      throw error;
    }
    const markers = actionEventShardImportBindingRelativePaths(shard.identity);
    for (const marker of [markers.reservation, markers.completion]) {
      if (readImportFile(root, marker) === null) await ensurePath(marker);
    }
    if (
      readImportFile(root, markers.reservation) === null &&
      readImportFile(root, markers.completion) === null
    )
      continue;
    const reservation = readImportReservation(root, markers.reservation);
    const replaySha256 = sha256(
      `${shard.events.map((event) => actionEventReplayJson(event)).join("\n")}\n`,
    );
    if (
      !reservation.shards.some(
        (member) => member.path === relativePath && member.replay_sha256 === replaySha256,
      )
    ) {
      throw new Error(`action event payload is absent from its reservation: ${relativePath}`);
    }
    const completion = readImportFile(root, markers.completion);
    if (completion !== null) {
      parseActionEventShardImportCompletion(
        completion,
        reservation.identity,
        sha256(reservation.content),
        markers.completion,
      );
      continue;
    }
    const present = reservation.shards.flatMap((member) => {
      let observed: ImportedActionEventShard;
      try {
        observed = readImportedActionEventShards(root, [member.path], { partial: true })[0]!;
      } catch (error) {
        if (isNotFoundError(error)) return [];
        throw error;
      }
      const replay = sha256(
        `${observed.events.map((event) => actionEventReplayJson(event)).join("\n")}\n`,
      );
      if (replay !== member.replay_sha256)
        throw new Error(`invalid uncommitted action event payload: ${member.path}`);
      return [{ ...member, bytes: Buffer.byteLength(observed.content, "utf8") }];
    });
    const omittedBytes = present.reduce((total, member) => total + member.bytes, 0);
    if (omittedBytes > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxTotalBytes)
      throw new Error("uncommitted action event import exceeds total byte limit");
    if (!present.some((member) => member.path === relativePath))
      throw new Error(`action event payload is absent from its reservation: ${relativePath}`);
    excludedRoot ??= mkdtempSync(path.join(stagingRoot, ".uncommitted-action-imports-"));
    // Keep exact on-disk tombstones for buffered entries without retaining an unbounded path set.
    for (const member of present) {
      const destination = prepareSafeWriteTarget(
        excludedRoot,
        member.path,
        "excluded action event payload",
      );
      renameSync(
        prepareSafeReadTarget(root, member.path, "uncommitted action event payload").path,
        destination.path,
      );
    }
    omitted.omittedProducers += 1;
    omitted.omittedPayloads += present.length;
    omitted.omittedBytes += omittedBytes;
    if (omitted.omittedProducerExamples.length < 5)
      omitted.omittedProducerExamples.push(path.basename(markers.reservation, ".json"));
  }
  // Verify each committed producer once, including siblings missed by non-snapshot pagination.
  for await (const completionPath of importFiles(
    root,
    "ledger/v1/import-bindings/completed-shard-sets",
  )) {
    const reservationPath = completionPath.replace("/completed-shard-sets/", "/shard-sets/");
    if (readImportFile(root, reservationPath) === null) await ensurePath(reservationPath);
    const reservation = readImportReservation(root, reservationPath);
    if (
      actionEventShardImportBindingRelativePaths(reservation.identity).completion !== completionPath
    )
      throw new Error(`invalid action event completion path: ${completionPath}`);
    parseActionEventShardImportCompletion(
      readImportFile(root, completionPath)!,
      reservation.identity,
      sha256(reservation.content),
      completionPath,
    );
    for (const member of reservation.shards) {
      if (readImportFile(root, member.path) === null && !(await ensurePath(member.path)))
        throw new Error(`missing completed action event payload: ${member.path}`);
    }
    const shards = readImportedActionEventShards(
      root,
      reservation.shards.map((member) => member.path),
    );
    for (const binding of actionEventShardImportBindings(shards)) {
      if (readImportFile(root, binding.relativePath) === null)
        await ensurePath(binding.relativePath);
      assertImportBinding(root, binding);
    }
  }
  return omitted;
}

async function* importFiles(root: SafeReadRoot, relativeRoot: string): AsyncGenerator<string> {
  let directory;
  try {
    directory = await opendir(
      prepareSafeReadTarget(root, relativeRoot, "action event import directory").path,
    );
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  for await (const entry of directory) {
    const relativePath = `${relativeRoot}/${entry.name}`;
    if (
      entry.isDirectory() &&
      relativePath.split("/").length <= ACTION_EVENT_SHARD_IMPORT_LIMITS.maxDepth + 2
    )
      yield* importFiles(root, relativePath);
    else if (entry.isFile()) yield relativePath;
    else throw new Error(`unsafe action event import entry: ${relativePath}`);
  }
}
