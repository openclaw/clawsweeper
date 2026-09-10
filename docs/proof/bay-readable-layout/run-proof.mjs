import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { repositories, scenarios, stages } from "./fixtures.mjs";
import { settledMasterViolations, activeMobileMasterTop } from "./settled-master.mjs";

const origin = process.env.BAY_PROOF_ORIGIN || "http://127.0.0.1:8794";
const baseOrigin = process.env.BAY_PROOF_BASE_ORIGIN || "http://127.0.0.1:8795";
const output = process.env.BAY_PROOF_OUTPUT || ".artifacts/bay-readable-layout";
for (const value of [origin, baseOrigin])
  assert.ok(
    ["127.0.0.1", "localhost"].includes(new URL(value).hostname),
    "proof must be loopback only",
  );
assert.ok(
  process.env.BAY_PROOF_PROVIDER && process.env.BAY_PROOF_LEASE && process.env.BAY_PROOF_IMAGE,
  "Record actual Crabbox provider, lease and image before claiming proof",
);
assert.ok(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  "Use a verified sandbox-capable browser from the selected image",
);
await mkdir(output, { recursive: true });
const checks = [],
  measurements = [],
  masterMeasurements = [],
  networks = [],
  errors = [];
let completed = false;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  headless: true,
  chromiumSandbox: true,
});
const post = async (server, route, value) => {
  const response = await fetch(server + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  assert.ok(response.ok, route + ": " + response.status);
  return response.json();
};
const get = async (server) => {
  const response = await fetch(server + "/api/status");
  assert.ok(response.ok);
  return { response, status: await response.json() };
};
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const check = (name) => {
  checks.push({ name, result: "PASS" });
  console.log("BAY_PROOF_PASS " + name);
};
const duration = (ms) => {
  const seconds = Math.round(ms / 1000),
    minutes = Math.floor(seconds / 60);
  return seconds < 60
    ? seconds + "s"
    : minutes < 10
      ? minutes + "m " + String(seconds % 60).padStart(2, "0") + "s"
      : minutes < 60
        ? minutes + "m"
        : Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
};
const areas = [...stages, "completed", "attention"];
const selector = (area) =>
  area === "attention"
    ? ".pool.attention"
    : area === "completed"
      ? ".pool.completed"
      : '.stage[data-stage="' + area + '"]';
const allRows = (status) => [
  ...(status.exact_review_queue.bay_projection.activity.items ||
    status.exact_review_queue.bay_projection.items ||
    []),
  ...status.bay.terminal_buffer.map((row) => ({
    ...row,
    stage: row.outcome === "success" ? "completed" : "attention",
  })),
];

async function captureMasterClearance(page, label, requireSettled = false) {
  if (requireSettled)
    await page.waitForFunction(
      () => {
        const master = document.querySelector("#master");
        return (
          master?.dataset.phase === "resting" &&
          master.classList.contains("resting") &&
          !master.classList.contains("moving") &&
          !master.classList.contains("settling") &&
          !master
            .getAnimations()
            .some(
              (animation) => animation.playState === "running" && "transitionProperty" in animation,
            )
        );
      },
      undefined,
      { timeout: 15000 },
    );
  const snapshot = await page.evaluate(() => {
    const master = document.querySelector("#master"),
      beach = document.querySelector("#beach");
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const visible = (node) => {
      const style = getComputedStyle(node);
      return (
        node.getClientRects().length > 0 &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        style.opacity !== "0"
      );
    };
    const style = getComputedStyle(master),
      images = [...master.querySelectorAll("img")];
    const obstacles = [
      ...document.querySelectorAll(
        ".critter,.critter .ref,.sample-count,.stage h2,.pool h2,.overflow-note,.focus-nav,.sample-note,.empty,.shore-toolbar button,.shore-toolbar select,.shore-toolbar summary,#inline-proof-filter",
      ),
    ]
      .filter(visible)
      .map((node) => ({
        target: node.id || String(node.className).slice(0, 120),
        bounds: box(node),
      }));
    return {
      phase: master.dataset.phase,
      resting: master.classList.contains("resting"),
      moving: master.classList.contains("moving"),
      settling: master.classList.contains("settling"),
      transitioning: master
        .getAnimations()
        .some(
          (animation) => animation.playState === "running" && "transitionProperty" in animation,
        ),
      visible: visible(master),
      imagesLoaded:
        images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0),
      master: box(master),
      beach: box(beach),
      sceneHeight: document.querySelector(".beach-inner").offsetHeight,
      layoutTop: master.offsetTop,
      layoutHeight: master.offsetHeight,
      transform: style.transform,
      transformOrigin: style.transformOrigin,
      cssWidth: style.width,
      cssHeight: style.height,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      obstacles,
    };
  });
  const result = settledMasterViolations(snapshot);
  const record = { label, ...snapshot, ...result };
  masterMeasurements.push(record);
  if (requireSettled) {
    if (!result.checked || result.violations.length)
      await writeFile(output + "/master-clearance-failure.json", JSON.stringify(record, null, 2));
    assert.equal(result.checked, true, label + " must reach a settled resting state");
    assert.deepEqual(
      result.violations,
      [],
      label + " parked sweeper clearance: " + JSON.stringify(result.violations),
    );
  }
  return record;
}

try {
  // Separate receipt path: actual queue admission and durable lifecycle finalization,
  // before the matrix's persisted status snapshots are installed.
  for (const fixture of [
    { number: 95011, duration: 60000, linked: true },
    { number: 95012, duration: 900000, linked: true, legacy: true, historical: true },
  ]) {
    await post(origin, "/fixture/admit", fixture);
    await post(origin, "/fixture/finalize", fixture);
  }
  const receiptStatus = (await get(origin)).status;
  await writeFile(output + "/durable-receipt-status.json", JSON.stringify(receiptStatus, null, 2));
  assert.equal(receiptStatus.bay.timings.including_legacy_batch.overall.samples, 2);
  assert.equal(receiptStatus.bay.timings.overall.samples, 1);
  check(
    "real ExactReviewQueue DO admission, lifecycle finalization, batch-inclusive and direct timing projection",
  );

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1199, height: 900 },
    { width: 768, height: 1024 },
    { width: 430, height: 932 },
    { width: 360, height: 800 },
  ]) {
    for (const scenario of scenarios) {
      const epoch = Date.now() - 1000;
      await post(origin, "/fixture/snapshot", { scenario, epoch });
      await post(baseOrigin, "/fixture/snapshot", { scenario, epoch });
      const current = await get(origin),
        before = await get(baseOrigin);
      const name = scenario + "-" + viewport.width;
      await writeFile(
        output + "/" + name + "-public.json",
        JSON.stringify(current.status, null, 2),
      );
      // Validate the real Worker result before matching screenshots or inspecting UI.
      // A supplied collection.state label is not evidence of valid raw telemetry.
      for (const [version, status] of [
        ["after", current.status],
        ["before", before.status],
      ]) {
        assert.equal(
          status.public_projection_complete,
          true,
          name + " " + version + " public projection unavailable",
        );
        assert.equal(
          status.exact_review_queue?.collection?.state,
          "complete",
          name +
            " " +
            version +
            " fixture rejected by production queue collection projection: " +
            JSON.stringify(status.exact_review_queue?.collection),
        );
        assert.equal(
          status.exact_review_queue?.bay_projection?.complete,
          true,
          name + " " + version + " Bay projection unavailable",
        );
      }
      assert.equal(
        current.response.headers.get("x-clawsweeper-cache"),
        "fresh",
        "must exercise production cached status route",
      );
      // Freshness age advances normally; all source data and projection must match.
      const { freshness: _freshness, ...projected } = current.status;
      const { freshness: _beforeFreshness, ...beforeProjected } = before.status;
      assert.deepEqual(projected, beforeProjected);
      assert.doesNotMatch(
        JSON.stringify(projected),
        /PRIVATE_UI_FIXTURE_SENTINEL|invalid\.example/,
      );
      for (const [version, server] of [
        ["before", baseOrigin],
        ["after", origin],
      ]) {
        const context = await browser.newContext({
          viewport,
          hasTouch: viewport.width <= 768,
          reducedMotion: "reduce",
        });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        let contextFailure;
        try {
          const page = await context.newPage();
          await page.addInitScript(() => {
            window.__bayInteractionTrace = [];
            const describe = (node) =>
              node instanceof Element
                ? {
                    tag: node.tagName,
                    id: node.id,
                    role: node.getAttribute("role"),
                    dialog: node.closest("dialog")?.id || null,
                    plot: node.classList.contains("journey-plot"),
                  }
                : null;
            for (const type of ["focusin", "focusout", "keydown", "close", "pointermove"])
              document.addEventListener(
                type,
                (event) => {
                  if (
                    type === "pointermove" &&
                    !(event.target instanceof Element && event.target.closest(".journey-plot"))
                  )
                    return;
                  const item = {
                    type,
                    key: event.key || null,
                    target: describe(event.target),
                    active: describe(document.activeElement),
                    value: document.querySelector(".journey-plot")?.getAttribute("aria-valuenow"),
                    at: performance.now(),
                  };
                  window.__bayInteractionTrace.push(item);
                  if (window.__bayInteractionTrace.length > 40)
                    window.__bayInteractionTrace.shift();
                },
                true,
              );
          });
          const traffic = [];
          page.on("pageerror", (error) => errors.push({ name, version, error: error.message }));
          await context.route("**/*", async (route) => {
            const request = route.request(),
              url = new URL(request.url());
            traffic.push({
              method: request.method(),
              url: request.url(),
              type: request.resourceType(),
            });
            if (url.origin !== server || request.method() !== "GET")
              return route.abort("blockedbyclient");
            return route.continue();
          });
          await page.goto(server + "/bay", { waitUntil: "networkidle" });
          await page.waitForFunction(
            () => document.querySelector("#loading").style.display === "none",
          );
          if (version === "before") {
            // Baseline used direct-only by default. Align its data selection, not its layout.
            await page.locator("#legacy-proof-toggle").click();
          }
          await page.screenshot({
            path: output + "/" + name + "-" + version + ".png",
            fullPage: true,
            animations: "disabled",
          });
          const geometry = await page.evaluate(() => {
            const box = (node) => {
              const r = node.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                right: r.right,
                bottom: r.bottom,
              };
            };
            const visible = (node) => node.getClientRects().length > 0;
            const labels = [...document.querySelectorAll(".critter .ref")].filter(visible).map(box);
            const controls = [
              ...document.querySelectorAll(
                ".shore-toolbar button,.shore-toolbar select,.shore-toolbar summary,#inline-proof-filter,.focus-nav button,.focus-nav select",
              ),
            ]
              .filter(visible)
              .map((node) => ({ label: node.id || node.textContent, ...box(node) }));
            return {
              hero: box(document.querySelector(".hero")),
              chart: box(document.querySelector(".journey-chart-host")),
              plot: document.querySelector(".journey-plot")
                ? box(document.querySelector(".journey-plot"))
                : null,
              beach: box(document.querySelector("#beach")),
              labels,
              controls,
              pageWidth: document.documentElement.scrollWidth,
              viewportWidth: innerWidth,
              viewportHeight: innerHeight,
              firstItems: [...document.querySelectorAll(".critter")].filter(visible).map(box),
            };
          });
          measurements.push({ name, version, fixtureSha256: hash(projected), ...geometry });
          await captureMasterClearance(
            page,
            name + "-" + version + "-initial",
            version === "after",
          );
          if (version === "after") {
            assert.equal(await page.locator("#review-paths").inputValue(), "all");
            assert.equal(await page.locator("#inline-proof-filter").inputValue(), "all");
            assert.ok(geometry.pageWidth <= viewport.width + 1, name + " horizontal page overflow");
            for (const control of geometry.controls)
              assert.ok(control.height >= 44, name + " undersized control " + control.label);
            for (let i = 0; i < geometry.labels.length; i++)
              for (let j = i + 1; j < geometry.labels.length; j++) {
                const a = geometry.labels[i],
                  b = geometry.labels[j];
                assert.ok(
                  !(a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y),
                  name + " label overlap",
                );
              }
            if (
              ["normal", "crowded", "mixed", "long", "batch"].includes(scenario) &&
              viewport.width <= 430
            )
              assert.ok(
                geometry.firstItems.some((item) => item.y >= 0 && item.bottom <= viewport.height),
                name + " must show a meaningful item on initial screen",
              );
            if (scenario === "stale")
              assert.match(await page.locator("#snapshot-line").innerText(), /stale/);
            if (scenario === "partial")
              assert.match(await page.locator("#notice").innerText(), /Partial/);
            if (scenario === "empty")
              assert.match(
                await page.locator(".journey-summary").innerText(),
                /No completed reviews/,
              );
            if (scenario === "missing")
              assert.match(await page.locator(".chart-unavailable").innerText(), /unavailable/);
            if (!["empty", "missing"].includes(scenario)) {
              const aggregate = current.status.bay.timings.including_legacy_batch.overall;
              assert.equal(
                await page.locator(".journey-summary .stat-value").innerText(),
                duration(aggregate.median_ms),
              );
              assert.match(
                await page.locator(".journey-summary").innerText(),
                new RegExp(aggregate.samples + " reviews"),
              );
            }
            if (viewport.width === 1440 && scenario === "normal") {
              const prior = measurements.find(
                (row) => row.name === name && row.version === "before",
              );
              assert.ok(
                geometry.hero.height < prior.hero.height,
                "compact header must reduce baseline height",
              );
              assert.ok(geometry.plot.width >= prior.plot.width, "chart must remain wide");
            }
            const initialRows = allRows(current.status);
            if (scenario === "mixed") {
              const repository = repositories[0];
              const timingBefore = await page.locator(".journey-summary").innerText();
              const repoButton = page.locator('.repo-button[data-repo="' + repository + '"]');
              await repoButton.scrollIntoViewIfNeeded();
              if (viewport.width <= 768) {
                const target = await repoButton.boundingBox();
                await page.touchscreen.tap(
                  target.x + target.width / 2,
                  target.y + target.height / 2,
                );
              } else await repoButton.click();
              assert.equal(await repoButton.getAttribute("aria-pressed"), "true");
              const filteredRefs = await page
                .locator(".critter[data-repository]")
                .evaluateAll((nodes) => nodes.map((node) => node.dataset.repository));
              assert.ok(
                filteredRefs.length > 0 && filteredRefs.every((repo) => repo === repository),
              );
              assert.equal(
                await page.locator(".journey-summary").innerText(),
                timingBefore,
                "repository filtering must not change review timing",
              );
              if (viewport.width < 1200) await page.selectOption("#focused-stage", "arriving");
              await page.locator(selector("arriving")).locator("[data-overflow-stage]").click();
              const filteredList = await page
                .locator("#queue-sample-body [data-overflow-reference]")
                .allTextContents();
              assert.deepEqual(
                [...filteredList].sort(),
                initialRows
                  .filter((row) => row.stage === "arriving" && row.repository === repository)
                  .map((row) => row.repository + "#" + row.item_number)
                  .sort(),
              );
              await page.keyboard.press("Escape");
              await page.locator('.repo-button[data-repo="all"]').click();
              assert.equal(await page.locator(".journey-summary").innerText(), timingBefore);
            }
            if (["normal", "batch", "unknown"].includes(scenario)) {
              for (const cohort of ["requested", "not_requested", "unknown"]) {
                await page.selectOption("#inline-proof-filter", cohort);
                const population =
                  current.status.bay.timings.including_legacy_batch.inline_proof?.[cohort];
                if (population) {
                  assert.equal(
                    await page.locator(".journey-summary .stat-value").innerText(),
                    duration(population.overall.median_ms),
                  );
                  assert.match(
                    await page.locator(".journey-summary").innerText(),
                    new RegExp(population.overall.samples + " review"),
                  );
                } else
                  assert.match(await page.locator(".journey-summary").innerText(), /Unavailable/);
              }
              await page.selectOption("#inline-proof-filter", "all");
            }
            for (const area of areas) {
              if (viewport.width < 1200) {
                await page.selectOption("#focused-stage", area);
                await captureMasterClearance(page, name + "-area-" + area, true);
              }
              const rows = initialRows.filter((row) => row.stage === area),
                section = page.locator(selector(area));
              const limit = area === "completed" ? 4 : area === "attention" ? 2 : 3;
              assert.equal(
                await section.locator(".critter").count(),
                Math.min(rows.length, limit),
                name + " slot bound " + area,
              );
              if (!rows.length) {
                assert.match(await section.innerText(), /No sampled/);
                continue;
              }
              await section.locator("[data-overflow-stage]").click();
              assert.equal(
                await page.locator("#queue-sample-body [data-overflow-reference]").count(),
                rows.length,
              );
              const listed = await page
                .locator("#queue-sample-body [data-overflow-reference]")
                .allTextContents();
              for (const row of rows)
                assert.ok(listed.includes(row.repository + "#" + row.item_number));
              if (area === "attention") {
                const outcomes = await page.locator("#queue-sample-body li").evaluateAll((nodes) =>
                  nodes.map((node) => ({
                    reference: node.querySelector("button").textContent,
                    outcome: node.querySelector("span").textContent,
                  })),
                );
                for (const row of rows) {
                  const label = row.outcome === "cancelled" ? "Cancelled" : "Failed";
                  assert.ok(
                    outcomes.some(
                      (entry) =>
                        entry.reference === row.repository + "#" + row.item_number &&
                        entry.outcome.startsWith(label + " · "),
                    ),
                    name + " preserves specific terminal outcome",
                  );
                }
              }
              const entry = page.locator("#queue-sample-body [data-overflow-reference]").last();
              await entry.focus();
              await page.keyboard.press("Enter");
              assert.equal(await page.locator("#drawer").evaluate((node) => node.open), true);
              assert.ok(
                repositories.some((repo) =>
                  (listed[listed.length - 1] || "").startsWith(repo + "#"),
                ),
              );
              for (const key of ["Tab", "Shift+Tab"]) {
                for (let i = 0; i < 8; i++) {
                  await page.keyboard.press(key);
                  const focus = await page.evaluate(() => {
                    const dialog = document.querySelector("#drawer");
                    const describe = (node) =>
                      node
                        ? {
                            tag: node.tagName,
                            id: node.id,
                            tabIndex: node.tabIndex,
                            disabled: node.matches(":disabled"),
                            hasLayout: node.getClientRects().length > 0,
                            dialog: node.closest("dialog")?.id || null,
                          }
                        : null;
                    return {
                      contained: dialog.contains(document.activeElement),
                      active: describe(document.activeElement),
                      openDialogs: [...document.querySelectorAll("dialog[open]")]
                        .map((node) => node.id)
                        .slice(0, 4),
                      candidates: [
                        ...dialog.querySelectorAll(
                          "button,a[href],input,select,textarea,summary,[tabindex]",
                        ),
                      ]
                        .slice(0, 16)
                        .map(describe),
                    };
                  });
                  const diagnostic = { scenario: name, area, key, step: i, ...focus };
                  if (!focus.contained)
                    await writeFile(
                      output + "/" + name + "-focus-failure.json",
                      JSON.stringify(diagnostic, null, 2),
                    );
                  assert.equal(focus.contained, true, JSON.stringify(diagnostic));
                }
              }
              await page.keyboard.press("Escape");
              assert.equal(
                await page
                  .locator("#queue-sample-drawer")
                  .evaluate((node) => node.contains(document.activeElement)),
                true,
              );
              await page.keyboard.press("Escape");
            }
            if (viewport.width < 1200) {
              await page.selectOption("#focused-stage", "applying");
              await page.locator("#next-stage").click();
              assert.equal(await page.locator("#focused-stage").inputValue(), "repairing");
              await page.locator("#previous-stage").click();
              assert.equal(await page.locator("#focused-stage").inputValue(), "applying");
              if (scenario === "normal") {
                for (const id of ["focused-stage", "previous-stage", "next-stage"]) {
                  await page.locator("#" + id).focus();
                  await page.setViewportSize({ width: 1440, height: 1000 });
                  await page.waitForFunction(() => document.activeElement?.id === "finder-input");
                  assert.equal(await page.locator("#finder-input").isVisible(), true);
                  await page.setViewportSize(viewport);
                  await page.waitForTimeout(150);
                }
              }
              await page.setViewportSize({ width: 1440, height: 1000 });
              await page.waitForTimeout(150);
              await captureMasterClearance(page, name + "-resize-desktop", true);
              await page.setViewportSize(viewport);
              await page.waitForTimeout(150);
              await captureMasterClearance(page, name + "-resize-return", true);
              assert.equal(await page.locator("#focused-stage").inputValue(), "applying");
            }
            const countBatch = initialRows.filter((row) => row.legacy_batch_path).length;
            if (scenario === "batch")
              assert.ok(countBatch > 0, "active fallback must be in the fixture");
            await page.selectOption("#inline-proof-filter", "not_requested");
            if (scenario === "unknown")
              assert.match(await page.locator(".journey-summary").innerText(), /Unavailable/);
            await page.selectOption("#review-paths", "direct");
            assert.equal(await page.locator("#inline-proof-filter").inputValue(), "not_requested");
            assert.equal(
              await page.locator('.stage .critter[data-key^="legacy:"]').count(),
              0,
              "direct selection must hide batch-classified active references",
            );
            if (!["empty", "unknown", "missing"].includes(scenario))
              assert.equal(
                await page.locator(".journey-summary .stat-value").innerText(),
                "1m 00s",
              );
            for (const area of ["completed", "attention"]) {
              if (viewport.width < 1200) await page.selectOption("#focused-stage", area);
              const expected = initialRows.filter(
                (row) => row.stage === area && !row.legacy_batch_path,
              );
              const section = page.locator(selector(area));
              const drawn = await section
                .locator(".critter")
                .evaluateAll((nodes) =>
                  nodes.map((node) => node.dataset.repository + "#" + node.dataset.number),
                );
              const expectedRefs = expected.map((row) => row.repository + "#" + row.item_number);
              assert.ok(
                drawn.every((reference) => expectedRefs.includes(reference)),
                "direct-only terminal slots must not include batch-classified outcomes",
              );
              assert.equal(drawn.length, Math.min(expected.length, area === "completed" ? 4 : 2));
              if (expected.length) {
                await section.locator("[data-overflow-stage]").click();
                const listed = await page
                  .locator("#queue-sample-body [data-overflow-reference]")
                  .allTextContents();
                assert.deepEqual(
                  [...listed].sort(),
                  [...expectedRefs].sort(),
                  "direct-only terminal list must contain exactly the selected sample",
                );
                await page.keyboard.press("Escape");
              }
            }
            await page.selectOption("#review-paths", "all");
            await page.selectOption("#inline-proof-filter", "all");
            if (geometry.plot) {
              const plot = page.locator(".journey-plot");
              await plot.focus();
              await page.keyboard.press("Home");
              const homeState = await page.evaluate(() => ({
                value: document.querySelector(".journey-plot")?.getAttribute("aria-valuenow"),
                active: {
                  tag: document.activeElement?.tagName,
                  id: document.activeElement?.id,
                  role: document.activeElement?.getAttribute("role"),
                },
                openDialogs: [...document.querySelectorAll("dialog[open]")].map((node) => node.id),
                trace: window.__bayInteractionTrace,
              }));
              if (homeState.value !== "0")
                await writeFile(
                  output + "/" + name + "-chart-home-failure.json",
                  JSON.stringify(homeState, null, 2),
                );
              assert.equal(homeState.value, "0", name + " Home key: " + JSON.stringify(homeState));
              await page.keyboard.press("End");
              assert.match(await plot.getAttribute("aria-valuetext"), /UTC.*median.*mean.*sample/);
              await page.keyboard.press("Escape");
              const bounds = await plot.boundingBox();
              await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 20);
              if (viewport.width <= 768)
                await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + 20);
              const refreshedEpoch = Math.max(Date.now() - 1000, epoch + 1000);
              const seed = await post(origin, "/fixture/snapshot", {
                scenario,
                epoch: refreshedEpoch,
              });
              assert.notEqual(seed.generated_at, current.status.bay.timings.window_ended_at);
              const responsePromise = page.waitForResponse(
                (response) =>
                  response.url() === origin + "/api/status" &&
                  response.request().method() === "GET",
                { timeout: 3000 },
              );
              await page.locator("#refresh-bay").click();
              const refreshedResponse = await responsePromise;
              assert.ok(refreshedResponse.ok());
              const refreshedStatus = await refreshedResponse.json();
              assert.equal(refreshedStatus.bay.timings.window_ended_at, seed.generated_at);
              await page.waitForFunction(
                (expected) =>
                  document.querySelector(".journey-chart")?.getAttribute("data-window-end") ===
                  expected,
                seed.generated_at,
              );
              await writeFile(
                output + "/" + name + "-refreshed-public.json",
                JSON.stringify(refreshedStatus, null, 2),
              );
            }
            await page.emulateMedia({ reducedMotion: "no-preference" });
            await page.locator(".view-menu > summary").click();
            await page.locator("#reduce-motion").uncheck();
            await page.locator('[data-brush="change"]').click();
            if (scenario === "normal" && viewport.width < 1200) {
              await page.selectOption("#focused-stage", "arriving");
              await page.locator('[data-brush="patrol"]').click();
              await page.waitForSelector('#master[data-phase="sweeping"]', { timeout: 10000 });
              const active = await captureMasterClearance(page, name + "-mobile-active-anchor");
              assert.equal(active.phase, "sweeping");
              assert.equal(active.checked, false, "intentional active overlaps remain allowed");
              assert.equal(
                active.layoutTop,
                activeMobileMasterTop(active.sceneHeight, active.layoutHeight),
                "active mobile anchor must use the scene, not the expanded beach/footer height",
              );
              // Return through the real appearance controls, not fixture DOM edits.
              await page.locator("#reduce-motion").check();
              await captureMasterClearance(page, name + "-mobile-after-active-rest", true);
              await page.locator("#reduce-motion").uncheck();
              await page.waitForSelector('#master[data-phase="sweeping"]', { timeout: 10000 });
              assert.equal(
                await page.locator('[data-brush="patrol"]').getAttribute("aria-pressed"),
                "true",
              );
              check(name + " patrol resumes after reduced motion is disabled");
              await page.locator("#reduce-motion").check();
              await captureMasterClearance(page, name + "-resumed-patrol-rest", true);
              await page.locator('[data-brush="change"]').click();
              await page.locator("#reduce-motion").uncheck();
            }
            await page.locator("#tide-preview").click();
            await page.waitForFunction(
              () => !document.querySelector("#beach").classList.contains("tide-active"),
              undefined,
              { timeout: 12000 },
            );
            if (scenario === "normal" && viewport.width === 1440) {
              await page.keyboard.press("Escape");
              await post(origin, "/fixture/snapshot", {
                scenario: "forward",
                epoch: Date.now() - 1000,
              });
              const movedResponse = page.waitForResponse(
                (response) =>
                  response.url() === origin + "/api/status" &&
                  response.request().method() === "GET",
                { timeout: 3000 },
              );
              await page.locator("#refresh-bay").click();
              assert.ok((await movedResponse).ok());
              await page.waitForSelector(".critter.being-swept", { timeout: 15000 });
              await captureMasterClearance(page, name + "-intentional-active-sweep");
              await page.locator("#finder-input").fill("openclaw/clawsweeper#91001");
              await page.locator("#finder-input").press("Enter");
              assert.equal(
                await page.evaluate(() => document.activeElement?.getAttribute("data-number")),
                "91001",
              );
              await page.waitForTimeout(6500);
              assert.equal(
                await page.locator("#master").getAttribute("data-phase"),
                "resting",
                "navigation must fence old sweep callbacks and leave a usable sweeper",
              );
              await captureMasterClearance(page, name + "-normal-motion-rest", true);
              await page.locator(".view-menu > summary").click();
              check(
                "finder interruption of an in-flight forward sweep parks and fences the visual state",
              );
            }
            await page.locator("#reduce-motion").check();
            await page.keyboard.press("Escape");
            assert.equal(await page.locator(".view-menu").evaluate((node) => node.open), false);
            await captureMasterClearance(page, name + "-reduced-rest", true);
            const remainingAnimations = await page.evaluate(() =>
              [...document.body.querySelectorAll("*")].flatMap((node) =>
                [null, "::before", "::after"]
                  .filter((pseudo) => getComputedStyle(node, pseudo).animationName !== "none")
                  .map((pseudo) => ({ tag: node.tagName, id: node.id, pseudo })),
              ),
            );
            assert.deepEqual(
              remainingAnimations,
              [],
              name + " manual reduced motion includes pseudo-elements",
            );
            if (scenario === "normal" && viewport.width === 1440) {
              const restored = await post(origin, "/fixture/snapshot", {
                scenario: "normal",
                epoch: Date.now() - 1000,
              });
              const restoredResponse = page.waitForResponse(
                (response) =>
                  response.url() === origin + "/api/status" &&
                  response.request().method() === "GET",
              );
              await page.locator("#refresh-bay").click();
              assert.ok((await restoredResponse).ok());
              await page.waitForFunction(
                (expected) =>
                  document.querySelector(".journey-chart")?.getAttribute("data-window-end") ===
                  expected,
                restored.generated_at,
              );
              const terminalCard = page.locator(".pool.completed .critter").first();
              await terminalCard.focus();
              assert.equal(
                await terminalCard.evaluate((node) => node === document.activeElement),
                true,
              );
              await post(origin, "/fixture/snapshot", {
                scenario: "empty",
                epoch: Date.now() - 1000,
              });
              const removedResponse = page.waitForResponse(
                (response) =>
                  response.url() === origin + "/api/status" &&
                  response.request().method() === "GET",
              );
              // Activate the real refresh handler without moving keyboard focus first.
              await page.locator("#refresh-bay").evaluate((button) => button.click());
              assert.ok((await removedResponse).ok());
              await page.waitForFunction(
                () => document.querySelectorAll(".pool.completed .critter").length === 0,
              );
              assert.equal(await page.evaluate(() => document.activeElement?.id), "finder-input");
              assert.equal(await page.locator("#finder-input").isVisible(), true);
              check(
                "desktop refresh removing a focused terminal card restores visible finder focus",
              );
            }
            if (scenario === "normal") {
              await page.locator(".view-menu > summary").click();
              await page.locator("#reduce-motion").uncheck();
              const nativeMotionState = await page.evaluate(() => {
                const target =
                  document.querySelector(".critter") || document.querySelector("#master");
                window.__bayProofAnimation = target.animate([{ opacity: 0.8 }, { opacity: 1 }], {
                  duration: 10000,
                });
                window.__bayProofAnimation.finished.catch(() => {});
                return window.__bayProofAnimation.playState;
              });
              assert.equal(nativeMotionState, "running");
              await page.emulateMedia({ reducedMotion: "reduce" });
              await page.waitForFunction(
                () => window.__bayProofAnimation.playState === "idle",
                undefined,
                { timeout: 3000 },
              );
              await page.waitForFunction(() => {
                const control = document.querySelector("#reduce-motion");
                return control.checked && control.disabled;
              });
              await page.emulateMedia({ reducedMotion: "no-preference" });
              await page.waitForFunction(() => {
                const control = document.querySelector("#reduce-motion");
                return !control.checked && !control.disabled;
              });
              await page.locator("#reduce-motion").check();
              await page.emulateMedia({ reducedMotion: "reduce" });
              await page.waitForFunction(() => document.querySelector("#reduce-motion").disabled);
              await page.emulateMedia({ reducedMotion: "no-preference" });
              await page.waitForFunction(() => {
                const control = document.querySelector("#reduce-motion");
                return control.checked && !control.disabled;
              });
              await page.keyboard.press("Escape");
              await captureMasterClearance(page, name + "-system-preference-rest", true);
              check(
                name +
                  " system motion preference changes synchronize control and retain manual choice",
              );
            }
            check(
              name +
                " current-page samples, areas, chart, cohorts, controls, focus and observer-only motion",
            );
          }
          assert.ok(
            traffic.every(
              (request) => request.method === "GET" && new URL(request.url).origin === server,
            ),
            name + " browser attempted mutation or external request",
          );
          networks.push({ name, version, requests: traffic });
        } catch (error) {
          contextFailure = error;
          throw error;
        } finally {
          try {
            await context.tracing.stop({ path: output + "/" + name + "-" + version + ".zip" });
          } catch (error) {
            if (!contextFailure) throw error;
            console.error("Trace cleanup failed after the original proof failure:", error);
          } finally {
            try {
              await context.close();
            } catch (error) {
              if (!contextFailure) throw error;
              console.error("Context cleanup failed after the original proof failure:", error);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(errors, []);
  check("all browser traffic stays same-origin GET; no queue/workflow/GitHub mutation attempts");
  completed = true;
} finally {
  await writeFile(output + "/measurements.json", JSON.stringify(measurements, null, 2));
  await writeFile(output + "/settled-master.json", JSON.stringify(masterMeasurements, null, 2));
  await writeFile(output + "/network.json", JSON.stringify(networks, null, 2));
  await writeFile(
    output + "/summary.json",
    JSON.stringify(
      {
        status: completed && errors.length === 0 ? "PASS" : "INCOMPLETE",
        candidate: process.env.BAY_PROOF_CANDIDATE,
        base: process.env.BAY_PROOF_BASE,
        provider: process.env.BAY_PROOF_PROVIDER,
        image: process.env.BAY_PROOF_IMAGE,
        lease: process.env.BAY_PROOF_LEASE,
        checks,
        errors,
        limits:
          "Controlled fixture snapshots persist through real StatusStore DO and production cached /api/status projection. Separate real ExactReviewQueue admission/finalization exercised. No live producers or upstream workflow behavior proved. Human screenshot inspection remains required.",
      },
      null,
      2,
    ),
  );
  await browser.close();
}
