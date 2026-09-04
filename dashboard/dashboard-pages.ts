export type DashboardEnv = Record<string, unknown>;

const DEFAULT_CRABFLEET_URL = "https://crabfleet.openclaw.ai";

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
      { href: "/bay", label: "OpenClaw Bay" },
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
      { href: "/bay", label: "OpenClaw Bay" },
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

function externalHttpUrl(value: unknown, fallback: string): string {
  try {
    const url = new URL(String(value ?? "").trim() || fallback);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
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

function dashboardHtml(env: DashboardEnv = {}) {
  const crabfleetUrl = externalHttpUrl(env.CLAWSWEEPER_CRABFLEET_URL, DEFAULT_CRABFLEET_URL);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f6f3ec">
${dashboardThemeInitScript()}
<title>🦞 ClawSweeper Live</title>
<style>
:root {
  color-scheme: light dark;
  --bg: light-dark(#f6f3ec, #141110);
  --panel: light-dark(#fffefa, #1c1916);
  --line: light-dark(#e6dfd2, #2d2822);
  --line-soft: light-dark(#eee8dd, #262019);
  --track: light-dark(#ebe4d7, #2b2620);
  --text: light-dark(#211c15, #ece5da);
  --muted: light-dark(#857a69, #988b7b);
  --claw: light-dark(#d94a26, #ff6f48);
  --green: light-dark(#31824f, #5cc088);
  --amber: light-dark(#b3831d, #dcaf5e);
  --red: light-dark(#c03d33, #ef685c);
  --violet: light-dark(#6b59c8, #a893f0);
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
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--claw);
  z-index: 10;
}
::selection { background: color-mix(in srgb, var(--claw) 22%, transparent); }
:focus-visible { outline: 2px solid color-mix(in srgb, var(--claw) 60%, transparent); outline-offset: 2px; }
main { width: min(1280px, calc(100vw - 48px)); margin: 0 auto; padding: 26px 0 72px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h1 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 9px;
}
h1::before { content: "🦞"; font-size: 18px; }
.live-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--claw) 45%, transparent);
  border-radius: 999px;
  color: var(--claw);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.live-tag::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--claw);
  animation: heartbeat 2.4s ease-in-out infinite;
}
@keyframes heartbeat {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
.top-links { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.top-link { color: var(--muted); font-size: 12.5px; font-weight: 500; }
.top-link:hover { color: var(--claw); text-decoration: none; }
#updated { font-size: 11px; }
.hero { margin: 44px 0 10px; }
.hero-headline {
  display: flex;
  align-items: center;
  gap: 14px;
  font-family: ui-serif, Georgia, "Times New Roman", serif;
  font-size: 38px;
  font-weight: 500;
  line-height: 1.12;
  letter-spacing: -0.015em;
  text-wrap: balance;
}
.hero-dot {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--muted) 50%, transparent);
}
.hero-dot.ok { background: var(--green); box-shadow: 0 0 0 5px color-mix(in srgb, var(--green) 14%, transparent); }
.hero-dot.amber { background: var(--amber); box-shadow: 0 0 0 5px color-mix(in srgb, var(--amber) 16%, transparent); }
.hero-dot.red { background: var(--red); box-shadow: 0 0 0 5px color-mix(in srgb, var(--red) 16%, transparent); }
.hero > .muted { margin-top: 10px; font-size: 12.5px; }
h2 {
  margin: 44px 0 12px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 8px;
}
h2::before { content: ""; flex: 0 0 auto; width: 14px; height: 2px; border-radius: 1px; background: var(--claw); }
.muted { color: var(--muted); }
.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: 30px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.metric { padding: 18px 20px 16px; border-left: 1px solid var(--line-soft); min-width: 0; }
.metric:first-child { border-left: 0; padding-left: 0; }
.metric span { color: var(--muted); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; }
.metric strong { display: block; margin-top: 10px; font-size: 30px; font-weight: 560; line-height: 1; letter-spacing: -0.03em; }
.metric > div.muted { margin-top: 4px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.band { width: 54px; height: 2px; margin-top: 12px; background: var(--track); border-radius: 999px; overflow: hidden; }
.band > i { display: block; height: 100%; border-radius: 999px; background: var(--claw); width: 0; transition: width 0.6s ease; }
.exact-review-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 22px; }
.exact-review-head .overview-section-title { margin: 0; }
.trend-ranges { display: flex; gap: 6px; }
.trend-range {
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.trend-range.active { color: var(--text); border-color: var(--claw); }
.execution-alert { margin-top: 24px; border: 1px solid color-mix(in srgb, var(--amber) 48%, var(--line)); border-radius: 10px; background: color-mix(in srgb, var(--amber) 7%, var(--panel)); }
.execution-alert summary { display: flex; justify-content: space-between; gap: 16px; padding: 13px 15px; cursor: pointer; list-style: none; }
.execution-alert summary::-webkit-details-marker { display: none; }
.execution-alert-title { display: grid; gap: 4px; }
.execution-alert-title strong { font-size: 13px; }
.execution-alert-title span, .execution-alert-toggle, .execution-alert-body { color: var(--muted); font-size: 11px; }
.execution-alert-body { padding: 0 15px 13px; }
.exact-trend { margin: 14px 0 16px; }
.exact-trend-status { font-size: 12px; font-weight: 650; }
.exact-trend-status.growing { color: var(--amber); }
.exact-trend-status.draining { color: var(--green); }
.exact-trend-status.catching-up { color: var(--green); }
.exact-trend-status.falling-behind { color: var(--amber); }
.exact-trend-status.stable,
.exact-trend-status.collecting,
.exact-trend-status.stale { color: var(--muted); }
.exact-trend-svg { display: block; width: 100%; height: 150px; margin-top: 6px; overflow: visible; }
.trend-grid-line { stroke: var(--line-soft); stroke-width: 1; }
.trend-grid-line.lane-speed-zero { stroke: var(--muted); }
.trend-axis-label { fill: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 10px; }
.exact-trend-line { fill: none; stroke: var(--claw); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.exact-trend-point { fill: var(--claw); }
.lane-speed { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.lane-speed .exact-trend-status { margin-top: 4px; }
.lane-rate-label { display: flex; align-items: center; gap: 5px; }
.lane-rate-help {
  position: relative;
}
.lane-rate-help summary {
  display: inline-grid;
  place-items: center;
  width: 13px;
  height: 13px;
  border: 1px solid var(--muted);
  border-radius: 50%;
  color: var(--muted);
  cursor: help;
  font-size: 9px;
  line-height: 1;
  list-style: none;
}
.lane-rate-help summary::-webkit-details-marker { display: none; }
.lane-rate-tooltip {
  display: none;
  position: absolute;
  z-index: 20;
  bottom: calc(100% + 7px);
  left: -8px;
  width: min(300px, calc(100vw - 64px));
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: 0 8px 24px color-mix(in srgb, #000 20%, transparent);
  color: var(--text);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
}
.lane-rate-help[open] .lane-rate-tooltip,
.lane-rate-help:hover .lane-rate-tooltip,
.lane-rate-help:focus-within .lane-rate-tooltip { display: block; }
.lane-speed-line { fill: none; stroke: var(--violet); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.lane-speed-point { fill: var(--violet); }
.trend-empty { display: grid; place-items: center; height: 130px; color: var(--muted); font-size: 12px; }
.overview-shell { margin: 0; padding: 0; border: 0; background: transparent; }
.overview-head,
.automatic-head,
.workers-head,
.worker-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.overview-head,
.automatic-head,
.workers-head { margin-top: 44px; }
.overview-head h2,
.automatic-head h2,
.workers-head h2 { margin: 0; }
.overview-head .muted,
.automatic-head .muted,
.workers-head .muted,
.worker-toolbar .muted { font-size: 12px; }
.flow-map {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 28px;
  margin-top: 26px;
}
.flow-node { position: relative; min-width: 0; padding-top: 18px; }
.flow-node::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: -28px;
  height: 2px;
  background: var(--line);
}
.flow-node:last-child::before { right: 0; }
.flow-node::after {
  content: "";
  position: absolute;
  top: -3px;
  left: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--claw);
}
.flow-node span {
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.flow-node strong {
  display: block;
  margin-top: 7px;
  font-size: 26px;
  font-weight: 560;
  letter-spacing: -0.02em;
  line-height: 1;
}
.flow-node p {
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.capacity-rail { margin-top: 30px; }
.overview-section-title {
  margin: 28px 0 0;
  color: var(--muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.capacity-bar {
  display: flex;
  height: 10px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.capacity-bar i { display: block; height: 100%; }
.capacity-bar .active { background: var(--claw); }
.capacity-bar .waiting { background: var(--amber); }
.capacity-meta { margin-top: 8px; color: var(--muted); font-size: 12px; }
.capacity-note { margin-top: 5px; color: var(--muted); font-size: 11px; }
.exact-lanes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 10px;
}
/* The queue lanes and state writer update independently, but they are one
   operator workflow and must share a single three-stage layout. */
.exact-review-lanes { display: contents; }
.exact-lane {
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}
.apply-observability { margin-top: 22px; }
.apply-observability .exact-review-head { margin-top: 0; }
.apply-observability .overview-section-title { margin: 0 0 3px; }
.apply-observability .apply-observability-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
.apply-observability .apply-observability-metric { min-width: 0; padding: 11px 12px; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--panel); }
.apply-observability .apply-observability-metric > span { display: block; color: var(--muted); font-size: 10px; line-height: 1.2; }
.apply-observability .apply-observability-metric > strong { display: block; margin-top: 5px; font: 700 15px ui-monospace, SFMono-Regular, Menlo, monospace; }
.apply-observability .apply-observability-metric small { display: block; margin-top: 4px; color: var(--muted); font-size: 10px; line-height: 1.25; }
.apply-observability .review-anomalies { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--panel); font-size: 11px; }
.apply-observability .review-anomaly { display: flex; justify-content: space-between; gap: 12px; }
.apply-observability .review-status { font-weight: 700; }
.apply-observability .review-status.healthy { color: var(--green); }
.apply-observability .review-status.degraded { color: var(--claw); }
.exact-lane-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.exact-lane-head strong { font-size: 13px; }
.exact-lane-head span { color: var(--muted); font-size: 11px; }
.lane-counts { display: grid; gap: 6px; margin-top: 12px; }
.lane-count { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 11px; }
.exact-lane > .lane-count { margin-top: 14px; }
.lane-count strong { color: var(--text); font-weight: 600; }
.lane-metrics { display: grid; gap: 6px; margin: 12px 0 0; }
.lane-metrics > div { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 11px; }
.lane-metrics dt, .lane-metrics dd { margin: 0; }
.lane-metrics dd { color: var(--text); font-weight: 600; text-align: right; }
.state-writer-note { margin: 7px 0 0; color: var(--muted); font-size: 10px; line-height: 1.45; }
.lane-flow { margin-top: 12px; }
.lane-flow summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  color: var(--muted);
  cursor: pointer;
  font-size: 11px;
  list-style: none;
}
.lane-flow summary::-webkit-details-marker { display: none; }
.lane-flow summary::after { flex: 0 0 auto; content: "Details ▾"; }
.lane-flow[open] summary::after { content: "Hide ▴"; }
.lane-flow-title { display: grid; gap: 3px; }
.lane-flow-title small { max-width: 420px; color: var(--muted); font-size: 10px; line-height: 1.4; }
.lane-flow .lane-counts { padding-left: 10px; border-left: 1px solid var(--line-soft); }
.lane-flow-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 8px; color: var(--muted); font-size: 10px; }
.lane-flow-foot strong { color: var(--text); font-weight: 600; }
.lane-bar { height: 6px; margin-top: 12px; overflow: hidden; border-radius: 999px; background: var(--track); }
.lane-bar i { display: block; height: 100%; background: var(--claw); }
.lane-foot { margin-top: 7px; color: var(--muted); font-size: 11px; }
.exact-handoff {
  margin-top: 18px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}
.exact-handoff-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
}
.exact-handoff-title { display: grid; gap: 3px; }
.exact-handoff-title strong { font-size: 13px; font-weight: 650; }
.exact-handoff-title span { color: var(--muted); font-size: 12px; }
.health-badge {
  flex: 0 0 auto;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.health-badge.healthy,
.health-badge.idle { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.health-badge.degraded,
.health-badge.congested { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 45%, transparent); }
.health-badge.stalled,
.health-badge.saturated { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
.exact-handoff-badges { display: flex; flex: 0 0 auto; flex-wrap: wrap; gap: 6px; justify-content: end; }
.handoff-phases {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin-top: 14px;
  overflow: hidden;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  background: var(--line-soft);
}
.handoff-phase { padding: 11px 12px; background: var(--bg); }
.handoff-phase span {
  display: block;
  color: var(--muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.handoff-phase strong { display: block; margin-top: 4px; font-size: 21px; font-weight: 560; line-height: 1; }
.handoff-phase small { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; }
.handoff-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  color: var(--muted);
  font-size: 11px;
}
.status-dot {
  display: inline-block;
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--muted) 50%, transparent);
}
.status-dot.active { background: var(--claw); }
.status-dot.waiting { background: var(--amber); }
.status-dot.done { background: var(--green); }
.status-dot.failed { background: var(--red); }
.apply-health-alert {
  display: grid;
  gap: 8px;
  margin-top: 18px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--amber) 45%, transparent);
  border-left: 3px solid var(--amber);
  border-radius: 10px;
  background: color-mix(in srgb, var(--amber) 7%, transparent);
}
.apply-health-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.apply-health-heading strong { color: var(--amber); }
.apply-health-alert p { margin: 0; color: var(--muted); font-size: 13px; }
.apply-health-next strong { color: var(--text); }
.apply-health-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.apply-health-meta .pill {
  min-height: 21px;
  padding: 1px 8px;
  font-size: 11px;
}
.apply-health-reason { cursor: help; }
.apply-health-action {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
  align-items: center;
}
.apply-health-command {
  min-width: 0;
  padding: 6px 9px;
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: normal;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  line-height: 1.45;
  font-size: 12px;
}
.apply-health-copy { min-height: 27px; }
@media (max-width: 740px) {
  .apply-health-action { grid-template-columns: 1fr; }
}
.worker-toolbar { margin-top: 12px; }
.public-reference-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
}
.public-reference-search input {
  min-width: 260px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text);
  padding: 8px 10px;
}
.public-reference-row mark {
  border-radius: 4px;
  background: color-mix(in srgb, var(--amber) 24%, transparent);
  color: inherit;
  padding: 1px 3px;
}
.public-reference-row {
  width: 100%;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.public-reference-row:hover,
.public-reference-row:focus-visible {
  background: color-mix(in srgb, var(--claw) 5%, transparent);
  outline: 2px solid var(--claw);
  outline-offset: 2px;
}
.worker-filters {
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  overflow: hidden;
}
.filter-button {
  appearance: none;
  border: 0;
  border-left: 1px solid var(--line-soft);
  padding: 5px 13px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.filter-button:first-child { border-left: 0; }
.filter-button:hover { color: var(--text); }
.filter-button.active {
  color: var(--claw);
  background: color-mix(in srgb, var(--claw) 8%, transparent);
}
.worker-list {
  margin-top: 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.worker-row {
  appearance: none;
  display: block;
  width: 100%;
  padding: 11px 16px 12px;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.worker-row:last-child { border-bottom: 0; }
.worker-row:hover,
.worker-row:focus-visible { background: color-mix(in srgb, var(--claw) 3%, transparent); outline: none; }
.worker-row-main {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1.1fr) minmax(0, 1.5fr) auto;
  gap: 12px;
  align-items: center;
}
.automatic-row .worker-row-main { grid-template-columns: auto auto minmax(0, 1fr) auto; }
.worker-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 13.5px;
}
.worker-step {
  color: var(--claw);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worker-step::before { content: "↳ "; }
.worker-time { color: var(--muted); font-size: 12px; text-align: right; white-space: nowrap; }
.worker-row-sub {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  margin-top: 6px;
  padding-left: 19px;
}
.worker-target-ref { color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.worker-target-title {
  color: var(--muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.worker-progress {
  width: 64px;
  height: 2px;
  border-radius: 999px;
  background: var(--track);
  overflow: hidden;
}
.worker-progress i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--claw);
}
dialog {
  width: min(680px, calc(100vw - 28px));
  max-height: calc(100vh - 28px);
  margin: 14px 14px 14px auto;
  padding: 0;
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 14px;
  box-shadow: 0 24px 70px light-dark(rgba(48, 34, 22, 0.2), rgba(0, 0, 0, 0.6));
}
dialog::backdrop {
  background: light-dark(rgba(52, 40, 28, 0.32), rgba(0, 0, 0, 0.55));
  backdrop-filter: blur(4px);
}
.drawer {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  max-height: calc(100vh - 30px);
}
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  padding: 20px;
  border-bottom: 1px solid var(--line);
}
.drawer-head h3 {
  margin: 9px 0 0;
  font-size: 19px;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
.drawer-head .pill { margin-right: 4px; }
.drawer-close {
  appearance: none;
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 50%;
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  font-size: 16px;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.drawer-close:hover {
  color: var(--claw);
  border-color: color-mix(in srgb, var(--claw) 45%, var(--line));
}
.drawer-body {
  min-height: 0;
  padding: 20px;
  overflow: auto;
}
.drawer-body h2 { margin: 26px 0 10px; }
.drawer-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.drawer-stat {
  padding: 11px 12px;
  border: 1px solid var(--line-soft);
  border-radius: 10px;
  background: var(--bg);
}
.drawer-stat span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
}
.drawer-stat strong {
  display: block;
  margin-top: 5px;
  overflow-wrap: anywhere;
  font-weight: 600;
}
.drawer-links { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
.drawer-links .filter-button { border: 1px solid var(--line); border-radius: 999px; }
.step-list {
  display: grid;
  gap: 0;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.step-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  min-height: 37px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line-soft);
}
.step-row:last-child { border-bottom: 0; }
.step-mark {
  width: 8px;
  height: 8px;
  border: 2px solid color-mix(in srgb, var(--muted) 55%, transparent);
  border-radius: 50%;
}
.step-row.completed .step-mark { border-color: var(--green); background: var(--green); }
.step-row.in_progress .step-mark {
  border-color: var(--claw);
  background: var(--claw);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--claw) 15%, transparent);
}
.step-row.queued .step-mark,
.step-row.pending .step-mark,
.step-row.waiting .step-mark { border-color: var(--amber); }
.step-row strong { font-size: 12.5px; font-weight: 550; }
.step-row span { color: var(--muted); font-size: 11px; }
table {
  width: 100%;
  min-width: 0;
  table-layout: fixed;
  border-collapse: collapse;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
th, td { padding: 10px 12px; border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: top; }
td { overflow-wrap: anywhere; }
th {
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  background: transparent;
  font-weight: 600;
  letter-spacing: 0.1em;
  border-bottom-color: var(--line);
}
tbody tr { transition: background-color 0.15s ease; }
tbody tr:hover { background: color-mix(in srgb, var(--claw) 3%, transparent); }
tr:last-child td { border-bottom: 0; }
a { color: var(--claw); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  padding: 2px 10px;
  border-radius: 999px;
  background: transparent;
  border: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  font-weight: 500;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.pill:hover { border-color: color-mix(in srgb, var(--claw) 45%, var(--line)); color: var(--text); }
a.pill:hover { color: var(--claw); text-decoration: none; }
.green { color: var(--green); }
.amber { color: var(--amber); }
.red { color: var(--red); }
.violet { color: var(--violet); }
.pill.green { color: var(--green); border-color: color-mix(in srgb, var(--green) 40%, transparent); }
.pill.amber { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }
.pill.red { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
.pill.violet { color: var(--violet); border-color: color-mix(in srgb, var(--violet) 40%, transparent); }
.run-link { color: var(--claw); }
.pill.run-link { color: var(--claw); border-color: color-mix(in srgb, var(--claw) 35%, transparent); }
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 390px);
  gap: 32px;
  align-items: start;
}
.split > div,
.split > aside,
.left-col { min-width: 0; }
.left-col {
  display: grid;
  gap: 0;
  align-content: start;
}
.pipeline-col { overflow: hidden; }
.cluster-col,
.side-col { min-width: 0; }
.cluster-col-mobile { display: none; }
#pipeline,
#automerge,
#closed,
#events {
  min-width: 0;
  overflow: hidden;
  border-radius: 10px;
}
.work-list,
.side-list {
  display: block;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
}
.work-row,
.side-row {
  display: grid;
  gap: 12px;
  min-width: 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  transition: background-color 0.15s ease;
}
.work-row:last-child,
.side-row:last-child { border-bottom: 0; }
.work-row {
  grid-template-columns: minmax(0, 1fr) minmax(200px, 250px) 74px;
  align-items: center;
  padding: 11px 14px;
}
.cluster-marker-row {
  grid-template-columns: minmax(0, 1fr) minmax(200px, 250px);
}
.side-row {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  padding: 10px 12px;
}
.work-row:hover,
.side-row:hover { background: color-mix(in srgb, var(--claw) 3%, transparent); }
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
.stage-block strong { font-size: 13px; font-weight: 600; }
.timebox {
  display: grid;
  justify-items: end;
  gap: 2px;
  white-space: nowrap;
}
.timebox strong {
  font-size: 15px;
  font-weight: 620;
  line-height: 1;
  letter-spacing: -0.01em;
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
  margin-bottom: 10px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.closed-stat {
  padding: 12px 14px 12px;
  border-left: 1px solid var(--line-soft);
  min-width: 0;
}
.closed-stat:first-child { border-left: 0; padding-left: 0; }
.closed-stat span {
  display: block;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
}
.closed-stat strong {
  display: block;
  margin-top: 6px;
  font-size: 22px;
  font-weight: 560;
  letter-spacing: -0.02em;
  line-height: 1;
}
.worker-health-section + .worker-health-section {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.worker-health-subhead { margin-bottom: 10px; }
.worker-health-subhead strong { display: block; font-size: 13px; font-weight: 620; }
.worker-health-subhead span { display: block; margin-top: 4px; font-size: 11px; line-height: 1.45; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.empty {
  padding: 26px;
  color: var(--muted);
  background: transparent;
  border: 1px dashed var(--line);
  border-radius: 10px;
  text-align: center;
}
.empty::before { content: "🦞 "; opacity: 0.5; }
.automerge-health { margin: 28px 0; padding: 22px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
.automerge-health-head, .automerge-controls, .automerge-meta, .automerge-tabs { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.automerge-health-head { justify-content: space-between; }
.automerge-health h2 { margin: 0; }
.automerge-controls select { max-width: 220px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--text); background: var(--panel); font: inherit; font-size: 11px; }
.automerge-meta { margin-top: 8px; color: var(--muted); font-size: 11px; }
.automerge-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 20px; border-block: 1px solid var(--line-soft); }
.automerge-kpi { padding: 18px; border-left: 1px solid var(--line-soft); }
.automerge-kpi:first-child { border-left: 0; }
.automerge-kpi span { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
.automerge-kpi strong { display: block; margin: 8px 0 5px; font-size: 25px; font-weight: 560; }
.automerge-kpi small { color: var(--muted); }
.automerge-chart-shell { margin-top: 20px; }
.automerge-tabs button { border: 0; border-bottom: 2px solid transparent; padding: 7px 2px; background: transparent; color: var(--muted); cursor: pointer; font: inherit; }
.automerge-tabs button.active { color: var(--text); border-color: var(--claw); }
.automerge-chart { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(18px, 1fr); align-items: end; gap: 3px; height: 190px; margin-top: 12px; padding: 12px 4px 22px; border-bottom: 1px solid var(--line); background: repeating-linear-gradient(to bottom, var(--line-soft) 0 1px, transparent 1px 42px); overflow-x: auto; }
.automerge-point { position: relative; height: 100%; min-width: 18px; }
.automerge-dot { position: absolute; left: 50%; width: 9px; height: 9px; translate: -50% 50%; border-radius: 50%; background: var(--claw); box-shadow: 0 0 0 3px var(--panel); }
.automerge-dot.low { background: var(--panel); border: 2px solid var(--claw); }
.automerge-dot.p90 { width: 7px; height: 7px; background: var(--amber); }
.automerge-n { position: absolute; left: 50%; bottom: -19px; translate: -50% 0; color: var(--muted); font-size: 9px; white-space: nowrap; }
.automerge-chart-legend { margin-top: 7px; color: var(--muted); font-size: 10px; }
.automerge-details { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; margin-top: 22px; }
.automerge-details h3 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.automerge-detail-row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--line-soft); font-size: 12px; }
.health-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.health-strip:empty { display: none; }
.health-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 550;
  line-height: 1.35;
}
.health-chip strong { color: var(--text); font-weight: 650; }
.health-chip::before {
  content: "";
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--muted) 55%, transparent);
}
.health-chip.ok::before { background: var(--green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--green) 15%, transparent); }
.health-chip.amber::before { background: var(--amber); box-shadow: 0 0 0 3px color-mix(in srgb, var(--amber) 17%, transparent); }
.health-chip.red::before { background: var(--red); box-shadow: 0 0 0 3px color-mix(in srgb, var(--red) 17%, transparent); }
.health-chip.ok { border-color: color-mix(in srgb, var(--green) 28%, var(--line)); }
.health-chip.amber { border-color: color-mix(in srgb, var(--amber) 35%, var(--line)); }
.health-chip.red { border-color: color-mix(in srgb, var(--red) 35%, var(--line)); }
.review-coverage { margin-top: 28px; }
.review-coverage > summary {
  padding: 14px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  cursor: pointer;
}
.coverage-summary-content {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 18px;
  width: calc(100% - 24px);
  margin-left: 8px;
}
.review-coverage > summary:hover .coverage-summary-label { color: var(--claw); }
.review-coverage > summary:focus-visible { outline: 2px solid var(--claw); outline-offset: 4px; }
.coverage-summary-label { color: var(--ink); font-family: var(--font-heading); font-size: 18px; font-weight: 800; }
.review-coverage > summary .muted { text-align: right; }
.review-coverage[open] > summary { margin-bottom: 14px; }
.coverage-fleets { display: grid; gap: 10px; margin-top: 14px; }
.coverage-fleet {
  display: grid;
  grid-template-columns: minmax(170px, 240px) minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel);
}
.coverage-fleet-name { display: grid; gap: 3px; min-width: 0; }
.coverage-fleet-name strong { font-size: 13px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coverage-fleet-name span { color: var(--muted); font-size: 11px; }
.coverage-bar { position: relative; height: 8px; border-radius: 999px; background: var(--track); overflow: hidden; }
.coverage-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--green); transition: width 0.6s ease; }
.coverage-bar.amber > i { background: var(--amber); }
.coverage-bar.red > i { background: var(--red); }
.coverage-value { display: grid; gap: 3px; justify-items: end; }
.coverage-value strong { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; line-height: 1; }
.coverage-value span { color: var(--muted); font-size: 11px; white-space: nowrap; }
.coverage-flags { display: inline-flex; gap: 6px; }
.coverage-flag {
  padding: 2px 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 650;
}
.coverage-flag.stale { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, var(--line)); }
.coverage-flag.failed { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, var(--line)); }
@media (max-width: 1280px) {
  .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .metric { padding: 16px 18px 14px; }
  .metric:nth-child(3n + 1) { border-left: 0; padding-left: 0; }
  .split { grid-template-columns: 1fr; }
  .left-col { order: 1; }
  .side-col { order: 2; }
  .cluster-col-desktop { display: none; }
  .cluster-col-mobile { display: block; order: 3; }
  header { align-items: start; flex-direction: column; }
  .top-links { justify-content: flex-start; }
}
@media (max-width: 900px) {
  .hero-headline { font-size: 28px; }
  .flow-map { grid-template-columns: 1fr; gap: 16px; }
  .flow-node { padding-top: 0; padding-left: 20px; }
  .flow-node::before { display: none; }
  .flow-node::after { top: 5px; }
  .exact-lanes { grid-template-columns: 1fr; }
  .apply-observability .apply-observability-kpis { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .automerge-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .automerge-kpi:nth-child(3) { border-left: 0; border-top: 1px solid var(--line-soft); }
  .automerge-kpi:nth-child(4) { border-top: 1px solid var(--line-soft); }
  .automerge-details { grid-template-columns: 1fr; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric:nth-child(3n + 1) { border-left: 1px solid var(--line-soft); padding-left: 18px; }
  .metric:nth-child(2n + 1) { border-left: 0; padding-left: 0; }
  .worker-row-main { grid-template-columns: auto auto minmax(0, 1fr) auto; }
  .worker-step { display: none; }
  .work-row { grid-template-columns: 1fr; align-items: start; }
  .work-state, .stage-block, .timebox { justify-content: start; justify-items: start; }
  .worker-toolbar { align-items: stretch; flex-direction: column; }
  .coverage-fleet { grid-template-columns: 1fr; gap: 9px; }
  .coverage-value { justify-items: start; }
  .coverage-summary-content { align-items: flex-start; flex-direction: column; gap: 6px; }
  .review-coverage > summary .muted { padding-left: 24px; text-align: left; }
}
@media (max-width: 560px) {
  main { width: min(100vw - 24px, 1280px); padding-top: 18px; }
  .hero { margin-top: 30px; }
  .hero-headline { font-size: 23px; gap: 10px; }
  .hero-dot { width: 10px; height: 10px; }
  .exact-review-head { align-items: flex-start; flex-direction: column; }
  .grid, .drawer-grid { grid-template-columns: 1fr; }
  .metric, .metric:nth-child(3n + 1) { border-left: 0; border-top: 1px solid var(--line-soft); padding-left: 0; }
  .metric:first-child { border-top: 0; }
  .closed-stats { grid-template-columns: 1fr; }
  .closed-stat { border-left: 0; border-top: 1px solid var(--line-soft); padding-left: 0; }
  .closed-stat:first-child { border-top: 0; }
  .side-row { grid-template-columns: 1fr; }
  .side-meta { justify-content: flex-start; }
  .worker-row-sub { grid-template-columns: auto minmax(0, 1fr); }
  .worker-progress { display: none; }
  .exact-handoff-head, .handoff-foot { align-items: start; flex-direction: column; }
  .handoff-phases { grid-template-columns: 1fr; }
  dialog { margin: 7px; max-height: calc(100vh - 14px); }
}
</style>
</head>
<body>
<main>
  <header>
    <h1>ClawSweeper <span class="live-tag">Live</span></h1>
    <div class="top-links">
      <a class="top-link" href="/bay">OpenClaw Bay</a>
      <a class="top-link" href="/triage">Issue triage</a>
      <a class="top-link" href="/pr-proof-triage">PR proof triage</a>
      <a class="top-link" href="${escapeHtml(crabfleetUrl)}">Live terminals</a>
      ${dashboardThemeControlHtml()}
      <span class="muted mono" id="updated"></span>
    </div>
  </header>
  <section class="hero">
    <div class="hero-headline"><span class="hero-dot" id="hero-dot"></span><span id="hero-headline">Loading pipeline state...</span></div>
    <div class="muted" id="subtitle"></div>
    <div class="health-strip" id="health-strip" aria-label="Subsystem health at a glance"></div>
  </section>
  <section class="grid" id="metrics"></section>
  <section class="overview-shell" aria-labelledby="system-overview-title">
    <div class="overview-head">
      <h2 id="system-overview-title">System Overview</h2>
      <span class="muted" id="overview-note">Live GitHub workflow telemetry</span>
    </div>
    <div class="flow-map" id="flow-map"></div>
    <h3 class="overview-section-title">Codex Capacity</h3>
    <div class="capacity-rail" id="capacity-rail"></div>
    <div id="execution-alert" aria-live="polite"></div>
    <div class="exact-review-head">
      <div><h3 class="overview-section-title">Exact Review</h3><span class="muted" id="exact-review-history-contract">History coverage unavailable.</span></div>
      <div class="trend-ranges" id="trend-ranges" aria-label="Exact Review backlog history range">
        <button class="trend-range active" type="button" data-trend-range="6h">6 hours</button>
        <button class="trend-range" type="button" data-trend-range="24h">24 hours</button>
        <button class="trend-range" type="button" data-trend-range="7d">7 days</button>
      </div>
    </div>
    <div class="exact-lanes">
      <div class="exact-review-lanes" id="exact-review-lanes" aria-live="polite"></div>
      <section class="exact-lane" id="state-writer-health" aria-live="polite"></section>
    </div>
    <section class="apply-observability" aria-labelledby="apply-observability-title">
      <div class="exact-review-head">
        <div>
          <h3 class="overview-section-title" id="apply-observability-title">Apply / close health</h3>
          <span class="muted" id="apply-observability-summary">Loading durable apply telemetry…</span>
        </div>
        <div class="trend-ranges" id="apply-observability-ranges" aria-label="Apply and close health range">
          <button class="trend-range" type="button" data-apply-range="6h">6 hours</button>
          <button class="trend-range active" type="button" data-apply-range="24h">24 hours</button>
          <button class="trend-range" type="button" data-apply-range="7d">7 days</button>
        </div>
      </div>
      <div id="apply-observability-body" aria-live="polite"><div class="empty">Loading apply and close telemetry…</div></div>
    </section>
    <h3 class="overview-section-title">Handoff Health</h3>
    <div id="exact-review-handoff" aria-live="polite"></div>
    <div id="recent-durable-publication-events" aria-live="polite"></div>
    <div id="apply-health"></div>
    <div class="automatic-head">
      <h2>Automatic Builds</h2>
      <span class="muted" id="automatic-summary"></span>
    </div>
    <div id="automatic-work"></div>
    <div class="workers-head">
      <h2>Active Workers</h2>
      <span class="muted" id="worker-summary"></span>
    </div>
    <div class="worker-toolbar">
      <div class="worker-filters" id="worker-filters" aria-label="Filter workers"></div>
      <span class="muted">Select a worker for its live step timeline.</span>
    </div>
    <div id="workers"></div>
    <div class="workers-head">
      <h2>Public GitHub work</h2>
      <span class="muted" id="public-reference-summary"></span>
    </div>
    <form class="public-reference-search" id="public-reference-search" role="search">
      <label class="sr-only" for="public-reference-input">Find a public issue or pull request</label>
      <input id="public-reference-input" autocomplete="off" placeholder="Issue/PR number or owner/repo#number">
      <button class="filter-button" type="submit">Find</button>
      <button class="filter-button" id="public-reference-clear" type="button">Clear</button>
    </form>
    <div id="public-references"></div>
  </section>
  <h2 id="review-coverage-title">Fleet Review Coverage</h2>
  <details class="review-coverage">
    <summary>
      <span class="coverage-summary-content">
        <span class="coverage-summary-label">Explore fleet-wide coverage</span>
        <span class="muted" id="review-coverage-note">Open items reviewed in the trailing 7 days</span>
      </span>
    </summary>
    <div id="review-coverage-body" aria-live="polite" aria-labelledby="review-coverage-title"><div class="empty">Loading review coverage…</div></div>
  </details>
  <section class="automerge-health" aria-labelledby="automerge-product-title">
    <div class="automerge-health-head">
      <h2 id="automerge-product-title">Automerge Product Health</h2>
      <div class="automerge-controls">
        <div class="trend-ranges" id="automerge-ranges" aria-label="Automerge metric range">
          <button class="trend-range" type="button" data-automerge-range="6h">6h</button>
          <button class="trend-range" type="button" data-automerge-range="24h">24h</button>
          <button class="trend-range active" type="button" data-automerge-range="7d">7d</button>
        </div>
      </div>
    </div>
    <div class="automerge-meta" id="automerge-meta">Loading product telemetry…</div>
    <div id="automerge-product"><div class="empty">Loading automerge product metrics…</div></div>
  </section>
  <section class="split">
    <div class="left-col">
      <div class="pipeline-col">
        <h2>Active Pipeline</h2>
        <div id="pipeline"></div>
      </div>
      <div class="cluster-col cluster-col-desktop">
        <h2>Cluster Intake</h2>
        <div class="cluster-repair"></div>
      </div>
    </div>
    <aside class="side-col">
      <h2>Closed by ClawSweeper</h2>
      <div id="closed-stats"></div>
      <div id="closed"></div>
      <h2>Worker Health</h2>
      <div id="worker-health"></div>
      <div id="automerge" hidden></div>
      <h2>Operations</h2>
      <div id="operations"></div>
      <h2>Recent Activity</h2>
      <div id="events"></div>
    </aside>
    <div class="cluster-col cluster-col-mobile">
      <h2>Cluster Intake</h2>
      <div class="cluster-repair"></div>
    </div>
  </section>
</main>
<dialog id="worker-dialog" aria-labelledby="worker-dialog-title">
  <div class="drawer">
    <div class="drawer-head">
      <div id="worker-dialog-heading"></div>
      <button class="drawer-close" id="worker-dialog-close" type="button" aria-label="Close details">×</button>
    </div>
    <div class="drawer-body" id="worker-dialog-body"></div>
  </div>
</dialog>
<script>
${dashboardThemeControlScript()}
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
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const diff = timestamp - Date.now();
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
  return '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><div class="muted">' + esc(sub || "") + '</div><div class="band"><i style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%;background:' + (color || "var(--claw)") + '"></i></div></div>';
}
function ciBadge(ci) {
  if (!ci) return '<span class="pill">ci unknown</span>';
  const cls = ci.state === "green" ? "green" : ci.state === "red" ? "red" : ci.state === "pending" ? "amber" : "";
  const prefix = ci.source === "workflow" ? "run" : "checks";
  const detail = ci.total ? " " + esc(ci.failing || 0) + "/" + esc(ci.pending || 0) + "/" + esc(ci.total || 0) : "";
  return '<span class="pill ' + cls + '" title="' + esc(ci.label || ci.source || "") + '">' + esc(prefix) + " " + esc(ci.state) + detail + '</span>';
}
const STATUS_CONTAINER_FIELDS = new Set([
  "root", "source", "fleet", "control_plane", "publishers", "comment_routers", "reconcilers",
  "health", "operational_health", "averages", "workers", "automatic_work", "pipeline", "bay",
  "recent", "diagnostics", "dashboard_health", "progress", "steps", "timeline", "ci", "timings",
  "overall", "terminal_buffer", "recently_washed", "cluster_repair", "markers", "latest_runs",
  "active_intake_runs", "active_worker_runs", "apply_health", "items", "failures", "skip_reasons",
  "closure", "next_action_buckets", "next_actions", "cycle", "candidate_counts", "lanes",
  "comment_sync", "automerge", "automerge_reliability", "closed_items", "closed_stats",
  "operation_counts", "events", "reasons", "cursor", "exact_review_queue",
  "recent_durable_publication_events", "collection", "review", "publication", "handoff_health",
  "review_failure_health", "by_stage",
  "phases", "pending", "dispatching", "leased", "pressure", "scheduled_feed", "bay_projection", "activity", "queue_stages", "live_stages", "stages",
  "active_stages", "window", "direct", "batch", "counts", "buckets", "provenance",
  "backoff_reasons", "parked_reasons", "recovery_reasons", "errors", "freshness"
]);
const STATUS_BOOLEAN_FIELDS = new Set([
  "active_census_complete", "complete", "cursor_required", "is_codex_worker",
  "public_aggregate_only", "public_projection_complete", "recovered", "telemetry_complete",
  "workflow_run_census_complete", "durable_server_observed"
]);
const STATUS_TEXT_FIELDS = new Set([
  "conclusion", "enqueue_replay", "mode", "outcome", "reason", "sample_kind", "severity", "source", "stage", "state",
  "status", "terminal_outcome", "work_kind", "errors", "reasons", "cache_state"
]);
const STATUS_TEXT_VALUES = new Set([
  "active", "apply", "applying", "arriving", "all_clear", "amber", "assist", "automerge",
  "background-review", "cancelled", "closing", "complete", "congested", "critical", "commit-review", "completed",
  "completed_review_journeys", "degraded", "exact-review", "failure", "github-checks", "green",
  "healthy", "hot-review", "in_progress", "idle", "issue_to_pr", "job", "live", "neutral",
  "needs_attention", "other", "pending", "processed", "publishing", "pr_repair", "queued",
  "recovered", "repair", "repair_cluster", "repairing", "red", "requested", "reviewing",
  "running", "setting-up", "skipped", "skipped_changed_since_review", "stale", "stalled",
  "success", "telemetry_unavailable", "timed_out", "unavailable", "unresolved", "unknown",
  "waiting", "workflow", "workflow-fallback", "6h", "24h", "7d", "accepted", "deduped",
  "superseded", "fallback", "retryable", "permanent", "saturated", "malformed", "mixed",
  "observed", "queue_empty", "claim_stalled", "dispatcher_blocked", "dispatcher_paused",
  "claim_delayed", "handoff_current", "handoff_unknown", "capacity_unavailable", "capacity_available",
  "no_ready_backlog", "no_admissible_backlog", "dispatcher_inactive", "capacity_full_with_backlog",
  "scheduled_disposition_v1",
  "fresh", "miss", "repeated_failure_identity", "terminal_review_failure",
  "retryable_review_failure", "queue_telemetry_unavailable", "queue_handoff_stalled",
  "queue_handoff_degraded", "queue_handoff_unavailable", "publication_critical",
  "publication_degraded", "publication_health_unavailable", "publication_dlq_open",
  "review_failures_repeated", "review_failures_recent", "review_failure_telemetry_unavailable",
  "review_retries_exhausted", "workflow_execution_stalled", "workflow_execution_degraded",
  "worker_failures_unresolved", "apply_health_attention", "automerge_attention"
]);
const STATUS_TIME_FIELDS = new Set([
  "at", "client_checked_at", "completed_at", "generated_at", "observed_at", "oldest_at", "oldest_pending_at",
  "oldest_ready_at", "oldest_backoff_at", "oldest_dispatching_at", "oldest_leased_at",
  "next_attempt_at", "next_wake_at", "last_tide_at", "received_at", "since", "started_at",
  "updated_at", "washed_at", "first_seen_at", "last_seen_at"
]);
const STATUS_TIMESTAMP_PATTERN =
  /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/;
const STATUS_NUMBER_FIELDS = new Set([
  "schema_version", "applying", "arriving", "active_codex_jobs", "active", "active_intake_runs",
  "active_worker_runs", "active_workflow_runs", "action_records", "attempts", "available_slots",
  "automerge_samples", "bot_owned_proof_decisions_requested", "bot_owned_proof_dispatches",
  "budget_used_percent", "capacity", "cancelled_attempts", "closed", "comment_synced",
  "completed", "confirmed_proposal", "count", "dispatching", "error_rate_percent", "examined",
  "failed_review_retries", "failed_review_retry_exhaustions", "failed_attempts", "failed_recent_runs",
  "failing", "fallbacks", "guarded_retry", "inherited_label_cleanups", "inconsistent_or_stale",
  "issues", "leased", "measured_attempts", "oldest_queued_minutes", "oldest_running_minutes",
  "oldest_wedged_rerun_minutes", "oldest_zombie_queued_minutes", "pending", "pending_depth", "processed", "publishing",
  "promotion_cooldown_eligible", "promotion_eligible", "promotion_total", "cooldown_eligible_total",
  "proof_required", "prs", "queued_over_threshold", "queued_runs", "queued_workflow_runs",
  "recovered_failures", "recovery_rate_percent", "review_refresh", "repairing", "reviewing",
  "running_over_threshold", "running", "sample_limit", "sampled_runs", "setting_up", "samples",
  "self_heal_conflict_repairs", "support_queued_workflow_runs", "support_workflow_runs",
  "stalled_after_seconds", "successful_attempts", "skipped", "skipped_changed_since_review",
  "tide_generation", "tide_threshold", "target_repository_count", "total", "unresolved_failures",
  "worker_budget", "worker_detail_fallbacks", "worker_detail_runs", "waiting", "window_minutes",
  "window_hours", "wedged_rerun_runs", "zombie_queued_runs", "apply_ready_count", "attention_count",
  "automerge_command_to_merge_ms", "average_duration_ms", "average_ms", "candidate_count",
  "completed_attempts", "duration_ms", "elapsed_ms", "age_ms", "error_count", "estimated_full_cycle_minutes",
  "failure_rate_percent", "generated_count", "longest_duration_ms", "maximum_age_ms", "median_ms",
  "oldest_age_seconds", "oldest_dispatching_age_seconds", "oldest_leased_age_seconds",
  "oldest_pending_age_seconds", "omitted_count", "ready_pending", "admissible_pending",
  "scheduled_interval_minutes", "target_rate_per_hour", "terminal_count", "total_count", "total_duration_ms", "ttl_seconds",
  "setting-up", "ready", "backoff", "parked", "oldest_ready_age_seconds",
  "oldest_backoff_age_seconds", "oldest_lease_age_seconds", "enqueued_total", "completed_total",
  "published_total", "superseded_total", "semantic_deduped_total", "retried_total",
  "dead_lettered_total", "refreshed_total", "shed_since_reset", "warning_after_seconds",
  "scan_limit", "bucket_seconds", "bucket_count", "rows", "retention_seconds", "index",
  "dispatch_debounce", "dispatcher_backoff", "admission_retry", "coordination_retry",
  "throttle_retry", "review_retry", "publication_retry", "dead_letter_capacity",
  "dispatch_rejected", "review_retry_exhausted", "direct_publication", "claim_timeout",
  "execution_timeout", "workflow_cancelled", "workflow_failed", "affected_targets",
  "retryable_attempts", "terminal_attempts", "repeated_identities", "agent_input_scan",
  "source_preparation", "provider_or_model", "workflow"
]);
function dashboardStatusNumber(value, field) {
  if (!STATUS_NUMBER_FIELDS.has(field) || !Number.isFinite(value) || value < 0) return undefined;
  if (field === "schema_version") return value === 1 ? 1 : undefined;
  if (field === "error_count") return Number.isSafeInteger(value) && value <= 20 ? value : undefined;
  if (field.endsWith("_percent")) return value <= 100 ? value : undefined;
  return Number.isSafeInteger(value) && value <= 1000000000000 ? value : undefined;
}
function dashboardStatusValue(value, field, depth) {
  if (depth > 12) return undefined;
  if (value === null) {
    return STATUS_CONTAINER_FIELDS.has(field) || STATUS_NUMBER_FIELDS.has(field) ||
      STATUS_TEXT_FIELDS.has(field) || STATUS_TIME_FIELDS.has(field) ? null : undefined;
  }
  if (typeof value === "boolean") return STATUS_BOOLEAN_FIELDS.has(field) ? value : undefined;
  if (typeof value === "number") return dashboardStatusNumber(value, field);
  if (typeof value === "string") {
    const text = value.trim();
    if (STATUS_TIME_FIELDS.has(field)) {
      if (text.length > 35 || !STATUS_TIMESTAMP_PATTERN.test(text)) return undefined;
      const parsed = Date.parse(text);
      return Number.isFinite(parsed) && parsed >= Date.UTC(2020, 0, 1) && parsed < Date.UTC(2100, 0, 1)
        ? new Date(parsed).toISOString()
        : undefined;
    }
    if (!STATUS_TEXT_FIELDS.has(field)) return undefined;
    const normalized = text.toLowerCase();
    return STATUS_TEXT_VALUES.has(normalized) ? normalized : undefined;
  }
  if (Array.isArray(value)) {
    if (!STATUS_CONTAINER_FIELDS.has(field)) return undefined;
    return value.slice(0, 100).map(entry => dashboardStatusValue(entry, field, depth + 1)).filter(entry => entry !== undefined);
  }
  if (!value || typeof value !== "object" || !STATUS_CONTAINER_FIELDS.has(field)) return undefined;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const projected = dashboardStatusValue(entry, key, depth + 1);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}
function dashboardPublicBayReferences(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 124) return [];
  const stages = new Set(["arriving", "setting-up", "reviewing", "publishing", "applying", "repairing"]);
  const sources = new Set(["queue", "live"]);
  const seen = new Set();
  const references = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const repository = typeof entry.repository === "string" ? entry.repository.trim().toLowerCase() : "";
    const itemNumber = entry.item_number;
    if (
      repository.length > 200 ||
      !/^[a-z0-9_.-]+\\/[a-z0-9_.-]+$/.test(repository) ||
      typeof itemNumber !== "number" ||
      !Number.isSafeInteger(itemNumber) ||
      itemNumber <= 0 ||
      itemNumber > 1000000000 ||
      !stages.has(entry.stage) ||
      !sources.has(entry.source)
    ) return [];
    const key = repository + "#" + itemNumber;
    if (seen.has(key)) continue;
    seen.add(key);
    const action = dashboardPublicBayAction(entry.action);
    references.push({
      repository,
      item_number: itemNumber,
      stage: entry.stage,
      source: entry.source,
      ...(action ? { action } : {})
    });
  }
  return references;
}
const PUBLIC_ACTION_STEP_LABELS = {
  setup: "Set up job",
  checkout: "Check out repository",
  dependencies: "Prepare dependencies",
  lease: "Acquire work lease",
  review: "Run review",
  proof: "Verify proof",
  test: "Run checks",
  publish: "Publish result",
  apply: "Apply result",
  finalize: "Finalize",
  cleanup: "Clean up",
  workflow: "Workflow step"
};
function dashboardPublicBayAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const repository = typeof value.repository === "string" ? value.repository.trim().toLowerCase() : "";
  const runId = value.run_id;
  const jobId = value.job_id;
  const statuses = new Set(["queued", "in_progress", "completed"]);
  const conclusions = new Set(["success", "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "startup_failure", "stale"]);
  const startedAt = value.started_at === null ? null : dashboardObservabilityTimestamp(value.started_at);
  if (
    repository.length > 200 ||
    !/^[a-z0-9_.-]+\\/[a-z0-9_.-]+$/.test(repository) ||
    typeof runId !== "number" || !Number.isSafeInteger(runId) || runId <= 0 || runId > 1000000000000000 ||
    (jobId !== undefined && (typeof jobId !== "number" || !Number.isSafeInteger(jobId) || jobId <= 0 || jobId > 1000000000000000)) ||
    !statuses.has(value.status) ||
    (value.started_at !== null && !startedAt) ||
    typeof value.steps_complete !== "boolean" ||
    !Array.isArray(value.steps) || value.steps.length > 100
  ) return null;
  const steps = [];
  const seen = new Set();
  for (const step of value.steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return null;
    if (
      typeof step.sequence !== "number" || !Number.isSafeInteger(step.sequence) || step.sequence <= 0 || step.sequence > 1000 || seen.has(step.sequence) ||
      !Object.hasOwn(PUBLIC_ACTION_STEP_LABELS, step.kind) ||
      !statuses.has(step.status) ||
      (step.conclusion !== null && !conclusions.has(step.conclusion))
    ) return null;
    seen.add(step.sequence);
    steps.push({ sequence: step.sequence, kind: step.kind, status: step.status, conclusion: step.conclusion });
  }
  if ((!value.steps_complete && steps.length) || (value.steps_complete && steps.length !== value.steps.length)) return null;
  steps.sort((left, right) => left.sequence - right.sequence);
  return { repository, run_id: runId, ...(jobId === undefined ? {} : { job_id: jobId }), status: value.status, started_at: startedAt, steps_complete: value.steps_complete, steps };
}
function dashboardStatusSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const projected = dashboardStatusValue(value, "root", 0);
  const source = projected && typeof projected === "object" && !Array.isArray(projected) ? projected : null;
  if (source?.schema_version !== 1 || typeof source.generated_at !== "string") return null;
  const rawDiagnostics = value.diagnostics && typeof value.diagnostics === "object" && !Array.isArray(value.diagnostics)
    ? value.diagnostics
    : {};
  const rawErrorCount = Array.isArray(rawDiagnostics.errors)
    ? Math.min(rawDiagnostics.errors.length, 20)
    : 1;
  const declaredErrorCount = Number.isSafeInteger(rawDiagnostics.error_count) && rawDiagnostics.error_count >= 0 && rawDiagnostics.error_count <= 20
    ? rawDiagnostics.error_count
    : 0;
  const errorCount = Math.max(rawErrorCount, declaredErrorCount);
  const projectedQueue = source.exact_review_queue && typeof source.exact_review_queue === "object"
    ? source.exact_review_queue
    : null;
  const projectedBay = projectedQueue?.bay_projection && typeof projectedQueue.bay_projection === "object"
    ? projectedQueue.bay_projection
    : null;
  const projectedActivity = projectedBay?.activity && typeof projectedBay.activity === "object"
    ? projectedBay.activity
    : null;
  const rawItems = value.exact_review_queue?.bay_projection?.activity?.items;
  const publicReferences = dashboardPublicBayReferences(rawItems);
  const exactReviewQueue = projectedQueue && projectedBay && projectedActivity
    ? {
        ...projectedQueue,
        bay_projection: {
          ...projectedBay,
          activity: {
            ...projectedActivity,
            ...(publicReferences.length ? { items: publicReferences } : {})
          }
        }
      }
    : projectedQueue;
  return {
    schema_version: 1,
    generated_at: source.generated_at,
    source: source.source || { target_repository_count: 0 },
    fleet: source.fleet || { active_codex_jobs: 0, active_workflow_runs: 0, worker_budget: 0, budget_used_percent: 0 },
    control_plane: source.control_plane || {},
    health: source.health || {},
    operational_health: source.operational_health || { status: "unknown" },
    averages: source.averages || {},
    workers: Array.isArray(source.workers) ? source.workers : [],
    automatic_work: Array.isArray(source.automatic_work) ? source.automatic_work : [],
    pipeline: Array.isArray(source.pipeline) ? source.pipeline : [],
    bay: source.bay || {},
    recent: source.recent || {},
    diagnostics: {
      ...(source.diagnostics || {}),
      errors: Array.from({ length: errorCount }, () => "telemetry_unavailable"),
      error_count: errorCount,
    },
    dashboard_health: source.dashboard_health || { conclusion: "needs_attention", severity: "amber" },
    exact_review_queue: exactReviewQueue,
    recent_durable_publication_events: source.recent_durable_publication_events ?? null,
    freshness: dashboardStatusFreshness(source)
  };
}
function unavailableDashboardStatusFreshness(cacheState = "miss", maximumAgeMs = 60000) {
  return { state: "unavailable", cache_state: cacheState, generated_at: null, age_ms: null, maximum_age_ms: maximumAgeMs };
}
function dashboardStatusFreshness(source) {
  const freshness = source?.freshness && typeof source.freshness === "object" && !Array.isArray(source.freshness)
    ? source.freshness
    : null;
  const cacheState = freshness?.cache_state === "fresh" || freshness?.cache_state === "stale"
    ? freshness.cache_state
    : "miss";
  const maximumAgeMs = Number.isSafeInteger(freshness?.maximum_age_ms) &&
    freshness.maximum_age_ms > 0 && freshness.maximum_age_ms <= 900000
      ? freshness.maximum_age_ms
      : 60000;
  if (!freshness) return unavailableDashboardStatusFreshness(cacheState, maximumAgeMs);
  if (
    freshness.state === "unavailable" && freshness.generated_at === null &&
    freshness.age_ms === null
  ) return unavailableDashboardStatusFreshness(cacheState, maximumAgeMs);
  const generatedAt = dashboardObservabilityTimestamp(freshness.generated_at);
  const generatedMs = generatedAt ? Date.parse(generatedAt) : NaN;
  const clientCheckedAt = freshness.client_checked_at === undefined
    ? null
    : dashboardObservabilityTimestamp(freshness.client_checked_at);
  const clientCheckedMs = clientCheckedAt ? Date.parse(clientCheckedAt) : null;
  const now = Date.now();
  if (
    !generatedAt || generatedAt !== source.generated_at || !Number.isFinite(now) ||
    generatedMs > now + 60000 ||
    (freshness.client_checked_at !== undefined && !clientCheckedAt) ||
    (clientCheckedMs !== null && clientCheckedMs > now + 60000) ||
    !Number.isSafeInteger(freshness.age_ms) || freshness.age_ms < 0 ||
    (freshness.state !== "fresh" && freshness.state !== "stale")
  ) return unavailableDashboardStatusFreshness(cacheState, maximumAgeMs);
  const elapsedMs = clientCheckedMs === null
    ? Math.max(0, now - generatedMs)
    : Math.max(0, now - clientCheckedMs);
  const ageMs = clientCheckedMs === null
    ? Math.max(freshness.age_ms, elapsedMs)
    : freshness.age_ms + elapsedMs;
  if (!Number.isSafeInteger(ageMs) || ageMs > 1000000000000) {
    return unavailableDashboardStatusFreshness(cacheState, maximumAgeMs);
  }
  const state = freshness.state === "stale" || cacheState === "stale" || ageMs > maximumAgeMs
    ? "stale"
    : "fresh";
  return {
    state,
    cache_state: cacheState,
    generated_at: generatedAt,
    age_ms: ageMs,
    maximum_age_ms: maximumAgeMs,
    client_checked_at: new Date(now).toISOString()
  };
}
let lastData = null;
let loading = false;
let activeAutomergeRange = "7d";
let activeAutomergeChart = "success";
let lastAutomergeMetrics = null;
let automergeMetricsRequestGeneration = 0;
let activeWorkerFilter = "all";
let publicReferenceQuery = "";
let publicReferenceIndex = new Map();
let workerIndex = new Map();
let automaticIndex = new Map();
let activeHealthRange = "6h";
let activeApplyRange = "24h";
let healthHistoryLoadedAt = 0;
let healthHistorySamples = [];
let healthHistoryContract = unavailableDashboardHealthHistoryContract();
let applyObservabilityRequestGeneration = 0;
let lastApplyObservability = null;
let lastReviewCoverage = null;
let reviewCoverageRequestGeneration = 0;

function exactReviewHistory(lane) {
  return healthHistorySamples.flatMap(sample => {
    const laneSample = sample.exact_review?.collection_ok === true
      ? sample.exact_review?.[lane]
      : null;
    const pending = Number(laneSample?.pending);
    const enqueuedTotal = Number(laneSample?.enqueued_total);
    const completedTotal = Number(laneSample?.completed_total);
    const shedTotal = lane === "review" ? Number(laneSample?.shed_total || 0) : 0;
    const hasFlowCounters = Number.isFinite(enqueuedTotal) && Number.isFinite(completedTotal) && Number.isFinite(shedTotal);
    return Number.isFinite(Date.parse(sample.at)) && Number.isFinite(pending)
      ? [{
          at: sample.at,
          pending: Math.max(0, pending),
          ...(hasFlowCounters
            ? {
                enqueuedTotal: Math.max(0, enqueuedTotal),
                completedTotal: Math.max(0, completedTotal),
                shedTotal: Math.max(0, shedTotal)
              }
            : {})
        }]
      : [];
  });
}

function laneSpeedHistory(samples) {
  let segment = [];
  let previous = null;
  let segmentId = 0;
  return samples.flatMap(sample => {
    const at = Date.parse(sample.at);
    const hasFlowCounters =
      Number.isFinite(at) &&
      Number.isFinite(sample.enqueuedTotal) &&
      Number.isFinite(sample.completedTotal) &&
      Number.isFinite(sample.shedTotal);
    if (!hasFlowCounters) {
      // A legacy sample means the counter delta across this interval is
      // unknowable. Treat it as a boundary so the chart never bridges that
      // missing demand with a plausible-looking speed line.
      if (segment.length) segmentId += 1;
      segment = [];
      previous = null;
      return [];
    }
    const previousAt = previous ? Date.parse(previous.at) : null;
    const reset = previous && (
      at <= previousAt ||
      at - previousAt > 12 * 60 * 1000 ||
      sample.enqueuedTotal < previous.enqueuedTotal ||
      sample.completedTotal < previous.completedTotal ||
      sample.shedTotal < previous.shedTotal
    );
    if (reset) {
      segment = [];
      segmentId += 1;
    }
    previous = sample;
    segment.push(sample);
    const cutoff = at - 60 * 60 * 1000;
    const hourlyBaseline = segment.filter(candidate => Date.parse(candidate.at) <= cutoff).at(-1);
    const hasHourlyBaseline = hourlyBaseline && cutoff - Date.parse(hourlyBaseline.at) <= 12 * 60 * 1000;
    const baseline = hasHourlyBaseline ? hourlyBaseline : segment[0];
    const elapsedHours = (at - Date.parse(baseline.at)) / (60 * 60 * 1000);
    if (elapsedHours < 4 / 60) return [];
    const completed = sample.completedTotal - baseline.completedTotal;
    const incoming =
      sample.enqueuedTotal - baseline.enqueuedTotal + sample.shedTotal - baseline.shedTotal;
    return [{
      at: sample.at,
      rate: (completed - incoming) / elapsedHours,
      windowMinutes: elapsedHours * 60,
      provisional: !hasHourlyBaseline,
      segmentId
    }];
  });
}

function trendGeometry(samples, field, plot, maximum, fromAt, toAt) {
  if (!samples.length || maximum <= 0) return [];
  const span = Math.max(1, toAt - fromAt);
  let previousAt = null;
  return samples.flatMap(sample => {
    const at = Date.parse(sample.at);
    if (!Number.isFinite(at)) {
      previousAt = null;
      return [];
    }
    const x = plot.left + ((at - fromAt) / span) * plot.width;
    const y = plot.top + plot.height - (Math.max(0, Number(sample[field]) || 0) / maximum) * plot.height;
    const connected = previousAt !== null && at - previousAt <= 12 * 60 * 1000;
    previousAt = at;
    return [{ at, x, y, connected }];
  });
}

function trendPath(geometry) {
  return geometry.map(point => (point.connected ? "L" : "M") + point.x.toFixed(1) + " " + point.y.toFixed(1)).join(" ");
}

function niceTrendScale(maximum, tickCount) {
  const safeMaximum = Math.max(1, Number(maximum) || 0);
  const roughStep = safeMaximum / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = [1, 2, 2.5, 5, 10].find(candidate => normalized <= candidate) || 10;
  const step = factor * magnitude;
  return {
    maximum: step * tickCount,
    ticks: Array.from({ length: tickCount + 1 }, (_, index) => index * step),
  };
}

function niceSignedTrendScale(maximum) {
  const positive = niceTrendScale(Math.max(1, maximum), 2);
  const step = positive.maximum / 2;
  return {
    maximum: positive.maximum,
    ticks: [-positive.maximum, -step, 0, step, positive.maximum]
  };
}

function formatTrendValue(value) {
  return fmt.format(Math.round(value));
}

function formatSignedTrendValue(value) {
  const rounded = Math.round(value);
  if (rounded > 0) return "+" + fmt.format(rounded);
  if (rounded < 0) return "−" + fmt.format(Math.abs(rounded));
  return "0";
}

function speedTrendGeometry(samples, plot, maximum, fromAt, toAt) {
  if (!samples.length || maximum <= 0) return [];
  const span = Math.max(1, toAt - fromAt);
  let previous = null;
  return samples.map(sample => {
    const at = Date.parse(sample.at);
    const x = plot.left + ((at - fromAt) / span) * plot.width;
    const y = plot.top + ((maximum - sample.rate) / (maximum * 2)) * plot.height;
    const connected = previous !== null &&
      sample.segmentId === previous.segmentId &&
      at - previous.at <= 12 * 60 * 1000;
    const point = { at, x, y, connected, segmentId: sample.segmentId };
    previous = point;
    return point;
  });
}

function oneHourTrend(samples) {
  if (!samples.length) return { className: "collecting", label: "Collecting 1h trend" };
  const latest = samples.at(-1);
  const cutoff = Date.parse(latest.at) - 60 * 60 * 1000;
  const baseline = samples.filter(sample => Date.parse(sample.at) <= cutoff).at(-1);
  if (!baseline || cutoff - Date.parse(baseline.at) > 12 * 60 * 1000) {
    return { className: "collecting", label: "Collecting 1h trend" };
  }
  const delta = latest.pending - baseline.pending;
  if (delta > 0) return { className: "growing", label: "Growing · +" + fmt.format(delta) + " in the last hour" };
  if (delta < 0) return { className: "draining", label: "Draining · −" + fmt.format(Math.abs(delta)) + " in the last hour" };
  return { className: "stable", label: "Stable · no change in the last hour" };
}

function exactReviewTrend(samples, label, ariaMetric = "pending backlog") {
  if (!samples.length) {
    return '<div class="exact-trend"><div class="exact-trend-status collecting">Collecting 1h trend</div><div class="trend-empty">No backlog history in this range.</div></div>';
  }
  const width = 600;
  const height = 150;
  const plot = { left: 48, top: 8, width: 540, height: 110 };
  const rangeMs = activeHealthRange === "7d" ? 7 * 86400000 : activeHealthRange === "24h" ? 86400000 : 6 * 3600000;
  const latestAt = Date.parse(samples.at(-1).at);
  const toAt = Math.max(Date.now(), latestAt);
  const fromAt = toAt - rangeMs;
  const visible = samples.filter(sample => Date.parse(sample.at) >= fromAt && Date.parse(sample.at) <= toAt);
  const scale = niceTrendScale(Math.max(1, ...visible.map(sample => sample.pending)), 4);
  const grid = scale.ticks.map(value => {
    const y = plot.top + plot.height - value / scale.maximum * plot.height;
    return '<line class="trend-grid-line" x1="' + plot.left + '" x2="' + (plot.left + plot.width) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line><text class="trend-axis-label" x="' + (plot.left - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + esc(formatTrendValue(value)) + '</text>';
  }).join("");
  const geometry = trendGeometry(visible, "pending", plot, scale.maximum, fromAt, toAt);
  const points = geometry.map(point => '<circle class="exact-trend-point" cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) + '" r="3"></circle>').join("");
  const direction = oneHourTrend(visible);
  const rangeLabel = activeHealthRange === "7d" ? "7d ago" : activeHealthRange + " ago";
  const axis = '<text class="trend-axis-label" x="' + plot.left + '" y="' + (height - 7) + '">' + rangeLabel + '</text><text class="trend-axis-label" x="' + (plot.left + plot.width) + '" y="' + (height - 7) + '" text-anchor="end">now</text>';
  return '<div class="exact-trend"><div class="exact-trend-status ' + direction.className + '">' + esc(direction.label) + '</div><svg class="exact-trend-svg" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + esc(label + " " + ariaMetric + " over " + activeHealthRange) + '">' + grid + '<path class="exact-trend-line" d="' + trendPath(geometry) + '"></path>' + points + axis + '</svg></div>';
}

function laneSpeedStatus(sample) {
  const rate = Math.round(sample.rate);
  const window = sample.provisional
    ? " · provisional " + fmt.format(Math.round(sample.windowMinutes)) + "m window"
    : "";
  if (rate > 0) return { className: "catching-up", label: "Catching up" + window };
  if (rate < 0) return { className: "falling-behind", label: "Falling behind" + window };
  return { className: "stable", label: "Balanced" + window };
}

function laneRateLabel(speedLabel, helpText) {
  const helpId = "lane-rate-help-" + String(speedLabel).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const help = helpText
    ? '<details class="lane-rate-help"><summary aria-label="Explain ' + esc(speedLabel) + '" aria-describedby="' + esc(helpId) + '">?</summary><span class="lane-rate-tooltip" id="' + esc(helpId) + '" role="tooltip">' + esc(helpText) + '</span></details>'
    : "";
  return '<div class="lane-rate-label"><span>' + esc(speedLabel) + '</span>' + help + '</div>';
}

function laneSpeedTrend(samples, speedLabel, helpText = "") {
  const rates = laneSpeedHistory(samples);
  const rangeMs = activeHealthRange === "7d" ? 7 * 86400000 : activeHealthRange === "24h" ? 86400000 : 6 * 3600000;
  const latestAt = rates.length ? Date.parse(rates.at(-1).at) : 0;
  const latestObservationAt = samples.length ? Date.parse(samples.at(-1).at) : 0;
  const hasLatestObservation = Number.isFinite(latestObservationAt) && latestObservationAt > 0;
  const latestSegmentNeedsBaseline = hasLatestObservation && latestObservationAt > latestAt;
  const toAt = Math.max(Date.now(), latestAt, hasLatestObservation ? latestObservationAt : 0);
  const latestObservationFresh =
    hasLatestObservation && toAt - latestObservationAt <= 12 * 60 * 1000;
  const collectingCurrentSegment = latestSegmentNeedsBaseline && latestObservationFresh;
  const fromAt = toAt - rangeMs;
  const visible = rates.filter(sample => Date.parse(sample.at) >= fromAt && Date.parse(sample.at) <= toAt);
  const latestVisible = visible.at(-1);
  const current =
    !latestSegmentNeedsBaseline &&
    latestVisible &&
    toAt - Date.parse(latestVisible.at) <= 12 * 60 * 1000
      ? latestVisible
      : null;
  const headline = current
    ? formatSignedTrendValue(current.rate) + " / hour"
    : collectingCurrentSegment
      ? "Collecting"
    : hasLatestObservation || visible.length
      ? "Stale"
      : "Collecting";
  if (!visible.length) {
    const emptyClass = headline === "Stale" ? "stale" : "collecting";
    const emptyLabel = headline === "Stale"
      ? "Stale · no rate sample in the last 12m"
      : "Needs two continuous five-minute samples";
    return '<div class="lane-speed"><div class="lane-count">' + laneRateLabel(speedLabel, helpText) + '<strong>' + headline + '</strong></div><div class="exact-trend-status ' + emptyClass + '">' + emptyLabel + '</div><div class="trend-empty">No rate history in this range.</div></div>';
  }
  const width = 600;
  const height = 150;
  const plot = { left: 48, top: 8, width: 540, height: 110 };
  const scale = niceSignedTrendScale(Math.max(1, ...visible.map(sample => Math.abs(sample.rate))));
  const grid = scale.ticks.map(value => {
    const y = plot.top + ((scale.maximum - value) / (scale.maximum * 2)) * plot.height;
    const className = value === 0 ? "trend-grid-line lane-speed-zero" : "trend-grid-line";
    return '<line class="' + className + '" x1="' + plot.left + '" x2="' + (plot.left + plot.width) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line><text class="trend-axis-label" x="' + (plot.left - 8) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + esc(formatSignedTrendValue(value)) + '</text>';
  }).join("");
  const geometry = speedTrendGeometry(visible, plot, scale.maximum, fromAt, toAt);
  const points = geometry.map(point => '<circle class="lane-speed-point" cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) + '" r="3"></circle>').join("");
  const direction = current
    ? laneSpeedStatus(current)
    : collectingCurrentSegment
      ? { className: "collecting", label: "Needs two continuous five-minute samples" }
    : { className: "stale", label: "Stale · no rate sample in the last 12m" };
  const rangeLabel = activeHealthRange === "7d" ? "7d ago" : activeHealthRange + " ago";
  const axis = '<text class="trend-axis-label" x="' + plot.left + '" y="' + (height - 7) + '">' + rangeLabel + '</text><text class="trend-axis-label" x="' + (plot.left + plot.width) + '" y="' + (height - 7) + '" text-anchor="end">now</text>';
  return '<div class="lane-speed"><div class="lane-count">' + laneRateLabel(speedLabel, helpText) + '<strong>' + headline + '</strong></div><div class="exact-trend-status ' + direction.className + '">' + esc(direction.label) + '</div><svg class="exact-trend-svg" viewBox="0 0 ' + width + " " + height + '" role="img" aria-label="' + esc(speedLabel + ", completed minus incoming, over " + activeHealthRange) + '">' + grid + '<path class="lane-speed-line" d="' + trendPath(geometry) + '"></path>' + points + axis + '</svg></div>';
}

function renderExecutionAlert(current) {
  const target = document.getElementById("execution-alert");
  if (!target) return;
  const incomplete = !current || current.telemetry_complete !== true;
  const queued = Number(current?.queued_over_threshold) || 0;
  const running = Number(current?.running_over_threshold) || 0;
  if (!incomplete && queued === 0 && running === 0) {
    target.innerHTML = "";
    return;
  }
  const parts = [];
  if (queued) parts.push(fmt.format(queued) + " workflow" + (queued === 1 ? "" : "s") + " waiting for a runner over 30m");
  if (running) parts.push(fmt.format(running) + " execution" + (running === 1 ? "" : "s") + " over 150m");
  if (incomplete) parts.push("work execution telemetry is incomplete");
  const approvalGated = Number(current?.approval_gated_runs) || 0;
  const wedgedReruns = Number(current?.wedged_rerun_runs) || 0;
  const details = "Total GitHub queued " + fmt.format(Number(current?.queued_runs) || 0) + " · oldest queued " + formatAgeMinutes(current?.oldest_queued_minutes) + " · oldest running " + formatAgeMinutes(current?.oldest_running_minutes) + (wedgedReruns ? " · " + fmt.format(wedgedReruns) + " wedged pre-queue re-run" + (wedgedReruns === 1 ? "" : "s") + " excluded from health (oldest " + formatAgeMinutes(current?.oldest_wedged_rerun_minutes) + ")" : "") + (approvalGated ? " · " + fmt.format(approvalGated) + " awaiting deployment approval (oldest " + formatAgeMinutes(current?.oldest_approval_gated_minutes) + ")" : "");
  target.innerHTML = '<details class="execution-alert"><summary><span class="execution-alert-title"><strong>⚠ Work execution needs attention</strong><span>' + esc(parts.join(" · ")) + '</span></span><span class="execution-alert-toggle">Details ▾</span></summary><div class="execution-alert-body">' + esc(details) + '</div></details>';
}

function applyMetric(label, value, detail) {
  return '<div class="apply-observability-metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</div>';
}
const DASHBOARD_OBSERVABILITY_RANGES = ["6h", "24h", "7d"];
const DASHBOARD_OBSERVABILITY_MAX_COUNT = 10000000;
const DASHBOARD_OBSERVABILITY_MAX_DURATION_MS = 90 * 24 * 60 * 60 * 1000;
const DASHBOARD_OBSERVABILITY_TIMESTAMP_PATTERN =
  /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/;
const DASHBOARD_APPLY_RESULT_FIELDS = ["arrivals", "applied", "closed", "superseded", "retried", "dead_lettered"];
const DASHBOARD_APPLY_FAILURE_KINDS = [
  "state_lease_timeout", "state_lease_contention", "action_ledger_failure",
  "state_publication_failure", "safe_close_blocked", "safe_close_failure", "workflow_failure"
];
const DASHBOARD_AUTOMERGE_OUTCOMES = [
  "merged", "repair_failed", "maintainer_stopped", "repair_cap_exhausted",
  "pr_closed", "automerge_disabled"
];
const DASHBOARD_AUTOMERGE_BUCKET_COUNTS = { "6h": 12, "24h": 12, "7d": 14 };
const DASHBOARD_AUTOMERGE_RANGE_MS = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
};
function dashboardObservabilityObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function dashboardObservabilityMember(values, value) {
  return values.some(candidate => candidate === value);
}
function dashboardObservabilityTimestamp(value) {
  if (typeof value !== "string" || value.length > 35 || !DASHBOARD_OBSERVABILITY_TIMESTAMP_PATTERN.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= Date.UTC(2020, 0, 1) && parsed < Date.UTC(2100, 0, 1)
    ? new Date(parsed).toISOString()
    : null;
}
function dashboardObservabilityNullableTimestamp(value) {
  if (value === null) return null;
  return dashboardObservabilityTimestamp(value) || undefined;
}
function dashboardObservabilityCount(value, maximum = DASHBOARD_OBSERVABILITY_MAX_COUNT) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}
function dashboardObservabilityNullableCount(value, maximum = DASHBOARD_OBSERVABILITY_MAX_COUNT) {
  if (value === null) return null;
  const parsed = dashboardObservabilityCount(value, maximum);
  return parsed === null ? undefined : parsed;
}
function dashboardObservabilityNullableSignedCount(value) {
  if (value === null) return null;
  return Number.isSafeInteger(value) && Math.abs(value) <= DASHBOARD_OBSERVABILITY_MAX_COUNT
    ? value
    : undefined;
}
function dashboardObservabilityNullableNumber(value, minimum, maximum) {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}
function dashboardObservabilityNullableCountObject(value, fields) {
  const source = dashboardObservabilityObject(value);
  if (!source) return null;
  const result = {};
  for (const field of fields) {
    const parsed = dashboardObservabilityNullableCount(source[field]);
    if (parsed === undefined) return null;
    result[field] = parsed;
  }
  return result;
}
function dashboardObservabilityCountObject(value, fields) {
  const source = dashboardObservabilityObject(value);
  if (!source) return null;
  const result = {};
  for (const field of fields) {
    const parsed = dashboardObservabilityCount(source[field]);
    if (parsed === null) return null;
    result[field] = parsed;
  }
  return result;
}
const DASHBOARD_REVIEW_COVERAGE_TOTAL_FIELDS = [
  "open_records", "reviewable_records", "tracked_records", "reviewed_recent", "stale", "failed",
  "expired", "unreviewed_records", "untracked_open", "pending", "excluded",
  "unschedulable_records", "record_drift"
];
function dashboardReviewCoverageSnapshot(value) {
  const source = dashboardObservabilityObject(value);
  const totalsSource = dashboardObservabilityObject(source?.totals);
  if (!source || source.ok !== true || !totalsSource) return null;
  const generatedAt = dashboardObservabilityTimestamp(source.generated_at);
  const inventoryGeneratedAt = dashboardObservabilityNullableTimestamp(source.inventory_generated_at);
  const windowDays = dashboardObservabilityCount(source.window_days, 90);
  if (
    !generatedAt || inventoryGeneratedAt === undefined || windowDays === null || windowDays < 1 ||
    !dashboardObservabilityMember(["missing", "stale", "current"], source.inventory_status) ||
    (source.inventory_status === "missing") !== (inventoryGeneratedAt === null)
  ) return null;
  const totals = {};
  for (const field of DASHBOARD_REVIEW_COVERAGE_TOTAL_FIELDS) {
    const parsed = dashboardObservabilityCount(totalsSource[field]);
    if (parsed === null) return null;
    totals[field] = parsed;
  }
  const coveragePercent = dashboardObservabilityNullableNumber(totalsSource.coverage_percent, 0, 100);
  if (coveragePercent === undefined) return null;
  const expectedCoverage = totals.reviewable_records
    ? Math.round((totals.reviewed_recent / totals.reviewable_records) * 1000) / 10
    : null;
  if (totals.reviewed_recent > totals.reviewable_records || coveragePercent !== expectedCoverage) return null;
  return {
    ok: true,
    generated_at: generatedAt,
    window_days: windowDays,
    inventory_generated_at: inventoryGeneratedAt,
    inventory_status: source.inventory_status,
    totals: { ...totals, coverage_percent: expectedCoverage }
  };
}
const DASHBOARD_HEALTH_HISTORY_RANGE_MS = {
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000
};
const DASHBOARD_HEALTH_HISTORY_SAMPLE_MS = 5 * 60 * 1000;
const DASHBOARD_HEALTH_HISTORY_RETENTION_DAYS = 7;
const DASHBOARD_HEALTH_HISTORY_MAX_TOTAL = 1000000000000;
const DASHBOARD_HEALTH_HISTORY_STATUSES = ["healthy", "degraded", "stalled", "unknown"];
const DASHBOARD_HEALTH_HISTORY_HANDOFF_STATUSES = ["idle", "healthy", "degraded", "stalled"];
const DASHBOARD_HEALTH_HISTORY_WRITER_MODES = ["single_item", "batch", "mixed", "unknown"];
function dashboardHealthHistoryOptionalCount(value, maximum = DASHBOARD_OBSERVABILITY_MAX_COUNT) {
  return value === undefined ? undefined : dashboardObservabilityCount(value, maximum);
}
function dashboardHealthHistoryPercentiles(value) {
  const source = dashboardObservabilityObject(value);
  if (!source) return null;
  const p50 = source.p50 === null ? null : dashboardHealthHistoryOptionalCount(source.p50);
  const p95 = source.p95 === null ? null : dashboardHealthHistoryOptionalCount(source.p95);
  const samples = dashboardObservabilityCount(source.samples);
  const pairPresent = p50 !== null && p50 !== undefined && p95 !== null && p95 !== undefined;
  if (
    p50 === undefined || p95 === undefined || samples === null ||
    (samples === 0 && (p50 !== null || p95 !== null)) ||
    (samples > 0 && (!pairPresent || p50 > p95))
  ) return null;
  return { p50, p95, samples };
}
function dashboardHealthHistoryLane(value, includeShed) {
  const source = dashboardObservabilityObject(value);
  if (!source) return null;
  const pending = dashboardObservabilityCount(source.pending);
  const enqueuedTotal = dashboardHealthHistoryOptionalCount(source.enqueued_total, DASHBOARD_HEALTH_HISTORY_MAX_TOTAL);
  const completedTotal = dashboardHealthHistoryOptionalCount(source.completed_total, DASHBOARD_HEALTH_HISTORY_MAX_TOTAL);
  const shedTotal = includeShed ? dashboardHealthHistoryOptionalCount(source.shed_total) : undefined;
  if (
    pending === null || enqueuedTotal === null || completedTotal === null || shedTotal === null ||
    (enqueuedTotal === undefined) !== (completedTotal === undefined)
  ) return null;
  return {
    pending,
    ...(enqueuedTotal === undefined ? {} : { enqueued_total: enqueuedTotal }),
    ...(completedTotal === undefined ? {} : { completed_total: completedTotal }),
    ...(shedTotal === undefined ? {} : { shed_total: shedTotal })
  };
}
function dashboardHealthHistoryExactReview(value) {
  const source = dashboardObservabilityObject(value);
  if (!source || typeof source.collection_ok !== "boolean") return null;
  if (!source.collection_ok) return { collection_ok: false };
  const review = dashboardHealthHistoryLane(source.review, true);
  const publication = dashboardHealthHistoryLane(source.publication, false);
  if (!review || !publication) return null;
  const result = { collection_ok: true, review, publication };
  if (source.handoff !== undefined) {
    const handoff = dashboardObservabilityObject(source.handoff);
    const pending = handoff && dashboardObservabilityCount(handoff.pending);
    const dispatching = handoff && dashboardObservabilityCount(handoff.dispatching);
    const leased = handoff && dashboardObservabilityCount(handoff.leased);
    if (
      !handoff || !dashboardObservabilityMember(DASHBOARD_HEALTH_HISTORY_HANDOFF_STATUSES, handoff.status) ||
      pending === null || dispatching === null || leased === null
    ) return null;
    result.handoff = { status: handoff.status, pending, dispatching, leased };
  }
  return result;
}
function dashboardHealthHistoryStateWriter(value) {
  const source = dashboardObservabilityObject(value);
  if (!source || typeof source.collection_ok !== "boolean") return null;
  if (!source.collection_ok) return { collection_ok: false };
  if (
    typeof source.terminal_collection_ok !== "boolean" ||
    !dashboardObservabilityMember(DASHBOARD_HEALTH_HISTORY_WRITER_MODES, source.mode)
  ) return null;
  const result = {
    collection_ok: true,
    terminal_collection_ok: source.terminal_collection_ok,
    mode: source.mode
  };
  for (const field of [
    "tracked_holding", "tracked_waiting", "tracked_releasing", "accepted_operations_total",
    "state_commits_total", "materialized_items_total", "contention_timeouts_total"
  ]) {
    const parsed = dashboardHealthHistoryOptionalCount(source[field]);
    if (parsed === null) return null;
    if (parsed !== undefined) result[field] = parsed;
  }
  const wait = dashboardHealthHistoryPercentiles(source.wait_ms);
  const hold = dashboardHealthHistoryPercentiles(source.hold_ms);
  if (!wait || !hold) return null;
  const lastSuccessful = source.last_successful_materialization_at === null
    ? null
    : dashboardObservabilityTimestamp(source.last_successful_materialization_at);
  if (lastSuccessful === null && source.last_successful_materialization_at !== null) return null;
  result.wait_ms = wait;
  result.hold_ms = hold;
  result.last_successful_materialization_at = lastSuccessful;
  return result;
}
function dashboardHealthHistorySample(value) {
  const source = dashboardObservabilityObject(value);
  if (!source) return null;
  const at = dashboardObservabilityTimestamp(source.at);
  if (!at) return null;
  const operationalFields = [
    "status", "collection_ok", "queued", "queued_over_30m", "oldest_queued_minutes",
    "running", "running_over_150m", "oldest_running_minutes"
  ];
  const hasOperational = operationalFields.some(field => Object.prototype.hasOwnProperty.call(source, field));
  const result = { at };
  if (hasOperational) {
    if (
      !dashboardObservabilityMember(DASHBOARD_HEALTH_HISTORY_STATUSES, source.status) ||
      typeof source.collection_ok !== "boolean"
    ) return null;
    const counts = {};
    for (const field of operationalFields.slice(2)) {
      const parsed = dashboardObservabilityCount(source[field]);
      if (parsed === null) return null;
      counts[field] = parsed;
    }
    if (counts.queued_over_30m > counts.queued || counts.running_over_150m > counts.running) return null;
    Object.assign(result, { status: source.status, collection_ok: source.collection_ok }, counts);
  }
  if (source.exact_review !== undefined) {
    const exactReview = dashboardHealthHistoryExactReview(source.exact_review);
    if (!exactReview) return null;
    result.exact_review = exactReview;
  }
  if (source.state_writer !== undefined) {
    const stateWriter = dashboardHealthHistoryStateWriter(source.state_writer);
    if (!stateWriter) return null;
    result.state_writer = stateWriter;
  }
  return hasOperational || result.exact_review || result.state_writer ? result : null;
}
function unavailableDashboardHealthHistoryContract() {
  return {
    coverage: { state: "unavailable", expected_slots: null, observed_slots: null, usable_slots: null, failed_slots: null, missing_slots: null, coverage_percent: null, largest_gap_slots: null, largest_gap_ms: null, window_started_at: null, window_ended_at: null },
    freshness: { state: "unavailable", latest_sample_at: null, age_ms: null, maximum_age_ms: 720000 }
  };
}
function exactUnavailableDashboardHealthHistoryContract(source) {
  if (source.generated_at !== null) return null;
  const expected = unavailableDashboardHealthHistoryContract();
  const coverage = dashboardObservabilityObject(source.coverage);
  const freshness = dashboardObservabilityObject(source.freshness);
  if (!coverage || !freshness) return null;
  const coverageFields = Object.keys(expected.coverage);
  const freshnessFields = Object.keys(expected.freshness);
  if (
    Object.keys(coverage).length !== coverageFields.length ||
    Object.keys(freshness).length !== freshnessFields.length ||
    coverageFields.some((field) => coverage[field] !== expected.coverage[field]) ||
    freshnessFields.some((field) => freshness[field] !== expected.freshness[field])
  ) return null;
  return expected;
}
function dashboardHealthHistoryContract(source, rangeMs) {
  const coverage = dashboardObservabilityObject(source.coverage);
  const freshness = dashboardObservabilityObject(source.freshness);
  const generatedAt = dashboardObservabilityTimestamp(source.generated_at);
  if (source.generated_at === null) return exactUnavailableDashboardHealthHistoryContract(source);
  if (!coverage && !freshness && !generatedAt) return unavailableDashboardHealthHistoryContract();
  const expected = dashboardObservabilityCount(coverage?.expected_slots);
  const observed = dashboardObservabilityCount(coverage?.observed_slots);
  const usable = dashboardObservabilityCount(coverage?.usable_slots);
  const failed = dashboardObservabilityCount(coverage?.failed_slots);
  const missing = dashboardObservabilityCount(coverage?.missing_slots);
  const largestGap = dashboardObservabilityCount(coverage?.largest_gap_slots);
  const largestGapMs = dashboardObservabilityCount(coverage?.largest_gap_ms);
  const coveragePercent =
    typeof coverage?.coverage_percent === "number" &&
    Number.isFinite(coverage.coverage_percent) &&
    coverage.coverage_percent >= 0 && coverage.coverage_percent <= 100
      ? coverage.coverage_percent
      : null;
  const expectedCoveragePercent =
    expected === 0 || usable === null ? null : Math.round((usable / expected) * 10_000) / 100;
  const windowStartedAt = dashboardObservabilityTimestamp(coverage?.window_started_at);
  const windowEndedAt = dashboardObservabilityTimestamp(coverage?.window_ended_at);
  const windowStartedMs = windowStartedAt ? Date.parse(windowStartedAt) : NaN;
  const windowEndedMs = windowEndedAt ? Date.parse(windowEndedAt) : NaN;
  const expectedFromWindow =
    Number.isFinite(windowStartedMs) && Number.isFinite(windowEndedMs)
      ? Math.floor(windowEndedMs / DASHBOARD_HEALTH_HISTORY_SAMPLE_MS) -
        Math.ceil(windowStartedMs / DASHBOARD_HEALTH_HISTORY_SAMPLE_MS) +
        1
      : null;
  const latestSampleAt = freshness?.latest_sample_at === null
    ? null
    : dashboardObservabilityTimestamp(freshness?.latest_sample_at);
  const ageMs = freshness?.age_ms === null ? null : dashboardObservabilityCount(freshness?.age_ms);
  const maximumAgeMs = dashboardObservabilityCount(freshness?.maximum_age_ms);
  const generatedMs = generatedAt ? Date.parse(generatedAt) : NaN;
  const latestSampleMs = latestSampleAt ? Date.parse(latestSampleAt) : null;
  const expectedAgeMs = latestSampleMs === null || !Number.isFinite(generatedMs)
    ? null
    : Math.max(0, generatedMs - latestSampleMs);
  const expectedFreshnessState = expectedAgeMs === null
    ? "unavailable"
    : expectedAgeMs <= 720000 ? "fresh" : "stale";
  if (
    !coverage || !freshness || !generatedAt ||
    !["complete", "partial", "unavailable"].includes(coverage.state) ||
    !["fresh", "stale", "unavailable"].includes(freshness.state) ||
    windowEndedMs - windowStartedMs !== rangeMs || expected !== expectedFromWindow ||
    observed === null || usable === null || failed === null || missing === null ||
    usable + failed !== observed || observed + missing !== expected ||
    largestGap === null || largestGapMs !== largestGap * DASHBOARD_HEALTH_HISTORY_SAMPLE_MS ||
    coveragePercent === undefined || coveragePercent === null || coveragePercent !== expectedCoveragePercent ||
    (coverage.state === "unavailable") !== (usable === 0) ||
    (coverage.state === "complete") !== (usable === expected) ||
    !windowStartedAt || !windowEndedAt ||
    maximumAgeMs !== 720000 ||
    (latestSampleAt === null) !== (freshness.latest_sample_at === null) ||
    (ageMs === null) !== (freshness.age_ms === null) ||
    (freshness.state === "unavailable") !== (latestSampleAt === null) ||
    (latestSampleMs !== null && latestSampleMs > generatedMs) ||
    ageMs !== expectedAgeMs || freshness.state !== expectedFreshnessState
  ) return null;
  return {
    generated_at: generatedAt,
    coverage: { state: coverage.state, expected_slots: expected, observed_slots: observed, usable_slots: usable, failed_slots: failed, missing_slots: missing, coverage_percent: coveragePercent, largest_gap_slots: largestGap, largest_gap_ms: largestGapMs, window_started_at: windowStartedAt, window_ended_at: windowEndedAt },
    freshness: { state: freshness.state, latest_sample_at: latestSampleAt, age_ms: ageMs, maximum_age_ms: maximumAgeMs }
  };
}
function dashboardHealthHistorySnapshot(value, requestedRange) {
  const source = dashboardObservabilityObject(value);
  const rangeMs = DASHBOARD_HEALTH_HISTORY_RANGE_MS[requestedRange];
  if (
    !source || !rangeMs || source.schema_version !== 1 || source.range !== requestedRange ||
    source.retention_days !== DASHBOARD_HEALTH_HISTORY_RETENTION_DAYS || !Array.isArray(source.samples)
  ) return null;
  const sampleLimit = Math.ceil(rangeMs / DASHBOARD_HEALTH_HISTORY_SAMPLE_MS) + 1;
  if (source.samples.length > sampleLimit) return null;
  const samples = [];
  const slots = new Set();
  let previousAt = null;
  const now = Date.now();
  for (const value of source.samples) {
    const sample = dashboardHealthHistorySample(value);
    if (!sample) return null;
    const at = Date.parse(sample.at);
    const slot = Math.floor(at / DASHBOARD_HEALTH_HISTORY_SAMPLE_MS);
    if (
      (previousAt !== null && at <= previousAt) || slots.has(slot) ||
      at < now - rangeMs - DASHBOARD_HEALTH_HISTORY_SAMPLE_MS ||
      at > now + DASHBOARD_HEALTH_HISTORY_SAMPLE_MS
    ) return null;
    previousAt = at;
    slots.add(slot);
    samples.push(sample);
  }
  const contract = dashboardHealthHistoryContract(source, rangeMs);
  if (!contract || (source.generated_at === null && samples.length > 0)) return null;
  return {
    schema_version: 1,
    range: requestedRange,
    retention_days: DASHBOARD_HEALTH_HISTORY_RETENTION_DAYS,
    generated_at: contract.generated_at || null,
    coverage: contract.coverage,
    freshness: contract.freshness,
    samples
  };
}
function dashboardApplyAggregate(value) {
  const source = dashboardObservabilityObject(value);
  if (!source) return null;
  const result = {};
  for (const field of DASHBOARD_APPLY_RESULT_FIELDS) {
    const parsed = dashboardObservabilityNullableCount(source[field]);
    if (parsed === undefined) return null;
    result[field] = parsed;
  }
  const netDrain = dashboardObservabilityNullableSignedCount(source.net_drain);
  const expectedNetDrain = result.arrivals === null || result.applied === null
    ? null
    : result.applied - result.arrivals;
  return netDrain === expectedNetDrain ? { ...result, net_drain: expectedNetDrain } : null;
}
function dashboardApplyObservabilitySnapshot(value) {
  const source = dashboardObservabilityObject(value);
  if (!source) return null;
  const generatedAt = dashboardObservabilityTimestamp(source.generated_at);
  const eventCount = dashboardObservabilityCount(source.event_count);
  const queue = dashboardObservabilityNullableCountObject(source.queue, [
    "active", "capacity", "ready", "backoff", "dispatching", "leased",
    "oldest_ready_age_seconds", "oldest_backoff_age_seconds", "oldest_lease_age_seconds"
  ]);
  const last15Minutes = dashboardApplyAggregate(source.last_15_minutes);
  const last60Minutes = dashboardApplyAggregate(source.last_60_minutes);
  const totals = dashboardApplyAggregate(source.totals);
  const lease = dashboardObservabilityNullableCountObject(source.lease, ["wait_ms", "hold_ms"]);
  const failuresSource = dashboardObservabilityObject(source.failures);
  const retryAmplification = dashboardObservabilityNullableNumber(
    source.retry_amplification,
    0,
    DASHBOARD_OBSERVABILITY_MAX_COUNT
  );
  const expectedRetryAmplification = !totals
    ? undefined
    : totals.retried === null || totals.applied === null || totals.applied === 0
      ? null
      : Math.round((totals.retried / totals.applied) * 100) / 100;
  if (
    source.schema_version !== 1 ||
    !dashboardObservabilityMember(DASHBOARD_OBSERVABILITY_RANGES, source.range) ||
    (source.repo !== undefined && source.repo !== "all") ||
    !generatedAt ||
    typeof source.telemetry_complete !== "boolean" ||
    eventCount === null ||
    !queue ||
    !last15Minutes ||
    !last60Minutes ||
    !totals ||
    !lease ||
    !failuresSource ||
    retryAmplification === undefined ||
    expectedRetryAmplification === undefined ||
    retryAmplification !== expectedRetryAmplification
  ) return null;
  const failures = {};
  for (const field of [
    "state_lease_timeout", "state_lease_contention", "action_ledger",
    "state_publication", "safe_close_blocked", "safe_close_failure"
  ]) {
    const parsed = dashboardObservabilityNullableCount(failuresSource[field]);
    if (parsed === undefined) return null;
    failures[field] = parsed;
  }
  const lastFailureKind = failuresSource.last_failure_kind;
  const lastFailureAt = dashboardObservabilityNullableTimestamp(failuresSource.last_failure_at);
  if (
    (lastFailureKind !== null && !dashboardObservabilityMember(DASHBOARD_APPLY_FAILURE_KINDS, lastFailureKind)) ||
    lastFailureAt === undefined ||
    (lastFailureKind === null) !== (lastFailureAt === null)
  ) return null;
  failures.last_failure_kind = lastFailureKind;
  failures.last_failure_at = lastFailureAt;
  return {
    schema_version: 1,
    range: source.range,
    generated_at: generatedAt,
    telemetry_complete: source.telemetry_complete,
    event_count: eventCount,
    queue,
    last_15_minutes: last15Minutes,
    last_60_minutes: last60Minutes,
    totals,
    retry_amplification: expectedRetryAmplification,
    lease,
    failures
  };
}
function dashboardAutomergeSummary(value) {
  const source = dashboardObservabilityObject(value);
  if (!source) return null;
  const terminalSessions = dashboardObservabilityCount(source.terminal_sessions);
  const mergedSessions = dashboardObservabilityCount(source.merged_sessions);
  const activeSessions = dashboardObservabilityCount(source.active_sessions);
  const successRate = dashboardObservabilityNullableNumber(source.merge_success_rate_percent, 0, 100);
  const latencyP50 = dashboardObservabilityNullableCount(source.command_to_merge_p50_ms, DASHBOARD_OBSERVABILITY_MAX_DURATION_MS);
  const latencyP90 = dashboardObservabilityNullableCount(source.command_to_merge_p90_ms, DASHBOARD_OBSERVABILITY_MAX_DURATION_MS);
  const baseSyncP50 = dashboardObservabilityNullableCount(source.base_sync_p50);
  const baseSyncP90 = dashboardObservabilityNullableCount(source.base_sync_p90);
  const multiRebaseRate = dashboardObservabilityNullableNumber(source.multi_rebase_rate_percent, 0, 100);
  if (
    terminalSessions === null || mergedSessions === null || activeSessions === null ||
    successRate === undefined || latencyP50 === undefined || latencyP90 === undefined ||
    baseSyncP50 === undefined || baseSyncP90 === undefined || multiRebaseRate === undefined ||
    mergedSessions > terminalSessions
  ) return null;
  const expectedSuccessRate = terminalSessions
    ? Math.round((mergedSessions / terminalSessions) * 1000) / 10
    : null;
  const latencyPairValid =
    (latencyP50 === null) === (latencyP90 === null) &&
    (latencyP50 === null || latencyP50 <= latencyP90) &&
    (mergedSessions > 0 || latencyP50 === null);
  const baseSyncPairValid = terminalSessions
    ? baseSyncP50 !== null && baseSyncP90 !== null && baseSyncP50 <= baseSyncP90
    : baseSyncP50 === null && baseSyncP90 === null;
  if (successRate !== expectedSuccessRate || !latencyPairValid || !baseSyncPairValid) return null;
  return {
    terminal_sessions: terminalSessions,
    merged_sessions: mergedSessions,
    merge_success_rate_percent: expectedSuccessRate,
    command_to_merge_p50_ms: latencyP50,
    command_to_merge_p90_ms: latencyP90,
    base_sync_p50: baseSyncP50,
    base_sync_p90: baseSyncP90,
    multi_rebase_rate_percent: multiRebaseRate,
    active_sessions: activeSessions
  };
}
function dashboardAutomergeBuckets(value, range) {
  if (!Array.isArray(value) || value.length !== DASHBOARD_AUTOMERGE_BUCKET_COUNTS[range]) return null;
  const result = [];
  let priorEnd = null;
  for (const entry of value) {
    const source = dashboardObservabilityObject(entry);
    if (!source) return null;
    const start = dashboardObservabilityTimestamp(source.start);
    const end = dashboardObservabilityTimestamp(source.end);
    const terminalCount = dashboardObservabilityCount(source.terminal_count);
    const mergedCount = dashboardObservabilityCount(source.merged_count);
    const successRate = dashboardObservabilityNullableNumber(source.success_rate_percent, 0, 100);
    const latencyP50 = dashboardObservabilityNullableCount(source.command_to_merge_p50_ms, DASHBOARD_OBSERVABILITY_MAX_DURATION_MS);
    const latencyP90 = dashboardObservabilityNullableCount(source.command_to_merge_p90_ms, DASHBOARD_OBSERVABILITY_MAX_DURATION_MS);
    const latencyPairValid =
      (latencyP50 === null) === (latencyP90 === null) &&
      (latencyP50 === null || latencyP50 <= latencyP90) &&
      (mergedCount === 0 ? latencyP50 === null : true);
    if (
      !start || !end || Date.parse(start) >= Date.parse(end) ||
      (priorEnd !== null && start !== priorEnd) || terminalCount === null ||
      mergedCount === null || mergedCount > terminalCount || successRate === undefined ||
      latencyP50 === undefined || latencyP90 === undefined || !latencyPairValid ||
      typeof source.low_sample !== "boolean" ||
      successRate !== (terminalCount ? Math.round((mergedCount / terminalCount) * 1000) / 10 : null) ||
      source.low_sample !== (terminalCount > 0 && terminalCount < 5)
    ) return null;
    result.push({
      start,
      end,
      terminal_count: terminalCount,
      merged_count: mergedCount,
      success_rate_percent: successRate,
      command_to_merge_p50_ms: latencyP50,
      command_to_merge_p90_ms: latencyP90,
      low_sample: source.low_sample
    });
    priorEnd = end;
  }
  return result;
}
function dashboardAutomergeOutcomes(value) {
  const source = dashboardObservabilityObject(value);
  if (!source || Object.keys(source).length > 32) return null;
  const result = Object.fromEntries(DASHBOARD_AUTOMERGE_OUTCOMES.map(outcome => [outcome, 0]));
  let unknown = 0;
  for (const [outcome, value] of Object.entries(source)) {
    const parsed = dashboardObservabilityCount(value);
    if (parsed === null) return null;
    if (dashboardObservabilityMember(DASHBOARD_AUTOMERGE_OUTCOMES, outcome)) result[outcome] = parsed;
    else unknown += parsed;
    if (unknown > DASHBOARD_OBSERVABILITY_MAX_COUNT) return null;
  }
  return { ...result, unknown };
}
function dashboardAutomergeMetricsSnapshot(value) {
  const source = dashboardObservabilityObject(value);
  if (!source || !dashboardObservabilityMember(DASHBOARD_OBSERVABILITY_RANGES, source.range)) return null;
  const filters = dashboardObservabilityObject(source.filters);
  if (
    (source.filters !== undefined && !filters) ||
    (filters && (filters.repo !== null || filters.policy_version !== null))
  ) return null;
  const generatedAt = dashboardObservabilityTimestamp(source.generated_at);
  const rangeStart = dashboardObservabilityTimestamp(source.range_start);
  const telemetrySince = dashboardObservabilityNullableTimestamp(source.telemetry_since);
  const coveragePercent = dashboardObservabilityNullableNumber(source.coverage_percent, 0, 100);
  const summary = dashboardAutomergeSummary(source.summary);
  const buckets = dashboardAutomergeBuckets(source.buckets, source.range);
  const outcomes = dashboardAutomergeOutcomes(source.terminal_outcomes);
  const efficiency = dashboardObservabilityCountObject(source.repair_efficiency, [
    "zero_base_sync", "one_base_sync", "multiple_base_sync"
  ]);
  const generatedAtMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  const rangeStartMs = rangeStart ? Date.parse(rangeStart) : Number.NaN;
  const expectedCoveragePercent = telemetrySince === null
    ? 0
    : Math.max(0, Math.min(100, Math.round(
      ((generatedAtMs - Math.max(rangeStartMs, Date.parse(String(telemetrySince)))) /
        DASHBOARD_AUTOMERGE_RANGE_MS[source.range]) * 100
    )));
  if (
    !generatedAt || !rangeStart || telemetrySince === undefined || coveragePercent === undefined ||
    !summary || !buckets || !outcomes || !efficiency ||
    generatedAtMs - rangeStartMs !== DASHBOARD_AUTOMERGE_RANGE_MS[source.range] ||
    coveragePercent !== expectedCoveragePercent || buckets[0]?.start !== rangeStart ||
    buckets.at(-1)?.end !== generatedAt
  ) return null;
  const outcomeTotal = Object.values(outcomes).reduce((total, item) => total + item, 0);
  const bucketTerminalTotal = buckets.reduce((total, bucket) => total + bucket.terminal_count, 0);
  const bucketMergedTotal = buckets.reduce((total, bucket) => total + bucket.merged_count, 0);
  const efficiencyTotal = Object.values(efficiency).reduce((total, item) => total + item, 0);
  const expectedMultiRebaseRate = summary.terminal_sessions
    ? Math.round((efficiency.multiple_base_sync / summary.terminal_sessions) * 1000) / 10
    : null;
  if (
    outcomeTotal !== summary.terminal_sessions || outcomes.merged !== summary.merged_sessions ||
    bucketTerminalTotal !== summary.terminal_sessions || bucketMergedTotal !== summary.merged_sessions ||
    efficiencyTotal !== summary.terminal_sessions ||
    summary.multi_rebase_rate_percent !== expectedMultiRebaseRate
  ) return null;
  return {
    generated_at: generatedAt,
    range: source.range,
    range_start: rangeStart,
    telemetry_since: telemetrySince,
    coverage_percent: expectedCoveragePercent,
    summary: { ...summary, multi_rebase_rate_percent: expectedMultiRebaseRate },
    buckets,
    terminal_outcomes: outcomes,
    repair_efficiency: efficiency
  };
}
function applyValue(value) {
  if (value == null) return "unknown";
  return Number.isFinite(Number(value)) ? fmt.format(Number(value)) : "unknown";
}
function renderApplyObservability(payload) {
  const summary = document.getElementById("apply-observability-summary");
  const target = document.getElementById("apply-observability-body");
  if (!summary || !target) return;
  payload = dashboardApplyObservabilitySnapshot(payload);
  if (!payload) {
    summary.innerHTML = '<span class="review-status degraded">Telemetry unavailable</span>';
    target.innerHTML = '<div class="empty">Durable apply telemetry could not be loaded.</div>';
    return;
  }
  const queue = payload.queue || {};
  const fifteen = payload.last_15_minutes || {};
  const sixty = payload.last_60_minutes || {};
  const failures = payload.failures || {};
  const known = payload.telemetry_complete === true;
  summary.innerHTML = '<span class="review-status ' + (known ? "healthy" : "degraded") + '">' + (known ? "Observed" : "Awaiting producer") + '</span> · ' + esc(payload.range || activeApplyRange) + ' window';
  const queueRows = [
    ["Active / capacity", applyValue(queue.active) + " / " + applyValue(queue.capacity), "durable run observation"],
    ["Ready / backoff", applyValue(queue.ready) + " / " + applyValue(queue.backoff), "oldest ready " + (queue.oldest_ready_age_seconds == null ? "unknown" : elapsed(queue.oldest_ready_age_seconds * 1000))],
    ["Dispatching / leased", applyValue(queue.dispatching) + " / " + applyValue(queue.leased), "oldest lease " + (queue.oldest_lease_age_seconds == null ? "unknown" : elapsed(queue.oldest_lease_age_seconds * 1000))],
    ["Lease wait / hold", payload.lease?.wait_ms == null ? "unknown" : elapsed(payload.lease.wait_ms), payload.lease?.hold_ms == null ? "hold unknown" : "hold " + elapsed(payload.lease.hold_ms)]
  ];
  const resultRows = [
    ["15m arrivals / applied / closed", applyValue(fifteen.arrivals) + " / " + applyValue(fifteen.applied) + " / " + applyValue(fifteen.closed)],
    ["60m arrivals / applied / closed", applyValue(sixty.arrivals) + " / " + applyValue(sixty.applied) + " / " + applyValue(sixty.closed)],
    ["60m net drain / retries", applyValue(sixty.net_drain) + " / " + applyValue(sixty.retried)],
    ["Range superseded / dead-lettered", applyValue(payload.totals?.superseded) + " / " + applyValue(payload.totals?.dead_lettered)],
    ["Retry amplification", payload.retry_amplification == null ? "unknown" : Number(payload.retry_amplification).toFixed(2)]
  ];
  const failureText = failures.last_failure_kind ? failures.last_failure_kind + " · " + since(failures.last_failure_at) : "No observed failure";
  const failureRows = [
    ["Lease timeout / contention", applyValue(failures.state_lease_timeout) + " / " + applyValue(failures.state_lease_contention)],
    ["Ledger / state publication", applyValue(failures.action_ledger) + " / " + applyValue(failures.state_publication)],
    ["Safe-close blocked / failure", applyValue(failures.safe_close_blocked) + " / " + applyValue(failures.safe_close_failure)]
  ];
  const blocks = (rows) => '<div class="apply-observability-kpis">' + rows.map(row => applyMetric(row[0], row[1], row[2] || "")).join("") + '</div>';
  target.innerHTML = blocks(queueRows) + blocks(resultRows) + '<div class="review-anomalies"><div class="review-anomaly"><span><strong>Last failure category</strong> ' + esc(failureText) + '</span></div></div>' + blocks(failureRows);
}
async function loadApplyObservability() {
  const generation = ++applyObservabilityRequestGeneration;
  try {
    const response = await fetch("/api/apply-observability?range=" + encodeURIComponent(activeApplyRange), { cache: "no-store" });
    if (!response.ok) throw new Error("apply observability returned " + response.status);
    const payload = dashboardApplyObservabilitySnapshot(await response.json());
    if (generation !== applyObservabilityRequestGeneration) return;
    if (!payload || payload.range !== activeApplyRange) throw new Error("invalid apply observability");
    lastApplyObservability = payload;
    renderApplyObservability(payload);
  } catch {
    if (generation !== applyObservabilityRequestGeneration) return;
    lastApplyObservability = null;
    renderApplyObservability(null);
  }
  renderHealthStrip();
}

async function loadReviewCoverage() {
  const generation = ++reviewCoverageRequestGeneration;
  try {
    const response = await fetch("/api/review-coverage", { cache: "no-store" });
    if (!response.ok) throw new Error("review coverage returned " + response.status);
    const payload = dashboardReviewCoverageSnapshot(await response.json());
    if (generation !== reviewCoverageRequestGeneration) return;
    if (!payload) throw new Error("invalid review coverage");
    lastReviewCoverage = payload;
  } catch {
    if (generation !== reviewCoverageRequestGeneration) return;
    lastReviewCoverage = null;
  }
  renderReviewCoverage();
  renderHealthStrip();
}

function coverageBand(percent) {
  if (percent == null) return "";
  return percent >= 90 ? "ok" : percent >= 60 ? "amber" : "red";
}

function renderReviewCoverage() {
  const note = document.getElementById("review-coverage-note");
  const target = document.getElementById("review-coverage-body");
  if (!note || !target) return;
  const payload = dashboardReviewCoverageSnapshot(lastReviewCoverage);
  if (!payload) {
    note.textContent = "Open items reviewed in the trailing 7 days";
    target.innerHTML = '<div class="empty">Review coverage is unavailable. The canonical record store could not be reached.</div>';
    return;
  }
  const totals = payload.totals || {};
  const windowDays = Number(payload.window_days) || 7;
  const inventorySuffix = payload.inventory_status === "stale"
    ? " · live inventory stale"
    : payload.inventory_status === "missing" ? " · awaiting live inventory" : "";
  note.textContent = totals.open_records
    ? fmt.format(totals.reviewed_recent || 0) + " of " + fmt.format(totals.reviewable_records || totals.open_records) + " reviewable open items reviewed in the trailing " + windowDays + " days" +
      (totals.coverage_percent == null ? "" : " · " + totals.coverage_percent + "%") +
      inventorySuffix +
      " · updated " + since(payload.generated_at)
    : "Open items reviewed in the trailing " + windowDays + " days";
  const percent = totals.coverage_percent;
  const flags =
    (totals.stale ? '<span class="coverage-flag stale">' + fmt.format(totals.stale) + ' stale</span>' : '') +
    (totals.failed ? '<span class="coverage-flag failed">' + fmt.format(totals.failed) + ' failed</span>' : '') +
    (totals.expired ? '<span class="coverage-flag stale">' + fmt.format(totals.expired) + ' expired</span>' : '') +
    (totals.untracked_open ? '<span class="coverage-flag">' + fmt.format(totals.untracked_open) + ' never reviewed</span>' : '') +
    (totals.excluded ? '<span class="coverage-flag">' + fmt.format(totals.excluded) + ' protected</span>' : '') +
    (totals.unschedulable_records ? '<span class="coverage-flag">' + fmt.format(totals.unschedulable_records) + ' unmanaged records</span>' : '') +
    (totals.pending ? '<span class="coverage-flag">' + fmt.format(totals.pending) + ' pending</span>' : '');
  target.innerHTML = '<div class="coverage-fleets"><div class="coverage-fleet">' +
    '<div class="coverage-fleet-name"><strong>Fleet aggregate</strong><span>' +
      fmt.format(totals.reviewed_recent || 0) + ' of ' + fmt.format(totals.reviewable_records || 0) + ' reviewable open items reviewed</span></div>' +
    '<div><div class="coverage-bar ' + coverageBand(percent) + '"><i style="width:' + Math.max(0, Math.min(100, percent ?? 0)) + '%"></i></div></div>' +
    '<div class="coverage-value"><strong>' + (percent == null ? "n/a" : percent + "%") + '</strong>' +
      (flags ? '<span class="coverage-flags">' + flags + '</span>' : '<span>fully current</span>') +
    '</div></div></div>';
}

function healthChip(label, value, band, title) {
  return '<span class="health-chip ' + band + '" title="' + esc(title || "") + '">' + esc(label) + ' <strong>' + esc(value) + '</strong></span>';
}

function statusBand(status, amberStates, redStates) {
  const value = String(status || "").toLowerCase();
  if (redStates.includes(value)) return "red";
  if (amberStates.includes(value)) return "amber";
  return value ? "ok" : "";
}

function renderHealthStrip() {
  const target = document.getElementById("health-strip");
  if (!target) return;
  const data = lastData;
  if (!data) {
    target.innerHTML = "";
    return;
  }
  const chips = [];
  const handoff = data.exact_review_queue?.handoff_health;
  if (handoff?.status) {
    chips.push(healthChip("Review handoff", handoff.status, statusBand(handoff.status, ["degraded", "congested"], ["stalled"]), "Exact-review queue to workflow handoff health."));
  }
  const operational = data.operational_health;
  if (operational?.status) {
    chips.push(healthChip("Work execution", operational.status, statusBand(operational.status, ["degraded", "unknown"], ["stalled"]), "GitHub workflow execution health."));
  }
  const failures = Number(data.health?.unresolved_failures || 0);
  chips.push(healthChip("Incidents", failures ? fmt.format(failures) + " unresolved" : "none", failures ? "amber" : "ok", "Unresolved worker failures in the recent sample."));
  if (lastApplyObservability) {
    const sixty = lastApplyObservability.last_60_minutes || {};
    const applyKnown = lastApplyObservability.telemetry_complete === true;
    chips.push(healthChip("Apply lane", applyKnown ? fmt.format(Number(sixty.applied) || 0) + " applied · " + fmt.format(Number(sixty.closed) || 0) + " closed / 60m" : "awaiting telemetry", applyKnown ? "ok" : "amber", "Durable apply and close lane activity in the last hour."));
  }
  const reviewCoverage = dashboardReviewCoverageSnapshot(lastReviewCoverage);
  if (reviewCoverage) {
    const coverage = reviewCoverage.totals.coverage_percent;
    const stale = reviewCoverage.totals.stale;
    chips.push(healthChip("7d coverage", (coverage == null ? "n/a" : coverage + "%") + (stale ? " · " + fmt.format(stale) + " stale" : ""), coverage == null ? "" : coverageBand(coverage), "Share of reviewable live open items with a completed review in the trailing 7 days."));
  }
  target.innerHTML = chips.join("");
}

function formatAgeMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 90) return fmt.format(Math.round(minutes)) + "m";
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  return fmt.format(hours) + "h" + (remainder ? " " + fmt.format(remainder) + "m" : "");
}

async function loadHealthHistory(range, force) {
  if (!force && range === activeHealthRange && Date.now() - healthHistoryLoadedAt < 60000) {
    renderExactReviewLanes(lastData?.exact_review_queue);
    renderStateWriter(lastData?.exact_review_queue);
    return;
  }
  activeHealthRange = range;
  const requestedRange = range;
  try {
    const response = await fetch("/api/health-history?range=" + encodeURIComponent(range), { cache: "no-store" });
    if (!response.ok) throw new Error("history returned " + response.status);
    const payload = dashboardHealthHistorySnapshot(await response.json(), requestedRange);
    if (requestedRange !== activeHealthRange) return;
    if (!payload) throw new Error("invalid health history");
    healthHistorySamples = payload.samples;
    healthHistoryContract = { coverage: payload.coverage, freshness: payload.freshness };
    healthHistoryLoadedAt = Date.now();
  } catch {
    if (requestedRange !== activeHealthRange) return;
    healthHistorySamples = [];
    healthHistoryContract = unavailableDashboardHealthHistoryContract();
  }
  const contractNode = document.getElementById("exact-review-history-contract");
  const coverage = healthHistoryContract.coverage || {};
  const freshness = healthHistoryContract.freshness || {};
  if (contractNode) contractNode.textContent = coverage.state === "unavailable"
    ? "History coverage unavailable."
    : "History " + coverage.usable_slots + " / " + coverage.expected_slots + " usable slots · " + coverage.state + " · " + freshness.state + (coverage.failed_slots ? " · " + coverage.failed_slots + " failed polls" : "") + (coverage.largest_gap_slots ? " · largest gap " + coverage.largest_gap_slots + " slots" : "");
  renderExactReviewLanes(lastData?.exact_review_queue);
  renderStateWriter(lastData?.exact_review_queue);
}

function workerGroup(worker) {
  const text = (worker.mode + " " + worker.name + " " + worker.workflow_title).toLowerCase();
  if (worker.work_kind === "issue_to_pr") return "issue-to-pr";
  if (worker.work_kind === "pr_repair") return "pr-repair";
  if (text.includes("assist")) return "assist";
  if (text.includes("repair") || text.includes("automerge")) return "repair";
  if (text.includes("commit")) return "commit";
  if (text.includes("review")) return "review";
  return "other";
}
function workerKindLabel(kind) {
  if (kind === "issue_to_pr") return "Issue to PR";
  if (kind === "pr_repair") return "PR repair";
  if (kind === "repair_cluster") return "Repair cluster";
  return "";
}
function workerStatusClass(status) {
  if (["in_progress", "running"].includes(status)) return "active";
  if (["queued", "waiting", "requested", "pending"].includes(status)) return "waiting";
  if (["completed", "success"].includes(status)) return "done";
  if (["blocked", "failed", "failure", "cancelled"].includes(status)) return "failed";
  return "";
}
function workerTarget(worker) {
  if (worker.repository && worker.item_numbers?.length) {
    return worker.repository + "#" + worker.item_numbers.join(", #");
  }
  if (worker.repository && worker.item_number) return worker.repository + "#" + worker.item_number;
  if (worker.repository) return worker.repository;
  return worker.mode ? modeLabel(worker.mode) + " activity" : "Worker activity";
}
function workerTargetTitle(worker) {
  const targets = (worker.target_items || []).filter(target => compactText(target.title));
  if (!targets.length) return "";
  const title = compactText(targets[0].title);
  return targets.length > 1 ? title + " +" + (targets.length - 1) + " more" : title;
}
function laneFlowDetails(laneKey, flow) {
  if (!flow) return "";
  const rate = value => Number.isFinite(Number(value)) ? fmt.format(Number(value)) + "/h" : "n/a";
  const amplification = flow.retry_amplification == null
    ? "n/a"
    : Number(flow.retry_amplification).toFixed(2);
  const config = laneKey === "review"
    ? {
        title: "Review throughput",
        rows: [
          ["Arrival", flow.arrival_rate_per_hour],
          ["Successful", flow.successful_rate_per_hour],
          ["Retried", flow.retried_rate_per_hour],
          ["Shed", flow.shed_rate_per_hour]
        ]
      }
    : {
        title: "Publication throughput",
        rows: [
          ["Arrival", flow.arrival_rate_per_hour],
          ["Published", flow.published_rate_per_hour],
          ["Superseded", flow.superseded_rate_per_hour],
          ["Retried", flow.retried_rate_per_hour]
        ]
      };
  return '<details class="lane-flow"><summary><span class="lane-flow-title">' + esc(config.title) + ' · last 15 minutes<small>15m hourly-equivalent rates respond faster to recent changes but are more burst-sensitive than the up-to-60m net rate above.</small></span></summary><div class="lane-counts">' +
    config.rows.map(([label, value]) => '<div class="lane-count"><span>' + esc(label) + '</span><strong>' + rate(value) + '</strong></div>').join("") +
    '</div><div class="lane-flow-foot"><span>Retry amplification</span><strong>' + esc(amplification) + '</strong></div></details>';
}
function renderSystemMap(data) {
  const workers = data.workers || [];
  const codexWorkers = workers.filter(worker => worker.is_codex_worker !== false);
  const pipeline = data.pipeline || [];
  const fleet = data.fleet || {};
  const workerRunIds = new Set(workers.map(worker => String(worker.run_id)));
  const planning = pipeline.filter(row => !workerRunIds.has(String(row.id))).length;
  const applying = pipeline.filter(row => row.mode === "apply" || row.mode === "automerge").length;
  const closed = data.recent?.closed_stats?.total || 0;
  const nodes = [
    ["01 · Intake", fleet.queued_workflow_runs || 0, "Events and scheduled sweeps waiting to start"],
    ["02 · Plan", planning, "Runs selecting work or expanding a matrix"],
    ["03 · Workers", codexWorkers.length, "Codex jobs reviewing, repairing, or assisting"],
    ["04 · Apply", applying, "Deterministic comment, close, merge, and publish lanes"],
    ["05 · Results", closed, (data.recent?.closed_stats?.window_hours || 24) + "h ClawSweeper closes"]
  ];
  document.getElementById("flow-map").innerHTML = nodes.map(node =>
    '<div class="flow-node"><span>' + esc(node[0]) + '</span><strong>' + fmt.format(node[1]) + '</strong><p>' + esc(node[2]) + '</p></div>'
  ).join("");
  const budget = Math.max(0, fleet.worker_budget || 0);
  const running = codexWorkers.filter(worker => worker.status === "in_progress").length;
  const waiting = codexWorkers.length - running;
  const free = Math.max(0, budget - running - waiting);
  const overflow = Math.max(0, running + waiting - budget);
  const share = value => budget ? Math.min(100, (value / budget) * 100) : 0;
  document.getElementById("capacity-rail").innerHTML =
    '<div class="capacity-bar"><i class="active" style="width:' + share(running) + '%"></i><i class="waiting" style="width:' + share(waiting) + '%"></i></div>' +
    '<div class="capacity-meta">' + fmt.format(running) + ' running · ' + fmt.format(waiting) + ' waiting · ' + fmt.format(free) + ' of ' + fmt.format(budget) + ' Codex slots free' + (overflow ? ' · ' + fmt.format(overflow) + ' over budget' : '') + '</div>' +
    '<div class="capacity-note">Only jobs that execute Codex count against this budget.</div>';
  const fallbacks = fleet.worker_detail_fallbacks || 0;
  document.getElementById("overview-note").textContent = fallbacks
    ? "Live jobs with " + fallbacks + " workflow fallback" + (fallbacks === 1 ? "" : "s")
    : "Live GitHub job and step telemetry";
}
function stateWriterHistorySamples() {
  return healthHistorySamples.flatMap((sample) => {
    const writer = sample?.state_writer;
    // Legacy samples predate the split and used collection_ok exclusively for
    // terminal telemetry. New coordinator-only samples stay useful for queue
    // history but must not contribute stale throughput counters.
    if (!writer || writer.collection_ok !== true || writer.terminal_collection_ok === false) return [];
    return [{
      at: sample.at,
      accepted: Number(writer.accepted_operations_total || 0),
      commits: Number(writer.state_commits_total || 0),
      items: Number(writer.materialized_items_total || 0),
      wait: writer.wait_ms,
      hold: writer.hold_ms,
    }];
  });
}

function stateWriterCoordinatorHistorySamples() {
  return healthHistorySamples.flatMap((sample) => {
    const writer = sample?.state_writer;
    const active = writer?.tracked_holding;
    const queued = writer?.tracked_waiting;
    if (
      !writer ||
      writer.collection_ok !== true ||
      typeof active !== "number" ||
      !Number.isInteger(active) ||
      active < 0 ||
      typeof queued !== "number" ||
      !Number.isInteger(queued) ||
      queued < 0
    ) return [];
    return [{ at: sample.at, active, queued }];
  });
}

function stateWriterHistorySegment(samples, field) {
  if (samples.length < 2) return null;
  let startIndex = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index][field] < samples[index - 1][field]) startIndex = index;
  }
  if (samples.length - startIndex < 2) return null;
  return samples.slice(startIndex);
}

function stateWriterRateFromHistory(samples, field) {
  const segment = stateWriterHistorySegment(samples, field);
  if (!segment) return null;
  const start = segment[0];
  const end = segment[segment.length - 1];
  const elapsedHours = (Date.parse(end.at) - Date.parse(start.at)) / 3_600_000;
  if (!(elapsedHours > 0) || end[field] < start[field]) return null;
  return Math.round(((end[field] - start[field]) / elapsedHours) * 10) / 10;
}

function renderStateWriter(queue) {
  const target = document.getElementById("state-writer-health");
  if (!target) return;
  const writer = queue?.state_writer;
  const coordinator = writer?.coordinator || {};
  const batches = queue?.lanes?.publication?.batches || {};
  const coordinatorLive = ["queued", "leased", "admitted", "completed"].every(
    field =>
      coordinator[field] !== null &&
      coordinator[field] !== undefined &&
      Number.isFinite(Number(coordinator[field])) &&
      Number(coordinator[field]) >= 0
  );
  if (!writer || (!writer.collection && !coordinatorLive)) {
    target.innerHTML = '<div class="exact-lane-head"><strong>State writer</strong><span>Unavailable</span></div><p class="state-writer-note">Writer telemetry has not been collected.</p>';
    return;
  }
  const collection = writer.collection || {};
  const live = writer.live || {};
  const hour = writer.last_60_minutes || {};
  const publicationFlow = queue?.lanes?.publication?.flow?.last_15_minutes || {};
  const history = stateWriterHistorySamples();
  const coordinatorHistory = stateWriterCoordinatorHistorySamples();
  const latestCoordinatorHistory = coordinatorHistory.at(-1);
  const latestHistory = history.at(-1);
  const historyFresh = Boolean(
    latestHistory && Date.now() - Date.parse(latestHistory.at) <= 12 * 60 * 1000
  );
  const itemsPerHour = historyFresh ? stateWriterRateFromHistory(history, "items") : null;
  const commitsPerHour = historyFresh ? stateWriterRateFromHistory(history, "commits") : null;
  const commitSegment = historyFresh ? stateWriterHistorySegment(history, "commits") : null;
  const terminalFresh = collection.status === "fresh";
  const recentPublicationCounts = ["resolved", "published", "superseded", "retried", "dead_lettered"]
    .map(field => Number(publicationFlow[field]));
  const recentPublicationNeedsTelemetry =
    recentPublicationCounts.some(count => !Number.isInteger(count) || count < 0) ||
    Number(publicationFlow.published) > 0 ||
    Number(publicationFlow.retried) > 0 ||
    Number(publicationFlow.dead_lettered) > 0 ||
    Number(publicationFlow.superseded) !== Number(publicationFlow.resolved);
  // The coordinator also serializes unrelated state writers. Exact publication
  // ownership is the signal that this panel still expects a terminal sample.
  const exactPublicationActive =
    [batches.leased, queue?.lanes?.publication?.active, queue?.lanes?.publication?.leased, queue?.lanes?.publication?.dispatching]
      .some(count => Number.isInteger(Number(count)) && Number(count) > 0);
  const terminalPending =
    !terminalFresh &&
    coordinatorLive &&
    !recentPublicationNeedsTelemetry &&
    exactPublicationActive;
  const terminalIdle =
    !terminalFresh &&
    coordinatorLive &&
    !recentPublicationNeedsTelemetry &&
    !exactPublicationActive;
  const itemsPerCommit =
    commitSegment &&
    commitSegment.length >= 2 &&
    commitSegment[commitSegment.length - 1].commits > commitSegment[0].commits
      ? Math.round(
          ((commitSegment[commitSegment.length - 1].items - commitSegment[0].items) /
            (commitSegment[commitSegment.length - 1].commits - commitSegment[0].commits)) *
            100,
        ) / 100
      : terminalFresh
        ? hour.items_per_commit
        : null;
  const wait = historyFresh ? latestHistory?.wait : terminalFresh ? hour.wait_ms : null;
  const hold = historyFresh ? latestHistory?.hold : terminalFresh ? hour.hold_ms : null;
  const rangeLabel = activeHealthRange === "7d" ? "7d" : activeHealthRange;
  const liveFresh =
    collection.status === "fresh" &&
    (live.freshness_seconds == null || Number(live.freshness_seconds) <= 90);
  const configuredBatchSize = Number.isInteger(Number(batches.max_items)) && Number(batches.max_items) > 0
    ? Number(batches.max_items)
    : null;
  const batchingConfigured = batches.enabled === true;
  const mode =
    writer.mode === "mixed"
      ? "Mixed · legacy draining + batch active"
      : batchingConfigured || writer.mode === "batch"
        ? "Batch" + (configuredBatchSize ? " · configured " + configuredBatchSize : "")
        : writer.mode === "single_item"
          ? "Single-item"
          : "Unknown";
  const metric = (value, fallback = "unknown") => value === null || value === undefined ? fallback : value;
  const percentile = (value) =>
    value?.samples ? "p50 " + metric(value.p50) + "ms · p95 " + metric(value.p95) + "ms · n=" + value.samples : "unknown";
  const queueTrend = coordinatorHistory.map((sample) => ({ at: sample.at, pending: sample.queued }));
  const queuedHistory = coordinatorHistory.map((sample) => sample.queued);
  const coordinatorHistorySummary = coordinatorHistory.length
    ? metric(coordinatorHistory.length) + " samples · " + metric(Math.min(...queuedHistory)) + "–" + metric(Math.max(...queuedHistory)) + " queued"
    : "collecting samples";
  const latestCoordinatorSummary = latestCoordinatorHistory
    ? metric(latestCoordinatorHistory.active) + " active · " + metric(latestCoordinatorHistory.queued) + " queued · " + since(latestCoordinatorHistory.at)
    : "collecting samples";
  const coordinatorTurns = coordinatorLive
    ? metric(coordinator.completed) + " completed · " + metric(coordinator.admitted) + " admitted" +
      (Number(coordinator.recovered) || Number(coordinator.expired)
        ? " · " + metric(coordinator.recovered, 0) + " recovered · " + metric(coordinator.expired, 0) + " expired"
        : "")
    : "unknown";
  const coordinatorWait = coordinatorLive
    ? "last " + elapsed(Number(coordinator.last_wait_ms)) + " · max " + elapsed(Number(coordinator.max_wait_ms))
    : "unknown";
  const terminalStatus = terminalFresh
    ? "terminal telemetry fresh"
    : terminalPending
      ? "awaiting exact-review writer result"
    : terminalIdle
      ? "idle · no exact-review materialization required in the last 15m"
    : collection.last_observed_at
      ? "terminal telemetry stale · last observed " + since(collection.last_observed_at)
      : "terminal telemetry unavailable";
  const terminalMetrics = terminalFresh
    ? "<div><dt>Exact-review materialized</dt><dd>" + esc(metric(itemsPerHour ?? hour.materialized_items)) + " items/hour</dd></div>" +
      "<div><dt>Exact-review commits</dt><dd>" + esc(metric(commitsPerHour ?? hour.state_commits)) + "/hour</dd></div>" +
      "<div><dt>Items / commit</dt><dd>" + esc(metric(itemsPerCommit)) + "</dd></div>" +
      "<div><dt>Git fence wait</dt><dd>" + esc(percentile(wait)) + "</dd></div>" +
      "<div><dt>Git fence hold</dt><dd>" + esc(percentile(hold)) + "</dd></div>"
    : "<div><dt>Last exact-review materialization</dt><dd>" + esc(writer.last_successful_materialization_at ? since(writer.last_successful_materialization_at) : "not observed") + "</dd></div>" +
      "<div><dt>Terminal telemetry</dt><dd>" + esc(terminalStatus) + "</dd></div>";
  target.innerHTML =
    '<div class="exact-lane-head"><strong>State writer</strong><span>' + esc(mode) + " · " + esc(coordinatorLive ? "coordinator live" : metric(collection.status)) + " · " + esc(rangeLabel) + "</span></div>" +
    '<div class="lane-counts">' +
    '<div class="lane-count"><span>Serialization queue</span><strong>' +
    (coordinatorLive
      ? metric(coordinator.leased) + " active · " + metric(coordinator.queued) + " queued · 1 writer max"
      : liveFresh
        ? metric(live.tracked_holding, "unknown") + " active · " + metric(live.tracked_waiting, "unknown") + " queued · 1 writer max"
        : "unknown active · unknown queued · 1 writer max") +
    '</strong></div></div>' +
    exactReviewTrend(queueTrend, "Serialized writer queue", "depth") +
    '<dl class="lane-metrics">' +
    "<div><dt>Coordinator turns</dt><dd>" + esc(coordinatorTurns) + "</dd></div>" +
    "<div><dt>Coordinator wait</dt><dd>" + esc(coordinatorWait) + "</dd></div>" +
    "<div><dt>Queue history</dt><dd>" + esc(coordinatorHistorySummary) + "</dd></div>" +
    "<div><dt>Latest queue sample</dt><dd>" + esc(latestCoordinatorSummary) + "</dd></div>" +
    terminalMetrics +
    "</dl>" +
    '<p class="state-writer-note">The chart uses five-minute coordinator queue samples from the selected ' + esc(rangeLabel) + " range. Exact-review throughput appears only while its separate terminal telemetry is fresh; all-superseded and no-work windows are idle.</p>" +
    '<p class="state-writer-note">The durable coordinator is authoritative for the remaining operational Git writers.</p>';
}

function renderExactReviewLanes(queue) {
  const target = document.getElementById("exact-review-lanes");
  if (!target) return;
  const lanes = queue?.lanes;
  const rateHelp = {
    review: "Successful completions minus incoming review demand per hour. Incoming includes newly queued work and shed demand. Positive means catching up; negative means falling behind.",
    publication: "Successful completions minus newly queued publication work per hour. Positive means catching up; negative means falling behind."
  };
  target.innerHTML = [["Review admission", "Net review rate", "review", lanes?.review], ["Result publication", "Net publication rate", "publication", lanes?.publication]].map(([label, speedLabel, laneKey, lane]) => {
    const samples = exactReviewHistory(laneKey);
    if (!lane) {
      const sampledAt = samples.at(-1)?.at;
      return '<div class="exact-lane"><div class="exact-lane-head"><strong>' + esc(label) + '</strong><span>Live snapshot unavailable</span></div>' +
        exactReviewTrend(samples, label) +
        laneSpeedTrend(samples, speedLabel, rateHelp[laneKey]) +
        '<div class="lane-foot">' + (sampledAt ? "Last sampled " + esc(since(sampledAt)) : "History starts with the next five-minute sample") + '</div></div>';
    }
    const capacity = Math.max(0, lane.capacity || 0);
    const active = Math.max(0, lane.active || 0);
    const used = capacity ? Math.min(100, (active / capacity) * 100) : 0;
    const oldest = Number.isFinite(lane.oldest_pending_age_seconds)
      ? " · oldest " + elapsed(lane.oldest_pending_age_seconds * 1000)
      : "";
    const oldestReady = Number.isFinite(lane.oldest_ready_age_seconds)
      ? " · oldest ready " + elapsed(lane.oldest_ready_age_seconds * 1000)
      : "";
    const oldestBackoff = Number.isFinite(lane.oldest_backoff_age_seconds)
      ? " · oldest backoff " + elapsed(lane.oldest_backoff_age_seconds * 1000)
      : "";
    const publicationControl = laneKey === "publication" ? lane.capacity_control : null;
    const cooldown = publicationControl?.cooldown_until
      ? " · cooldown until " + new Date(publicationControl.cooldown_until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    const capacityNote = publicationControl?.mode === "throttled"
      ? " · target " + fmt.format(publicationControl.demand_capacity || capacity) + " · pressure ceiling " + fmt.format(publicationControl.ceiling || capacity) + " after " +
        (publicationControl.last_failure_kind === "github_rate_limit" ? "GitHub rate limit" : "GitHub 5xx")
      : laneKey === "publication"
        ? " · target " + fmt.format(publicationControl?.demand_capacity || capacity) + " · adaptive " + fmt.format(publicationControl?.base || 24) + "–" + fmt.format(publicationControl?.maximum || capacity)
        : "";
    const flow = lane.flow?.last_15_minutes;
    const flowSummary = laneFlowDetails(laneKey, flow);
    const deadLetters = laneKey === "publication" ? lane.dead_letters : null;
    const deadLetterNote = deadLetters
      ? " · DLQ " + fmt.format(deadLetters.open || 0) +
        (deadLetters.oldest_failed_at ? " · oldest DLQ " + since(deadLetters.oldest_failed_at) : "")
      : "";
    const reasonSummary = (label, reasons) => {
      const values = Object.entries(reasons || {})
        .filter(([, count]) => Number(count) > 0)
        .sort((left, right) => Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0]))
        .map(([reason, count]) => reason.replaceAll("_", " ") + " " + fmt.format(Number(count)));
      return values.length ? " · " + label + ": " + values.join(", ") : "";
    };
    const queueReasonNote = reasonSummary("backoff", lane.backoff_reasons) +
      reasonSummary("parked", lane.parked_reasons);
    return '<div class="exact-lane"><div class="exact-lane-head"><strong>' + esc(label) + '</strong><span>' + fmt.format(active) + ' of ' + fmt.format(capacity) + ' active</span></div>' +
      '<div class="lane-count"><span>Pending</span><strong>' + fmt.format(lane.pending || 0) + '</strong></div>' +
      exactReviewTrend(samples, label) +
      laneSpeedTrend(samples, speedLabel, rateHelp[laneKey]) +
      flowSummary +
      '<div class="lane-counts">' +
      '<div class="lane-count"><span>Ready</span><strong>' + fmt.format(lane.ready || 0) + '</strong></div>' +
      '<div class="lane-count"><span>Backoff</span><strong>' + fmt.format(lane.backoff || 0) + '</strong></div>' +
      '<div class="lane-count"><span>Dispatching</span><strong>' + fmt.format(lane.dispatching || 0) + '</strong></div>' +
      '<div class="lane-count"><span>Leased</span><strong>' + fmt.format(lane.leased || 0) + '</strong></div>' +
      '<div class="lane-count"><span>Parked</span><strong>' + fmt.format(lane.parked || 0) + '</strong></div></div>' +
      '<div class="lane-bar"><i style="width:' + used + '%"></i></div>' +
      '<div class="lane-foot">' + fmt.format(lane.available_slots || 0) + ' ' + esc(label.toLowerCase()) + ' slots open' + esc(oldest + oldestReady + oldestBackoff + capacityNote + cooldown + deadLetterNote + queueReasonNote) + '</div></div>';
  }).join("");
}
function renderExactReviewHandoff(queue) {
  const target = document.getElementById("exact-review-handoff");
  if (!target) return;
  const health = queue?.handoff_health;
  if (!health?.phases) {
    target.innerHTML = '<div class="exact-handoff"><div class="exact-handoff-head"><div class="exact-handoff-title"><strong>Queue handoff health</strong><span>Queue telemetry unavailable in this snapshot.</span></div><span class="health-badge">unknown</span></div></div>';
    return;
  }
  const status = ["idle", "healthy", "degraded", "stalled"].includes(health.status) ? health.status : "unknown";
  const pressure = queue?.pressure;
  const pressureStatus = ["idle", "congested", "saturated", "unknown"].includes(pressure?.status)
    ? pressure.status
    : "unknown";
  const pressureLabel = "pressure " + pressureStatus;
  const labels = {
    pending: ["Pending", "waiting for admission"],
    dispatching: ["Dispatching", "waiting for run claim"],
    leased: ["Leased", "run owns the review"]
  };
  const phases = ["pending", "dispatching", "leased"].map(phase => {
    const summary = health.phases[phase] || {};
    const age = Number.isFinite(summary.oldest_age_seconds)
      ? "oldest " + elapsed(summary.oldest_age_seconds * 1000)
      : "none waiting";
    return '<div class="handoff-phase"><span>' + esc(labels[phase][0]) + '</span><strong>' + fmt.format(summary.count || 0) + '</strong><small>' + esc(labels[phase][1] + " · " + age) + '</small></div>';
  }).join("");
  const slots = fmt.format(health.available_slots || 0) + " of " + fmt.format(health.capacity || 0) + " exact-review slots open";
  const backlog = fmt.format(queue?.pending || 0) + " total · " + fmt.format(queue?.ready_pending || 0) + " ready · " + fmt.format(queue?.admissible_pending || 0) + " admissible";
  const threshold = "stalled after " + elapsed((health.stalled_after_seconds || 0) * 1000);
  target.innerHTML = '<div class="exact-handoff"><div class="exact-handoff-head"><div class="exact-handoff-title"><strong>Queue handoff health</strong><span>' + esc(health.message || "Queue phase telemetry") + '</span></div><div class="exact-handoff-badges"><span class="health-badge ' + esc(status) + '">' + esc(status) + '</span><span class="health-badge ' + esc(pressureStatus) + '">' + esc(pressureLabel) + '</span></div></div><div class="handoff-phases">' + phases + '</div><div class="handoff-foot"><span>' + esc(slots) + '</span><span>' + esc(backlog) + '</span><span>' + esc(threshold) + '</span></div></div>';
}
function renderRecentDurablePublicationEvents(events) {
  const target = document.getElementById("recent-durable-publication-events");
  if (!target) return;
  const direct = events?.direct?.counts || {};
  const batch = events?.batch?.counts || {};
  const value = item => item == null ? "unknown" : fmt.format(item);
  const state = events?.collection?.state || "unknown";
  target.innerHTML = '<div class="exact-handoff"><div class="exact-handoff-head"><div class="exact-handoff-title"><strong>Recent durable publication events</strong><span>Trailing ' + esc(events?.window?.id || "unknown") + ' window; publication attempts only.</span></div><span class="health-badge ' + esc(state) + '">' + esc(state) + '</span></div><div class="handoff-phases"><div class="handoff-phase"><span>Direct accepted</span><strong>' + esc(value(direct.accepted)) + '</strong><small>durable event</small></div><div class="handoff-phase"><span>Batch retryable</span><strong>' + esc(value(batch.retryable)) + '</strong><small>durable event</small></div></div><div class="handoff-foot"><span>No events observed is idle, not failure.</span><span>Workflow activity is not lifecycle completion.</span></div></div>';
}
function renderWorkers(rows) {
  workerIndex = new Map(rows.map((worker, index) => [String(index), worker]));
  const groups = ["issue-to-pr", "pr-repair", "review", "repair", "commit", "assist", "other"];
  const counts = Object.fromEntries(groups.map(group => [group, rows.filter(worker => workerGroup(worker) === group).length]));
  const filters = [["all", "All", rows.length], ...groups.filter(group => counts[group]).map(group => [group, group[0].toUpperCase() + group.slice(1), counts[group]])];
  if (!filters.some(filter => filter[0] === activeWorkerFilter)) activeWorkerFilter = "all";
  document.getElementById("worker-filters").innerHTML = filters.map(filter =>
    '<button type="button" class="filter-button' + (filter[0] === activeWorkerFilter ? " active" : "") + '" data-worker-filter="' + esc(filter[0]) + '">' + esc(filter[1]) + " " + fmt.format(filter[2]) + '</button>'
  ).join("");
  const visible = activeWorkerFilter === "all" ? rows : rows.filter(worker => workerGroup(worker) === activeWorkerFilter);
  document.getElementById("worker-summary").textContent = fmt.format(rows.length) + " active · " + fmt.format(rows.filter(worker => worker.status === "in_progress").length) + " running";
  if (!visible.length) {
    document.getElementById("workers").innerHTML = '<div class="empty">No workers match this view.</div>';
    return;
  }
  document.getElementById("workers").innerHTML = '<div class="worker-list">' + visible.map(worker => {
    const viewKey = rows.indexOf(worker);
    const progress = worker.progress?.total ? Math.round((worker.progress.completed / worker.progress.total) * 100) : 0;
    const kind = workerKindLabel(worker.work_kind);
    const targetTitle = workerTargetTitle(worker);
    return '<button type="button" class="worker-row" data-worker-id="' + viewKey + '" aria-label="Open worker details">' +
      '<div class="worker-row-main">' +
      '<i class="status-dot ' + workerStatusClass(worker.status) + '"></i>' +
      '<span class="pill">' + esc(modeLabel(worker.mode)) + (kind ? " · " + esc(kind) : "") + '</span>' +
      '<strong class="worker-name">Active worker</strong>' +
      '<span class="worker-step">' + esc(worker.stage || "Status telemetry") + '</span>' +
      '<span class="worker-time mono">' + elapsed(worker.elapsed_ms) + '</span>' +
      '</div>' +
      '<div class="worker-row-sub">' +
      '<span class="worker-target-ref mono">' + esc(workerTarget(worker)) + '</span>' +
      '<span class="worker-target-title" title="' + esc(targetTitle) + '">' + esc(targetTitle) + '</span>' +
      '<span class="worker-progress"><i style="width:' + progress + '%"></i></span>' +
      '</div>' +
      '</button>';
  }).join("") + '</div>';
}
function publicReferenceSearch(value) {
  const query = String(value || "").trim().toLowerCase();
  if (!query) return null;
  const qualified = query.match(/^([a-z0-9_.-]+\\/[a-z0-9_.-]+)#(\\d+)$/);
  const numberOnly = query.match(/^#?(\\d+)$/);
  const itemNumber = Number(qualified ? qualified[2] : numberOnly?.[1]);
  if (!Number.isSafeInteger(itemNumber) || itemNumber <= 0 || itemNumber > 1000000000) return false;
  return { repository: qualified?.[1] || null, item_number: itemNumber };
}
function renderPublicReferences(data) {
  const target = document.getElementById("public-references");
  const summary = document.getElementById("public-reference-summary");
  const rows = dashboardPublicBayReferences(data?.exact_review_queue?.bay_projection?.activity?.items);
  publicReferenceIndex = new Map(rows.map(row => [row.repository + "#" + row.item_number, row]));
  const search = publicReferenceSearch(publicReferenceQuery);
  const visible = search && search !== false
    ? rows.filter(row => row.item_number === search.item_number && (!search.repository || row.repository === search.repository))
    : search === false ? [] : rows;
  summary.textContent = search === false
    ? "Enter a number or owner/repo#number"
    : publicReferenceQuery
      ? visible.length + " match" + (visible.length === 1 ? "" : "es")
      : rows.length + " verified public reference" + (rows.length === 1 ? "" : "s");
  if (!visible.length) {
    target.innerHTML = '<div class="empty">' + (publicReferenceQuery ? "No matching public reference in this snapshot." : "No verified public references are in the bounded Bay sample.") + '</div>';
    return;
  }
  target.innerHTML = '<div class="work-list">' + visible.map(row => {
    const key = row.repository + "#" + row.item_number;
    const label = esc(key);
    const display = publicReferenceQuery ? "<mark>" + label + "</mark>" : label;
    return '<button type="button" class="work-row public-reference-row" data-public-reference-key="' + esc(key) + '" aria-label="Open public reference details for ' + esc(key) + '"><div class="work-main"><div class="row-top"><span class="pill">' + esc(row.source) + '</span><span class="item-link">' + display + '</span></div><div class="muted work-title">Verified public repository and issue/PR reference only</div></div><div class="work-state"><div class="stage-block"><strong>' + esc(row.stage) + '</strong><span class="muted">Bay stage</span></div></div></button>';
  }).join("") + '</div>';
}
function renderPublicReferenceDialog(row, key) {
  const dialog = document.getElementById("worker-dialog");
  const repositoryUrl = "https://github.com/" + row.repository;
  const itemUrl = repositoryUrl + "/issues/" + row.item_number;
  const source = row.source === "queue" ? "Bounded queue sample" : "Bounded live sample";
  const action = dashboardPublicBayAction(row.action);
  const completedSteps = action ? action.steps.filter(step => step.status === "completed").length : 0;
  const actionRepositoryUrl = action ? "https://github.com/" + action.repository : null;
  const runUrl = action ? actionRepositoryUrl + "/actions/runs/" + action.run_id : null;
  const jobUrl = action?.job_id ? runUrl + "/job/" + action.job_id : null;
  const stepRows = action?.steps.map(step =>
    '<li class="step-row ' + esc(step.status) + '"><i class="step-mark"></i><strong>' + esc(PUBLIC_ACTION_STEP_LABELS[step.kind]) + '</strong><span>' + esc((step.conclusion || step.status).replaceAll("_", " ")) + '</span></li>'
  ).join("") || "";
  document.getElementById("worker-dialog-heading").innerHTML =
    '<div><span class="pill">' + esc(row.source) + '</span> <span class="pill">' + esc(row.stage) + '</span></div>' +
    '<h3 id="worker-dialog-title">' + esc(key) + '</h3>' +
    '<div class="muted">Verified public GitHub issue or pull request</div>';
  document.getElementById("worker-dialog-body").innerHTML =
    '<div class="drawer-grid">' +
      '<div class="drawer-stat"><span>Current stage</span><strong>' + esc(row.stage) + '</strong></div>' +
      '<div class="drawer-stat"><span>Source</span><strong>' + esc(source) + '</strong></div>' +
      '<div class="drawer-stat"><span>Repository</span><strong>' + esc(row.repository) + '</strong></div>' +
      '<div class="drawer-stat"><span>Reference</span><strong>#' + esc(row.item_number) + '</strong></div>' +
      (action ? '<div class="drawer-stat"><span>Action status</span><strong>' + esc(action.status.replaceAll("_", " ")) + '</strong></div>' : '') +
      (action ? '<div class="drawer-stat"><span>Progress</span><strong>' + esc(completedSteps) + ' / ' + esc(action.steps.length) + ' steps</strong></div>' : '') +
    '</div>' +
    '<div class="drawer-links">' +
      linkClass(itemUrl, "Open issue or pull request", "pill run-link") +
      linkClass(repositoryUrl, "Open repository", "pill run-link") +
      linkClass(jobUrl, "Open job", "pill run-link") +
      linkClass(runUrl, "Open workflow run", "pill run-link") +
    '</div>' +
    '<h2>' + (action ? 'Step timeline' : 'Public status') + '</h2>' +
    (stepRows ? '<ol class="step-list">' + stepRows + '</ol>' : '<ol class="step-list"><li class="step-row completed"><i class="step-mark"></i><strong>Reference verified</strong><span>Verified public GitHub coordinates</span></li><li class="step-row in_progress"><i class="step-mark"></i><strong>Current Bay stage</strong><span>' + esc(row.stage) + '</span></li></ol>');
  if (!dialog.open) dialog.showModal();
  history.replaceState(null, "", "#public-reference-" + encodeURIComponent(key));
}
function renderAutomaticWork(rows) {
  automaticIndex = new Map(rows.map((row, index) => [String(index), row]));
  const active = rows.filter(row => row.active || ["queued", "running", "in_progress"].includes(row.status)).length;
  document.getElementById("automatic-summary").textContent =
    fmt.format(rows.length) + " recent · " + fmt.format(active) + " active";
  if (!rows.length) {
    document.getElementById("automatic-work").innerHTML =
      '<div class="empty">No automatic issue builds have started yet.</div>';
    return;
  }
  document.getElementById("automatic-work").innerHTML =
    '<div class="worker-list">' +
    rows.map((row, index) => {
      const phase = compactText(row.phase || row.status || "queued").replaceAll("_", " ");
      return '<button type="button" class="worker-row automatic-row" data-automatic-id="' + index +
        '" aria-label="Open automatic build details">' +
        '<div class="worker-row-main">' +
        '<i class="status-dot ' + workerStatusClass(row.status) + '"></i>' +
        '<span class="pill">' + esc(phase) + '</span>' +
        '<strong class="worker-name">Automatic work</strong>' +
        '<span class="worker-time mono">' + esc(row.updated_at ? since(row.updated_at) : "") + '</span>' +
        '</div>' +
        '<div class="worker-row-sub">' +
        '<span class="worker-target-ref mono">Identity-safe status</span>' +
        '<span class="worker-target-title">' + esc(row.pr_url ? "PR opened" : row.active ? "worker active" : row.status) + '</span>' +
        '</div>' +
        '</button>';
    }).join("") +
    '</div>';
}
function renderWorkerDialog(worker, viewKey) {
  const dialog = document.getElementById("worker-dialog");
  const statusClass = workerStatusClass(worker.status);
  document.getElementById("worker-dialog-heading").innerHTML = '<div><span class="pill"><i class="status-dot ' + statusClass + '"></i>' + esc(worker.status) + '</span> <span class="pill">' + esc(modeLabel(worker.mode)) + '</span></div><h3 id="worker-dialog-title">Active worker</h3><div class="muted">Identity-safe live status</div>';
  const targetItems = new Map((worker.target_items || []).map(target => [Number(target.number), target]));
  const targetUrls = worker.repository
    ? (worker.item_numbers || (worker.item_number ? [worker.item_number] : [])).map(number => ({
        url: targetItems.get(Number(number))?.url || "https://github.com/" + worker.repository + "/" + (worker.work_kind === "pr_repair" ? "pull" : "issues") + "/" + number,
        label: "#" + number + (targetItems.get(Number(number))?.title ? " · " + compactText(targetItems.get(Number(number)).title) : "")
      }))
    : [];
  const stepRows = (worker.steps || []).map(step => '<li class="step-row ' + esc(step.status) + '"><i class="step-mark"></i><strong>Step</strong><span>' + esc(step.conclusion || step.status) + '</span></li>').join("");
  document.getElementById("worker-dialog-body").innerHTML =
    '<div class="drawer-grid">' +
      '<div class="drawer-stat"><span>Current stage</span><strong>' + esc(worker.stage || "Status telemetry") + '</strong></div>' +
      '<div class="drawer-stat"><span>Elapsed</span><strong>' + elapsed(worker.elapsed_ms) + '</strong></div>' +
      '<div class="drawer-stat"><span>Target</span><strong>' + esc(workerTarget(worker)) + '</strong></div>' +
      '<div class="drawer-stat"><span>Progress</span><strong>' + fmt.format(worker.progress?.completed || 0) + " / " + fmt.format(worker.progress?.total || 0) + ' steps</strong></div>' +
    '</div>' +
    '<div class="drawer-links">' +
      linkClass(worker.job_url, "Open job", "pill run-link") +
      linkClass(worker.run_url, "Open workflow run", "pill run-link") +
      targetUrls.map(target => linkClass(target.url, target.label, "pill run-link")).join("") +
    '</div>' +
    '<h2>Step Timeline</h2>' +
    (stepRows ? '<ol class="step-list">' + stepRows + '</ol>' : '<div class="empty">Job-level steps are unavailable; showing workflow fallback telemetry.</div>');
  if (!dialog.open) dialog.showModal();
  history.replaceState(null, "", "#worker-" + encodeURIComponent(viewKey));
}
function renderAutomaticDialog(row, viewKey) {
  const dialog = document.getElementById("worker-dialog");
  const phase = compactText(row.phase || row.status || "queued").replaceAll("_", " ");
  document.getElementById("worker-dialog-heading").innerHTML =
    '<div><span class="pill"><i class="status-dot ' + workerStatusClass(row.status) + '"></i>' +
    esc(row.status) + '</span> <span class="pill">Automatic issue build</span></div>' +
    '<h3 id="worker-dialog-title">Automatic work</h3>' +
    '<div class="muted">Identity-safe status</div>';
  const timeline = (row.timeline || []).map(entry =>
    '<li class="step-row ' + esc(entry.status) + '"><i class="step-mark"></i><strong>' +
    esc(compactText(entry.phase).replaceAll("_", " ")) + '</strong><span>' +
    esc(entry.received_at ? since(entry.received_at) : entry.status) + '</span>' +
    (entry.note ? '<div class="muted" style="grid-column:2 / -1">' + esc(entry.note) + '</div>' : '') +
    '</li>'
  ).join("");
  document.getElementById("worker-dialog-body").innerHTML =
    '<div class="drawer-grid">' +
      '<div class="drawer-stat"><span>Current phase</span><strong>' + esc(phase) + '</strong></div>' +
      '<div class="drawer-stat"><span>Status</span><strong>' + esc(row.status) + '</strong></div>' +
      '<div class="drawer-stat"><span>Source</span><strong>Identity-safe status</strong></div>' +
      '<div class="drawer-stat"><span>Updated</span><strong>' + esc(row.updated_at ? since(row.updated_at) : "unknown") + '</strong></div>' +
    '</div>' +
    '<div class="drawer-links">' +
      linkClass(row.issue_url, "Open issue", "pill run-link") +
      linkClass(row.run_url, "Open workflow run", "pill run-link") +
      linkClass(row.pr_url, "Open generated PR", "pill run-link") +
      (row.worker_id ? '<button type="button" class="filter-button" data-linked-worker-id="' + esc(row.worker_id) + '">Open live worker</button>' : '') +
    '</div>' +
    '<h2>Lifecycle Timeline</h2>' +
    (timeline ? '<ol class="step-list">' + timeline + '</ol>' : '<div class="empty">No lifecycle events recorded yet.</div>');
  if (!dialog.open) dialog.showModal();
  history.replaceState(null, "", "#automatic-" + encodeURIComponent(viewKey));
}
function closeWorkerDialog() {
  const dialog = document.getElementById("worker-dialog");
  if (dialog.open) dialog.close();
  if (location.hash.startsWith("#worker-") || location.hash.startsWith("#automatic-") || location.hash.startsWith("#public-reference-")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}
function decodedHashValue(prefix) {
  try {
    return decodeURIComponent(location.hash.slice(prefix.length));
  } catch {
    return null;
  }
}
function openWorkerFromHash() {
  if (location.hash.startsWith("#worker-")) {
    const key = decodedHashValue("#worker-");
    const worker = key === null ? null : workerIndex.get(key);
    if (worker) renderWorkerDialog(worker, key);
    else closeWorkerDialog();
  } else if (location.hash.startsWith("#automatic-")) {
    const key = decodedHashValue("#automatic-");
    const row = key === null ? null : automaticIndex.get(key);
    if (row) renderAutomaticDialog(row, key);
    else closeWorkerDialog();
  } else if (location.hash.startsWith("#public-reference-")) {
    const key = decodedHashValue("#public-reference-");
    const row = key === null ? null : publicReferenceIndex.get(key);
    if (row) renderPublicReferenceDialog(row, key);
    else closeWorkerDialog();
  }
}

try {
  const cachedStatus = localStorage.getItem("clawsweeper:last-status");
  if (cachedStatus) {
    lastData = dashboardStatusSnapshot(JSON.parse(cachedStatus));
    if (lastData) {
      localStorage.setItem("clawsweeper:last-status", JSON.stringify(lastData));
    } else {
      localStorage.removeItem?.("clawsweeper:last-status");
    }
  }
} catch {
  lastData = null;
  localStorage.removeItem?.("clawsweeper:last-status");
}
if (lastData) {
  try {
    renderDashboard(lastData, "Showing cached status while refreshing...");
  } catch {
    lastData = null;
  }
}

async function load() {
  if (loading) return;
  loading = true;
  let data;
  try {
  const response = await fetch("/api/status", { cache: "no-store" });
  if (!response.ok) throw new Error("/api/status returned " + response.status);
  data = dashboardStatusSnapshot(await response.json());
  const cacheState = response.headers.get("x-clawsweeper-cache");
  const hasErrors = Boolean(data.diagnostics && Array.isArray(data.diagnostics.errors) && data.diagnostics.errors.length);
  const looksEmpty = !data.pipeline?.length && data.fleet?.active_workflow_runs === 0 && hasErrors;
  if (looksEmpty && lastData) {
    renderDashboard(lastData, "Live refresh failed; showing last good status.");
    return;
  }
  lastData = data;
  if (!looksEmpty) localStorage.setItem("clawsweeper:last-status", JSON.stringify(data));
  renderDashboard(
    data,
    cacheState === "stale"
      ? "Refreshing live status in the background."
      : hasErrors
        ? "Updated with partial GitHub telemetry."
        : "",
  );
  loadHealthHistory(activeHealthRange, false).catch(() => undefined);
  loadApplyObservability().catch(() => undefined);
  loadReviewCoverage().catch(() => undefined);
  loadAutomergeMetrics().catch(() => undefined);
  } catch {
    if (lastData) {
      renderDashboard(lastData, "Live refresh failed; showing last good status.");
    } else {
      document.getElementById("subtitle").textContent = "Failed to load public status.";
    }
  } finally {
    loading = false;
  }
}

function renderDashboard(data, note) {
  data = dashboardStatusSnapshot(data);
  if (!data) return;
  lastData = data;
  const handoffStatus = data.exact_review_queue?.handoff_health?.status;
  const operationalStatus = data.operational_health?.status;
  const serverHealth = data.dashboard_health;
  // Cached snapshots from before the observation contract remain readable
  // during rollout; new snapshots use the server-owned aggregate exclusively.
  const needsAttention = serverHealth
    ? serverHealth.conclusion === "needs_attention"
    : Boolean(
        (data.health?.unresolved_failures || 0) ||
        (data.recent?.apply_health?.items || []).some(item => applyHealthNeedsAttention(item.status)) ||
        Boolean(data.diagnostics?.exact_review_queue_error) ||
        ["degraded", "stalled"].includes(handoffStatus) ||
        ["degraded", "stalled", "unknown"].includes(operationalStatus) ||
        (data.recent?.automerge_reliability?.unresolved_failures || 0) > 0 ||
        (data.recent?.automerge_reliability?.stalled_attempts || 0) > 0
      );
  const severity = serverHealth?.severity ||
    (handoffStatus === "stalled" || operationalStatus === "stalled" ? "red" : needsAttention ? "amber" : "green");
  const workerCount = (data.workers || []).filter(worker => worker.is_codex_worker !== false).length;
  const repoCount = Number(data.source?.target_repository_count || 0);
  document.getElementById("hero-dot").className = "hero-dot " + (severity === "green" ? "ok" : severity);
  document.getElementById("hero-headline").textContent =
    (needsAttention ? "Needs attention" : "All clear") + " — " +
    fmt.format(workerCount) + " claw worker" + (workerCount === 1 ? "" : "s") + " sweeping " +
    fmt.format(repoCount) + " " + (repoCount === 1 ? "repository" : "repositories");
  document.getElementById("subtitle").textContent = "Identity-safe public status";
  const freshnessCopy = data.freshness?.state === "stale"
    ? " · stale snapshot"
    : data.freshness?.state === "unavailable"
      ? " · freshness unavailable"
      : "";
  document.getElementById("updated").textContent = "Updated " + since(data.generated_at) + freshnessCopy + (note ? " \u00b7 " + note : "");
  const fleet = data.fleet;
  const attempts = typeof data.health?.attempts === "number" ? data.health.attempts : NaN;
  const failedAttempts = typeof data.health?.failed_attempts === "number" ? data.health.failed_attempts : NaN;
  const errorRate = typeof data.health?.error_rate_percent === "number" ? data.health.error_rate_percent : NaN;
  const attemptsKnown = Number.isSafeInteger(attempts) && attempts > 0;
  const failedAttemptsKnown = Number.isSafeInteger(failedAttempts) && failedAttempts >= 0 && attemptsKnown && failedAttempts <= attempts;
  const expectedErrorRate = failedAttemptsKnown ? Math.round((failedAttempts / attempts) * 1000) / 10 : NaN;
  const errorRateKnown = failedAttemptsKnown && errorRate === expectedErrorRate;
  const errorRateAvailability = !attemptsKnown
    ? "denominator unavailable"
    : !failedAttemptsKnown
      ? "numerator unavailable"
      : "rate unavailable or inconsistent";
  document.getElementById("metrics").innerHTML = [
    metric("Codex Workers", fmt.format(fleet.active_codex_jobs), "Codex budget " + fleet.worker_budget, fleet.budget_used_percent, "var(--green)"),
    metric("Error Rate", errorRateKnown ? errorRate + "%" : "n/a", (failedAttemptsKnown ? fmt.format(failedAttempts) : "n/a") + " failed / " + (attemptsKnown ? fmt.format(attempts) : "n/a") + " attempts" + (errorRateKnown ? "" : " · " + errorRateAvailability), errorRateKnown ? Math.min(100, errorRate) : 0, errorRateKnown && failedAttempts > 0 ? "var(--red)" : errorRateKnown ? "var(--green)" : "var(--muted)"),
    metric("Recovery Rate", data.health?.recovery_rate_percent == null ? "n/a" : data.health.recovery_rate_percent + "%", fmt.format(data.health?.unresolved_failures || 0) + " unresolved", data.health?.recovery_rate_percent == null ? 100 : data.health.recovery_rate_percent, data.health?.unresolved_failures ? "var(--amber)" : "var(--green)"),
    metric("Codex Capacity", fleet.budget_used_percent + "%", "Codex slot utilization", fleet.budget_used_percent, "var(--green)")
  ].join("");
  renderHealthStrip();
  renderExecutionAlert(data.operational_health);
  renderSystemMap(data);
  renderExactReviewLanes(data.exact_review_queue);
  renderStateWriter(data.exact_review_queue);
  renderExactReviewHandoff(data.exact_review_queue);
  renderRecentDurablePublicationEvents(data.recent_durable_publication_events);
  renderApplyHealth(data);
  renderAutomaticWork(data.automatic_work || []);
  renderWorkers(data.workers || []);
  renderPublicReferences(data);
  openWorkerFromHash();
  renderClusterRepair(data.recent?.cluster_repair);
  renderPipeline(data.pipeline || []);
  renderAutomerge(data.recent.automerge || []);
  renderClosedStats(data.recent.closed_stats);
  renderClosedItems(data.recent.closed_items || []);
  renderWorkerHealth(data.health, data.recent?.automerge_reliability);
  renderOperations(data.recent.operation_counts);
  renderEvents(data.recent.events || []);
}
function renderApplyHealth(data) {
  const target = document.getElementById("apply-health");
  if (!target) return;
  const items = (data.recent?.apply_health?.items || []).filter(item => applyHealthNeedsAttention(item.status));
  if (!items.length) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = items.map(item => {
    const topReason = applyHealthPrimaryReason(item);
    const topInfo = applyHealthReasonInfo(topReason, item);
    const action = applyHealthRecommendedAction(item, topReason);
    const reasons = applyHealthReasonEntries(item)
      .slice(0, 4)
      .map(([reason, count]) => applyHealthReasonPill(reason, count, item))
      .join("");
    const showCursor = item.cursor_required || Boolean(item.cursor?.next_after_number);
    const buckets = applyHealthNextActionBucketPills(item);
    const cursor = item.cursor?.next_after_number ? "cursor #" + item.cursor.next_after_number : "cursor missing";
    const cursorTitle = item.cursor?.next_after_number
      ? "Rotation cursor was recorded; the next pruning run should continue after this item."
      : "No rotation cursor was recorded. If this was a full scan window, the next pruning run can repeat the same records.";
    const cursorPill = showCursor
      ? '<span class="pill" title="' + esc(cursorTitle) + '">' + esc(cursor) + '</span>'
      : "";
    const actionRecords = Number.isFinite(item.action_records)
      ? fmt.format(item.action_records)
      : Number.isFinite(item.processed)
        ? fmt.format(item.processed)
        : "unknown";
    const hasExamined = Number.isFinite(item.examined);
    const examined = hasExamined ? fmt.format(item.examined) : null;
    const activityLabel = hasExamined ? examined + " examined" : actionRecords + " actions";
    const activityTitle = hasExamined
      ? examined + " candidates examined; " + actionRecords + " produced action records."
      : actionRecords + " action records; candidate examined count unavailable for this lane.";
    const closed = Number.isFinite(item.closed) ? fmt.format(item.closed) : "unknown";
    const synced = Number.isFinite(item.comment_synced) ? fmt.format(item.comment_synced) : "unknown";
    const closureProcessed = Number.isFinite(item.lanes?.closure?.processed) ? fmt.format(item.lanes.closure.processed) : actionRecords;
    const syncProcessed = Number.isFinite(item.lanes?.comment_sync?.processed) ? fmt.format(item.lanes.comment_sync.processed) : actionRecords;
    const closureSynced = Number.isFinite(item.lanes?.closure?.comment_synced) ? fmt.format(item.lanes.closure.comment_synced) : "0";
    const syncLaneSynced = Number.isFinite(item.lanes?.comment_sync?.comment_synced) ? fmt.format(item.lanes.comment_sync.comment_synced) : "0";
    const cycle = applyHealthCyclePill(item.cycle);
    const candidateMix = applyHealthCandidateMixPill(item.cycle);
    return '<div class="apply-health-alert" role="status" title="' + esc(topInfo.summary + " Next: " + topInfo.action) + '">' +
      '<div class="apply-health-heading"><strong>Pruning sweep ' + esc(applyHealthStatusLabel(item.status)) + " - " + esc(item.target_repo || "target repo") + '</strong><span class="pill" title="' + esc("Latest " + applyHealthModeLabel(item.mode) + " status from the sweep-status marker.") + '">' + esc(applyHealthModeLabel(item.mode)) + '</span></div>' +
      '<p>' + esc(applyHealthOperatorSummary(item, topInfo)) + '</p>' +
      '<p class="apply-health-next"><strong>Next check:</strong> ' + esc(topInfo.action) + '</p>' +
      applyHealthActionHtml(action) +
      '<div class="apply-health-meta"><span class="pill" title="' + esc(activityTitle) + '">' + esc(activityLabel) + '</span><span class="pill" title="' + esc("Closure lane: " + closureProcessed + " action records; " + closed + " closed.") + '">' + esc(closed) + ' closed</span><span class="pill" title="' + esc("Durable review comments refreshed across lanes: " + synced + ". Closure lane refreshed " + closureSynced + "; comment-sync lane refreshed " + syncLaneSynced + " from " + syncProcessed + " action records.") + '">' + esc(synced) + ' comments synced</span>' + cycle + candidateMix + cursorPill + reasons + buckets + linkClass(item.run_url, "workflow run", "pill run-link") + '</div></div>';
  }).join("");
}
function applyHealthCyclePill(cycle) {
  if (!cycle || cycle.basis !== "scheduled_close_cursor") return "";
  const windows = Number(cycle.estimated_full_cycle_windows);
  const label = Number.isFinite(windows)
    ? "revisit ~" + fmt.format(windows) + " window" + (windows === 1 ? "" : "s")
    : "revisit estimate";
  return '<span class="pill" title="' + esc(cycle.label || "Estimated time to revisit the current apply-ready close queue.") + '">' + esc(label) + '</span>';
}
function applyHealthCandidateMixPill(cycle) {
  const counts = cycle?.candidate_counts;
  if (!counts) return "";
  const confirmed = Number(counts.confirmed_proposal) || 0;
  const guarded = Number(counts.guarded_retry) || 0;
  const proof = Number(counts.proof_required) || 0;
  const promotions = Number(counts.promotion_total) || 0;
  const eligiblePromotions = Number(counts.promotion_eligible) || 0;
  const cooldownEligiblePromotions = Number(counts.promotion_cooldown_eligible) || 0;
  const cooldownEligibleTotal = Number(counts.cooldown_eligible_total) || 0;
  const inconsistent = Number(counts.inconsistent_or_stale) || 0;
  const label = fmt.format(confirmed) + " proposals · " + fmt.format(guarded) + " retries · " + fmt.format(eligiblePromotions) + "/" + fmt.format(promotions) + " promotions admitted";
  const title = fmt.format(confirmed) + " confirmed proposals; " + fmt.format(guarded) + " guarded retries; " + fmt.format(eligiblePromotions) + " of " + fmt.format(promotions) + " promotion probes scheduler-admitted; " + fmt.format(cooldownEligiblePromotions) + " promotion probes and " + fmt.format(cooldownEligibleTotal) + " total candidates meet cooldown rules; " + fmt.format(proof) + " admitted candidates require close proof; " + fmt.format(inconsistent) + " inconsistent or stale records excluded.";
  return '<span class="pill" title="' + esc(title) + '">' + esc(label) + '</span>';
}
function applyHealthNeedsAttention(status) {
  return ["attention", "blocked", "degraded", "failed", "needs_attention", "warning"].includes(String(status || "").toLowerCase());
}
function applyHealthStatusLabel(status) {
  const value = String(status || "").toLowerCase();
  if (value === "failed") return "failed";
  if (value === "degraded" || value === "warning" || value === "attention") return "degraded";
  return "blocked";
}
function applyHealthModeLabel(mode) {
  const value = String(mode || "").toLowerCase();
  if (value === "comment_sync") return "comment-sync lane";
  if (value === "close") return "close lane";
  return "pruning lane";
}
function applyHealthReasonEntries(item) {
  const entries = [];
  const seen = new Set();
  const skipReasons = item.skip_reasons || {};
  for (const reason of item.attention_reasons || []) {
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    const skipCount = skipReasons[reason];
    entries.push([reason, Number.isFinite(skipCount) ? skipCount : null]);
  }
  for (const entry of Object.entries(skipReasons).sort((left, right) => Number(right[1]) - Number(left[1]))) {
    if (seen.has(entry[0])) continue;
    seen.add(entry[0]);
    entries.push(entry);
  }
  return entries;
}
function applyHealthPrimaryReason(item) {
  return applyHealthReasonEntries(item)[0]?.[0] || item.status || "";
}
function applyHealthReasonPill(reason, count, item) {
  const info = applyHealthReasonInfo(reason, item);
  const countText = Number.isFinite(count) ? " " + fmt.format(count) : "";
  return '<span class="pill apply-health-reason" title="' + esc(info.summary + " Next: " + info.action) + '">' + esc(info.label + countText) + '</span>';
}
function applyHealthNextActionForReason(item, reason) {
  return (item.next_actions || []).find(action => action.reason === reason) || null;
}
function applyHealthNextActionBucketPills(item) {
  const buckets = item.next_action_buckets || {};
  const entries = Object.entries(buckets)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]));
  if (entries.length < 2) return "";
  const total = entries.reduce((sum, [, count]) => sum + Number(count), 0);
  const summary = entries
    .slice(0, 4)
    .map(([bucket, count]) => applyHealthBucketLabel(bucket) + " " + fmt.format(Number(count)))
    .join("; ");
  return '<span class="pill apply-health-reason" title="' + esc("Follow-up buckets: " + summary) + '">' + esc("follow-ups " + fmt.format(total)) + '</span>';
}
function applyHealthBucketLabel(bucket) {
  const labels = {
    already_resolved: "already resolved",
    close_coverage_proof: "needs close proof",
    conversation_unlock: "unlock conversation",
    defer_until_closing_pr: "defer for PR state",
    inspect: "inspect skips",
    live_state_recovery: "live check recovery",
    maintainer_review: "maintainer decision",
    report_quality_repair: "repair review report",
    review_refresh: "refresh reviews",
    run_budget: "runtime budget",
    stable_skip: "stable skips",
  };
  return labels[bucket] || applyHealthReasonLabel(bucket);
}
function applyHealthActionHtml(action) {
  if (!action) return "";
  const command = action.command || "";
  const commandHtml = command
    ? '<code class="apply-health-command" title="' + esc(command) + '">' + esc(command) + '</code><button class="filter-button apply-health-copy" type="button" data-copy-command="' + esc(command) + '" title="Copy this maintainer command">Copy command</button>'
    : '<span class="apply-health-command" title="' + esc(action.detail || "") + '">' + esc(action.detail || "No safe automatic action is available from the dashboard.") + '</span>';
  return '<div class="apply-health-action" title="' + esc(action.title || "") + '">' + commandHtml + linkClass(action.url, action.linkLabel || "open workflow", "pill run-link") + '</div>';
}
function applyHealthRecommendedAction(item, reason) {
  const targetRepo = String(item.target_repo || "openclaw/openclaw");
  const mode = String(item.mode || "").toLowerCase();
  const workflowUrl = "https://github.com/openclaw/clawsweeper/actions/workflows/sweep.yml";
  const nextAction = applyHealthNextActionForReason(item, reason);
  if (reason === "cursor_required_but_missing_after_full_window") {
    return {
      title: "Maintainer action: inspect the current run before rerunning, because a missing cursor can make the next run repeat the same window.",
      detail: "Inspect the cursor-write and state-publish steps; rerun only after the cursor write failure is understood.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (reason === "skipped_changed_since_review") {
    return {
      title: "Maintainer action: " + (nextAction?.next_step || "refresh review records before trying to close changed items."),
      command: "gh workflow run sweep.yml --repo openclaw/clawsweeper -f target_repo=" + targetRepo + " -f apply_existing=false",
      url: workflowUrl,
      linkLabel: "open workflow",
    };
  }
  if (reason === "skipped_pr_close_coverage_proof") {
    return {
      title: "Maintainer action: " + (nextAction?.next_step || "add close-coverage proof before retrying PR pruning."),
      detail: nextAction?.next_step || "Add or refresh close-coverage proof, then rerun the close lane.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (nextAction && !nextAction.retryable) {
    return {
      title: "Maintainer action: " + (nextAction.next_step || "inspect this stable or policy-gated skip before rerunning."),
      detail: nextAction.next_step || "No automatic rerun is recommended for this skip bucket.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (nextAction && nextAction.bucket === "report_quality_repair") {
    return {
      title: "Maintainer action: " + (nextAction.next_step || "repair or refresh the review report."),
      detail: nextAction.next_step || "Queue report-quality repair or re-review before retrying apply.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (nextAction) {
    return {
      title: "Maintainer action: " + (nextAction.next_step || "inspect this follow-up before rerunning."),
      detail: nextAction.next_step || "Inspect this follow-up bucket before retrying apply.",
      url: item.run_url || workflowUrl,
      linkLabel: item.run_url ? "open run" : "open workflow",
    };
  }
  if (mode === "comment_sync") {
    return {
      title: "Maintainer action: run the next comment-sync cursor window. GitHub permissions control who can run it.",
      command: "gh workflow run sweep.yml --repo openclaw/clawsweeper -f target_repo=" + targetRepo + " -f apply_existing=true -f apply_sync_comments_only=true -f apply_item_numbers=__cursor__ -f apply_limit=25",
      url: workflowUrl,
      linkLabel: "open workflow",
    };
  }
  const closeLimit = Number.isFinite(item.close_limit) && item.close_limit > 0 ? item.close_limit : 5;
  return {
    title: "Maintainer action: rerun the bounded close lane. GitHub permissions control who can run it.",
    command: "gh workflow run sweep.yml --repo openclaw/clawsweeper -f target_repo=" + targetRepo + " -f apply_existing=true -f apply_limit=" + closeLimit + " -f apply_kind=all -f apply_close_reasons=all",
    url: workflowUrl,
    linkLabel: "open workflow",
  };
}
function applyHealthReasonInfo(reason, item) {
  const nextAction = item ? applyHealthNextActionForReason(item, reason) : null;
  if (nextAction?.label || nextAction?.summary || nextAction?.next_step) {
    return {
      label: nextAction.label || applyHealthReasonLabel(reason),
      summary: nextAction.summary || "ClawSweeper classified this skip bucket with a deterministic follow-up.",
      action: nextAction.next_step || "Inspect this follow-up bucket before rerunning.",
    };
  }
  const value = String(reason || "");
  if (value === "cursor_required_but_missing_after_full_window") {
    return {
      label: "Rotation cursor missing",
      summary: "The pruning sweep processed the full bounded window but did not publish the next cursor.",
      action: "Open the workflow run and check the cursor-write step; until the cursor is written, the next run can repeat this window.",
    };
  }
  if (value === "skipped_runtime_budget") {
    return {
      label: "Runtime budget hit",
      summary: "The workflow stopped processing because it reached its bounded runtime.",
      action: "Let the next scheduled sweep continue; if this repeats, reduce the batch size or raise the apply runtime budget.",
    };
  }
  if (value === "skipped_live_fetch_failed") {
    return {
      label: "GitHub live check failed",
      summary: "ClawSweeper could not confirm live GitHub state before mutating an item.",
      action: "Inspect the workflow run for GitHub API, auth, or rate-limit failures, then rerun after live checks recover.",
    };
  }
  if (value === "skipped_changed_since_review") {
    return {
      label: "Changed since review",
      summary: "The item changed after the ClawSweeper review that proposed the close.",
      action: "Refresh the ClawSweeper review for those items before closing; this skip is a safety guard.",
    };
  }
  if (value === "skipped_pr_close_coverage_proof") {
    return {
      label: "PR close proof needed",
      summary: "The PR needs coverage proof before ClawSweeper can close it as duplicate or superseded.",
      action: "Add or refresh close-coverage proof, then rerun the sweep.",
    };
  }
  if (value === "skipped_open_closing_pr") {
    return {
      label: "Closing PR still open",
      summary: "The issue appears covered by an open pull request, so ClawSweeper avoided closing it early.",
      action: "Review or land the linked closing PR before expecting the issue to close.",
    };
  }
  if (value === "skipped_maintainer_authored") {
    return {
      label: "Maintainer-authored item",
      summary: "Automation will not close this maintainer-authored item without human review.",
      action: "Have a maintainer decide whether to close it manually or update the review policy.",
    };
  }
  if (value === "skipped_policy_exempt" || value === "skipped_protected_label") {
    return {
      label: "Policy-protected item",
      summary: "A label or policy exemption blocked automated pruning.",
      action: "Check the policy or label before taking manual action.",
    };
  }
  if (value === "skipped_not_open" || value === "skipped_already_closed" || value === "skipped_closed") {
    return {
      label: "Already closed",
      summary: "The item was no longer open by the time ClawSweeper checked it.",
      action: "No action is usually needed; investigate only if already-closed records dominate repeated runs.",
    };
  }
  return {
    label: applyHealthReasonLabel(value || "blocked_condition"),
    summary: "ClawSweeper reported this skip bucket while checking whether it could safely prune an item.",
    action: "Open the workflow run and inspect this skip bucket before rerunning or changing limits.",
  };
}
function applyHealthReasonLabel(reason) {
  return String(reason || "")
    .replace(/^skipped_/, "")
    .replace(/_/g, " ")
    .replace(/\\b\\w/g, letter => letter.toUpperCase());
}
function applyHealthOperatorSummary(item, reasonInfo) {
  const processed = applyHealthCount(item.processed, "record", "records");
  const skipped = Number.isFinite(item.skipped) ? "; " + applyHealthCount(item.skipped, "record", "records") + " skipped" : "";
  const closed = Number.isFinite(item.closed) ? item.closed : 0;
  const synced = Number.isFinite(item.comment_synced) ? item.comment_synced : 0;
  const useful = closed + synced;
  const result = useful > 0
    ? "ClawSweeper processed " + processed + " and completed " + applyHealthCount(useful, "close/comment update", "close/comment updates")
    : "ClawSweeper processed " + processed + " without closing or syncing anything";
  return result + skipped + ". Main signal: " + reasonInfo.label + ".";
}
function applyHealthCount(value, singular, plural) {
  if (!Number.isFinite(value)) return "unknown " + plural;
  return fmt.format(value) + " " + (value === 1 ? singular : plural);
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
function renderClusterRepair(cluster) {
  const targets = Array.from(document.querySelectorAll(".cluster-repair"));
  if (!targets.length) return;
  if (!cluster) {
    for (const target of targets) {
      target.innerHTML = '<div class="empty">No cluster intake telemetry in this snapshot.</div>';
    }
    return;
  }
  const markerRows = (cluster.markers || []).map(marker => {
    const jobs = (marker.generated_jobs || []).slice(0, 3).map(job => '<span class="pill mono">' + esc(job.split("/").pop() || job) + '</span>').join("");
    const jobText = marker.generated_count ? fmt.format(marker.generated_count) + " job" + (marker.generated_count === 1 ? "" : "s") : "no jobs";
    return '<article class="work-row cluster-marker-row"><div class="work-main"><div class="row-top"><span class="pill">' + esc(marker.status || "unknown") + '</span><span class="item-link">' + esc(marker.target_repo || "unknown repo") + '</span></div><div class="muted work-title">store ' + esc(marker.last_processed_store_short_sha || "unknown") + " · " + esc(jobText) + (marker.last_processed_store_exported_at ? " · exported " + esc(since(marker.last_processed_store_exported_at)) : "") + '</div><div class="row-top">' + jobs + '</div></div><div class="work-state"><div class="stage-block"><strong>' + esc(marker.updated_at ? since(marker.updated_at) : "never") + '</strong><span class="muted">marker</span></div>' + linkClass(marker.run_url, "run", "pill run-link") + '</div></article>';
  }).join("");
  const runRows = (cluster.latest_runs || []).slice(0, 3).map(run => '<article class="side-row"><div class="side-main">' + linkClass(run.url, compactText(run.title || run.workflow), "item-link") + '<div class="muted side-title">' + esc(run.status || "") + (run.conclusion ? " · " + esc(run.conclusion) : "") + '</div></div><div class="side-meta"><span>' + esc(run.started_at ? since(run.started_at) : "") + '</span></div></article>').join("");
  const activeText = fmt.format((cluster.active_intake_runs || []).length) + " intake · " + fmt.format((cluster.active_worker_runs || []).length) + " workers";
  const html =
    '<div class="split"><div class="pipeline-col"><div class="muted" style="margin-bottom:8px">Runs on ' + esc(cluster.workflow || "repair-cluster-intake.yml") + " · " + esc(activeText) + '</div><div class="work-list">' + (markerRows || '<div class="empty">No processed-store markers yet.</div>') + '</div></div><aside class="side-col"><div class="muted" style="margin-bottom:8px">Recent intake workflow runs</div><div class="side-list">' + (runRows || '<div class="empty">No intake runs found.</div>') + '</div></aside></div>';
  for (const target of targets) {
    target.innerHTML = html;
  }
}
function renderAutomerge(rows) {
  if (!rows.length) {
    document.getElementById("automerge").innerHTML = '<div class="empty">No automerge data yet... claws resting</div>';
    return;
  }
  document.getElementById("automerge").innerHTML = '<div class="side-list">' + rows.map(row => '<article class="side-row"><div class="side-main">' + linkClass(row.url, "#" + row.number, "item-link") + '<div class="muted side-title">' + esc(row.title) + '</div></div><div class="side-meta"><span class="pill violet">' + (row.duration_ms ? elapsed(row.duration_ms) : "unknown") + '</span><span>' + (row.merged_at ? since(row.merged_at) : "") + '</span></div></article>').join("") + '</div>';
}
async function loadAutomergeMetrics() {
  const generation = ++automergeMetricsRequestGeneration;
  try {
    const params = new URLSearchParams({ range: activeAutomergeRange });
    const response = await fetch("/api/automerge-metrics?" + params.toString(), { cache: "no-store" });
    if (!response.ok) throw new Error("automerge metrics unavailable");
    const metrics = dashboardAutomergeMetricsSnapshot(await response.json());
    if (generation !== automergeMetricsRequestGeneration) return;
    if (!metrics || metrics.range !== activeAutomergeRange) throw new Error("invalid automerge metrics");
    lastAutomergeMetrics = metrics;
    renderAutomergeProduct(metrics);
  } catch {
    if (generation !== automergeMetricsRequestGeneration) return;
    lastAutomergeMetrics = null;
    renderAutomergeProduct(null);
  }
}
function renderAutomergeProduct(data) {
  data = dashboardAutomergeMetricsSnapshot(data);
  if (!data) {
    document.getElementById("automerge-meta").textContent = "Telemetry unavailable";
    document.getElementById("automerge-product").innerHTML = '<div class="empty">Automerge product telemetry could not be loaded.</div>';
    return;
  }
  const summary = data.summary || {};
  const sinceText = data.telemetry_since ? new Date(data.telemetry_since).toLocaleString() : "not started";
  const terminalSamples = Number(summary.terminal_sessions) || 0;
  document.getElementById("automerge-meta").textContent = "Telemetry since " + sinceText + " · Time-window coverage " + fmt.format(data.coverage_percent || 0) + "% · Active sessions " + fmt.format(summary.active_sessions || 0) + " · terminal sample n=" + fmt.format(terminalSamples) + " · Updated " + since(data.generated_at);
  const value = (number, suffix) => number == null ? "—" : fmt.format(number) + (suffix || "");
  const duration = number => number == null ? "—" : elapsed(number);
  const kpis = terminalSamples < 1
    ? '<div class="empty">No terminal samples yet. Active sessions remain outside the success-rate denominator.</div>'
    : '<div class="automerge-kpis">' +
    '<div class="automerge-kpi"><span>Merge success rate</span><strong>' + value(summary.merge_success_rate_percent, "%") + '</strong><small>merged ' + fmt.format(summary.merged_sessions || 0) + ' / terminal ' + fmt.format(summary.terminal_sessions || 0) + '</small></div>' +
    '<div class="automerge-kpi"><span>Command → Merge p50</span><strong>' + duration(summary.command_to_merge_p50_ms) + '</strong><small>successful sessions only</small></div>' +
    '<div class="automerge-kpi"><span>Command → Merge p90</span><strong>' + duration(summary.command_to_merge_p90_ms) + '</strong><small>nearest-rank percentile</small></div>' +
    '<div class="automerge-kpi"><span>Base sync / session</span><strong>' + value(summary.base_sync_p50) + ' · ' + value(summary.base_sync_p90) + '</strong><small>p50 · p90 · multi-rebase ' + value(summary.multi_rebase_rate_percent, "%") + '</small></div></div>';
  const maxLatency = Math.max(1, ...(data.buckets || []).flatMap(bucket => [bucket.command_to_merge_p50_ms || 0, bucket.command_to_merge_p90_ms || 0]));
  const points = (data.buckets || []).map(bucket => {
    if (activeAutomergeChart === "success") {
      if (bucket.success_rate_percent == null) return '<div class="automerge-point" title="No terminal samples"></div>';
      return '<div class="automerge-point" title="' + esc(bucket.start + ' · ' + bucket.success_rate_percent + '% · n=' + bucket.terminal_count) + '"><i class="automerge-dot' + (bucket.low_sample ? ' low' : '') + '" style="bottom:' + bucket.success_rate_percent + '%"></i><span class="automerge-n">n=' + fmt.format(bucket.terminal_count) + '</span></div>';
    }
    if (bucket.command_to_merge_p50_ms == null) return '<div class="automerge-point" title="No merged samples"></div>';
    const p50 = Math.round(bucket.command_to_merge_p50_ms / maxLatency * 100);
    const p90 = Math.round(bucket.command_to_merge_p90_ms / maxLatency * 100);
    return '<div class="automerge-point" title="' + esc(bucket.start + ' · p50 ' + duration(bucket.command_to_merge_p50_ms) + ' · p90 ' + duration(bucket.command_to_merge_p90_ms)) + '"><i class="automerge-dot" style="bottom:' + p50 + '%"></i><i class="automerge-dot p90" style="bottom:' + p90 + '%"></i><span class="automerge-n">n=' + fmt.format(bucket.merged_count) + '</span></div>';
  }).join("");
  const chart = '<div class="automerge-chart-shell"><div class="automerge-tabs"><button type="button" data-automerge-chart="success" class="' + (activeAutomergeChart === "success" ? "active" : "") + '">Merge success</button><button type="button" data-automerge-chart="latency" class="' + (activeAutomergeChart === "latency" ? "active" : "") + '">Merge latency</button></div><div class="automerge-chart" role="img" aria-label="Automerge ' + esc(activeAutomergeChart) + ' trend over ' + esc(activeAutomergeRange) + '">' + points + '</div><div class="automerge-chart-legend">' + (activeAutomergeChart === "success" ? '● normal sample · ○ fewer than 5 terminal sessions · gaps mean no terminal sample' : '● p50 · amber p90 · gaps mean no merged sample') + '</div></div>';
  const outcomeLabels = { merged: "Merged", repair_failed: "Repair workflow failed", maintainer_stopped: "Maintainer stopped", repair_cap_exhausted: "Repair cap exhausted", pr_closed: "PR closed", automerge_disabled: "Automerge disabled", unknown: "Other terminal outcome" };
  const outcomes = Object.entries(outcomeLabels).map(entry => '<div class="automerge-detail-row"><span>' + esc(entry[1]) + '</span><strong>' + fmt.format(data.terminal_outcomes?.[entry[0]] || 0) + '</strong></div>').join("");
  const efficiency = [['0 base sync sessions', data.repair_efficiency?.zero_base_sync], ['1 base sync session', data.repair_efficiency?.one_base_sync], ['2+ base sync sessions', data.repair_efficiency?.multiple_base_sync], ['Multi-rebase rate', value(summary.multi_rebase_rate_percent, "%")]].map(entry => '<div class="automerge-detail-row"><span>' + esc(entry[0]) + '</span><strong>' + esc(entry[1] ?? 0) + '</strong></div>').join("");
  const details = '<div class="automerge-details"><div><h3>Terminal outcomes</h3>' + outcomes + '</div><div><h3>Repair efficiency</h3>' + efficiency + '</div></div>';
  document.getElementById("automerge-product").innerHTML = kpis + chart + details;
}
function automergeWorkerHealthHtml(reliability) {
  const safe = reliability || {
    sampled_runs: 0,
    completed_attempts: 0,
    failed_attempts: 0,
    failure_rate_percent: null,
    active_attempts: 0,
    stalled_attempts: 0,
    average_duration_ms: null,
    longest_duration_ms: null,
    failures: []
  };
  const active = fmt.format(safe.active_attempts || 0) + " / " + fmt.format(safe.stalled_attempts || 0);
  const outcomes = fmt.format(safe.recovered_failures || 0) + " / " + fmt.format(safe.unresolved_failures || 0);
  const stats = '<div class="closed-stats"><div class="closed-stat"><span>Active / stalled</span><strong>' + esc(active) + '</strong></div><div class="closed-stat"><span>Failed attempts</span><strong>' + fmt.format(safe.failed_attempts || 0) + '</strong></div><div class="closed-stat"><span>Recovered / unresolved</span><strong>' + esc(outcomes) + '</strong></div></div>';
  const sample = '<div class="muted" style="margin:8px 0">' + fmt.format(safe.sampled_runs || 0) + " runs sampled · " + fmt.format(safe.completed_attempts || 0) + " completed · avg runtime " + elapsed(safe.average_duration_ms) + " · longest " + elapsed(safe.longest_duration_ms) + '</div>';
  const rows = (safe.failures || []).map(failure => '<article class="side-row"><div class="side-main"><div class="row-top">' + linkClass(failure.item_url, failure.repository + "#" + failure.number, "item-link") + linkClass(failure.run_url, "run", "pill run-link") + '</div><div class="muted side-title">' + esc(failure.conclusion || "failure") + " · " + elapsed(failure.duration_ms) + " · " + esc(failure.completed_at ? since(failure.completed_at) : "") + '</div></div><div class="side-meta"><span class="pill ' + (failure.recovered ? "" : "red") + '">' + (failure.recovered ? "recovered" : "unresolved") + '</span></div></article>').join("");
  return '<section class="worker-health-section" aria-labelledby="automerge-worker-health-title"><div class="worker-health-subhead"><strong id="automerge-worker-health-title">Automerge worker operations</strong><span class="muted">Repair workflow reliability only · separate from Automerge Product Health success rate.</span></div>' + stats + sample + (rows ? '<div class="side-list">' + rows + '</div>' : '<div class="empty">No automerge worker failures in the recent sample.</div>') + '</section>';
}
function renderClosedItems(rows) {
  const visible = (Array.isArray(rows) ? rows : []).filter(row =>
    Number.isFinite(Date.parse(row?.closed_at || ""))
  );
  if (!visible.length) {
    document.getElementById("closed").innerHTML = '<div class="empty">Individual close details are unavailable; aggregate counts remain above.</div>';
    return;
  }
  document.getElementById("closed").innerHTML = '<div class="side-list">' + visible.map(row => '<article class="side-row"><div class="side-main"><div class="row-top"><span class="pill">' + esc(row.type) + '</span>' + linkClass(row.url, row.repository + "#" + row.number, "item-link") + '</div><div class="muted side-title">' + esc(row.title) + '</div></div><div class="side-meta">' + since(row.closed_at) + '</div></article>').join("") + '</div>';
}
function renderClosedStats(stats) {
  const safe = stats || { total: 0, issues: 0, prs: 0, window_hours: 24 };
  document.getElementById("closed-stats").innerHTML = '<div class="closed-stats"><div class="closed-stat"><span>' + esc((safe.window_hours || 24) + "h total") + '</span><strong>' + fmt.format(safe.total || 0) + '</strong></div><div class="closed-stat"><span>Issues</span><strong>' + fmt.format(safe.issues || 0) + '</strong></div><div class="closed-stat"><span>PRs</span><strong>' + fmt.format(safe.prs || 0) + '</strong></div></div>';
}
function renderWorkerHealth(health, automergeReliability) {
  const safe = health || { attempts: 0, failed_attempts: 0, recovered_failures: 0, unresolved_failures: 0, failures: [] };
  const stats = '<div class="closed-stats"><div class="closed-stat"><span>Attempts sampled</span><strong>' + fmt.format(safe.attempts || 0) + '</strong></div><div class="closed-stat"><span>Failed attempts</span><strong>' + fmt.format(safe.failed_attempts || 0) + '</strong></div><div class="closed-stat"><span>Recovered</span><strong>' + fmt.format(safe.recovered_failures || 0) + '</strong></div></div>';
  const rows = (safe.failures || []).map(failure => '<article class="side-row"><div class="side-main">' + linkClass(failure.url, compactText(failure.workflow_title || failure.job_name), "item-link") + '<div class="muted side-title">' + esc(failure.failed_step || failure.conclusion || "worker failure") + '</div></div><div class="side-meta"><span class="pill ' + (failure.recovered ? "" : "red") + '">' + (failure.recovered ? "recovered" : "unresolved") + '</span><span>' + esc(failure.started_at ? since(failure.started_at) : "") + '</span></div></article>').join("");
  const workflowHealth = '<section class="worker-health-section">' + stats + (rows ? '<div class="side-list">' + rows + '</div>' : '<div class="empty">No worker failures in the recent sample.</div>') + '</section>';
  document.getElementById("worker-health").innerHTML = workflowHealth + automergeWorkerHealthHtml(automergeReliability);
}
function renderOperations(counts) {
  const safe = counts || {};
  const rows = [
    ["Inherited labels", safe.inherited_label_cleanups || 0],
    ["Conflict self-heal", safe.self_heal_conflict_repairs || 0],
    ["Review retries", safe.failed_review_retries || 0],
    ["Retry exhausted", safe.failed_review_retry_exhaustions || 0],
    ["Proof decisions", safe.bot_owned_proof_decisions_requested || 0],
    ["Proof dispatches", safe.bot_owned_proof_dispatches || 0]
  ];
  document.getElementById("operations").innerHTML = '<div class="closed-stats">' + rows.map(row => '<div class="closed-stat"><span>' + esc(row[0]) + '</span><strong>' + fmt.format(row[1]) + '</strong></div>').join("") + '</div>';
}
function renderEvents(rows) {
  if (!rows.length) {
    document.getElementById("events").innerHTML = '<div class="empty">Listening for signals from the fleet...</div>';
    return;
  }
  document.getElementById("events").innerHTML = '<div class="side-list">' + rows.map(row => '<article class="side-row"><div class="side-main"><div class="row-top"><span class="pill">' + esc(row.mode) + '</span><span class="item-link">' + esc(row.stage) + '</span></div><div class="muted side-title">' + (row.item_url ? link(row.item_url, row.title || row.item_url) : esc(row.title || row.event_type)) + '</div></div><div class="side-meta"><span>' + esc(row.status) + '</span><span>' + since(row.received_at) + '</span></div></article>').join("") + '</div>';
}
document.getElementById("worker-filters").addEventListener("click", event => {
  const button = event.target.closest("button[data-worker-filter]");
  if (!button) return;
  activeWorkerFilter = button.dataset.workerFilter || "all";
  renderWorkers(lastData?.workers || []);
});
document.getElementById("public-reference-search").addEventListener("submit", event => {
  event.preventDefault();
  publicReferenceQuery = document.getElementById("public-reference-input").value;
  renderPublicReferences(lastData || {});
});
document.getElementById("public-reference-clear").addEventListener("click", () => {
  publicReferenceQuery = "";
  document.getElementById("public-reference-input").value = "";
  renderPublicReferences(lastData || {});
});
document.getElementById("public-references").addEventListener("click", event => {
  const button = event.target.closest("button[data-public-reference-key]");
  if (!button) return;
  const key = String(button.dataset.publicReferenceKey || "");
  const row = publicReferenceIndex.get(key);
  if (row) renderPublicReferenceDialog(row, key);
});
document.getElementById("trend-ranges").addEventListener("click", event => {
  const button = event.target.closest("button[data-trend-range]");
  if (!button) return;
  document.querySelectorAll("button[data-trend-range]").forEach(item => item.classList.toggle("active", item === button));
  loadHealthHistory(button.dataset.trendRange || "6h", true).catch(() => undefined);
});
document.getElementById("apply-observability-ranges").addEventListener("click", event => {
  const button = event.target.closest("button[data-apply-range]");
  if (!button) return;
  activeApplyRange = button.dataset.applyRange || "24h";
  document.querySelectorAll("button[data-apply-range]").forEach(item => item.classList.toggle("active", item === button));
  loadApplyObservability().catch(() => undefined);
});
document.getElementById("automerge-ranges").addEventListener("click", event => {
  const button = event.target.closest("button[data-automerge-range]");
  if (!button) return;
  activeAutomergeRange = button.dataset.automergeRange || "7d";
  document.querySelectorAll("button[data-automerge-range]").forEach(item => item.classList.toggle("active", item === button));
  loadAutomergeMetrics().catch(() => undefined);
});
document.getElementById("automerge-product").addEventListener("click", event => {
  const button = event.target.closest("button[data-automerge-chart]");
  if (!button || !lastAutomergeMetrics) return;
  activeAutomergeChart = button.dataset.automergeChart || "success";
  renderAutomergeProduct(lastAutomergeMetrics);
});
document.getElementById("workers").addEventListener("click", event => {
  const button = event.target.closest("button[data-worker-id]");
  if (!button) return;
  const worker = workerIndex.get(String(button.dataset.workerId));
  if (worker) renderWorkerDialog(worker, String(button.dataset.workerId));
});
document.getElementById("automatic-work").addEventListener("click", event => {
  const button = event.target.closest("button[data-automatic-id]");
  if (!button) return;
  const row = automaticIndex.get(String(button.dataset.automaticId));
  if (row) renderAutomaticDialog(row, String(button.dataset.automaticId));
});
document.addEventListener("click", event => {
  const button = event.target.closest("button[data-copy-command]");
  if (!button) return;
  const command = String(button.dataset.copyCommand || "");
  if (!command) return;
  const copied = navigator.clipboard?.writeText(command);
  if (!copied) return;
  copied.then(() => {
    const original = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = original || "Copy command";
    }, 1500);
  }).catch(() => undefined);
});
document.getElementById("worker-dialog-close").addEventListener("click", closeWorkerDialog);
document.getElementById("worker-dialog").addEventListener("click", event => {
  const linkedWorker = event.target.closest("button[data-linked-worker-id]");
  if (linkedWorker) {
    const worker = workerIndex.get(String(linkedWorker.dataset.linkedWorkerId));
    if (worker) renderWorkerDialog(worker, String(linkedWorker.dataset.linkedWorkerId));
    return;
  }
  if (event.target === event.currentTarget) closeWorkerDialog();
});
document.getElementById("worker-dialog").addEventListener("close", () => {
  if (location.hash.startsWith("#worker-") || location.hash.startsWith("#automatic-") || location.hash.startsWith("#public-reference-")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
});
window.addEventListener("hashchange", openWorkerFromHash);
load();
setInterval(load, 15000);
</script>
</body>
</html>`;
}

export { dashboardHtml, issueTriagePageConfig, prProofTriagePageConfig, triageHtml };
