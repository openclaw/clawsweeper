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
  verdict: "git-wins" | "canonical-wins" | "lag";
  reason: string;
};

export type AuthorityTupleDecision = {
  itemId: string;
  verdict: "git-wins" | "canonical-wins";
  reason: string;
};

type ParsedRecordPath = { path: string; section: TupleSection | "commits"; id: string };

export function decideRecordAuthority(options: {
  mismatches: readonly RecordParityMismatch[];
  canonicalRecords: ReadonlyMap<string, WorkerRecord>;
  gitRecordPaths: ReadonlySet<string>;
  githubStates: ReadonlyMap<string, GitHubState>;
  gitCommitTimes: ReadonlyMap<string, string>;
}) {
  const decisions: AuthorityDecision[] = [];
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
      if (!gitHasExpectedPrimary) {
        throw new Error(
          `Canonical placement for ${itemId} contradicts GitHub, but git lacks ${expectedPrimary}`,
        );
      }
      tuple = {
        itemId,
        verdict: "git-wins",
        reason: `GitHub is ${githubState}; canonical ${canonicalPrimary} placement is stale`,
      };
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
  ) => Map<string, string>;
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
  const gitCommitTimes = (options.gitCommitTimes ?? loadGitCommitTimes)(
    options.stateRoot,
    options.repoSlug,
    contentDifferPaths,
  );
  const authority = decideRecordAuthority({
    mismatches: parity.mismatches,
    canonicalRecords,
    gitRecordPaths: new Set(gitRecords.keys()),
    githubStates,
    gitCommitTimes,
  });
  if (options.summaryFile) {
    appendFileSync(
      options.summaryFile,
      renderDecisionTable(options.targetRepo, options.dryRun === true, authority.decisions),
    );
  }

  const corrections: Array<{
    itemId: string;
    deduped: boolean;
    revision: number;
    sequence: number;
  }> = [];
  const gitWinners = authority.tuples.filter((tuple) => tuple.verdict === "git-wins");
  if (!options.dryRun) {
    for (const tuple of gitWinners) {
      const mutation = gitTupleMutation({
        repoSlug: options.repoSlug,
        itemId: tuple.itemId,
        githubState: githubStates.get(tuple.itemId)!,
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
    corrections,
    replay,
  };
  if (options.summaryFile) appendFileSync(options.summaryFile, renderDecisionOutcome(result));
  return result;
}

function gitTupleMutation(options: {
  repoSlug: string;
  itemId: string;
  githubState: GitHubState;
  gitRecords: ReadonlyMap<string, { content: string; digest: string }>;
  canonicalRecords: ReadonlyMap<string, WorkerRecord>;
}) {
  const primarySection = options.githubState === "open" ? "items" : "closed";
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

export function loadGitCommitTimes(
  _stateRoot: string,
  repoSlug: string,
  recordPaths: readonly string[],
) {
  const requested = new Set(recordPaths);
  if (!requested.size) return new Map<string, string>();
  const result = new Map<string, string>();
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
    const command = spawnSync("gh", ["api", "graphql", "-f", `query=${query}`], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (command.status !== 0) {
      throw new Error(`gh api failed while reading git provenance: ${command.stderr.trim()}`);
    }
    const commit = JSON.parse(command.stdout).data?.repository?.object as
      | Record<string, { nodes?: Array<{ committedDate?: string }> }>
      | undefined;
    for (let index = 0; index < batch.length; index += 1) {
      const recordPath = batch[index]!;
      const committedAt = commit?.[`p${index}`]?.nodes?.[0]?.committedDate;
      if (committedAt) result.set(recordPath, committedAt);
    }
  }
  for (const recordPath of requested) {
    if (!result.has(recordPath)) throw new Error(`Git provenance was not found for ${recordPath}`);
  }
  return result;
}

function renderDecisionTable(
  targetRepo: string,
  dryRun: boolean,
  decisions: readonly AuthorityDecision[],
) {
  const counts = { "git-wins": 0, "canonical-wins": 0, lag: 0 };
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
    `Mode: ${dryRun ? "dry run" : "apply"}. Git wins: ${counts["git-wins"]}; canonical wins: ${counts["canonical-wins"]}; projection lag: ${counts.lag}.`,
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
  corrections: readonly { itemId: string; deduped: boolean }[];
  replay: { attempted: number; deduped: number } | null;
}) {
  return [
    "#### Reconciliation outcome",
    "",
    `Corrective tuples: ${result.corrections.length}; replayed canonical tuples: ${result.replay?.attempted ?? 0}; deduped receipts: ${result.corrections.filter((entry) => entry.deduped).length + (result.replay?.deduped ?? 0)}.`,
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
