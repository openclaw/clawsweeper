import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("docs site preserves the landing, documentation hub, and theme controls", () => {
  execFileSync(process.execPath, ["scripts/build-docs-site.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const html = readFileSync("dist/docs-site/index.html", "utf8");
  const documentationHtml = readFileSync("dist/docs-site/documentation.html", "utf8");
  const themeInit = html.indexOf('const key = "clawsweeper-theme"');
  const styles = html.indexOf("<style>");

  assert.notEqual(themeInit, -1);
  assert.notEqual(styles, -1);
  assert.ok(themeInit < styles, "saved theme must be applied before site styles");
  assert.match(html, /html\[data-theme="dark"\]/);
  assert.match(html, /data-theme-choice="system"/);
  assert.match(html, /data-theme-choice="light"/);
  assert.match(html, /data-theme-choice="dark"/);
  assert.match(html, /localStorage\?\.setItem\(themeKey,choice\)/);
  assert.match(html, /themeQuery\?\.addEventListener\('change'/);
  assert.match(html, /setAttribute\('aria-pressed',selected\?'true':'false'\)/);
  assert.match(html, /setAttribute\("content", themeColor\[active\]\)/);
  assert.match(html, /Three hosted operational lanes/);
  assert.match(html, /Three hosted lanes, plus local review/);
  assert.match(html, /GitHub context stays local while Codex connects/);
  assert.doesNotMatch(html, /Four operational lanes|Four lanes, one engine/);
  assert.doesNotMatch(html, /commit-range review without polling/);
  assert.match(documentationHtml, /ClawSweeper documentation/);
  assert.match(documentationHtml, /Start here/);
  assert.match(documentationHtml, /Document lifecycle/);
  assert.match(
    documentationHtml,
    /github\.com\/openclaw\/clawsweeper\/blob\/main\/CONTRIBUTING\.md/,
  );
  assert.doesNotMatch(documentationHtml, /\.\.\/(?:VISION|CONTRIBUTING|AGENTS)\.html/);
});

test("docs site keeps non-current evidence out of canonical discovery", () => {
  execFileSync(process.execPath, ["scripts/build-docs-site.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const llms = readFileSync("dist/docs-site/llms.txt", "utf8");
  const sitemap = readFileSync("dist/docs-site/sitemap.xml", "utf8");
  const proposal = readFileSync("dist/docs-site/queue-service-split-runbook.html", "utf8");
  const historical = readFileSync("dist/docs-site/repair/containment-validation-todo.html", "utf8");
  const proof = readFileSync(
    "dist/docs-site/proof/operational-health-zombie-runs/index.html",
    "utf8",
  );

  for (const output of [llms, sitemap]) {
    assert.doesNotMatch(output, /queue-service-split-runbook/);
    assert.doesNotMatch(output, /containment-validation-todo/);
    assert.doesNotMatch(output, /proof\/operational-health-zombie-runs/);
  }
  assert.match(llms, /live-dashboard\.html/);
  for (const html of [proposal, historical, proof]) {
    assert.match(html, /<meta name="robots" content="noindex, follow">/);
    assert.match(html, /class="lifecycle-banner"/);
  }
  assert.match(proposal, /unapproved proposal, not current operator guidance/);
  assert.match(historical, /historical decision evidence, not current operator guidance/);
  assert.match(proof, /does not override current documentation/);
});
