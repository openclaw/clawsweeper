import type { ReviewUsageDataset } from "./review-usage.ts";

export type DashboardEnv = Record<string, unknown> & {
  REVIEW_USAGE?: ReviewUsageDataset;
};

function issueTriagePageConfig() {
  return {
    title: "ClawSweeper Triage",
    endpoint: "/api/triage",
    defaultView: "clawsweeper",
    navLabel: "Issue triage views",
    aggregateViews: [
      {
        id: "clawsweeper",
        title: "ClawSweeper",
        description: "Open issues carrying any ClawSweeper label.",
      },
      {
        id: "ready-candidates",
        title: "Ready candidates",
        description: "Queueable fixes without a no-new-fix-pr blocker.",
      },
      {
        id: "queueable-blocked",
        title: "Queueable but blocked",
        description: "Queueable-looking fixes with a no-new-fix-pr blocker.",
      },
      {
        id: "already-has-pr",
        title: "Already has PR",
        description: "Issues where an open linked pull request was found.",
      },
      {
        id: "needs-info",
        title: "Needs info",
        description: "Issues needing more reporter detail before verification.",
      },
      {
        id: "needs-maintainer-review",
        title: "Needs maintainer review",
        description: "Issues where a maintainer decision is the next useful step.",
      },
      {
        id: "product-security",
        title: "Product or security",
        description: "Issues needing product, behavior, or security-sensitive review.",
      },
      {
        id: "needs-live-repro",
        title: "Needs live repro",
        description: "Issues where live validation would improve confidence.",
      },
    ],
    links: [
      { href: "/", label: "Live pipeline" },
      { href: "/pr-proof-triage", label: "PR proof triage" },
    ],
    metrics: [
      {
        label: "ClawSweeper issues",
        view: "clawsweeper",
        detail: "any discovered clawsweeper label",
      },
      { label: "Ready candidates", view: "ready-candidates", detail: "queueable and unblocked" },
      { label: "Blocked queue", view: "queueable-blocked", detail: "queueable but no-new-fix-pr" },
      { label: "Linked PRs", view: "already-has-pr", detail: "open fix PR already found" },
      {
        label: "Needs review",
        view: "needs-maintainer-review",
        detail: "maintainer decision next",
      },
      { label: "Product/security", view: "product-security", detail: "policy or security call" },
    ],
  };
}

function prProofTriagePageConfig() {
  return {
    title: "ClawSweeper PR Proof Triage",
    endpoint: "/api/pr-proof-triage",
    defaultView: "missing-proof",
    navLabel: "Pull request proof triage views",
    aggregateViews: [
      {
        id: "proof-triage",
        title: "Proof triage",
        description: "Open pull requests carrying a closed proof-triage category.",
      },
      {
        id: "needs-proof",
        title: "Needs proof",
        description: "Open pull requests where real behavior proof is requested.",
      },
      {
        id: "missing-proof",
        title: "Needs proof review",
        description: "Proof is requested but not yet marked sufficient or overridden.",
      },
      {
        id: "sufficient-proof",
        title: "Proof sufficient",
        description: "Open pull requests whose proof gate appears satisfied.",
      },
      {
        id: "mock-only-proof",
        title: "Mock-only proof",
        description: "Open pull requests whose proof needs a stronger real-behavior signal.",
      },
      {
        id: "telegram-proof",
        title: "Telegram proof",
        description: "Open pull requests awaiting the closed Telegram proof category.",
      },
      {
        id: "sufficient-with-need-label",
        title: "Sufficient plus needs label",
        description: "Open pull requests with sufficient proof and a remaining needs-proof state.",
      },
    ],
    links: [
      { href: "/", label: "Live pipeline" },
      { href: "/triage", label: "Issue triage" },
    ],
    metrics: [
      { label: "Proof triage PRs", view: "proof-triage", detail: "proof-related labels" },
      { label: "Needs proof", view: "needs-proof", detail: "real behavior proof requested" },
      { label: "Needs proof review", view: "missing-proof", detail: "most stuck bucket" },
      {
        label: "Proof sufficient",
        view: "sufficient-proof",
        detail: "proof gate appears satisfied",
      },
      { label: "Mock-only proof", view: "mock-only-proof", detail: "needs stronger proof" },
    ],
  };
}

type TriagePageConfig =
  | ReturnType<typeof issueTriagePageConfig>
  | ReturnType<typeof prProofTriagePageConfig>;

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char,
  );
}

function dashboardThemeInitScript() {
  return `<script>
(() => {
  const themeKey = "clawsweeper-theme";
  const themeChoices = new Set(["system", "light", "dark"]);
  const themeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const themeColor = { light: "#f6f3ec", dark: "#141110" };
  let themeChoice = "system";
  try {
    const saved = window.localStorage?.getItem(themeKey);
    if (themeChoices.has(saved)) themeChoice = saved;
  } catch {}
  const active = themeChoice === "system" && themeQuery?.matches ? "dark" : themeChoice === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = active;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[active]);
})();
</script>`;
}

function dashboardThemeCss() {
  return `
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
.theme-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
}
.theme-control > span {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.theme-options {
  display: inline-grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
}
.theme-options button {
  appearance: none;
  min-width: 48px;
  min-height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 650;
  line-height: 1;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.theme-options button:hover {
  color: var(--text);
}
.theme-options button[aria-pressed="true"] {
  color: var(--claw);
  background: color-mix(in srgb, var(--claw) 10%, transparent);
}
`;
}

function dashboardThemeControlHtml() {
  return `<div class="theme-control" aria-label="Theme">
        <span>Theme</span>
        <div class="theme-options" role="group" aria-label="Theme preference">
          <button type="button" data-theme-choice="system" aria-pressed="true">System</button>
          <button type="button" data-theme-choice="light" aria-pressed="false">Light</button>
          <button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>
        </div>
      </div>`;
}

function dashboardThemeControlScript() {
  return `(() => {
  const themeKey = "clawsweeper-theme";
  const themeChoices = new Set(["system", "light", "dark"]);
  const themeColor = { light: "#f6f3ec", dark: "#141110" };
  const themeQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const themeButtons = document.querySelectorAll("[data-theme-choice]");
  const readThemeChoice = () => {
    try {
      const saved = window.localStorage?.getItem(themeKey);
      return themeChoices.has(saved) ? saved : "system";
    } catch {
      return "system";
    }
  };
  let themeChoice = readThemeChoice();
  const activeTheme = () => themeChoice === "system" && themeQuery?.matches ? "dark" : themeChoice === "dark" ? "dark" : "light";
  const applyTheme = () => {
    const active = activeTheme();
    document.documentElement.dataset.theme = active;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[active]);
    themeButtons.forEach(button => {
      const selected = button.dataset.themeChoice === themeChoice;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    });
  };
  themeButtons.forEach(button => button.addEventListener("click", () => {
    const choice = button.dataset.themeChoice;
    if (!themeChoices.has(choice)) return;
    themeChoice = choice;
    try {
      window.localStorage?.setItem(themeKey, choice);
    } catch {}
    applyTheme();
  }));
  const updateSystemTheme = () => {
    if (themeChoice === "system") applyTheme();
  };
  if (typeof themeQuery?.addEventListener === "function") {
    themeQuery.addEventListener("change", updateSystemTheme);
  } else {
    themeQuery?.addListener?.(updateSystemTheme);
  }
  applyTheme();
})();`;
}

function serializedAggregateTriagePageConfig(config: TriagePageConfig): string {
  return JSON.stringify({
    endpoint: config.endpoint,
    defaultView: config.defaultView,
    navLabel: config.navLabel,
    views: config.aggregateViews,
    metrics: config.metrics,
  }).replace(/</g, "\\u003c");
}

function aggregateTriageHtml(config: TriagePageConfig): string {
  const pageConfig = serializedAggregateTriagePageConfig(config);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f6f3ec">
<title>${escapeHtml(config.title)}</title>
${dashboardThemeInitScript()}
<style>
:root {
  color-scheme: light dark;
  --bg: light-dark(#f6f3ec, #141110);
  --panel: light-dark(#fffefa, #1c1916);
  --line: light-dark(#e6dfd2, #2d2822);
  --line-soft: light-dark(#eee8dd, #262019);
  --text: light-dark(#211c15, #ece5da);
  --muted: light-dark(#857a69, #988b7b);
  --claw: light-dark(#d94a26, #ff6f48);
  --green: light-dark(#31824f, #5cc088);
  --amber: light-dark(#b3831d, #dcaf5e);
}
* { box-sizing: border-box; }
html { scrollbar-color: light-dark(#cfc6b6, #3a332b) transparent; }
${dashboardThemeCss()}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: "";
  position: fixed;
  inset: 0 0 auto;
  height: 2px;
  background: var(--claw);
}
::selection { background: color-mix(in srgb, var(--claw) 22%, transparent); }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--claw) 60%, transparent); outline-offset: 2px; }
main { width: min(1180px, calc(100vw - 48px)); margin: 0 auto; padding: 34px 0 72px; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
h1 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
h1::before { content: "\\1F99E "; font-size: 20px; }
h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.top-links { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.top-link { color: var(--muted); font-size: 12.5px; font-weight: 500; text-decoration: none; }
.top-link:hover { color: var(--claw); }
#updated { font-size: 11px; }
.privacy-note {
  margin: 12px 0 24px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
  color: var(--muted);
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-bottom: 24px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.metric { padding: 16px 18px 14px; border-left: 1px solid var(--line-soft); min-width: 0; }
.metric:nth-child(3n + 1) { border-left: 0; padding-left: 0; }
.metric strong { display: block; margin-top: 9px; font-size: 28px; font-weight: 560; line-height: 1; }
.metric span { color: var(--muted); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; }
.metric .muted { font-size: 12px; margin-top: 4px; }
.tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.tab {
  min-height: 28px;
  padding: 3px 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.tab[aria-selected="true"] {
  color: var(--claw);
  border-color: color-mix(in srgb, var(--claw) 55%, transparent);
  background: color-mix(in srgb, var(--claw) 8%, transparent);
}
.aggregate-card, .snapshot-health {
  padding: 22px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
}
.aggregate-card { display: grid; grid-template-columns: 1fr auto; gap: 8px 24px; align-items: center; }
.aggregate-card p { margin: 0; }
.aggregate-count { grid-row: 1 / span 2; grid-column: 2; color: var(--claw); font-size: 38px; font-weight: 600; }
.snapshot-health { margin-top: 18px; color: var(--muted); }
.snapshot-health[data-state="complete"] { border-color: color-mix(in srgb, var(--green) 35%, var(--line)); }
.snapshot-health[data-state="partial"] { border-color: color-mix(in srgb, var(--amber) 40%, var(--line)); }
@media (max-width: 760px) {
  main { width: min(100vw - 24px, 1180px); padding-top: 20px; }
  header { align-items: start; flex-direction: column; }
  .top-links { justify-content: flex-start; }
  .grid { grid-template-columns: 1fr; }
  .metric { border-left: 0; padding-left: 0; }
  .aggregate-card { grid-template-columns: 1fr; }
  .aggregate-count { grid-row: auto; grid-column: auto; }
}
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(config.title)}</h1>
      <div class="muted" id="subtitle">Privacy-safe aggregate triage counts</div>
    </div>
    <div class="top-links">
      ${config.links.map((link) => `<a class="top-link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("")}
      ${dashboardThemeControlHtml()}
      <span class="muted mono" id="updated"></span>
    </div>
  </header>
  <p class="privacy-note">This public page exposes bounded category counts only. Per-item details and source diagnostics are intentionally unavailable.</p>
  <section class="grid" id="metrics" aria-label="Aggregate triage metrics"></section>
  <nav class="tabs" id="tabs" aria-label="${escapeHtml(config.navLabel)}"></nav>
  <section class="aggregate-card" id="aggregate-view" aria-live="polite">
    <h2 id="view-name">Loading aggregate view</h2>
    <p class="muted" id="view-description"></p>
    <strong class="aggregate-count" id="view-count">Not available</strong>
  </section>
  <section class="snapshot-health" id="snapshot-health" data-state="unavailable" aria-live="polite">Aggregate snapshot is loading.</section>
</main>
<script>
${dashboardThemeControlScript()}
const PAGE = ${pageConfig};
const MAX_PUBLIC_COUNT = 1000000;
const MAX_PUBLIC_ERROR_COUNT = 20;
const fmt = new Intl.NumberFormat();
let state = null;
let activeView = PAGE.views.some(view => view.id === location.hash.slice(1))
  ? location.hash.slice(1)
  : PAGE.defaultView;
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function boundedCount(value, maximum = MAX_PUBLIC_COUNT) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : null;
}
function normalizedTimestamp(value) {
  if (
    typeof value !== "string" ||
    value.length > 35 ||
    !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/.test(value)
  ) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.UTC(2020, 0, 1) && timestamp < Date.UTC(2100, 0, 1)
    ? new Date(timestamp).toISOString()
    : null;
}
function unavailableSnapshot() {
  return {
    generated_at: null,
    complete: false,
    error_count: null,
    views: PAGE.views.map(view => ({ ...view, count: null })),
  };
}
function publicSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema_version !== 2) {
    return unavailableSnapshot();
  }
  const generatedAt = normalizedTimestamp(value.generated_at);
  const errorCount = boundedCount(value.error_count, MAX_PUBLIC_ERROR_COUNT);
  if (
    !generatedAt ||
    typeof value.complete !== "boolean" ||
    errorCount === null ||
    value.complete !== (errorCount === 0) ||
    !Array.isArray(value.views) ||
    value.views.length !== PAGE.views.length
  ) {
    return unavailableSnapshot();
  }
  const sourceById = new Map();
  for (const source of value.views) {
    if (!source || typeof source !== "object" || Array.isArray(source) || typeof source.id !== "string" || sourceById.has(source.id)) {
      return unavailableSnapshot();
    }
    sourceById.set(source.id, source);
  }
  const views = [];
  for (const view of PAGE.views) {
    const count = boundedCount(sourceById.get(view.id)?.total_count);
    if (count === null) return unavailableSnapshot();
    views.push({ ...view, count });
  }
  if (sourceById.size !== PAGE.views.length) return unavailableSnapshot();
  return { generated_at: generatedAt, complete: value.complete, error_count: errorCount, views };
}
function displayCount(value) {
  return value === null ? "Not available" : fmt.format(value);
}
function metric(label, count, detail) {
  return '<article class="metric"><span>' + esc(label) + '</span><strong>' + esc(displayCount(count)) + '</strong><div class="muted">' + esc(detail || "") + '</div></article>';
}
function renderMetrics() {
  const byId = Object.fromEntries(state.views.map(view => [view.id, view.count]));
  document.getElementById("metrics").innerHTML = PAGE.metrics.map(metricDefinition =>
    metric(metricDefinition.label, byId[metricDefinition.view] ?? null, metricDefinition.detail)
  ).join("");
}
function renderTabs() {
  document.getElementById("tabs").innerHTML = state.views.map(view =>
    '<button class="tab" type="button" data-view="' + esc(view.id) + '" aria-selected="' + (view.id === activeView ? "true" : "false") + '">' +
    esc(view.title) + ' <span class="muted">' + esc(displayCount(view.count)) + '</span></button>'
  ).join("");
  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      const selected = PAGE.views.find(view => view.id === button.dataset.view);
      if (!selected) return;
      activeView = selected.id;
      history.replaceState(null, "", location.pathname + "#" + encodeURIComponent(activeView));
      render();
    });
  });
}
function renderView() {
  const view = state.views.find(candidate => candidate.id === activeView) || state.views[0];
  if (!view) return;
  activeView = view.id;
  document.getElementById("view-name").textContent = view.title;
  document.getElementById("view-description").textContent = view.description;
  document.getElementById("view-count").textContent = displayCount(view.count);
}
function renderHealth() {
  const health = document.getElementById("snapshot-health");
  if (!state.generated_at || state.error_count === null) {
    health.dataset.state = "unavailable";
    health.textContent = "Aggregate snapshot is temporarily unavailable; no detail was rendered.";
    document.getElementById("updated").textContent = "";
    return;
  }
  document.getElementById("updated").textContent = "Updated " + new Date(state.generated_at).toLocaleString();
  if (state.complete) {
    health.dataset.state = "complete";
    health.textContent = "Complete aggregate snapshot. No collection errors were reported.";
  } else {
    health.dataset.state = "partial";
    health.textContent = "Partial aggregate snapshot. " + fmt.format(state.error_count) + " collection errors were withheld.";
  }
}
function render() {
  renderMetrics();
  renderTabs();
  renderView();
  renderHealth();
}
async function load() {
  try {
    const response = await fetch(PAGE.endpoint, { cache: "no-store" });
    state = response.ok ? publicSnapshot(await response.json()) : unavailableSnapshot();
  } catch {
    state = unavailableSnapshot();
  }
  render();
}
load();
setInterval(load, 120000);
</script>
</body>
</html>`;
}

function triageHtml(config: TriagePageConfig): string {
  return aggregateTriageHtml(config);
}

export { issueTriagePageConfig, prProofTriagePageConfig, triageHtml };
