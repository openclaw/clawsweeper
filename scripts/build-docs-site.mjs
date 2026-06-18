#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { socialCardPng } from "./social-card.mjs";

const root = process.cwd();
const docsDir = path.join(root, "docs");
const outDir = path.join(root, "dist", "docs-site");
const repoUrl = "https://github.com/openclaw/clawsweeper";
const repoEditBase = `${repoUrl}/edit/main/docs`;
const customDomain = "clawsweeper.bot";

const sections = [
  ["Start", ["scheduler.md", "work-lane.md"]],
  [
    "Lanes",
    [
      "commit-sweeper.md",
      "commit-dispatcher.md",
      "target-dispatcher.md",
      "pr-review-comments.md",
      "openclaw-event-hooks.md",
    ],
  ],
  [
    "Repair",
    [
      "repair/README.md",
      "repair/operations.md",
      "repair/auto-update-prs.md",
      "repair/automerge-flow.md",
      "repair/internal-features.md",
    ],
  ],
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const pages = allMarkdown(docsDir).map((file) => {
  const rel = path.relative(docsDir, file).replaceAll(path.sep, "/");
  const markdown = fs.readFileSync(file, "utf8");
  const title = firstHeading(markdown) || titleize(path.basename(rel, ".md"));
  return { file, rel, title, outRel: outPath(rel), markdown, synthetic: false };
});

const homePage = {
  file: null,
  rel: "__home",
  title: "ClawSweeper",
  outRel: "index.html",
  markdown: "",
  synthetic: true,
};
pages.unshift(homePage);

const pageMap = new Map(pages.map((page) => [page.rel, page]));
const nav = sections
  .map(([name, rels]) => ({
    name,
    pages: rels.map((rel) => pageMap.get(rel)).filter(Boolean),
  }))
  .filter((section) => section.pages.length);

const sectionByRel = new Map();
for (const section of nav)
  for (const page of section.pages) sectionByRel.set(page.rel, section.name);
const orderedPages = [homePage, ...nav.flatMap((s) => s.pages)];

for (const page of pages) {
  const html = page.synthetic ? "" : markdownToHtml(page.markdown, page.rel);
  const toc = page.synthetic ? "" : tocFromHtml(html);
  const idx = orderedPages.findIndex((p) => p.rel === page.rel);
  const prev = idx > 0 ? orderedPages[idx - 1] : null;
  const next = idx >= 0 && idx < orderedPages.length - 1 ? orderedPages[idx + 1] : null;
  const sectionName = sectionByRel.get(page.rel) || "Docs";
  const pageOut = path.join(outDir, page.outRel);
  fs.mkdirSync(path.dirname(pageOut), { recursive: true });
  fs.writeFileSync(pageOut, layout({ page, html, toc, prev, next, sectionName }), "utf8");
}

fs.writeFileSync(path.join(outDir, "clawsweeper.svg"), clawSvg(), "utf8");
fs.writeFileSync(path.join(outDir, "favicon.svg"), faviconSvg(), "utf8");
fs.writeFileSync(path.join(outDir, "social-card.png"), socialCardPng());
fs.writeFileSync(path.join(outDir, ".nojekyll"), "", "utf8");
fs.writeFileSync(path.join(outDir, "CNAME"), `${customDomain}\n`, "utf8");
fs.writeFileSync(
  path.join(outDir, "robots.txt"),
  `User-agent: *\nAllow: /\nSitemap: https://${customDomain}/sitemap.xml\n`,
  "utf8",
);
fs.writeFileSync(path.join(outDir, "sitemap.xml"), sitemap(orderedPages), "utf8");
fs.writeFileSync(path.join(outDir, "llms.txt"), llmsTxt(), "utf8");
console.log(`built docs site: ${path.relative(root, outDir)} (${pages.length} pages)`);

function llmsTxt() {
  const origin = docsOrigin();
  const source = docsSourceUrl();
  const name = typeof productName !== "undefined" ? productName : path.basename(root);
  const description =
    typeof productDescription !== "undefined" ? productDescription : `${name} documentation index.`;
  const install = docsInstallHint();
  const docPages = docsLlmsPages().map(
    (page) => `- ${page.title}: ${pageUrl(origin, page.outRel)}`,
  );
  const lines = [`# ${name}`, "", description, "", "Canonical documentation:", ...docPages];
  if (install) {
    lines.push("", "Install:", `- ${install}`);
  }
  if (source) {
    lines.push("", `Source: ${source}`);
  }
  lines.push(
    "",
    "Guidance for agents:",
    "- Prefer the canonical documentation URLs above over README excerpts or package metadata.",
    "- Fetch only the pages needed for the current task; this is an index, not a full-site corpus.",
  );
  return `${lines.join("\n")}\n`;
}

function docsLlmsPages() {
  const seen = new Set();
  const ordered = typeof orderedPages !== "undefined" ? orderedPages : [];
  return [...ordered, ...pages].filter(
    (page) => page.outRel && !seen.has(page.outRel) && seen.add(page.outRel),
  );
}

function docsOrigin() {
  const value =
    (typeof siteBase !== "undefined" && siteBase) ||
    (typeof siteUrl !== "undefined" && siteUrl) ||
    (typeof customDomain !== "undefined" && customDomain ? `https://${customDomain}` : "");
  return value.replace(/\/$/, "");
}

function docsSourceUrl() {
  if (typeof repoBase !== "undefined") return repoBase;
  if (typeof repoUrl !== "undefined") return repoUrl;
  if (typeof repoEditBase !== "undefined")
    return repoEditBase.replace(/\/edit\/main\/docs\/?$/, "");
  return "";
}

function docsInstallHint() {
  if (typeof installCommand !== "undefined") return installCommand;
  if (typeof installLine !== "undefined") return installLine;
  if (typeof installCmd !== "undefined") return installCmd;
  if (typeof installSnippet !== "undefined") return installSnippet;
  if (typeof brewInstall !== "undefined") return brewInstall;
  return "";
}

function pageUrl(origin, outRel) {
  const normalized =
    outRel === "index.html"
      ? ""
      : outRel.replace(/(?:^|\/)index\.html$/, (match) => (match === "index.html" ? "" : "/"));
  if (!origin) return normalized || "index.html";
  return normalized ? `${origin}/${normalized}` : `${origin}/`;
}

function allMarkdown(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return allMarkdown(full);
      return entry.name.endsWith(".md") ? [full] : [];
    })
    .sort();
}

function outPath(rel) {
  if (rel === "README.md") return "index.html";
  if (rel.endsWith("/README.md")) return rel.replace(/README\.md$/, "index.html");
  return rel.replace(/\.md$/, ".html");
}

function firstHeading(markdown) {
  return markdown
    .match(/^#\s+(.+)$/m)?.[1]
    ?.trim()
    .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s+/u, "");
}

function titleize(input) {
  return input.replaceAll("-", " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function markdownToHtml(markdown, currentRel) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let fence = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(" "), currentRel)}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    html.push(`</${list}>`);
    list = null;
  };
  const splitRow = (line) =>
    line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((s) => s.trim());
  const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("<img ")) {
      flushParagraph();
      closeList();
      continue;
    }
    const fenceMatch = line.match(/^```(\w+)?\s*$/);
    if (fenceMatch) {
      flushParagraph();
      closeList();
      if (fence) {
        html.push(
          `<pre><code class="language-${fence.lang}">${escapeHtml(fence.lines.join("\n"))}</code></pre>`,
        );
        fence = null;
      } else {
        fence = { lang: fenceMatch[1] || "text", lines: [] };
      }
      continue;
    }
    if (fence) {
      fence.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      const text = heading[2].trim().replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s+/u, "");
      const id = slug(text);
      const inner = inline(text, currentRel);
      if (level === 1) {
        html.push(`<h1 id="${id}">${inner}</h1>`);
      } else {
        html.push(
          `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="Anchor link">#</a>${inner}</h${level}>`,
        );
      }
      continue;
    }
    if (
      line.trimStart().startsWith("|") &&
      line.includes("|", line.indexOf("|") + 1) &&
      isDivider(lines[i + 1] || "")
    ) {
      flushParagraph();
      closeList();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return right && left ? "center" : right ? "right" : left ? "left" : "";
      });
      i += 1;
      const rows = [];
      while (i + 1 < lines.length && lines[i + 1].trimStart().startsWith("|")) {
        i += 1;
        rows.push(splitRow(lines[i]));
      }
      const th = header
        .map(
          (c, idx) =>
            `<th${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${inline(c, currentRel)}</th>`,
        )
        .join("");
      const tb = rows
        .map(
          (r) =>
            `<tr>${r.map((c, idx) => `<td${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${inline(c, currentRel)}</td>`).join("")}</tr>`,
        )
        .join("");
      html.push(`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`);
      continue;
    }
    const blockquote = line.match(/^>\s?(.*)$/);
    if (blockquote) {
      flushParagraph();
      closeList();
      const buf = [blockquote[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) {
        i += 1;
        buf.push(lines[i].replace(/^>\s?/, ""));
      }
      html.push(`<blockquote><p>${inline(buf.join(" "), currentRel)}</p></blockquote>`);
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.+)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list !== tag) closeList();
      if (!list) {
        list = tag;
        html.push(`<${tag}>`);
      }
      html.push(`<li>${inline((bullet || numbered)[1], currentRel)}</li>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  return html.join("\n");
}

function inline(text, currentRel) {
  const stash = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    stash.push(`<code>${escapeHtml(code)}</code>`);
    return `@@CODE${stash.length - 1}@@`;
  });
  out = escapeHtml(out)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, label, href) => `<a href="${escapeAttr(rewriteHref(href, currentRel))}">${label}</a>`,
    );
  return out.replace(/@@CODE(\d+)@@/g, (_, i) => stash[Number(i)]);
}

function rewriteHref(href, currentRel) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const [raw, hash = ""] = href.split("#");
  if (!raw) return `#${hash}`;
  if (!raw.endsWith(".md")) return href;
  const from = path.posix.dirname(currentRel);
  const target = path.posix.normalize(path.posix.join(from, raw));
  let rewritten = outPath(target);
  const currentOut = outPath(currentRel);
  rewritten = path.posix.relative(path.posix.dirname(currentOut), rewritten) || "index.html";
  return `${rewritten}${hash ? `#${hash}` : ""}`;
}

function tocFromHtml(html) {
  const items = [];
  const re = /<h([23]) id="([^"]+)">([\s\S]*?)<\/h[23]>/g;
  let m;
  while ((m = re.exec(html))) {
    const text = textFromHtml(m[3]).trim();
    items.push({ level: Number(m[1]), id: m[2], text });
  }
  if (items.length < 2) return "";
  return `<nav class="toc" aria-label="On this page"><h2>On this page</h2>${items
    .map((i) => `<a class="toc-l${i.level}" href="#${i.id}">${escapeHtml(i.text)}</a>`)
    .join("")}</nav>`;
}

function textFromHtml(html) {
  let text = "";
  let inTag = false;
  for (const char of html) {
    if (char === "<") {
      inTag = true;
      continue;
    }
    if (char === ">") {
      inTag = false;
      continue;
    }
    if (!inTag) text += char;
  }
  return text;
}

function layout({ page, html, toc, prev, next, sectionName }) {
  const depth = page.outRel.split("/").length - 1;
  const rootPrefix = depth ? "../".repeat(depth) : "";
  const editUrl = page.synthetic ? "" : `${repoEditBase}/${page.rel}`;
  const isHome = page.synthetic;
  const prevNext = !isHome && (prev || next) ? pageNavHtml(prev, next, rootPrefix) : "";
  const heroBlock = isHome ? landingHero(rootPrefix) : standardHero(page, sectionName, editUrl);
  const articleBlock = isHome ? landingBody() : `<article class="doc">${html}${prevNext}</article>`;
  const tocBlock = isHome ? "" : toc;
  const description = isHome
    ? "ClawSweeper is the conservative maintenance bot for OpenClaw repositories. It reviews issues, pull requests, and commits — and only acts when the evidence is strong."
    : `${page.title} - ClawSweeper docs`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(page.title)}${isHome ? " - Conservative maintenance bot" : " - ClawSweeper Docs"}</title>
  <meta name="description" content="${escapeAttr(description)}">
  <meta name="theme-color" content="#f4ead7">
  <meta property="og:title" content="${escapeAttr(page.title)}${isHome ? " - ClawSweeper" : " - ClawSweeper docs"}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://${customDomain}/${page.outRel === "index.html" ? "" : page.outRel}">
  <meta property="og:image" content="https://${customDomain}/social-card.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="ClawSweeper: conservative OpenClaw maintenance bot">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://${customDomain}/social-card.png">
  <meta name="twitter:image:alt" content="ClawSweeper: conservative OpenClaw maintenance bot">
  <link rel="icon" type="image/svg+xml" href="${rootPrefix}favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,500;0,600;0,700;1,500&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  ${themeInitScript()}
  <style>${css()}</style>
</head>
<body${isHome ? ' class="home"' : ""}>
  <button class="nav-toggle" type="button" aria-label="Toggle navigation" aria-expanded="false">
    <span></span><span></span><span></span>
  </button>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="${rootPrefix}index.html" aria-label="ClawSweeper docs home">
        <img src="${rootPrefix}clawsweeper.svg" alt="">
        <span><strong>ClawSweeper</strong><small>Conservative maintenance bot</small></span>
      </a>
      <label class="search"><span>Search docs</span><input id="doc-search" type="search" placeholder="commits, repair, dispatch"></label>
      <nav>${navHtml(page.rel, rootPrefix)}</nav>
      <div class="sidebar-foot">
        <div class="theme-control" aria-label="Theme">
          <span>Theme</span>
          <div class="theme-options" role="group" aria-label="Theme preference">
            <button type="button" data-theme-choice="system" aria-pressed="true">System</button>
            <button type="button" data-theme-choice="light" aria-pressed="false">Light</button>
            <button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>
          </div>
        </div>
        <div class="sidebar-links">
          <a href="${repoUrl}" rel="noopener">GitHub</a>
          <span>·</span>
          <a href="${repoUrl}/issues" rel="noopener">Issues</a>
        </div>
      </div>
    </aside>
    <main>
      ${heroBlock}
      <div class="doc-grid${isHome ? " doc-grid-home" : ""}">
        ${articleBlock}
        ${tocBlock}
      </div>
      <footer class="page-foot">
        <span>ClawSweeper - one of the <a href="https://github.com/openclaw" rel="noopener">OpenClaw</a> tools</span>
        <span>${escapeHtml(new Date().toISOString().slice(0, 10))} - <a href="${repoUrl}" rel="noopener">source</a></span>
      </footer>
    </main>
  </div>
  <script>${js()}</script>
</body>
</html>`;
}

function standardHero(page, sectionName, editUrl) {
  return `<header class="hero">
        <div class="hero-text">
          <p class="eyebrow">${escapeHtml(sectionName)}</p>
          <h1>${escapeHtml(page.title)}</h1>
        </div>
        <div class="hero-meta">
          <a class="repo" href="${repoUrl}" rel="noopener">GitHub</a>
          <a class="edit" href="${escapeAttr(editUrl)}" rel="noopener">Edit page</a>
        </div>
      </header>`;
}

function landingHero(rootPrefix) {
  return `<header class="hero hero-home">
        <div class="hero-text">
          <p class="eyebrow">OpenClaw - maintenance bot</p>
          <h1>Sideways through the <em>backlog</em>.<br>Sweep what's safe.<br>Leave the rest.</h1>
          <p class="lede">ClawSweeper is the conservative maintenance bot for OpenClaw. It reviews issues, pull requests, and code-bearing commits; keeps one durable public comment per item; and turns narrow trusted findings into guarded repair or automerge work.</p>
          <div class="cta">
            <a class="cta-primary" href="${rootPrefix}scheduler.html">Read the docs</a>
            <a class="cta-secondary" href="${repoUrl}" rel="noopener">View on GitHub</a>
          </div>
          <p class="cta-foot">No closes without evidence. No autocomments without a marker. No mutations without an audit.</p>
        </div>
        <div class="hero-art" aria-hidden="true">
          ${heroCrab()}
        </div>
      </header>`;
}

function landingBody() {
  const features = [
    [
      "One report per item",
      "Every reviewed issue and PR becomes <code>records/&lt;repo&gt;/items/&lt;n&gt;.md</code>: decision, evidence, proposed comment, runtime metadata, and snapshot hash.",
      "report",
    ],
    [
      "Durable review comments",
      "ClawSweeper edits a single marker-backed comment per item instead of stacking new ones. Maintainers get one source of truth, not noise.",
      "comment",
    ],
    [
      "Conservative apply",
      "A close is only proposed when the item is implemented, unreproducible, duplicate, incoherent, or obviously stale. Maintainer-authored stays open.",
      "shield",
    ],
    [
      "Four operational lanes",
      "Review, apply, repair, and commit review run as separate lanes. Each lane has its own state, gates, and GitHub Actions path.",
      "lanes",
    ],
    [
      "Targeted dispatch",
      "Target repos forward <code>repository_dispatch</code> for low-latency single-item review or commit-range review without polling.",
      "bolt",
    ],
    [
      "Repair, gated",
      "Opted-in PRs can run through review, fix, re-review, and merge. Strict reproducible bug issues can open one guarded generated PR.",
      "wrench",
    ],
  ];
  const cards = features
    .map(
      ([title, body, icon]) =>
        `<article class="feature"><div class="feature-icon">${featureIcon(icon)}</div><h3>${escapeHtml(title)}</h3><p>${body}</p></article>`,
    )
    .join("");

  const lanes = [
    {
      name: "Review Lane",
      href: "scheduler.html",
      desc: "Scheduled and event-driven issue/PR reviews. Planner paths: exact event, hot intake, normal backfill.",
    },
    {
      name: "Apply Lane",
      href: "scheduler.html#apply-lane",
      desc: "Guarded comment and close mutations. Re-fetches live GitHub state before every write.",
    },
    {
      name: "Repair Lane",
      href: "repair/",
      desc: 'Bounded "review, fix, re-review, merge" loop for opted-in PRs and strict generated bug PRs.',
    },
    {
      name: "Commit Review Lane",
      href: "commit-sweeper.html",
      desc: "Reviews code-bearing commits on <code>main</code>. Skips non-code commits cheaply. Optional Check Runs.",
    },
  ];
  const laneCards = lanes
    .map(
      (l) =>
        `<a class="lane" href="${l.href}"><span class="lane-arrow">-&gt;</span><h3>${l.name}</h3><p>${l.desc}</p></a>`,
    )
    .join("");

  return `<article class="doc doc-home">
        <section class="features-row" aria-label="What ClawSweeper does">${cards}</section>
        <section class="snippet-row" aria-label="What a sweep looks like">
          <div class="snippet-text">
            <p class="eyebrow">A sweep, in motion</p>
            <h2>Read, write, propose. Never the other way round.</h2>
            <p>ClawSweeper does not act on raw model output. Every decision lands in the report repo first; every comment is gated by a marker; every mutation is replayed against live GitHub state before the API call.</p>
            <ul class="snippet-list">
              <li><strong>Read</strong> - GitHub snapshot, prior report, repository profile, paired issue/PR state.</li>
              <li><strong>Write</strong> - one markdown report per item or commit, with a hashed snapshot.</li>
            <li><strong>Act</strong> - one durable comment, guarded apply, and repair only through explicit trusted gates.</li>
            </ul>
          </div>
          <pre class="snippet" aria-hidden="true"><code><span class="prompt">$</span> pnpm run plan -- --target-repo openclaw/openclaw --shard-count 100
<span class="comment"># exact item numbers selected for review shards</span>
<span class="prompt">$</span> pnpm run review -- --target-repo openclaw/openclaw --artifact-dir artifacts/reviews
<span class="comment"># records/openclaw-openclaw/items/812.md</span>
<span class="comment"># durable comment marker: clawsweeper:review</span>
<span class="prompt">$</span> pnpm run apply-decisions -- --target-repo openclaw/openclaw --limit 20
<span class="comment"># guarded close/comment mutations only after live re-fetch</span>
<span class="prompt">$</span> pnpm commit-reports -- --since 24h --findings
<span class="comment"># 6 commits reviewed - 1 finding (non-security)</span>
<span class="comment"># dispatched to repair intake</span></code></pre>
        </section>
        <section class="lanes-row" aria-label="The lanes">
          <h2>Four lanes, one engine</h2>
          <div class="lanes">${laneCards}</div>
        </section>
        <section class="rules" aria-label="Guardrails">
          <h2>Guardrails</h2>
          <p class="lede small">A close is allowed only when the item is clearly one of these. Maintainer-authored items are never auto-closed.</p>
          <ul class="rules-list">
            <li>Implemented on current <code>main</code></li>
            <li>Not reproducible on current <code>main</code></li>
            <li>Better suited for ClawHub skill / plugin work</li>
            <li>Duplicate or superseded by a canonical item</li>
            <li>Concrete but not actionable in this source repo</li>
            <li>Incoherent enough that no action can be taken</li>
            <li>Stale issue older than 60 days with too little data to verify</li>
          </ul>
        </section>
      </article>`;
}

function pageNavHtml(prev, next, rootPrefix) {
  const cell = (page, dir) => {
    if (!page) return "";
    return `<a class="page-nav-${dir}" href="${rootPrefix}${page.outRel}"><small>${dir === "prev" ? "Previous" : "Next"}</small><span>${escapeHtml(page.title)}</span></a>`;
  };
  return `<nav class="page-nav" aria-label="Pager">${cell(prev, "prev")}${cell(next, "next")}</nav>`;
}

function navHtml(currentRel, rootPrefix) {
  const homeActive = currentRel === "__home" ? " active" : "";
  const homeLink = `<section><h2>Home</h2><a class="nav-link${homeActive}" href="${rootPrefix}index.html">Overview</a></section>`;
  const sectionLinks = nav
    .map(
      (section) =>
        `<section><h2>${section.name}</h2>${section.pages
          .map((page) => {
            const href = rootPrefix + page.outRel;
            const active = page.rel === currentRel ? " active" : "";
            return `<a class="nav-link${active}" href="${href}">${escapeHtml(page.title)}</a>`;
          })
          .join("")}</section>`,
    )
    .join("");
  return homeLink + sectionLinks;
}

function sitemap(pages) {
  const urls = pages
    .map((p) => {
      const path = p.outRel === "index.html" ? "" : p.outRel;
      return `  <url><loc>https://${customDomain}/${path}</loc></url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function themeInitScript() {
  return `<script>
(() => {
  const key = "clawsweeper-theme";
  const themes = new Set(["system", "light", "dark"]);
  const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
  const themeColor = { light: "#f4ead7", dark: "#081417" };
  let choice = "system";
  try {
    const saved = window.localStorage?.getItem(key);
    if (themes.has(saved)) choice = saved;
  } catch {}
  const active = choice === "system" && darkQuery?.matches ? "dark" : choice === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = active;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[active]);
})();
</script>`;
}

function css() {
  return `
:root{
  --ink:#06181c;
  --paper:#fdf6e9;
  --shell:#f4ead7;
  --reef:#0b3a3f;
  --tide:#0a6a72;
  --kelp:#13848e;
  --coral:#ec5b3c;
  --accent-text:#b6422d;
  --crab:#d9472b;
  --sun:#f4a93a;
  --sand:#e9d7b1;
  --line:#dccfb6;
  --line-soft:#ece1c8;
  --muted:#56625e;
  --code-bg:#0a1d20;
  --code-fg:#f1e3c8;
  --shadow:0 24px 60px -28px rgba(6,24,28,.35);
  --home-bg:linear-gradient(180deg,#fbf1de 0%,#f4ead7 38%,#ecdec0 100%);
  --page-glow:radial-gradient(800px 500px at 110% -10%,rgba(236,91,60,.08),transparent 60%),radial-gradient(700px 500px at -10% 110%,rgba(10,106,114,.10),transparent 60%);
  --sidebar-bg:rgba(253,246,233,.78);
  --sidebar-mobile-bg:var(--paper);
  --body-text:#293836;
  --body-text-soft:#3b4a48;
  --focus-ring:rgba(236,91,60,.20);
  --nav-hover-bg:rgba(236,91,60,.08);
  --nav-active-bg:#f0e0bf;
  --inline-code-bg:#f0e0bf;
  --inline-code-line:#e2cf9f;
  --feature-bg:rgba(253,246,233,.86);
  --feature-icon-bg:linear-gradient(135deg,#fbe2cf,#f4a93a55);
  --feature-hover-shadow:0 16px 30px -16px rgba(11,58,63,.25);
  --lane-bg:linear-gradient(180deg,rgba(253,246,233,.96),rgba(244,234,215,.6));
  --lane-hover-shadow:0 16px 30px -14px rgba(217,71,43,.22);
  --rules-bg:linear-gradient(135deg,rgba(11,58,63,.06),rgba(236,91,60,.04));
  --code-border:#06141660;
  --code-scroll:#3a4a47;
  --code-copy-bg:rgba(253,246,233,.06);
  --code-copy-line:rgba(253,246,233,.18);
  --code-copy-hover:rgba(253,246,233,.14);
  --code-comment:#7e948f;
  --blockquote-bg:#f3e3c5;
  --pager-shadow:0 6px 18px rgba(11,58,63,.10);
  --toggle-shadow:0 6px 18px rgba(6,24,28,.14);
  --sidebar-shadow:0 18px 40px rgba(6,24,28,.18);
  --art-shadow:drop-shadow(0 30px 50px rgba(217,71,43,.22));
  --brand-shadow:drop-shadow(0 4px 10px rgba(217,71,43,.25));
  --selected-shadow:0 1px 6px rgba(6,24,28,.10);
  --snippet-shadow:0 24px 50px -22px rgba(6,24,28,.4);
  --cta-shadow:0 8px 22px rgba(11,58,63,.3);
}
html[data-theme="dark"]{
  --ink:#edf4ed;
  --paper:#102023;
  --shell:#081417;
  --reef:#9ed4d1;
  --tide:#72d0d8;
  --kelp:#60c0aa;
  --coral:#ff7a5c;
  --accent-text:#ff8a70;
  --crab:#f05f42;
  --sun:#f5bf65;
  --sand:#594d37;
  --line:#314448;
  --line-soft:#23363a;
  --muted:#a6b8b4;
  --code-bg:#061013;
  --code-fg:#f6e5c8;
  --shadow:0 28px 70px -34px rgba(0,0,0,.86);
  --home-bg:linear-gradient(180deg,#09191c 0%,#0b171a 42%,#101b1d 100%);
  --page-glow:radial-gradient(800px 500px at 110% -10%,rgba(255,122,92,.12),transparent 62%),radial-gradient(700px 500px at -10% 110%,rgba(114,208,216,.10),transparent 60%);
  --sidebar-bg:rgba(11,25,28,.82);
  --sidebar-mobile-bg:#0d1b1e;
  --body-text:#d3dfdc;
  --body-text-soft:#c0cfcb;
  --focus-ring:rgba(255,122,92,.28);
  --nav-hover-bg:rgba(255,122,92,.13);
  --nav-active-bg:#213539;
  --inline-code-bg:#1b3032;
  --inline-code-line:#385054;
  --feature-bg:rgba(16,32,35,.88);
  --feature-icon-bg:linear-gradient(135deg,rgba(255,122,92,.24),rgba(245,191,101,.20));
  --feature-hover-shadow:0 18px 34px -20px rgba(0,0,0,.75);
  --lane-bg:linear-gradient(180deg,rgba(16,32,35,.96),rgba(10,22,25,.72));
  --lane-hover-shadow:0 18px 34px -20px rgba(0,0,0,.82);
  --rules-bg:linear-gradient(135deg,rgba(114,208,216,.10),rgba(255,122,92,.08));
  --code-border:#22383d;
  --code-scroll:#52686a;
  --code-copy-bg:rgba(246,229,200,.08);
  --code-copy-line:rgba(246,229,200,.22);
  --code-copy-hover:rgba(246,229,200,.15);
  --code-comment:#9eb3ad;
  --blockquote-bg:#1c2d2f;
  --pager-shadow:0 8px 22px rgba(0,0,0,.36);
  --toggle-shadow:0 8px 22px rgba(0,0,0,.38);
  --sidebar-shadow:0 18px 44px rgba(0,0,0,.54);
  --art-shadow:drop-shadow(0 30px 56px rgba(0,0,0,.45));
  --brand-shadow:drop-shadow(0 4px 10px rgba(255,122,92,.20));
  --selected-shadow:0 1px 8px rgba(0,0,0,.34);
  --snippet-shadow:0 24px 50px -22px rgba(0,0,0,.78);
  --cta-shadow:0 8px 22px rgba(0,0,0,.34);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:24px}
body{margin:0;background:var(--shell);color:var(--ink);font-family:Inter,"IBM Plex Sans",system-ui,sans-serif;line-height:1.65;overflow-x:hidden;-webkit-font-smoothing:antialiased;font-feature-settings:"ss01","cv11"}
body.home{background:var(--home-bg)}
body:before{content:"";position:fixed;inset:0;pointer-events:none;background:var(--page-glow);z-index:-1}
::selection{background:var(--coral);color:var(--paper)}
a{color:var(--tide);text-decoration-thickness:.07em;text-underline-offset:.18em;transition:color .15s}
a:hover{color:var(--accent-text)}
.shell{display:grid;grid-template-columns:288px minmax(0,1fr);min-height:100vh}

/* sidebar */
.sidebar{position:sticky;top:0;height:100vh;overflow:auto;padding:24px 20px 14px;background:var(--sidebar-bg);border-right:1px solid var(--line);backdrop-filter:blur(20px);scrollbar-width:thin;scrollbar-color:var(--line) transparent;display:flex;flex-direction:column}
.sidebar::-webkit-scrollbar{width:6px}
.sidebar::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px}
.brand{display:flex;align-items:center;gap:11px;color:var(--ink);text-decoration:none;margin-bottom:22px}
.brand img{width:46px;height:46px;filter:var(--brand-shadow)}
.brand strong{display:block;font-family:Fraunces,Georgia,serif;font-size:1.36rem;line-height:1;letter-spacing:-.005em;font-weight:700}
.brand small{display:block;color:var(--muted);font-size:.74rem;margin-top:5px;letter-spacing:.01em}
.search{display:block;margin:0 0 22px}
.search span{display:block;color:var(--muted);font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;margin-bottom:7px}
.search input{width:100%;border:1px solid var(--line);background:var(--paper);border-radius:9px;padding:10px 12px;font:inherit;font-size:.92rem;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
.search input:focus{border-color:var(--coral);box-shadow:0 0 0 3px var(--focus-ring)}
.theme-control{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:8px;color:var(--muted)}
.theme-control>span{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em}
.theme-options{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;border:1px solid var(--line-soft);background:transparent;border-radius:8px;padding:2px}
.theme-options button{appearance:none;border:0;border-radius:6px;background:transparent;color:var(--muted);font:700 .66rem/1 Inter,sans-serif;padding:5px 4px;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
.theme-options button:hover{color:var(--ink);background:var(--nav-hover-bg)}
.theme-options button:focus-visible{outline:0;box-shadow:0 0 0 3px var(--focus-ring)}
.theme-options button[aria-pressed="true"]{background:var(--paper);color:var(--ink);box-shadow:var(--selected-shadow)}
nav section{margin:0 0 18px}
nav h2{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.13em;margin:0 0 6px;font-weight:700}
.nav-link{display:block;color:var(--ink);text-decoration:none;border-radius:7px;padding:6px 10px;margin:1px 0;font-size:.91rem;line-height:1.4;border-left:2px solid transparent;transition:background .12s,color .12s}
.nav-link:hover{background:var(--nav-hover-bg);color:var(--reef)}
.nav-link.active{background:var(--nav-active-bg);color:var(--reef);border-left-color:var(--coral);font-weight:600}
.sidebar-foot{margin-top:auto;padding-top:12px;border-top:1px solid var(--line-soft);font-size:.78rem;color:var(--muted);display:grid;gap:10px}
.sidebar-links{display:flex;gap:8px;align-items:center}
.sidebar-foot a{color:var(--muted);text-decoration:none}
.sidebar-foot a:hover{color:var(--accent-text)}

/* main */
main{min-width:0;padding:28px clamp(20px,4.5vw,60px) 36px;max-width:1240px;margin:0 auto;width:100%;display:flex;flex-direction:column;min-height:100vh}
.page-foot{margin-top:auto;padding:24px 0 0;display:flex;justify-content:space-between;color:var(--muted);font-size:.8rem;flex-wrap:wrap;gap:8px;border-top:1px dashed var(--line);margin-top:48px}
.page-foot a{color:var(--muted)}
.page-foot a:hover{color:var(--accent-text)}

.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:22px;border-bottom:1px solid var(--line);padding:18px 0 22px;position:relative;flex-wrap:wrap}
.hero:after{content:"";position:absolute;left:0;bottom:-1px;width:96px;height:3px;background:linear-gradient(90deg,var(--coral),var(--sun),var(--kelp));border-radius:3px}
.hero-text{min-width:0;flex:1 1 320px}
.eyebrow{margin:0 0 8px;color:var(--accent-text);font-weight:700;text-transform:uppercase;letter-spacing:.14em;font-size:.72rem}
.hero h1{font-family:Fraunces,Georgia,serif;font-size:clamp(1.9rem,3.4vw,2.85rem);line-height:1.05;letter-spacing:-.005em;margin:0;font-weight:700;color:var(--ink)}
.hero-meta{display:flex;gap:8px;flex:0 0 auto}
.repo,.edit{border:1px solid var(--line);color:var(--ink);text-decoration:none;border-radius:9px;padding:7px 12px;font-weight:600;font-size:.84rem;background:var(--paper);transition:border-color .15s,color .15s}
.repo:hover,.edit:hover{border-color:var(--coral);color:var(--accent-text)}
.edit{color:var(--muted)}

/* landing hero */
.hero-home{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:48px;align-items:center;border-bottom:0;padding:24px 0 12px}
.hero-home:after{display:none}
.hero-home .eyebrow{margin-bottom:14px}
.hero-home h1{font-size:clamp(2.2rem,5vw,4rem);line-height:1.0;letter-spacing:-.018em;font-weight:700;margin:0 0 18px;max-width:18ch}
.hero-home h1 em{font-style:italic;color:var(--accent-text);font-weight:600}
.lede{margin:0 0 22px;color:var(--body-text);font-size:clamp(1rem,1.25vw,1.13rem);line-height:1.55;max-width:48ch}
.lede.small{font-size:.96rem;color:var(--body-text-soft)}
.lede code{background:var(--inline-code-bg);border:1px solid var(--inline-code-line);border-radius:5px;padding:.04em .3em;font-size:.86em}
.cta{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.cta-primary,.cta-secondary{display:inline-flex;align-items:center;border-radius:10px;padding:11px 18px;font-weight:600;font-size:.95rem;text-decoration:none;transition:transform .15s,box-shadow .15s,background .15s,border-color .15s,color .15s}
.cta-primary{background:var(--ink);color:var(--paper);border:1px solid var(--ink)}
.cta-primary:hover{background:var(--reef);border-color:var(--reef);color:var(--paper);transform:translateY(-1px);box-shadow:var(--cta-shadow)}
.cta-secondary{border:1px solid var(--ink);color:var(--ink);background:transparent}
.cta-secondary:hover{border-color:var(--coral);color:var(--accent-text);transform:translateY(-1px)}
.cta-foot{margin:6px 0 0;color:var(--muted);font-size:.84rem;font-style:italic}

.hero-art{position:relative;display:flex;align-items:center;justify-content:center;min-height:340px}
.hero-art svg{width:min(440px,90%);height:auto;filter:var(--art-shadow)}
html[data-theme="dark"] .hero-art svg [stroke="#0b3a3f"]{stroke:#123c43}
html[data-theme="dark"] .hero-art svg [fill="#06181c"]{fill:#081417}
.hero-art .crab-body{transform-origin:center;animation:sway 6s ease-in-out infinite}
.hero-art .claw-l{transform-origin:88px 142px;animation:snip-l 4s ease-in-out infinite}
.hero-art .claw-r{transform-origin:312px 142px;animation:snip-r 4s ease-in-out infinite}
.hero-art .bubble{animation:bubble 5s ease-in infinite;opacity:0}
.hero-art .bubble.b2{animation-delay:1.4s}
.hero-art .bubble.b3{animation-delay:2.8s}
@keyframes sway{0%,100%{transform:translateX(0) rotate(-1.2deg)}50%{transform:translateX(8px) rotate(1.2deg)}}
@keyframes snip-l{0%,40%,100%{transform:rotate(0deg)}20%{transform:rotate(-14deg)}}
@keyframes snip-r{0%,40%,100%{transform:rotate(0deg)}20%{transform:rotate(14deg)}}
@keyframes bubble{0%{opacity:0;transform:translateY(0) scale(.8)}30%{opacity:.7}100%{opacity:0;transform:translateY(-90px) scale(1.2)}}
@media(prefers-reduced-motion:reduce){.hero-art .crab-body,.hero-art .claw-l,.hero-art .claw-r,.hero-art .bubble{animation:none}}

/* feature cards on landing */
.features-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:42px 0 6px}
.feature{background:var(--feature-bg);border:1px solid var(--line-soft);border-radius:14px;padding:22px 22px 20px;transition:border-color .15s,transform .15s,box-shadow .15s;position:relative;overflow:hidden}
.feature:hover{border-color:var(--coral);transform:translateY(-2px);box-shadow:var(--feature-hover-shadow)}
.feature-icon{display:inline-flex;width:38px;height:38px;border-radius:10px;background:var(--feature-icon-bg);align-items:center;justify-content:center;margin-bottom:12px;color:var(--reef)}
.feature-icon svg{width:22px;height:22px}
.feature h3{font-family:Fraunces,Georgia,serif;font-size:1.12rem;margin:0 0 6px;font-weight:600;letter-spacing:-.005em;line-height:1.2}
.feature p{margin:0;color:var(--body-text);font-size:.94rem;line-height:1.55}
.feature code{font-size:.82em;background:var(--inline-code-bg);border:1px solid var(--inline-code-line);border-radius:5px;padding:.04em .3em;font-family:"JetBrains Mono",ui-monospace,monospace}

/* snippet row */
.snippet-row{margin:42px 0 0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.05fr);gap:32px;align-items:center}
.snippet-text h2{font-family:Fraunces,Georgia,serif;font-size:clamp(1.4rem,2.1vw,1.85rem);margin:0 0 12px;line-height:1.15;letter-spacing:-.005em;font-weight:600}
.snippet-text p{margin:0 0 14px;color:var(--body-text)}
.snippet-list{margin:0;padding-left:18px;color:var(--body-text)}
.snippet-list li{margin:6px 0}
.snippet{margin:0;background:var(--code-bg);color:var(--code-fg);border-radius:14px;padding:24px 24px;font:500 .9rem/1.65 "JetBrains Mono",ui-monospace,monospace;border:1px solid var(--code-border);box-shadow:var(--snippet-shadow);overflow:hidden}
.snippet code{background:transparent;border:0;padding:0;color:inherit;font:inherit;display:block;white-space:pre}
.snippet .prompt{color:var(--sun)}
.snippet .comment{color:var(--code-comment)}

/* lanes row */
.lanes-row{margin:48px 0 0}
.lanes-row h2{font-family:Fraunces,Georgia,serif;font-size:clamp(1.4rem,2.1vw,1.85rem);margin:0 0 16px;line-height:1.15;letter-spacing:-.005em;font-weight:600}
.lanes{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.lane{display:block;background:var(--lane-bg);border:1px solid var(--line);border-radius:14px;padding:22px 22px 22px;text-decoration:none;color:var(--ink);position:relative;overflow:hidden;transition:transform .15s,border-color .15s,box-shadow .15s}
.lane:hover{transform:translateY(-2px);border-color:var(--coral);box-shadow:var(--lane-hover-shadow)}
.lane-arrow{position:absolute;top:18px;right:20px;color:var(--coral);font-family:"JetBrains Mono",monospace;font-weight:700;font-size:1.05rem;transition:transform .2s}
.lane:hover .lane-arrow{transform:translateX(4px)}
.lane h3{font-family:Fraunces,Georgia,serif;font-size:1.18rem;margin:0 0 6px;font-weight:600;letter-spacing:-.005em}
.lane p{margin:0;color:var(--body-text-soft);font-size:.94rem;line-height:1.55}
.lane code{background:var(--inline-code-bg);border:1px solid var(--inline-code-line);border-radius:5px;padding:.04em .3em;font-size:.84em;font-family:"JetBrains Mono",monospace}

/* rules */
.rules{margin:48px 0 8px;padding:28px 28px 26px;background:var(--rules-bg);border:1px solid var(--line);border-radius:18px}
.rules h2{font-family:Fraunces,Georgia,serif;font-size:clamp(1.4rem,2.1vw,1.85rem);margin:0 0 8px;line-height:1.15;letter-spacing:-.005em;font-weight:600}
.rules-list{list-style:none;padding:0;margin:14px 0 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px 18px;color:var(--body-text)}
.rules-list li{position:relative;padding-left:22px;line-height:1.5}
.rules-list li:before{content:"";position:absolute;left:0;top:.55em;width:10px;height:10px;background:var(--coral);clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%);transform:rotate(0deg)}
.rules-list code{background:var(--inline-code-bg);border:1px solid var(--inline-code-line);border-radius:5px;padding:.04em .3em;font-size:.86em;font-family:"JetBrains Mono",monospace}

/* layout: doc + toc */
.doc-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:36px;margin-top:30px}
.doc-grid-home{margin-top:18px}
.doc-home{background:transparent;box-shadow:none;border:0;padding:0;max-width:none;width:100%}
@media(min-width:1180px){.doc-grid{grid-template-columns:minmax(0,74ch) 200px;justify-content:start}.doc-grid-home{grid-template-columns:minmax(0,1fr)}}
.doc{min-width:0;max-width:74ch;background:var(--feature-bg);box-shadow:var(--shadow);border:1px solid var(--line-soft);border-radius:14px;padding:clamp(22px,3.6vw,44px);overflow-wrap:break-word}
.doc h1{display:none}
.doc h2{font-family:Fraunces,Georgia,serif;font-size:1.7rem;line-height:1.15;margin:1.9em 0 .5em;font-weight:600;letter-spacing:-.005em;position:relative}
.doc h3{font-size:1.14rem;margin:1.6em 0 .3em;position:relative;font-weight:600}
.doc h4{font-size:.99rem;margin:1.3em 0 .2em;color:var(--reef);position:relative;font-weight:600}
.doc h2:first-child,.doc h3:first-child,.doc h4:first-child{margin-top:0}
.doc :is(h2,h3,h4) .anchor{position:absolute;left:-1em;top:0;color:var(--muted);opacity:0;text-decoration:none;font-weight:400;padding-right:.3em;transition:opacity .12s,color .12s}
.doc :is(h2,h3,h4):hover .anchor{opacity:.55}
.doc :is(h2,h3,h4) .anchor:hover{opacity:1;color:var(--accent-text)}
.doc p{margin:0 0 1.05em}
.doc ul,.doc ol{padding-left:1.35rem;margin:0 0 1.2em}
.doc li{margin:.25em 0}
.doc li>p{margin:0 0 .4em}
.doc strong{font-weight:600}
.doc code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.86em;background:var(--inline-code-bg);border:1px solid var(--inline-code-line);border-radius:5px;padding:.08em .34em}
.doc pre{position:relative;overflow:auto;background:var(--code-bg);color:var(--code-fg);border-radius:11px;padding:16px 20px;border:1px solid var(--code-border);box-shadow:inset 0 0 0 1px rgba(255,255,255,.03);margin:1.35em 0;font-size:.88em;scrollbar-width:thin;scrollbar-color:var(--code-scroll) transparent}
.doc pre::-webkit-scrollbar{height:8px}
.doc pre::-webkit-scrollbar-thumb{background:var(--code-scroll);border-radius:8px}
.doc pre code{background:transparent;border:0;color:inherit;padding:0;font-size:1em}
.doc pre .copy{position:absolute;top:8px;right:8px;background:var(--code-copy-bg);color:var(--code-fg);border:1px solid var(--code-copy-line);border-radius:6px;padding:3px 9px;font:600 .7rem/1 Inter,sans-serif;cursor:pointer;opacity:0;transition:opacity .15s,background .15s,border-color .15s}
.doc pre:hover .copy,.doc pre .copy:focus{opacity:1}
.doc pre .copy:hover{background:var(--code-copy-hover)}
.doc pre .copy.copied{background:var(--coral);border-color:var(--coral);opacity:1}
.doc blockquote{margin:1.4em 0;padding:12px 16px;border-left:3px solid var(--coral);background:var(--blockquote-bg);border-radius:0 9px 9px 0;color:var(--ink)}
.doc blockquote p:last-child{margin-bottom:0}
.doc table{width:100%;border-collapse:collapse;margin:1.2em 0;font-size:.94em}
.doc th,.doc td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:left}
.doc th{font-weight:600;color:var(--reef)}
.doc hr{border:0;border-top:1px solid var(--line);margin:2em 0}

/* toc */
.toc{position:sticky;top:24px;align-self:start;font-size:.85rem;padding-left:14px;border-left:1px solid var(--line);max-height:calc(100vh - 48px);overflow:auto;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.toc::-webkit-scrollbar{width:5px}
.toc::-webkit-scrollbar-thumb{background:var(--line);border-radius:5px}
.toc h2{font-size:.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:.13em;margin:0 0 10px;font-weight:700}
.toc a{display:block;color:var(--muted);text-decoration:none;padding:4px 0 4px 10px;line-height:1.35;border-left:2px solid transparent;margin-left:-12px;transition:color .12s,border-color .12s}
.toc a:hover{color:var(--ink)}
.toc a.active{color:var(--reef);border-left-color:var(--coral);font-weight:600}
.toc-l3{padding-left:22px!important;font-size:.94em}
@media(max-width:1179px){.toc{display:none}}

/* prev/next pager */
.page-nav{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:48px}
.page-nav>a{display:block;border:1px solid var(--line);background:var(--paper);border-radius:11px;padding:14px 18px;text-decoration:none;color:var(--ink);transition:border-color .15s,transform .15s,box-shadow .15s}
.page-nav>a:hover{border-color:var(--coral);transform:translateY(-1px);box-shadow:var(--pager-shadow)}
.page-nav small{display:block;color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.12em;margin-bottom:5px;font-weight:700}
.page-nav span{display:block;font-weight:600;line-height:1.3}
.page-nav-prev{text-align:left}
.page-nav-next{text-align:right;grid-column:2}
.page-nav-prev:only-child{grid-column:1}

/* mobile nav toggle */
.nav-toggle{display:none;position:fixed;top:14px;right:14px;z-index:20;width:42px;height:42px;border-radius:10px;background:var(--paper);border:1px solid var(--line);cursor:pointer;padding:11px 10px;flex-direction:column;justify-content:space-between;box-shadow:var(--toggle-shadow)}
.nav-toggle span{display:block;height:2px;background:var(--ink);border-radius:2px;transition:transform .2s,opacity .2s}
.nav-toggle[aria-expanded="true"] span:nth-child(1){transform:translateY(8px) rotate(45deg)}
.nav-toggle[aria-expanded="true"] span:nth-child(2){opacity:0}
.nav-toggle[aria-expanded="true"] span:nth-child(3){transform:translateY(-8px) rotate(-45deg)}

/* mobile */
@media(max-width:980px){
  .shell{display:block}
  .sidebar{position:fixed;inset:0 25% 0 0;max-width:340px;height:100vh;z-index:15;transform:translateX(-100%);transition:transform .25s ease;box-shadow:var(--sidebar-shadow);background:var(--sidebar-mobile-bg)}
  .sidebar.open{transform:translateX(0)}
  .nav-toggle{display:flex}
  main{padding:64px 18px 32px}
  .hero{padding-top:8px}
  .hero h1{font-size:clamp(1.7rem,7vw,2.2rem)}
  .hero-meta{width:100%;justify-content:flex-start}
  .hero-home{grid-template-columns:1fr;gap:18px}
  .hero-home h1{font-size:clamp(2rem,8vw,2.7rem);max-width:none}
  .hero-art{min-height:240px;order:-1}
  .hero-art svg{width:min(280px,80%)}
  .features-row{grid-template-columns:1fr;margin-top:30px}
  .snippet-row{grid-template-columns:1fr;margin-top:32px;gap:18px}
  .snippet{font-size:.78rem;padding:18px}
  .lanes{grid-template-columns:1fr}
  .rules{padding:22px}
  .doc{padding:22px;border-radius:11px}
  .doc-home{padding:0}
  .doc-grid{margin-top:22px;gap:24px}
  .doc :is(h2,h3,h4) .anchor{display:none}
}
@media(max-width:520px){
  main{padding:60px 14px 28px}
  .doc{padding:18px 16px}
  .doc pre{margin-left:-16px;margin-right:-16px;border-radius:0;border-left:0;border-right:0}
}
`;
}

function js() {
  return `
const themeKey='clawsweeper-theme';
const themeChoices=new Set(['system','light','dark']);
const themeColor={light:'#f4ead7',dark:'#081417'};
const themeQuery=window.matchMedia?.('(prefers-color-scheme: dark)');
const themeButtons=document.querySelectorAll('[data-theme-choice]');
const readThemeChoice=()=>{try{const saved=window.localStorage?.getItem(themeKey);return themeChoices.has(saved)?saved:'system'}catch{return 'system'}};
let themeChoice=readThemeChoice();
const activeTheme=()=>themeChoice==='system'&&themeQuery?.matches?'dark':themeChoice==='dark'?'dark':'light';
const applyTheme=()=>{const active=activeTheme();document.documentElement.dataset.theme=active;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',themeColor[active]);themeButtons.forEach(btn=>{const selected=btn.dataset.themeChoice===themeChoice;btn.setAttribute('aria-pressed',selected?'true':'false')})};
themeButtons.forEach(btn=>btn.addEventListener('click',()=>{const choice=btn.dataset.themeChoice;if(!themeChoices.has(choice))return;themeChoice=choice;try{window.localStorage?.setItem(themeKey,choice)}catch{}applyTheme()}));
themeQuery?.addEventListener('change',()=>{if(themeChoice==='system')applyTheme()});
applyTheme();

const sidebar=document.querySelector('.sidebar');
const toggle=document.querySelector('.nav-toggle');
toggle?.addEventListener('click',()=>{const open=sidebar.classList.toggle('open');toggle.setAttribute('aria-expanded',open?'true':'false')});
document.addEventListener('click',(e)=>{if(!sidebar?.classList.contains('open'))return;if(sidebar.contains(e.target)||toggle.contains(e.target))return;sidebar.classList.remove('open');toggle.setAttribute('aria-expanded','false')});

const input=document.getElementById('doc-search');
input?.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();document.querySelectorAll('nav section').forEach(sec=>{let any=false;sec.querySelectorAll('.nav-link').forEach(a=>{const m=!q||a.textContent.toLowerCase().includes(q);a.style.display=m?'block':'none';if(m)any=true});sec.style.display=any?'block':'none'})});

document.querySelectorAll('.doc pre').forEach(pre=>{const btn=document.createElement('button');btn.type='button';btn.className='copy';btn.textContent='Copy';btn.addEventListener('click',async()=>{const code=pre.querySelector('code')?.textContent??'';try{await navigator.clipboard.writeText(code);btn.textContent='Copied';btn.classList.add('copied');setTimeout(()=>{btn.textContent='Copy';btn.classList.remove('copied')},1400)}catch{btn.textContent='Failed';setTimeout(()=>{btn.textContent='Copy'},1400)}});pre.appendChild(btn)});

const tocLinks=document.querySelectorAll('.toc a');
if(tocLinks.length){const map=new Map();tocLinks.forEach(a=>{const id=a.getAttribute('href').slice(1);const el=document.getElementById(id);if(el)map.set(el,a)});const setActive=l=>{tocLinks.forEach(x=>x.classList.remove('active'));l.classList.add('active')};const obs=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);if(visible.length){const link=map.get(visible[0].target);if(link)setActive(link)}},{rootMargin:'-15% 0px -65% 0px',threshold:0});map.forEach((_,el)=>obs.observe(el))}
`;
}

function heroCrab() {
  return `<svg viewBox="0 0 400 320" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sweeping crab">
  <defs>
    <radialGradient id="bodyGrad" cx="50%" cy="55%" r="60%">
      <stop offset="0%" stop-color="#f17655"/>
      <stop offset="55%" stop-color="#d9472b"/>
      <stop offset="100%" stop-color="#a4321c"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#0a6a72" stop-opacity=".0"/>
      <stop offset="100%" stop-color="#0a6a72" stop-opacity=".18"/>
    </linearGradient>
  </defs>
  <ellipse cx="200" cy="288" rx="170" ry="14" fill="url(#floor)"/>
  <circle class="bubble" cx="80" cy="240" r="6" fill="#0a6a72" opacity=".5"/>
  <circle class="bubble b2" cx="330" cy="220" r="8" fill="#0a6a72" opacity=".5"/>
  <circle class="bubble b3" cx="270" cy="250" r="5" fill="#0a6a72" opacity=".5"/>
  <g class="crab-body">
    <!-- legs -->
    <g stroke="#0b3a3f" stroke-width="9" stroke-linecap="round" fill="none">
      <path d="M118 198 Q 84 220 64 252"/>
      <path d="M132 218 Q 110 244 96 280"/>
      <path d="M150 232 Q 144 260 142 290"/>
      <path d="M282 198 Q 316 220 336 252"/>
      <path d="M268 218 Q 290 244 304 280"/>
      <path d="M250 232 Q 256 260 258 290"/>
    </g>
    <!-- left claw arm -->
    <g class="claw-l">
      <path d="M152 168 Q 110 168 80 152" stroke="#a4321c" stroke-width="14" stroke-linecap="round" fill="none"/>
      <path d="M88 152 q -28 -8 -52 -2 q 4 18 22 26 q -10 4 -10 14 q 22 8 36 -8 q 10 6 22 0 q 6 -16 -18 -30 z" fill="url(#bodyGrad)" stroke="#7d2613" stroke-width="2"/>
      <path d="M40 158 q 14 -2 26 6" stroke="#fdf6e9" stroke-width="2" fill="none" opacity=".5"/>
    </g>
    <!-- right claw arm -->
    <g class="claw-r">
      <path d="M248 168 Q 290 168 320 152" stroke="#a4321c" stroke-width="14" stroke-linecap="round" fill="none"/>
      <path d="M312 152 q 28 -8 52 -2 q -4 18 -22 26 q 10 4 10 14 q -22 8 -36 -8 q -10 6 -22 0 q -6 -16 18 -30 z" fill="url(#bodyGrad)" stroke="#7d2613" stroke-width="2"/>
      <path d="M360 158 q -14 -2 -26 6" stroke="#fdf6e9" stroke-width="2" fill="none" opacity=".5"/>
    </g>
    <!-- body -->
    <ellipse cx="200" cy="180" rx="92" ry="56" fill="url(#bodyGrad)" stroke="#7d2613" stroke-width="3"/>
    <!-- shell highlights -->
    <path d="M134 168 q 66 -34 132 0" stroke="#fdf6e9" stroke-width="3" fill="none" opacity=".55" stroke-linecap="round"/>
    <path d="M154 188 q 46 -22 92 0" stroke="#fdf6e9" stroke-width="2" fill="none" opacity=".35" stroke-linecap="round"/>
    <!-- eyes -->
    <line x1="180" y1="146" x2="180" y2="120" stroke="#0b3a3f" stroke-width="4" stroke-linecap="round"/>
    <line x1="220" y1="146" x2="220" y2="120" stroke="#0b3a3f" stroke-width="4" stroke-linecap="round"/>
    <circle cx="180" cy="116" r="9" fill="#fdf6e9" stroke="#0b3a3f" stroke-width="2.5"/>
    <circle cx="220" cy="116" r="9" fill="#fdf6e9" stroke="#0b3a3f" stroke-width="2.5"/>
    <circle cx="183" cy="115" r="3.5" fill="#06181c"/>
    <circle cx="223" cy="115" r="3.5" fill="#06181c"/>
    <!-- mouth -->
    <path d="M188 204 q 12 8 24 0" stroke="#0b3a3f" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <!-- broom in right claw -->
    <g transform="translate(346 132) rotate(28)">
      <rect x="-2" y="0" width="4" height="46" fill="#8a5a2c" rx="2"/>
      <path d="M-14 46 l28 0 l-3 22 l-22 0 z" fill="#f4a93a" stroke="#8a5a2c" stroke-width="2"/>
      <line x1="-10" y1="50" x2="-12" y2="68" stroke="#8a5a2c" stroke-width="1"/>
      <line x1="-4" y1="50" x2="-5" y2="68" stroke="#8a5a2c" stroke-width="1"/>
      <line x1="2" y1="50" x2="2" y2="68" stroke="#8a5a2c" stroke-width="1"/>
      <line x1="8" y1="50" x2="9" y2="68" stroke="#8a5a2c" stroke-width="1"/>
    </g>
  </g>
</svg>`;
}

function featureIcon(kind) {
  const icons = {
    report: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>`,
    comment: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8M8 13h5"/></svg>`,
    shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4v6c0 5-3.5 8-8 8s-8-3-8-8V7z"/><path d="M9 12l2 2 4-4"/></svg>`,
    lanes: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="1.6" fill="currentColor"/><circle cx="14" cy="12" r="1.6" fill="currentColor"/><circle cx="10" cy="18" r="1.6" fill="currentColor"/></svg>`,
    bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>`,
    wrench: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/></svg>`,
  };
  return icons[kind] || icons.report;
}

function clawSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="ClawSweeper">
<rect width="120" height="120" rx="26" fill="#0b3a3f"/>
<circle cx="60" cy="62" r="36" fill="#d9472b" stroke="#7d2613" stroke-width="3"/>
<path d="M30 60q30 -22 60 0" stroke="#fdf6e9" stroke-width="4" fill="none" stroke-linecap="round" opacity=".7"/>
<line x1="50" y1="46" x2="50" y2="32" stroke="#0b3a3f" stroke-width="3" stroke-linecap="round"/>
<line x1="70" y1="46" x2="70" y2="32" stroke="#0b3a3f" stroke-width="3" stroke-linecap="round"/>
<circle cx="50" cy="30" r="5" fill="#fdf6e9" stroke="#0b3a3f" stroke-width="2"/>
<circle cx="70" cy="30" r="5" fill="#fdf6e9" stroke="#0b3a3f" stroke-width="2"/>
<circle cx="51" cy="30" r="2" fill="#06181c"/>
<circle cx="71" cy="30" r="2" fill="#06181c"/>
<path d="M52 78q8 5 16 0" stroke="#0b3a3f" stroke-width="2.5" fill="none" stroke-linecap="round"/>
<path d="M22 64q-12 -2 -16 4q4 8 12 6m-6 -6 q3 -1 6 0" stroke="#7d2613" stroke-width="2" fill="#d9472b"/>
<path d="M98 64q12 -2 16 4q-4 8 -12 6m6 -6 q-3 -1 -6 0" stroke="#7d2613" stroke-width="2" fill="#d9472b"/>
<g stroke="#0b3a3f" stroke-width="3" stroke-linecap="round" fill="none">
<path d="M30 84q-4 8 -8 12"/>
<path d="M40 92q-2 6 -2 12"/>
<path d="M90 84q4 8 8 12"/>
<path d="M80 92q2 6 2 12"/>
</g>
</svg>`;
}

function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#0b3a3f"/>
<circle cx="32" cy="34" r="20" fill="#d9472b"/>
<line x1="26" y1="26" x2="26" y2="18" stroke="#0b3a3f" stroke-width="2.5" stroke-linecap="round"/>
<line x1="38" y1="26" x2="38" y2="18" stroke="#0b3a3f" stroke-width="2.5" stroke-linecap="round"/>
<circle cx="26" cy="17" r="3" fill="#fdf6e9"/>
<circle cx="38" cy="17" r="3" fill="#fdf6e9"/>
<circle cx="26.5" cy="17" r="1.2" fill="#06181c"/>
<circle cx="38.5" cy="17" r="1.2" fill="#06181c"/>
<path d="M28 42q4 3 8 0" stroke="#0b3a3f" stroke-width="1.8" fill="none" stroke-linecap="round"/>
<path d="M12 36q-6 -1 -8 2q2 4 6 3" stroke="#7d2613" stroke-width="1.5" fill="#d9472b"/>
<path d="M52 36q6 -1 8 2q-2 4 -6 3" stroke="#7d2613" stroke-width="1.5" fill="#d9472b"/>
</svg>`;
}

function slug(text) {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function escapeAttr(value) {
  return escapeHtml(value);
}
