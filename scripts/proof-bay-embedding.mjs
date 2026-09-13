#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import worker from "../dashboard/worker.ts";

// Exercise Chromium's ancestor enforcement using the unmodified Worker responses.
// Every request is fulfilled locally; no Team, GitHub, or production data is read.
const expectBlocked = process.argv.includes("--expect-blocked");
const phase = expectBlocked ? "before" : "after";
const outputDir = ".artifacts/bay-team-embedding";
const origin = "https://clawsweeper.openclaw.ai";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
const results = [];
const requests = [];

await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  requests.push({ method: request.method(), origin: url.origin, path: url.pathname });
  assert.equal(request.method(), "GET");
  if (url.origin !== origin) {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Bay embedding proof</title><h1>Synthetic embedding parent</h1><iframe title="ClawSweeper" src="${origin}/" style="width:100%;height:900px;border:0"></iframe>`,
    });
  } else if (url.pathname === "/" || url.pathname === "/bay") {
    const response = await worker.fetch(new Request(request.url()), {});
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  } else if (/^\/bay-assets\/[a-z-]+\.webp$/.test(url.pathname)) {
    await route.fulfill({
      contentType: "image/webp",
      body: await readFile(new URL(`../dashboard/public${url.pathname}`, import.meta.url)),
    });
  } else {
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  }
});

try {
  await mkdir(outputDir, { recursive: true });
  for (const parent of [
    "https://team.openclaw.ai",
    "https://unrelated.example",
    "https://team.openclaw.ai.unrelated.example",
    "http://team.openclaw.ai",
  ]) {
    const page = await context.newPage();
    const violations = [];
    page.on("console", (message) => {
      if (/frame-ancestors|X-Frame-Options/i.test(message.text())) violations.push(message.text());
    });
    await page.goto(`${parent}/embedding-proof`);
    const frame = page.frameLocator("iframe");
    const shouldLoad = !expectBlocked && parent === "https://team.openclaw.ai";
    const blocked = shouldLoad
      ? null
      : page.waitForEvent("console", {
          predicate: (message) => /frame-ancestors|X-Frame-Options/i.test(message.text()),
        });
    await frame.getByRole("link", { name: "OpenClaw Bay", exact: true }).click();
    if (shouldLoad) {
      await frame.getByRole("heading", { name: "OpenClaw Bay", exact: true }).waitFor();
      assert.equal(violations.length, 0);
    } else {
      await blocked;
      assert.equal(
        await frame.getByRole("heading", { name: "OpenClaw Bay", exact: true }).count(),
        0,
      );
    }
    results.push({ parent, result: shouldLoad ? "rendered" : "blocked", violations });
    if (parent === "https://team.openclaw.ai")
      await page.screenshot({ path: `${outputDir}/${phase}.png` });
    await page.close();
  }
  const standalone = await context.newPage();
  await standalone.goto(`${origin}/bay`);
  await standalone.getByRole("heading", { name: "OpenClaw Bay", exact: true }).waitFor();
  results.push({ parent: null, result: "rendered" });
  const response = await worker.fetch(new Request(`${origin}/bay`), {});
  const summary = {
    phase,
    base_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    worker_sha256: createHash("sha256")
      .update(await readFile(new URL("../dashboard/worker.ts", import.meta.url)))
      .digest("hex"),
    browser: browser.version(),
    headers: Object.fromEntries(response.headers),
    results,
    request_count: requests.length,
    limits:
      "Synthetic parents and unavailable telemetry; production Worker HTML/headers and browser frame enforcement are real. No external network requests.",
  };
  await writeFile(`${outputDir}/${phase}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
