#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { parseArgs as parseNodeArgs } from "node:util";

export const STALE_QUEUED_AGE_MS = 90 * 60 * 1000;
export const STARTED_AROUND_EVIDENCE_COUNT = 3;
export const MAX_CANCELLATIONS_PER_PASS = 10;
export const EXPECTED_LONG_QUEUE_WORKFLOWS = new Set([
  ".github/workflows/repair-cluster-worker.yml",
]);

const DEFAULT_OUTPUT = ".artifacts/exact-review-dlq/stuck-queued-runs.json";
const DEFAULT_ZOMBIE_OUTPUT = ".artifacts/exact-review-dlq/stuck-queued-zombies.json";
const DEFAULT_ZOMBIE_SEED = "config/stuck-queued-run-zombies.json";
const MAX_LIST_PAGES = 10;
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const RUN_ID = /^[1-9]\d*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const STARTED_STATUSES = new Set(["in_progress", "completed"]);

export function selectStuckQueuedRuns({
  queuedRuns,
  historyByWorkflow,
  historyCompleteByWorkflow = new Map(),
  zombieRunIds = new Set(),
  excludedWorkflowPaths = EXPECTED_LONG_QUEUE_WORKFLOWS,
  nowMs,
  staleAgeMs = STALE_QUEUED_AGE_MS,
  evidenceCount = STARTED_AROUND_EVIDENCE_COUNT,
  maxCancellations = MAX_CANCELLATIONS_PER_PASS,
}) {
  const candidates = queuedRuns.map((run) => {
    const runId = normalizeRunId(run.id);
    const workflowId = normalizeRunId(run.workflow_id);
    const createdAtMs = Date.parse(String(run.created_at || ""));
    const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : null;
    const base = {
      run_id: runId,
      workflow_id: workflowId,
      workflow_path: String(run.path || ""),
      display_title: String(run.display_title || run.name || ""),
      html_url: String(run.html_url || ""),
      created_at: String(run.created_at || ""),
      age_minutes: ageMs === null ? null : Math.floor(ageMs / 60_000),
      discriminator: {
        required_newer_started_runs: evidenceCount,
        newer_started_run_count: 0,
        evidence: [],
        history_complete: false,
      },
      selected: false,
      reason: "",
    };

    if (String(run.status || "") !== "queued") return { ...base, reason: "not_queued" };
    if (!runId || !workflowId || ageMs === null) {
      return { ...base, reason: "invalid_run_identity" };
    }
    if (zombieRunIds.has(runId)) return { ...base, reason: "permanent_zombie" };
    if (excludedWorkflowPaths.has(base.workflow_path)) {
      return { ...base, reason: "expected_long_queue_workflow" };
    }
    if (ageMs <= staleAgeMs) return { ...base, reason: "younger_than_threshold" };

    const history = historyByWorkflow.get(workflowId);
    if (!Array.isArray(history)) {
      return { ...base, reason: "discriminator_unavailable" };
    }
    const evidence = history
      .filter((newerRun) => {
        const newerCreatedAtMs = Date.parse(String(newerRun.created_at || ""));
        return (
          normalizeRunId(newerRun.workflow_id) === workflowId &&
          normalizeRunId(newerRun.id) !== runId &&
          Number.isFinite(newerCreatedAtMs) &&
          newerCreatedAtMs > createdAtMs &&
          STARTED_STATUSES.has(String(newerRun.status || ""))
        );
      })
      .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
    const discriminator = {
      required_newer_started_runs: evidenceCount,
      newer_started_run_count: evidence.length,
      evidence: evidence.slice(0, evidenceCount).map((newerRun) => ({
        run_id: normalizeRunId(newerRun.id),
        status: String(newerRun.status),
        created_at: String(newerRun.created_at),
        run_started_at: String(newerRun.run_started_at || ""),
      })),
      history_complete: historyCompleteByWorkflow.get(workflowId) === true,
    };
    if (evidence.length < evidenceCount) {
      return {
        ...base,
        discriminator,
        reason: discriminator.history_complete
          ? "insufficient_newer_started_runs"
          : "discriminator_unavailable",
      };
    }
    return { ...base, discriminator, selected: true, reason: "started_around_it" };
  });

  const selected = candidates
    .filter((candidate) => candidate.selected)
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
  const selectedIds = new Set(
    selected.slice(0, maxCancellations).map((candidate) => candidate.run_id),
  );
  for (const candidate of selected.slice(maxCancellations)) {
    candidate.selected = false;
    candidate.reason = "cancellation_bound";
  }
  return {
    candidates,
    selected: candidates.filter((candidate) => selectedIds.has(candidate.run_id)),
  };
}

export async function remediateCandidate({ candidate, postCancellation, zombieState, now }) {
  const regular = await postCancellation(candidate.run_id, "cancel");
  if (regular.ok) {
    return {
      run_id: candidate.run_id,
      outcome: "cancel_requested",
      cancel_status: regular.status,
      force_cancel_status: null,
    };
  }
  if (regular.status !== 500) {
    return {
      run_id: candidate.run_id,
      outcome: "cancel_failed",
      cancel_status: regular.status,
      force_cancel_status: null,
    };
  }

  const forced = await postCancellation(candidate.run_id, "force-cancel");
  if (forced.ok) {
    return {
      run_id: candidate.run_id,
      outcome: "force_cancel_requested",
      cancel_status: regular.status,
      force_cancel_status: forced.status,
    };
  }
  if (forced.status !== 500) {
    return {
      run_id: candidate.run_id,
      outcome: "force_cancel_failed",
      cancel_status: regular.status,
      force_cancel_status: forced.status,
    };
  }

  zombieState.set(candidate.run_id, {
    run_id: candidate.run_id,
    workflow_id: candidate.workflow_id,
    workflow_path: candidate.workflow_path,
    created_at: candidate.created_at,
    recorded_at: now,
    reason: "cancel_and_force_cancel_http_500",
  });
  return {
    run_id: candidate.run_id,
    outcome: "permanent_zombie_recorded",
    cancel_status: 500,
    force_cancel_status: 500,
  };
}

export function mergeZombieRecords(...states) {
  const merged = new Map();
  for (const state of states) {
    for (const record of state?.zombies || []) {
      const runId = normalizeRunId(record?.run_id);
      if (!runId) throw new Error("zombie state contains an invalid run_id");
      merged.set(runId, {
        run_id: runId,
        workflow_id: normalizeRunId(record.workflow_id),
        workflow_path: String(record.workflow_path || ""),
        created_at: String(record.created_at || ""),
        recorded_at: String(record.recorded_at || ""),
        reason: String(record.reason || ""),
      });
    }
  }
  return merged;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`Usage:
  node scripts/stuck-queued-run-remediation.mjs [options]

Options:
  --repository <owner/repo>  Repository to inspect (default GITHUB_REPOSITORY)
  --execute                  Request cancellation; otherwise produce a read-only plan
  --output <path>            Summary artifact path
  --zombie-seed <path>       Checked-in permanent-zombie seed
  --zombie-state <path>      Restored prior artifact state, when available
  --zombie-output <path>     Refreshed permanent-zombie artifact path
  -h, --help                 Show this help
`);
    return;
  }

  const repository = args.repository || process.env.GITHUB_REPOSITORY || "";
  if (!REPOSITORY.test(repository)) throw new Error("--repository must be owner/repo");
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
  const api = githubApi({ repository, token });
  const generatedAt = new Date().toISOString();
  const nowMs = Date.parse(generatedAt);

  const seedState = await readZombieState(args.zombieSeed, { required: true });
  const priorState = args.zombieState
    ? await readZombieState(args.zombieState, { required: false })
    : { schema_version: 1, zombies: [] };
  const zombieState = mergeZombieRecords(seedState, priorState);
  const queuedInventory = await api.listQueuedRuns();
  const staleWorkflows = new Map();
  for (const run of queuedInventory.runs) {
    const workflowId = normalizeRunId(run.workflow_id);
    const createdAtMs = Date.parse(String(run.created_at || ""));
    if (
      workflowId &&
      Number.isFinite(createdAtMs) &&
      nowMs - createdAtMs > STALE_QUEUED_AGE_MS &&
      !zombieState.has(normalizeRunId(run.id)) &&
      !EXPECTED_LONG_QUEUE_WORKFLOWS.has(String(run.path || ""))
    ) {
      const current = staleWorkflows.get(workflowId);
      if (!current || createdAtMs < current) staleWorkflows.set(workflowId, createdAtMs);
    }
  }

  const historyByWorkflow = new Map();
  const historyCompleteByWorkflow = new Map();
  const historyErrors = [];
  for (const [workflowId, earliestCreatedAtMs] of staleWorkflows) {
    try {
      const history = await api.listWorkflowRuns({ workflowId, earliestCreatedAtMs });
      historyByWorkflow.set(workflowId, history.runs);
      historyCompleteByWorkflow.set(workflowId, history.complete);
    } catch (error) {
      historyErrors.push({ workflow_id: workflowId, error: errorMessage(error) });
    }
  }

  const plan = selectStuckQueuedRuns({
    queuedRuns: queuedInventory.runs,
    historyByWorkflow,
    historyCompleteByWorkflow,
    zombieRunIds: new Set(zombieState.keys()),
    nowMs,
  });
  const actions = [];
  if (args.execute) {
    for (const candidate of plan.selected) {
      const current = await api.getRun(candidate.run_id);
      if (String(current.status || "") !== "queued") {
        const action = {
          run_id: candidate.run_id,
          outcome: "no_longer_queued",
          cancel_status: null,
          force_cancel_status: null,
        };
        actions.push(action);
        logAction(action, candidate);
        continue;
      }
      const action = await remediateCandidate({
        candidate,
        postCancellation: api.postCancellation,
        zombieState,
        now: generatedAt,
      });
      actions.push(action);
      logAction(action, candidate);
    }
  }

  const summary = {
    schema_version: 1,
    generated_at: generatedAt,
    repository,
    dry_run: !args.execute,
    policy: {
      stale_age_minutes: STALE_QUEUED_AGE_MS / 60_000,
      required_newer_started_runs: STARTED_AROUND_EVIDENCE_COUNT,
      max_cancellations: MAX_CANCELLATIONS_PER_PASS,
      expected_long_queue_workflows: [...EXPECTED_LONG_QUEUE_WORKFLOWS],
    },
    queued_inventory_complete: queuedInventory.complete,
    queued_runs_inspected: queuedInventory.runs.length,
    history_errors: historyErrors,
    selected_count: plan.selected.length,
    selected: plan.selected,
    candidates: plan.candidates,
    actions,
    permanent_zombie_count: zombieState.size,
  };
  const zombieOutput = {
    schema_version: 1,
    updated_at: generatedAt,
    zombies: [...zombieState.values()].sort(
      (left, right) => Number(left.run_id) - Number(right.run_id),
    ),
  };
  await writeJson(args.output, summary);
  await writeJson(args.zombieOutput, zombieOutput);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await appendStepSummary(summary);
}

function githubApi({ repository, token }) {
  const root = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repository}`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${root}${path}`, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...options.headers,
      },
    });
    return response;
  };
  const getJson = async (path) => {
    const response = await request(path);
    if (!response.ok) {
      throw new Error(`GET ${path} returned ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };
  const listRuns = async (pathForPage) => {
    const runs = [];
    let complete = false;
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const payload = await getJson(pathForPage(page));
      if (!Array.isArray(payload.workflow_runs))
        throw new Error("GitHub returned invalid run inventory");
      runs.push(...payload.workflow_runs);
      if (payload.workflow_runs.length < PER_PAGE || runs.length >= Number(payload.total_count)) {
        complete = true;
        break;
      }
    }
    return { runs, complete };
  };
  return {
    listQueuedRuns: () =>
      listRuns((page) => `/actions/runs?status=queued&per_page=${PER_PAGE}&page=${page}`),
    listWorkflowRuns: ({ workflowId, earliestCreatedAtMs }) => {
      const created = encodeURIComponent(`>=${new Date(earliestCreatedAtMs).toISOString()}`);
      return listRuns(
        (page) =>
          `/actions/workflows/${workflowId}/runs?created=${created}&per_page=${PER_PAGE}&page=${page}`,
      );
    },
    getRun: (runId) => getJson(`/actions/runs/${runId}`),
    postCancellation: async (runId, endpoint) => {
      const response = await request(`/actions/runs/${runId}/${endpoint}`, { method: "POST" });
      return { ok: response.ok, status: response.status };
    },
  };
}

function parseArgs(argv) {
  const parsed = parseNodeArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      repository: { type: "string" },
      execute: { type: "boolean", default: false },
      output: { type: "string", default: DEFAULT_OUTPUT },
      "zombie-seed": { type: "string", default: DEFAULT_ZOMBIE_SEED },
      "zombie-state": { type: "string" },
      "zombie-output": { type: "string", default: DEFAULT_ZOMBIE_OUTPUT },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return {
    repository: parsed.values.repository,
    execute: parsed.values.execute,
    output: parsed.values.output,
    zombieSeed: parsed.values["zombie-seed"],
    zombieState: parsed.values["zombie-state"],
    zombieOutput: parsed.values["zombie-output"],
    help: parsed.values.help,
  };
}

async function readZombieState(path, { required }) {
  try {
    const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
    if (parsed?.schema_version !== 1 || !Array.isArray(parsed.zombies)) {
      throw new Error(`${path} has an unsupported zombie-state schema`);
    }
    return parsed;
  } catch (error) {
    if (!required && error?.code === "ENOENT") return { schema_version: 1, zombies: [] };
    throw error;
  }
}

async function writeJson(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeRunId(value) {
  const text = String(value ?? "");
  return RUN_ID.test(text) ? text : "";
}

function logAction(action, candidate) {
  process.stdout.write(
    `stuck-queued remediation action=${action.outcome} run_id=${action.run_id} age_minutes=${candidate.age_minutes} newer_started=${candidate.discriminator.newer_started_run_count} evidence_ids=${candidate.discriminator.evidence.map((entry) => entry.run_id).join(",")}\n`,
  );
}

async function appendStepSummary(summary) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    "## Stuck queued-run remediation",
    "",
    `- Mode: ${summary.dry_run ? "dry run" : "execute"}`,
    `- Queued runs inspected: ${summary.queued_runs_inspected}`,
    `- Selected: ${summary.selected_count}`,
    `- Actions: ${summary.actions.length}`,
    `- Permanent zombies: ${summary.permanent_zombie_count}`,
    "",
  ];
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, { flag: "a" });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
