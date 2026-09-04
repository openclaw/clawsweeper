#!/usr/bin/env node

const statusUrl = trimTrailingSlash(
  process.env.CLAWSWEEPER_STATUS_URL || "https://clawsweeper.openclaw.ai",
);
const ingestUrl = process.env.CLAWSWEEPER_STATUS_INGEST_URL || `${statusUrl}/api/events`;
const ingestToken = process.env.CLAWSWEEPER_STATUS_INGEST_TOKEN || "";
const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const limit = positiveInt(process.env.CLAWSWEEPER_STATUS_CI_LIMIT, 25);
const badConclusions = new Set([
  "failure",
  "timed_out",
  "action_required",
  "cancelled",
  "startup_failure",
]);

async function main() {
  if (!ingestToken) {
    console.log("dashboard CI refresh skipped: CLAWSWEEPER_STATUS_INGEST_TOKEN is not configured");
    return;
  }

  const status = await fetchJson(`${statusUrl}/api/status`);
  const rows = Array.isArray(status.pipeline) ? status.pipeline : [];
  const targets = uniquePrTargets(rows).slice(0, limit);
  const posted = [];

  for (const target of targets) {
    const ci = await targetCiStatus(target).catch((error) => ({
      ...target,
      state: "unknown",
      total: 0,
      failing: 0,
      pending: 0,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (ci.total < 1 && ci.state === "unknown") continue;
    await postEvent({
      event_type: "ci.status",
      mode: target.mode || "pipeline",
      stage: "checks",
      status: ci.state,
      repository: target.repository,
      item_number: target.item_number,
      item_url: `https://github.com/${target.repository}/pull/${target.item_number}`,
      run_url: target.run_url || null,
      title: target.title || `${target.repository}#${target.item_number}`,
      ci: {
        source: "github-checks",
        state: ci.state,
        label: ci.label || null,
        repository: target.repository,
        item_number: target.item_number,
        item_url: `https://github.com/${target.repository}/pull/${target.item_number}`,
        run_url: target.run_url || null,
        head_sha: ci.head_sha || null,
        total: ci.total,
        failing: ci.failing,
        pending: ci.pending,
        updated_at: new Date().toISOString(),
      },
    });
    posted.push(`${target.repository}#${target.item_number}:${ci.state}`);
  }

  console.log(JSON.stringify({ ok: true, targets: targets.length, posted }, null, 2));
}

function uniquePrTargets(rows) {
  const seen = new Set();
  const targets = [];
  for (const row of rows) {
    if (!row.repository || !Number.isInteger(row.item_number)) continue;
    const key = `${row.repository}#${row.item_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(row);
  }
  return targets;
}

async function targetCiStatus(target) {
  const pr = await githubJson(`/repos/${target.repository}/pulls/${target.item_number}`);
  const headSha = pr?.head?.sha;
  if (!headSha)
    throw new Error(`missing PR head SHA for ${target.repository}#${target.item_number}`);
  const [checks, combined] = await Promise.all([
    githubJson(`/repos/${target.repository}/commits/${headSha}/check-runs?per_page=100`),
    githubJson(`/repos/${target.repository}/commits/${headSha}/status`).catch(() => null),
  ]);
  const checkRuns = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  const statuses = Array.isArray(combined?.statuses) ? combined.statuses : [];
  const failingChecks = checkRuns.filter(
    (check) => check.status === "completed" && badConclusions.has(String(check.conclusion)),
  );
  const pendingChecks = checkRuns.filter((check) => check.status !== "completed");
  const failingStatuses = statuses.filter((status) =>
    ["failure", "error"].includes(String(status.state)),
  );
  const pendingStatuses = statuses.filter((status) => status.state === "pending");
  const total = checkRuns.length + statuses.length;
  const failing = failingChecks.length + failingStatuses.length;
  const pending = pendingChecks.length + pendingStatuses.length;
  const state = failing ? "red" : pending ? "pending" : total ? "green" : "unknown";
  return {
    head_sha: headSha,
    state,
    total,
    failing,
    pending,
    label: `${checkRuns.length} checks, ${statuses.length} statuses`,
  };
}

async function postEvent(event) {
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ingestToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  if (!response.ok)
    throw new Error(`dashboard ingest returned ${response.status}: ${await response.text()}`);
}

async function githubJson(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "openclaw-clawsweeper-dashboard-ci",
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
