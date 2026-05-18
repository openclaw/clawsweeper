const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
type DashboardEnv = Record<string, unknown>;
type DashboardContext = { waitUntil?: (promise: Promise<unknown>) => void };
type GithubAppJsonOptions = { method?: string; body?: BodyInit; errorLabel?: string };

declare global {
  interface CacheStorage {
    default: Cache;
  }
}

const ACTIVE_RUN_STATUS_FILTERS = ["in_progress", "queued", "waiting", "requested", "pending"];
const TERMINAL_BAD_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);
const EVENT_LIMIT = 200;
const AVERAGE_LIMIT = 4;
const RECENT_CLOSED_LIMIT = 8;
const CLOSED_STATS_HOURS = 24;
const CLOSED_STATS_PAGE_LIMIT = 10;
const DEFAULT_CLAWSWEEPER_BOT_LOGINS = ["clawsweeper[bot]", "openclaw-clawsweeper[bot]"];
const GITHUB_TIMEOUT_MS = 4500;
const OPTIONAL_SECTION_TIMEOUT_MS = 6000;
const STALE_CACHE_TTL_SECONDS = 900;
const CI_STATUS_TTL_SECONDS = 7200;
const SUPPORT_WORKFLOW_NAMES = new Set([
  "CI",
  "CodeQL",
  "ClawSweeper Live Dashboard",
  "ClawSweeper Live Dashboard CI Status",
  "github activity to openclaw",
  "spam comment intake",
]);
const TRIAGE_CACHE_TTL_SECONDS = 120;
const DEFAULT_TRIAGE_ITEMS_PER_VIEW = 500;
const MAX_TRIAGE_ITEMS_PER_VIEW = 1000;
const TRIAGE_SEARCH_PAGE_SIZE = 100;
const TRIAGE_FOCUSED_FALLBACK_ITEMS_PER_VIEW = 100;
const TRIAGE_LINKED_PR_ITEM_LIMIT = 240;
const TRIAGE_LINKED_PR_BATCH_SIZE = 25;
const TRIAGE_LABEL_PREFIX = "clawsweeper:";
const GITHUB_APP_TOKEN_REFRESH_SKEW_MS = 120_000;
const GITHUB_APP_TOKEN_DEFAULT_TTL_MS = 50 * 60_000;
const TRIAGE_VIEWS = [
  {
    id: "clawsweeper",
    title: "ClawSweeper",
    description: "Open issues carrying any ClawSweeper label.",
    anyLabels: "discovered",
  },
  {
    id: "ready-candidates",
    title: "Ready candidates",
    description: "Queueable fixes without a no-new-fix-pr blocker.",
    allLabels: ["clawsweeper:queueable-fix"],
    withoutLabels: ["clawsweeper:no-new-fix-pr"],
  },
  {
    id: "queueable-blocked",
    title: "Queueable but blocked",
    description: "Queueable-looking fixes where ClawSweeper also recommends no new fix PR.",
    allLabels: ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"],
  },
  {
    id: "already-has-pr",
    title: "Already has PR",
    description: "Issues where ClawSweeper found an open linked pull request.",
    allLabels: ["clawsweeper:linked-pr-open"],
  },
  {
    id: "needs-info",
    title: "Needs info",
    description: "Issues needing reporter details before ClawSweeper can verify behavior.",
    allLabels: ["clawsweeper:needs-info"],
  },
  {
    id: "needs-maintainer-review",
    title: "Needs maintainer review",
    description: "Issues where a human maintainer decision is the next useful step.",
    allLabels: ["clawsweeper:needs-maintainer-review"],
  },
  {
    id: "product-security",
    title: "Product or security",
    description: "Issues needing product, behavior, or security-sensitive review.",
    anyLabels: ["clawsweeper:needs-product-decision", "clawsweeper:needs-security-review"],
  },
  {
    id: "needs-live-repro",
    title: "Needs live repro",
    description:
      "Issues where source evidence exists but live validation would improve confidence.",
    allLabels: ["clawsweeper:needs-live-repro"],
  },
];

let githubAppTokenCache = null;

export default {
  async fetch(request: Request, env: DashboardEnv = {}, ctx?: DashboardContext) {
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
    if (url.pathname === "/api/status") return statusJson(request, env, ctx);
    if (url.pathname === "/api/triage") return triageJson(request, env, ctx);
    if (url.pathname === "/" || url.pathname === "/index.html") return html(dashboardHtml());
    if (url.pathname === "/triage" || url.pathname === "/triage.html") return html(triageHtml());
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

async function triageJson(request, env, ctx) {
  const ttl = numberFrom(env.TRIAGE_CACHE_TTL_SECONDS, TRIAGE_CACHE_TTL_SECONDS);
  const staleTtl = numberFrom(env.STALE_CACHE_TTL_SECONDS, STALE_CACHE_TTL_SECONDS);
  const cache = caches.default;
  const cached = await cache.match(triageCacheRequest(request, "fresh"));
  if (cached) return cors(new Response(cached.body, cached));

  const snapshot = await triageSnapshot(env);
  const body = JSON.stringify(snapshot, null, 2);
  const looksEmpty = triageSnapshotLooksEmpty(snapshot);
  if (looksEmpty) {
    const stale = await cache.match(triageCacheRequest(request, "stale"));
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
          triageCacheRequest(request, "fresh"),
          new Response(body, { headers: responseHeaders }),
        ),
        cache.put(
          triageCacheRequest(request, "stale"),
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

function triageSnapshotLooksEmpty(snapshot) {
  const hasErrors = Boolean(snapshot.diagnostics?.errors?.length);
  const loadedItems = (snapshot.views || []).reduce(
    (total, view) => total + (Array.isArray(view.items) ? view.items.length : 0),
    0,
  );
  return !loadedItems && hasErrors;
}

function triageCacheRequest(request, bucket) {
  return new Request(new URL(`/api/triage-cache/v2/${bucket}`, request.url).toString(), {
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
  const budget = numberFrom(env.WORKER_BUDGET, 72);
  const [runs, filteredActiveRuns] = await Promise.all([
    githubJson(env, `/repos/${repo}/actions/runs?per_page=100`).catch((error) => {
      errors.push(`workflow runs: ${error.message}`);
      return null;
    }),
    activeWorkflowRuns(env, repo, errors),
  ]);
  const workflowRuns = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : [];
  const activeRuns = uniqueWorkflowRuns([
    ...filteredActiveRuns,
    ...workflowRuns.filter((run) => ACTIVE_RUN_STATUSES.has(String(run.status))),
  ]).sort(newestWorkflowRunFirst);
  const workerRuns = activeRuns.filter((run) => !isSupportWorkflowRun(run));
  const supportRuns = activeRuns.filter((run) => isSupportWorkflowRun(run));
  const failedRuns = workflowRuns.filter(
    (run) => run.status === "completed" && TERMINAL_BAD_CONCLUSIONS.has(String(run.conclusion)),
  );
  const [activeJobs, pipeline, automerge, closed, storedEvents] = await Promise.all([
    estimateActiveCodexJobs(workerRuns),
    withTimeout(
      pipelineItems(env, workerRuns.slice(0, 30)),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "pipeline",
    ).catch((error) => {
      errors.push(error.message);
      return workerRuns.slice(0, 30).map((run) => classifyRun(run));
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
      recentClawsweeperClosed(env, targetRepos),
      OPTIONAL_SECTION_TIMEOUT_MS,
      "recent closed",
    ).catch((error) => {
      errors.push(error.message);
      return { items: [], stats: emptyClosedStats(generatedAt) };
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
      active_workflow_runs: workerRuns.length,
      queued_workflow_runs: workerRuns.filter((run) => run.status !== "in_progress").length,
      support_workflow_runs: supportRuns.length,
      support_queued_workflow_runs: supportRuns.filter((run) => run.status !== "in_progress")
        .length,
      active_codex_jobs: activeJobs.count,
      failed_recent_runs: failedRuns.length,
      budget_used_percent: budget > 0 ? Math.round((activeJobs.count / budget) * 100) : 0,
    },
    averages: {
      automerge_command_to_merge_ms: automerge.average_ms,
      automerge_samples: automerge.samples,
    },
    pipeline,
    recent: {
      automerge: automerge.items,
      closed_items: closed.items,
      closed_stats: closed.stats,
      events: recentActivityEvents(storedEvents, closed.items),
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

async function triageSnapshot(env) {
  const generatedAt = new Date().toISOString();
  const errors = [];
  const repos = triageTargetRepos(env);
  const searchBudget = { remaining: triageSearchRequestBudget(env) };
  const itemLimit = triageItemsPerView(env, repos.length, searchBudget.remaining);
  const repoSnapshots = [];
  for (let index = 0; index < repos.length; index += 1) {
    const repo = repos[index];
    if (searchBudget.remaining < 1) {
      errors.push(`${repo} triage skipped: search budget exhausted before broad snapshot`);
      repoSnapshots.push(emptyTriageRepoSnapshot(repo));
      continue;
    }
    repoSnapshots.push(
      await triageSnapshotForRepo(
        env,
        repo,
        errors,
        itemLimit,
        searchBudget,
        repos.length - index - 1,
      ),
    );
  }
  const views = mergeTriageRepoViews(repoSnapshots, itemLimit);
  await attachTriageLinkedPullRequests(env, views, errors);
  const counts = Object.fromEntries(views.map((view) => [view.id, view.total_count]));
  return {
    schema_version: 1,
    generated_at: generatedAt,
    source: {
      target_repositories: repos,
      label_prefix: TRIAGE_LABEL_PREFIX,
      item_limit_per_view: itemLimit,
      search_request_budget_remaining: searchBudget.remaining,
    },
    counts,
    views,
    diagnostics: {
      errors: errors.slice(0, 20),
    },
  };
}

async function attachTriageLinkedPullRequests(env, views, errors) {
  const allItems = allTriageItems(views);
  for (const item of allItems) item.linked_pull_requests = [];
  const items = uniqueTriageItems(views);
  if (!items.length) return;
  if (!hasGithubAuth(env)) {
    errors.push(
      "linked pull requests: GITHUB_TOKEN or ClawSweeper GitHub App credentials are required for GraphQL enrichment",
    );
    return;
  }
  const limitedItems = items.slice(0, TRIAGE_LINKED_PR_ITEM_LIMIT);
  if (items.length > limitedItems.length) {
    errors.push(
      `linked pull requests: limited to ${limitedItems.length} of ${items.length} loaded issues`,
    );
  }
  const byRepo = new Map();
  for (const item of limitedItems) {
    const bucket = byRepo.get(item.repository) || [];
    bucket.push(item);
    byRepo.set(item.repository, bucket);
  }
  await Promise.all(
    [...byRepo.entries()].map(async ([repo, repoItems]) => {
      for (let index = 0; index < repoItems.length; index += TRIAGE_LINKED_PR_BATCH_SIZE) {
        const batch = repoItems.slice(index, index + TRIAGE_LINKED_PR_BATCH_SIZE);
        await attachTriageLinkedPullRequestBatch(env, repo, batch).catch((error) => {
          errors.push(`${repo} linked pull requests: ${error.message}`);
        });
      }
    }),
  );
  syncLinkedPullRequestsToDuplicateItems(views, limitedItems);
}

function allTriageItems(views) {
  return views.flatMap((view) => view.items || []);
}

function syncLinkedPullRequestsToDuplicateItems(views, linkedItems) {
  const linkedByKey = new Map(
    linkedItems.map((item) => [triageItemKey(item), item.linked_pull_requests || []]),
  );
  for (const item of allTriageItems(views)) {
    if (triageItemHasLabel(item, "clawsweeper:linked-pr-open")) {
      item.linked_pull_requests = linkedByKey.get(triageItemKey(item)) || [];
    }
  }
}

function triageItemKey(item) {
  return `${item.repository}#${item.number}`;
}

function uniqueTriageItems(views) {
  const seen = new Map();
  for (const view of views) {
    for (const item of view.items || []) {
      const key = triageItemKey(item);
      if (!seen.has(key) && triageItemHasLabel(item, "clawsweeper:linked-pr-open")) {
        seen.set(key, item);
      }
    }
  }
  return [...seen.values()].sort(newestTriageCreatedFirst);
}

function triageItemHasLabel(item, labelName) {
  return (item.labels || []).some(
    (label) => String(label.name || "").toLowerCase() === labelName.toLowerCase(),
  );
}

async function attachTriageLinkedPullRequestBatch(env, repo, items) {
  const [owner, name] = repo.split("/");
  if (!owner || !name || !items.length) return;
  const aliases = items
    .map(
      (item, index) => `
        issue${index}: issue(number: ${Number(item.number)}) {
          timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
            nodes {
              __typename
              ... on CrossReferencedEvent {
                willCloseTarget
                source {
                  __typename
                  ... on PullRequest {
                    number
                    title
                    url
                    state
                    repository { nameWithOwner }
                  }
                }
              }
              ... on ConnectedEvent {
                subject {
                  __typename
                  ... on PullRequest {
                    number
                    title
                    url
                    state
                    repository { nameWithOwner }
                  }
                }
              }
            }
          }
        }`,
    )
    .join("\n");
  const data = await githubGraphql(
    env,
    `query TriageLinkedPullRequests($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${aliases}
      }
    }`,
    { owner, name },
  );
  const repository = data?.repository || {};
  for (let index = 0; index < items.length; index += 1) {
    items[index].linked_pull_requests = linkedPullRequestsFromTimeline(
      repository[`issue${index}`]?.timelineItems?.nodes || [],
    );
  }
}

function linkedPullRequestsFromTimeline(nodes) {
  const prs = new Map();
  for (const node of nodes || []) {
    const source =
      node?.source?.__typename === "PullRequest"
        ? node.source
        : node?.subject?.__typename === "PullRequest"
          ? node.subject
          : null;
    if (!source?.url || !source?.number) continue;
    const repository = source.repository?.nameWithOwner || "";
    const key = `${repository}#${source.number}`;
    prs.set(key, {
      repository,
      number: source.number,
      title: source.title || "",
      url: source.url,
      state: normalizePullRequestState(source.state),
      will_close: Boolean(node.willCloseTarget),
    });
  }
  return [...prs.values()].sort(compareLinkedPullRequests);
}

function compareLinkedPullRequests(left, right) {
  const stateRank = { open: 0, merged: 1, closed: 2 };
  const leftRank = stateRank[left.state] ?? 9;
  const rightRank = stateRank[right.state] ?? 9;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return Number(right.number || 0) - Number(left.number || 0);
}

function normalizePullRequestState(state) {
  const text = String(state || "").toLowerCase();
  if (text === "merged") return "merged";
  if (text === "closed") return "closed";
  if (text === "open") return "open";
  return "unknown";
}

function emptyTriageRepoSnapshot(repo) {
  return {
    repository: repo,
    labels: [],
    views: TRIAGE_VIEWS.map((view) => ({
      id: view.id,
      repository: repo,
      title: view.title,
      description: view.description,
      query: null,
      github_url: null,
      total_count: 0,
      items: [],
    })),
  };
}

async function triageSnapshotForRepo(
  env,
  repo,
  errors,
  itemLimit,
  searchBudget,
  remainingRepoCount,
) {
  const repoLabels = await repoClawsweeperLabels(env, repo).catch((error) => {
    errors.push(`${repo} labels: ${error.message}`);
    return [];
  });
  const discoveredLabels = repoLabels.map((label) => label.name);
  const rootView = await triageViewForRepo(
    env,
    repo,
    TRIAGE_VIEWS[0],
    discoveredLabels,
    errors,
    itemLimit,
  );
  if (rootView.query) {
    searchBudget.remaining -= rootView.search_failed
      ? triageSearchPageCount(itemLimit, itemLimit)
      : triageSearchPageCount(itemLimit, rootView.total_count);
  }
  const rootIsComplete = rootView.total_count <= rootView.items.length;
  const fallbackItemLimit = Math.min(itemLimit, TRIAGE_FOCUSED_FALLBACK_ITEMS_PER_VIEW);
  const reservedRootSearches = remainingRepoCount * triageSearchPageCount(itemLimit, itemLimit);
  const focusedViews = [];
  let budgetExhausted = false;
  for (const view of TRIAGE_VIEWS.slice(1)) {
    if (rootIsComplete) {
      focusedViews.push(
        triageViewFromItems(repo, view, discoveredLabels, rootView.items, itemLimit),
      );
      continue;
    }
    const query = triageSearchQuery(repo, view, discoveredLabels);
    if (query && searchBudget.remaining - reservedRootSearches >= 1) {
      searchBudget.remaining -= triageSearchPageCount(fallbackItemLimit, fallbackItemLimit);
      focusedViews.push(
        await triageViewForRepo(
          env,
          repo,
          view,
          discoveredLabels,
          errors,
          fallbackItemLimit,
          rootView.items,
          itemLimit,
        ),
      );
      continue;
    }
    if (query) budgetExhausted = true;
    focusedViews.push(triageViewFromItems(repo, view, discoveredLabels, rootView.items, itemLimit));
  }
  if (budgetExhausted) {
    errors.push(
      `${repo} focused triage fallback: search budget exhausted; using loaded broad rows`,
    );
  }
  const views = [rootView, ...focusedViews];
  return {
    repository: repo,
    labels: repoLabels,
    views,
  };
}

function triageViewFromItems(repo, definition, discoveredLabels, sourceItems, itemLimit) {
  const query = triageSearchQuery(repo, definition, discoveredLabels);
  if (!query) {
    return {
      id: definition.id,
      repository: repo,
      title: definition.title,
      description: definition.description,
      query: null,
      github_url: null,
      item_limit: itemLimit,
      total_count: 0,
      items: [],
    };
  }
  const items = (sourceItems || [])
    .filter((item) => triageItemMatchesView(item, definition, discoveredLabels))
    .sort(newestTriageCreatedFirst)
    .slice(0, itemLimit);
  return {
    id: definition.id,
    repository: repo,
    title: definition.title,
    description: definition.description,
    query,
    github_url: githubSearchUrl(query),
    item_limit: itemLimit,
    total_count: items.length,
    items,
  };
}

function triageItemMatchesView(item, definition, discoveredLabels) {
  const labels = new Set((item.labels || []).map((label) => label.name.toLowerCase()));
  const available = new Set(discoveredLabels.map((label) => label.toLowerCase()));
  const allLabels = (definition.allLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  const withoutLabels = (definition.withoutLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  let anyLabels = [];
  if (definition.anyLabels === "discovered") {
    anyLabels = discoveredLabels;
  } else {
    anyLabels = (definition.anyLabels || []).filter((label) => available.has(label.toLowerCase()));
  }
  if ((definition.allLabels || []).length && allLabels.length !== definition.allLabels.length) {
    return false;
  }
  if (definition.anyLabels && anyLabels.length === 0) return false;
  if (allLabels.some((label) => !labels.has(label.toLowerCase()))) return false;
  if (withoutLabels.some((label) => labels.has(label.toLowerCase()))) return false;
  if (anyLabels.length && !anyLabels.some((label) => labels.has(label.toLowerCase()))) {
    return false;
  }
  return true;
}

function triageItemsPerView(env, repoCount = 1, searchBudget = triageSearchRequestBudget(env)) {
  const configured = Math.min(
    MAX_TRIAGE_ITEMS_PER_VIEW,
    Math.max(1, numberFrom(env.TRIAGE_ITEMS_PER_VIEW, DEFAULT_TRIAGE_ITEMS_PER_VIEW)),
  );
  const rootPagesPerRepo = Math.max(
    1,
    Math.floor(Math.max(1, searchBudget - 1) / Math.max(1, repoCount)),
  );
  return Math.min(configured, rootPagesPerRepo * TRIAGE_SEARCH_PAGE_SIZE);
}

function triageSearchRequestBudget(env) {
  return hasGithubAuth(env) ? 28 : 9;
}

function triageSearchPageCount(limit, totalCount) {
  return Math.ceil(Math.min(limit, Math.max(1, Number(totalCount || 0))) / TRIAGE_SEARCH_PAGE_SIZE);
}

function mergeTriageRepoViews(repoSnapshots, itemLimit) {
  return TRIAGE_VIEWS.map((definition) => {
    const repoViews = repoSnapshots.map((repo) =>
      repo.views.find((view) => view.id === definition.id),
    );
    const items = repoViews
      .flatMap((view) => view?.items || [])
      .sort(newestTriageCreatedFirst)
      .slice(0, itemLimit);
    const totalCount = repoViews.reduce((total, view) => total + (view?.total_count || 0), 0);
    const combinedQuery = combinedTriageSearchQuery(repoSnapshots, definition, repoViews);
    const viewItemLimit =
      Math.max(...repoViews.map((view) => view?.item_limit || 0).filter(Boolean)) || itemLimit;
    return {
      id: definition.id,
      title: definition.title,
      description: definition.description,
      total_count: totalCount,
      query: combinedQuery,
      github_url: combinedQuery ? githubSearchUrl(combinedQuery) : null,
      item_limit: viewItemLimit,
      items,
    };
  });
}

function combinedTriageSearchQuery(repoSnapshots, definition, repoViews) {
  const repos = repoViews
    .filter((view) => view?.query)
    .map((view) => view.repository)
    .filter(Boolean);
  if (!repos.length) return null;
  const parts = [...repos.map((repo) => `repo:${repo}`), "is:issue", "is:open"];
  if (definition.anyLabels === "discovered") {
    const labels = [
      ...new Set(
        repoSnapshots
          .filter((repo) => repos.includes(repo.repository))
          .flatMap((repo) => repo.labels.map((label) => label.name)),
      ),
    ].sort();
    if (!labels.length) return null;
    parts.push(`label:${labels.map(quoteSearchValue).join(",")}`);
  } else if (definition.anyLabels?.length) {
    parts.push(`label:${definition.anyLabels.map(quoteSearchValue).join(",")}`);
  }
  for (const label of definition.allLabels || []) parts.push(`label:${quoteSearchValue(label)}`);
  for (const label of definition.withoutLabels || [])
    parts.push(`-label:${quoteSearchValue(label)}`);
  return parts.join(" ");
}

async function triageViewForRepo(
  env,
  repo,
  definition,
  discoveredLabels,
  errors,
  itemLimit,
  fallbackSourceItems = null,
  fallbackItemLimit = itemLimit,
) {
  const query = triageSearchQuery(repo, definition, discoveredLabels);
  if (!query) {
    return {
      id: definition.id,
      repository: repo,
      title: definition.title,
      description: definition.description,
      query: null,
      github_url: null,
      item_limit: itemLimit,
      total_count: 0,
      items: [],
    };
  }
  const search = await githubIssueSearch(env, query, itemLimit).catch((error) => {
    errors.push(`${repo} ${definition.id}: ${error.message}`);
    if (fallbackSourceItems) {
      return {
        ...triageViewFromItems(
          repo,
          definition,
          discoveredLabels,
          fallbackSourceItems,
          fallbackItemLimit,
        ),
        search_failed: true,
      };
    }
    return {
      id: definition.id,
      repository: repo,
      title: definition.title,
      description: definition.description,
      query,
      github_url: githubSearchUrl(query),
      item_limit: itemLimit,
      total_count: 0,
      items: [],
      search_failed: true,
    };
  });
  if (search.search_failed) return search;
  return {
    id: definition.id,
    repository: repo,
    title: definition.title,
    description: definition.description,
    query,
    github_url: githubSearchUrl(query),
    item_limit: itemLimit,
    total_count: search.total_count || 0,
    items: Array.isArray(search.items)
      ? search.items.map((issue) => normalizeTriageIssue(repo, issue))
      : [],
  };
}

function triageSearchQuery(repo, definition, discoveredLabels) {
  const available = new Set(discoveredLabels.map((label) => label.toLowerCase()));
  const allLabels = (definition.allLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  const withoutLabels = (definition.withoutLabels || []).filter((label) =>
    available.has(label.toLowerCase()),
  );
  let anyLabels = [];
  if (definition.anyLabels === "discovered") {
    anyLabels = discoveredLabels;
  } else {
    anyLabels = (definition.anyLabels || []).filter((label) => available.has(label.toLowerCase()));
  }
  if ((definition.allLabels || []).length && allLabels.length !== definition.allLabels.length) {
    return null;
  }
  if (definition.anyLabels && anyLabels.length === 0) return null;
  const parts = [`repo:${repo}`, "is:issue", "is:open"];
  if (anyLabels.length) parts.push(`label:${anyLabels.map(quoteSearchValue).join(",")}`);
  for (const label of allLabels) parts.push(`label:${quoteSearchValue(label)}`);
  for (const label of withoutLabels) parts.push(`-label:${quoteSearchValue(label)}`);
  return parts.join(" ");
}

function newestTriageCreatedFirst(left, right) {
  const created = Date.parse(right?.created_at || "") - Date.parse(left?.created_at || "");
  if (Number.isFinite(created) && created !== 0) return created;
  const updated = Date.parse(right?.updated_at || "") - Date.parse(left?.updated_at || "");
  if (Number.isFinite(updated) && updated !== 0) return updated;
  const leftNumber = Number(left?.number);
  const rightNumber = Number(right?.number);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return 0;
}

async function repoClawsweeperLabels(env, repo) {
  const labels = [];
  for (let page = 1; page <= 4; page += 1) {
    const rows = await githubJson(env, `/repos/${repo}/labels?per_page=100&page=${page}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    labels.push(
      ...rows
        .filter((label) => String(label.name || "").startsWith(TRIAGE_LABEL_PREFIX))
        .map((label) => ({
          name: String(label.name || ""),
          color: String(label.color || ""),
          description: String(label.description || ""),
        })),
    );
    if (rows.length < 100) break;
  }
  return labels.sort((left, right) => left.name.localeCompare(right.name));
}

async function githubIssueSearch(env, query, perPage) {
  const limit = Math.min(MAX_TRIAGE_ITEMS_PER_VIEW, Math.max(1, perPage));
  const pageSize = Math.min(TRIAGE_SEARCH_PAGE_SIZE, limit);
  const firstPage = await githubIssueSearchPage(env, query, pageSize, 1);
  const totalCount = Number(firstPage?.total_count || 0);
  const items = Array.isArray(firstPage?.items) ? [...firstPage.items] : [];
  const wantedItems = Math.min(limit, totalCount || items.length);
  const pageCount = Math.ceil(wantedItems / pageSize);
  for (let page = 2; page <= pageCount; page += 1) {
    const nextPage = await githubIssueSearchPage(env, query, pageSize, page);
    if (!Array.isArray(nextPage?.items) || nextPage.items.length === 0) break;
    items.push(...nextPage.items);
  }
  return {
    ...firstPage,
    total_count: totalCount,
    items: items.slice(0, limit),
  };
}

async function githubIssueSearchPage(env, query, perPage, page) {
  return githubJson(
    env,
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&sort=created&order=desc`,
  );
}

function normalizeTriageIssue(repo, issue) {
  return {
    repository: repo,
    number: issue.number,
    title: issue.title || "",
    url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    comments: issue.comments || 0,
    author: issue.user?.login || null,
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.map((assignee) => assignee.login).filter(Boolean)
      : [],
    labels: Array.isArray(issue.labels)
      ? issue.labels.map((label) => ({
          name: String(label.name || ""),
          color: String(label.color || ""),
        }))
      : [],
  };
}

function triageTargetRepos(env) {
  const configured = String(env.TRIAGE_TARGET_REPOS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const targetRepos = String(env.TARGET_REPOS || "openclaw/openclaw")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return targetRepos.length ? [targetRepos[0]] : ["openclaw/openclaw"];
}

function quoteSearchValue(value) {
  return JSON.stringify(String(value));
}

function githubSearchUrl(query) {
  return `https://github.com/issues?q=${encodeURIComponent(query)}&s=created&o=desc`;
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

function isSupportWorkflowRun(run) {
  const name = String(run?.name || "").trim();
  if (SUPPORT_WORKFLOW_NAMES.has(name)) return true;
  const title = String(run?.display_title || "").trim();
  if (SUPPORT_WORKFLOW_NAMES.has(title)) return true;
  const lower = `${name} ${title}`.toLowerCase();
  return lower.includes("dashboard ci status") || lower.includes("github_activity");
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

async function recentClawsweeperClosed(env, repos) {
  const since = new Date(Date.now() - CLOSED_STATS_HOURS * 60 * 60 * 1000).toISOString();
  const trustedBotLogins = clawsweeperBotLogins(env);
  const rows = await Promise.all(
    repos.map((repo) => recentClawsweeperClosedForRepo(env, repo, since, trustedBotLogins)),
  );
  const items = rows
    .flat()
    .sort((left, right) => Date.parse(right.closed_at || "") - Date.parse(left.closed_at || ""));
  return {
    items: items.slice(0, RECENT_CLOSED_LIMIT),
    stats: closedStats(items, since),
  };
}

async function recentClawsweeperClosedForRepo(env, repo, since, trustedBotLogins) {
  const items = [];
  const firstPage = await githubJson(env, closedIssuesPath(repo, since, 1)).catch(() => []);
  const pages = [Array.isArray(firstPage) ? firstPage : []];
  if (pages[0].length >= 100 && CLOSED_STATS_PAGE_LIMIT > 1) {
    const remainingPages = await Promise.all(
      Array.from({ length: CLOSED_STATS_PAGE_LIMIT - 1 }, (_, index) =>
        githubJson(env, closedIssuesPath(repo, since, index + 2)).catch(() => []),
      ),
    );
    pages.push(...remainingPages.map((issues) => (Array.isArray(issues) ? issues : [])));
  }
  for (const issues of pages) {
    for (const item of issues) {
      if (!isClawsweeperClosedItem(item, since, trustedBotLogins)) continue;
      items.push({
        repository: repo,
        number: item.number,
        type: item.pull_request ? "PR" : "Issue",
        title: item.title || "",
        url: item.html_url,
        closed_at: item.closed_at,
        closed_by: item.closed_by?.login || null,
      });
    }
  }
  return items;
}

function closedIssuesPath(repo, since, page) {
  return `/repos/${repo}/issues?state=closed&sort=updated&direction=desc&since=${encodeURIComponent(
    since,
  )}&per_page=100&page=${page}`;
}

function isClawsweeperClosedItem(item, since, trustedBotLogins) {
  if (!item?.closed_at) return false;
  if (!trustedBotLogins.has(String(item.closed_by?.login || ""))) return false;
  return Date.parse(item.closed_at) >= Date.parse(since);
}

function recentActivityEvents(storedEvents, closedItems) {
  const rows = [];
  const seen = new Set();
  const storedCloseItemKeys = new Set();
  for (const event of Array.isArray(storedEvents) ? storedEvents : []) {
    const key = activityEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    const itemKey = activityItemKey(event);
    if (isStoredCloseEvent(event) && itemKey) storedCloseItemKeys.add(itemKey);
    rows.push(event);
  }
  for (const item of Array.isArray(closedItems) ? closedItems : []) {
    const itemKey = activityItemKey(item);
    if (itemKey && storedCloseItemKeys.has(itemKey)) continue;
    const event = activityEventFromClosedItem(item);
    const key = activityEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(event);
  }
  return rows
    .sort(
      (left, right) =>
        Date.parse(right.received_at || right.closed_at || "") -
        Date.parse(left.received_at || left.closed_at || ""),
    )
    .slice(0, 25);
}

function activityEventFromClosedItem(item) {
  return {
    event_type: "clawsweeper.item_closed",
    mode: "closed",
    stage: item.type || "item",
    status: "closed",
    repository: item.repository,
    item_number: item.number,
    item_url: item.url,
    title: item.title,
    received_at: item.closed_at,
    source: "closed_items",
  };
}

function activityEventKey(event) {
  return [
    event.event_type || "",
    event.item_url || "",
    event.item_number || "",
    event.id || event.received_at || "",
  ].join(":");
}

function activityItemKey(event) {
  if (event.repository && event.item_number) return `${event.repository}#${event.item_number}`;
  const url = nullableString(event.item_url || event.url);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)(?:\/|$)/);
    return match ? `${match[1]}#${match[2]}` : null;
  } catch {
    return null;
  }
}

function isStoredCloseEvent(event) {
  return event.event_type === "clawsweeper.item_closed" && event.status === "executed";
}

function clawsweeperBotLogins(env) {
  const configured = String(env.CLAWSWEEPER_BOT_LOGINS || "")
    .split(",")
    .map((login) => login.trim())
    .filter(Boolean);
  return new Set(configured.length ? configured : DEFAULT_CLAWSWEEPER_BOT_LOGINS);
}

function closedStats(items, since) {
  const byRepo = {};
  let issues = 0;
  let prs = 0;
  for (const item of items) {
    const repoStats = byRepo[item.repository] || { total: 0, issues: 0, prs: 0 };
    repoStats.total += 1;
    if (item.type === "PR") {
      prs += 1;
      repoStats.prs += 1;
    } else {
      issues += 1;
      repoStats.issues += 1;
    }
    byRepo[item.repository] = repoStats;
  }
  return {
    window_hours: CLOSED_STATS_HOURS,
    since,
    total: items.length,
    issues,
    prs,
    by_repository: byRepo,
  };
}

function emptyClosedStats(generatedAt) {
  return {
    window_hours: CLOSED_STATS_HOURS,
    since: new Date(Date.parse(generatedAt) - CLOSED_STATS_HOURS * 60 * 60 * 1000).toISOString(),
    total: 0,
    issues: 0,
    prs: 0,
    by_repository: {},
  };
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
  const token = await githubAuthToken(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GITHUB_TIMEOUT_MS);
  const response = await fetch(`https://api.github.com${path}`, {
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "openclaw-clawsweeper-status",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

async function githubGraphql(env, query, variables) {
  const token = await githubAuthToken(env);
  if (!token) throw new Error("GitHub auth is required for GraphQL");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), OPTIONAL_SECTION_TIMEOUT_MS);
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-status",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}`);
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }
  return payload.data;
}

function hasGithubAuth(env) {
  return Boolean(env.GITHUB_TOKEN || githubAppCredentials(env));
}

async function githubAuthToken(env) {
  if (env.GITHUB_TOKEN) return String(env.GITHUB_TOKEN);
  const credentials = githubAppCredentials(env);
  if (!credentials) return "";

  const now = Date.now();
  const repos = triageTargetRepos(env);
  const cacheKey = [
    credentials.issuer,
    credentials.installationId || repos[0] || "",
    repos.join(","),
  ].join("|");
  if (
    githubAppTokenCache?.key === cacheKey &&
    githubAppTokenCache.expiresAtMs - GITHUB_APP_TOKEN_REFRESH_SKEW_MS > now
  ) {
    return githubAppTokenCache.token;
  }
  if (githubAppTokenCache?.key === cacheKey && githubAppTokenCache.promise) {
    return githubAppTokenCache.promise;
  }

  const promise = createGithubAppInstallationToken(env, credentials, repos)
    .then((result) => {
      githubAppTokenCache = {
        key: cacheKey,
        token: result.token,
        expiresAtMs: result.expiresAtMs,
      };
      return result.token;
    })
    .catch((error) => {
      githubAppTokenCache = null;
      throw error;
    });
  githubAppTokenCache = {
    key: cacheKey,
    token: "",
    expiresAtMs: 0,
    promise,
  };
  return promise;
}

function githubAppCredentials(env) {
  const issuer = stringEnv(env.CLAWSWEEPER_APP_ID) || stringEnv(env.CLAWSWEEPER_APP_CLIENT_ID);
  const privateKey = normalizePrivateKey(env.CLAWSWEEPER_APP_PRIVATE_KEY);
  if (!issuer || !privateKey) return null;
  return {
    issuer,
    privateKey,
    installationId: stringEnv(env.CLAWSWEEPER_APP_INSTALLATION_ID),
  };
}

async function createGithubAppInstallationToken(env, credentials, repos) {
  const appJwt = await signGithubAppJwt(credentials.issuer, credentials.privateKey);
  const installationId =
    credentials.installationId || (await githubAppInstallationId(appJwt, repos[0]));
  const payload = await githubAppJson(
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    {
      method: "POST",
      body: JSON.stringify({
        permissions: {
          actions: "read",
          checks: "read",
          contents: "read",
          issues: "read",
          pull_requests: "read",
        },
      }),
      errorLabel: "GitHub App token",
    },
  );
  const token = String(payload.token || "");
  if (!token) throw new Error("GitHub App token response missing token");
  const expiresAtMs = payload.expires_at
    ? Date.parse(payload.expires_at)
    : Date.now() + GITHUB_APP_TOKEN_DEFAULT_TTL_MS;
  return { token, expiresAtMs };
}

async function githubAppInstallationId(appJwt, repo) {
  if (!repo || !repo.includes("/")) throw new Error("GitHub App installation repo is required");
  const payload = await githubAppJson(`/repos/${repo}/installation`, appJwt, {
    errorLabel: "GitHub App installation",
  });
  const installationId = Number(payload.id);
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new Error(`GitHub App installation response missing id for ${repo}`);
  }
  return String(installationId);
}

async function githubAppJson(path, appJwt, options: GithubAppJsonOptions = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), GITHUB_TIMEOUT_MS);
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    signal: controller.signal,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "openclaw-clawsweeper-status",
      Authorization: `Bearer ${appJwt}`,
    },
    body: options.body,
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`${options.errorLabel || "GitHub App"} ${response.status}`);
  return response.json();
}

async function signGithubAppJwt(issuer, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: issuer }));
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function normalizePrivateKey(value) {
  return stringEnv(value)?.replace(/\\n/g, "\n") || "";
}

function pemToPkcs8(pem) {
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  if (pkcs8) return pkcs8;
  const pkcs1 = pemBody(pem, "RSA PRIVATE KEY");
  if (!pkcs1) throw new Error("GitHub App private key must be PEM encoded");
  return wrapPkcs1PrivateKey(pkcs1);
}

function pemBody(pem, label) {
  const pattern = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`, "m");
  const match = String(pem).match(pattern);
  if (!match) return null;
  const binary = atob(match[1].replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function wrapPkcs1PrivateKey(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const octetString = derElement(0x04, pkcs1);
  return derElement(0x30, concatBytes(version, algorithm, octetString));
}

function derElement(tag, value) {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length) {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function base64UrlEncode(value) {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringEnv(value) {
  const text = String(value || "").trim();
  return text ? text : "";
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

function triageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClawSweeper Triage</title>
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
}
* { box-sizing: border-box; }
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
}
main { width: min(1560px, calc(100vw - 40px)); margin: 0 auto; padding: 28px 0 48px; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
h1 { margin: 0; font-size: 28px; line-height: 1.1; letter-spacing: 0; }
h2 { margin: 24px 0 12px; font-size: 16px; font-weight: 600; letter-spacing: 0; }
a { color: var(--blue); text-decoration: none; }
a:hover { color: #89c8ff; text-decoration: underline; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.top-links { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.pill,
.tab,
.query-link {
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
}
.query-link { color: var(--blue); }
.grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
.metric {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 14px 16px;
  min-height: 88px;
  overflow: hidden;
}
.metric strong { display: block; font-size: 28px; line-height: 1.1; margin-top: 8px; font-weight: 700; }
.metric span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; }
.tabs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 12px;
  padding-bottom: 8px;
}
button.tab {
  cursor: pointer;
  font: inherit;
}
button.tab[aria-selected="true"] {
  background: rgba(103, 183, 255, 0.16);
  border-color: rgba(103, 183, 255, 0.55);
}
.view-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin: 12px 0;
}
.view-title { display: grid; gap: 3px; min-width: 0; }
.view-title strong { font-size: 18px; }
.controls {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 12px;
  flex-wrap: wrap;
}
.control-group {
  display: flex;
  align-items: end;
  gap: 10px;
  flex-wrap: wrap;
}
.field {
  display: grid;
  gap: 5px;
  min-width: 220px;
}
.field span {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
input,
select,
.secondary-button {
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #0d131b;
  color: var(--text);
  padding: 7px 10px;
  font: inherit;
}
input { min-width: min(460px, calc(100vw - 40px)); }
select { min-width: 190px; }
input:focus,
select:focus,
.secondary-button:focus {
  outline: 2px solid rgba(103, 183, 255, 0.4);
  outline-offset: 1px;
}
.secondary-button {
  cursor: pointer;
  min-width: 70px;
  font-weight: 600;
}
.table-wrap {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
}
table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
}
th,
td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
th {
  position: relative;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  background: #0d131b;
  font-weight: 600;
  letter-spacing: 0.05em;
}
tbody tr:hover { background: rgba(103, 183, 255, 0.03); }
tr:last-child td { border-bottom: 0; }
.issue-cell { display: grid; gap: 4px; min-width: 0; }
.issue-title {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.25;
  font-weight: 650;
}
.label-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.assignee-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.pr-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.label-pill,
.priority-filter {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.16);
  background: #1a2532;
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
}
.label-pill.clawsweeper { border-color: rgba(103, 183, 255, 0.35); }
.label-pill:hover,
.priority-filter:hover {
  border-color: rgba(103, 183, 255, 0.55);
  color: #ffffff;
}
.priority-filter {
  border-color: rgba(243, 183, 89, 0.42);
  background: rgba(243, 183, 89, 0.1);
  color: var(--amber);
}
.assignee-pill {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid rgba(103, 183, 255, 0.28);
  background: rgba(103, 183, 255, 0.1);
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.pr-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 19px;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.16);
  background: #1a2532;
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.pr-chip.open { border-color: rgba(78, 216, 145, 0.45); color: var(--green); }
.pr-chip.merged { border-color: rgba(185, 156, 255, 0.45); color: var(--violet); }
.pr-chip.closed { border-color: rgba(244, 109, 117, 0.45); color: var(--red); }
.resize-handle {
  position: absolute;
  top: 0;
  right: -4px;
  width: 8px;
  height: 100%;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
}
.resize-handle::after {
  content: "";
  position: absolute;
  top: 22%;
  bottom: 22%;
  left: 3px;
  width: 1px;
  background: transparent;
}
.resize-handle:hover::after,
body.resizing-col .resize-handle::after {
  background: rgba(103, 183, 255, 0.55);
}
body.resizing-col {
  cursor: col-resize;
  user-select: none;
}
.priority { color: var(--amber); }
.empty,
.error {
  padding: 24px;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  text-align: center;
}
.error { color: var(--red); border-color: rgba(244,109,117,0.35); }
@media (max-width: 1280px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } header, .view-head { align-items: start; flex-direction: column; } .top-links { justify-content: flex-start; } }
@media (max-width: 760px) { main { width: min(100vw - 20px, 1560px); padding-top: 16px; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>ClawSweeper Triage</h1>
      <div class="muted" id="subtitle">Loading advisory issue labels...</div>
    </div>
    <div class="top-links">
      <a class="pill" href="/">Live pipeline</a>
      <span class="muted mono" id="updated"></span>
    </div>
  </header>
  <section class="grid" id="metrics"></section>
  <section class="controls" id="controls">
    <div class="control-group">
      <label class="field">
        <span>Filter</span>
        <input id="issue-filter" type="search" placeholder="Title, number, author, assignee, label...">
      </label>
      <button class="secondary-button" id="clear-filter" type="button">Clear</button>
      <label class="field">
        <span>Sort</span>
        <select id="issue-sort">
          <option value="created-desc">Newest issue first</option>
          <option value="created-asc">Oldest issue first</option>
          <option value="number-desc">Highest issue number first</option>
          <option value="number-asc">Lowest issue number first</option>
          <option value="updated-desc">Recently updated first</option>
          <option value="updated-asc">Least recently updated first</option>
          <option value="comments-desc">Most comments first</option>
          <option value="comments-asc">Fewest comments first</option>
        </select>
      </label>
    </div>
    <span class="muted mono" id="visible-count">Showing 0 loaded</span>
  </section>
  <nav class="tabs" id="tabs" aria-label="Triage views"></nav>
  <section class="view-head">
    <div class="view-title">
      <strong id="view-name">Loading</strong>
      <span class="muted" id="view-description"></span>
    </div>
    <a class="query-link" id="github-query" href="https://github.com/issues" target="_blank" rel="noreferrer">Open GitHub query</a>
  </section>
  <section id="table"></section>
  <h2>Diagnostics</h2>
  <section id="diagnostics" class="muted"></section>
</main>
<script>
const fmt = new Intl.NumberFormat();
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const COLUMN_ORDER = ["issue", "assignees", "priority", "prs", "labels", "updated", "comments"];
const COLUMN_LABELS = {
  issue: "Issue",
  assignees: "Assignees",
  priority: "Priority",
  prs: "Linked PRs",
  labels: "Labels",
  updated: "Updated",
  comments: "Comments",
};
const COLUMN_DEFAULTS = {
  issue: 420,
  assignees: 140,
  priority: 92,
  prs: 180,
  labels: 430,
  updated: 130,
  comments: 96,
};
const COLUMN_MIN = {
  issue: 240,
  assignees: 100,
  priority: 76,
  prs: 120,
  labels: 220,
  updated: 110,
  comments: 84,
};
function storageGet(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
let state = null;
let activeView = location.hash.replace(/^#/, "") || storageGet("clawsweeper:triage-view") || "clawsweeper";
let filterText = storageGet("clawsweeper:triage-filter");
let sortMode = storageGet("clawsweeper:triage-sort") || "created-desc";
let filterTimer = null;
let columnWidths = loadColumnWidths();
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function loadColumnWidths() {
  let saved = {};
  try {
    saved = JSON.parse(storageGet("clawsweeper:triage-columns") || "{}");
  } catch {
    saved = {};
  }
  return Object.fromEntries(COLUMN_ORDER.map(key => {
    const width = Number(saved[key]);
    return [key, Math.max(COLUMN_MIN[key], Number.isFinite(width) ? width : COLUMN_DEFAULTS[key])];
  }));
}
function saveColumnWidths() {
  storageSet("clawsweeper:triage-columns", JSON.stringify(columnWidths));
}
function tableWidth() {
  return COLUMN_ORDER.reduce((total, key) => total + columnWidths[key], 0);
}
function columnPercent(key) {
  const total = Math.max(1, tableWidth());
  return ((columnWidths[key] / total) * 100).toFixed(3) + "%";
}
function colgroupHtml() {
  return COLUMN_ORDER.map(key => '<col data-col="' + esc(key) + '" style="width:' + esc(columnPercent(key)) + '">').join("");
}
function headerCell(key) {
  const label = COLUMN_LABELS[key] || key;
  return '<th><span>' + esc(label) + '</span><span class="resize-handle" role="separator" aria-label="Resize ' + esc(label) + ' column" data-resize-col="' + esc(key) + '"></span></th>';
}
function tableHeaderHtml() {
  return COLUMN_ORDER.map(headerCell).join("");
}
function applyColumnWidths() {
  const table = document.querySelector("#table table");
  if (table) table.style.width = "100%";
  document.querySelectorAll("#table col[data-col]").forEach(col => {
    const key = col.getAttribute("data-col");
    if (columnWidths[key]) col.style.width = columnPercent(key);
  });
}
function since(iso) {
  const diff = Date.parse(iso) - Date.now();
  const minutes = Math.round(diff / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (Math.abs(minutes) < 90) return rel.format(minutes, "minute");
  return rel.format(Math.round(minutes / 60), "hour");
}
function compact(value) {
  return String(value ?? "").replace(/\\s+/g, " ").trim();
}
function metric(label, count, detail) {
  return '<article class="metric"><span>' + esc(label) + '</span><strong>' + esc(fmt.format(count || 0)) + '</strong><div class="muted">' + esc(detail || "") + '</div></article>';
}
function labelPill(label) {
  const name = label.name || String(label);
  const color = label.color ? '#' + label.color : '';
  const style = color ? ' style="background: color-mix(in srgb, ' + esc(color) + ' 22%, #1a2532); border-color: color-mix(in srgb, ' + esc(color) + ' 55%, #2a3646);"' : '';
  const cls = name.startsWith("clawsweeper:") ? "label-pill clawsweeper" : "label-pill";
  return '<button class="' + cls + '" type="button" data-filter-value="' + esc(name) + '"' + style + ' title="Filter by ' + esc(name) + '">' + esc(name) + '</button>';
}
function assigneePills(row) {
  const assignees = Array.isArray(row.assignees) ? row.assignees : [];
  if (!assignees.length) return '<span class="muted">Unassigned</span>';
  return assignees.map(assignee => '<span class="assignee-pill">' + esc(assignee) + '</span>').join("");
}
function linkedPullRequestPills(row) {
  const prs = Array.isArray(row.linked_pull_requests) ? row.linked_pull_requests : [];
  if (!prs.length) return '<span class="muted">-</span>';
  return prs
    .map((pr) => {
      const state = pr.state || "unknown";
      const label = state.toUpperCase() + " #" + pr.number;
      return '<a class="pr-chip ' + esc(state) + '" href="' + esc(pr.url) + '" target="_blank" rel="noreferrer" title="' + esc(pr.repository + "#" + pr.number + ": " + pr.title) + '">' + esc(label) + '</a>';
    })
    .join("");
}
function priorityFor(row) {
  return (row.labels || []).map(label => label.name).find(name => /^P[0-3]$/.test(name || "")) || "";
}
function searchableText(row) {
  const assignees = row.assignees || [];
  return [
    row.title,
    row.repository,
    "#" + row.number,
    row.number,
    row.author,
    ...(assignees.length ? assignees : ["unassigned"]),
    ...(row.linked_pull_requests || []).flatMap(pr => [
      pr.repository,
      "#" + pr.number,
      pr.title,
      pr.state,
    ]),
    priorityFor(row),
    ...(row.labels || []).map(label => label.name)
  ].join(" ").toLowerCase();
}
function filteredRows(rows) {
  const terms = filterText.toLowerCase().split(/\\s+/).filter(Boolean);
  const visible = terms.length
    ? rows.filter(row => terms.every(term => searchableText(row).includes(term)))
    : rows.slice();
  return visible.sort(compareRows);
}
function compareRows(left, right) {
  if (sortMode === "created-asc") return Date.parse(left.created_at || "") - Date.parse(right.created_at || "");
  if (sortMode === "number-desc") return Number(right.number || 0) - Number(left.number || 0);
  if (sortMode === "number-asc") return Number(left.number || 0) - Number(right.number || 0);
  if (sortMode === "updated-desc") return Date.parse(right.updated_at || "") - Date.parse(left.updated_at || "");
  if (sortMode === "updated-asc") return Date.parse(left.updated_at || "") - Date.parse(right.updated_at || "");
  if (sortMode === "comments-desc") return Number(right.comments || 0) - Number(left.comments || 0);
  if (sortMode === "comments-asc") return Number(left.comments || 0) - Number(right.comments || 0);
  return Date.parse(right.created_at || "") - Date.parse(left.created_at || "");
}
function renderTabs(views) {
  document.getElementById("tabs").innerHTML = views.map(view =>
    '<button class="tab" type="button" data-view="' + esc(view.id) + '" aria-selected="' + (view.id === activeView ? "true" : "false") + '">' +
    esc(view.title) + ' <span class="muted">' + esc(fmt.format(view.total_count || 0)) + '</span></button>'
  ).join("");
  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      activeView = button.dataset.view;
      storageSet("clawsweeper:triage-view", activeView);
      history.replaceState(null, "", "#" + activeView);
      render();
    });
  });
}
function renderMetrics(views) {
  const byId = Object.fromEntries(views.map(view => [view.id, view.total_count || 0]));
  document.getElementById("metrics").innerHTML = [
    metric("ClawSweeper issues", byId.clawsweeper, "any discovered clawsweeper label"),
    metric("Ready candidates", byId["ready-candidates"], "queueable and unblocked"),
    metric("Blocked queue", byId["queueable-blocked"], "queueable but no-new-fix-pr"),
    metric("Linked PRs", byId["already-has-pr"], "open fix PR already found"),
    metric("Needs review", byId["needs-maintainer-review"], "maintainer decision next"),
    metric("Product/security", byId["product-security"], "policy or security call")
  ].join("");
}
function renderTable(view) {
  document.getElementById("view-name").textContent = view.title + " (" + fmt.format(view.total_count || 0) + ")";
  document.getElementById("view-description").textContent = view.description || "";
  const query = document.getElementById("github-query");
  query.href = view.github_url || "https://github.com/issues";
  query.style.display = view.github_url ? "inline-flex" : "none";
  renderRows(view);
}
function renderRows(view) {
  const rows = filteredRows(view.items || []);
  const visibleCount = document.getElementById("visible-count");
  if (visibleCount) {
    const loaded = (view.items || []).length;
    const total = view.total_count || loaded;
    const limit = view.item_limit || state?.source?.item_limit_per_view || loaded;
    const totalText = total > loaded ? " \\u00b7 " + fmt.format(total) + " total" : "";
    visibleCount.textContent =
      "Showing " +
      fmt.format(rows.length) +
      " of " +
      fmt.format(loaded) +
      " loaded" +
      totalText +
      " \u00b7 max " +
      fmt.format(limit) +
      " for this view";
  }
  if (!view.items || !view.items.length) {
    document.getElementById("table").innerHTML = '<div class="empty">No matching issues in the current snapshot.</div>';
    return;
  }
  if (!rows.length) {
    document.getElementById("table").innerHTML = '<div class="empty">No issues match the current filter.</div>';
    return;
  }
  const tableRows = rows.map(row => {
    const priority = priorityFor(row);
    const issueLabel = row.repository + "#" + row.number;
    const priorityCell = priority
      ? '<button class="priority-filter" type="button" data-filter-value="' + esc(priority) + '" title="Filter by ' + esc(priority) + '">' + esc(priority) + '</button>'
      : "-";
    return '<tr>' +
      '<td><div class="issue-cell"><a class="issue-title" href="' + esc(row.url) + '" target="_blank" rel="noreferrer">' + esc(compact(row.title)) + '</a><span class="muted mono">' + esc(issueLabel) + (row.author ? " opened by " + esc(row.author) : "") + '</span></div></td>' +
      '<td><div class="assignee-list">' + assigneePills(row) + '</div></td>' +
      '<td class="priority">' + priorityCell + '</td>' +
      '<td><div class="pr-list">' + linkedPullRequestPills(row) + '</div></td>' +
      '<td><div class="label-list">' + (row.labels || []).map(labelPill).join("") + '</div></td>' +
      '<td><span title="' + esc(row.updated_at || "") + '">' + esc(since(row.updated_at)) + '</span></td>' +
      '<td>' + esc(fmt.format(row.comments || 0)) + '</td>' +
      '</tr>';
  }).join("");
  document.getElementById("table").innerHTML =
    '<div class="table-wrap"><table><colgroup>' +
    colgroupHtml() +
    '</colgroup><thead><tr>' + tableHeaderHtml() + '</tr></thead><tbody>' +
    tableRows +
    '</tbody></table></div>';
}
function currentView() {
  const views = state?.views || [];
  return views.find(view => view.id === activeView) || views[0] || null;
}
function initControls() {
  const input = document.getElementById("issue-filter");
  const sort = document.getElementById("issue-sort");
  input.value = filterText;
  sort.value = sortMode;
  input.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterText = input.value;
      storageSet("clawsweeper:triage-filter", filterText);
      const view = currentView();
      if (view) renderRows(view);
    }, 80);
  });
  document.getElementById("clear-filter").addEventListener("click", () => {
    filterText = "";
    input.value = "";
    storageSet("clawsweeper:triage-filter", filterText);
    const view = currentView();
    if (view) renderRows(view);
    input.focus();
  });
  sort.addEventListener("change", event => {
    sortMode = event.target.value;
    storageSet("clawsweeper:triage-sort", sortMode);
    const view = currentView();
    if (view) renderRows(view);
  });
  document.getElementById("table").addEventListener("click", event => {
    const target = event.target.closest("[data-filter-value]");
    if (!target) return;
    filterText = target.getAttribute("data-filter-value") || "";
    input.value = filterText;
    storageSet("clawsweeper:triage-filter", filterText);
    const view = currentView();
    if (view) renderRows(view);
    input.focus();
  });
  document.getElementById("table").addEventListener("pointerdown", event => {
    const handle = event.target.closest("[data-resize-col]");
    if (!handle) return;
    event.preventDefault();
    const key = handle.getAttribute("data-resize-col");
    if (!COLUMN_ORDER.includes(key)) return;
    const startX = event.clientX;
    const startWidth = columnWidths[key] || COLUMN_DEFAULTS[key];
    document.body.classList.add("resizing-col");
    const onMove = moveEvent => {
      columnWidths[key] = Math.round(Math.max(COLUMN_MIN[key], startWidth + moveEvent.clientX - startX));
      applyColumnWidths();
    };
    const onUp = () => {
      document.body.classList.remove("resizing-col");
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      saveColumnWidths();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}
function renderDiagnostics(data) {
  const errors = data.diagnostics?.errors || [];
  document.getElementById("diagnostics").innerHTML = errors.length
    ? '<div class="error">' + errors.map(esc).join("<br>") + '</div>'
    : '<div class="empty">No dashboard diagnostics in this snapshot.</div>';
}
function render() {
  if (!state) return;
  const views = state.views || [];
  if (!views.find(view => view.id === activeView) && views.length) activeView = views[0].id;
  document.getElementById("subtitle").textContent = (state.source?.target_repositories || []).join(", ") + " - read-only GitHub Search snapshot";
  document.getElementById("updated").textContent = "Updated " + since(state.generated_at);
  renderMetrics(views);
  renderTabs(views);
  renderTable(views.find(view => view.id === activeView) || views[0] || {});
  renderDiagnostics(state);
}
async function load() {
  try {
    const response = await fetch("/api/triage", { cache: "no-store" });
    if (!response.ok) throw new Error("/api/triage returned " + response.status);
    state = await response.json();
    render();
  } catch (error) {
    document.getElementById("subtitle").textContent = "Failed to load triage data: " + error.message;
    document.getElementById("table").innerHTML = '<div class="error">' + esc(error.message) + '</div>';
  }
}
initControls();
load();
setInterval(load, 120000);
</script>
</body>
</html>`;
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
.top-links { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
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
#automerge,
#closed,
#events {
  min-width: 0;
  overflow: hidden;
  border-radius: 14px;
}
.work-list,
.side-list {
  display: grid;
  gap: 8px;
}
.work-row,
.side-row {
  display: grid;
  gap: 12px;
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}
.work-row {
  grid-template-columns: minmax(0, 1fr) minmax(210px, 260px) 82px;
  align-items: center;
  padding: 12px 14px;
}
.side-row {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  padding: 11px 12px;
}
.work-row:hover,
.side-row:hover {
  border-color: rgba(103, 183, 255, 0.35);
  background: rgba(103, 183, 255, 0.03);
}
.work-main,
.side-main {
  min-width: 0;
}
.row-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.item-link {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.work-title,
.side-title {
  display: -webkit-box;
  margin-top: 4px;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.work-state {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}
.stage-block {
  display: grid;
  justify-items: end;
  gap: 2px;
  min-width: 74px;
}
.run-link {
  color: var(--blue);
}
.timebox {
  display: grid;
  justify-items: end;
  gap: 2px;
  white-space: nowrap;
}
.timebox strong {
  font-size: 18px;
  line-height: 1;
}
.timebox span,
.side-meta {
  color: var(--muted);
  font-size: 12px;
}
.side-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  white-space: nowrap;
}
.closed-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 8px;
}
.closed-stat {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 10px 12px;
  min-width: 0;
}
.closed-stat span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.closed-stat strong {
  display: block;
  margin-top: 4px;
  font-size: 22px;
  line-height: 1;
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
@media (max-width: 1280px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } .split { grid-template-columns: 1fr; } header { align-items: start; flex-direction: column; } .top-links { justify-content: flex-start; } }
@media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .work-row { grid-template-columns: 1fr; align-items: start; } .work-state, .stage-block, .timebox { justify-content: start; justify-items: start; } }
@media (max-width: 560px) { main { width: min(100vw - 20px, 1440px); padding-top: 16px; } .grid, .closed-stats { grid-template-columns: 1fr; } .side-row { grid-template-columns: 1fr; } .side-meta { justify-content: flex-start; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>ClawSweeper Live</h1>
      <div class="muted" id="subtitle">🌊 Loading pipeline state...</div>
    </div>
    <div class="top-links">
      <a class="pill" href="/triage">Issue triage</a>
      <span class="muted mono" id="updated"></span>
    </div>
  </header>
  <section class="grid" id="metrics"></section>
  <section class="split">
    <div class="pipeline-col">
      <h2>🌀 Active Pipeline</h2>
      <div id="pipeline"></div>
    </div>
    <aside class="side-col">
      <h2>⚡ Automerge Speed</h2>
      <div id="automerge"></div>
      <h2>✅ Closed by ClawSweeper</h2>
      <div id="closed-stats"></div>
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
function linkClass(url, label, className) {
  return url ? '<a class="' + esc(className || "") + '" href="' + esc(url) + '">' + esc(label || url) + '</a>' : esc(label || "");
}
function compactText(value) {
  return String(value ?? "")
    .replace(/\\b([0-9a-f]{10})[0-9a-f]{22,}\\b/gi, "$1")
    .replace(/[\\t\\n\\r\\f ]+/g, " ")
    .trim();
}
function pipelineItemLabel(row) {
  if (row.repository && row.item_number) {
    return linkClass("https://github.com/" + row.repository + "/issues/" + row.item_number, row.repository + "#" + row.item_number, "item-link");
  }
  return '<span class="item-link">' + esc(compactText(row.title)) + '</span>';
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
    metric("🌊 Active Sweeps", fmt.format(fleet.active_workflow_runs), "support " + fmt.format(fleet.support_workflow_runs || 0), Math.min(100, fleet.active_workflow_runs * 3), "var(--blue)"),
    metric("⏳ Queue Depth", fmt.format(fleet.queued_workflow_runs), "support queue " + fmt.format(fleet.support_queued_workflow_runs || 0), Math.min(100, fleet.queued_workflow_runs * 10), "var(--amber)"),
    metric("💥 Recent Snags", fmt.format(fleet.failed_recent_runs), "last page", Math.min(100, fleet.failed_recent_runs * 15), fleet.failed_recent_runs ? "var(--red)" : "var(--green)"),
    metric("⚡ Merge Speed", data.averages.automerge_command_to_merge_ms ? elapsed(data.averages.automerge_command_to_merge_ms) : "n/a", data.averages.automerge_samples + " samples", 60, "var(--violet)"),
    metric("🎯 Capacity", fleet.budget_used_percent + "%", "fleet utilization", fleet.budget_used_percent, "var(--green)")
  ].join("");
  renderPipeline(data.pipeline || []);
  renderAutomerge(data.recent.automerge || []);
  renderClosedStats(data.recent.closed_stats);
  renderClosedItems(data.recent.closed_items || []);
  renderEvents(data.recent.events || []);
}
function renderPipeline(rows) {
  if (!rows.length) {
    document.getElementById("pipeline").innerHTML = '<div class="empty">All quiet in the depths... no active sweeps</div>';
    return;
  }
  document.getElementById("pipeline").innerHTML = '<div class="work-list">' + rows.map(row => {
    const detail = pipelineItemDetail(row);
    return '<article class="work-row"><div class="work-main" title="' + esc(compactText(row.title)) + '"><div class="row-top"><span class="pill" title="' + esc(row.mode) + '">' + esc(modeLabel(row.mode)) + '</span>' + pipelineItemLabel(row) + '</div>' + (detail ? '<div class="muted work-title">' + esc(detail) + '</div>' : "") + '</div><div class="work-state"><div class="stage-block"><strong>' + esc(row.stage) + '</strong><span class="muted">' + esc(row.status) + '</span></div>' + ciBadge(row.ci) + linkClass(row.run_url, "run", "pill run-link") + '</div><div class="timebox"><strong>' + elapsed(row.elapsed_ms) + '</strong><span>elapsed</span></div></article>';
  }).join("") + '</div>';
}
function renderAutomerge(rows) {
  if (!rows.length) {
    document.getElementById("automerge").innerHTML = '<div class="empty">No automerge data yet... claws resting</div>';
    return;
  }
  document.getElementById("automerge").innerHTML = '<div class="side-list">' + rows.map(row => '<article class="side-row"><div class="side-main">' + linkClass(row.url, "#" + row.number, "item-link") + '<div class="muted side-title">' + esc(row.title) + '</div></div><div class="side-meta"><span class="pill violet">' + (row.duration_ms ? elapsed(row.duration_ms) : "unknown") + '</span><span>' + (row.merged_at ? since(row.merged_at) : "") + '</span></div></article>').join("") + '</div>';
}
function renderClosedItems(rows) {
  if (!rows.length) {
    document.getElementById("closed").innerHTML = '<div class="empty">No ClawSweeper closes found...</div>';
    return;
  }
  document.getElementById("closed").innerHTML = '<div class="side-list">' + rows.map(row => '<article class="side-row"><div class="side-main"><div class="row-top"><span class="pill">' + esc(row.type) + '</span>' + linkClass(row.url, row.repository + "#" + row.number, "item-link") + '</div><div class="muted side-title">' + esc(row.title) + '</div></div><div class="side-meta">' + since(row.closed_at) + '</div></article>').join("") + '</div>';
}
function renderClosedStats(stats) {
  const safe = stats || { total: 0, issues: 0, prs: 0, window_hours: 24 };
  document.getElementById("closed-stats").innerHTML = '<div class="closed-stats"><div class="closed-stat"><span>' + esc((safe.window_hours || 24) + "h total") + '</span><strong>' + fmt.format(safe.total || 0) + '</strong></div><div class="closed-stat"><span>Issues</span><strong>' + fmt.format(safe.issues || 0) + '</strong></div><div class="closed-stat"><span>PRs</span><strong>' + fmt.format(safe.prs || 0) + '</strong></div></div>';
}
function renderEvents(rows) {
  if (!rows.length) {
    document.getElementById("events").innerHTML = '<div class="empty">Listening for signals from the fleet...</div>';
    return;
  }
  document.getElementById("events").innerHTML = '<div class="side-list">' + rows.map(row => '<article class="side-row"><div class="side-main"><div class="row-top"><span class="pill">' + esc(row.mode) + '</span><span class="item-link">' + esc(row.stage) + '</span></div><div class="muted side-title">' + (row.item_url ? link(row.item_url, row.title || row.item_url) : esc(row.title || row.event_type)) + '</div></div><div class="side-meta"><span>' + esc(row.status) + '</span><span>' + since(row.received_at) + '</span></div></article>').join("") + '</div>';
}
load();
setInterval(load, 15000);
</script>
</body>
</html>`;
}
