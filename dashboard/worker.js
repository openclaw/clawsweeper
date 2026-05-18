const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const ACTIVE_RUN_STATUS_FILTERS = ["in_progress", "queued", "waiting", "requested", "pending"];
const TERMINAL_BAD_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);
const EVENT_LIMIT = 200;
const AVERAGE_LIMIT = 4;
const RECENT_CLOSED_LIMIT = 8;
const GITHUB_TIMEOUT_MS = 4500;
const OPTIONAL_SECTION_TIMEOUT_MS = 6000;
const STALE_CACHE_TTL_SECONDS = 900;
const CI_STATUS_TTL_SECONDS = 7200;
const RUNNER_MODES = {
  "mac-mini": ["self-hosted", "macOS", "ARM64", "mac-mini"],
  macbook: ["self-hosted", "macOS", "ARM64", "macbook"],
  both: ["self-hosted", "macOS", "ARM64"],
};
const RUNNER_VARIABLES = ["CLAWSWEEPER_RUNNER_LABELS", "CLAWSWEEPER_REVIEW_RUNNER"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.hostname.includes("-ingest.") &&
      url.pathname !== "/api/events" &&
      url.pathname !== "/api/health"
    ) {
      return json({ error: "not_found" }, 404);
    }
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (url.pathname === "/api/health") return json({ ok: true, service: "clawsweeper-status" });
    if (url.pathname === "/api/events" && request.method === "POST")
      return ingestEvent(request, env);
    if (url.pathname === "/api/runner-mode" && request.method === "POST")
      return setRunnerMode(request, env, ctx);
    if (url.pathname === "/api/status") return statusJson(request, env, ctx);
    if (url.pathname === "/" || url.pathname === "/index.html") return html(dashboardHtml());
    return json({ error: "not_found" }, 404);
  },
};

async function statusJson(request, env, ctx) {
  const ttl = numberFrom(env.CACHE_TTL_SECONDS, 20);
  const staleTtl = numberFrom(env.STALE_CACHE_TTL_SECONDS, STALE_CACHE_TTL_SECONDS);
  const cache = caches.default;
  const cached = await cache.match(statusCacheRequest(request, "fresh"));
  if (cached) return cors(new Response(cached.body, cached));

  const snapshot = await statusSnapshot(env, ctx);
  const body = JSON.stringify(snapshot, null, 2);
  const hasErrors = Boolean(snapshot.diagnostics?.errors?.length);
  const looksEmpty =
    !snapshot.pipeline.length && snapshot.fleet.active_workflow_runs === 0 && hasErrors;
  if (looksEmpty) {
    const stale = await cache.match(statusCacheRequest(request, "stale"));
    if (stale) return cors(new Response(stale.body, stale));
  }
  if (!looksEmpty) {
    const responseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttl}`,
    };
    const staleResponseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${staleTtl}`,
    };
    ctx?.waitUntil?.(
      Promise.all([
        cache.put(
          statusCacheRequest(request, "fresh"),
          new Response(body, { headers: responseHeaders }),
        ),
        cache.put(
          statusCacheRequest(request, "stale"),
          new Response(body, { headers: staleResponseHeaders }),
        ),
      ]),
    );
  }
  return cors(
    new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  );
}

function statusCacheRequest(request, bucket) {
  return new Request(new URL(`/api/status-cache/${bucket}`, request.url).toString(), {
    method: "GET",
  });
}

async function ingestEvent(request, env) {
  const token = bearerToken(request);
  if (!env.INGEST_TOKEN || token !== env.INGEST_TOKEN) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "invalid_json" }, 400);
  const event = normalizeEvent(body);
  const current = await readEvents(env);
  const events = [event, ...current].slice(0, EVENT_LIMIT);
  const writes = [
    writeStoredJson(env, "events", events),
    writeStoredJson(env, "latest-event", event),
  ];
  const ci = normalizeCiStatus(body);
  if (ci) writes.push(writeCiStatus(env, ci));
  await Promise.all(writes);
  return json({ ok: true, event });
}

async function setRunnerMode(request, env, ctx) {
  const token = bearerToken(request);
  const adminToken = env.DASHBOARD_ADMIN_TOKEN || env.INGEST_TOKEN;
  if (!adminToken || token !== adminToken) return json({ error: "unauthorized" }, 401);
  const body = await request.json().catch(() => null);
  const mode = String(body?.mode || "").trim();
  const labels = RUNNER_MODES[mode];
  if (!labels) return json({ error: "invalid_mode", modes: Object.keys(RUNNER_MODES) }, 400);

  const repo = env.CLAWSWEEPER_REPO || "openclaw/clawsweeper";
  await Promise.all(
    RUNNER_VARIABLES.map((name) => upsertGithubVariable(env, repo, name, JSON.stringify(labels))),
  );
  await env.STATUS_STORE?.delete?.("snapshot");
  const result = { ok: true, mode, labels };
  ctx?.waitUntil?.(writeStoredJson(env, "runner-mode", result));
  return json(result);
}

async function statusSnapshot(env, ctx) {
  const ttl = numberFrom(env.CACHE_TTL_SECONDS, 20);
  const cached = await readCachedSnapshot(env, ttl);
  if (cached) return cached;

  const generatedAt = new Date().toISOString();
  const errors = [];
  const repo = env.CLAWSWEEPER_REPO || "openclaw/clawsweeper";
  const targetRepos = String(env.TARGET_REPOS || "openclaw/openclaw")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const budget = numberFrom(env.WORKER_BUDGET, 80);
  const [runs, filteredActiveRuns, runnerConfig, runners] = await Promise.all([
    githubJson(env, `/repos/${repo}/actions/runs?per_page=100`).catch((error) => {
      errors.push(`workflow runs: ${error.message}`);
      return null;
    }),
    activeWorkflowRuns(env, repo, errors),
    runnerConfigSnapshot(env, repo).catch((error) => {
      errors.push(`runner config: ${error.message}`);
      return runnerConfigFromLabels(null);
    }),
    githubJson(env, `/repos/${repo}/actions/runners?per_page=100`).catch((error) => {
      errors.push(`runners: ${error.message}`);
      return null;
    }),
  ]);
  const workflowRuns = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  const activeRuns = uniqueWorkflowRuns([
    ...filteredActiveRuns,
    ...workflowRuns.filter((run) => ACTIVE_RUN_STATUSES.has(String(run.status))),
  ]).sort(newestWorkflowRunFirst);
  const failedRuns = workflowRuns.filter(
    (run) => run.status === "completed" && TERMINAL_BAD_CONCLUSIONS.has(String(run.conclusion)),
  );
  const [activeJobs, pipeline, automerge, closedItems, events] = await Promise.all([
    estimateActiveCodexJobs(activeRuns),
    withTimeout(
      pipelineItems(env, activeRuns.slice(0, 30)),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "pipeline",
    ).catch((error) => {
      errors.push(error.message);
      return activeRuns.slice(0, 30).map((run) => classifyRun(run));
    }),
    withTimeout(
      recentAutomerge(env, targetRepos[0] || "openclaw/openclaw"),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "automerge timing",
    ).catch((error) => {
      errors.push(error.message);
      return { average_ms: null, samples: 0, items: [] };
    }),
    withTimeout(
      recentClosedItems(env, targetRepos),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "recent closed",
    ).catch((error) => {
      errors.push(error.message);
      return [];
    }),
    readEvents(env).catch((error) => {
      errors.push(`events: ${error.message}`);
      return [];
    }),
  ]);
  errors.push(...activeJobs.errors);

  const snapshot = {
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      clawsweeper_repo: repo,
      target_repositories: targetRepos,
    },
    fleet: {
      worker_budget: budget,
      active_workflow_runs: activeRuns.length,
      queued_workflow_runs: activeRuns.filter((run) => run.status !== "in_progress").length,
      active_codex_jobs: activeJobs.count,
      failed_recent_runs: failedRuns.length,
      budget_used_percent: budget > 0 ? Math.round((activeJobs.count / budget) * 100) : 0,
      runner_config: runnerConfig,
      runners: normalizeRunners(runners),
    },
    averages: {
      automerge_command_to_merge_ms: automerge.average_ms,
      automerge_samples: automerge.samples,
    },
    pipeline,
    recent: {
      automerge: automerge.items,
      closed_items: closedItems,
      events: events.slice(0, 25),
      failed_runs: failedRuns.slice(0, 10).map((run) => workflowRunSummary(run)),
    },
    diagnostics: {
      active_job_sample: activeJobs.sample,
      github_rate: activeJobs.rate,
      errors: errors.slice(0, 20),
    },
  };
  if (env.STATUS_STORE) {
    ctx?.waitUntil?.(env.STATUS_STORE.put("snapshot", JSON.stringify(snapshot)));
  }
  return snapshot;
}

async function estimateActiveCodexJobs(runs) {
  const codexRuns = runs.filter((run) =>
    codexJobName(`${run.name || ""} ${run.display_title || ""}`),
  );
  return {
    count: codexRuns.length,
    sample: codexRuns.slice(0, 25).map((run) => ({
      run_url: run.html_url,
      run_title: run.display_title || run.name,
      job: run.name,
      status: run.status,
      started_at: run.created_at,
    })),
    rate: null,
    errors: [],
  };
}

async function activeWorkflowRuns(env, repo, errors) {
  const pages = await Promise.all(
    ACTIVE_RUN_STATUS_FILTERS.map(async (status) => {
      const runs = await githubJson(
        env,
        `/repos/${repo}/actions/runs?status=${status}&per_page=100`,
      ).catch((error) => {
        errors.push(`workflow runs ${status}: ${error.message}`);
        return null;
      });
      return Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
    }),
  );
  return uniqueWorkflowRuns(pages.flat()).filter((run) =>
    ACTIVE_RUN_STATUSES.has(String(run.status)),
  );
}

function uniqueWorkflowRuns(runs) {
  const seen = new Map();
  for (const run of runs) {
    const key =
      run?.id ??
      run?.html_url ??
      `${run?.name || ""}:${run?.display_title || ""}:${run?.created_at || ""}`;
    if (key) seen.set(String(key), run);
  }
  return [...seen.values()];
}

function newestWorkflowRunFirst(left, right) {
  return Date.parse(right.created_at || "") - Date.parse(left.created_at || "");
}

async function pipelineItems(env, runs) {
  const items = [];
  const prCandidates = [];
  for (const run of runs) {
    const item = classifyRun(run);
    if (item.item_number && item.repository) prCandidates.push(item);
    items.push(item);
  }
  await attachStoredCiStatuses(env, prCandidates);
  if (env.INCLUDE_CI_STATUS === "1") {
    await Promise.all(
      prCandidates
        .filter((item) => !item.ci || item.ci.source === "workflow" || item.ci.state === "unknown")
        .slice(0, 4)
        .map((item) => attachCiStatus(env, item)),
    );
  }
  return items.sort(
    (left, right) =>
      laneRank(left.mode) - laneRank(right.mode) ||
      Date.parse(right.started_at || "") - Date.parse(left.started_at || ""),
  );
}

function classifyRun(run) {
  const title = String(run.display_title || run.name || "");
  const workflow = String(run.name || "");
  const extracted = title.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/);
  const lower = `${workflow} ${title}`.toLowerCase();
  let mode = "background-review";
  let stage = "running";
  if (lower.includes("automerge")) {
    mode = "automerge";
    stage = lower.includes("repair") ? "repairing" : "reviewing";
  } else if (lower.includes("repair cluster")) {
    mode = "repair";
    stage = "repairing";
  } else if (lower.includes("review event item")) {
    mode = "exact-review";
    stage = "reviewing";
  } else if (lower.includes("apply clawsweeper closures")) {
    mode = "apply";
    stage = "closing";
  } else if (lower.includes("commit review")) {
    mode = "commit-review";
    stage = "reviewing";
  } else if (lower.includes("hot")) {
    mode = "hot-review";
    stage = "reviewing";
  }
  return {
    id: run.id,
    mode,
    stage,
    status: run.status,
    conclusion: run.conclusion,
    repository: extracted?.[1] || null,
    item_number: extracted?.[2] ? Number(extracted[2]) : null,
    title,
    workflow,
    run_url: run.html_url,
    started_at: run.created_at,
    updated_at: run.updated_at,
    elapsed_ms: Date.now() - Date.parse(run.created_at || new Date().toISOString()),
    ci: workflowRunCi(run),
  };
}

function workflowRunCi(run) {
  const status = String(run.status || "");
  const conclusion = String(run.conclusion || "");
  if (status === "completed") {
    return {
      state: TERMINAL_BAD_CONCLUSIONS.has(conclusion) ? "red" : "green",
      source: "workflow",
      label: conclusion || "completed",
      total: 1,
      failing: TERMINAL_BAD_CONCLUSIONS.has(conclusion) ? 1 : 0,
      pending: 0,
    };
  }
  return {
    state: "pending",
    source: "workflow",
    label: status || "running",
    total: 1,
    failing: 0,
    pending: 1,
  };
}

async function attachStoredCiStatuses(env, items) {
  if (!items.length) return;
  await Promise.all(
    items.map(async (item) => {
      const stored = await readCiStatus(env, item.repository, item.item_number);
      if (stored) item.ci = stored;
    }),
  );
}

async function attachCiStatus(env, item) {
  try {
    const pr = await githubJson(env, `/repos/${item.repository}/pulls/${item.item_number}`);
    if (!pr?.head?.sha) return;
    const checks = await githubJson(
      env,
      `/repos/${item.repository}/commits/${pr.head.sha}/check-runs?per_page=100`,
    );
    const runs = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
    const failing = runs.filter(
      (check) =>
        check.status === "completed" &&
        !["success", "neutral", "skipped"].includes(String(check.conclusion)),
    );
    const pending = runs.filter((check) => check.status !== "completed");
    item.ci = {
      state: failing.length ? "red" : pending.length ? "pending" : "green",
      head_sha: pr.head.sha,
      total: runs.length,
      failing: failing.length,
      pending: pending.length,
      source: "live",
    };
  } catch (error) {
    if (!item.ci)
      item.ci = { state: "unknown", source: "live", error: String(error?.message || error) };
  }
}

async function recentAutomerge(env, repo) {
  const search = await githubJson(
    env,
    `/search/issues?q=${encodeURIComponent(`repo:${repo} is:pr is:merged label:clawsweeper:automerge sort:updated-desc`)}&per_page=${AVERAGE_LIMIT}`,
  );
  const items = [];
  for (const issue of Array.isArray(search?.items) ? search.items : []) {
    const number = issue.number;
    const [pr, comments] = await Promise.all([
      githubJson(env, `/repos/${repo}/pulls/${number}`),
      githubJson(env, `/repos/${repo}/issues/${number}/comments?per_page=100`),
    ]);
    const commandAt = firstAutomergeCommandAt(comments);
    const mergedAt = pr?.merged_at || null;
    const durationMs = commandAt && mergedAt ? Date.parse(mergedAt) - Date.parse(commandAt) : null;
    items.push({
      url: issue.html_url,
      title: issue.title,
      number,
      command_at: commandAt,
      merged_at: mergedAt,
      duration_ms: durationMs,
      merge_commit_sha: pr?.merge_commit_sha || null,
    });
  }
  const durations = items
    .map((item) => item.duration_ms)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    average_ms: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : null,
    samples: durations.length,
    items,
  };
}

async function recentClosedItems(env, repos) {
  const rows = await Promise.all(
    repos.map(async (repo) => {
      const issues = await githubJson(
        env,
        `/repos/${repo}/issues?state=closed&sort=updated&direction=desc&per_page=${RECENT_CLOSED_LIMIT}`,
      ).catch(() => []);
      return (Array.isArray(issues) ? issues : [])
        .filter((item) => item?.closed_at)
        .map((item) => ({
          repository: repo,
          number: item.number,
          type: item.pull_request ? "PR" : "Issue",
          title: item.title || "",
          url: item.html_url,
          closed_at: item.closed_at,
          closed_by: item.closed_by?.login || null,
        }));
    }),
  );
  return rows
    .flat()
    .sort((left, right) => Date.parse(right.closed_at || "") - Date.parse(left.closed_at || ""))
    .slice(0, RECENT_CLOSED_LIMIT);
}

function firstAutomergeCommandAt(comments) {
  if (!Array.isArray(comments)) return null;
  const command = comments.find((comment) =>
    /@clawsweeper\s+auto\s*-?\s*merge|@clawsweeper\s+automerge|\/clawsweeper\s+auto\s*-?\s*merge|\/clawsweeper\s+automerge/i.test(
      String(comment.body || ""),
    ),
  );
  return command?.created_at || null;
}

async function readCachedSnapshot(env, ttlSeconds) {
  if (!env.STATUS_STORE) return null;
  const text = await env.STATUS_STORE.get("snapshot");
  if (!text) return null;
  const snapshot = JSON.parse(text);
  if (Date.now() - Date.parse(snapshot.generated_at || "") > ttlSeconds * 1000) return null;
  return snapshot;
}

async function readEvents(env) {
  const parsed = await readStoredJson(env, "events");
  return Array.isArray(parsed) ? parsed : [];
}

async function writeCiStatus(env, ci) {
  await writeStoredJson(
    env,
    ciStatusKey(ci.repository, ci.item_number),
    ci,
    numberFrom(env.CI_STATUS_TTL_SECONDS, CI_STATUS_TTL_SECONDS),
  );
}

async function readCiStatus(env, repository, itemNumber) {
  if (!repository || !itemNumber) return null;
  const ci = await readStoredJson(env, ciStatusKey(repository, itemNumber));
  if (!ci) return null;
  if (
    Date.now() - Date.parse(ci.updated_at || ci.received_at || "") >
    numberFrom(env.CI_STATUS_TTL_SECONDS, CI_STATUS_TTL_SECONDS) * 1000
  ) {
    return null;
  }
  return ci;
}

function ciStatusKey(repository, itemNumber) {
  return `ci:${repository}#${itemNumber}`;
}

async function readStoredJson(env, key) {
  if (env.STATUS_STORE) {
    const text = await env.STATUS_STORE.get(key);
    return text ? JSON.parse(text) : null;
  }
  const cached = await caches.default.match(storeCacheRequest(key));
  return cached ? cached.json() : null;
}

async function writeStoredJson(
  env,
  key,
  value,
  ttlSeconds = numberFrom(env.STORE_CACHE_TTL_SECONDS, STALE_CACHE_TTL_SECONDS),
) {
  const body = JSON.stringify(value);
  if (env.STATUS_STORE) {
    await env.STATUS_STORE.put(key, body, { expirationTtl: ttlSeconds });
    return;
  }
  await caches.default.put(
    storeCacheRequest(key),
    new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ttlSeconds}`,
      },
    }),
  );
}

function storeCacheRequest(key) {
  return new Request(`https://clawsweeper.internal/store/${encodeURIComponent(key)}`, {
    method: "GET",
  });
}

async function githubJson(env, path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GITHUB_TIMEOUT_MS);
  const response = await fetch(`https://api.github.com${path}`, {
    signal: controller.signal,
    headers: githubHeaders(env),
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

function githubHeaders(env) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "openclaw-clawsweeper-status",
    ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
  };
}

async function githubWriteJson(env, path, options) {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method,
    headers: {
      ...githubHeaders(env),
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(options.body),
  });
  if (!response.ok && response.status !== 204) {
    const text = await response.text().catch(() => "");
    throw new Error(`GitHub ${response.status} for ${path}: ${text.slice(0, 200)}`);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function upsertGithubVariable(env, repo, name, value) {
  try {
    await githubWriteJson(env, `/repos/${repo}/actions/variables/${name}`, {
      method: "PATCH",
      body: { name, value },
    });
  } catch (error) {
    if (!String(error?.message || error).includes("GitHub 404")) throw error;
    await githubWriteJson(env, `/repos/${repo}/actions/variables`, {
      method: "POST",
      body: { name, value },
    });
  }
}

async function runnerConfigSnapshot(env, repo) {
  const variable = await githubJson(env, `/repos/${repo}/actions/variables/CLAWSWEEPER_RUNNER_LABELS`).catch(
    () => null,
  );
  return runnerConfigFromLabels(variable?.value ?? null);
}

function runnerConfigFromLabels(value) {
  const labels = parseRunnerLabels(value) || RUNNER_MODES["mac-mini"];
  return {
    mode: runnerModeForLabels(labels),
    labels,
  };
}

function parseRunnerLabels(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {}
  return null;
}

function runnerModeForLabels(labels) {
  const serialized = JSON.stringify(labels);
  for (const [mode, modeLabels] of Object.entries(RUNNER_MODES)) {
    if (JSON.stringify(modeLabels) === serialized) return mode;
  }
  return "custom";
}

function normalizeRunners(value) {
  const runners = Array.isArray(value?.runners) ? value.runners : [];
  return runners.map((runner) => ({
    name: runner.name,
    status: runner.status,
    busy: Boolean(runner.busy),
    labels: Array.isArray(runner.labels)
      ? runner.labels.map((label) => label.name).filter(Boolean)
      : [],
  }));
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label}: timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function normalizeEvent(body) {
  return {
    id: crypto.randomUUID(),
    received_at: new Date().toISOString(),
    event_type: stringField(body.event_type, "status.event"),
    mode: stringField(body.mode, "unknown"),
    stage: stringField(body.stage, "unknown"),
    status: stringField(body.status, "unknown"),
    repository: nullableString(body.repository),
    item_url: nullableString(body.item_url),
    run_url: nullableString(body.run_url),
    title: nullableString(body.title),
    duration_ms: numberOrNull(body.duration_ms),
    note: nullableString(body.note),
  };
}

function normalizeCiStatus(body) {
  const ci =
    body.ci && typeof body.ci === "object"
      ? body.ci
      : body.event_type === "ci.status"
        ? body
        : null;
  if (!ci) return null;
  const repository = nullableString(ci.repository ?? body.repository);
  const itemNumber = numberOrNull(ci.item_number ?? body.item_number);
  if (!repository || !Number.isInteger(itemNumber) || itemNumber <= 0) return null;
  const state = normalizeCiState(ci.state ?? ci.status ?? body.status);
  return {
    state,
    source: stringField(ci.source ?? body.source, "stored"),
    label: nullableString(ci.label),
    repository,
    item_number: itemNumber,
    item_url:
      nullableString(ci.item_url ?? body.item_url) ||
      `https://github.com/${repository}/pull/${itemNumber}`,
    run_url: nullableString(ci.run_url ?? body.run_url),
    head_sha: nullableString(ci.head_sha ?? body.head_sha),
    total: Math.max(0, numberOrNull(ci.total) ?? 0),
    failing: Math.max(0, numberOrNull(ci.failing) ?? 0),
    pending: Math.max(0, numberOrNull(ci.pending) ?? 0),
    updated_at: nullableString(ci.updated_at) || new Date().toISOString(),
    received_at: new Date().toISOString(),
  };
}

function normalizeCiState(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["green", "success", "passed", "pass"].includes(text)) return "green";
  if (
    [
      "red",
      "failure",
      "failed",
      "error",
      "timed_out",
      "action_required",
      "cancelled",
      "startup_failure",
    ].includes(text)
  )
    return "red";
  if (["pending", "queued", "waiting", "requested", "in_progress", "running"].includes(text))
    return "pending";
  return "unknown";
}

function workflowRunSummary(run) {
  return {
    id: run.id,
    workflow: run.name,
    title: run.display_title || run.name,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    started_at: run.created_at,
    updated_at: run.updated_at,
  };
}

function codexJobName(name) {
  return /review|codex|repair|worker|commit/i.test(name);
}

function laneRank(mode) {
  return (
    {
      automerge: 0,
      repair: 1,
      "exact-review": 2,
      "hot-review": 3,
      apply: 4,
      "commit-review": 5,
      "background-review": 6,
    }[mode] ?? 9
  );
}

function bearerToken(request) {
  const header = request.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function stringField(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function nullableString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberFrom(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function json(value, status = 200) {
  return cors(
    new Response(JSON.stringify(value, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    }),
  );
}

function html(value) {
  return new Response(value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cors(response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  response.headers.set("access-control-allow-headers", "authorization,content-type");
  return response;
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🦞 ClawSweeper Live</title>
<style>
:root {
  color-scheme: dark;
  --bg: #0a0e14;
  --panel: #111821;
  --panel-2: #151f2b;
  --line: #2a3646;
  --text: #e7edf5;
  --muted: #9aa8ba;
  --blue: #67b7ff;
  --green: #4ed891;
  --amber: #f3b759;
  --red: #f46d75;
  --violet: #b99cff;
  --accent: #ff7a66;
}
* { box-sizing: border-box; }
@keyframes wave {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(-3px) rotate(1deg); }
}
@keyframes bubble {
  0% { transform: translateY(0) scale(1); opacity: 0.05; }
  50% { opacity: 0.08; }
  100% { transform: translateY(-400px) scale(1.2); opacity: 0; }
}
body {
  margin: 0;
  background: var(--bg);
  background-image:
    radial-gradient(circle at 20% 80%, rgba(103, 183, 255, 0.03) 0%, transparent 50%),
    radial-gradient(circle at 80% 20%, rgba(78, 216, 145, 0.03) 0%, transparent 50%),
    radial-gradient(circle at 40% 40%, rgba(185, 156, 255, 0.02) 0%, transparent 50%);
  background-attachment: fixed;
  color: var(--text);
  font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  letter-spacing: 0;
  position: relative;
  overflow-x: hidden;
}
body::before {
  content: "";
  position: fixed;
  bottom: -50px;
  left: -50px;
  right: -50px;
  height: 120px;
  background: radial-gradient(ellipse at bottom, rgba(103, 183, 255, 0.05) 0%, transparent 70%);
  animation: wave 8s ease-in-out infinite;
  pointer-events: none;
  z-index: 0;
}
main { width: min(1440px, calc(100vw - 40px)); margin: 0 auto; padding: 28px 0 48px; position: relative; z-index: 1; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1.1;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 10px;
}
h1::before { content: "🦞"; font-size: 32px; animation: wave 3s ease-in-out infinite; }
h2 {
  margin: 28px 0 12px;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 8px;
}
.muted { color: var(--muted); }
.grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; }
.metric {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 14px 16px;
  min-height: 92px;
  position: relative;
  overflow: hidden;
  transition: all 0.2s ease;
}
.metric:hover {
  border-color: rgba(103, 183, 255, 0.4);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
.metric::before {
  content: "";
  position: absolute;
  top: -2px;
  right: -2px;
  width: 40px;
  height: 40px;
  background: radial-gradient(circle, rgba(103, 183, 255, 0.08) 0%, transparent 70%);
  border-radius: 0 16px 0 100%;
  pointer-events: none;
}
.metric strong { display: block; font-size: 28px; line-height: 1.1; margin-top: 8px; font-weight: 700; }
.metric span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
.band { height: 7px; margin-top: 12px; background: #1a2532; border-radius: 999px; overflow: hidden; position: relative; }
.band::after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
  animation: shimmer 2s infinite;
}
@keyframes shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
.band > i { display: block; height: 100%; background: var(--blue); width: 0; transition: width 0.6s ease; }
table {
  width: 100%;
  min-width: 0;
  table-layout: fixed;
  border-collapse: collapse;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  overflow: hidden;
}
th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
td { overflow-wrap: anywhere; }
th {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  background: #0d131b;
  font-weight: 600;
  letter-spacing: 0.05em;
}
tbody tr { transition: background-color 0.15s ease; }
tbody tr:hover { background: rgba(103, 183, 255, 0.03); }
tr:last-child td { border-bottom: 0; }
a { color: var(--blue); text-decoration: none; transition: color 0.15s ease; }
a:hover { color: #89c8ff; text-decoration: underline; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 3px 10px;
  border-radius: 12px;
  background: #1a2532;
  border: 1px solid #2a3646;
  color: var(--text);
  font-size: 12px;
  white-space: nowrap;
  font-weight: 500;
  transition: all 0.15s ease;
}
.pill:hover { border-color: rgba(103, 183, 255, 0.4); }
.green { color: var(--green); }
.amber { color: var(--amber); }
.red { color: var(--red); }
.violet { color: var(--violet); }
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 420px);
  gap: 24px;
  align-items: start;
}
.split > div,
.split > aside { min-width: 0; }
.pipeline-col { overflow: hidden; }
.side-col { min-width: 0; }
#pipeline,
#runnerControl,
#automerge,
#closed,
#events {
  min-width: 0;
  overflow: hidden;
  border-radius: 14px;
}
#pipeline { overflow-x: auto; }
#pipeline table { min-width: 820px; }
#pipeline table th:nth-child(1) { width: 112px; }
#pipeline table th:nth-child(2) { width: auto; }
#pipeline table th:nth-child(3) { width: 100px; }
#pipeline table th:nth-child(4) { width: 118px; }
#pipeline table th:nth-child(5) { width: 68px; }
#pipeline table th:nth-child(6) { width: 50px; }
#pipeline table td:nth-child(2) {
  line-height: 1.35;
}
#pipeline table td:nth-child(3) {
  white-space: nowrap;
}
#pipeline .item-main {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#pipeline table td:nth-child(2) .muted {
  display: -webkit-box;
  margin-top: 2px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
#pipeline table td:nth-child(6) a { white-space: nowrap; }
#automerge table th:nth-child(1) { width: auto; }
#automerge table th:nth-child(2) { width: 88px; }
#automerge table th:nth-child(3) { width: 112px; }
#automerge table td:nth-child(1) .muted {
  display: -webkit-box;
  margin-top: 2px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
#closed table th:nth-child(1) { width: auto; }
#closed table th:nth-child(2) { width: 90px; }
#closed table td:nth-child(1) .muted {
  display: -webkit-box;
  margin-top: 2px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.empty {
  padding: 24px;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  text-align: center;
  font-style: italic;
}
.empty::before { content: "🦀 "; opacity: 0.3; }
.control-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 14px;
}
.runner-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
button {
  background: #1a2532;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
  font: inherit;
}
button:hover { border-color: rgba(103, 183, 255, 0.6); }
button.active { background: rgba(103, 183, 255, 0.16); border-color: var(--blue); }
.runner-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.runner-row { display: flex; justify-content: space-between; gap: 8px; }
@media (max-width: 1280px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .split { grid-template-columns: 1fr; } header { align-items: start; flex-direction: column; } }
@media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } #pipeline table { min-width: 760px; } }
@media (max-width: 560px) { main { width: min(100vw - 20px, 1440px); padding-top: 16px; } .grid { grid-template-columns: 1fr; } th:nth-child(4), td:nth-child(4), th:nth-child(6), td:nth-child(6) { display: none; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>ClawSweeper Live</h1>
      <div class="muted" id="subtitle">🌊 Loading pipeline state...</div>
    </div>
    <div class="muted mono" id="updated"></div>
  </header>
  <section class="grid" id="metrics"></section>
  <section class="split">
    <div class="pipeline-col">
      <h2>🌀 Active Pipeline</h2>
      <div id="pipeline"></div>
    </div>
    <aside class="side-col">
      <h2>🧭 Runner Lane</h2>
      <div id="runnerControl"></div>
      <h2>⚡ Automerge Speed</h2>
      <div id="automerge"></div>
      <h2>✅ Last Closed Issues/PRs</h2>
      <div id="closed"></div>
      <h2>📡 Recent Activity</h2>
      <div id="events"></div>
    </aside>
  </section>
</main>
<script>
const fmt = new Intl.NumberFormat();
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function elapsed(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const s = Math.round(ms / 1000);
  if (s < 90) return s + "s";
  const m = Math.round(s / 60);
  if (m < 90) return m + "m";
  return Math.round(m / 60) + "h";
}
function since(iso) {
  const diff = Date.parse(iso) - Date.now();
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 90) return rel.format(minutes, "minute");
  return rel.format(Math.round(minutes / 60), "hour");
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function link(url, label) {
  return url ? '<a href="' + esc(url) + '">' + esc(label || url) + '</a>' : esc(label || "");
}
function compactText(value) {
  return String(value ?? "")
    .replace(/\b([0-9a-f]{10})[0-9a-f]{22,}\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
function pipelineItemLabel(row) {
  if (row.repository && row.item_number) {
    return link("https://github.com/" + row.repository + "/pull/" + row.item_number, row.repository + "#" + row.item_number);
  }
  return esc(compactText(row.title));
}
function pipelineItemDetail(row) {
  if (row.repository && row.item_number) return compactText(row.title);
  const workflow = compactText(row.workflow);
  const title = compactText(row.title);
  return workflow && workflow !== title ? workflow : "";
}
function modeLabel(mode) {
  return {
    "background-review": "bg-review",
    "commit-review": "commit",
    "exact-review": "exact",
    "hot-review": "hot",
  }[mode] || mode;
}
function metric(label, value, sub, pct, color) {
  return '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><div class="muted">' + esc(sub || "") + '</div><div class="band"><i style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%;background:' + (color || "var(--blue)") + '"></i></div></div>';
}
function ciBadge(ci) {
  if (!ci) return '<span class="pill">ci unknown</span>';
  const cls = ci.state === "green" ? "green" : ci.state === "red" ? "red" : ci.state === "pending" ? "amber" : "";
  const prefix = ci.source === "workflow" ? "run" : "checks";
  const detail = ci.total ? " " + esc(ci.failing || 0) + "/" + esc(ci.pending || 0) + "/" + esc(ci.total || 0) : "";
  return '<span class="pill ' + cls + '" title="' + esc(ci.label || ci.source || "") + '">' + esc(prefix) + " " + esc(ci.state) + detail + '</span>';
}
let lastData = null;
let loading = false;

try {
  lastData = JSON.parse(localStorage.getItem("clawsweeper:last-status") || "null");
  if (lastData) renderDashboard(lastData, "Showing cached status while refreshing...");
} catch {}

async function load() {
  if (loading) return;
  loading = true;
  let data;
  try {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error("/api/status returned " + response.status);
  data = await response.json();
  const hasErrors = Boolean(data.diagnostics && Array.isArray(data.diagnostics.errors) && data.diagnostics.errors.length);
  const looksEmpty = !data.pipeline?.length && data.fleet?.active_workflow_runs === 0 && hasErrors;
  if (looksEmpty && lastData) {
    renderDashboard(lastData, "Live refresh failed; showing last good status.");
    return;
  }
  lastData = data;
  if (!looksEmpty) localStorage.setItem("clawsweeper:last-status", JSON.stringify(data));
  renderDashboard(data, hasErrors ? "Updated with partial GitHub telemetry." : "");
  } catch (error) {
    if (lastData) {
      renderDashboard(lastData, "Live refresh failed; showing last good status.");
    } else {
      document.getElementById("subtitle").textContent = "Failed to load status: " + error.message;
    }
  } finally {
    loading = false;
  }
}

function renderDashboard(data, note) {
  document.getElementById("subtitle").textContent = data.source.target_repositories.join(", ");
  document.getElementById("updated").textContent = "Updated " + since(data.generated_at) + (note ? " · " + note : "");
  const fleet = data.fleet;
  document.getElementById("metrics").innerHTML = [
    metric("🦾 Claw Workers", fmt.format(fleet.active_codex_jobs), "budget " + fleet.worker_budget, fleet.budget_used_percent, "var(--green)"),
    metric("🌊 Active Sweeps", fmt.format(fleet.active_workflow_runs), "in motion", Math.min(100, fleet.active_workflow_runs * 3), "var(--blue)"),
    metric("⏳ Queue Depth", fmt.format(fleet.queued_workflow_runs), "waiting to surface", Math.min(100, fleet.queued_workflow_runs * 10), "var(--amber)"),
    metric("💥 Recent Snags", fmt.format(fleet.failed_recent_runs), "last page", Math.min(100, fleet.failed_recent_runs * 15), fleet.failed_recent_runs ? "var(--red)" : "var(--green)"),
    metric("⚡ Merge Speed", data.averages.automerge_command_to_merge_ms ? elapsed(data.averages.automerge_command_to_merge_ms) : "n/a", data.averages.automerge_samples + " samples", 60, "var(--violet)"),
    metric("🎯 Capacity", fleet.budget_used_percent + "%", "fleet utilization", fleet.budget_used_percent, "var(--green)")
  ].join("");
  renderPipeline(data.pipeline || []);
  renderRunnerControl(fleet.runner_config || {}, fleet.runners || []);
  renderAutomerge(data.recent.automerge || []);
  renderClosedItems(data.recent.closed_items || []);
  renderEvents(data.recent.events || []);
}
function renderPipeline(rows) {
  if (!rows.length) {
    document.getElementById("pipeline").innerHTML = '<div class="empty">All quiet in the depths... no active sweeps</div>';
    return;
  }
  document.getElementById("pipeline").innerHTML = '<table><thead><tr><th>Mode</th><th>Item</th><th>Stage</th><th>CI</th><th>Elapsed</th><th>Run</th></tr></thead><tbody>' + rows.map(row => {
    const detail = pipelineItemDetail(row);
    return '<tr><td><span class="pill" title="' + esc(row.mode) + '">' + esc(modeLabel(row.mode)) + '</span></td><td><span class="item-main" title="' + esc(compactText(row.title)) + '">' + pipelineItemLabel(row) + '</span>' + (detail ? '<div class="muted">' + esc(detail) + '</div>' : "") + '</td><td>' + esc(row.stage) + '<div class="muted">' + esc(row.status) + '</div></td><td>' + ciBadge(row.ci) + '</td><td>' + elapsed(row.elapsed_ms) + '</td><td>' + link(row.run_url, "run") + '</td></tr>';
  }).join("") + '</tbody></table>';
}
function renderRunnerControl(config, runners) {
  const mode = config.mode || "mac-mini";
  const labels = Array.isArray(config.labels) ? config.labels : [];
  const rows = runners
    .filter(runner => runner.labels && runner.labels.includes("self-hosted"))
    .map(runner => '<div class="runner-row"><span>' + esc(runner.name) + '<div class="muted mono">' + esc((runner.labels || []).join(", ")) + '</div></span><span class="pill ' + (runner.status === "online" ? "green" : "red") + '">' + esc(runner.status) + (runner.busy ? " · busy" : "") + '</span></div>')
    .join("");
  document.getElementById("runnerControl").innerHTML = '<div class="control-card"><div>Mode: <span class="pill">' + esc(mode) + '</span></div><div class="muted mono">' + esc(JSON.stringify(labels)) + '</div><div class="runner-buttons">' + ["mac-mini", "macbook", "both"].map(name => '<button class="' + (name === mode ? "active" : "") + '" onclick="setRunnerMode(\'' + name + '\')">' + esc(name) + '</button>').join("") + '</div><div class="muted">Requires dashboard admin token. Both mode uses common labels so either registered Mac can take jobs.</div><div class="runner-list">' + (rows || '<div class="empty">No self-hosted runners returned</div>') + '</div></div>';
}
async function setRunnerMode(mode) {
  let token = localStorage.getItem("clawsweeper:admin-token") || "";
  if (!token) {
    token = prompt("Dashboard admin token");
    if (!token) return;
    localStorage.setItem("clawsweeper:admin-token", token);
  }
  const response = await fetch("/api/runner-mode", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ mode })
  });
  if (response.status === 401) {
    localStorage.removeItem("clawsweeper:admin-token");
    alert("Unauthorized runner toggle token");
    return;
  }
  if (!response.ok) {
    alert("Runner toggle failed: " + await response.text());
    return;
  }
  await load();
}
function renderAutomerge(rows) {
  if (!rows.length) {
    document.getElementById("automerge").innerHTML = '<div class="empty">No automerge data yet... claws resting</div>';
    return;
  }
  document.getElementById("automerge").innerHTML = '<table><thead><tr><th>PR</th><th>Duration</th><th>Merged</th></tr></thead><tbody>' + rows.map(row => '<tr><td>' + link(row.url, "#" + row.number) + '<div class="muted">' + esc(row.title) + '</div></td><td>' + (row.duration_ms ? elapsed(row.duration_ms) : "unknown") + '</td><td>' + (row.merged_at ? since(row.merged_at) : "") + '</td></tr>').join("") + '</tbody></table>';
}
function renderClosedItems(rows) {
  if (!rows.length) {
    document.getElementById("closed").innerHTML = '<div class="empty">No recent closes found...</div>';
    return;
  }
  document.getElementById("closed").innerHTML = '<table><thead><tr><th>Item</th><th>Closed</th></tr></thead><tbody>' + rows.map(row => '<tr><td><span class="pill">' + esc(row.type) + '</span> ' + link(row.url, row.repository + "#" + row.number) + '<div class="muted">' + esc(row.title) + '</div></td><td>' + since(row.closed_at) + '</td></tr>').join("") + '</tbody></table>';
}
function renderEvents(rows) {
  if (!rows.length) {
    document.getElementById("events").innerHTML = '<div class="empty">Listening for signals from the fleet...</div>';
    return;
  }
  document.getElementById("events").innerHTML = '<table><thead><tr><th>Stage</th><th>Status</th><th>When</th></tr></thead><tbody>' + rows.map(row => '<tr><td>' + esc(row.mode) + " / " + esc(row.stage) + '<div class="muted">' + (row.item_url ? link(row.item_url, row.title || row.item_url) : esc(row.title || row.event_type)) + '</div></td><td>' + esc(row.status) + '</td><td>' + since(row.received_at) + '</td></tr>').join("") + '</tbody></table>';
}
load();
setInterval(load, 15000);
</script>
</body>
</html>`;
}
