import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = await import(playwrightModule);

const outputDir = path.resolve(process.env.BAY_PROOF_OUTPUT || ".artifacts/openclaw-bay-proof");
const sourceSha = process.env.SOURCE_SHA || "unknown";
const port = Number(process.env.BAY_PROOF_PORT || 8787);
const origin = `http://bay-proof.test:${port}`;
const proofUrl = `${origin}/bay-demo`;
const browserPath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  "/ms-playwright/chromium-1223/chrome-linux64/chrome";

await mkdir(outputDir, { recursive: true });

function worker({ id, repository, number, step, runId, kind = "review", startedAt }) {
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  return {
    id,
    repository,
    item_number: number,
    item_numbers: [number],
    target_items: [
      {
        repository,
        number,
        title: `Synthetic proof item ${number}`,
        url: `https://github.com/${repository}/issues/${number}`,
      },
    ],
    name: "Synthetic ClawSweeper proof run",
    workflow_title: `Synthetic proof item ${number}`,
    current_step: step,
    status: "in_progress",
    run_id: runId,
    run_url: runUrl,
    job_url: `${runUrl}/job/${runId + 1000}`,
    started_at: startedAt,
    work_kind: kind,
    mode: "exact",
    progress: { completed: 2, total: 5 },
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: step, status: "in_progress", conclusion: null },
    ],
  };
}

function terminal({ repository, number, outcome, runId }) {
  return {
    event_id: `synthetic:${repository}#${number}:${outcome}`,
    item_key: `${repository}#${number}`,
    repository,
    number,
    title: `Synthetic ${outcome} proof item ${number}`,
    item_url: `https://github.com/${repository}/issues/${number}`,
    outcome,
    completed_at: "2026-07-11T17:58:00.000Z",
    job_url: `https://github.com/${repository}/actions/runs/${runId}/job/${runId + 1000}`,
    run_id: runId,
    current_step:
      outcome === "success"
        ? "Workflow concluded successfully"
        : outcome === "failure"
          ? "Workflow concluded with failure"
          : "Workflow was explicitly cancelled",
  };
}

const baseWorkers = [
  worker({
    id: "worker-main",
    repository: "openclaw/openclaw",
    number: 97722,
    step: "Review exact event item",
    runId: 1001,
    kind: "repair",
    startedAt: "2026-07-11T17:41:00.000Z",
  }),
  worker({
    id: "worker-clawhub",
    repository: "openclaw/clawhub",
    number: 3058,
    step: "Set up job",
    runId: 2001,
    kind: "review",
    startedAt: "2026-07-11T17:48:00.000Z",
  }),
  worker({
    id: "worker-sweeper",
    repository: "openclaw/clawsweeper",
    number: 485,
    step: "Validate repair",
    runId: 3001,
    kind: "repair",
    startedAt: "2026-07-11T17:52:00.000Z",
  }),
  worker({
    id: "worker-arriving",
    repository: "openclaw/openclaw",
    number: 103981,
    step: "Waiting for exact-review lease",
    runId: 4001,
    kind: "review",
    startedAt: "2026-07-11T17:55:00.000Z",
  }),
];

// The durable queue keeps this lease under Setting up while the actual worker is
// already Reviewing. Keep the checked-in progression fixtures stable and add the
// overlap only to a dedicated served snapshot, where the assertion exercises it.
const claimedReviewingWorker = worker({
  id: "worker-claimed-reviewing",
  repository: "openclaw/openclaw",
  number: 108002,
  step: "Review exact event item",
  runId: 4102,
  startedAt: "2026-07-11T17:57:00.000Z",
});

const terminalBuffer = [
  terminal({ repository: "openclaw/openclaw", number: 97001, outcome: "success", runId: 5001 }),
  terminal({ repository: "openclaw/clawhub", number: 97002, outcome: "failure", runId: 5002 }),
  terminal({
    repository: "openclaw/clawsweeper",
    number: 97003,
    outcome: "cancelled",
    runId: 5003,
  }),
];
const denseTerminalBuffer = Array.from({ length: 20 }, (_, index) =>
  terminal({
    repository: "openclaw/openclaw",
    number: 97101 + index,
    outcome: "success",
    runId: 5101 + index,
  }),
);

function snapshot(workers) {
  return {
    schema_version: 1,
    generated_at: "2026-07-11T18:00:00.000Z",
    fleet: { active_workflow_runs: workers.length, active_codex_jobs: workers.length },
    pipeline: [],
    workers,
    health: { sampled_runs: 4 },
    recent: { closed_items: [], failed_runs: [] },
    diagnostics: {
      errors: ["Synthetic proof fixture: optional telemetry unavailable [REDACTED]"],
    },
    bay: {
      terminal_buffer: terminalBuffer,
      recently_washed: [],
      terminal_count: terminalBuffer.length,
      tide_threshold: 20,
      tide_generation: 0,
      last_tide_at: null,
      washed_at: null,
      timings: {
        sample_kind: "completed_review_journeys",
        window_minutes: 60,
        overall: { samples: 4, average_ms: 742000 },
      },
    },
  };
}

const expectedSnapshots = [
  snapshot(baseWorkers),
  snapshot([
    { ...baseWorkers[0], current_step: "Publish review artifacts" },
    ...baseWorkers.slice(1),
  ]),
  snapshot([
    {
      ...baseWorkers[0],
      current_step: "Set up job",
      run_id: 1002,
      run_url: "https://github.com/openclaw/openclaw/actions/runs/1002",
      job_url: "https://github.com/openclaw/openclaw/actions/runs/1002/job/2002",
      started_at: "2026-07-11T18:01:00.000Z",
      steps: [{ name: "Set up job", status: "in_progress", conclusion: null }],
    },
    ...baseWorkers.slice(1),
  ]),
];

const fixtureFiles = ["01-initial.json", "02-forward.json", "03-retrigger.json"];
const fixtureBodies = await Promise.all(
  fixtureFiles.map((file) => readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8")),
);
const snapshots = fixtureBodies.map((body) => JSON.parse(body));
if (JSON.stringify(snapshots) !== JSON.stringify(expectedSnapshots)) {
  throw new Error("Checked-in Bay proof fixtures no longer match the expected synthetic sequence");
}
const denseTerminalSnapshot = structuredClone(snapshots[2]);
denseTerminalSnapshot.generated_at = "2026-07-11T18:02:00.000Z";
denseTerminalSnapshot.bay = {
  ...denseTerminalSnapshot.bay,
  terminal_buffer: denseTerminalBuffer,
  terminal_count: denseTerminalBuffer.length,
};
const realTideSnapshot = structuredClone(denseTerminalSnapshot);
realTideSnapshot.generated_at = "2026-07-11T18:02:00.000Z";
realTideSnapshot.bay = {
  ...realTideSnapshot.bay,
  terminal_buffer: [],
  recently_washed: denseTerminalBuffer,
  terminal_count: 0,
  tide_generation: 1,
  last_tide_at: "2026-07-11T18:02:00.000Z",
  washed_at: "2026-07-11T18:02:00.000Z",
};
const realTideSnapshotSha256 = createHash("sha256")
  .update(JSON.stringify(realTideSnapshot))
  .digest("hex")
  .toUpperCase();
const fixtureSnapshotSha256 = fixtureBodies.map((body, index) => ({
  file: `fixtures/${fixtureFiles[index]}`,
  sha256: createHash("sha256").update(body).digest("hex").toUpperCase(),
}));
const fixtureSha256 = createHash("sha256")
  .update(JSON.stringify(snapshots))
  .digest("hex")
  .toUpperCase();

let healthHistory = Array.from({ length: 73 }, (_, index) => {
  const at = new Date(Date.parse("2026-07-11T12:02:00.000Z") + index * 5 * 60_000).toISOString();
  return {
    at,
    exact_review: {
      collection_ok: true,
      review: {
        pending: 38 - Math.floor(index / 9),
        enqueued_total: 800 + index * 3,
        completed_total: 780 + index * 4,
        shed_total: 2,
      },
      publication: {
        pending: 6 - Math.floor(index / 22),
        enqueued_total: 320 + index * 2,
        completed_total: 318 + index * 3,
      },
    },
  };
});
let healthHistoryFailure = false;

function queueProjection() {
  const bayStages = [
    { stage: "arriving", queue_state: "pending" },
    { stage: "setting-up", queue_state: "leased" },
    { stage: "applying", queue_state: "dispatching" },
    { stage: "repairing", queue_state: "pending" },
  ];
  const items = Array.from({ length: 6 }, (_, batch) =>
    bayStages.map(({ stage, queue_state }, stageIndex) => {
      const item_number = 108001 + batch * bayStages.length + stageIndex;
      const at = new Date(
        Date.parse("2026-07-11T17:31:00.000Z") + item_number * 1_000,
      ).toISOString();
      return {
        item_key: `openclaw/openclaw#${item_number}`,
        repository: "openclaw/openclaw",
        item_number,
        stage,
        queue_state,
        created_at: at,
        updated_at: at,
        next_attempt_at: at,
      };
    }),
  ).flat();
  return {
    generated_at: "2026-07-11T18:02:00.000Z",
    lanes: {
      review: { pending: 29, ready: 4, backoff: 25, dispatching: 2, leased: 19 },
      publication: { pending: 2, ready: 0, backoff: 2, dispatching: 1, leased: 14 },
    },
    handoff_health: {
      status: "healthy",
      phases: {
        pending: { count: 29 },
        dispatching: { count: 3 },
        leased: { count: 33 },
      },
    },
    bay_projection: {
      sample_limit: 24,
      total: 36,
      stages: { arriving: 9, "setting-up": 9, reviewing: 0, applying: 9, repairing: 9 },
      items,
    },
  };
}

function denseFilteredQueueProjection() {
  const base = queueProjection();
  const items = Array.from({ length: 24 }, (_, index) => {
    const item_number = 109001 + index;
    const at = new Date(Date.parse("2026-07-11T17:31:00.000Z") + index * 1_000).toISOString();
    return {
      item_key: `openclaw/openclaw#${item_number}`,
      repository: "openclaw/openclaw",
      item_number,
      stage: "arriving",
      queue_state: "pending",
      created_at: at,
      updated_at: at,
      next_attempt_at: at,
    };
  });
  return {
    ...base,
    bay_projection: {
      sample_limit: 24,
      total: 24,
      stages: { arriving: 24, "setting-up": 0, reviewing: 0, applying: 0, repairing: 0 },
      items,
    },
  };
}

const proofSnapshots = [...snapshots, denseTerminalSnapshot, realTideSnapshot].map((snapshot) => ({
  ...snapshot,
  exact_review_queue: queueProjection(),
}));
proofSnapshots.push({
  ...snapshots[0],
  workers: [...snapshots[0].workers, claimedReviewingWorker],
  exact_review_queue: queueProjection(),
});
proofSnapshots.push({
  ...snapshots[0],
  workers: [
    ...snapshots[0].workers,
    {
      ...worker({
        id: "worker-filtered-arriving",
        repository: "openclaw/openclaw",
        number: 199999,
        step: "Awaiting review admission",
        runId: 4199,
        startedAt: "2026-07-11T17:57:00.000Z",
      }),
      status: "waiting",
    },
  ],
  exact_review_queue: denseFilteredQueueProjection(),
});

let fixtureIndex = 0;
const requests = [];
const responses = [];
const consoleErrors = [];
const pageErrors = [];
const assertions = [];
const evidence = [];
let tideBefore = [];
let tideAfter = [];
let reducedTideAfter = [];
const tidePhases = [];
let drawerLinks = [];

function assertProof(name, condition, details = {}) {
  if (!condition) {
    throw new Error(`Proof assertion failed: ${name} ${JSON.stringify(details)}`);
  }
  assertions.push({ name, status: "PASS", ...details });
}

function sanitizeUrl(value) {
  const url = new URL(value);
  return { host: url.host, path: url.pathname };
}

const browser = await chromium.launch({
  headless: true,
  executablePath: browserPath,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-proxy-server",
    "--host-resolver-rules=MAP bay-proof.test 127.0.0.1",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1900, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});

await context.addInitScript(() => {
  const nativeSetInterval = window.setInterval.bind(window);
  const nativeMatchMedia = window.matchMedia.bind(window);
  let randomSeed = 0x0c1a5eed;
  Math.random = () => {
    randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0;
    return randomSeed / 4294967296;
  };
  let nowMs = Date.parse("2026-07-11T18:02:00.000Z");
  Date.now = () => nowMs;
  window.__bayProofSetNow = (value) => {
    nowMs = Number(value);
  };
  window.__bayProofReduceMotion = true;
  window.__bayProofPoll = null;
  window.setInterval = (callback, delay, ...args) => {
    if (Number(delay) === 20000) {
      window.__bayProofPoll = callback;
      return 4242;
    }
    return nativeSetInterval(callback, delay, ...args);
  };
  window.matchMedia = (query) => {
    if (query !== "(prefers-reduced-motion: reduce)") return nativeMatchMedia(query);
    return {
      matches: Boolean(window.__bayProofReduceMotion),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    };
  };
});

const page = await context.newPage();
page.on("request", (request) => {
  const safe = sanitizeUrl(request.url());
  requests.push({
    method: request.method(),
    host: safe.host,
    path: safe.path,
    resource_type: request.resourceType(),
  });
});
page.on("response", (response) => {
  const safe = sanitizeUrl(response.url());
  responses.push({
    status: response.status(),
    host: safe.host,
    path: safe.path,
  });
});
page.on("console", (message) => {
  if (message.type() === "error")
    consoleErrors.push(message.text().replaceAll(outputDir, "[REDACTED]"));
});
page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));

await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/status") {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      headers: { "cache-control": "no-store", "x-clawsweeper-cache": "synthetic-proof" },
      body: JSON.stringify(proofSnapshots[fixtureIndex]),
    });
    return;
  }
  if (url.pathname === "/api/health-history") {
    if (healthHistoryFailure) {
      await route.fulfill({
        status: 503,
        contentType: "application/json; charset=utf-8",
        headers: { "cache-control": "no-store", "x-clawsweeper-cache": "synthetic-proof" },
        body: JSON.stringify({ error: "synthetic history outage" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      headers: { "cache-control": "no-store", "x-clawsweeper-cache": "synthetic-proof" },
      body: JSON.stringify({
        schema_version: 1,
        range: "6h",
        retention_days: 7,
        samples: healthHistory,
      }),
    });
    return;
  }
  if (url.origin !== origin) {
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
});

await context.tracing.start({ screenshots: false, snapshots: true, sources: false });

async function setCaption(title, detail) {
  await page.evaluate(
    ({ title, detail }) => {
      let node = document.getElementById("playwright-proof-caption");
      if (!node) {
        node = document.createElement("aside");
        node.id = "playwright-proof-caption";
        node.setAttribute("aria-label", "Playwright proof caption");
        Object.assign(node.style, {
          position: "fixed",
          zIndex: "1000",
          left: "50%",
          bottom: "18px",
          transform: "translateX(-50%)",
          width: "min(980px, 86vw)",
          padding: "12px 18px",
          border: "2px solid rgba(255,255,255,.78)",
          borderRadius: "14px",
          background: "rgba(23,67,70,.94)",
          boxShadow: "0 12px 30px rgba(24,44,42,.28)",
          color: "white",
          font: "700 15px/1.35 system-ui,sans-serif",
          pointerEvents: "none",
          textAlign: "center",
        });
        document.body.append(node);
      }
      node.replaceChildren();
      const strong = document.createElement("strong");
      strong.textContent = title;
      strong.style.color = "#ffd092";
      const span = document.createElement("span");
      span.textContent = ` — ${detail}`;
      node.append(strong, span);
    },
    { title, detail },
  );
}

async function capture(id, title, detail) {
  await setCaption(title, detail);
  const file = `${id}.jpg`;
  await page.screenshot({
    path: path.join(outputDir, file),
    type: "jpeg",
    quality: 82,
    animations: "allow",
  });
  evidence.push({ id, title, detail, file });
}

let proofError = null;
try {
  await page.goto(proofUrl, { waitUntil: "networkidle" });
  await page.locator("#loading").waitFor({ state: "hidden", timeout: 15_000 });
  await page.locator("#stage-grid .critter").first().waitFor({ state: "visible" });
  await page.locator("#bay-control-board .bay-control-point").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);

  assertProof("real Bay route loaded", (await page.title()).includes("OpenClaw Bay"), {
    route: "/bay-demo",
  });
  assertProof(
    "manual poll hook captured",
    await page.evaluate(() => typeof window.__bayProofPoll === "function"),
  );
  assertProof("visible redacted diagnostics", await page.locator("#notice.show").isVisible(), {
    text: await page.locator("#notice").innerText(),
    title: await page.locator("#notice").getAttribute("title"),
  });
  const bayControl = {
    cards: await page.locator("#bay-control-board .bay-control-card").count(),
    review: await page.locator("#bay-control-board").innerText(),
    waiting_hover_label: await page
      .locator("#bay-control-board .bay-control-point title")
      .first()
      .evaluate((node) => node.textContent || ""),
    rate_hover_label: await page
      .locator("#bay-control-board .bay-control-point.rate title")
      .first()
      .evaluate((node) => node.textContent || ""),
    queue_items: await page.locator('[data-key="openclaw/openclaw#108001"]').count(),
    arriving_queue_samples: await page
      .locator('[data-stage="arriving"] [data-item^="queue:"]')
      .count(),
    queue_header: await page.locator('[data-stage="arriving"] h2').innerText(),
    queue_omission: await page.locator('[data-stage="arriving"] .overflow-note').count(),
    queue_omission_label: await page.locator('[data-stage="arriving"] .overflow-note').innerText(),
  };
  assertProof(
    "Bay mirrors cached exact-review admission, publication, and handoff telemetry",
    bayControl.cards === 3 &&
      /Review admission/i.test(bayControl.review) &&
      /Result publication/i.test(bayControl.review) &&
      /Queue handoff/i.test(bayControl.review) &&
      /waiting/.test(bayControl.waiting_hover_label) &&
      /\/ hour/.test(bayControl.rate_hover_label) &&
      bayControl.queue_items === 1 &&
      bayControl.arriving_queue_samples === 6 &&
      bayControl.queue_header === "ARRIVING 9" &&
      bayControl.queue_omission === 1 &&
      bayControl.queue_omission_label === "+3 queued IDs not shown",
    bayControl,
  );
  const terminalPoolCounts = {
    completed: await page.locator('[data-stage="completed"] .critter').count(),
    attention: await page.locator(".pool.attention .critter").count(),
    failed: await page.locator(".pool.attention .terminal-failed").count(),
    cancelled: await page.locator(".pool.attention .terminal-cancelled").count(),
  };
  assertProof(
    "completed and attention pools keep terminal outcomes distinct",
    (await page.locator(".pool .critter").count()) === 3 &&
      terminalPoolCounts.completed === 1 &&
      terminalPoolCounts.attention === 2 &&
      terminalPoolCounts.failed === 1 &&
      terminalPoolCounts.cancelled === 1,
    terminalPoolCounts,
  );
  const timingSummary = await page.locator("#overall-average").innerText();
  assertProof(
    "journey timing names the trigger-to-final-review duration",
    /Avg trigger.*final review/i.test(timingSummary) && /4 journeys/i.test(timingSummary),
    { text: timingSummary },
  );
  await capture(
    "01-initial-diagnostics",
    "Synthetic, redacted status fixture",
    "Real Bay route and assets; visible partial-telemetry diagnostic; three explicit terminal outcomes.",
  );
  await capture(
    "01a-mini-control-board",
    "Mini queue control board",
    "Bay reuses the dashboard’s cached six-hour review-admission, publication, and handoff telemetry; each sparkline point has an exact hover label.",
  );

  const originalHistory = healthHistory;
  const lastHistory = originalHistory.at(-1);
  const resetAt = new Date(Date.parse(lastHistory.at) + 15 * 60_000).toISOString();
  healthHistory = [
    ...originalHistory.slice(-3),
    {
      at: resetAt,
      exact_review: {
        collection_ok: true,
        review: { pending: 8, enqueued_total: 4, completed_total: 3, shed_total: 0 },
        publication: { pending: 1, enqueued_total: 2, completed_total: 1 },
      },
    },
  ];
  await page.evaluate(() => {
    window.__bayProofSetNow(Date.parse("2026-07-11T18:15:01.000Z"));
    window.__bayProofPoll();
  });
  await page.waitForFunction(() =>
    document
      .getElementById("bay-control-board")
      ?.textContent?.includes("Awaiting enough flow history"),
  );
  assertProof(
    "Bay does not reuse a stale rate after a history counter reset",
    /Awaiting enough flow history/.test(await page.locator("#bay-control-board").innerText()),
    { reset_at: resetAt },
  );
  healthHistory = originalHistory;
  await page.evaluate(() => {
    window.__bayProofSetNow(Date.parse("2026-07-11T18:30:01.000Z"));
    window.__bayProofPoll();
  });
  await page.waitForFunction(() =>
    document
      .getElementById("bay-control-board")
      ?.textContent?.includes("Stale · no rate sample in the last 12m"),
  );
  assertProof(
    "Bay marks a stalled cached history rate as stale",
    /History stale · awaiting current sample/.test(
      await page.locator("#bay-control-board").innerText(),
    ) &&
      /Stale · no rate sample in the last 12m/.test(
        await page.locator("#bay-control-board").innerText(),
      ),
    { last_history_at: originalHistory.at(-1)?.at, observed_at: "2026-07-11T18:30:01.000Z" },
  );
  healthHistory = originalHistory;

  const historyRequestsBeforeFailure = requests.filter(
    (request) => request.path === "/api/health-history",
  ).length;
  healthHistoryFailure = true;
  const failedHistory = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/health-history" && response.status() === 503,
  );
  await page.evaluate(() => {
    window.__bayProofSetNow(Date.parse("2026-07-11T18:45:01.000Z"));
    window.__bayProofPoll();
  });
  await failedHistory;
  await page.evaluate(() => {
    window.__bayProofSetNow(Date.parse("2026-07-11T18:45:21.000Z"));
    window.__bayProofPoll();
  });
  await page.waitForTimeout(80);
  const historyRequestsDuringFailure = requests.filter(
    (request) => request.path === "/api/health-history",
  ).length;
  healthHistoryFailure = false;
  const recoveredHistory = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/health-history" && response.status() === 200,
  );
  await page.evaluate(() => {
    window.__bayProofSetNow(Date.parse("2026-07-11T18:46:02.000Z"));
    window.__bayProofPoll();
  });
  await recoveredHistory;
  const historyRequestsAfterRecovery = requests.filter(
    (request) => request.path === "/api/health-history",
  ).length;
  assertProof(
    "mini control board throttles failed history fetches before retrying",
    historyRequestsDuringFailure === historyRequestsBeforeFailure + 1 &&
      historyRequestsAfterRecovery === historyRequestsDuringFailure + 1,
    {
      before_failure: historyRequestsBeforeFailure,
      during_failure: historyRequestsDuringFailure,
      after_recovery: historyRequestsAfterRecovery,
    },
  );

  const failedCollectionAt = originalHistory.at(-2)?.at;
  healthHistory = [
    originalHistory.at(-3),
    { at: failedCollectionAt, exact_review: { collection_ok: false } },
    originalHistory.at(-1),
  ];
  const failedCollectionHistory = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/health-history" && response.status() === 200,
  );
  await page.evaluate(() => {
    window.__bayProofSetNow(Date.parse("2026-07-11T18:48:03.000Z"));
    window.__bayProofPoll();
  });
  await failedCollectionHistory;
  await page.waitForFunction(() => {
    const path = document
      .querySelector("#bay-control-board .bay-control-card .bay-control-chart svg path")
      ?.getAttribute("d");
    return (path?.match(/M/g) || []).length === 2;
  });
  const failedCollectionPath = await page
    .locator("#bay-control-board .bay-control-card .bay-control-chart svg path")
    .first()
    .getAttribute("d");
  assertProof(
    "Bay renders failed history collections as a gap instead of a zero backlog",
    (failedCollectionPath?.match(/M/g) || []).length === 2,
    { review_pending_path: failedCollectionPath },
  );

  healthHistory = [
    originalHistory.at(-3),
    {
      at: originalHistory.at(-2)?.at,
      exact_review: {
        collection_ok: true,
        review: { pending: 31 },
        publication: { pending: 2 },
      },
    },
    originalHistory.at(-1),
  ];
  const pendingOnlyHistory = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/health-history" && response.status() === 200,
  );
  await page.evaluate(() => {
    window.__bayProofSetNow(Date.parse("2026-07-11T18:49:04.000Z"));
    window.__bayProofPoll();
  });
  await pendingOnlyHistory;
  await page.waitForFunction(
    () =>
      document
        .querySelector("#bay-control-board .bay-control-card .bay-control-chart svg")
        ?.querySelectorAll("circle.bay-control-point").length === 3,
  );
  const pendingOnlyPath = await page
    .locator("#bay-control-board .bay-control-card .bay-control-chart svg path")
    .first()
    .getAttribute("d");
  assertProof(
    "Bay retains legacy pending-only history samples",
    (pendingOnlyPath?.match(/M/g) || []).length === 1,
    { review_pending_path: pendingOnlyPath },
  );
  healthHistory = originalHistory;

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() =>
    document.getElementById("stage-grid")?.classList.contains("portrait-stack"),
  );
  await page.waitForTimeout(140);
  const portraitLayout = await page.evaluate(() => {
    const stages = Array.from(document.querySelectorAll("#stage-grid .stage")).map((stage) => {
      const rect = stage.getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      };
    });
    const terminal = document.getElementById("terminal-stack")?.getBoundingClientRect();
    const grid = document.getElementById("stage-grid");
    return {
      scroll_width: document.documentElement.scrollWidth,
      viewport_width: window.innerWidth,
      grid_columns: getComputedStyle(grid).gridTemplateColumns,
      stages,
      terminal_top: Math.round(terminal?.top || 0),
    };
  });
  assertProof(
    "portrait layout stacks the workflow from sand to waterline without horizontal overflow",
    portraitLayout.scroll_width <= portraitLayout.viewport_width + 1 &&
      portraitLayout.stages.length === 5 &&
      portraitLayout.stages.every((stage, index, stages) =>
        index === 0
          ? stage.left >= 0
          : Math.abs(stage.left - stages[0].left) <= 2 && stage.top >= stages[index - 1].bottom,
      ) &&
      portraitLayout.terminal_top >= portraitLayout.stages.at(-1).bottom,
    portraitLayout,
  );
  await capture(
    "01b-portrait-workflow",
    "Portrait workflow: top to bottom",
    "Phone portrait mode stacks Arriving through Applying vertically, then places the terminal pools at the waterline without horizontal scrolling.",
  );
  await page.setViewportSize({ width: 1900, height: 1000 });
  await page.waitForFunction(
    () => !document.getElementById("stage-grid")?.classList.contains("portrait-stack"),
  );
  await page.waitForTimeout(140);
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.locator('[data-brush="change"]').click();
  await page.evaluate(() => {
    window.__bayProofReduceMotion = false;
  });
  const claw = page.locator('[data-key="openclaw/openclaw#97722"] .sprite-claw-a');
  const clawStart = await claw.evaluate((node) =>
    Number(node.getAnimations()[0]?.currentTime || 0),
  );
  await page.waitForTimeout(280);
  const clawEnd = await claw.evaluate((node) => Number(node.getAnimations()[0]?.currentTime || 0));
  assertProof("crustacean claw animation advances", clawEnd > clawStart, {
    elapsed_animation_ms: Math.round(clawEnd - clawStart),
  });

  fixtureIndex = 1;
  await page.evaluate(async () => {
    await window.__bayProofPoll();
  });
  const mainItemKey = "openclaw/openclaw#97722";
  const mainKey = `[data-key="${mainItemKey}"]`;
  await page.locator(`${mainKey}.ready`).waitFor({ state: "visible", timeout: 5_000 });
  assertProof(
    "forward transition raises READY flag",
    await page.locator(`${mainKey} .ready-flag`).isVisible(),
  );
  await capture(
    "02-ready-for-sweep",
    "Forward transition: READY",
    "The item remains in Reviewing and raises its flag before any lane movement.",
  );

  await page.locator(`${mainKey}.being-swept`).waitFor({ state: "visible", timeout: 18_000 });
  const masterClaw = page.locator("#master .master-claw-a");
  const masterStart = await masterClaw.evaluate((node) =>
    Number(node.getAnimations()[0]?.currentTime || 0),
  );
  await page.waitForTimeout(280);
  const masterEnd = await masterClaw.evaluate((node) =>
    Number(node.getAnimations()[0]?.currentTime || 0),
  );
  assertProof("master sweeper animation advances", masterEnd > masterStart, {
    phase: await page.locator("#master").getAttribute("data-phase"),
    elapsed_animation_ms: Math.round(masterEnd - masterStart),
  });
  await capture(
    "03-physical-forward-sweep",
    "Forward transition: physical sweep",
    "The master and item are animated together; neither disappears between lanes.",
  );

  const appliedItem = page.locator(`${mainKey}.stage-applying`);
  await appliedItem.waitFor({ state: "visible", timeout: 10_000 });
  assertProof("forward transition lands in applying", await appliedItem.isVisible(), {
    destination: "applying",
  });
  await capture(
    "04-forward-landed",
    "Forward transition complete",
    "The same GitHub reference is now visibly placed in Applying, the final publication step before its terminal outcome.",
  );

  fixtureIndex = 2;
  await page.evaluate(async () => {
    await window.__bayProofPoll();
  });
  await page.locator(`${mainKey}.tunneling`).waitFor({ state: "visible", timeout: 5_000 });
  await page.locator("#tunnel-layer .tunnel-journey").waitFor({ state: "visible", timeout: 3_000 });
  await page.waitForFunction(
    () => {
      const target = document.querySelector(".tunnel-hole.target");
      return target && Number.parseFloat(getComputedStyle(target).opacity) > 0.25;
    },
    null,
    { timeout: 4_000 },
  );
  const sourceHoleCount = await page.locator(".tunnel-hole.source").count();
  const targetHoleCount = await page.locator(".tunnel-hole.target").count();
  const tunnelLabel = await page.locator(".burrow-label").innerText();
  const targetHoleOpacity = await page
    .locator(".tunnel-hole.target")
    .evaluate((node) => Number.parseFloat(getComputedStyle(node).opacity));
  assertProof(
    "retrigger uses tunnel journey",
    sourceHoleCount === 1 &&
      targetHoleCount === 1 &&
      tunnelLabel === `${mainItemKey} burrowing` &&
      targetHoleOpacity > 0.25,
    {
      source_hole: sourceHoleCount,
      target_hole: targetHoleCount,
      target_hole_opacity: targetHoleOpacity,
      label: tunnelLabel,
    },
  );
  await capture(
    "05-retrigger-tunnel",
    "New run detected: retrigger tunnel",
    "A changed run ID digs from Applying back toward Setting up with both tunnel openings visible.",
  );

  const resurfacedItem = page.locator(`${mainKey}.stage-setting-up.retriggered`);
  await resurfacedItem.waitFor({ state: "visible", timeout: 8_000 });
  assertProof("retrigger resurfaces in reported lane", await resurfacedItem.isVisible(), {
    destination: "setting-up",
    run_id: 1002,
  });
  await capture(
    "06-retrigger-resurfaced",
    "Retrigger resurfaced",
    "The same GitHub reference reappears in Setting up for its new run.",
  );

  await page.locator("#finder-input").fill("97722");
  await page.locator("#finder").evaluate((form) => form.requestSubmit());
  await page.locator(`${mainKey}.located`).waitFor({ state: "visible" });
  assertProof(
    "search locates GitHub reference",
    (await page.locator("#finder-status").innerText()) === "Found #97722",
    {
      focused_number: await page.evaluate(() =>
        document.activeElement?.getAttribute("data-number"),
      ),
    },
  );
  await capture(
    "07-search-highlight",
    "Where's my crustacean?",
    "Search focuses and highlights GitHub reference #97722 without another network request.",
  );

  await page.locator('[data-repo="openclaw/clawhub"]').click();
  const filteredKeys = await page
    .locator(".critter[data-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key")));
  assertProof(
    "repository filter isolates selected repo",
    filteredKeys.length === 2 && filteredKeys.every((key) => key?.startsWith("openclaw/clawhub#")),
    { visible_keys: filteredKeys },
  );
  await capture(
    "08-repository-filter",
    "Repository waters filter",
    "Only openclaw/clawhub active and terminal items remain visible.",
  );

  await page.locator('[data-key="openclaw/clawhub#3058"]').click({ force: true });
  await page.locator("#drawer[open]").waitFor({ state: "visible" });
  drawerLinks = await page.locator("#drawer .drawer-links a").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      label: anchor.textContent?.trim(),
      href: anchor.href,
      target: anchor.getAttribute("target"),
      rel: anchor.getAttribute("rel"),
    })),
  );
  assertProof(
    "drawer exposes safe GitHub links",
    drawerLinks.length === 3 &&
      drawerLinks.every((link) => new URL(link.href).hostname === "github.com") &&
      drawerLinks.every((link) => link.target === "_blank" && link.rel === "noopener"),
    { links: drawerLinks },
  );
  await capture(
    "09-detail-drawer-links",
    "Read-only detail drawer",
    "The selected item exposes only safe GitHub item, job, and workflow-run links.",
  );
  await page.locator("#drawer-close").click();
  await page.locator('[data-repo="all"]').click();

  tideBefore = await page
    .locator(".pool .critter[data-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key")).sort());
  const countdownBefore = await page.locator("#tide-countdown").innerText();
  const statusGetsBeforeTide = requests.filter((request) => request.path === "/api/status").length;
  await page.locator("#tide-preview").click();
  await page
    .locator('#beach.tide-active[data-tide-phase="incoming"]')
    .waitFor({ state: "visible" });
  tidePhases.push("incoming");
  const wave = page.locator("#beach .wave");
  const waveStart = await wave.evaluate((node) =>
    Number(node.getAnimations()[0]?.currentTime || 0),
  );
  await page.waitForFunction(
    (start) =>
      Number(document.querySelector("#beach .wave")?.getAnimations()[0]?.currentTime || 0) >
      Number(start),
    waveStart,
    { timeout: 1_500 },
  );
  const waveEnd = await wave.evaluate((node) => Number(node.getAnimations()[0]?.currentTime || 0));
  const tideLayerCount = await page
    .locator("#beach .tide-water, #beach .tide-foam-lace, #beach .tide-wet-sheen")
    .count();
  assertProof(
    "layered preview tide visibly animates",
    (await page.locator("#tide-preview").getAttribute("aria-busy")) === "true" &&
      waveEnd > waveStart &&
      tideLayerCount === 3,
    { elapsed_animation_ms: Math.round(waveEnd - waveStart), tide_layers: tideLayerCount },
  );
  await page.waitForFunction(
    () =>
      Number(document.querySelector("#beach .wave")?.getAnimations()[0]?.currentTime || 0) >= 1800,
    null,
    { timeout: 3_000 },
  );
  await capture(
    "10-preview-tide-incoming",
    "Tide incoming along the shoreline",
    "Layered translucent water, painted texture, foam, ripples, and bubbles approach the terminal pools.",
  );
  await page
    .locator('#beach.preview-tide-cleared[data-tide-phase="crest"]')
    .waitFor({ state: "visible", timeout: 5_000 });
  tidePhases.push("crest");
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".pool .critter")).every(
        (node) => Number(getComputedStyle(node).opacity) < 0.25,
      ),
    null,
    { timeout: 1_800 },
  );
  await capture(
    "11-preview-tide-crest",
    "Foam crest washes the terminal pools",
    "Terminal crustaceans drift seaward only inside the temporary local preview; live outcomes remain unchanged.",
  );
  await page
    .locator('#beach[data-tide-phase="receding"]')
    .waitFor({ state: "visible", timeout: 2_500 });
  tidePhases.push("receding");
  await page.locator("#beach.preview-tide-cleared").waitFor({ state: "hidden", timeout: 2_500 });
  await capture(
    "12-preview-tide-backwash",
    "Backwash leaves a wet-sand sheen",
    "The water and foam recede toward the illustrated sea while the preview crustaceans return.",
  );
  await page.waitForFunction(
    () => document.getElementById("tide-preview")?.getAttribute("aria-busy") === "false",
    null,
    { timeout: 8_000 },
  );
  tidePhases.push(await page.locator("#beach").getAttribute("data-tide-phase"));
  tideAfter = await page
    .locator(".pool .critter[data-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key")).sort());
  const countdownAfter = await page.locator("#tide-countdown").innerText();
  assertProof(
    "preview tide follows explicit visual phases",
    JSON.stringify(tidePhases) === JSON.stringify(["incoming", "crest", "receding", "idle"]),
    {
      phases: tidePhases,
    },
  );
  await capture(
    "13-preview-tide-restored",
    "Preview returns to live state",
    "The shoreline is restored and every terminal crustacean returns after the non-mutating preview.",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    window.__bayProofReduceMotion = true;
  });
  const reducedStart = await page.evaluate(() => performance.now());
  await page.locator("#tide-preview").click();
  await page.locator("#beach.tide-active").waitFor({ state: "visible" });
  await page.waitForTimeout(120);
  const reducedDuration = await page
    .locator("#beach")
    .evaluate((node) => node.style.getPropertyValue("--tide-duration"));
  const reducedAnimationName = await wave.evaluate((node) => getComputedStyle(node).animationName);
  await capture(
    "14-preview-tide-reduced-motion",
    "Reduced-motion tide cue",
    "Motion-sensitive users receive a brief static shoreline wash with the same non-mutating semantics.",
  );
  await page.waitForFunction(
    () => document.getElementById("tide-preview")?.getAttribute("aria-busy") === "false",
    null,
    { timeout: 1_500 },
  );
  const reducedElapsed = Math.round((await page.evaluate(() => performance.now())) - reducedStart);
  reducedTideAfter = await page
    .locator(".pool .critter[data-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key")).sort());
  assertProof(
    "reduced-motion tide is brief and non-spatial",
    reducedDuration === "520ms" &&
      reducedAnimationName === "none" &&
      reducedElapsed < 1_500 &&
      JSON.stringify(reducedTideAfter) === JSON.stringify(tideBefore),
    { duration: reducedDuration, animation_name: reducedAnimationName, elapsed_ms: reducedElapsed },
  );

  const statusGetsAfterTide = requests.filter((request) => request.path === "/api/status").length;
  assertProof("tide previews do not poll status", statusGetsAfterTide === statusGetsBeforeTide, {
    before_status_gets: statusGetsBeforeTide,
    after_status_gets: statusGetsAfterTide,
  });

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    window.__bayProofReduceMotion = false;
  });
  fixtureIndex = 3;
  await page.evaluate(async () => {
    await window.__bayProofPoll();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-stage="completed"] .critter[data-key]').length === 20,
    null,
    { timeout: 3_000 },
  );
  const denseCompletedCount = await page
    .locator('[data-stage="completed"] .critter[data-key]')
    .count();
  const denseOverflowCount = await page.locator('[data-stage="completed"] .overflow-note').count();
  assertProof(
    "dense completed pool renders every buffered outcome",
    denseCompletedCount === denseTerminalBuffer.length && denseOverflowCount === 0,
    { completed: denseCompletedCount, overflow_notes: denseOverflowCount },
  );
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.waitForFunction(
    () => document.querySelector('[data-stage="completed"]')?.getAttribute("data-cols") === "2",
    null,
    { timeout: 3_000 },
  );
  await page.waitForTimeout(1_000);
  const narrowTerminalPool = await page
    .locator('[data-stage="completed"] .ref')
    .evaluateAll((nodes) => {
      const references = nodes.map((node) => node.getBoundingClientRect());
      const overlaps = references.some((reference, index) =>
        references
          .slice(index + 1)
          .some(
            (other) =>
              reference.left < other.right &&
              reference.right > other.left &&
              reference.top < other.bottom &&
              reference.bottom > other.top,
          ),
      );
      return {
        references: references.length,
        overlaps,
        columns: document.querySelector('[data-stage="completed"]')?.getAttribute("data-cols"),
        overflow:
          document.querySelector('[data-stage="completed"] .overflow-note')?.textContent || null,
      };
    });
  assertProof(
    "completed pool keeps visible references readable at constrained width",
    narrowTerminalPool.references === 12 &&
      narrowTerminalPool.columns === "2" &&
      narrowTerminalPool.overflow === "+8 more in the tide buffer" &&
      !narrowTerminalPool.overlaps,
    narrowTerminalPool,
  );
  await page.setViewportSize({ width: 1900, height: 1000 });
  await page.waitForFunction(
    () => document.querySelector('[data-stage="completed"]')?.getAttribute("data-cols") === "4",
    null,
    { timeout: 3_000 },
  );
  await capture(
    "15-dense-terminal-pool",
    "Dense completed pool uses the available shoreline",
    "Twenty completed outcomes stay individually visible, with a larger four-column pool and no hidden overflow.",
  );
  const activeBeforeRealTide = await page
    .locator(".stage .critter[data-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key")).sort());
  fixtureIndex = 4;
  await page.evaluate(async () => {
    await window.__bayProofPoll();
  });
  await page
    .locator('#beach.tide-active[data-tide-mode="real"][data-tide-phase="incoming"]')
    .waitFor({ state: "visible", timeout: 3_000 });
  await page
    .locator('#beach.tide-washing[data-tide-mode="real"][data-tide-phase="crest"]')
    .waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll(".pool .critter")).every(
        (node) => Number(getComputedStyle(node).opacity) < 0.25,
      ),
    null,
    { timeout: 1_800 },
  );
  const realWashCount = await page.locator(".pool .critter[data-key]").count();
  const realUsesPreviewClass = await page
    .locator("#beach")
    .evaluate((node) => node.classList.contains("preview-tide-cleared"));
  await page.waitForFunction(
    () => document.querySelectorAll(".pool .critter[data-key]").length === 0,
    null,
    { timeout: 2_000 },
  );
  await capture(
    "16-real-tide-cleared",
    "Real tide clears only after the wash",
    "A generated tide first moves the proved terminal crustaceans seaward, then commits the empty shared buffer.",
  );
  await page.waitForFunction(
    () => document.getElementById("tide-preview")?.getAttribute("aria-busy") === "false",
    null,
    { timeout: 8_000 },
  );
  const activeAfterRealTide = await page
    .locator(".stage .critter[data-key]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-key")).sort());
  const realCountdown = await page.locator("#tide-countdown").innerText();
  assertProof(
    "real tide washes terminal outcomes before clearing",
    realWashCount === denseTerminalBuffer.length &&
      !realUsesPreviewClass &&
      (await page.locator(".pool .critter[data-key]").count()) === 0 &&
      realCountdown === "0 / 20" &&
      JSON.stringify(activeAfterRealTide) === JSON.stringify(activeBeforeRealTide),
    {
      washed_terminal_count: realWashCount,
      preview_class_used: realUsesPreviewClass,
      terminal_after: 0,
      countdown: realCountdown,
      active_keys_unchanged:
        JSON.stringify(activeAfterRealTide) === JSON.stringify(activeBeforeRealTide),
    },
  );

  await page.evaluate(() => {
    window.__bayProofReduceMotion = true;
  });
  fixtureIndex = 5;
  await page.evaluate(async () => {
    await window.__bayProofPoll();
  });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-key="openclaw/openclaw#108002"]').length === 1,
    null,
    { timeout: 3_000 },
  );
  const queueReconciliation = {
    in_setting_up: await page
      .locator('[data-stage="setting-up"] [data-key="openclaw/openclaw#108002"]')
      .count(),
    in_reviewing: await page
      .locator('[data-stage="reviewing"] [data-key="openclaw/openclaw#108002"]')
      .count(),
    setting_up_header: await page.locator('[data-stage="setting-up"] h2').innerText(),
  };
  assertProof(
    "live workers take precedence over their durable queue stage",
    queueReconciliation.in_setting_up === 0 &&
      queueReconciliation.in_reviewing === 1 &&
      queueReconciliation.setting_up_header === "SETTING UP 9",
    queueReconciliation,
  );

  fixtureIndex = 6;
  await page.evaluate(async () => {
    await window.__bayProofPoll();
  });
  await page.getByRole("button", { name: /openclaw\/openclaw/i }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-stage="arriving"] .critter').length === 24,
    null,
    { timeout: 3_000 },
  );
  const filteredQueueOverflow = await page
    .locator('[data-stage="arriving"] .overflow-note')
    .innerText();
  assertProof(
    "filtered lanes label omitted queue rows as queued",
    /^\+\d+ queued IDs? not shown$/.test(filteredQueueOverflow),
    { overflow: filteredQueueOverflow },
  );

  const totalStatusGets = requests.filter((request) => request.path === "/api/status").length;
  const healthHistoryGets = requests.filter(
    (request) => request.path === "/api/health-history",
  ).length;
  const mutatingRequests = requests.filter((request) => !["GET", "HEAD"].includes(request.method));
  const directGitHubRequests = requests.filter((request) =>
    request.host.toLowerCase().startsWith("api.github.com"),
  );
  assertProof(
    "preview tide preserves live outcome data",
    JSON.stringify(tideAfter) === JSON.stringify(tideBefore) &&
      JSON.stringify(reducedTideAfter) === JSON.stringify(tideBefore) &&
      countdownAfter === countdownBefore,
    {
      before_keys: tideBefore,
      after_keys: tideAfter,
      reduced_motion_after_keys: reducedTideAfter,
      countdown: countdownAfter,
    },
  );
  assertProof("preview tide sends no mutation", mutatingRequests.length === 0, {
    mutating_requests: mutatingRequests,
  });
  assertProof("browser sends no GitHub API request", directGitHubRequests.length === 0, {
    direct_github_requests: 0,
  });
  assertProof(
    "mini control board reads cached dashboard history once per minute",
    healthHistoryGets === 7,
    { health_history_gets: healthHistoryGets },
  );
  const unexpectedConsoleErrors = consoleErrors.filter(
    (error) =>
      error !==
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
  );
  assertProof("no unexpected browser console errors", unexpectedConsoleErrors.length === 0, {
    errors: unexpectedConsoleErrors,
  });
  assertProof("no uncaught page errors", pageErrors.length === 0, { errors: pageErrors });

  const diagnostics = {
    fixture: "synthetic + redacted",
    status_gets: totalStatusGets,
    health_history_gets: healthHistoryGets,
    direct_github_api_requests: directGitHubRequests.length,
    mutating_requests: mutatingRequests.length,
    preview_terminal_before: tideBefore.length,
    preview_terminal_after: reducedTideAfter.length,
    dense_terminal_completed: denseCompletedCount,
    real_tide_terminal_after: 0,
    assertions_passed: assertions.length,
  };
  await page.evaluate((data) => {
    const node = document.createElement("aside");
    node.id = "playwright-proof-diagnostics";
    Object.assign(node.style, {
      position: "fixed",
      zIndex: "1001",
      right: "18px",
      bottom: "88px",
      width: "360px",
      padding: "15px 17px",
      border: "2px solid #a7e1db",
      borderRadius: "14px",
      background: "rgba(248,255,253,.97)",
      boxShadow: "0 14px 32px rgba(25,75,76,.25)",
      color: "#174e52",
      font: "750 13px/1.45 ui-monospace,monospace",
      pointerEvents: "none",
    });
    const heading = document.createElement("strong");
    heading.textContent = "PLAYWRIGHT DIAGNOSTICS · REDACTED";
    heading.style.display = "block";
    heading.style.marginBottom = "7px";
    heading.style.color = "#c74f32";
    node.append(heading);
    for (const [key, value] of Object.entries(data)) {
      const row = document.createElement("div");
      row.textContent = `${key.replaceAll("_", " ")}: ${value}`;
      node.append(row);
    }
    document.body.append(node);
  }, diagnostics);
  await capture(
    "17-visible-proof-diagnostics",
    "Network and state boundary",
    "Visible diagnostics confirm no GitHub API or mutation request, unchanged preview data, and a proved real clear.",
  );
} catch (error) {
  proofError = error;
} finally {
  await context.tracing.stop({ path: path.join(outputDir, "trace.zip") });
  await context.close();
}

if (proofError) {
  await browser.close();
  throw proofError;
}

const manifest = {
  proof: "OpenClaw Bay deterministic Playwright browser proof",
  source_sha: sourceSha,
  route: "/bay-demo",
  data_classification: "fully synthetic and redacted; no live/private dashboard payloads",
  fixture_sha256: fixtureSha256,
  fixture_snapshots: fixtureSnapshotSha256,
  derived_real_tide_snapshot_sha256: realTideSnapshotSha256,
  generated_at: new Date().toISOString(),
  assertions,
  evidence: evidence.map(({ file: _file, ...item }, index) => ({
    ...item,
    storyboard_panel: index + 1,
  })),
  tide_isolation: {
    phases: tidePhases,
    before_keys: tideBefore,
    after_keys: tideAfter,
    reduced_motion_after_keys: reducedTideAfter,
    real_tide_terminal_after: 0,
  },
  drawer_links: drawerLinks,
  network: {
    requests,
    responses,
    direct_github_api_requests: requests.filter((request) =>
      request.host.toLowerCase().startsWith("api.github.com"),
    ).length,
    mutating_requests: requests.filter((request) => !["GET", "HEAD"].includes(request.method))
      .length,
  },
  console_errors: consoleErrors,
  page_errors: pageErrors,
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
}

const cards = [];
for (const item of evidence) {
  const bytes = await readFile(path.join(outputDir, item.file));
  cards.push(
    `<article><div class="copy"><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.detail)}</p></div><img src="data:image/jpeg;base64,${bytes.toString("base64")}" alt="${escapeHtml(item.title)}"></article>`,
  );
}
const reportHtml = `<!doctype html><html><head><meta charset="utf-8"><title>OpenClaw Bay Playwright proof</title><style>
*{box-sizing:border-box}body{margin:0;padding:28px;background:#edf7f5;color:#263533;font:16px/1.45 system-ui,sans-serif}header{max-width:1640px;margin:0 auto 24px;padding:24px 28px;border-radius:18px;background:#174e52;color:white;box-shadow:0 14px 35px rgba(24,67,69,.18)}header h1{margin:0 0 8px;font-size:34px}header p{margin:4px 0;color:#d9f1ed}.pass{display:inline-block;margin-top:12px;padding:7px 11px;border-radius:999px;background:#dff5dc;color:#174e52;font-weight:850}.grid{max-width:1640px;margin:auto;display:grid;grid-template-columns:1fr 1fr;gap:22px}article{overflow:hidden;border:1px solid #b8d3cf;border-radius:16px;background:white;box-shadow:0 10px 25px rgba(25,70,70,.11)}.copy{min-height:112px;padding:16px 18px;border-bottom:1px solid #d6e5e2}.copy h2{margin:0 0 6px;color:#bc4b31;font-size:21px}.copy p{margin:0;color:#536864}img{display:block;width:100%;height:auto}@media(max-width:900px){.grid{grid-template-columns:1fr}}
</style></head><body><header><h1>OpenClaw Bay · deterministic Playwright proof</h1><p>Real <code>/bay-demo</code> page and artwork; only dashboard reads <code>/api/status</code> and <code>/api/health-history</code> are replaced with fully synthetic, redacted fixtures.</p><p>Source ${escapeHtml(sourceSha)} · fixture SHA-256 ${escapeHtml(fixtureSha256)}</p><span class="pass">${assertions.length} assertions passed · 0 GitHub API requests · 0 mutation requests</span></header><main class="grid">${cards.join("")}</main></body></html>`;
const reportPath = path.join(outputDir, "playwright-proof-report.html");
await writeFile(reportPath, reportHtml);

const reportContext = await browser.newContext({
  viewport: { width: 1700, height: 900 },
  deviceScaleFactor: 1,
});
const reportPage = await reportContext.newPage();
await reportPage.goto(pathToFileURL(reportPath).href, { waitUntil: "load" });
await reportPage.screenshot({
  path: path.join(outputDir, "playwright-proof-storyboard.jpg"),
  type: "jpeg",
  quality: 86,
  fullPage: true,
});
await reportContext.close();
await browser.close();

console.log(
  JSON.stringify(
    {
      ok: true,
      source_sha: sourceSha,
      fixture_sha256: fixtureSha256,
      assertions: assertions.length,
      evidence_frames: evidence.length,
      direct_github_api_requests: manifest.network.direct_github_api_requests,
      mutating_requests: manifest.network.mutating_requests,
      output_dir: outputDir,
    },
    null,
    2,
  ),
);
