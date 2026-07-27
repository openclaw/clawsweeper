#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { verifyWorkerRecordParity } from "./verify-worker-record-parity.ts";
import {
  collectGitRecords,
  exportWorkerRecords,
  replayWorkerRecordProjections,
  signedPost,
  type WorkerRecord,
} from "./worker-records.ts";

const TUPLE_SECTIONS = ["items", "closed", "plans", "decision-packets"] as const;
type TupleSection = (typeof TUPLE_SECTIONS)[number];
type GitHubState = "open" | "closed";

export type RecordParityMismatch = {
  path: string;
  gitDigest: string | null;
  workerDigest: string | null;
};

export type AuthorityDecision = {
  path: string;
  itemId: string;
  verdict: "git-wins" | "canonical-wins" | "both-stale" | "lag";
  reason: string;
};

export type AuthorityTupleDecision = {
  itemId: string;
  verdict: "git-wins" | "canonical-wins" | "both-stale";
  reason: string;
};

type ParsedRecordPath = { path: string; section: TupleSection | "commits"; id: string };

export type GitCommitTimesResult = {
  times: Map<string, string>;
  unavailable: Set<string>;
};

export function decideRecordAuthority(options: {
  mismatches: readonly RecordParityMismatch[];
  canonicalRecords: ReadonlyMap<string, WorkerRecord>;
  gitRecordPaths: ReadonlySet<string>;
  githubStates: ReadonlyMap<string, GitHubState>;
  gitCommitTimes: ReadonlyMap<string, string>;
  provenanceUnavailable?: ReadonlySet<string>;
}) {
  const decisions: AuthorityDecision[] = [];
  const degraded: string[] = [];
  const actionable = new Map<
    string,
    Array<{ mismatch: RecordParityMismatch; parsed: ParsedRecordPath }>
  >();
  for (const mismatch of options.mismatches) {
    const parsed = parseRecordPath(mismatch.path);
    if (mismatch.gitDigest === null) {
      decisions.push({
        path: mismatch.path,
        itemId: parsed.id,
        verdict: "lag",
        reason: "canonical record is waiting for git projection",
      });
      continue;
    }
    if (parsed.section === "commits") {
      throw new Error(`Cannot reconcile non-lag commit record through a tuple: ${mismatch.path}`);
    }
    const records = actionable.get(parsed.id) ?? [];
    records.push({ mismatch, parsed });
    actionable.set(parsed.id, records);
  }

  const tuples: AuthorityTupleDecision[] = [];
  for (const [itemId, records] of [...actionable].sort(
    (left, right) => Number(left[0]) - Number(right[0]),
  )) {
    const githubState = options.githubStates.get(itemId);
    if (!githubState) throw new Error(`Missing live GitHub state for item ${itemId}`);
    const expectedPrimary = githubState === "open" ? "items" : "closed";
    const oppositePrimary = expectedPrimary === "items" ? "closed" : "items";
    const canonicalPrimary = canonicalPrimarySection(options.canonicalRecords, itemId);
    const gitHasExpectedPrimary = options.gitRecordPaths.has(recordPath(expectedPrimary, itemId));
    const gitHasOppositePrimary = options.gitRecordPaths.has(recordPath(oppositePrimary, itemId));
    const gitOnlyPrimaries = records.filter(
      ({ mismatch, parsed }) =>
        mismatch.workerDigest === null &&
        (parsed.section === "items" || parsed.section === "closed"),
    );
    const correctPlacement = gitOnlyPrimaries.find(
      ({ parsed }) => parsed.section === expectedPrimary,
    );
    const gitOnlySidecar = records.find(
      ({ mismatch, parsed }) =>
        mismatch.workerDigest === null &&
        (parsed.section === "plans" || parsed.section === "decision-packets"),
    );

    let tuple: AuthorityTupleDecision;
    if (canonicalPrimary && canonicalPrimary !== expectedPrimary) {
      if (gitHasExpectedPrimary) {
        tuple = {
          itemId,
          verdict: "git-wins",
          reason: `GitHub is ${githubState}; canonical ${canonicalPrimary} placement is stale`,
        };
      } else if (options.gitRecordPaths.has(recordPath(canonicalPrimary, itemId))) {
        // Both stores agree on placement; only GitHub disagrees. Placement is not a
        // parity problem — the normal sweep corrects it when it re-reviews the item.
        tuple = {
          itemId,
          verdict: "both-stale",
          reason: `GitHub is ${githubState} but git and canonical agree on ${canonicalPrimary}; sweep will correct placement`,
        };
      } else {
        throw new Error(
          `Canonical placement for ${itemId} contradicts GitHub, but git lacks ${expectedPrimary}`,
        );
      }
    } else if (
      canonicalPrimary === expectedPrimary &&
      gitHasOppositePrimary &&
      !gitHasExpectedPrimary
    ) {
      tuple = {
        itemId,
        verdict: "canonical-wins",
        reason: `GitHub is ${githubState}; git ${oppositePrimary} placement is stale`,
      };
    } else if (correctPlacement) {
      tuple = {
        itemId,
        verdict: "git-wins",
        reason: `GitHub is ${githubState}; git has the matching primary missing from canonical`,
      };
    } else if (gitOnlySidecar) {
      tuple = {
        itemId,
        verdict: "git-wins",
        reason: `git-only ${gitOnlySidecar.parsed.section} must be imported with its atomic tuple`,
      };
    } else if (
      records.some(
        ({ mismatch, parsed }) =>
          mismatch.workerDigest !== null && options.provenanceUnavailable?.has(parsed.path),
      )
    ) {
      // Recency comparison is impossible without git provenance. Canonical is
      // the designed authority (git is a projection being retired), so keeping
      // it plus a projection replay is the safe degradation instead of aborting
      // the whole run. This is not destructive: the divergent git content stays
      // recoverable in the state repo's commit history, and every degraded path
      // is printed and recorded in the decision table for operator follow-up.
      for (const { mismatch, parsed } of records) {
        if (mismatch.workerDigest !== null && options.provenanceUnavailable?.has(parsed.path)) {
          degraded.push(parsed.path);
        }
      }
      tuple = {
        itemId,
        verdict: "canonical-wins",
        reason:
          "provenance-unavailable: git commit recency could not be read; canonical stays authoritative",
      };
    } else {
      let gitNewer: ParsedRecordPath | null = null;
      for (const { mismatch, parsed } of records) {
        if (mismatch.workerDigest === null) continue;
        const canonical = options.canonicalRecords.get(parsed.path);
        const gitCommittedAt = options.gitCommitTimes.get(parsed.path);
        if (!canonical?.updatedAt || !gitCommittedAt) {
          throw new Error(`Missing provenance for content-differ record: ${parsed.path}`);
        }
        const gitTime = Date.parse(gitCommittedAt);
        const canonicalTime = Date.parse(canonical.updatedAt);
        if (gitTime === canonicalTime) {
          throw new Error(`Equal provenance timestamps cannot establish authority: ${parsed.path}`);
        }
        if (gitTime > canonicalTime) gitNewer ??= parsed;
      }
      tuple = gitNewer
        ? {
            itemId,
            verdict: "git-wins",
            reason: `${gitNewer.path} was committed after canonical provenance`,
          }
        : {
            itemId,
            verdict: "canonical-wins",
            reason: "canonical provenance post-dates every differing git record",
          };
    }
    tuples.push(tuple);
    for (const { parsed } of records) {
      decisions.push({ path: parsed.path, itemId, verdict: tuple.verdict, reason: tuple.reason });
    }
  }

  return {
    decisions: decisions.sort((left, right) => left.path.localeCompare(right.path)),
    tuples,
    degraded: degraded.sort((left, right) => left.localeCompare(right)),
  };
}

export async function reconcileWorkerRecordAuthority(options: {
  stateRoot: string;
  targetRepo: string;
  repoSlug: string;
  baseUrl: string;
  webhookSecret: string;
  parityReport?: string;
  summaryFile?: string;
  dryRun?: boolean;
  fetch?: typeof globalThis.fetch;
  githubStates?: (targetRepo: string, itemIds: readonly string[]) => Map<string, GitHubState>;
  gitCommitTimes?: (
    stateRoot: string,
    repoSlug: string,
    recordPaths: readonly string[],
  ) => GitCommitTimesResult;
}) {
  validateTargetRepo(options.targetRepo);
  const parity = options.parityReport
    ? readParityReport(options.parityReport, options.repoSlug)
    : await verifyWorkerRecordParity(
        {
          stateRoot: options.stateRoot,
          repoSlug: options.repoSlug,
          recordsUrl: options.baseUrl,
          webhookSecret: options.webhookSecret,
        },
        options.fetch,
      );
  const canonical = await exportWorkerRecords({
    baseUrl: options.baseUrl,
    webhookSecret: options.webhookSecret,
    repoSlug: options.repoSlug,
    fetch: options.fetch,
  });
  const canonicalRecords = new Map(
    canonical.records.map((record) => [recordPath(record.section, record.id), record]),
  );
  const gitRecords = new Map(
    collectGitRecords(options.stateRoot, options.repoSlug).map((record) => [
      recordPath(record.section, record.id),
      record,
    ]),
  );
  const parsed = parity.mismatches.map((mismatch) => parseRecordPath(mismatch.path));
  const itemIds = [
    ...new Set(
      parsed.flatMap((record, index) =>
        record.section === "commits" || parity.mismatches[index]?.gitDigest === null
          ? []
          : [record.id],
      ),
    ),
  ].sort(compareNumericText);
  const githubStates = (options.githubStates ?? loadGitHubStates)(options.targetRepo, itemIds);
  const contentDifferPaths = parity.mismatches.flatMap((mismatch) =>
    mismatch.gitDigest !== null && mismatch.workerDigest !== null ? [mismatch.path] : [],
  );
  const provenance = (options.gitCommitTimes ?? loadGitCommitTimes)(
    options.stateRoot,
    options.repoSlug,
    contentDifferPaths,
  );
  const authority = decideRecordAuthority({
    mismatches: parity.mismatches,
    canonicalRecords,
    gitRecordPaths: new Set(gitRecords.keys()),
    githubStates,
    gitCommitTimes: provenance.times,
    provenanceUnavailable: provenance.unavailable,
  });
  if (authority.degraded.length) {
    console.error(
      `WARNING: git provenance unavailable for ${authority.degraded.length} record(s); ` +
        "degraded to canonical-wins + projection replay:",
    );
    for (const degradedPath of authority.degraded) console.error(`  - ${degradedPath}`);
  }
  if (options.summaryFile) {
    appendFileSync(
      options.summaryFile,
      renderDecisionTable(
        options.targetRepo,
        options.dryRun === true,
        authority.decisions,
        authority.degraded.length,
      ),
    );
  }

  const corrections: Array<{
    itemId: string;
    deduped: boolean;
    revision: number;
    sequence: number;
  }> = [];
  const gitWinners = authority.tuples.filter(
    (tuple) => tuple.verdict === "git-wins" || tuple.verdict === "both-stale",
  );
  if (!options.dryRun) {
    for (const tuple of gitWinners) {
      const mutation = gitTupleMutation({
        repoSlug: options.repoSlug,
        itemId: tuple.itemId,
        // A both-stale tuple keeps the placement both stores agree on, so the
        // corrective tuple validates against the current canonical primary.
        primarySection:
          tuple.verdict === "both-stale"
            ? canonicalPrimarySection(canonicalRecords, tuple.itemId)!
            : githubStates.get(tuple.itemId)! === "open"
              ? "items"
              : "closed",
        gitRecords,
        canonicalRecords,
      });
      const response = await signedPost<{
        ok?: boolean;
        deduped?: boolean;
        revision?: number;
        sequence?: number;
      }>({
        baseUrl: options.baseUrl,
        path: "/internal/state/records/tuples",
        webhookSecret: options.webhookSecret,
        body: mutation,
        fetch: options.fetch,
      });
      if (
        response.ok !== true ||
        !Number.isSafeInteger(response.revision) ||
        Number(response.revision) < 1 ||
        !Number.isSafeInteger(response.sequence) ||
        Number(response.sequence) < 1
      ) {
        throw new Error(`Worker returned an invalid corrective tuple receipt for ${tuple.itemId}`);
      }
      corrections.push({
        itemId: tuple.itemId,
        deduped: response.deduped === true,
        revision: Number(response.revision),
        sequence: Number(response.sequence),
      });
    }
  }

  const canonicalWinnerIds = authority.tuples
    .filter((tuple) => tuple.verdict === "canonical-wins")
    .map((tuple) => tuple.itemId);
  const replay =
    !options.dryRun && canonicalWinnerIds.length
      ? await replayWorkerRecordProjections({
          baseUrl: options.baseUrl,
          webhookSecret: options.webhookSecret,
          repoSlug: options.repoSlug,
          itemIds: canonicalWinnerIds,
          fetch: options.fetch,
        })
      : null;
  if (replay?.failed) {
    throw new Error(
      `Authority reconciliation replay failed for ${replay.failed} tuple(s): ${replay.failedIds.join(",")}`,
    );
  }

  const result = {
    repoSlug: options.repoSlug,
    targetRepo: options.targetRepo,
    dryRun: options.dryRun === true,
    mismatchCount: parity.mismatches.length,
    decisions: authority.decisions,
    degradedPaths: authority.degraded,
    degradedCount: authority.degraded.length,
    corrections,
    replay,
  };
  if (options.summaryFile) appendFileSync(options.summaryFile, renderDecisionOutcome(result));
  return result;
}

function gitTupleMutation(options: {
  repoSlug: string;
  itemId: string;
  primarySection: "items" | "closed";
  gitRecords: ReadonlyMap<string, { content: string; digest: string }>;
  canonicalRecords: ReadonlyMap<string, WorkerRecord>;
}) {
  const primarySection = options.primarySection;
  const primary = options.gitRecords.get(recordPath(primarySection, options.itemId));
  if (!primary) {
    throw new Error(
      `Git tuple ${options.repoSlug}/${options.itemId} lacks live ${primarySection} primary`,
    );
  }
  const packet = referencedPacket(
    options.repoSlug,
    options.itemId,
    primary.content,
    options.gitRecords,
  );
  const target = new Map<TupleSection, { content: string; digest: string } | null>([
    ["items", primarySection === "items" ? primary : null],
    ["closed", primarySection === "closed" ? primary : null],
    [
      "plans",
      primarySection === "items"
        ? (options.gitRecords.get(recordPath("plans", options.itemId)) ?? null)
        : null,
    ],
    ["decision-packets", packet],
  ]);
  const identity = TUPLE_SECTIONS.map((section) => {
    const current = options.canonicalRecords.get(recordPath(section, options.itemId));
    return [
      section,
      current && !current.deleted ? current.digest : null,
      target.get(section)?.digest ?? null,
    ];
  });
  const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return {
    deliveryId: `record-reconcile:${options.repoSlug}:${options.itemId}:${fingerprint}`,
    key: `${options.repoSlug}/${options.itemId}`,
    operations: TUPLE_SECTIONS.map((section) => {
      const current = options.canonicalRecords.get(recordPath(section, options.itemId));
      const next = target.get(section);
      return {
        path: `records/${options.repoSlug}/${recordPath(section, options.itemId)}`,
        expectedDigest: current && !current.deleted ? current.digest : null,
        ...(next ? { contentBase64: Buffer.from(next.content).toString("base64") } : {}),
      };
    }),
  };
}

function referencedPacket(
  repoSlug: string,
  itemId: string,
  primary: string,
  gitRecords: ReadonlyMap<string, { content: string; digest: string }>,
) {
  const frontMatter = recordFrontMatter(primary);
  const digest = frontMatter.get("decision_packet_sha256");
  const pointer = frontMatter.get("decision_packet_path");
  if ((!digest && !pointer) || (digest === "none" && pointer === "none")) return null;
  const expectedPath = `records/${repoSlug}/decision-packets/${itemId}.json`;
  const packet = gitRecords.get(recordPath("decision-packets", itemId));
  if (!packet || packet.digest !== digest || pointer !== expectedPath) {
    throw new Error(`Git tuple ${repoSlug}/${itemId} has an invalid decision-packet reference`);
  }
  return packet;
}

function recordFrontMatter(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
  const values = new Map<string, string>();
  if (end === -1) return values;
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    const value = match[2] ?? "";
    values.set(
      match[1],
      value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
        ? value.slice(1, -1)
        : value,
    );
  }
  return values;
}

export function loadGitHubStates(targetRepo: string, itemIds: readonly string[]) {
  const [owner, name] = validateTargetRepo(targetRepo);
  const states = new Map<string, GitHubState>();
  for (let offset = 0; offset < itemIds.length; offset += 50) {
    const batch = itemIds.slice(offset, offset + 50);
    const fields = batch
      .map(
        (itemId) =>
          `n${itemId}: issueOrPullRequest(number: ${itemId}) { __typename ... on Issue { state } ... on PullRequest { state } }`,
      )
      .join("\n");
    const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
    const command = spawnSync("gh", ["api", "graphql", "-f", `query=${query}`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (command.status !== 0) {
      throw new Error(`gh api failed while reading live item state: ${command.stderr.trim()}`);
    }
    const repository = JSON.parse(command.stdout).data?.repository as
      | Record<string, { state?: string } | null>
      | undefined;
    for (const itemId of batch) {
      const state = repository?.[`n${itemId}`]?.state;
      if (state === "OPEN") states.set(itemId, "open");
      else if (state === "CLOSED" || state === "MERGED") states.set(itemId, "closed");
      else throw new Error(`GitHub item ${targetRepo}#${itemId} was not found`);
    }
  }
  return states;
}

export type GhCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type GitCommitTimesDeps = {
  runGh?: (args: readonly string[]) => GhCommandResult;
  sleep?: (ms: number) => void;
};

const PROVENANCE_MAX_ATTEMPTS = 4;
const PROVENANCE_BASE_DELAY_MS = 2000;

export function loadGitCommitTimes(
  _stateRoot: string,
  repoSlug: string,
  recordPaths: readonly string[],
  deps?: GitCommitTimesDeps,
): GitCommitTimesResult {
  const requested = new Set(recordPaths);
  const times = new Map<string, string>();
  const unavailable = new Set<string>();
  if (!requested.size) return { times, unavailable };
  const paths = [...requested];
  for (let offset = 0; offset < paths.length; offset += 50) {
    const batch = paths.slice(offset, offset + 50);
    const fields = batch
      .map(
        (recordPath, index) =>
          `p${index}: history(first: 1, path: ${JSON.stringify(`records/${repoSlug}/${recordPath}`)}) { nodes { committedDate } }`,
      )
      .join("\n");
    const query = `query { repository(owner: "openclaw", name: "clawsweeper-state") { object(expression: "state") { ... on Commit { ${fields} } } } }`;
    const stdout = runProvenanceQueryWithRetry(query, deps);
    if (stdout === null) {
      // Retries exhausted on a transient failure: mark the batch degraded
      // instead of aborting the whole reconcile run.
      for (const recordPath of batch) unavailable.add(recordPath);
      continue;
    }
    const commit = JSON.parse(stdout).data?.repository?.object as
      | Record<string, { nodes?: Array<{ committedDate?: string }> }>
      | undefined;
    for (let index = 0; index < batch.length; index += 1) {
      const recordPath = batch[index]!;
      const committedAt = commit?.[`p${index}`]?.nodes?.[0]?.committedDate;
      if (committedAt) times.set(recordPath, committedAt);
    }
  }
  for (const recordPath of requested) {
    if (!times.has(recordPath) && !unavailable.has(recordPath)) {
      throw new Error(`Git provenance was not found for ${recordPath}`);
    }
  }
  return { times, unavailable };
}

function runProvenanceQueryWithRetry(query: string, deps?: GitCommitTimesDeps): string | null {
  const runGh = deps?.runGh ?? runGhCommand;
  const sleep = deps?.sleep ?? sleepSync;
  let lastFailure = "";
  for (let attempt = 1; attempt <= PROVENANCE_MAX_ATTEMPTS; attempt += 1) {
    const command = runGh(["api", "graphql", "-f", `query=${query}`]);
    if (command.status === 0) return command.stdout;
    lastFailure = (command.stderr.trim() || command.error?.message || "unknown failure").trim();
    if (!isRetryableGhFailure(command)) {
      throw new Error(`gh api failed while reading git provenance: ${lastFailure}`);
    }
    if (attempt < PROVENANCE_MAX_ATTEMPTS) {
      const delayMs = PROVENANCE_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.error(
        `gh git provenance read failed (attempt ${attempt}/${PROVENANCE_MAX_ATTEMPTS}): ` +
          `${lastFailure}; retrying in ${delayMs / 1000}s`,
      );
      sleep(delayMs);
    }
  }
  console.error(
    `gh git provenance read failed after ${PROVENANCE_MAX_ATTEMPTS} attempts: ${lastFailure}`,
  );
  return null;
}

function isRetryableGhFailure(command: GhCommandResult) {
  // Spawn failures (gh missing, EPERM, ...) are configuration problems.
  if (command.error) return false;
  const httpStatus = /HTTP\s+(\d{3})/.exec(command.stderr);
  if (httpStatus?.[1]) return Number(httpStatus[1]) >= 500;
  // No HTTP status in stderr: retry only transport-shaped failures, not
  // GraphQL/query errors.
  return /connect|connection|timeout|timed out|temporar|unavailable|reset by peer|unexpected EOF|dial tcp|TLS handshake|network/i.test(
    command.stderr,
  );
}

function runGhCommand(args: readonly string[]): GhCommandResult {
  const command = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return {
    status: command.status,
    stdout: command.stdout ?? "",
    stderr: command.stderr ?? "",
    ...(command.error ? { error: command.error } : {}),
  };
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renderDecisionTable(
  targetRepo: string,
  dryRun: boolean,
  decisions: readonly AuthorityDecision[],
  degradedCount: number,
) {
  const counts = { "git-wins": 0, "canonical-wins": 0, "both-stale": 0, lag: 0 };
  for (const decision of decisions) counts[decision.verdict] += 1;
  const rows = decisions
    .map(
      (decision) =>
        `| \`${escapeTable(decision.path)}\` | ${decision.verdict} | ${escapeTable(decision.reason)} |`,
    )
    .join("\n");
  return [
    `### Worker record authority reconciliation: ${targetRepo}`,
    "",
    `Mode: ${dryRun ? "dry run" : "apply"}. Git wins: ${counts["git-wins"]}; canonical wins: ${counts["canonical-wins"]}; both stale: ${counts["both-stale"]}; projection lag: ${counts.lag}; provenance degradations: ${degradedCount}.`,
    "",
    "| Path | Verdict | Reason |",
    "| --- | --- | --- |",
    rows,
    "",
  ].join("\n");
}

function renderDecisionOutcome(result: {
  targetRepo: string;
  repoSlug: string;
  dryRun: boolean;
  decisions: readonly AuthorityDecision[];
  degradedPaths: readonly string[];
  corrections: readonly { itemId: string; deduped: boolean }[];
  replay: { attempted: number; deduped: number } | null;
}) {
  return [
    "#### Reconciliation outcome",
    "",
    `Corrective tuples: ${result.corrections.length}; replayed canonical tuples: ${result.replay?.attempted ?? 0}; deduped receipts: ${result.corrections.filter((entry) => entry.deduped).length + (result.replay?.deduped ?? 0)}; provenance degradations: ${result.degradedPaths.length}.`,
    ...(result.degradedPaths.length
      ? [
          "",
          "Degraded (provenance-unavailable) paths:",
          ...result.degradedPaths.map((degradedPath) => `- \`${escapeTable(degradedPath)}\``),
        ]
      : []),
    "",
  ].join("\n");
}

function escapeTable(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function readParityReport(reportPath: string, repoSlug: string) {
  const value = JSON.parse(readFileSync(reportPath, "utf8")) as {
    repoSlug?: string;
    gitRecords?: number;
    workerRecords?: number;
    mismatches?: RecordParityMismatch[];
  };
  if (value.repoSlug !== repoSlug || !Array.isArray(value.mismatches)) {
    throw new Error(`Parity report does not describe ${repoSlug}`);
  }
  return {
    repoSlug,
    gitRecords: Number(value.gitRecords ?? 0),
    workerRecords: Number(value.workerRecords ?? 0),
    mismatches: value.mismatches,
  };
}

function parseRecordPath(recordPathValue: string): ParsedRecordPath {
  const match =
    /^(items|closed|plans|commits)\/([^/]+)\.md$|^(decision-packets)\/([^/]+)\.json$/.exec(
      recordPathValue,
    );
  const section = (match?.[1] ?? match?.[3]) as ParsedRecordPath["section"] | undefined;
  const id = match?.[2] ?? match?.[4];
  if (
    !section ||
    !id ||
    (section === "commits" ? !/^[0-9a-f]{40}$/.test(id) : !/^[1-9]\d*$/.test(id))
  ) {
    throw new Error(`Invalid parity record path: ${recordPathValue}`);
  }
  return { path: recordPathValue, section, id };
}

function recordPath(section: WorkerRecord["section"], id: string) {
  return `${section}/${id}${section === "decision-packets" ? ".json" : ".md"}`;
}

function canonicalPrimarySection(
  records: ReadonlyMap<string, WorkerRecord>,
  itemId: string,
): "items" | "closed" | null {
  const item = records.get(recordPath("items", itemId));
  const closed = records.get(recordPath("closed", itemId));
  const openLive = item && !item.deleted ? item : null;
  const closedLive = closed && !closed.deleted ? closed : null;
  if (!openLive) return closedLive ? "closed" : null;
  if (!closedLive) return "items";
  if (openLive.revision === closedLive.revision) {
    throw new Error(`Canonical primary sections have equal authority for item ${itemId}`);
  }
  return openLive.revision > closedLive.revision ? "items" : "closed";
}

function validateTargetRepo(value: string): [string, string] {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match?.[1] || !match[2]) throw new Error("--target-repo must be owner/name");
  return [match[1], match[2]];
}

function compareNumericText(left: string, right: string) {
  return Number(left) - Number(right);
}

function parseArgs(argv: string[]) {
  const result: {
    stateDir?: string;
    targetRepo?: string;
    repoSlug?: string;
    recordsUrl?: string;
    parityReport?: string;
    summaryFile?: string;
    dryRun?: boolean;
  } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--state-dir") result.stateDir = requiredValue(argv, ++index, arg);
    else if (arg === "--target-repo") result.targetRepo = requiredValue(argv, ++index, arg);
    else if (arg === "--repo-slug") result.repoSlug = requiredValue(argv, ++index, arg);
    else if (arg === "--records-url") result.recordsUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--parity-report") result.parityReport = requiredValue(argv, ++index, arg);
    else if (arg === "--summary-file") result.summaryFile = requiredValue(argv, ++index, arg);
    else if (arg === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function requiredValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const webhookSecret = process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "";
  if (!webhookSecret) throw new Error("CLAWSWEEPER_WEBHOOK_SECRET is required");
  const result = await reconcileWorkerRecordAuthority({
    stateRoot: path.resolve(
      args.stateDir ?? process.env.CLAWSWEEPER_STATE_DIR ?? "clawsweeper-state",
    ),
    targetRepo: args.targetRepo ?? "",
    repoSlug: args.repoSlug ?? "",
    baseUrl:
      args.recordsUrl ??
      process.env.CLAWSWEEPER_RECORDS_URL ??
      process.env.CLAWSWEEPER_STATE_COORDINATOR_URL ??
      "https://clawsweeper.openclaw.ai",
    webhookSecret,
    parityReport: args.parityReport,
    summaryFile: args.summaryFile ?? process.env.GITHUB_STEP_SUMMARY,
    dryRun: args.dryRun,
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) await main();
