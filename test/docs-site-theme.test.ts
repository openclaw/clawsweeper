import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

const sourceRoot = resolve(import.meta.dirname, "..");
let fixtureRoot: string;

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "clawsweeper-docs-site-"));
  for (const input of ["docs", "config"]) {
    cpSync(join(sourceRoot, input), join(fixtureRoot, input), { recursive: true });
  }
  // Other proof files copy dist concurrently; this build owns only its temporary output.
  execFileSync(process.execPath, [join(sourceRoot, "scripts/build-docs-site.mjs")], {
    cwd: fixtureRoot,
    stdio: "pipe",
  });
});

after(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

function readSite(file: string): string {
  return readFileSync(join(fixtureRoot, "dist/docs-site", file), "utf8");
}

test("docs site preserves the landing, documentation hub, and theme controls", () => {
  const html = readSite("index.html");
  const documentationHtml = readSite("documentation.html");
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
  const llms = readSite("llms.txt");
  const sitemap = readSite("sitemap.xml");
  const proposal = readSite("queue-service-split-runbook.html");
  const historical = readSite("repair/containment-validation-todo.html");
  const proof = readSite("proof/operational-health-zombie-runs/index.html");

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
