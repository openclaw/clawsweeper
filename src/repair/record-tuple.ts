import { createHash } from "node:crypto";

export type RecordTupleIdentity = {
  repository: string;
  number: string;
};

export type RecordTuplePaths = RecordTupleIdentity & {
  key: string;
  item: string;
  closed: string;
  plan: string;
  packet: string;
};

export type RecordTupleContents = {
  paths: RecordTuplePaths;
  item: string | null;
  closed: string | null;
  plan: string | null;
  packet: string | null;
};

export type RecordTupleWinner = "local" | "remote" | "base" | "equal";

export class RecordTupleError extends Error {}

type RecordTupleState = {
  location: "items" | "closed" | null;
  version: readonly (number | null)[] | null;
  transitionAt: number | null;
};

const VERSION_GROUPS = [
  ["item_updated_at", "current_item_updated_at", "current_item_closed_at"],
  ["reviewed_at", "last_full_review_at"],
  ["reconciled_at"],
  ["applied_at", "apply_checked_at"],
  ["review_comment_synced_at", "review_comment_checked_at"],
  ["labels_synced_at"],
  ["failed_review_retry_last_at"],
] as const;
const RECOGNIZED_TIMESTAMPS = new Set(VERSION_GROUPS.flat());

/**
 * Durable item state is one atomic tuple: exactly one open/closed record plus
 * its optional work plan and decision packet. Tuple conflicts use only the
 * recognized state-mutation timestamps above. Live subject freshness wins
 * first, then full-review freshness; operational reconcile/apply/comment/label
 * stamps can break ties but cannot revive older review content. Commit time is
 * never a fallback. Equal vectors with different contents are ambiguous.
 */
export function chooseRecordTupleWinner(options: {
  base: RecordTupleContents;
  local: RecordTupleContents;
  remote: RecordTupleContents;
}): RecordTupleWinner {
  const localChanged = !recordTupleContentsEqual(options.base, options.local);
  const remoteChanged = !recordTupleContentsEqual(options.base, options.remote);

  // Untouched legacy tuples are outside this reconciliation. In particular,
  // do not make an unrelated publish fail because old state contains a tuple
  // that predates the atomic invariant.
  if (!localChanged && !remoteChanged) return "equal";

  let baseState: RecordTupleState;
  try {
    baseState = inspectRecordTuple(options.base, "base");
  } catch (error) {
    if (!(error instanceof RecordTupleError)) throw error;
    return chooseWinnerFromInvalidBase({ ...options, localChanged, remoteChanged });
  }

  const localState = localChanged ? inspectRecordTuple(options.local, "local") : baseState;
  const remoteState = remoteChanged ? inspectRecordTuple(options.remote, "remote") : baseState;
  if (recordTupleContentsEqual(options.local, options.remote)) return "equal";

  // A deletion relative to an existing base is authoritative. This prevents a
  // stale broad snapshot from resurrecting a tuple removed by another writer.
  if (baseState.location) {
    if (!localState.location && remoteState.location) return "local";
    if (localState.location && !remoteState.location) return "remote";
    if (!localState.location && !remoteState.location) return "equal";
  } else {
    // With no base tuple, an uncontested creation is publishable.
    if (localState.location && !remoteState.location) return "local";
    if (!localState.location && remoteState.location) return "remote";
    if (!localState.location && !remoteState.location) return "equal";
  }

  const localRelation = compareTupleToBase(options.base, options.local, baseState, localState);
  const remoteRelation = compareTupleToBase(options.base, options.remote, baseState, remoteState);
  const localFresh = localRelation > 0;
  const remoteFresh = remoteRelation > 0;
  if (localFresh && !remoteFresh) return "local";
  if (remoteFresh && !localFresh) return "remote";
  if (!localFresh && !remoteFresh) return "base";
  return chooseBetweenChangedTuples(options.local, options.remote, localState, remoteState);
}

function chooseWinnerFromInvalidBase(options: {
  base: RecordTupleContents;
  local: RecordTupleContents;
  remote: RecordTupleContents;
  localChanged: boolean;
  remoteChanged: boolean;
}): RecordTupleWinner {
  const projection = uniqueValidBaseProjection(options.base);
  if (projection) {
    const projectedLocal = options.localChanged ? options.local : projection;
    const projectedRemote = options.remoteChanged ? options.remote : projection;
    const winner = chooseRecordTupleWinner({
      base: projection,
      local: projectedLocal,
      remote: projectedRemote,
    });
    const localHeals = options.localChanged && recordTupleContentsEqual(options.local, projection);
    const remoteHeals =
      options.remoteChanged && recordTupleContentsEqual(options.remote, projection);
    if ((winner === "base" || winner === "equal") && localHeals !== remoteHeals) {
      return localHeals ? "local" : "remote";
    }
    return winner;
  }

  const legacyBaseState = inspectLenientSinglePrimary(options.base, "legacy base");
  if (legacyBaseState) {
    return chooseWinnerFromLegacyInvalidBase(options, legacyBaseState);
  }

  throw tupleError(options.base.paths, "base is structurally invalid and cannot be ordered");
}

function chooseWinnerFromLegacyInvalidBase(
  options: {
    base: RecordTupleContents;
    local: RecordTupleContents;
    remote: RecordTupleContents;
    localChanged: boolean;
    remoteChanged: boolean;
  },
  baseState: RecordTupleState,
): RecordTupleWinner {
  const local = options.localChanged
    ? inspectLegacyCandidate(options.base, options.local, "local")
    : { state: baseState, structurallyValid: false };
  const remote = options.remoteChanged
    ? inspectLegacyCandidate(options.base, options.remote, "remote")
    : { state: baseState, structurallyValid: false };
  if (recordTupleContentsEqual(options.local, options.remote)) return "equal";

  if (baseState.location) {
    if (!local.state.location && remote.state.location) return "local";
    if (local.state.location && !remote.state.location) return "remote";
    if (!local.state.location && !remote.state.location) return "equal";
  }
  if (!local.state.location || !remote.state.location) {
    throw tupleError(options.base.paths, "ambiguous repair of legacy invalid tuple");
  }

  const localRelation = compareLegacyCandidateToBase(options.base, options.local, baseState, local);
  const remoteRelation = compareLegacyCandidateToBase(
    options.base,
    options.remote,
    baseState,
    remote,
  );
  const localFresh = localRelation > 0;
  const remoteFresh = remoteRelation > 0;
  if (localFresh && !remoteFresh) return "local";
  if (remoteFresh && !localFresh) return "remote";
  if (!localFresh && !remoteFresh) return "base";
  return chooseBetweenChangedTuples(options.local, options.remote, local.state, remote.state);
}

function inspectLegacyCandidate(
  base: RecordTupleContents,
  candidate: RecordTupleContents,
  label: string,
): { state: RecordTupleState; structurallyValid: boolean } {
  let structurallyValid = false;
  let strictState: RecordTupleState | null = null;
  try {
    strictState = inspectRecordTuple(candidate, label);
    structurallyValid = true;
  } catch (error) {
    if (!(error instanceof RecordTupleError)) throw error;
    if (!preservesLegacyInvalidSidecars(base, candidate)) throw error;
  }
  const primaryState = inspectLenientSinglePrimary(candidate, `${label} legacy candidate`);
  if (primaryState) return { state: primaryState, structurallyValid };
  if (strictState && strictState.location === null)
    return { state: strictState, structurallyValid };
  throw tupleError(candidate.paths, `${label} legacy candidate cannot be ordered`);
}

function compareLegacyCandidateToBase(
  base: RecordTupleContents,
  candidateContents: RecordTupleContents,
  baseState: RecordTupleState,
  candidate: { state: RecordTupleState; structurallyValid: boolean },
): number {
  if (recordTupleContentsEqual(base, candidateContents)) return 0;
  if (!baseState.version || !candidate.state.version) {
    throw tupleError(base.paths, "missing comparable state-mutation timestamp");
  }
  const comparison = compareRecordStates(candidate.state, baseState);
  if (comparison !== 0) return comparison;
  if (candidate.structurallyValid && isStrictLegacyStructuralRepair(base, candidateContents)) {
    return 1;
  }
  throw tupleError(base.paths, "equal mutation vector with different tuple contents");
}

function uniqueValidBaseProjection(base: RecordTupleContents): RecordTupleContents | null {
  if (base.item === null || base.closed === null) return null;
  const projections = [
    { ...base, closed: null },
    { ...base, item: null },
  ].filter((candidate) => {
    try {
      inspectRecordTuple(candidate, "base projection");
      return true;
    } catch (error) {
      if (error instanceof RecordTupleError) return false;
      throw error;
    }
  });
  return projections.length === 1 ? (projections[0] ?? null) : null;
}

function inspectLenientSinglePrimary(
  tuple: RecordTupleContents,
  label: string,
): RecordTupleState | null {
  if ((tuple.item === null) === (tuple.closed === null)) return null;
  const primary = tuple.item ?? tuple.closed;
  if (primary === null) return null;
  const frontMatter = parseFrontMatter(primary);
  const timestampGroups: number[][] = VERSION_GROUPS.map(() => []);
  collectFrontMatterTimestamps(frontMatter, timestampGroups, tuple.paths, label);
  const grouped = timestampGroups.map(maxTimestamp);
  return {
    location: tuple.item !== null ? "items" : "closed",
    version: grouped.every((timestamp) => timestamp === null) ? null : grouped,
    transitionAt: stateTransitionTimestamp(frontMatter, tuple.item !== null ? "items" : "closed"),
  };
}

function preservesLegacyInvalidSidecars(
  base: RecordTupleContents,
  candidate: RecordTupleContents,
): boolean {
  const basePrimary = base.item ?? base.closed;
  const candidatePrimary = candidate.item ?? candidate.closed;
  if (
    basePrimary === null ||
    candidatePrimary === null ||
    (base.item !== null) !== (candidate.item !== null)
  ) {
    return false;
  }
  const baseFrontMatter = parseFrontMatter(basePrimary);
  const candidateFrontMatter = parseFrontMatter(candidatePrimary);
  return (
    base.plan === candidate.plan &&
    base.packet === candidate.packet &&
    baseFrontMatter.get("decision_packet_sha256") ===
      candidateFrontMatter.get("decision_packet_sha256") &&
    baseFrontMatter.get("decision_packet_path") === candidateFrontMatter.get("decision_packet_path")
  );
}

function isStrictLegacyStructuralRepair(
  base: RecordTupleContents,
  candidate: RecordTupleContents,
): boolean {
  const basePrimary = base.item ?? base.closed;
  const candidatePrimary = candidate.item ?? candidate.closed;
  const planIsUnchangedOrClosedCleanup =
    base.plan === candidate.plan ||
    (base.closed !== null &&
      candidate.closed !== null &&
      base.plan !== null &&
      candidate.plan === null);
  return (
    basePrimary !== null &&
    candidatePrimary !== null &&
    (base.item !== null) === (candidate.item !== null) &&
    withoutPacketReferenceFields(basePrimary) === withoutPacketReferenceFields(candidatePrimary) &&
    planIsUnchangedOrClosedCleanup &&
    !recordTupleContentsEqual(base, candidate)
  );
}

function withoutPacketReferenceFields(markdown: string): string {
  return markdown.replace(/^decision_packet_(?:sha256|path):.*(?:\n|$)/gm, "");
}

function compareTupleToBase(
  base: RecordTupleContents,
  candidate: RecordTupleContents,
  baseState: RecordTupleState,
  candidateState: RecordTupleState,
): number {
  if (recordTupleContentsEqual(base, candidate)) return 0;
  if (!baseState.version || !candidateState.version) {
    throw tupleError(candidate.paths, "missing comparable state-mutation timestamp");
  }
  const comparison = compareRecordStates(candidateState, baseState);
  if (comparison !== 0) return comparison;
  if (isStrictPlanRemoval(base, candidate)) return 1;
  throw tupleError(candidate.paths, "equal mutation vector with different tuple contents");
}

function chooseBetweenChangedTuples(
  local: RecordTupleContents,
  remote: RecordTupleContents,
  localState: RecordTupleState,
  remoteState: RecordTupleState,
): RecordTupleWinner {
  if (!localState.version || !remoteState.version) {
    throw tupleError(local.paths, "missing comparable state-mutation timestamp");
  }
  const comparison = compareRecordStates(localState, remoteState);
  if (comparison > 0) return "local";
  if (comparison < 0) return "remote";
  if (isStrictPlanRemoval(remote, local)) return "local";
  if (isStrictPlanRemoval(local, remote)) return "remote";
  throw tupleError(local.paths, "equal mutation vector with different tuple contents");
}

function isStrictPlanRemoval(base: RecordTupleContents, candidate: RecordTupleContents): boolean {
  return (
    base.plan !== null &&
    candidate.plan === null &&
    base.item === candidate.item &&
    base.closed === candidate.closed &&
    base.packet === candidate.packet
  );
}

export function validateRecordTuple(tuple: RecordTupleContents, label = "tuple"): void {
  inspectRecordTuple(tuple, label);
}

export function recordTupleContentsEqual(
  left: RecordTupleContents,
  right: RecordTupleContents,
): boolean {
  return (
    left.item === right.item &&
    left.closed === right.closed &&
    left.plan === right.plan &&
    left.packet === right.packet
  );
}

export function recordTupleIdentityForPath(path: string): RecordTupleIdentity | undefined {
  const markdownMatch = /^records\/([^/]+)\/(?:items|closed|plans)\/([^/]+\.md)$/.exec(path);
  if (markdownMatch) {
    const repository = markdownMatch[1];
    const filename = markdownMatch[2];
    const number = filename ? /(?:^|-)(\d+)\.md$/.exec(filename)?.[1] : undefined;
    return repository && number ? { repository, number } : undefined;
  }
  const packetMatch = /^records\/([^/]+)\/decision-packets\/(\d+)\.json$/.exec(path);
  const repository = packetMatch?.[1];
  const number = packetMatch?.[2];
  return repository && number ? { repository, number } : undefined;
}

export function recordTupleMarkdownFileForPath(path: string): string | undefined {
  return /^records\/[^/]+\/(?:items|closed|plans)\/([^/]+\.md)$/.exec(path)?.[1];
}

export function recordTuplePaths(
  identity: RecordTupleIdentity,
  markdownFiles: { item?: string; closed?: string; plan?: string } = {},
): RecordTuplePaths {
  const root = `records/${identity.repository}`;
  const fallback =
    markdownFiles.item ?? markdownFiles.closed ?? markdownFiles.plan ?? `${identity.number}.md`;
  return {
    ...identity,
    key: `${identity.repository}/${identity.number}`,
    item: `${root}/items/${markdownFiles.item ?? fallback}`,
    closed: `${root}/closed/${markdownFiles.closed ?? fallback}`,
    plan: `${root}/plans/${markdownFiles.plan ?? fallback}`,
    packet: `${root}/decision-packets/${identity.number}.json`,
  };
}

export function recordTuplePathList(paths: RecordTuplePaths): string[] {
  return [paths.item, paths.closed, paths.plan, paths.packet];
}

function inspectRecordTuple(tuple: RecordTupleContents, label: string): RecordTupleState {
  if (tuple.item !== null && tuple.closed !== null) {
    throw tupleError(tuple.paths, `${label} has both open and closed primary records`);
  }
  const primary = tuple.item ?? tuple.closed;
  if (primary === null) {
    if (tuple.plan !== null || tuple.packet !== null) {
      throw tupleError(tuple.paths, `${label} has orphaned sidecars without a primary record`);
    }
    return { location: null, version: null, transitionAt: null };
  }
  const location: "items" | "closed" = tuple.item !== null ? "items" : "closed";

  const frontMatter = parseFrontMatter(primary);
  validatePacketReference(tuple, frontMatter, label);
  const timestampGroups: number[][] = VERSION_GROUPS.map(() => []);
  collectFrontMatterTimestamps(frontMatter, timestampGroups, tuple.paths, label);
  if (tuple.plan !== null) {
    collectFrontMatterTimestamps(
      parseFrontMatter(tuple.plan),
      timestampGroups,
      tuple.paths,
      `${label} plan`,
    );
  }
  if (tuple.packet !== null) {
    collectPacketTimestamps(tuple.packet, timestampGroups, tuple.paths, label);
  }
  const grouped = timestampGroups.map(maxTimestamp);
  return {
    location,
    version: grouped.every((timestamp) => timestamp === null) ? null : grouped,
    transitionAt: stateTransitionTimestamp(frontMatter, location),
  };
}

function validatePacketReference(
  tuple: RecordTupleContents,
  frontMatter: ReadonlyMap<string, string>,
  label: string,
): void {
  const digest = frontMatter.get("decision_packet_sha256");
  const pointer = frontMatter.get("decision_packet_path");
  if (digest === undefined && pointer === undefined) {
    if (tuple.packet !== null) {
      throw tupleError(tuple.paths, `${label} has a packet without a primary pointer`);
    }
    return;
  }
  if (digest === undefined || pointer === undefined) {
    throw tupleError(tuple.paths, `${label} has an incomplete decision packet reference`);
  }
  if (digest === "none" && pointer === "none") {
    if (tuple.packet !== null) {
      throw tupleError(tuple.paths, `${label} keeps a packet after clearing its pointer`);
    }
    return;
  }
  if (pointer !== tuple.paths.packet) {
    throw tupleError(tuple.paths, `${label} points to unexpected packet path ${pointer}`);
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw tupleError(tuple.paths, `${label} has malformed decision packet digest`);
  }
  if (tuple.packet === null) {
    throw tupleError(tuple.paths, `${label} references a missing decision packet`);
  }
  const actual = createHash("sha256").update(tuple.packet).digest("hex");
  if (actual !== digest) {
    throw tupleError(tuple.paths, `${label} decision packet digest mismatch`);
  }
  validatePacketSemantics(tuple, frontMatter, label);
}

function validatePacketSemantics(
  tuple: RecordTupleContents,
  frontMatter: ReadonlyMap<string, string>,
  label: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tuple.packet ?? "");
  } catch {
    throw tupleError(tuple.paths, `${label} decision packet is malformed JSON`);
  }
  if (!isObject(parsed) || parsed.version !== 1) {
    throw tupleError(tuple.paths, `${label} decision packet has unsupported schema`);
  }
  const subject = isObject(parsed.subject) ? parsed.subject : null;
  const source = isObject(parsed.source) ? parsed.source : null;
  const primaryPath = tuple.item !== null ? tuple.paths.item : tuple.paths.closed;
  if (
    !subject ||
    typeof subject.repo !== "string" ||
    typeof subject.number !== "number" ||
    !Number.isInteger(subject.number)
  ) {
    throw tupleError(tuple.paths, `${label} decision packet has malformed subject identity`);
  }
  if (
    subject.repo.replace("/", "-") !== tuple.paths.repository ||
    String(subject.number) !== tuple.paths.number
  ) {
    throw tupleError(tuple.paths, `${label} decision packet belongs to another subject`);
  }
  if (!source || source.reportPath !== primaryPath) {
    throw tupleError(tuple.paths, `${label} decision packet points to another primary record`);
  }
  const primaryNumber = frontMatter.get("number");
  const primaryRepository = frontMatter.get("repository");
  if (primaryNumber !== undefined && primaryNumber !== tuple.paths.number) {
    throw tupleError(tuple.paths, `${label} primary record has mismatched number`);
  }
  if (primaryRepository !== undefined && primaryRepository !== subject.repo) {
    throw tupleError(tuple.paths, `${label} primary record has mismatched repository`);
  }
}

function parseFrontMatter(markdown: string): Map<string, string> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return new Map();
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return new Map();
  const values = new Map<string, string>();
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    values.set(match[1], unquoteYamlScalar(match[2] ?? ""));
  }
  return values;
}

function unquoteYamlScalar(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function collectFrontMatterTimestamps(
  frontMatter: ReadonlyMap<string, string>,
  groups: number[][],
  paths: RecordTuplePaths,
  label: string,
): void {
  for (const [key, value] of frontMatter) {
    if (!RECOGNIZED_TIMESTAMPS.has(key as (typeof VERSION_GROUPS)[number][number])) continue;
    addTimestamp(groups, key, value, paths, label);
  }
}

function collectPacketTimestamps(
  packet: string,
  groups: number[][],
  paths: RecordTuplePaths,
  label: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packet);
  } catch {
    throw tupleError(paths, `${label} decision packet is malformed JSON`);
  }
  if (!isObject(parsed)) return;
  addOptionalTimestamp(groups, "reviewed_at", parsed.generatedAt, paths, `${label} packet`);
  addOptionalTimestamp(groups, "item_updated_at", parsed.updatedAt, paths, `${label} packet`);
  const source = isObject(parsed.source) ? parsed.source : undefined;
  addOptionalTimestamp(groups, "reviewed_at", source?.reviewedAt, paths, `${label} packet`);
}

function addOptionalTimestamp(
  groups: number[][],
  key: (typeof VERSION_GROUPS)[number][number],
  value: unknown,
  paths: RecordTuplePaths,
  label: string,
): void {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") {
    throw tupleError(paths, `${label} has non-string ${key}`);
  }
  addTimestamp(groups, key, value, paths, label);
}

function addTimestamp(
  groups: number[][],
  key: string,
  value: string,
  paths: RecordTuplePaths,
  label: string,
): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw tupleError(paths, `${label} has malformed ${key}`);
  }
  const group = VERSION_GROUPS.findIndex((keys) => (keys as readonly string[]).includes(key));
  if (group !== -1) groups[group]?.push(timestamp);
}

function maxTimestamp(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function stateTransitionTimestamp(
  frontMatter: ReadonlyMap<string, string>,
  location: "items" | "closed",
): number | null {
  const keys =
    location === "closed"
      ? (["applied_at", "current_item_closed_at", "reconciled_at", "apply_checked_at"] as const)
      : (["reconciled_at"] as const);
  const timestamps = keys.flatMap((key) => {
    const value = frontMatter.get(key);
    if (value === undefined || value === "") return [];
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? [timestamp] : [];
  });
  return maxTimestamp(timestamps);
}

function compareRecordStates(local: RecordTupleState, remote: RecordTupleState): number {
  if (!local.version || !remote.version) return 0;
  const subjectComparison = compareVersionVectors(local.version, remote.version, 0, 1);
  if (subjectComparison !== 0) return subjectComparison;
  if (local.location !== remote.location) {
    const localTransition = local.transitionAt ?? Number.NEGATIVE_INFINITY;
    const remoteTransition = remote.transitionAt ?? Number.NEGATIVE_INFINITY;
    if (localTransition !== remoteTransition) return localTransition > remoteTransition ? 1 : -1;
  }
  return compareVersionVectors(local.version, remote.version, 1);
}

function compareVersionVectors(
  local: readonly (number | null)[],
  remote: readonly (number | null)[],
  start = 0,
  end = Math.max(local.length, remote.length),
): number {
  for (let index = start; index < end; index += 1) {
    const left = local[index] ?? Number.NEGATIVE_INFINITY;
    const right = remote[index] ?? Number.NEGATIVE_INFINITY;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tupleError(paths: RecordTuplePaths, detail: string): Error {
  return new RecordTupleError(`Invalid record tuple ${paths.key}: ${detail}`);
}
