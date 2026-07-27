#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isActionEventPublishPath } from "../action-ledger-paths.js";
import {
  publishMainCommit,
  type GitPublishOptions,
  type PublishResult,
  type RebaseStrategy,
} from "./git-publish.js";
import { recordTuplePaths, validateRecordTuple, type RecordTupleContents } from "./record-tuple.js";
import {
  postCanonicalRecordTuple,
  postStateAppend,
  type CanonicalRecordTupleMutation,
  type StateAppendInputRecord,
  type StateAppendResult,
} from "./state-append-client.js";

type Args = {
  message: string;
  paths: string[];
  restorePaths: string[];
  maxAttempts?: number;
  pushAttempts?: number;
  rebaseStrategy?: RebaseStrategy;
};

type PublishMainRuntime = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  publishGit?: (options: GitPublishOptions) => PublishResult;
  root?: string;
};

type StateAppendPlan = {
  consumedPaths: Set<string>;
  records: StateAppendInputRecord[];
};

type CanonicalRecordPlan = {
  mutations: CanonicalRecordTupleMutation[];
  remainingPaths: string[];
};

const SWEEP_STATUS_DIRECTORY = "results/sweep-status";
const SWEEP_STATUS_FILE_PATTERN = /^results\/sweep-status\/([A-Za-z0-9][A-Za-z0-9_.-]*)\.json$/;
const COMMENT_ROUTER_LEDGER_PATH = "results/comment-router.json";
const STATE_APPEND_MAX_RECORD_BYTES = 256 * 1024;

export async function publishMainWithStateAppend(
  options: GitPublishOptions,
  runtime: PublishMainRuntime = {},
): Promise<PublishResult | "appended"> {
  const env = runtime.env ?? process.env;
  const publishGit = runtime.publishGit ?? publishMainCommit;
  const root = runtime.root ?? process.cwd();
  const queueUrl = env.QUEUE_URL ?? "";
  const webhookSecret = env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  const canonicalPlan = planCanonicalRecordTuples(
    options.paths,
    root,
    env.CLAWSWEEPER_STATE_DIR,
    env,
  );
  if (canonicalPlan.mutations.length > 0) {
    if (env.CLAWSWEEPER_STATE_APPEND_ENABLED !== "1" || !queueUrl || !webhookSecret) {
      throw new Error("canonical record publication is required for record tuple changes");
    }
    for (const mutation of canonicalPlan.mutations) {
      await postCanonicalRecordTuple({
        queueUrl,
        webhookSecret,
        mutation,
        ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
      });
    }
  }
  const canonicalAppended = canonicalPlan.mutations.length > 0;
  const publicationOptions = { ...options, paths: canonicalPlan.remainingPaths };
  if (publicationOptions.paths.length === 0) {
    console.log(`Appended ${canonicalPlan.mutations.length} canonical record tuple(s)`);
    return "appended";
  }
  if (env.CLAWSWEEPER_STATE_APPEND_ENABLED !== "1" || !queueUrl || !webhookSecret) {
    return publishGit(publicationOptions);
  }

  let plan: StateAppendPlan;
  try {
    plan = planStateAppend(publicationOptions.paths, root, env.CLAWSWEEPER_STATE_DIR, runtime.now);
  } catch {
    console.warn("state-append shed/failed; falling back to git publish");
    return publishGit(publicationOptions);
  }
  if (plan.records.length === 0) return publishGit(publicationOptions);

  const remainingPaths = publicationOptions.paths.filter((path) => !plan.consumedPaths.has(path));
  // Router replay is crash-recoverable through deterministic job paths, stable
  // dispatch keys, and live-run/status reconciliation. Publish those outputs
  // first so an interrupted append is retried instead of suppressing missing work.
  const publishRemainingFirst =
    remainingPaths.length > 0 && plan.records.some((record) => record.kind === "comment_router");
  const remainingResult = publishRemainingFirst
    ? publishGit({ ...publicationOptions, paths: remainingPaths })
    : undefined;
  const contentHash = stateAppendContentHash(plan.records);
  const deliveryId = `router:${stateAppendLane(plan.records)}-${deliveryPart(env.GITHUB_RUN_ID, "local")}-${deliveryPart(env.GITHUB_RUN_ATTEMPT, "1")}-${contentHash}`;

  let appendResult: StateAppendResult;
  try {
    appendResult = await postStateAppend({
      queueUrl,
      webhookSecret,
      deliveryId,
      records: plan.records,
      ...(runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}),
    });
  } catch {
    console.warn("state-append shed/failed; falling back to git publish");
    return publishGit(publicationOptions);
  }
  if (!appendResult.ok || appendResult.shed) {
    console.warn("state-append shed/failed; falling back to git publish");
    return publishGit(publicationOptions);
  }

  if (remainingResult) return remainingResult;
  if (remainingPaths.length > 0)
    return publishGit({ ...publicationOptions, paths: remainingPaths });
  console.log(
    `Appended ${plan.records.length} state record(s) and ${canonicalAppended ? canonicalPlan.mutations.length : 0} canonical tuple(s) to durable state`,
  );
  return "appended";
}

const RECORD_TUPLE_PATH =
  /^records\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/(items|closed|plans|decision-packets)\/([1-9]\d*)\.(md|json)$/;
const RECORD_TUPLE_SECTIONS = ["items", "closed", "plans", "decision-packets"] as const;

function planCanonicalRecordTuples(
  requestedPaths: readonly string[],
  root: string,
  stateRoot: string | undefined,
  env: NodeJS.ProcessEnv,
): CanonicalRecordPlan {
  const recordRequests = requestedPaths.filter((path) => isRecordsPath(normalizedPath(path)));
  if (recordRequests.length === 0) {
    return { mutations: [], remainingPaths: [...requestedPaths] };
  }
  if (!stateRoot) throw new Error("record publication requires a hydrated state checkout");
  const localFiles = collectRequestedRecordFiles(root, recordRequests);
  const stateFiles = collectRequestedRecordFiles(stateRoot, recordRequests);
  const changedPaths = new Set(
    [...new Set([...localFiles.keys(), ...stateFiles.keys()])].filter(
      (path) => localFiles.get(path) !== stateFiles.get(path),
    ),
  );
  const changedTupleKeys = new Set<string>();
  for (const path of changedPaths) {
    const match = RECORD_TUPLE_PATH.exec(path);
    if (match && (match[2] === "decision-packets") === (match[4] === "json")) {
      changedTupleKeys.add(`${match[1]}/${match[3]}`);
    } else if (/^records\/[^/]+\/(?:items|closed|plans|decision-packets)\//.test(path)) {
      throw new Error(`record tuple path is not canonically addressable: ${path}`);
    }
  }
  const mutations = [...changedTupleKeys].sort().map((key) => {
    const [repository, number] = key.split("/");
    if (!repository || !number) throw new Error(`invalid canonical tuple key: ${key}`);
    const paths = recordTuplePaths({ repository, number });
    const localContent = (path: string) =>
      localFiles.has(path) ? localFiles.get(path)! : readOptionalRecordFile(root, path);
    const stateContent = (path: string) =>
      stateFiles.has(path) ? stateFiles.get(path)! : readOptionalRecordFile(stateRoot, path);
    const tuple: RecordTupleContents = {
      paths,
      item: localContent(paths.item),
      closed: localContent(paths.closed),
      plan: localContent(paths.plan),
      packet: localContent(paths.packet),
    };
    validateRecordTuple(tuple, "canonical publication tuple");
    const operations = RECORD_TUPLE_SECTIONS.map((section) => {
      const path =
        section === "items"
          ? paths.item
          : section === "closed"
            ? paths.closed
            : section === "plans"
              ? paths.plan
              : paths.packet;
      const content = localContent(path);
      const expected = stateContent(path);
      return {
        path,
        expectedDigest: expected === null ? null : sha256(expected),
        ...(content === null ? {} : { contentBase64: Buffer.from(content).toString("base64") }),
      };
    });
    const contentHash = createHash("sha256")
      .update(JSON.stringify({ key, operations }))
      .digest("hex");
    return {
      deliveryId: `record-tuple:${deliveryPart(env.GITHUB_RUN_ID, "local")}:${deliveryPart(env.GITHUB_RUN_ATTEMPT, "1")}:${contentHash}`,
      key,
      operations,
    };
  });
  const remainingPaths = requestedPaths.flatMap((requestedPath) => {
    const normalized = normalizedPath(requestedPath);
    if (!isRecordsPath(normalized)) return [requestedPath];
    const coveredChanges = [...changedPaths].filter(
      (path) => path === normalized || path.startsWith(`${normalized}/`),
    );
    const otherChanges = coveredChanges.filter((path) => !RECORD_TUPLE_PATH.test(path));
    if (coveredChanges.some((path) => RECORD_TUPLE_PATH.test(path))) return otherChanges;
    return [requestedPath];
  });
  return { mutations, remainingPaths: [...new Set(remainingPaths)] };
}

function isRecordsPath(path: string): boolean {
  return path === "records" || path.startsWith("records/");
}

function readOptionalRecordFile(root: string, path: string): string | null {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return null;
  return readContainedRegularFile(root, path);
}

function collectRequestedRecordFiles(root: string, requestedPaths: readonly string[]) {
  const files = new Map<string, string>();
  for (const requestedPath of requestedPaths) {
    collectRecordFiles(root, normalizedPath(requestedPath), files);
  }
  return files;
}

function collectRecordFiles(root: string, relativePath: string, files: Map<string, string>): void {
  const absolute = resolve(root, relativePath);
  if (!existsSync(absolute)) return;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink())
    throw new Error(`record publication path is symbolic: ${relativePath}`);
  if (stat.isFile()) {
    files.set(relativePath, readContainedRegularFile(root, relativePath));
    return;
  }
  if (!stat.isDirectory())
    throw new Error(`record publication path is not regular: ${relativePath}`);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    collectRecordFiles(root, `${relativePath}/${entry.name}`, files);
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function planStateAppend(
  paths: readonly string[],
  root: string,
  stateRoot: string | undefined,
  now: (() => Date) | undefined,
): StateAppendPlan {
  const fallbackProducedAt = (now ?? (() => new Date()))().toISOString();
  const plans = [
    planSweepStatusAppend(paths, root, stateRoot, fallbackProducedAt),
    planCommentRouterAppend(paths, root, fallbackProducedAt),
    planApplyProofAppend(paths, root, fallbackProducedAt),
  ];
  return {
    consumedPaths: new Set(plans.flatMap((plan) => [...plan.consumedPaths])),
    records: plans.flatMap((plan) => plan.records),
  };
}

function planSweepStatusAppend(
  paths: readonly string[],
  root: string,
  stateRoot: string | undefined,
  fallbackProducedAt: string,
): StateAppendPlan {
  const consumedPaths = new Set<string>();
  const files = new Set<string>();
  for (const originalPath of paths) {
    const path = normalizedPath(originalPath);
    if (SWEEP_STATUS_FILE_PATTERN.test(path)) {
      const absolute = resolve(root, path);
      if (existsSync(absolute) && statSync(absolute).isFile()) {
        consumedPaths.add(originalPath);
        files.add(path);
      }
      continue;
    }
    if (path !== SWEEP_STATUS_DIRECTORY) continue;
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue;
    if (!stateRoot) throw new Error("cannot prove sweep status directory append is lossless");
    const stateDirectory = resolve(stateRoot, path);
    if (!existsSync(stateDirectory) || !statSync(stateDirectory).isDirectory()) {
      throw new Error("cannot compare sweep status directory with state checkout");
    }
    const sourceNames = sweepStatusDirectoryNames(absolute);
    const stateNames = sweepStatusDirectoryNames(stateDirectory);
    if (stateNames.some((name) => !sourceNames.includes(name))) {
      throw new Error("sweep status directory contains a deletion that requires git publish");
    }
    const directoryFiles = sourceNames.map((name) => `${SWEEP_STATUS_DIRECTORY}/${name}`);
    if (directoryFiles.length === 0) continue;
    consumedPaths.add(originalPath);
    for (const file of directoryFiles) files.add(file);
  }

  const records = [...files].sort().map((path): StateAppendInputRecord => {
    const match = SWEEP_STATUS_FILE_PATTERN.exec(path);
    if (!match) throw new Error(`invalid sweep status path: ${path}`);
    const payload = JSON.parse(readContainedRegularFile(root, path)) as unknown;
    if (!isRecord(payload) || payload.slug !== match[1]) {
      throw new Error(`sweep status payload slug does not match ${path}`);
    }
    const updatedAt = typeof payload.updated_at === "string" ? payload.updated_at : "";
    return {
      kind: "sweep_status",
      key: path,
      payload,
      produced_at: Number.isFinite(Date.parse(updatedAt)) ? updatedAt : fallbackProducedAt,
    };
  });
  return { consumedPaths, records };
}

function planCommentRouterAppend(
  paths: readonly string[],
  root: string,
  fallbackProducedAt: string,
): StateAppendPlan {
  const consumedPaths = new Set<string>();
  const records: StateAppendInputRecord[] = [];
  for (const originalPath of paths) {
    const path = normalizedPath(originalPath);
    if (path !== COMMENT_ROUTER_LEDGER_PATH) continue;
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    const payload = JSON.parse(readContainedRegularFile(root, path)) as unknown;
    if (!isRecord(payload)) throw new Error("comment router ledger must be a JSON object");
    const payloadText = JSON.stringify(payload);
    const updatedAt = typeof payload.updated_at === "string" ? payload.updated_at : "";
    consumedPaths.add(originalPath);
    records.push({
      kind: "comment_router",
      key: createHash("sha256").update(payloadText).digest("hex"),
      payload,
      produced_at: Number.isFinite(Date.parse(updatedAt)) ? updatedAt : fallbackProducedAt,
    });
  }
  return { consumedPaths, records };
}

function planApplyProofAppend(
  paths: readonly string[],
  root: string,
  producedAt: string,
): StateAppendPlan {
  const consumedPaths = new Set<string>();
  const records: StateAppendInputRecord[] = [];
  for (const originalPath of paths) {
    const path = normalizedPath(originalPath);
    if (!isActionEventPublishPath(path)) continue;
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    const payload = readContainedRegularFile(root, path);
    if (Buffer.byteLength(JSON.stringify(payload)) > STATE_APPEND_MAX_RECORD_BYTES) {
      console.warn(
        `State append apply-proof record ${path} exceeds ${STATE_APPEND_MAX_RECORD_BYTES} bytes; using git fallback`,
      );
      continue;
    }
    consumedPaths.add(originalPath);
    records.push({ kind: "apply_proof", key: path, payload, produced_at: producedAt });
  }
  return { consumedPaths, records };
}

function sweepStatusDirectoryNames(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  if (
    entries.some(
      (entry) => !entry.isFile() || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(entry.name),
    )
  ) {
    throw new Error("sweep status directory contains an unrepresentable entry");
  }
  return entries.map((entry) => entry.name).sort();
}

function readContainedRegularFile(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const candidate = resolve(realRoot, path);
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new Error(`state append source must not be a symbolic link: ${path}`);
  }
  const realFile = realpathSync(candidate);
  const relativePath = relative(realRoot, realFile);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`state append source resolves outside the workspace: ${path}`);
  }
  if (!statSync(realFile).isFile()) {
    throw new Error(`state append source is not a regular file: ${path}`);
  }
  return readFileSync(realFile, "utf8");
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function deliveryPart(value: string | undefined, fallback: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, "-");
  return normalized || fallback;
}

function stateAppendContentHash(records: readonly StateAppendInputRecord[]): string {
  return createHash("sha256")
    .update(JSON.stringify(records.map(({ kind, key, payload }) => ({ kind, key, payload }))))
    .digest("hex");
}

function stateAppendLane(records: readonly StateAppendInputRecord[]): string {
  const kinds = [...new Set(records.map((record) => record.kind))];
  return kinds.length === 1 ? kinds[0]!.replaceAll("_", "-") : "mixed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv: readonly string[]): Args {
  const parsed: Args = { message: "", paths: [], restorePaths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--message") parsed.message = requiredValue(argv, ++index, arg);
    else if (arg === "--path") parsed.paths.push(requiredValue(argv, ++index, arg));
    else if (arg === "--restore") parsed.restorePaths.push(requiredValue(argv, ++index, arg));
    else if (arg === "--max-attempts")
      parsed.maxAttempts = parsePositiveInt(requiredValue(argv, ++index, arg), arg);
    else if (arg === "--push-attempts")
      parsed.pushAttempts = parsePositiveInt(requiredValue(argv, ++index, arg), arg);
    else if (arg === "--rebase-strategy")
      parsed.rebaseStrategy = parseRebaseStrategy(requiredValue(argv, ++index, arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.message) throw new Error("--message is required");
  if (parsed.paths.length === 0) throw new Error("At least one --path is required");
  return parsed;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseRebaseStrategy(value: string): RebaseStrategy {
  if (
    value === "normal" ||
    value === "theirs" ||
    value === "apply-records" ||
    value === "reconcile-records"
  )
    return value;
  throw new Error("--rebase-strategy must be normal, theirs, apply-records, or reconcile-records");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  await publishMainWithStateAppend({
    message: args.message,
    paths: args.paths,
    restorePaths: args.restorePaths,
    maxAttempts: args.maxAttempts,
    pushAttempts: args.pushAttempts,
    rebaseStrategy: args.rebaseStrategy,
  });
}
