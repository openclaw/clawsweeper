import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const origin = String(process.env.BAY_LIFECYCLE_PROOF_ORIGIN || "").replace(/\/+$/, "");
const secret = String(process.env.BAY_LIFECYCLE_PROOF_SECRET || "");
const outputDir = path.resolve(
  process.env.BAY_LIFECYCLE_PROOF_OUTPUT || ".artifacts/bay-lifecycle-metrics",
);
if (!origin || !secret) throw new Error("Bay lifecycle proof origin and secret are required");

const publicRepository = "openclaw/openclaw";
const privateRepository = "example/private";
// This controlled real-runtime fixture exercises only commands because an
// authenticated command acknowledgement is the public final-review receipt.
// Automatic ingress is covered separately by the focused lifecycle tests,
// where its distinct correlated GitHub-effect receipt can be constructed.
const sources = ["review", "re_review"];
const triggeredAt = new Date(Date.now() - 90_000).toISOString();
const assertions = [];

await mkdir(outputDir, { recursive: true });

function assertProof(name, condition, details = {}) {
  if (!condition) throw new Error(`Proof assertion failed: ${name} ${JSON.stringify(details)}`);
  assertions.push({ name, status: "PASS", ...details });
}

function signature(body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function signedPost(pathname, value) {
  const body = JSON.stringify(value);
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature(body),
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function decision(repository, itemNumber, sourceAction) {
  const command = sourceAction === "review" || sourceAction === "re_review";
  return {
    targetRepo: repository,
    targetBranch: "main",
    itemNumber,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction,
    supersedesInProgress: sourceAction === "edited" || sourceAction === "synchronize",
    sourceUpdatedAt: triggeredAt,
    ...(command
      ? {
          commandStatusMarker: `<!-- clawsweeper-command-status:${itemNumber}:${sourceAction}:${"a".repeat(40)} -->`,
          statusCommentId: 90_000 + itemNumber,
        }
      : {}),
  };
}

async function admitAndComplete(repository, itemNumber, sourceAction) {
  const identity = `${repository}#${itemNumber}`;
  const admitted = await signedPost("/internal/exact-review/enqueue", {
    delivery_id: `bay-lifecycle-proof:${repository}:${itemNumber}:v1`,
    decision: decision(repository, itemNumber, sourceAction),
  });
  assertProof(
    "Durable lifecycle admission is queued",
    admitted?.ok === true && admitted?.queued === true,
    {
      repository,
      item_number: itemNumber,
      source_action: sourceAction,
    },
  );
  const canonical = await signedPost("/internal/exact-review/lifecycle/canonical-receipt", {
    canonical_target_key: identity,
    fence_key: identity,
    revision: 1,
    outcome: "accepted",
    receipt_id: `bay-lifecycle-proof:${repository}:${itemNumber}:canonical`,
  });
  assertProof("Canonical lifecycle receipt is accepted", canonical?.ok === true, {
    repository,
    item_number: itemNumber,
  });
  const router = await signedPost("/internal/exact-review/lifecycle/router-receipt", {
    canonical_target_key: identity,
    fence_key: identity,
    revision: 1,
    outcome: "durable",
    receipt_id: `bay-lifecycle-proof:${repository}:${itemNumber}:router`,
  });
  assertProof("Router lifecycle receipt is accepted", router?.ok === true, {
    repository,
    item_number: itemNumber,
  });
  const completed = await signedPost("/internal/exact-review/lifecycle/terminal-disposition", {
    canonical_target_key: identity,
    fence_key: identity,
    revision: 1,
    kind: "review_completed_routed",
  });
  assertProof("Durable lifecycle completion is accepted", completed?.ok === true, {
    repository,
    item_number: itemNumber,
  });
  if (sourceAction === "review" || sourceAction === "re_review") {
    const attempt = await signedPost("/internal/exact-review/lifecycle/command-ack/attempt", {
      canonical_target_key: identity,
      fence_key: identity,
      revision: 1,
      status_marker: decision(repository, itemNumber, sourceAction).commandStatusMarker,
      status_comment_id: 90_000 + itemNumber,
    });
    assertProof("Final command acknowledgement is authorized", attempt?.allowed === true, {
      repository,
      item_number: itemNumber,
    });
    const acknowledgement = await signedPost(
      "/internal/exact-review/lifecycle/command-ack/observed",
      {
        canonical_target_key: identity,
        fence_key: identity,
        revision: 1,
        status_marker: decision(repository, itemNumber, sourceAction).commandStatusMarker,
        command_comment_id: 81_000 + itemNumber,
        completion_comment_id: 90_000 + itemNumber,
        status_comment_id: 90_000 + itemNumber,
        observed_at: Date.now(),
      },
    );
    assertProof(
      "Correlated final command receipt is accepted",
      acknowledgement?.accepted === true,
      {
        repository,
        item_number: itemNumber,
      },
    );
  }
}

for (let index = 0; index < 21; index += 1) {
  await admitAndComplete(publicRepository, 95_000 + index, sources[index % sources.length]);
}
await admitAndComplete(privateRepository, 96_000, "review");

const statusResponse = await fetch(`${origin}/api/status`, { cache: "no-store" });
if (!statusResponse.ok) throw new Error(`/api/status returned ${statusResponse.status}`);
const status = await statusResponse.json();
const bay = status?.bay;
assertProof(
  "Public status is sourced from durable lifecycle metrics",
  bay?.metrics_state === "warming",
  {
    metrics_state: bay?.metrics_state,
  },
);
assertProof(
  "Warming coverage retains only verified completed journey pairs",
  bay?.timings?.overall?.samples === 21 &&
    Number.isFinite(bay?.timings?.overall?.average_ms) &&
    Number.isFinite(bay?.timings?.overall?.median_ms),
  {
    samples: bay?.timings?.overall?.samples,
    average_ms: bay?.timings?.overall?.average_ms,
    median_ms: bay?.timings?.overall?.median_ms,
    sample_kind: bay?.timings?.sample_kind,
  },
);
assertProof(
  "Timing preserves the v1 source enum and adds final-review receipt provenance",
  bay?.timings?.sample_kind === "completed_review_journeys" &&
    bay?.timings?.source === "durable_exact_review_lifecycles" &&
    bay?.timings?.completion_source === "verified_final_review_receipts",
  {
    sample_kind: bay?.timings?.sample_kind,
    source: bay?.timings?.source,
    completion_source: bay?.timings?.completion_source,
  },
);
assertProof(
  "Verified terminal journeys advance the durable tide independently of aggregate coverage",
  bay?.tide_generation === 1 &&
    bay?.terminal_count === 1 &&
    Array.isArray(bay?.terminal_buffer) &&
    bay.terminal_buffer.length === 1 &&
    Number.isFinite(bay.terminal_buffer[0]?.journey_duration_ms),
  {
    tide_generation: bay?.tide_generation,
    terminal_count: bay?.terminal_count,
    terminal_buffer: bay?.terminal_buffer,
  },
);
assertProof(
  "The private lifecycle completion remains excluded from the public aggregate",
  bay?.timings?.overall?.samples === 21 &&
    Array.isArray(bay?.terminal_buffer) &&
    bay.terminal_buffer.every((entry) => entry?.repository === publicRepository),
  {
    samples: bay?.timings?.overall?.samples,
    terminal_buffer: bay?.terminal_buffer,
  },
);
assertProof(
  "The durable tide reports its verified completion time",
  typeof bay?.last_tide_at === "string",
  {
    last_tide_at: bay?.last_tide_at,
  },
);

const browserPath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  "/ms-playwright/chromium-1223/chrome-linux64/chrome";
const browser = await chromium.launch({
  headless: true,
  executablePath: browserPath,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-proxy-server"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`${origin}/bay`, { waitUntil: "networkidle" });
  await page.locator("#loading").waitFor({ state: "hidden" });
  const timingSummary = await page.locator("#overall-average").innerText();
  assertProof(
    "The rendered Bay page preserves authoritative warming coverage",
    timingSummary.toLowerCase().includes("calibrating end-to-end coverage"),
    { timing_summary: timingSummary, metrics_state: bay?.metrics_state },
  );
  assertProof(
    "The rendered Bay page preserves durable tide progress during warming",
    (await page.locator("#tide-countdown").innerText()).trim() === "1 / 20",
    { countdown: await page.locator("#tide-countdown").innerText() },
  );
  const completedLaneHeading = await page
    .locator('#terminal-stack [data-stage="completed"] h2')
    .innerText();
  assertProof(
    "The rendered completed lane shows the verified terminal journey",
    completedLaneHeading.startsWith("COMPLETED 1"),
    { completed_lane: completedLaneHeading },
  );
  assertProof(
    "The rendered Bay page labels the verified last tide",
    (await page.locator("#tide-summary").innerText()).startsWith("Last tide "),
    { tide_summary: await page.locator("#tide-summary").innerText() },
  );
  assertProof(
    "The rendered terminal card states its verified total journey duration",
    (await page.locator(".pool .journey-duration").innerText()).startsWith("Journey "),
    { duration: await page.locator(".pool .journey-duration").innerText() },
  );
  await page.screenshot({
    path: path.join(outputDir, "bay-lifecycle-metrics.png"),
    fullPage: true,
  });
  await page.close();
} finally {
  await browser.close();
}

const summary = {
  proof: "Authoritative OpenClaw Bay lifecycle metrics",
  environment: "local Wrangler Worker plus Durable Object",
  trigger_sources: sources,
  public_completions: 21,
  excluded_private_completions: 1,
  status: {
    metrics_state: bay?.metrics_state,
    timing_samples: bay?.timings?.overall?.samples,
    tide_generation: bay?.tide_generation,
    terminal_count: bay?.terminal_count,
    last_tide_at: bay?.last_tide_at,
  },
  assertions,
  artifacts: ["bay-lifecycle-metrics.png", "proof-summary.json"],
  limits: [
    "The one-hour timing coverage window is intentionally still warming in this short proof; the aggregate UI withholds its partial typical-duration statistic, while individually verified terminal cards and tide progress remain visible.",
    "The proof uses local signed lifecycle traffic and does not call GitHub or mutate production state.",
  ],
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({ ok: true, assertions: assertions.length, status: summary.status }));
