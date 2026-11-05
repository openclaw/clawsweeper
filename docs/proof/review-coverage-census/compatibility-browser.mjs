// Optional execution owner for the later approved contained compatibility proof.
// Serves the actual complete Astro build; never installs a fake browser page.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync } from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

export async function captureCompatibilityBrowser({
  selected,
  output,
  evaluation,
  executionStartedAt,
  complete,
}) {
  mkdirSync(output, { recursive: true });
  const site = resolve("dashboard-site"),
    data = join(site, "src/data/dashboard.json"),
    prior = existsSync(data) ? readFileSync(data) : null;
  let server,
    browser,
    externalRequests = 0;
  try {
    mkdirSync(join(site, "src/data"), { recursive: true });
    writeFileSync(
      data,
      JSON.stringify({
        ...JSON.parse(readFileSync(join(site, "fixtures/dashboard.json"))),
        ...selected,
        generatedAt: evaluation,
      }),
    );
    const build = spawnSync("pnpm", ["exec", "astro", "build"], {
      cwd: site,
      encoding: "utf8",
      env: {
        ...process.env,
        CLAWSWEEPER_PROOF_EVALUATION_AT: evaluation,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          "--import=" + resolve("docs/proof/ui-live-coverage/replay-clock-preload.mjs"),
        ]
          .filter(Boolean)
          .join(" "),
      },
    });
    writeFileSync(join(output, "astro-build.log"), (build.stdout ?? "") + (build.stderr ?? ""));
    assert.equal(build.status, 0);
    const dist = join(site, "dist"),
      built = join(dist, "coverage/index.html");
    assert.ok(existsSync(built));
    writeFileSync(join(output, "built-coverage.html"), readFileSync(built));
    server = createServer((req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, "http://local").pathname);
        let file = resolve(dist, "." + pathname);
        if (!file.startsWith(dist + sep)) {
          res.writeHead(403).end();
          return;
        }
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
        if (!existsSync(file)) {
          res.writeHead(404).end();
          return;
        }
        const mime = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };
        res.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream");
        res.end(readFileSync(file));
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    browser = await chromium.launch({
      headless: true,
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
      externalRequests++;
      return route.abort();
    });
    await page.goto("http://127.0.0.1:" + port + "/coverage/", { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText();
    assert.match(text, /Observed GitHub Open|Observed Open/);
    assert.match(text, /as.of|collection windows/i);
    assert.match(text, /openclaw\/core/);
    if (complete) {
      assert.match(text, /Census complete:\s*1\/1/);
      assert.match(text, /0\.0%|100\.0%/);
    } else {
      assert.match(text, /Coverage unknown|Unknown/);
      assert.match(text, /Census complete:\s*0\/1/);
    }
    const details = page.getByText("Verified collection windows", { exact: false });
    if (await details.count()) await details.first().click();
    const caption =
      "CONTROLLED PREDECESSOR-UPGRADE PROOF: state produced by pinned03 owner APIs, candidate same-storage upgrade. Evaluated as of " +
      evaluation +
      "; actual execution began " +
      executionStartedAt +
      ". NOT a captured production store/live observation. Browser wall time remains real.";
    await page.evaluate((caption) => {
      const div = document.createElement("div");
      div.textContent = caption;
      div.style.cssText = "background:#fff2b0;color:#222;padding:10px;font:14px sans-serif";
      document.body.prepend(div);
    }, caption);
    writeFileSync(join(output, "coverage.txt"), await page.locator("body").innerText());
    writeFileSync(join(output, "coverage.html"), await page.content());
    await page.screenshot({ path: join(output, "coverage.png"), fullPage: true });
    assert.equal(externalRequests, 0);
    return {
      passed: true,
      complete,
      externalRequests,
      browserClock: "real",
      buildEvaluation: evaluation,
      executionStartedAt,
      caption,
    };
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (prior) writeFileSync(data, prior);
    else rmSync(data, { force: true });
  }
}
