import {
  assert,
  generateKeyPairSync,
  test,
  createContext,
  Script,
  worker,
  automaticIssueWork,
  workerWorkKind,
  MemoryKv,
  MemoryDurableNamespace,
  MemoryCache,
  isoAgo,
  completedReviewRun,
  activePrFetch,
  triageIssue,
  jsonResponse,
} from "./dashboard-worker-harness.ts";

test("dashboard classifies issue conversion and PR repair workers", () => {
  assert.equal(
    workerWorkKind(
      { title: "repair cluster jobs/openclaw/inbox/issue-openclaw-openclaw-123.md" },
      "Execute and apply cluster actions",
    ),
    "issue_to_pr",
  );
  assert.equal(
    workerWorkKind({ title: "automerge repair jobs/openclaw/inbox/automerge-456.md" }, ""),
    "pr_repair",
  );
  assert.equal(
    workerWorkKind({ title: "repair cluster jobs/openclaw/inbox/cluster-1.md" }, ""),
    "repair_cluster",
  );
});

test("dashboard HTML preserves UTF-8 emoji labels", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"), {
    CLAWSWEEPER_CRABFLEET_URL: "https://fleet.example.test/terminal?view=live&mode=all",
  });
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.match(html, /<title>🦞 ClawSweeper Live<\/title>/);
  assert.match(html, /content: "🦞"/);
  assert.match(html, /Codex Workers/);
  assert.doesNotMatch(html, /Active Sweeps/);
  assert.doesNotMatch(html, /Queue Depth/);
  assert.doesNotMatch(html, /Health Trends/);
  assert.doesNotMatch(html, /id="health-trend-grid"/);
  assert.match(html, /\/api\/health-history\?range=/);
  assert.match(html, /Work execution needs attention/);
  assert.doesNotMatch(html, /Review reliability/);
  assert.doesNotMatch(html, /\/api\/review-observability\?range=/);
  assert.match(html, /Apply \/ close health/);
  assert.match(html, /id="apply-observability-body"/);
  assert.match(html, /id="health-strip"/);
  assert.match(html, /Fleet Review Coverage/);
  assert.match(html, /id="review-coverage-body"/);
  assert.match(html, /\/api\/review-coverage/);
  assert.ok(html.indexOf("System Overview") < html.indexOf('id="review-coverage-body"'));
  assert.match(html, /<details class="review-coverage">/);
  assert.match(
    html,
    /<h2 id="review-coverage-title">Fleet Review Coverage<\/h2>\s*<details class="review-coverage">/,
  );
  assert.match(
    html,
    /<summary>\s*<span class="coverage-summary-content">\s*<span class="coverage-summary-label">Explore repository coverage<\/span>/,
  );
  assert.doesNotMatch(html, /<summary>(?:(?!<\/summary>)[\s\S])*<h2/);
  assert.doesNotMatch(html, /\.review-coverage > summary \{[^}]*display: flex/);
  assert.doesNotMatch(html, /<details class="review-coverage" open>/);
  assert.match(html, /aria-labelledby="review-coverage-title"/);
  assert.match(html, /\/api\/apply-observability\?range=/);
  assert.match(html, /data-trend-range="6h"/);
  assert.match(html, /<details class="execution-alert">/);
  assert.match(html, /Error Rate/);
  assert.match(html, /Recovery Rate/);
  assert.match(html, /Capacity/);
  assert.match(html, /Only jobs that execute Codex count against this budget/);
  assert.match(html, /id="exact-review-lanes"/);
  assert.match(html, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.exact-review-lanes \{ display: contents; \}/);
  assert.match(html, /Review admission/);
  assert.match(html, /Result publication/);
  assert.match(html, /Net publication rate/);
  assert.match(html, /Review throughput/);
  assert.doesNotMatch(html, /Control Plane · GitHub Actions, not Codex/);
  assert.doesNotMatch(html, /id="control-plane"/);
  assert.match(html, /\.exact-lanes \{ grid-template-columns: 1fr; \}/);
  assert.match(
    html,
    /<div class="exact-lanes">\s*<div class="exact-review-lanes" id="exact-review-lanes"[\s\S]*?<section class="exact-lane" id="state-writer-health"/,
  );
  assert.ok(html.indexOf("Codex Capacity") < html.indexOf('id="exact-review-lanes"'));
  assert.ok(html.indexOf('id="exact-review-lanes"') < html.indexOf("Apply / close health"));
  assert.ok(html.indexOf('id="exact-review-lanes"') < html.indexOf("Handoff Health"));
  assert.match(html, /Live terminals/);
  assert.match(html, /href="https:\/\/fleet\.example\.test\/terminal\?view=live&amp;mode=all"/);
  assert.match(html, /Loading pipeline state/);
  assert.match(html, /System Overview/);
  assert.match(html, /id="exact-review-handoff"/);
  assert.match(html, /function renderExactReviewHandoff/);
  assert.match(html, /id="recent-durable-publication-events"/);
  assert.match(html, /function renderRecentDurablePublicationEvents/);
  assert.match(html, /Workflow activity is not lifecycle completion/);
  assert.match(html, /waiting for run claim/);
  assert.match(html, /id="apply-health"/);
  assert.match(html, /function renderApplyHealth/);
  assert.match(html, /candidate examined count unavailable for this lane/);
  assert.match(html, /Pruning sweep/);
  assert.match(html, /Copy command/);
  assert.match(html, /applyHealthRecommendedAction/);
  assert.match(html, /Rotation cursor missing/);
  assert.match(html, /Inspect the cursor-write and state-publish steps/);
  assert.match(html, /const skipCount = skipReasons\[reason\]/);
  assert.doesNotMatch(html, /Apply needs attention/);
  assert.match(html, /Automatic Builds/);
  assert.match(html, /id="automatic-work"/);
  assert.match(html, /Lifecycle Timeline/);
  assert.match(html, /Active Workers/);
  assert.match(html, /id="worker-dialog"/);
  assert.match(html, /Step Timeline/);
  assert.match(html, /worker-target-title/);
  assert.match(html, /Refreshing live status in the background/);
  assert.match(html, /Cluster Intake/);
  assert.match(html, /Active Pipeline/);
  assert.doesNotMatch(html, /Automerge Reliability/);
  assert.doesNotMatch(html, /id="automerge-reliability"/);
  assert.match(html, /Automerge worker operations/);
  assert.match(html, /separate from Automerge Product Health success rate/);
  assert.match(html, /Time-window coverage/);
  assert.match(html, /Active sessions/);
  assert.match(html, /No terminal samples yet/);
  assert.match(html, /Repair workflow failed/);
  assert.match(html, /outcomeLabels\[session\.state\]/);
  assert.match(html, /Showing up to 30 latest sessions in the selected window/);
  assert.match(html, /Closed by ClawSweeper/);
  assert.match(html, /Worker Health/);
  assert.match(html, /Recent Activity/);
  assert.doesNotMatch(html, /ðŸ|â|âš|âœ/);
});

test("dashboard hero treats apply and exact-review handoff health as attention", async () => {
  const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/"));
  const html = await response.text();
  const script = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].at(-1)?.[1];
  assert.ok(script);

  const elements = new Map();
  const elementFor = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        addEventListener: () => undefined,
        className: "",
        close() {
          this.open = false;
        },
        dataset: {},
        id,
        innerHTML: "",
        open: false,
        showModal() {
          this.open = true;
        },
        style: {},
        textContent: "",
      });
    }
    return elements.get(id);
  };
  const status = {
    generated_at: "2026-07-05T11:22:43.934Z",
    source: { target_repositories: ["openclaw/openclaw"] },
    health: {
      attempts: 0,
      error_rate_percent: 0,
      failed_attempts: 0,
      failures: [],
      recovered_failures: 0,
      recovery_rate_percent: 100,
      unresolved_failures: 0,
    },
    fleet: {
      active_codex_jobs: 0,
      active_workflow_runs: 0,
      budget_used_percent: 0,
      queued_workflow_runs: 0,
      support_queued_workflow_runs: 0,
      support_workflow_runs: 0,
      worker_budget: 128,
      worker_detail_fallbacks: 0,
    },
    workers: [],
    automatic_work: [],
    pipeline: [],
    control_plane: {
      publishers: { running: 2, waiting: 1 },
      comment_routers: { running: 3, waiting: 4 },
      reconcilers: { running: 1, waiting: 0 },
    },
    exact_review_queue: {
      pending: 4,
      ready_pending: 3,
      admissible_pending: 2,
      lanes: {
        review: {
          pending: 4,
          ready: 3,
          backoff: 1,
          dispatching: 2,
          leased: 10,
          active: 12,
          capacity: 64,
          available_slots: 52,
          oldest_pending_age_seconds: 60,
          flow: {
            last_15_minutes: {
              arrival_rate_per_hour: 24,
              successful_rate_per_hour: 20,
              retried_rate_per_hour: 4,
              shed_rate_per_hour: 0,
              retry_amplification: 0.2,
            },
          },
        },
        publication: {
          pending: 2,
          ready: 1,
          backoff: 1,
          dispatching: 1,
          leased: 20,
          active: 21,
          capacity: 24,
          available_slots: 3,
          oldest_pending_age_seconds: 30,
          oldest_ready_age_seconds: 30,
          oldest_backoff_age_seconds: 20,
          flow: {
            last_15_minutes: {
              arrival_rate_per_hour: 12,
              resolved_rate_per_hour: 20,
              published_rate_per_hour: 4,
              superseded_rate_per_hour: 16,
              retried_rate_per_hour: 8,
              dead_lettered_rate_per_hour: 0,
              retry_amplification: 0.4,
            },
          },
          dead_letters: {
            open: 2,
            oldest_failed_at: "2026-07-05T10:22:43.934Z",
          },
          capacity_control: {
            mode: "throttled",
            base: 24,
            maximum: 48,
            ceiling: 24,
            demand_capacity: 32,
            cooldown_until: "2026-07-05T12:00:00.000Z",
            last_failure_kind: "github_rate_limit",
          },
        },
      },
      pressure: {
        status: "congested",
        reason: "capacity_full_with_backlog",
        capacity: 28,
        active: 28,
        pending: 4,
        ready_pending: 3,
        admissible_pending: 2,
      },
      handoff_health: {
        status: "healthy",
        message: "Dispatch-to-claim handoffs are within the expected window.",
        available_slots: 2,
        capacity: 28,
        stalled_after_seconds: 300,
        phases: {
          pending: { count: 4, oldest_age_seconds: 60 },
          dispatching: { count: 2, oldest_age_seconds: 10 },
          leased: { count: 24, oldest_age_seconds: 240 },
        },
      },
    },
    diagnostics: { errors: [], exact_review_queue_error: null as string | null },
    recent: {
      apply_health: {
        attention_count: 1,
        items: [
          {
            attention_reasons: ["cursor_required_but_missing_after_full_window"],
            closed: 0,
            comment_synced: 0,
            cursor: null,
            cursor_required: true,
            cycle: null,
            lanes: {
              closure: {
                closed: 0,
                comment_synced: 0,
                processed: 2,
                skip_reasons: { skipped_changed_since_review: 2 },
                skipped: 2,
              },
              comment_sync: {
                closed: 0,
                comment_synced: 0,
                processed: 0,
                skip_reasons: {},
                skipped: 0,
              },
            },
            mode: "close",
            next_action_buckets: { review_refresh: 2 },
            next_actions: [
              {
                bucket: "review_refresh",
                count: 2,
                label: "Refresh review",
                next_step: "Queue a fresh ClawSweeper review before any close retry.",
                owner: "clawsweeper",
                reason: "skipped_changed_since_review",
                retryable: true,
                summary: "The item changed after review.",
              },
            ],
            processed: 2,
            run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
            skip_reasons: { skipped_changed_since_review: 2 },
            skipped: 2,
            status: "needs_attention",
            target_repo: "openclaw/openclaw",
            updated_at: "2026-07-05T11:22:03.748Z",
          },
        ],
      },
      automerge: [],
      automerge_reliability: {
        sampled_runs: 3,
        completed_attempts: 3,
        failed_attempts: 2,
        failure_rate_percent: 66.7,
        active_attempts: 0,
        stalled_attempts: 0,
        average_duration_ms: 600_000,
        longest_duration_ms: 1_200_000,
        unresolved_failures: 1,
        recovered_failures: 1,
        failures: [
          {
            repository: "openclaw/openclaw",
            number: 107691,
            item_url: "https://github.com/openclaw/openclaw/pull/107691",
            run_url: "https://github.com/openclaw/clawsweeper/actions/runs/29431617465",
            status: "unresolved",
            conclusion: "failure",
            started_at: "2026-07-05T10:50:00Z",
            completed_at: "2026-07-05T11:10:00Z",
            duration_ms: 1_200_000,
            recovered: false,
          },
        ],
      },
      closed_items: [],
      closed_stats: { issues: 0, prs: 0, total: 0, window_hours: 24 },
      cluster_repair: null,
      events: [],
      operation_counts: {},
    },
  };

  const context = createContext({
    console,
    document: {
      addEventListener: () => undefined,
      body: { classList: { add: () => undefined, remove: () => undefined } },
      documentElement: { dataset: {} },
      getElementById: elementFor,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    fetch: async () => ({
      headers: { get: () => "fresh" },
      json: async () => status,
      ok: true,
      status: 200,
    }),
    history: { replaceState: () => undefined },
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    location: { hash: "", pathname: "/", search: "" },
    navigator: { clipboard: { writeText: async () => undefined } },
    setInterval: () => 1,
    setTimeout: () => 1,
    window: { addEventListener: () => undefined },
  });
  new Script(script).runInContext(context);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(elementFor("hero-dot").className, "hero-dot amber");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("apply-health").innerHTML, /Pruning sweep blocked/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /Dispatching/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /2 of 28 exact-review slots open/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /health-badge healthy/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /pressure congested/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /4 total · 3 ready · 2 admissible/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /Review admission/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /52 review admission slots open/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /Result publication/);
  assert.match(elementFor("exact-review-lanes").innerHTML, /3 result publication slots open/);
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /<div class="exact-lane-head"><strong>State writer<\/strong><span>Unavailable<\/span><\/div>/,
  );
  context.renderStateWriter({
    lanes: {
      publication: {
        batches: { enabled: true, max_items: 2 },
        active: 0,
        leased: 0,
        dispatching: 0,
        flow: {
          last_15_minutes: {
            resolved: 16,
            published: 0,
            superseded: 16,
            retried: 0,
            dead_lettered: 0,
          },
        },
      },
    },
    state_writer: {
      collection: { status: "stale", last_observed_at: "2026-07-21T12:12:42.397Z" },
      coordinator: {
        queued: 0,
        leased: 0,
        admitted: 16,
        completed: 16,
        expired: 0,
        recovered: 0,
        last_wait_ms: 0,
        max_wait_ms: 300_309,
      },
      global_lease: { status: "free" },
      last_60_minutes: {
        materialized_items: 0,
        state_commits: 0,
        items_per_commit: null,
        wait_ms: { p50: null, p95: null, samples: 0 },
        hold_ms: { p50: null, p95: null, samples: 0 },
      },
      live: { freshness_seconds: null, tracked_holding: 0, tracked_waiting: 0 },
      mode: "unknown",
    },
  });
  const stateWriterHtml = elementFor("state-writer-health").innerHTML;
  assert.match(stateWriterHtml, /class="exact-lane-head"/);
  assert.match(stateWriterHtml, /Batch · configured 2 · coordinator live · 6h/);
  assert.match(
    stateWriterHtml,
    /Serialization queue<\/span><strong>0 active · 0 queued · 1 writer max/,
  );
  assert.doesNotMatch(stateWriterHtml, /Git crash fence/);
  assert.match(stateWriterHtml, /Coordinator turns<\/dt><dd>16 completed · 16 admitted/);
  assert.match(stateWriterHtml, /Coordinator wait<\/dt><dd>last 0s · max 5m/);
  assert.match(stateWriterHtml, /Queue history<\/dt><dd>collecting samples/);
  assert.match(
    stateWriterHtml,
    /Terminal telemetry<\/dt><dd>idle · no exact-review materialization required in the last 15m/,
  );
  assert.doesNotMatch(stateWriterHtml, /terminal telemetry stale/);
  assert.doesNotMatch(stateWriterHtml, /Exact-review materialized/);

  context.renderStateWriter({
    lanes: {
      publication: {
        batches: { enabled: true, max_items: 2, leased: 1 },
        active: 0,
        leased: 0,
        dispatching: 0,
        flow: {
          last_15_minutes: {
            resolved: 16,
            published: 0,
            superseded: 16,
            retried: 0,
            dead_lettered: 0,
          },
        },
      },
    },
    state_writer: {
      collection: { status: "stale", last_observed_at: "2026-07-21T12:12:42.397Z" },
      coordinator: {
        queued: 2,
        leased: 1,
        admitted: 16,
        completed: 16,
        expired: 0,
        recovered: 0,
        last_wait_ms: 0,
        max_wait_ms: 300_309,
      },
      global_lease: { status: "free" },
      last_60_minutes: { materialized_items: 0, state_commits: 0 },
      mode: "batch",
    },
  });
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Terminal telemetry<\/dt><dd>awaiting exact-review writer result/,
  );
  assert.doesNotMatch(elementFor("state-writer-health").innerHTML, /terminal telemetry stale/);

  context.renderStateWriter({
    lanes: {
      publication: {
        batches: { enabled: true, max_items: 2 },
        flow: {
          last_15_minutes: {
            resolved: 1,
            published: 1,
            superseded: 0,
            retried: 0,
            dead_lettered: 0,
          },
        },
      },
    },
    state_writer: {
      collection: { status: "stale", last_observed_at: "2026-07-21T12:12:42.397Z" },
      coordinator: {
        queued: 0,
        leased: 0,
        admitted: 16,
        completed: 16,
        expired: 0,
        recovered: 0,
        last_wait_ms: 0,
        max_wait_ms: 300_309,
      },
      global_lease: { status: "free" },
      last_60_minutes: { materialized_items: 0, state_commits: 0 },
      mode: "batch",
    },
  });
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Terminal telemetry<\/dt><dd>terminal telemetry stale/,
  );

  const coordinatorSamples = [
    {
      at: new Date(Date.now() - 15 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: null,
        tracked_waiting: "",
      },
    },
    {
      at: new Date(Date.now() - 10 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 5,
        accepted_operations_total: 16,
        state_commits_total: 8,
        materialized_items_total: 16,
      },
    },
    {
      at: new Date(Date.now() - 5 * 60_000).toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 2,
      },
    },
    {
      at: new Date().toISOString(),
      state_writer: {
        collection_ok: true,
        terminal_collection_ok: false,
        tracked_holding: 1,
        tracked_waiting: 4,
      },
    },
  ];
  context.fetch = async () => ({
    ok: true,
    json: async () => ({ samples: coordinatorSamples }),
  });
  await context.loadHealthHistory("6h", true);
  context.renderStateWriter({
    lanes: { publication: { batches: { enabled: true, max_items: 2 } } },
    state_writer: {
      collection: { status: "stale" },
      coordinator: { queued: 0, leased: 0, admitted: 16, completed: 16 },
      global_lease: { status: "free" },
      last_60_minutes: { materialized_items: 0, state_commits: 0 },
      mode: "batch",
    },
  });
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Queue history<\/dt><dd>3 samples · 2–5 queued/,
  );
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Latest queue sample<\/dt><dd>1 active · 4 queued ·/,
  );
  assert.match(
    elementFor("state-writer-health").innerHTML,
    /Serialized writer queue depth over 6h/,
  );
  assert.doesNotMatch(elementFor("state-writer-health").innerHTML, /Exact-review materialized/);
  assert.match(stateWriterHtml, /class="lane-metrics"/);
  assert.doesNotMatch(stateWriterHtml, /<section class="exact-lane">/);
  const initialLaneHtml = elementFor("exact-review-lanes").innerHTML;
  assert.match(
    initialLaneHtml,
    /<details class="lane-flow"><summary><span class="lane-flow-title">Review throughput · last 15 minutes/,
  );
  assert.match(
    initialLaneHtml,
    /<details class="lane-flow"><summary><span class="lane-flow-title">Publication throughput · last 15 minutes/,
  );
  assert.match(
    initialLaneHtml,
    /15m hourly-equivalent rates respond faster to recent changes but are more burst-sensitive than the up-to-60m net rate above\./,
  );
  assert.equal(initialLaneHtml.match(/class="lane-flow"/g)?.length, 2);
  assert.equal(initialLaneHtml.match(/class="lane-flow-foot"/g)?.length, 2);
  assert.doesNotMatch(initialLaneHtml, /<details class="lane-flow" open>/);
  const flowBlocks = [
    ...initialLaneHtml.matchAll(/<details class="lane-flow">([\s\S]*?)<\/details>/g),
  ];
  assert.equal(flowBlocks.length, 2);
  assert.deepEqual(
    flowBlocks.map((match) => match[1].match(/class="lane-count"/g)?.length),
    [4, 4],
  );
  assert.match(initialLaneHtml, /Successful<\/span><strong>20\/h/);
  assert.match(initialLaneHtml, /Shed<\/span><strong>0\/h/);
  assert.match(initialLaneHtml, /Published<\/span><strong>4\/h/);
  assert.match(initialLaneHtml, /Superseded<\/span><strong>16\/h/);
  assert.doesNotMatch(initialLaneHtml, /Terminal resolved/);
  assert.doesNotMatch(initialLaneHtml, /Dead-lettered/);
  assert.match(initialLaneHtml, /DLQ 2/);
  assert.match(initialLaneHtml, /Retry amplification<\/span><strong>0\.20/);
  assert.match(initialLaneHtml, /Retry amplification<\/span><strong>0\.40/);
  assert.match(elementFor("worker-health").innerHTML, /Automerge worker operations/);
  assert.match(elementFor("worker-health").innerHTML, /Active \/ stalled<\/span><strong>0 \/ 0/);
  assert.match(elementFor("worker-health").innerHTML, /Failed attempts<\/span><strong>2/);
  assert.match(
    elementFor("worker-health").innerHTML,
    /Recovered \/ unresolved<\/span><strong>1 \/ 1/,
  );
  assert.match(elementFor("worker-health").innerHTML, /avg runtime 10m/);
  assert.match(elementFor("worker-health").innerHTML, /openclaw\/openclaw#107691/);
  assert.match(elementFor("worker-health").innerHTML, /actions\/runs\/29431617465/);
  assert.match(elementFor("worker-health").innerHTML, /unresolved/);
  assert.match(
    elementFor("exact-review-lanes").innerHTML,
    /target 32 · pressure ceiling 24 after GitHub rate limit/,
  );
  assert.match(elementFor("exact-review-lanes").innerHTML, /No backlog history in this range/);
  status.workers = [
    ...Array.from({ length: 128 }, (_, id) => ({
      id,
      status: "in_progress",
      is_codex_worker: true,
    })),
    { id: 128, status: "in_progress", is_codex_worker: false },
    { id: 129, status: "in_progress", is_codex_worker: false },
  ];
  context.renderSystemMap(status);
  assert.match(elementFor("capacity-rail").innerHTML, /128 running/);
  assert.doesNotMatch(elementFor("capacity-rail").innerHTML, /over budget/);
  status.workers = [{ id: 130, status: "in_progress", is_codex_worker: false }];
  context.renderDashboard(status, "");
  assert.match(elementFor("hero-headline").textContent, /0 claw workers sweeping/);
  status.workers = [];

  status.recent.apply_health.items = [];
  status.exact_review_queue.handoff_health.status = "stalled";
  status.exact_review_queue.pressure.status = "saturated";
  status.exact_review_queue.pressure.reason = "capacity_full_with_backlog";
  status.exact_review_queue.handoff_health.message =
    "A dispatched review has not been claimed within the expected handoff window.";
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot red");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /health-badge stalled/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /pressure saturated/);

  Object.assign(status, { exact_review_queue: null });
  status.diagnostics.exact_review_queue_error = "exact-review queue timed out";
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot amber");
  assert.match(elementFor("hero-headline").textContent, /^Needs attention/);
  assert.match(elementFor("exact-review-handoff").innerHTML, /telemetry unavailable/);

  const healthyOperational = {
    status: "healthy",
    telemetry_complete: true,
    queued_runs: 0,
    queued_over_threshold: 0,
    oldest_queued_minutes: 0,
    running_runs: 0,
    running_over_threshold: 0,
    oldest_running_minutes: 0,
  };
  context.renderExecutionAlert(healthyOperational);
  assert.equal(elementFor("execution-alert").innerHTML, "");
  context.renderExecutionAlert({ ...healthyOperational, queued_runs: 2, queued_over_threshold: 2 });
  assert.match(
    elementFor("execution-alert").innerHTML,
    /2 workflows waiting for a runner over 30m/,
  );
  context.renderExecutionAlert({
    ...healthyOperational,
    queued_runs: 2,
    queued_over_threshold: 2,
    approval_gated_runs: 1,
    oldest_approval_gated_minutes: 7 * 24 * 60,
  });
  assert.match(
    elementFor("execution-alert").innerHTML,
    /1 awaiting deployment approval \(oldest 168h\)/,
  );
  context.renderExecutionAlert({
    ...healthyOperational,
    running_runs: 1,
    running_over_threshold: 1,
  });
  assert.match(elementFor("execution-alert").innerHTML, /1 execution over 150m/);
  context.renderExecutionAlert({ ...healthyOperational, telemetry_complete: false });
  assert.match(elementFor("execution-alert").innerHTML, /telemetry is incomplete/);

  status.diagnostics.exact_review_queue_error = null;
  status.exact_review_queue = { handoff_health: { status: "healthy", phases: {} } };
  status.operational_health = {
    status: "stalled",
    checked_at: "2026-07-05T11:22:43.934Z",
    telemetry_complete: true,
    queued_runs: 10,
    queued_over_threshold: 4,
    oldest_queued_minutes: 90,
    running_runs: 2,
    running_over_threshold: 1,
    oldest_running_minutes: 180,
  };
  context.renderDashboard(status, "");

  assert.equal(elementFor("hero-dot").className, "hero-dot red");
  assert.doesNotMatch(elementFor("metrics").innerHTML, /over 30m|over 150m/);
  assert.match(
    elementFor("execution-alert").innerHTML,
    /4 workflows waiting for a runner over 30m/,
  );
  assert.match(elementFor("execution-alert").innerHTML, /1 execution over 150m/);
  assert.match(elementFor("execution-alert").innerHTML, /Total GitHub queued 10/);
  assert.match(elementFor("execution-alert").innerHTML, /oldest running 3h/);

  const scale = context.niceTrendScale(95, 4);
  assert.equal(scale.maximum, 100);
  assert.deepEqual([...scale.ticks], [0, 25, 50, 75, 100]);

  let resolve24HourHistory: ((response: unknown) => void) | undefined;
  const now = Date.now();
  const samples = Array.from({ length: 25 }, (_, index) => ({
    at: new Date(now - (24 - index) * 5 * 60_000).toISOString(),
    collection_ok: true,
    exact_review: {
      collection_ok: true,
      review: {
        pending: 100 + index,
        enqueued_total: index * 8,
        completed_total: index * 5,
        shed_total: 0,
      },
      publication: {
        pending: 200 - index,
        enqueued_total: index * 4,
        completed_total: index * 10,
      },
    },
  }));
  context.fetch = async (input: string) => {
    if (input.includes("range=24h")) {
      return new Promise((resolve) => {
        resolve24HourHistory = resolve;
      });
    }
    return {
      ok: true,
      json: async () => ({ samples }),
    };
  };
  const stale24HourRequest = context.loadHealthHistory("24h", true);
  const active7DayRequest = context.loadHealthHistory("7d", true);
  await active7DayRequest;
  resolve24HourHistory?.({ ok: true, json: async () => ({ samples: [] }) });
  await stale24HourRequest;
  const laneHtml = elementFor("exact-review-lanes").innerHTML;
  assert.match(laneHtml, /Growing · \+12 in the last hour/);
  assert.match(laneHtml, /Draining · −12 in the last hour/);
  assert.match(laneHtml, /Net review rate/);
  assert.match(laneHtml, /Net publication rate/);
  assert.match(laneHtml, /Net review rate.*<\/div><strong>−36 \/ hour/);
  assert.match(laneHtml, /Net publication rate.*<\/div><strong>\+72 \/ hour/);
  assert.equal(laneHtml.match(/class="lane-rate-help"/g)?.length, 2);
  assert.equal(laneHtml.match(/role="tooltip"/g)?.length, 2);
  assert.match(laneHtml, /aria-describedby="lane-rate-help-net-review-rate"/);
  assert.match(laneHtml, /aria-describedby="lane-rate-help-net-publication-rate"/);
  assert.match(
    laneHtml,
    /Successful completions minus incoming review demand per hour\. Incoming includes newly queued work and shed demand\./,
  );
  assert.match(laneHtml, /Successful completions minus newly queued publication work per hour\./);
  assert.match(laneHtml, /Falling behind/);
  assert.match(laneHtml, /Catching up/);
  assert.equal(laneHtml.match(/class="lane-speed"/g)?.length, 2);
  assert.doesNotMatch(laneHtml, /Processed \/ hour|Incoming \/ hour/);
  assert.match(
    laneHtml,
    /role="img" aria-label="Net review rate, completed minus incoming, over 7d"/,
  );
  assert.match(
    laneHtml,
    /role="img" aria-label="Net publication rate, completed minus incoming, over 7d"/,
  );
  assert.match(laneHtml, /role="img" aria-label="Review admission pending backlog over 7d"/);
  assert.match(laneHtml, /Live snapshot unavailable/);
  assert.match(laneHtml, /Last sampled/);

  const smallAxis = context.exactReviewTrend(
    [{ at: new Date(now).toISOString(), pending: 8 }],
    "Small lane",
  );
  const largeAxis = context.exactReviewTrend(
    [{ at: new Date(now).toISOString(), pending: 1500 }],
    "Large lane",
  );
  assert.match(smallAxis, />8<\/text>/);
  assert.match(largeAxis, />2,000<\/text>/);
  const flowSample = (
    minutesAgo: number,
    enqueuedTotal: number,
    completedTotal: number,
    shedTotal = 0,
  ) => ({
    at: new Date(now - minutesAgo * 60_000).toISOString(),
    enqueuedTotal,
    completedTotal,
    shedTotal,
  });
  const provisionalSamples = [flowSample(5, 10, 20), flowSample(0, 12, 25)];
  const provisionalRates = context.laneSpeedHistory(provisionalSamples);
  assert.equal(provisionalRates.length, 1);
  assert.equal(Math.round(provisionalRates[0].rate), 36);
  assert.equal(provisionalRates[0].provisional, true);
  assert.equal(Math.round(provisionalRates[0].windowMinutes), 5);
  const provisionalSpeed = context.laneSpeedTrend(provisionalSamples, "Net review rate");
  assert.match(provisionalSpeed, /Net review rate<\/span><\/div><strong>\+36 \/ hour/);
  assert.match(provisionalSpeed, /Catching up · provisional 5m window/);

  const balancedSamples = [flowSample(5, 10, 20), flowSample(0, 10, 20)];
  const balancedSpeed = context.laneSpeedTrend(balancedSamples, "Net review rate");
  assert.match(balancedSpeed, /Net review rate<\/span><\/div><strong>0 \/ hour/);
  assert.match(balancedSpeed, /Balanced · provisional 5m window/);
  assert.doesNotMatch(balancedSpeed, /Collecting/);

  const shedRates = context.laneSpeedHistory([flowSample(5, 10, 20, 2), flowSample(0, 10, 20, 3)]);
  assert.equal(Math.round(shedRates[0].rate), -12);

  const matureRates = context.laneSpeedHistory(
    Array.from({ length: 13 }, (_, index) => flowSample((12 - index) * 5, index * 3, index * 5)),
  );
  assert.equal(Math.round(matureRates.at(-1).rate), 24);
  assert.equal(matureRates.at(-1).provisional, false);
  assert.equal(Math.round(matureRates.at(-1).windowMinutes), 60);

  const gapRates = context.laneSpeedHistory([
    flowSample(40, 0, 0),
    flowSample(35, 1, 2),
    flowSample(10, 2, 4),
    flowSample(5, 3, 6),
  ]);
  assert.equal(gapRates.length, 2);
  assert.notEqual(gapRates[0].segmentId, gapRates[1].segmentId);

  const resetRates = context.laneSpeedHistory([
    flowSample(20, 10, 10),
    flowSample(15, 11, 12),
    flowSample(10, 1, 1),
    flowSample(5, 2, 3),
  ]);
  assert.equal(resetRates.length, 2);
  assert.notEqual(resetRates[0].segmentId, resetRates[1].segmentId);
  const resetCollecting = context.laneSpeedTrend(
    [flowSample(10, 10, 10), flowSample(5, 11, 12), flowSample(0, 1, 1)],
    "Net review rate",
  );
  assert.match(resetCollecting, /Net review rate<\/span><\/div><strong>Collecting/);
  assert.match(resetCollecting, /Needs two continuous five-minute samples/);

  const legacyBreakRates = context.laneSpeedHistory([
    flowSample(25, 10, 10),
    flowSample(20, 11, 12),
    { at: new Date(now - 15 * 60_000).toISOString(), pending: 1 },
    flowSample(10, 12, 14),
    flowSample(5, 13, 16),
  ]);
  assert.equal(legacyBreakRates.length, 2);
  assert.notEqual(legacyBreakRates[0].segmentId, legacyBreakRates[1].segmentId);
  const speedGeometry = context.speedTrendGeometry(
    legacyBreakRates,
    { left: 0, top: 0, width: 100, height: 100 },
    20,
    now - 30 * 60_000,
    now,
  );
  assert.equal(speedGeometry[1].connected, false);
  assert.match(context.trendPath(speedGeometry), /^M.* M/);

  const staleSpeed = context.laneSpeedTrend(
    [flowSample(25, 0, 0), flowSample(20, 1, 2)],
    "Net publication rate",
  );
  assert.match(staleSpeed, /Net publication rate<\/span><\/div><strong>Stale/);
  assert.match(staleSpeed, /Stale · no rate sample in the last 12m/);
  const collectingSpeed = context.laneSpeedTrend([flowSample(0, 0, 0)], "Net review rate");
  assert.match(collectingSpeed, /Net review rate<\/span><\/div><strong>Collecting/);
  assert.match(collectingSpeed, /Needs two continuous five-minute samples/);

  assert.equal(
    context.oneHourTrend(samples.slice(0, 1).map((sample) => ({ at: sample.at, pending: 4 })))
      .label,
    "Collecting 1h trend",
  );
  assert.equal(
    context.oneHourTrend(samples.map((sample) => ({ at: sample.at, pending: 9 }))).label,
    "Stable · no change in the last hour",
  );
  const broken = context.trendGeometry(
    [
      { at: new Date(now - 30 * 60_000).toISOString(), pending: 1 },
      { at: new Date(now - 10 * 60_000).toISOString(), pending: 2 },
    ],
    "pending",
    { left: 0, top: 0, width: 100, height: 100 },
    2,
    now - 60 * 60_000,
    now,
  );
  assert.equal(broken[1].connected, false);
  assert.match(context.trendPath(broken), /^M.* M/);
});

test("dashboard HTML emits early persistent theme controls", async () => {
  for (const path of ["/", "/triage", "/pr-proof-triage"]) {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai" + path));
    const html = await response.text();
    const themeInit = html.indexOf('const themeKey = "clawsweeper-theme";');
    const styles = html.indexOf("<style>");

    assert.notEqual(themeInit, -1, path + " should initialize theme preference");
    assert.notEqual(styles, -1, path + " should include CSS");
    assert.ok(themeInit < styles, path + " should apply saved theme before styles");
    assert.match(html, /:root\[data-theme="light"\] \{ color-scheme: light; \}/);
    assert.match(html, /:root\[data-theme="dark"\] \{ color-scheme: dark; \}/);
    assert.match(html, /data-theme-choice="system"/);
    assert.match(html, /data-theme-choice="light"/);
    assert.match(html, /data-theme-choice="dark"/);
    assert.match(html, /window\.localStorage\?\.setItem\(themeKey, choice\)/);
    assert.match(html, /typeof themeQuery\?\.addEventListener === "function"/);
    assert.match(html, /themeQuery\.addEventListener\("change", updateSystemTheme\)/);
    assert.match(html, /themeQuery\?\.addListener\?\.\(updateSystemTheme\)/);
    assert.match(html, /setAttribute\("aria-pressed", selected \? "true" : "false"\)/);
  }
});

test("dashboard groups automatic issue lifecycle events with active workers", () => {
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_queued",
        repository: "steipete/example",
        source_item_number: 42,
        source_item_url: "https://github.com/steipete/example/issues/42",
        title: "Add compact export mode",
        stage: "queued",
        status: "queued",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        work_kind: "issue_to_pr",
        automatic: true,
        received_at: "2026-06-14T10:00:00Z",
      },
      {
        event_type: "clawsweeper.generated_pr_opened",
        repository: "steipete/example",
        source_item_number: 42,
        source_item_url: "https://github.com/steipete/example/issues/42",
        item_url: "https://github.com/steipete/example/pull/51",
        pr_url: "https://github.com/steipete/example/pull/51",
        title: "Add compact export mode",
        stage: "pr_opened",
        status: "completed",
        work_kind: "issue_to_pr",
        automatic: null,
        received_at: "2026-06-14T10:10:00Z",
      },
    ],
    [
      {
        id: 7001,
        repository: "steipete/example",
        item_number: 42,
        work_kind: "issue_to_pr",
        name: "Implement issue",
        status: "in_progress",
        current_step: "Run Codex",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/100",
        updated_at: "2026-06-14T10:05:00Z",
        target_items: [
          {
            number: 42,
            title: "Add compact export mode",
            url: "https://github.com/steipete/example/issues/42",
          },
        ],
      },
    ],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "steipete/example#42");
  assert.equal(rows[0].title, "Add compact export mode");
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].worker_id, "7001");
  assert.equal(rows[0].pr_url, "https://github.com/steipete/example/pull/51");
  assert.equal(rows[0].timeline.length, 3);
});

test("dashboard correlates issue implementation workers by run URL", () => {
  const workers = [
    {
      id: 7002,
      repository: null,
      item_number: null,
      item_numbers: [],
      work_kind: "issue_to_pr",
      name: "Execute and apply cluster actions",
      status: "in_progress",
      current_step: "Execute credited fix artifact",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/101",
      updated_at: "2026-06-14T10:05:00Z",
      target_items: [],
    },
  ];
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_started",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        title: "Install sudo when missing",
        stage: "building",
        status: "running",
        run_url: "https://github.com/openclaw/clawsweeper/actions/runs/101",
        work_kind: "issue_to_pr",
        automatic: true,
        received_at: "2026-06-14T10:04:00Z",
      },
    ],
    workers,
  );

  assert.equal(rows[0].active, true);
  assert.equal(rows[0].worker_id, "7002");
  assert.equal(workers[0].repository, "openclaw/openclaw-ansible");
  assert.equal(workers[0].item_number, 20);
  assert.equal(workers[0].target_items[0].title, "Install sudo when missing");
});

test("dashboard preserves issue titles across generated PR repair events", () => {
  const rows = automaticIssueWork(
    [
      {
        event_type: "clawsweeper.issue_build_started",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        title: "installation fails due to not sudo installed",
        stage: "building",
        status: "running",
        automatic: true,
        received_at: "2026-06-14T10:00:00Z",
      },
      {
        event_type: "clawsweeper.contributor_branch_repaired",
        repository: "openclaw/openclaw-ansible",
        source_item_number: 20,
        source_item_url: "https://github.com/openclaw/openclaw-ansible/issues/20",
        item_url: "https://github.com/openclaw/openclaw-ansible/pull/49",
        pr_url: "https://github.com/openclaw/openclaw-ansible/pull/49",
        title: "openclaw/openclaw-ansible#49",
        stage: "repair_contributor_branch",
        status: "pushed",
        received_at: "2026-06-14T10:10:00Z",
      },
    ],
    [],
  );

  assert.equal(rows[0].title, "installation fails due to not sudo installed");
  assert.equal(rows[0].pr_url, "https://github.com/openclaw/openclaw-ansible/pull/49");
});

test("dashboard exposes active worker jobs and their current steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: cache,
    },
  });
  const run = {
    id: 42,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92521",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    created_at: isoAgo(120_000),
    updated_at: isoAgo(10_000),
  };
  const queuedRun = {
    id: 43,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#92523",
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/43",
    created_at: isoAgo(30_000),
    updated_at: isoAgo(5_000),
  };
  const queuedBatchRun = {
    id: 44,
    name: "Publish exact review batch",
    display_title: "Publish exact review batch",
    status: "queued",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/44",
    created_at: isoAgo(20_000),
    updated_at: isoAgo(2_000),
  };
  let graphqlRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status
          ? [run, queuedRun, queuedBatchRun]
          : status === "in_progress"
            ? [run]
            : status === "queued"
              ? [queuedRun, queuedBatchRun]
              : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/42/jobs") {
      return jsonResponse({
        jobs: [
          {
            id: 4201,
            name: "Review shard 0 · openclaw/openclaw#92521,92522",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4201",
            started_at: isoAgo(90_000),
            steps: [
              {
                number: 1,
                name: "Set up job",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 3,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
          {
            id: 4202,
            name: "Publish review artifacts",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4202",
            started_at: isoAgo(60_000),
            steps: [
              {
                number: 1,
                name: "Apply review artifacts",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Publish review artifact action ledger",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
          {
            id: 4203,
            name: "publish",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42/job/4203",
            started_at: isoAgo(55_000),
            steps: [
              {
                number: 1,
                name: "Claim one durable publication batch",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Finalize healthy members under a fenced heartbeat",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/43/jobs") {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/44/jobs") {
      return jsonResponse({
        jobs: [
          {
            id: 4401,
            name: "publish",
            status: "queued",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/44/job/4401",
            started_at: null,
            steps: [],
          },
        ],
      });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            target0: {
              __typename: "Issue",
              title: "Preserve terminal resize state",
              url: "https://github.com/openclaw/openclaw/issues/92521",
            },
            target1: {
              __typename: "PullRequest",
              title: "Repair terminal resize state",
              url: "https://github.com/openclaw/openclaw/pull/92522",
            },
            target2: {
              __typename: "Issue",
              title: "Queued terminal resize follow-up",
              url: "https://github.com/openclaw/openclaw/issues/92523",
            },
          },
        },
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 2);
    assert.equal(status.fleet.worker_detail_runs, 3);
    assert.equal(status.fleet.worker_detail_fallbacks, 1);
    assert.equal(status.workers.length, 5);
    assert.equal(status.workers[0].id, 4201);
    assert.equal(status.workers[0].name, "Review shard 0 · openclaw/openclaw#92521,92522");
    assert.equal(status.workers[0].repository, "openclaw/openclaw");
    assert.equal(status.workers[0].item_number, null);
    assert.deepEqual(status.workers[0].item_numbers, [92521, 92522]);
    assert.equal(status.workers[0].current_step, "Review shard");
    assert.deepEqual(status.workers[0].progress, { completed: 2, total: 3 });
    assert.equal(status.workers[0].steps[2].status, "in_progress");
    assert.deepEqual(status.workers[0].target_items, [
      {
        repository: "openclaw/openclaw",
        number: 92521,
        title: "Preserve terminal resize state",
        url: "https://github.com/openclaw/openclaw/issues/92521",
        type: "issue",
      },
      {
        repository: "openclaw/openclaw",
        number: 92522,
        title: "Repair terminal resize state",
        url: "https://github.com/openclaw/openclaw/pull/92522",
        type: "pull_request",
      },
    ]);
    assert.equal(status.workers[1].id, 4202);
    assert.equal(status.workers[1].name, "Publish review artifacts");
    assert.equal(status.workers[1].is_codex_worker, false);
    assert.equal(status.workers[1].item_number, 92521);
    assert.equal(status.workers[1].current_step, "Publish review artifact action ledger");
    assert.equal(status.workers[1].steps[0].name, "Apply review artifacts");
    assert.equal(status.workers[2].id, 4203);
    assert.equal(status.workers[2].name, "publish");
    assert.equal(status.workers[2].is_codex_worker, false);
    assert.equal(
      status.workers[2].current_step,
      "Finalize healthy members under a fenced heartbeat",
    );
    const cachedPublisherJobs = await cache.match(
      new Request("https://clawsweeper.internal/store/workflow-jobs%3Aopenclaw%2Fclawsweeper%3A42"),
    );
    assert.equal(cachedPublisherJobs?.headers.get("cache-control"), "public, max-age=60");
    assert.equal(status.workers[3].id, "run-43");
    assert.equal(status.workers[3].source, "workflow-fallback");
    assert.equal(status.workers[3].current_step, "reviewing");
    assert.equal(status.workers[3].target_items[0].title, "Queued terminal resize follow-up");
    const queuedBatchPublisher = status.workers.find((entry) => entry.id === 4401);
    assert.ok(queuedBatchPublisher);
    assert.equal(queuedBatchPublisher.name, "publish");
    assert.equal(queuedBatchPublisher.is_codex_worker, false);
    assert.equal(queuedBatchPublisher.workflow_title, "Publish exact review batch");
    assert.equal(queuedBatchPublisher.current_step, "Waiting for runner");

    const cachedResponse = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const cachedStatus = await cachedResponse.json();
    assert.equal(cachedStatus.workers[0].target_items[0].title, "Preserve terminal resize state");
    assert.equal(graphqlRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps control-plane workflow fallbacks out of Codex capacity", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: new MemoryCache() },
  });
  const runs = [
    [1, "ClawSweeper", "Review event item openclaw/openclaw#1", "in_progress"],
    [2, "repair cluster worker", "repair cluster jobs/openclaw/inbox/cluster-2.md", "queued"],
    [3, "Assist", "Assist openclaw/openclaw#3", "in_progress"],
    [4, "ClawSweeper", "Review event item openclaw/openclaw#4@publish:40:1", "in_progress"],
    [5, "repair comment router", "clawsweeper_comment", "queued"],
    [6, "Reconcile exact-review leases", "Reconcile exact-review leases", "in_progress"],
    [7, "ClawSweeper", "Sync Codex review comments for openclaw/openclaw", "queued"],
  ].map(([id, name, displayTitle, status]) => ({
    id,
    name,
    display_title: displayTitle,
    status,
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
    created_at: isoAgo(Number(id) * 1_000),
    updated_at: isoAgo(500),
  }));
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status ? runs : runs.filter((run) => run.status === status),
      });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 3);
    assert.equal(status.fleet.worker_detail_fallbacks, 3);
    assert.deepEqual(status.workers.map((entry: { id: string }) => entry.id).sort(), [
      "run-1",
      "run-2",
      "run-3",
    ]);
    assert.deepEqual(status.control_plane, {
      publishers: { running: 1, waiting: 0 },
      comment_routers: { running: 0, waiting: 2 },
      reconcilers: { running: 1, waiting: 0 },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard bounds worker job detail request concurrency", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = Array.from({ length: 12 }, (_, index) => ({
    id: 1000 + index,
    name: "Review ClawSweeper items",
    display_title: `Review event item openclaw/openclaw#${9000 + index}`,
    status: "in_progress",
    conclusion: null,
    html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${1000 + index}`,
    created_at: isoAgo((index + 1) * 1000),
    updated_at: isoAgo(1000),
  }));
  let activeJobRequests = 0;
  let maxActiveJobRequests = 0;
  let pipelineRequestsWhileJobsActive = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      const runId = Number(url.pathname.split("/").at(-2));
      activeJobRequests += 1;
      maxActiveJobRequests = Math.max(maxActiveJobRequests, activeJobRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeJobRequests -= 1;
      return jsonResponse({
        jobs: [
          {
            id: runId * 10,
            name: `Review shard ${runId}`,
            status: "in_progress",
            conclusion: null,
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: isoAgo(1000),
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
              },
              {
                number: 2,
                name: "Review shard",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/pulls\/\d+$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ head: { sha: `head-${url.pathname.split("/").at(-1)}` } });
    }
    if (/^\/repos\/openclaw\/openclaw\/commits\/head-\d+\/check-runs$/.test(url.pathname)) {
      if (activeJobRequests) pipelineRequestsWhileJobsActive += 1;
      return jsonResponse({ check_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        WORKER_DETAIL_RUN_LIMIT: "12",
        WORKER_JOB_FETCH_CONCURRENCY: "3",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.workers.length, 12);
    assert.equal(status.fleet.active_codex_jobs, 12);
    assert.equal(maxActiveJobRequests, 3);
    assert.equal(pipelineRequestsWhileJobsActive, 0);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard paginates worker jobs beyond GitHub's first page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const run = {
    id: 500,
    name: "Review ClawSweeper items",
    display_title: "Review event item openclaw/openclaw#500",
    status: "in_progress",
    conclusion: null,
    html_url: "https://github.com/openclaw/clawsweeper/actions/runs/500",
    created_at: isoAgo(60_000),
    updated_at: isoAgo(5_000),
  };
  const requestedPages = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({
        workflow_runs: !status || status === "in_progress" ? [run] : [],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/500/jobs") {
      const page = Number(url.searchParams.get("page") || "1");
      requestedPages.push(page);
      const count = page === 1 ? 100 : 28;
      const offset = page === 1 ? 0 : 100;
      return jsonResponse({
        total_count: 128,
        jobs: Array.from({ length: count }, (_, index) => ({
          id: 500_000 + offset + index,
          name: `Review shard ${offset + index}`,
          status: "in_progress",
          conclusion: null,
          html_url: `https://github.com/openclaw/clawsweeper/actions/runs/500/job/${
            500_000 + offset + index
          }`,
          started_at: isoAgo(30_000),
          steps: [
            {
              number: 1,
              name: "Run ./clawsweeper/.github/actions/setup-codex",
              status: "completed",
              conclusion: "success",
            },
            {
              number: 2,
              name: "Review shard",
              status: "in_progress",
              conclusion: null,
            },
          ],
        })),
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_codex_jobs, 128);
    assert.equal(status.workers.length, 128);
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reports worker error and recovery rates from completed job steps", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    completedReviewRun(4, 300, "success", 60_000),
    completedReviewRun(3, 200, "success", 120_000),
    completedReviewRun(2, 100, "success", 180_000),
    completedReviewRun(1, 100, "success", 240_000),
  ];
  let jobRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({
        workflow_runs:
          url.searchParams.get("status") === "completed"
            ? runs
            : url.searchParams.has("status")
              ? []
              : runs,
      });
    }
    const jobMatch = url.pathname.match(
      /^\/repos\/openclaw\/clawsweeper\/actions\/runs\/(\d+)\/jobs$/,
    );
    if (jobMatch) {
      jobRequests += 1;
      const runId = Number(jobMatch[1]);
      const itemNumber = runId === 1 || runId === 2 ? 100 : runId === 3 ? 200 : 300;
      const failed = runId === 1 || runId === 3;
      const run = runs.find((candidate) => candidate.id === runId);
      const runStartedAt = Date.parse(run?.created_at || "");
      const jobStartedAt = new Date(runStartedAt + 1_000).toISOString();
      const reviewStartedAt = new Date(runStartedAt + 3_000).toISOString();
      return jsonResponse({
        jobs: [
          {
            id: runId * 10,
            name: `Review shard 0 · openclaw/openclaw#${itemNumber}`,
            status: "completed",
            conclusion: runId === 4 ? "neutral" : "success",
            html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${runId}/job/${
              runId * 10
            }`,
            started_at: jobStartedAt,
            completed_at: run?.updated_at,
            steps: [
              {
                number: 1,
                name: "Run ./clawsweeper/.github/actions/setup-codex",
                status: "completed",
                conclusion: "success",
                started_at: jobStartedAt,
                completed_at: reviewStartedAt,
              },
              {
                number: 2,
                name: "Review shard",
                status: "completed",
                conclusion: failed ? "failure" : "success",
                started_at: reviewStartedAt,
                completed_at: run?.updated_at,
              },
            ],
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
      STATUS_STORE: new MemoryKv(),
    };
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.health.attempts, 4);
    assert.equal(status.health.successful_attempts, 2);
    assert.equal(status.health.failed_attempts, 2);
    assert.equal(status.health.recovered_failures, 1);
    assert.equal(status.health.unresolved_failures, 1);
    assert.equal(status.health.error_rate_percent, 50);
    assert.equal(status.health.recovery_rate_percent, 50);
    assert.equal(status.bay.tide_threshold, 20);
    assert.equal(status.bay.tide_generation, 0);
    assert.equal(status.bay.terminal_count, 3);
    assert.equal(status.bay.timings.lanes, undefined);
    assert.deepEqual(status.bay.timings.overall, {
      average_ms: null,
      median_ms: null,
      samples: 0,
    });
    assert.deepEqual(
      status.bay.terminal_buffer.map((item: { number: number }) => item.number),
      [100, 200, 300],
    );
    assert.equal(status.health.recent_attempts, undefined);
    assert.equal(status.health.failures[0].item_numbers[0], 200);
    assert.equal(status.health.failures[0].recovered, false);
    assert.equal(status.health.failures[0].failed_step, "Review shard");
    assert.equal(status.health.failures[1].item_numbers[0], 100);
    assert.equal(status.health.failures[1].recovered, true);
    assert.equal(jobRequests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes scheduled cluster intake markers and runs", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const marker = {
    target_repo: "openclaw/openclaw",
    last_processed_store_sha256: "abc123def4567890",
    last_processed_store_exported_at: "2026-05-25T12:00:00Z",
    generated_count: 1,
    generated_jobs: ["jobs/openclaw/inbox/gitcrawl-42-login-fix.md"],
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
    updated_at: "2026-05-25T12:08:00Z",
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 42,
            name: "repair cluster intake",
            display_title: "repair cluster intake",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/42",
            created_at: "2026-05-25T12:08:00Z",
            updated_at: "2026-05-25T12:09:00Z",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/cluster-repair-intake/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(marker)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.cluster_repair.workflow, "repair-cluster-intake.yml");
    assert.equal("schedule" in status.recent.cluster_repair, false);
    assert.equal(status.recent.cluster_repair.markers[0].status, "imported");
    assert.equal(status.recent.cluster_repair.markers[0].generated_count, 1);
    assert.equal(
      status.recent.cluster_repair.markers[0].last_processed_store_short_sha,
      "abc123def4",
    );
    assert.equal(status.recent.cluster_repair.latest_runs[0].url, marker.run_url);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes apply health from sweep status without broad scans", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const sweepStatus = {
    target_repo: "openclaw/openclaw",
    state: "Apply finished",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
    updated_at: "2026-07-03T10:15:00Z",
    apply_health: {
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/98",
      mode: "close",
      status: "needs_attention",
      summary:
        "4 examined; 2/2 action records; 0 closed, 0 comments synced, 2 skipped; no cursor recorded.",
      examined: 4,
      action_records: 2,
      processed: 2,
      processed_limit: 2,
      close_limit: 5,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      cursor_required: true,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
      lanes: {
        closure: {
          processed: 2,
          closed: 0,
          comment_synced: 0,
          skipped: 2,
          skip_reasons: {
            skipped_changed_since_review: 2,
          },
        },
        comment_sync: {
          processed: 0,
          closed: 0,
          comment_synced: 0,
          skipped: 0,
          skip_reasons: {},
        },
      },
      next_actions: [
        {
          reason: "skipped_changed_since_review",
          count: 2,
          bucket: "review_refresh",
          owner: "clawsweeper",
          retryable: true,
          label: "Refresh review",
          summary: "The item changed after the review that proposed closing it.",
          next_step: "Queue a fresh ClawSweeper review before any close retry.",
        },
      ],
      next_action_buckets: {
        review_refresh: 2,
      },
      cycle: {
        basis: "scheduled_close_cursor",
        apply_ready_count: 1200,
        candidate_counts: {
          confirmed_proposal: 4,
          guarded_retry: 2,
          proof_required: 3,
          promotion_total: 1194,
          promotion_eligible: 1,
          promotion_cooldown_eligible: 420,
          cooldown_eligible_total: 427,
          inconsistent_or_stale: 1,
        },
        window_size: 300,
        estimated_full_cycle_windows: 4,
        estimated_full_cycle_minutes: null,
        scheduled_interval_minutes: null,
        label:
          "1200 close candidates (confirmed proposals plus live promotion probes) at 300 records per latest cursor advance: about 4 windows.",
      },
      attention_reasons: ["cursor_required_but_missing_after_full_window"],
      cursor: null,
    },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper-state/contents/results/sweep-status/openclaw-openclaw.json"
    ) {
      assert.equal(url.searchParams.get("ref"), "state");
      return jsonResponse({
        content: Buffer.from(JSON.stringify(sweepStatus)).toString("base64"),
      });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.recent.apply_health.attention_count, 1);
    assert.equal(status.recent.apply_health.items[0].status, "needs_attention");
    assert.equal(
      status.recent.apply_health.items[0].run_url,
      "https://github.com/openclaw/clawsweeper/actions/runs/98",
    );
    assert.equal(status.recent.apply_health.items[0].examined, 4);
    assert.equal(status.recent.apply_health.items[0].action_records, 2);
    assert.equal(status.recent.apply_health.items[0].processed, 2);
    assert.equal(status.recent.apply_health.items[0].cursor_required, true);
    assert.deepEqual(status.recent.apply_health.items[0].skip_reasons, {
      skipped_changed_since_review: 2,
    });
    assert.deepEqual(status.recent.apply_health.items[0].lanes.closure, {
      processed: 2,
      closed: 0,
      comment_synced: 0,
      skipped: 2,
      skip_reasons: {
        skipped_changed_since_review: 2,
      },
    });
    assert.equal(status.recent.apply_health.items[0].lanes.comment_sync.processed, 0);
    assert.deepEqual(status.recent.apply_health.items[0].next_action_buckets, {
      review_refresh: 2,
    });
    assert.equal(
      status.recent.apply_health.items[0].next_actions[0].next_step,
      "Queue a fresh ClawSweeper review before any close retry.",
    );
    assert.equal(status.recent.apply_health.items[0].cycle.estimated_full_cycle_minutes, null);
    assert.equal(status.recent.apply_health.items[0].cycle.apply_ready_count, 1200);
    assert.deepEqual(status.recent.apply_health.items[0].cycle.candidate_counts, {
      confirmed_proposal: 4,
      guarded_retry: 2,
      proof_required: 3,
      promotion_total: 1194,
      promotion_eligible: 1,
      promotion_cooldown_eligible: 420,
      cooldown_eligible_total: 427,
      inconsistent_or_stale: 1,
    });
    assert.equal(status.recent.apply_health.items[0].cursor, null);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reads stored CI status for active PR rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          status: "green",
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "green",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 0,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].repository, "openclaw/openclaw");
    assert.equal(status.pipeline[0].item_number, 80609);
    assert.equal(status.pipeline[0].ci.state, "green");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.total, 12);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard falls back to edge cache storage when KV is not bound", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "ci.status",
          repository: "openclaw/openclaw",
          item_number: 80609,
          ci: {
            repository: "openclaw/openclaw",
            item_number: 80609,
            state: "pending",
            source: "github-checks",
            total: 12,
            failing: 0,
            pending: 2,
          },
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "github-checks");
    assert.equal(status.pipeline[0].ci.pending, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard serves stale status while coalescing one background refresh", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cache = new MemoryCache();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: cache },
  });
  await cache.put(
    new Request("https://clawsweeper.openclaw.ai/api/status-cache/v3/stale"),
    jsonResponse({
      schema_version: 1,
      generated_at: "2026-06-13T18:00:00Z",
      source: {
        clawsweeper_repo: "openclaw/clawsweeper",
        target_repositories: ["openclaw/openclaw"],
      },
      fleet: { active_workflow_runs: 1 },
      workers: [],
      pipeline: [{ id: "stale-row" }],
      exact_review_queue: {
        pending: 1,
        dispatching: 1,
        leased: 0,
        handoff_health: { status: "stalled" },
      },
      diagnostics: { errors: [], exact_review_queue_error: null },
    }),
  );

  const currentQueue = {
    pending: 7,
    dispatching: 0,
    leased: 28,
    storage_schema_version: 1,
    handoff_health: {
      status: "healthy",
      reason: "handoff_current",
      phases: {
        pending: { count: 7 },
        dispatching: { count: 0 },
        leased: { count: 28 },
      },
    },
  };
  let queueReads = 0;
  const exactReviewQueue = new MemoryDurableNamespace({
    fetch: async () => {
      queueReads += 1;
      return jsonResponse(currentQueue);
    },
  });

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let unfilteredRunRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    await fetchGate;
    if (url.pathname.includes("/actions/")) {
      if (url.pathname.endsWith("/actions/runs") && !url.searchParams.has("status")) {
        unfilteredRunRequests += 1;
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const waitUntilPromises: Promise<unknown>[] = [];
    const env = {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "20",
      EXACT_REVIEW_QUEUE: exactReviewQueue,
    };
    const context = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const [first, second] = await Promise.all([
      worker.fetch(request, env, context),
      worker.fetch(request, env, context),
    ]);

    assert.equal(first.headers.get("x-clawsweeper-cache"), "stale");
    assert.equal(second.headers.get("x-clawsweeper-cache"), "stale");
    const firstStatus = await first.json();
    const secondStatus = await second.json();
    assert.equal(firstStatus.pipeline[0].id, "stale-row");
    assert.equal(firstStatus.exact_review_queue.pending, 1);
    assert.equal(firstStatus.exact_review_queue.handoff_health.status, "stalled");
    assert.equal(secondStatus.exact_review_queue.handoff_health.status, "stalled");
    assert.equal(queueReads, 0);
    assert.equal(waitUntilPromises.length, 2);

    releaseFetch();
    await Promise.all(waitUntilPromises);
    assert.equal(unfilteredRunRequests, 1);
    assert.equal(queueReads, 2);

    const refreshed = await worker.fetch(request, env);
    assert.equal(refreshed.headers.get("x-clawsweeper-cache"), "fresh");
    const refreshedStatus = await refreshed.json();
    assert.deepEqual(refreshedStatus.pipeline, []);
    assert.equal(refreshedStatus.exact_review_queue.pending, 7);
    assert.equal(refreshedStatus.exact_review_queue.handoff_health.status, "healthy");
    assert.equal(queueReads, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard status survives cache persistence failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async (request: Request) => {
          if (
            request.url.includes("/api/status-cache/") ||
            request.url.includes("recent-automerge") ||
            request.url.includes("recent-closed")
          ) {
            throw new Error("cache unavailable");
          }
        },
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-clawsweeper-cache"), "miss");
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.deepEqual(status.diagnostics.errors, []);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard parallelizes and caches historical GitHub telemetry", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let closedRequests = 0;
  let activeDetails = 0;
  let maxActiveDetails = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        items: [101, 102, 103, 104].map((number) => ({
          number,
          title: `Merged PR ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        })),
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/(?:pulls\/\d+|issues\/\d+\/comments)$/.test(url.pathname)) {
      activeDetails += 1;
      maxActiveDetails = Math.max(maxActiveDetails, activeDetails);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeDetails -= 1;
      if (url.pathname.includes("/comments")) {
        return jsonResponse([
          {
            body: "@clawsweeper automerge",
            created_at: "2026-06-13T18:00:00Z",
          },
        ]);
      }
      return jsonResponse({
        merged_at: "2026-06-13T18:01:00Z",
        merge_commit_sha: "abc123",
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      closedRequests += 1;
      return jsonResponse([]);
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const env = {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "-1",
    };
    const request = new Request("https://clawsweeper.openclaw.ai/api/status");
    const first = await worker.fetch(request, env);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).averages.automerge_samples, 4);
    assert.ok(maxActiveDetails >= 4);
    assert.equal(searchRequests, 1);
    assert.equal(closedRequests, 1);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await worker.fetch(request, env);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).averages.automerge_samples, 4);
    assert.equal(searchRequests, 1);
    assert.equal(closedRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reports automerge worker reliability independently of merged PR timing", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let reliabilityRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-worker.yml/runs"
    ) {
      reliabilityRequests += 1;
      const workflowRun = (
        id: number,
        number: number,
        conclusion: "failure" | "success",
        createdAt: string,
        updatedAt: string,
      ) => ({
        id,
        display_title: `automerge repair jobs/openclaw/inbox/automerge-openclaw-openclaw-${number}.md`,
        status: "completed",
        conclusion,
        html_url: `https://github.com/openclaw/clawsweeper/actions/runs/${id}`,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return jsonResponse({
        workflow_runs: [
          workflowRun(
            29431617465,
            107691,
            "failure",
            "2026-07-15T16:15:04Z",
            "2026-07-15T16:34:51Z",
          ),
          workflowRun(
            29434021623,
            107691,
            "success",
            "2026-07-15T16:49:45Z",
            "2026-07-15T16:51:53Z",
          ),
          workflowRun(
            29435000000,
            107692,
            "failure",
            "2026-07-15T17:00:00Z",
            "2026-07-15T17:10:00Z",
          ),
        ],
      });
    }
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };

  try {
    const response = await worker.fetch(new Request("https://clawsweeper.openclaw.ai/api/status"), {
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "-1",
    });
    assert.equal(response.status, 200);
    const status = await response.json();
    const reliability = status.recent.automerge_reliability;
    assert.equal(reliabilityRequests, 1);
    assert.equal(reliability.sampled_runs, 3);
    assert.equal(reliability.failure_rate_percent, 66.7);
    assert.equal(reliability.recovered_failures, 1);
    assert.equal(reliability.unresolved_failures, 1);
    assert.deepEqual(
      reliability.failures.map((failure: { number: number; status: string }) => [
        failure.number,
        failure.status,
      ]),
      [
        [107692, "unresolved"],
        [107691, "recovered"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard batches recent automerge hydration with GraphQL when authenticated", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let graphqlRequests = 0;
  let restDetailRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/actions/")) return jsonResponse({ workflow_runs: [] });
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        items: [101, 102].map((number) => ({
          number,
          title: `Merged PR ${number}`,
          html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
        })),
      });
    }
    if (url.pathname === "/graphql") {
      graphqlRequests += 1;
      return jsonResponse({
        data: {
          repository: {
            pr0: {
              mergedAt: "2026-06-13T18:01:00Z",
              mergeCommit: { oid: "abc101" },
              comments: {
                nodes: [
                  {
                    body: "@clawsweeper automerge",
                    createdAt: "2026-06-13T18:00:30Z",
                  },
                  {
                    body: "/clawsweeper automerge",
                    createdAt: "2026-06-13T18:00:00Z",
                  },
                ],
              },
            },
            pr1: {
              mergedAt: "2026-06-13T18:04:00Z",
              mergeCommit: { oid: "abc102" },
              comments: {
                nodes: [
                  {
                    body: "/clawsweeper automerge",
                    createdAt: "2026-06-13T18:02:00Z",
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (/^\/repos\/openclaw\/openclaw\/(?:pulls\/\d+|issues\/\d+\/comments)$/.test(url.pathname)) {
      restDetailRequests += 1;
      return jsonResponse({});
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "-1",
        GITHUB_TOKEN: "test-token",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(status.averages.automerge_samples, 2);
    assert.equal(status.averages.automerge_command_to_merge_ms, 90_000);
    assert.equal(searchRequests, 1);
    assert.equal(graphqlRequests, 1);
    assert.equal(restDetailRequests, 0);
    assert.deepEqual(
      status.recent.automerge.map((item: { number: number; merge_commit_sha: string }) => [
        item.number,
        item.merge_commit_sha,
      ]),
      [
        [101, "abc101"],
        [102, "abc102"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard preserves repeated untargeted activity events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    for (const title of ["Probe one", "Probe two"]) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            event_type: "status.test",
            mode: "test",
            stage: "probe",
            status: "ok",
            title,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      status.recent.events
        .filter((event: { event_type: string }) => event.event_type === "status.test")
        .map((event: { title: string }) => event.title)
        .sort(),
      ["Probe one", "Probe two"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts cluster-fixer operation events", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = activePrFetch;

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const events = [
      { event_type: "clawsweeper.replacement_label_cleanup", stage: "executed" },
      { event_type: "clawsweeper.clawsweeper_self_rebase", stage: "dispatched" },
      { event_type: "clawsweeper.dispatched_failed_review_retry", stage: "dispatched" },
      { event_type: "clawsweeper.marked_failed_review_retry_exhausted", stage: "exhausted" },
      { event_type: "clawsweeper.bot_proof_decision_posted", stage: "posted" },
      { event_type: "clawsweeper.bot_proof_mantis_request_posted", stage: "posted" },
    ];
    for (const event of events) {
      const ingest = await worker.fetch(
        new Request("https://clawsweeper.openclaw.ai/api/events", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            mode: "operation",
            status: "ok",
            ...event,
          }),
        }),
        env,
      );
      assert.equal(ingest.status, 200);
    }

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(status.recent.operation_counts, {
      inherited_label_cleanups: 1,
      self_heal_conflict_repairs: 1,
      failed_review_retries: 1,
      failed_review_retry_exhaustions: 1,
      bot_owned_proof_decisions_requested: 1,
      bot_owned_proof_dispatches: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard keeps workflow CI status when live PR checks fail", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/repos/openclaw/clawsweeper/actions/runs")) {
      return jsonResponse({
        workflow_runs: [
          {
            id: 1,
            name: "ClawSweeper",
            display_title: "Review event item openclaw/openclaw#80609",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
            created_at: new Date(Date.now() - 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.includes("/repos/openclaw/openclaw/pulls/80609")) {
      return new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
    }
    if (url.includes("/search/issues")) return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.pipeline[0].ci.state, "pending");
    assert.equal(status.pipeline[0].ci.source, "workflow");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard reuses live PR CI hydration within one status snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: new MemoryCache(),
    },
  });
  const runs = [
    {
      id: 8060901,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060901",
      created_at: isoAgo(120_000),
      updated_at: isoAgo(10_000),
    },
    {
      id: 8060902,
      name: "ClawSweeper",
      display_title: "Review event item openclaw/openclaw#80609",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/openclaw/clawsweeper/actions/runs/8060902",
      created_at: isoAgo(90_000),
      updated_at: isoAgo(5_000),
    },
  ];
  let pullRequests = 0;
  let checkRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      return jsonResponse({ workflow_runs: !status || status === "in_progress" ? runs : [] });
    }
    if (/^\/repos\/openclaw\/clawsweeper\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
      return jsonResponse({ jobs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/pulls/80609") {
      pullRequests += 1;
      return jsonResponse({ head: { sha: "head-80609" } });
    }
    if (url.pathname === "/repos/openclaw/openclaw/commits/head-80609/check-runs") {
      checkRequests += 1;
      return jsonResponse({
        check_runs: [
          {
            name: "test",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    }
    if (
      url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/repair-cluster-intake.yml/runs"
    ) {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    if (url.pathname === "/repos/openclaw/openclaw/issues") return jsonResponse([]);
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
        INCLUDE_CI_STATUS: "1",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(response.status, 200);
    assert.equal(pullRequests, 1);
    assert.equal(checkRequests, 1);
    assert.deepEqual(
      status.pipeline.map((row: { ci: { source: string; state: string } }) => row.ci),
      [
        {
          state: "green",
          head_sha: "head-80609",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
        {
          state: "green",
          head_sha: "head-80609",
          total: 1,
          failing: 0,
          pending: 0,
          source: "live",
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard counts active runs that are older than the latest unfiltered page", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "recent completed run",
              display_title: "recent completed run",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: "2026-05-14T06:40:00Z",
              updated_at: "2026-05-14T06:41:00Z",
            },
          ],
        });
      }
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81001",
              display_title: "Review event item openclaw/openclaw#81001",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(25 * 60_000),
              updated_at: isoAgo(20 * 60_000),
            },
            {
              id: 3,
              name: "Commit review openclaw/openclaw@abc123",
              display_title: "Commit review openclaw/openclaw@abc123",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/3",
              created_at: isoAgo(20 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
            {
              id: 5,
              name: "spam comment intake",
              display_title: "github_activity",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/5",
              created_at: isoAgo(18 * 60_000),
              updated_at: isoAgo(16 * 60_000),
            },
            {
              id: 6,
              name: "ClawSweeper Live Dashboard CI Status",
              display_title: "ClawSweeper Live Dashboard CI Status",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/6",
              created_at: isoAgo(17 * 60_000),
              updated_at: isoAgo(15 * 60_000),
            },
          ],
        });
      }
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 4,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/4",
              created_at: isoAgo(30 * 60_000),
              updated_at: isoAgo(29 * 60_000),
            },
            {
              id: 7,
              name: "github activity to openclaw",
              display_title: "github_activity",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/7",
              created_at: isoAgo(31 * 60_000),
              updated_at: isoAgo(30 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 3);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.equal(status.fleet.support_workflow_runs, 3);
    assert.equal(status.fleet.support_queued_workflow_runs, 1);
    assert.equal(status.fleet.worker_budget, 128);
    assert.deepEqual(
      status.pipeline.map((row: { id: number }) => row.id),
      [2, 4, 3],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard surfaces stale queue ghosts as zombies without active cards", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (!status) return jsonResponse({ workflow_runs: [] });
      if (status === "queued") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 1,
              name: "ClawSweeper Commit Review",
              display_title: "clawsweeper_commit_review",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
              created_at: isoAgo(7 * 24 * 60 * 60_000),
              updated_at: isoAgo(7 * 24 * 60 * 60_000),
            },
            {
              id: 2,
              name: "Review event item openclaw/openclaw#81002",
              display_title: "Review event item openclaw/openclaw#81002",
              status: "queued",
              conclusion: null,
              html_url: "https://github.com/openclaw/clawsweeper/actions/runs/2",
              created_at: isoAgo(10 * 60_000),
              updated_at: isoAgo(9 * 60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.equal(status.fleet.active_workflow_runs, 1);
    assert.equal(status.fleet.queued_workflow_runs, 1);
    assert.equal(status.operational_health.queued_runs, 2);
    assert.equal(status.operational_health.queued_over_threshold, 0);
    assert.equal(status.operational_health.oldest_queued_minutes, 10);
    assert.equal(status.operational_health.zombie_queued_runs, 1);
    assert.equal(status.operational_health.oldest_zombie_queued_minutes, 7 * 24 * 60);
    assert.equal(status.operational_health.status, "healthy");
    assert.deepEqual(
      status.pipeline.map((row: { id: number }) => row.id),
      [2],
    );
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard health retains in-progress runs beyond the queued ghost window", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: { default: { match: async () => undefined, put: async () => undefined } },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      const status = url.searchParams.get("status");
      if (status === "in_progress") {
        return jsonResponse({
          workflow_runs: [
            {
              id: 8,
              name: "repair cluster worker",
              display_title: "repair cluster worker",
              status: "in_progress",
              created_at: isoAgo(8 * 60 * 60_000),
              run_started_at: isoAgo(7 * 60 * 60_000),
              updated_at: isoAgo(60_000),
            },
          ],
        });
      }
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      { waitUntil: () => undefined },
    );
    const status = await response.json();
    assert.equal(status.operational_health.status, "stalled");
    assert.equal(status.operational_health.running_over_threshold, 1);
    assert.equal(status.operational_health.oldest_running_minutes, 420);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard exposes ClawSweeper-owned recent closes and 24h stats", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    const olderClosedAt = new Date(Date.now() - 120_000).toISOString();
    const oldestClosedAt = new Date(Date.now() - 180_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (
      url.pathname === "/repos/openclaw/openclaw/issues" &&
      url.searchParams.get("page") === "1"
    ) {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([
        {
          number: 81,
          title: "Fix stale terminal resize state",
          html_url: "https://github.com/openclaw/openclaw/pull/81",
          closed_at: olderClosedAt,
          closed_by: { login: "clawsweeper[bot]" },
          pull_request: {},
        },
        {
          number: 82,
          title: "Alternate app closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/82",
          closed_at: oldestClosedAt,
          closed_by: { login: "openclaw-clawsweeper[bot]" },
        },
        {
          number: 80,
          title: "Remove old session warning",
          html_url: "https://github.com/openclaw/openclaw/issues/80",
          closed_at: closedAt,
          closed_by: { login: "clawsweeper[bot]" },
        },
        {
          number: 79,
          title: "Human closed issue",
          html_url: "https://github.com/openclaw/openclaw/issues/79",
          closed_at: closedAt,
          closed_by: { login: "steipete" },
        },
      ]);
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      issuePages.push(url.searchParams.get("page") || "");
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      INGEST_TOKEN: "test-token",
      STATUS_STORE: new MemoryKv(),
      CLAWSWEEPER_REPO: "openclaw/clawsweeper",
      TARGET_REPOS: "openclaw/openclaw",
      CACHE_TTL_SECONDS: "0",
    };
    const ingest = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/80",
          title: "Real close event",
        }),
      }),
      env,
    );
    assert.equal(ingest.status, 200);
    const prClose = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.item_closed",
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/81",
          title: "Explicit PR close event",
        }),
      }),
      env,
    );
    assert.equal(prClose.status, 200);
    const blocked = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/events", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "clawsweeper.close_blocked",
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          repository: "openclaw/openclaw",
          item_url: "https://github.com/openclaw/openclaw/issues/82",
          title: "Blocked close event",
        }),
      }),
      env,
    );
    assert.equal(blocked.status, 200);

    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      env,
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      status.recent.closed_items.map(
        (item: { type: string; number: number; closed_by: string }) => ({
          type: item.type,
          number: item.number,
          closed_by: item.closed_by,
        }),
      ),
      [
        { type: "Issue", number: 80, closed_by: "clawsweeper[bot]" },
        { type: "PR", number: 81, closed_by: "clawsweeper[bot]" },
        { type: "Issue", number: 82, closed_by: "openclaw-clawsweeper[bot]" },
      ],
    );
    assert.deepEqual(
      status.recent.events.map(
        (event: {
          mode: string;
          stage: string;
          status: string;
          item_number: number;
          source: string;
          title: string;
        }) => ({
          mode: event.mode,
          stage: event.stage,
          status: event.status,
          item_number: event.item_number,
          source: event.source,
          title: event.title,
        }),
      ),
      [
        {
          mode: "close_blocked",
          stage: "close_duplicate",
          status: "blocked",
          item_number: undefined,
          source: undefined,
          title: "Blocked close event",
        },
        {
          mode: "item_closed",
          stage: "close_fixed_by_candidate",
          status: "executed",
          item_number: undefined,
          source: undefined,
          title: "Explicit PR close event",
        },
        {
          mode: "item_closed",
          stage: "close_duplicate",
          status: "executed",
          item_number: undefined,
          source: undefined,
          title: "Real close event",
        },
        {
          mode: "closed",
          stage: "Issue",
          status: "closed",
          item_number: 82,
          source: "closed_items",
          title: "Alternate app closed issue",
        },
      ],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 3,
      issues: 2,
      prs: 1,
      by_repository: {
        "openclaw/openclaw": {
          total: 3,
          issues: 2,
          prs: 1,
        },
      },
    });
    assert.ok(new Date(status.recent.closed_stats.since).getTime() <= Date.now());
    assert.deepEqual(issuePages, ["1"]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("dashboard fetches additional closed pages only when the first page is full", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const issuePages: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const closedAt = new Date(Date.now() - 60_000).toISOString();
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs") {
      return jsonResponse({ workflow_runs: [] });
    }
    if (url.pathname === "/repos/openclaw/openclaw/issues") {
      const page = url.searchParams.get("page") || "";
      issuePages.push(page);
      if (page === "1") {
        return jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({
            number: index + 1,
            title: `Human closed issue ${index + 1}`,
            html_url: `https://github.com/openclaw/openclaw/issues/${index + 1}`,
            closed_at: closedAt,
            closed_by: { login: "steipete" },
          })),
        );
      }
      if (page === "2") {
        return jsonResponse([
          {
            number: 101,
            title: "ClawSweeper closed overflow page issue",
            html_url: "https://github.com/openclaw/openclaw/issues/101",
            closed_at: closedAt,
            closed_by: { login: "clawsweeper[bot]" },
          },
        ]);
      }
      return jsonResponse([]);
    }
    if (url.pathname === "/search/issues") return jsonResponse({ items: [] });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/status"),
      {
        CLAWSWEEPER_REPO: "openclaw/clawsweeper",
        TARGET_REPOS: "openclaw/openclaw",
        CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const status = await response.json();
    assert.deepEqual(
      issuePages.sort((left, right) => Number(left) - Number(right)),
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
    );
    assert.deepEqual(status.recent.closed_stats, {
      window_hours: 24,
      since: status.recent.closed_stats.since,
      total: 1,
      issues: 1,
      prs: 0,
      by_repository: {
        "openclaw/openclaw": {
          total: 1,
          issues: 1,
          prs: 0,
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused views use direct search when broad snapshot is capped", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let readyPerPage = "";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        readyPerPage = url.searchParams.get("per_page") || "";
        return jsonResponse({
          total_count: 2,
          items: [
            triageIssue(102, ["clawsweeper:queueable-fix", "impact:message-loss"]),
            triageIssue(100, ["clawsweeper:queueable-fix"]),
          ],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const root = snapshot.views.find((view: { id: string }) => view.id === "clawsweeper");
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(root.item_limit, 500);
    assert.equal(ready.total_count, 2);
    assert.equal(ready.item_limit, 100);
    assert.equal(readyPerPage, "100");
    assert.deepEqual(
      ready.items.map((item: { number: number }) => item.number),
      [102, 100],
    );
    assert.deepEqual(
      ready.items[0].routing_groups.map((group: { id: string }) => group.id),
      ["message-delivery"],
    );
    assert.deepEqual(
      ready.items[1].routing_groups.map((group: { id: string }) => group.id),
      ["unclassified"],
    );
    assert.equal(ready.loaded_routing_group_counts["message-delivery"], 1);
    assert.equal(ready.loaded_routing_group_counts.unclassified, 1);
    assert.ok(snapshot.routing_groups.some((group: { id: string }) => group.id === "state-data"));
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused fallbacks reserve search budget for later repos", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  let sawSecondRepoLastRootPage = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      const repo = query.includes("repo:openclaw/other") ? "openclaw/other" : "openclaw/openclaw";
      if (repo === "openclaw/other" && page === "4") {
        sawSecondRepoLastRootPage = true;
      }
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        return jsonResponse({
          total_count: 1,
          items: [triageIssue(repo, 200, ["clawsweeper:queueable-fix"])],
        });
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 401,
          items: [triageIssue(repo, Number(page), ["clawsweeper:queueable-fix"])],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: "openclaw/openclaw,openclaw/other",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.equal(sawSecondRepoLastRootPage, true);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage focused search errors fall back to loaded broad rows", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
        { name: "clawsweeper:no-new-fix-pr", color: "BFDADC", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      const query = url.searchParams.get("q") || "";
      const page = url.searchParams.get("page") || "1";
      if (
        query.includes('label:"clawsweeper:queueable-fix"') &&
        query.includes('-label:"clawsweeper:no-new-fix-pr"')
      ) {
        throw new Error("focused search failed");
      }
      if (query.includes('label:"clawsweeper:no-new-fix-pr","clawsweeper:queueable-fix"')) {
        return jsonResponse({
          total_count: 501,
          items:
            page === "1"
              ? [
                  triageIssue(102, ["clawsweeper:queueable-fix"]),
                  triageIssue(101, ["clawsweeper:queueable-fix", "clawsweeper:no-new-fix-pr"]),
                ]
              : [],
        });
      }
      return jsonResponse({ total_count: 0, items: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_ITEMS_PER_VIEW: "500",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    const ready = snapshot.views.find((view: { id: string }) => view.id === "ready-candidates");
    assert.equal(ready.total_count, 1);
    assert.deepEqual(
      ready.items.map((item: { number: number }) => item.number),
      [102],
    );
    assert.match(snapshot.diagnostics.errors.join("\n"), /focused search failed/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage skips repos after root search budget is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(searchRequests, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.match(snapshot.diagnostics.errors.join("\n"), /repo-9 triage skipped/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage debits failed root searches from the search budget", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  let searchRequests = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/labels")) {
      return jsonResponse([
        { name: "clawsweeper:queueable-fix", color: "0E8A16", description: "" },
      ]);
    }
    if (url.pathname === "/search/issues") {
      searchRequests += 1;
      throw new Error("root search failed");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const repos = Array.from({ length: 10 }, (_, index) => `openclaw/repo-${index}`).join(",");
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        TRIAGE_TARGET_REPOS: repos,
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(searchRequests, 9);
    assert.equal(snapshot.source.search_request_budget_remaining, 0);
    assert.match(snapshot.diagnostics.errors.join("\n"), /repo-9 triage skipped/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});

test("triage uses ClawSweeper GitHub App credentials when no static token is configured", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => undefined,
      },
    },
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let sawAppJwt = false;
  let sawInstallationToken = false;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const authorization = String(new Headers(init?.headers).get("authorization") || "");
    if (url.pathname === "/repos/openclaw/openclaw/installation") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({ id: 12345 });
    }
    if (url.pathname === "/app/installations/12345/access_tokens") {
      sawAppJwt = authorization.startsWith("Bearer ");
      return jsonResponse({
        token: "installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.pathname === "/repos/openclaw/openclaw/labels") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse([{ name: "clawsweeper:queueable-fix", color: "0E8A16" }]);
    }
    if (url.pathname === "/search/issues") {
      sawInstallationToken = authorization === "Bearer installation-token";
      return jsonResponse({
        total_count: 1,
        items: [triageIssue(101, ["clawsweeper:queueable-fix"])],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/api/triage"),
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: String(privateKey),
        TARGET_REPOS: "openclaw/openclaw",
        TRIAGE_CACHE_TTL_SECONDS: "0",
      },
      {
        waitUntil: () => undefined,
      },
    );
    const snapshot = await response.json();
    assert.equal(response.status, 200);
    assert.equal(snapshot.source.search_request_budget_remaining, 27);
    assert.equal(sawAppJwt, true);
    assert.equal(sawInstallationToken, true);
    assert.doesNotMatch(snapshot.diagnostics.errors.join("\n"), /GITHUB_TOKEN/);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
});
