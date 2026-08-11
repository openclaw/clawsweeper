export type DashboardEnv = Record<string, unknown>;

const DEFAULT_CRABFLEET_URL = "https://crabfleet.openclaw.ai";

function issueTriagePageConfig() {
  return {
    title: "ClawSweeper Triage",
    loadingSubtitle: "Loading advisory issue labels...",
    endpoint: "/api/triage",
    storagePrefix: "clawsweeper:triage",
    defaultView: "clawsweeper",
    navLabel: "Issue triage views",
    filterPlaceholder: "Title, number, author, assignee, label...",
    itemNoun: "issue",
    itemLabel: "Issue",
    emptySnapshotText: "No matching issues in the current snapshot.",
    emptyFilterText: "No issues match the current filter.",
    routingGroups: true,
    highlightLabelPrefixes: ["clawsweeper:"],
    links: [
      { href: "/", label: "Live pipeline" },
      { href: "/bay", label: "OpenClaw Bay" },
      { href: "/pr-proof-triage", label: "PR proof triage" },
    ],
    columns: [
      { key: "issue", label: "Issue", width: 420, min: 240 },
      { key: "assignees", label: "Assignees", width: 140, min: 100 },
      { key: "priority", label: "Priority", width: 92, min: 76 },
      { key: "area", label: "Impact group", width: 180, min: 130 },
      { key: "prs", label: "Linked PRs", width: 180, min: 120 },
      { key: "labels", label: "Labels", width: 430, min: 220 },
      { key: "updated", label: "Updated", width: 130, min: 110 },
      { key: "comments", label: "Comments", width: 96, min: 84 },
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
    loadingSubtitle: "Loading pull request proof labels...",
    endpoint: "/api/pr-proof-triage",
    storagePrefix: "clawsweeper:pr-proof-triage",
    defaultView: "missing-proof",
    navLabel: "Pull request proof triage views",
    filterPlaceholder: "Title, number, author, assignee, proof state, label...",
    itemNoun: "PR",
    itemLabel: "Pull request",
    emptySnapshotText: "No matching pull requests in the current snapshot.",
    emptyFilterText: "No pull requests match the current filter.",
    routingGroups: false,
    highlightLabelPrefixes: ["triage:", "proof:", "mantis:"],
    links: [
      { href: "/", label: "Live pipeline" },
      { href: "/bay", label: "OpenClaw Bay" },
      { href: "/triage", label: "Issue triage" },
    ],
    columns: [
      { key: "issue", label: "Pull request", width: 420, min: 240 },
      { key: "author", label: "Author", width: 130, min: 100 },
      { key: "assignees", label: "Assignees", width: 140, min: 100 },
      { key: "priority", label: "Priority", width: 86, min: 76 },
      { key: "proof", label: "Proof state", width: 180, min: 140 },
      { key: "labels", label: "Labels", width: 430, min: 220 },
      { key: "updated", label: "Updated", width: 130, min: 110 },
      { key: "comments", label: "Comments", width: 96, min: 84 },
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

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
  );
}

function externalHttpUrl(value, fallback) {
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

function serializedPageConfig(config) {
  return JSON.stringify(config).replace(/</g, "\\u003c");
}

function triageHtml(config) {
  const pageConfig = serializedPageConfig(config);
  const routingGroupControl = config.routingGroups
    ? `<label class="field">
        <span>Impact group</span>
        <select id="routing-group">
          <option value="">All impact groups</option>
        </select>
      </label>`
    : "";
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
main { width: min(1560px, calc(100vw - 48px)); margin: 0 auto; padding: 34px 0 72px; }
header { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
header h1 + .muted { margin-top: 6px; font-size: 12px; }
h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 650;
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 9px;
}
h1::before { content: "🦞"; font-size: 20px; }
h2 {
  margin: 32px 0 12px;
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
a { color: var(--claw); text-decoration: none; }
a:hover { text-decoration: underline; text-underline-offset: 3px; }
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.top-links { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.top-link { color: var(--muted); font-size: 12.5px; font-weight: 500; }
.top-link:hover { color: var(--claw); text-decoration: none; }
#updated { font-size: 11px; }
.pill,
.tab,
.query-link {
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
.pill:hover,
.tab:hover,
.query-link:hover { border-color: color-mix(in srgb, var(--claw) 45%, var(--line)); color: var(--text); }
a.pill:hover,
.query-link:hover { color: var(--claw); text-decoration: none; }
.query-link { color: var(--claw); border-color: color-mix(in srgb, var(--claw) 35%, transparent); }
.grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  margin-bottom: 24px;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.metric { padding: 16px 18px 14px; border-left: 1px solid var(--line-soft); min-width: 0; overflow: hidden; }
.metric:first-child { border-left: 0; padding-left: 0; }
.metric strong { display: block; margin-top: 9px; font-size: 28px; font-weight: 560; line-height: 1; letter-spacing: -0.03em; }
.metric span { color: var(--muted); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; }
.metric .muted { font-size: 12px; margin-top: 4px; }
.tabs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 14px;
  padding-bottom: 10px;
}
button.tab {
  cursor: pointer;
  font: inherit;
}
button.tab[aria-selected="true"] {
  color: var(--claw);
  border-color: color-mix(in srgb, var(--claw) 55%, transparent);
  background: color-mix(in srgb, var(--claw) 8%, transparent);
}
.view-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 16px;
  margin: 14px 0;
}
.view-title { display: grid; gap: 3px; min-width: 0; }
.view-title strong { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.controls {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 14px;
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
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
input,
select,
.secondary-button {
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  padding: 6px 10px;
  font: inherit;
}
input { min-width: min(460px, calc(100vw - 48px)); }
select { min-width: 190px; }
input::placeholder { color: var(--muted); }
input:focus,
select:focus,
.secondary-button:focus {
  outline: 2px solid color-mix(in srgb, var(--claw) 55%, transparent);
  outline-offset: 1px;
}
.secondary-button {
  cursor: pointer;
  min-width: 70px;
  font-weight: 600;
  color: var(--muted);
  transition: border-color 0.15s ease, color 0.15s ease;
}
.secondary-button:hover { color: var(--claw); border-color: color-mix(in srgb, var(--claw) 45%, var(--line)); }
.table-wrap {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
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
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  vertical-align: top;
}
th {
  position: relative;
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  background: transparent;
  font-weight: 600;
  letter-spacing: 0.1em;
  border-bottom-color: var(--line);
}
tbody tr:hover { background: color-mix(in srgb, var(--claw) 3%, transparent); }
tr:last-child td { border-bottom: 0; }
.issue-cell { display: grid; gap: 4px; min-width: 0; }
.issue-title {
  display: block;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.3;
  font-weight: 600;
  color: var(--text);
}
.issue-title:hover { color: var(--claw); }
.label-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.assignee-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.pr-list { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.label-pill,
.priority-filter {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.label-pill.dot::before {
  content: "";
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--label-color, transparent);
}
.label-pill.clawsweeper,
.label-pill.highlight { color: var(--claw); border-color: color-mix(in srgb, var(--claw) 40%, transparent); }
.label-pill:hover,
.priority-filter:hover {
  border-color: color-mix(in srgb, var(--claw) 55%, transparent);
  color: var(--claw);
}
.priority-filter {
  border-color: color-mix(in srgb, var(--amber) 45%, transparent);
  background: color-mix(in srgb, var(--amber) 8%, transparent);
  color: var(--amber);
}
.assignee-pill {
  display: inline-flex;
  align-items: center;
  min-height: 19px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--violet) 40%, transparent);
  background: color-mix(in srgb, var(--violet) 7%, transparent);
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
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.25;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.pr-chip.open { border-color: color-mix(in srgb, var(--green) 45%, transparent); color: var(--green); }
.pr-chip.merged { border-color: color-mix(in srgb, var(--violet) 45%, transparent); color: var(--violet); }
.pr-chip.closed { border-color: color-mix(in srgb, var(--red) 45%, transparent); color: var(--red); }
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
  background: color-mix(in srgb, var(--claw) 55%, transparent);
}
body.resizing-col {
  cursor: col-resize;
  user-select: none;
}
.priority { color: var(--amber); }
.empty,
.error {
  padding: 26px;
  color: var(--muted);
  background: transparent;
  border: 1px dashed var(--line);
  border-radius: 12px;
  text-align: center;
}
.empty::before { content: "🦞 "; opacity: 0.5; }
.error { color: var(--red); border-color: color-mix(in srgb, var(--red) 40%, transparent); }
@media (max-width: 1280px) {
  .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .metric:nth-child(3n + 1) { border-left: 0; padding-left: 0; }
  header, .view-head { align-items: start; flex-direction: column; }
  .top-links { justify-content: flex-start; }
}
@media (max-width: 760px) {
  main { width: min(100vw - 24px, 1560px); padding-top: 20px; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(config.title)}</h1>
      <div class="muted" id="subtitle">${escapeHtml(config.loadingSubtitle)}</div>
    </div>
    <div class="top-links">
      ${config.links.map((link) => `<a class="top-link" href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("")}
      ${dashboardThemeControlHtml()}
      <span class="muted mono" id="updated"></span>
    </div>
  </header>
  <section class="grid" id="metrics"></section>
  <section class="controls" id="controls">
    <div class="control-group">
      <label class="field">
        <span>Filter</span>
        <input id="issue-filter" type="search" placeholder="${escapeHtml(config.filterPlaceholder)}">
      </label>
      <button class="secondary-button" id="clear-filter" type="button">Clear</button>
      ${routingGroupControl}
      <label class="field">
        <span>Sort</span>
        <select id="issue-sort">
          <option value="created-desc">Newest ${escapeHtml(config.itemNoun)} first</option>
          <option value="created-asc">Oldest ${escapeHtml(config.itemNoun)} first</option>
          <option value="number-desc">Highest ${escapeHtml(config.itemNoun)} number first</option>
          <option value="number-asc">Lowest ${escapeHtml(config.itemNoun)} number first</option>
          <option value="updated-desc">Recently updated first</option>
          <option value="updated-asc">Least recently updated first</option>
          <option value="comments-desc">Most comments first</option>
          <option value="comments-asc">Fewest comments first</option>
        </select>
      </label>
    </div>
    <span class="muted mono" id="visible-count">Showing 0 loaded</span>
  </section>
  <nav class="tabs" id="tabs" aria-label="${escapeHtml(config.navLabel)}"></nav>
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
${dashboardThemeControlScript()}
const PAGE = ${pageConfig};
const fmt = new Intl.NumberFormat();
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const COLUMN_ORDER = PAGE.columns.map(column => column.key);
const COLUMN_LABELS = Object.fromEntries(PAGE.columns.map(column => [column.key, column.label]));
const COLUMN_DEFAULTS = Object.fromEntries(PAGE.columns.map(column => [column.key, column.width]));
const COLUMN_MIN = Object.fromEntries(PAGE.columns.map(column => [column.key, column.min]));
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
let activeView = location.hash.replace(/^#/, "") || storageGet(PAGE.storagePrefix + ":view") || PAGE.defaultView;
let activeGroup = PAGE.routingGroups
  ? new URLSearchParams(location.search).get("group") || storageGet(PAGE.storagePrefix + ":group")
  : "";
let filterText = storageGet(PAGE.storagePrefix + ":filter");
let sortMode = storageGet(PAGE.storagePrefix + ":sort") || "created-desc";
let filterTimer = null;
let columnWidths = loadColumnWidths();
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}
function loadColumnWidths() {
  let saved = {};
  try {
    saved = JSON.parse(storageGet(PAGE.storagePrefix + ":columns") || "{}");
  } catch {
    saved = {};
  }
  return Object.fromEntries(COLUMN_ORDER.map(key => {
    const width = Number(saved[key]);
    return [key, Math.max(COLUMN_MIN[key], Number.isFinite(width) ? width : COLUMN_DEFAULTS[key])];
  }));
}
function saveColumnWidths() {
  storageSet(PAGE.storagePrefix + ":columns", JSON.stringify(columnWidths));
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
function updateLocation() {
  const url = new URL(location.href);
  if (PAGE.routingGroups && activeGroup) url.searchParams.set("group", activeGroup);
  else url.searchParams.delete("group");
  url.hash = activeView;
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}
function metric(label, count, detail) {
  return '<article class="metric"><span>' + esc(label) + '</span><strong>' + esc(fmt.format(count || 0)) + '</strong><div class="muted">' + esc(detail || "") + '</div></article>';
}
function labelPill(label) {
  const name = label.name || String(label);
  const color = label.color ? '#' + label.color : '';
  const style = color ? ' style="--label-color: ' + esc(color) + ';"' : '';
  const highlighted = (PAGE.highlightLabelPrefixes || []).some(prefix => name.startsWith(prefix));
  const cls = (highlighted ? "label-pill highlight" : "label-pill") + (color ? " dot" : "");
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
function routingGroupPills(row) {
  const groups = Array.isArray(row.routing_groups) ? row.routing_groups : [];
  if (!groups.length) return '<span class="muted">Unclassified</span>';
  return groups.map(group =>
    '<button class="label-pill" type="button" data-group-value="' + esc(group.id) +
    '" title="Show ' + esc(group.title) + '">' + esc(group.title) + '</button>'
  ).join("");
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
    row.proof_state,
    ...(row.routing_groups || []).flatMap(group => [group.id, group.title]),
    ...(row.labels || []).map(label => label.name)
  ].join(" ").toLowerCase();
}
function filteredRows(rows) {
  const terms = filterText.toLowerCase().split(/\\s+/).filter(Boolean);
  const grouped = activeGroup
    ? rows.filter(row => (row.routing_groups || []).some(group => group.id === activeGroup))
    : rows.slice();
  const visible = terms.length
    ? grouped.filter(row => terms.every(term => searchableText(row).includes(term)))
    : grouped;
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
      storageSet(PAGE.storagePrefix + ":view", activeView);
      updateLocation();
      render();
    });
  });
}
function renderMetrics(views) {
  const byId = Object.fromEntries(views.map(view => [view.id, view.total_count || 0]));
  document.getElementById("metrics").innerHTML = PAGE.metrics.map(item =>
    metric(item.label, byId[item.view], item.detail)
  ).join("");
}
function renderTable(view) {
  document.getElementById("view-name").textContent = view.title + " (" + fmt.format(view.total_count || 0) + ")";
  document.getElementById("view-description").textContent = view.description || "";
  const query = document.getElementById("github-query");
  const githubUrl = routingGroupGithubUrl(view);
  query.href = githubUrl || "https://github.com/issues";
  query.style.display = githubUrl ? "inline-flex" : "none";
  renderRows(view);
}
function routingGroupGithubUrl(view) {
  if (!view.github_url || !activeGroup) return view.github_url || "";
  const group = (state?.routing_groups || []).find(candidate => candidate.id === activeGroup);
  if (!group || group.labels?.length !== 1) return "";
  const url = new URL(view.github_url);
  const query = url.searchParams.get("q") || "";
  url.searchParams.set("q", query + ' label:"' + group.labels[0] + '"');
  return url.toString();
}
function authorCell(row) {
  return row.author ? '<button class="label-pill" type="button" data-filter-value="' + esc(row.author) + '" title="Filter by ' + esc(row.author) + '">' + esc(row.author) + '</button>' : '<span class="muted">Unknown</span>';
}
function proofStateCell(row) {
  return row.proof_state ? '<button class="priority-filter" type="button" data-filter-value="' + esc(row.proof_state) + '" title="Filter by ' + esc(row.proof_state) + '">' + esc(row.proof_state) + '</button>' : '<span class="muted">-</span>';
}
function rowCellHtml(key, row) {
  if (key === "issue") {
    const itemLabel = row.repository + "#" + row.number;
    return '<div class="issue-cell"><a class="issue-title" href="' + esc(row.url) + '" target="_blank" rel="noreferrer">' + esc(compact(row.title)) + '</a><span class="muted mono">' + esc(itemLabel) + (row.author ? " opened by " + esc(row.author) : "") + '</span></div>';
  }
  if (key === "author") return authorCell(row);
  if (key === "assignees") return '<div class="assignee-list">' + assigneePills(row) + '</div>';
  if (key === "priority") {
    const priority = priorityFor(row);
    return priority
      ? '<button class="priority-filter" type="button" data-filter-value="' + esc(priority) + '" title="Filter by ' + esc(priority) + '">' + esc(priority) + '</button>'
      : '<span class="muted">-</span>';
  }
  if (key === "proof") return proofStateCell(row);
  if (key === "area") return '<div class="label-list">' + routingGroupPills(row) + '</div>';
  if (key === "prs") return '<div class="pr-list">' + linkedPullRequestPills(row) + '</div>';
  if (key === "labels") return '<div class="label-list">' + (row.labels || []).map(labelPill).join("") + '</div>';
  if (key === "updated") return '<span title="' + esc(row.updated_at || "") + '">' + esc(since(row.updated_at)) + '</span>';
  if (key === "comments") return esc(fmt.format(row.comments || 0));
  return "";
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
    document.getElementById("table").innerHTML = '<div class="empty">' + esc(PAGE.emptySnapshotText) + '</div>';
    return;
  }
  if (!rows.length) {
    document.getElementById("table").innerHTML = '<div class="empty">' + esc(PAGE.emptyFilterText) + '</div>';
    return;
  }
  const tableRows = rows.map(row => {
    return '<tr>' +
      COLUMN_ORDER.map(key => '<td>' + rowCellHtml(key, row) + '</td>').join("") +
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
function renderRoutingGroupControl(view) {
  if (!PAGE.routingGroups) return;
  const select = document.getElementById("routing-group");
  const groups = state?.routing_groups || [];
  if (activeGroup && !groups.some(group => group.id === activeGroup)) {
    activeGroup = "";
    storageSet(PAGE.storagePrefix + ":group", "");
    updateLocation();
  }
  const counts = view?.loaded_routing_group_counts || {};
  select.innerHTML = '<option value="">All impact groups</option>' + groups.map(group =>
    '<option value="' + esc(group.id) + '">' + esc(group.title) +
    ' (' + esc(fmt.format(counts[group.id] || 0)) + ')</option>'
  ).join("");
  select.value = activeGroup;
}
function initControls() {
  const input = document.getElementById("issue-filter");
  const sort = document.getElementById("issue-sort");
  input.value = filterText;
  sort.value = sortMode;
  const routingGroup = document.getElementById("routing-group");
  input.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterText = input.value;
      storageSet(PAGE.storagePrefix + ":filter", filterText);
      const view = currentView();
      if (view) renderRows(view);
    }, 80);
  });
  document.getElementById("clear-filter").addEventListener("click", () => {
    filterText = "";
    input.value = "";
    storageSet(PAGE.storagePrefix + ":filter", filterText);
    const view = currentView();
    if (view) renderRows(view);
    input.focus();
  });
  sort.addEventListener("change", event => {
    sortMode = event.target.value;
    storageSet(PAGE.storagePrefix + ":sort", sortMode);
    const view = currentView();
    if (view) renderRows(view);
  });
  if (routingGroup) {
    routingGroup.addEventListener("change", event => {
      activeGroup = event.target.value;
      storageSet(PAGE.storagePrefix + ":group", activeGroup);
      updateLocation();
      render();
    });
  }
  document.getElementById("table").addEventListener("click", event => {
    const groupTarget = event.target.closest("[data-group-value]");
    if (groupTarget) {
      activeGroup = groupTarget.getAttribute("data-group-value") || "";
      storageSet(PAGE.storagePrefix + ":group", activeGroup);
      updateLocation();
      render();
      return;
    }
    const target = event.target.closest("[data-filter-value]");
    if (!target) return;
    filterText = target.getAttribute("data-filter-value") || "";
    input.value = filterText;
    storageSet(PAGE.storagePrefix + ":filter", filterText);
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
  const view = views.find(view => view.id === activeView) || views[0] || {};
  renderRoutingGroupControl(view);
  renderTable(view);
  renderDiagnostics(state);
}
async function load() {
  try {
    const response = await fetch(PAGE.endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(PAGE.endpoint + " returned " + response.status);
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
.automerge-details h3, .automerge-sessions h3 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.automerge-detail-row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--line-soft); font-size: 12px; }
.automerge-sessions { margin-top: 22px; overflow-x: auto; }
.automerge-sessions-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.automerge-sessions-head h3 { margin: 0; }
.automerge-sessions-head span { color: var(--muted); font-size: 10px; }
.automerge-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.automerge-table th, .automerge-table td { padding: 9px 8px; border-bottom: 1px solid var(--line-soft); text-align: left; white-space: nowrap; }
.automerge-table th { color: var(--muted); font-weight: 500; }
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
      <h3 class="overview-section-title">Exact Review</h3>
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
  </section>
  <h2 id="review-coverage-title">Fleet Review Coverage</h2>
  <details class="review-coverage">
    <summary>
      <span class="coverage-summary-content">
        <span class="coverage-summary-label">Explore repository coverage</span>
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
        <label class="muted">Repo <select id="automerge-repo" aria-label="Filter automerge metrics by repository"><option value="">All</option></select></label>
        <label class="muted">Policy <select id="automerge-policy" aria-label="Filter automerge metrics by policy"><option value="">All</option></select></label>
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
      <button class="drawer-close" id="worker-dialog-close" type="button" aria-label="Close worker details">×</button>
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
  return '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong><div class="muted">' + esc(sub || "") + '</div><div class="band"><i style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%;background:' + (color || "var(--claw)") + '"></i></div></div>';
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
let activeAutomergeRange = "7d";
let activeAutomergeChart = "success";
let lastAutomergeMetrics = null;
let automergeMetricsRequestGeneration = 0;
let activeWorkerFilter = "all";
let workerIndex = new Map();
let automaticIndex = new Map();
let activeHealthRange = "6h";
let activeApplyRange = "24h";
let healthHistoryLoadedAt = 0;
let healthHistorySamples = [];
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
  const details = "Total GitHub queued " + fmt.format(Number(current?.queued_runs) || 0) + " · oldest queued " + formatAgeMinutes(current?.oldest_queued_minutes) + " · oldest running " + formatAgeMinutes(current?.oldest_running_minutes) + (approvalGated ? " · " + fmt.format(approvalGated) + " awaiting deployment approval (oldest " + formatAgeMinutes(current?.oldest_approval_gated_minutes) + ")" : "");
  target.innerHTML = '<details class="execution-alert"><summary><span class="execution-alert-title"><strong>⚠ Work execution needs attention</strong><span>' + esc(parts.join(" · ")) + '</span></span><span class="execution-alert-toggle">Details ▾</span></summary><div class="execution-alert-body">' + esc(details) + '</div></details>';
}

function applyMetric(label, value, detail) {
  return '<div class="apply-observability-metric"><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</div>';
}
function applyValue(value) {
  if (value == null) return "unknown";
  return Number.isFinite(Number(value)) ? fmt.format(Number(value)) : "unknown";
}
function renderApplyObservability(payload) {
  const summary = document.getElementById("apply-observability-summary");
  const target = document.getElementById("apply-observability-body");
  if (!summary || !target) return;
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
  target.innerHTML = blocks(queueRows) + blocks(resultRows) + '<div class="review-anomalies"><div class="review-anomaly"><span><strong>Last failure</strong> ' + esc(failureText) + '</span>' + link(failures.last_failure_run_url, "Actions run") + '</div></div>' + blocks(failureRows);
}
async function loadApplyObservability() {
  const generation = ++applyObservabilityRequestGeneration;
  try {
    const response = await fetch("/api/apply-observability?range=" + encodeURIComponent(activeApplyRange), { cache: "no-store" });
    if (!response.ok) throw new Error("apply observability returned " + response.status);
    const payload = await response.json();
    if (generation !== applyObservabilityRequestGeneration) return;
    lastApplyObservability = payload;
    renderApplyObservability(payload);
  } catch {
    if (generation !== applyObservabilityRequestGeneration) return;
    lastApplyObservability = null;
    document.getElementById("apply-observability-summary").innerHTML = '<span class="review-status degraded">Telemetry unavailable</span>';
    document.getElementById("apply-observability-body").innerHTML = '<div class="empty">Durable apply telemetry could not be loaded.</div>';
  }
  renderHealthStrip();
}

async function loadReviewCoverage() {
  const generation = ++reviewCoverageRequestGeneration;
  try {
    const response = await fetch("/api/review-coverage", { cache: "no-store" });
    if (!response.ok) throw new Error("review coverage returned " + response.status);
    const payload = await response.json();
    if (generation !== reviewCoverageRequestGeneration) return;
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
  const payload = lastReviewCoverage;
  if (!payload || payload.ok !== true) {
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
  const fleets = Array.isArray(payload.fleets) ? payload.fleets : [];
  if (!fleets.length) {
    target.innerHTML = '<div class="empty">No canonical item records yet. Coverage appears after the first hydrated review sweep.</div>';
    return;
  }
  const ordered = [...fleets].sort((left, right) => (left.coverage_percent ?? 101) - (right.coverage_percent ?? 101));
  target.innerHTML = '<div class="coverage-fleets">' + ordered.map(fleet => {
    const percent = fleet.coverage_percent;
    const band = coverageBand(percent);
    const flags =
      (fleet.stale ? '<span class="coverage-flag stale">' + fmt.format(fleet.stale) + ' stale</span>' : '') +
      (fleet.failed ? '<span class="coverage-flag failed">' + fmt.format(fleet.failed) + ' failed</span>' : '') +
      (fleet.expired ? '<span class="coverage-flag stale">' + fmt.format(fleet.expired) + ' expired</span>' : '') +
      (fleet.untracked_open ? '<span class="coverage-flag">' + fmt.format(fleet.untracked_open) + ' never reviewed</span>' : '') +
      (fleet.excluded ? '<span class="coverage-flag">' + fmt.format(fleet.excluded) + ' protected</span>' : '') +
      (fleet.unschedulable_records ? '<span class="coverage-flag">' + fmt.format(fleet.unschedulable_records) + ' unmanaged records</span>' : '') +
      (fleet.pending ? '<span class="coverage-flag">' + fmt.format(fleet.pending) + ' pending</span>' : '');
    return '<div class="coverage-fleet">' +
      '<div class="coverage-fleet-name"><strong>' + esc(fleet.repo) + '</strong><span>' +
        (fleet.schedulable === false
          ? fmt.format(fleet.tracked_records || 0) + ' canonical records outside the current fleet'
          : fmt.format(fleet.reviewed_recent || 0) + ' of ' + fmt.format(fleet.reviewable_records || 0) + ' reviewable open items reviewed') +
      '</span></div>' +
      '<div><div class="coverage-bar ' + band + '"><i style="width:' + Math.max(0, Math.min(100, percent ?? 0)) + '%"></i></div></div>' +
      '<div class="coverage-value"><strong>' + (percent == null ? "n/a" : percent + "%") + '</strong>' +
      (flags ? '<span class="coverage-flags">' + flags + '</span>' : '<span>fully current</span>') +
      '</div></div>';
  }).join("") + '</div>';
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
  if (lastReviewCoverage?.ok === true) {
    const coverage = lastReviewCoverage.totals?.coverage_percent;
    const stale = Number(lastReviewCoverage.totals?.stale || 0);
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
    const payload = await response.json();
    if (requestedRange !== activeHealthRange) return;
    healthHistorySamples = Array.isArray(payload.samples) ? payload.samples : [];
    healthHistoryLoadedAt = Date.now();
  } catch {
    if (requestedRange !== activeHealthRange) return;
    healthHistorySamples = [];
  }
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
  return compactText(worker.workflow_title || worker.name);
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
  workerIndex = new Map(rows.map(worker => [String(worker.id), worker]));
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
    const progress = worker.progress?.total ? Math.round((worker.progress.completed / worker.progress.total) * 100) : 0;
    const kind = workerKindLabel(worker.work_kind);
    const targetTitle = workerTargetTitle(worker);
    return '<button type="button" class="worker-row" data-worker-id="' + esc(worker.id) + '" aria-label="Open details for ' + esc(targetTitle || worker.name) + '">' +
      '<div class="worker-row-main">' +
      '<i class="status-dot ' + workerStatusClass(worker.status) + '"></i>' +
      '<span class="pill">' + esc(modeLabel(worker.mode)) + (kind ? " · " + esc(kind) : "") + '</span>' +
      '<strong class="worker-name" title="' + esc(worker.name) + '">' + esc(worker.name) + '</strong>' +
      '<span class="worker-step">' + esc(worker.current_step || worker.stage) + '</span>' +
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
function renderAutomaticWork(rows) {
  automaticIndex = new Map(rows.map(row => [String(row.id), row]));
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
    rows.map(row => {
      const phase = compactText(row.phase || row.status || "queued").replaceAll("_", " ");
      return '<button type="button" class="worker-row automatic-row" data-automatic-id="' + esc(row.id) +
        '" aria-label="Open automatic build details for ' + esc(row.title) + '">' +
        '<div class="worker-row-main">' +
        '<i class="status-dot ' + workerStatusClass(row.status) + '"></i>' +
        '<span class="pill">' + esc(phase) + '</span>' +
        '<strong class="worker-name">' + esc(row.title || "Issue #" + row.issue_number) + '</strong>' +
        '<span class="worker-time mono">' + esc(row.updated_at ? since(row.updated_at) : "") + '</span>' +
        '</div>' +
        '<div class="worker-row-sub">' +
        '<span class="worker-target-ref mono">' + esc(row.repository + "#" + row.issue_number) + '</span>' +
        '<span class="worker-target-title">' + esc(row.pr_url ? "PR opened" : row.active ? "worker active" : row.status) + '</span>' +
        '</div>' +
        '</button>';
    }).join("") +
    '</div>';
}
function renderWorkerDialog(worker) {
  const dialog = document.getElementById("worker-dialog");
  const statusClass = workerStatusClass(worker.status);
  document.getElementById("worker-dialog-heading").innerHTML = '<div><span class="pill"><i class="status-dot ' + statusClass + '"></i>' + esc(worker.status) + '</span> <span class="pill">' + esc(modeLabel(worker.mode)) + '</span></div><h3 id="worker-dialog-title">' + esc(worker.name) + '</h3><div class="muted">' + esc(compactText(worker.workflow_title)) + '</div>';
  const targetItems = new Map((worker.target_items || []).map(target => [Number(target.number), target]));
  const targetUrls = worker.repository
    ? (worker.item_numbers || (worker.item_number ? [worker.item_number] : [])).map(number => ({
        url: targetItems.get(Number(number))?.url || "https://github.com/" + worker.repository + "/" + (worker.work_kind === "pr_repair" ? "pull" : "issues") + "/" + number,
        label: "#" + number + (targetItems.get(Number(number))?.title ? " · " + compactText(targetItems.get(Number(number)).title) : "")
      }))
    : [];
  const stepRows = (worker.steps || []).map(step => '<li class="step-row ' + esc(step.status) + '"><i class="step-mark"></i><strong>' + esc(step.name) + '</strong><span>' + esc(step.conclusion || step.status) + '</span></li>').join("");
  document.getElementById("worker-dialog-body").innerHTML =
    '<div class="drawer-grid">' +
      '<div class="drawer-stat"><span>Current step</span><strong>' + esc(worker.current_step || worker.stage) + '</strong></div>' +
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
  history.replaceState(null, "", "#worker-" + encodeURIComponent(worker.id));
}
function renderAutomaticDialog(row) {
  const dialog = document.getElementById("worker-dialog");
  const phase = compactText(row.phase || row.status || "queued").replaceAll("_", " ");
  document.getElementById("worker-dialog-heading").innerHTML =
    '<div><span class="pill"><i class="status-dot ' + workerStatusClass(row.status) + '"></i>' +
    esc(row.status) + '</span> <span class="pill">Automatic issue build</span></div>' +
    '<h3 id="worker-dialog-title">' + esc(row.title) + '</h3>' +
    '<div class="muted">' + esc(row.repository + "#" + row.issue_number) + '</div>';
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
      '<div class="drawer-stat"><span>Source</span><strong>' + esc(row.repository + "#" + row.issue_number) + '</strong></div>' +
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
  history.replaceState(null, "", "#automatic-" + encodeURIComponent(row.id));
}
function closeWorkerDialog() {
  const dialog = document.getElementById("worker-dialog");
  if (dialog.open) dialog.close();
  if (location.hash.startsWith("#worker-") || location.hash.startsWith("#automatic-")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
}
function openWorkerFromHash() {
  if (location.hash.startsWith("#worker-")) {
    const worker = workerIndex.get(decodeURIComponent(location.hash.slice(8)));
    if (worker) renderWorkerDialog(worker);
    else if (document.getElementById("worker-dialog").open) closeWorkerDialog();
  } else if (location.hash.startsWith("#automatic-")) {
    const row = automaticIndex.get(decodeURIComponent(location.hash.slice(11)));
    if (row) renderAutomaticDialog(row);
    else if (document.getElementById("worker-dialog").open) closeWorkerDialog();
  }
}

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
  const repoCount = (data.source.target_repositories || []).length;
  document.getElementById("hero-dot").className = "hero-dot " + (severity === "green" ? "ok" : severity);
  document.getElementById("hero-headline").textContent =
    (needsAttention ? "Needs attention" : "All clear") + " — " +
    fmt.format(workerCount) + " claw worker" + (workerCount === 1 ? "" : "s") + " sweeping " +
    fmt.format(repoCount) + " " + (repoCount === 1 ? "repository" : "repositories");
  document.getElementById("subtitle").textContent = data.source.target_repositories.join(", ");
  document.getElementById("updated").textContent = "Updated " + since(data.generated_at) + (note ? " \u00b7 " + note : "");
  const fleet = data.fleet;
  document.getElementById("metrics").innerHTML = [
    metric("Codex Workers", fmt.format(fleet.active_codex_jobs), "Codex budget " + fleet.worker_budget, fleet.budget_used_percent, "var(--green)"),
    metric("Error Rate", (data.health?.error_rate_percent || 0) + "%", fmt.format(data.health?.failed_attempts || 0) + " failed / " + fmt.format(data.health?.attempts || 0) + " attempts", Math.min(100, data.health?.error_rate_percent || 0), data.health?.failed_attempts ? "var(--red)" : "var(--green)"),
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
  const params = new URLSearchParams({ range: activeAutomergeRange });
  const repo = document.getElementById("automerge-repo").value;
  const policy = document.getElementById("automerge-policy").value;
  if (repo) params.set("repo", repo);
  if (policy) params.set("policy_version", policy);
  const response = await fetch("/api/automerge-metrics?" + params.toString(), { cache: "no-store" });
  if (!response.ok) throw new Error("automerge metrics returned " + response.status);
  const metrics = await response.json();
  if (generation !== automergeMetricsRequestGeneration) return;
  lastAutomergeMetrics = metrics;
  renderAutomergeProduct(lastAutomergeMetrics);
}
function renderAutomergeProduct(data) {
  const summary = data.summary || {};
  const setOptions = (id, values, selected) => {
    const select = document.getElementById(id);
    select.innerHTML = '<option value="">All</option>' + (values || []).map(value => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(value) + '</option>').join("");
  };
  setOptions("automerge-repo", data.filters?.repositories, data.filters?.repo);
  setOptions("automerge-policy", data.filters?.policy_versions, data.filters?.policy_version);
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
  const outcomeLabels = { merged: "Merged", repair_failed: "Repair workflow failed", maintainer_stopped: "Maintainer stopped", repair_cap_exhausted: "Repair cap exhausted", pr_closed: "PR closed", automerge_disabled: "Automerge disabled" };
  const outcomes = Object.entries(outcomeLabels).map(entry => '<div class="automerge-detail-row"><span>' + esc(entry[1]) + '</span><strong>' + fmt.format(data.terminal_outcomes?.[entry[0]] || 0) + '</strong></div>').join("");
  const efficiency = [['0 base sync sessions', data.repair_efficiency?.zero_base_sync], ['1 base sync session', data.repair_efficiency?.one_base_sync], ['2+ base sync sessions', data.repair_efficiency?.multiple_base_sync], ['Multi-rebase rate', value(summary.multi_rebase_rate_percent, "%")]].map(entry => '<div class="automerge-detail-row"><span>' + esc(entry[0]) + '</span><strong>' + esc(entry[1] ?? 0) + '</strong></div>').join("");
  const details = '<div class="automerge-details"><div><h3>Terminal outcomes</h3>' + outcomes + '</div><div><h3>Repair efficiency</h3>' + efficiency + '</div></div>';
  const rows = (data.sessions || []).map(session => '<tr><td>' + linkClass(session.pr_url, session.repository + '#' + session.item_number, "item-link") + '</td><td>' + esc(outcomeLabels[session.state] || session.state || 'unknown') + '</td><td>' + esc(session.policy_version) + '</td><td>' + esc(session.activated_at ? since(session.activated_at) : 'missing') + '</td><td>' + esc(session.terminal_at ? since(session.terminal_at) : since(session.last_event_at)) + '</td><td>' + fmt.format(session.base_sync_count || 0) + '</td><td>' + fmt.format(session.repairs || 0) + '</td><td>' + esc(session.last_reason || '') + ' ' + linkClass(session.run_url, 'run', 'pill run-link') + '</td></tr>').join("");
  const sessions = '<div class="automerge-sessions"><div class="automerge-sessions-head"><h3>Recent automerge sessions</h3><span>Showing up to 30 latest sessions in the selected window</span></div><table class="automerge-table"><thead><tr><th>PR</th><th>State</th><th>Policy</th><th>Activated</th><th>Terminal / age</th><th>Syncs</th><th>Repairs</th><th>Last reason</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8" class="muted">No session telemetry in this range.</td></tr>') + '</tbody></table></div>';
  document.getElementById("automerge-product").innerHTML = kpis + chart + details + sessions;
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
document.getElementById("automerge-repo").addEventListener("change", () => loadAutomergeMetrics().catch(() => undefined));
document.getElementById("automerge-policy").addEventListener("change", () => loadAutomergeMetrics().catch(() => undefined));
document.getElementById("workers").addEventListener("click", event => {
  const button = event.target.closest("button[data-worker-id]");
  if (!button) return;
  const worker = workerIndex.get(String(button.dataset.workerId));
  if (worker) renderWorkerDialog(worker);
});
document.getElementById("automatic-work").addEventListener("click", event => {
  const button = event.target.closest("button[data-automatic-id]");
  if (!button) return;
  const row = automaticIndex.get(String(button.dataset.automaticId));
  if (row) renderAutomaticDialog(row);
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
    if (worker) renderWorkerDialog(worker);
    return;
  }
  if (event.target === event.currentTarget) closeWorkerDialog();
});
document.getElementById("worker-dialog").addEventListener("close", () => {
  if (location.hash.startsWith("#worker-") || location.hash.startsWith("#automatic-")) {
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
