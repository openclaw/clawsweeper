import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("docs site emits an early persistent theme switcher", () => {
  execFileSync(process.execPath, ["scripts/build-docs-site.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });

  const html = readFileSync("dist/docs-site/index.html", "utf8");
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
});
