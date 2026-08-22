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
const sources = ["opened", "synchronize", "edited", "review", "re_review"];
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
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction,
    supersedesInProgress: sourceAction === "edited" || sourceAction === "synchronize",
    sourceUpdatedAt: command ? undefined : triggeredAt,
    ...(command
      ? {
          sourceCommentId: 80_000 + itemNumber,
          sourceCommentUpdatedAt: triggeredAt,
          commandStatusMarker: `<!-- clawsweeper-command-status:${itemNumber}:${sourceAction}:${"a".repeat(40)} -->`,
          statusCommentId: 90_000 + itemNumber,
          commandBodyDigest: "a".repeat(64),
          commandOrigin: "hosted_webhook",
          sourceCommentVerified: true,
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
}

for (let index = 0; index < 21; index += 1) {
  await admitAndComplete(publicRepository, 95_000 + index, sources[index % sources.length]);
}
await admitAndComplete(privateRepository, 96_000, "opened");

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
  "Lifecycle timing samples include every review trigger source",
  bay?.timings?.overall?.samples === 21,
  {
    samples: bay?.timings?.overall?.samples,
    sample_kind: bay?.timings?.sample_kind,
  },
);
assertProof(
  "Timing preserves the v1 sample kind and identifies its durable lifecycle source",
  bay?.timings?.sample_kind === "completed_review_journeys" &&
    bay?.timings?.source === "durable_exact_review_lifecycles",
  {
    sample_kind: bay?.timings?.sample_kind,
    source: bay?.timings?.source,
  },
);
assertProof(
  "Twenty public completions advance the durable completed lane",
  bay?.tide_generation === 1,
  {
    tide_generation: bay?.tide_generation,
    terminal_count: bay?.terminal_count,
  },
);
assertProof(
  "The twenty-first public completion remains in the next tide",
  bay?.terminal_count === 1,
  {
    terminal_count: bay?.terminal_count,
  },
);
assertProof(
  "The private lifecycle completion is excluded from the public aggregate",
  bay?.terminal_count === 1 && bay?.tide_generation === 1,
  {
    tide_generation: bay?.tide_generation,
    terminal_count: bay?.terminal_count,
  },
);
assertProof("The completed lane records its last tide", typeof bay?.last_tide_at === "string", {
  last_tide_at: bay?.last_tide_at,
});

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
    timingSummary.toLowerCase().includes("calibrating complete lifecycle coverage"),
    { timing_summary: timingSummary, metrics_state: bay?.metrics_state },
  );
  assertProof(
    "The rendered Bay page shows the authoritative completed lane",
    (await page.locator("#tide-countdown").innerText()).trim() === "1 / 20",
    { countdown: await page.locator("#tide-countdown").innerText() },
  );
  const completedLaneHeading = await page
    .locator('#terminal-stack [data-stage="completed"] h2')
    .innerText();
  assertProof(
    "The rendered completed lane retains its finished revision when active work overlaps it",
    completedLaneHeading.startsWith("COMPLETED 1"),
    { completed_lane: completedLaneHeading },
  );
  await page
    .locator('#terminal-stack [data-stage="completed"] [data-reference]')
    .first()
    .click({ force: true });
  const terminalDrawerStage = (await page.locator("#drawer-badges").innerText()).trim();
  assertProof(
    "A completed card retains its terminal identity when its review is still active",
    terminalDrawerStage.toLowerCase() === "completed",
    { terminal_drawer_stage: terminalDrawerStage },
  );
  await page.locator("#drawer-close").click();
  assertProof(
    "The rendered Bay page shows the authoritative last tide",
    (await page.locator("#tide-summary").innerText()).startsWith("Last tide "),
    { tide_summary: await page.locator("#tide-summary").innerText() },
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
    "The one-hour timing coverage window is intentionally still warming in this short proof; the aggregate has all 21 source completions, while the UI withholds a partial average until coverage is complete.",
    "The proof uses local signed lifecycle traffic and does not call GitHub or mutate production state.",
  ],
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify({ ok: true, assertions: assertions.length, status: summary.status }));
