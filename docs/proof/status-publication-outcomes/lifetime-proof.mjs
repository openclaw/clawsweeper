import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright-core";

export async function proveLifetime(origin, revision, artifacts) {
  const results = [];
  for (const stall of ["read", "body"]) {
    await post("/__proof/lifetime", { stall });
    const publications = await get("/api/recent-durable-publication-events");
    assert.equal(publications.recent_durable_publication_events?.direct.counts.accepted, 1);
    const started = Date.now();
    let settled = false;
    const pending = fetch(origin + "/api/status", { signal: AbortSignal.timeout(25_000) }).then(
      async (response) => {
        settled = true;
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      },
    );
    const outcome = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve(null), 19_500)),
    ]);
    const elapsed = Date.now() - started;
    const held = await get("/__proof/observations");
    if (revision === "base") {
      assert.equal(settled, false, "baseline must reproduce the stalled HTTP response");
    } else {
      assert.ok(outcome && elapsed < 19_500, "candidate must return within the collection bound");
      assert.equal(outcome.public_projection_complete, false);
      assert.equal(outcome.freshness.state, "unavailable");
      assert.equal(held.snapshot_writes, 0, "unavailable snapshot must never be persisted");
      assert.equal(held.snapshot_reads, 1, "deadline must stop admission after the held read");
    }
    await post("/__proof/release");
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const released = await get("/__proof/observations");
    if (revision === "candidate") {
      assert.equal(released.snapshot_writes, 0, "late completion must not publish partial status");
      assert.equal(released.snapshot_reads, 1, "late completion must not start a sibling read");
    }
    const healthy = await get("/api/status");
    assert.equal(healthy.public_projection_complete, true);
    assert.equal(healthy.fleet.active_codex_jobs, 17);
    assert.equal(healthy.recent_durable_publication_events.direct.counts.accepted, 1);
    results.push({
      stall,
      elapsed_ms: elapsed,
      timed_out: !outcome,
      held,
      released,
      healthy_next_refresh: true,
    });
  }
  let persistenceProof = null;
  let browserProof = null;
  if (revision === "candidate") {
    persistenceProof = await provePersistence();
    browserProof = await proveClients();
  }
  return { revision, results, persistence: persistenceProof, browser: browserProof };

  async function provePersistence() {
    await post("/__proof/lifetime", { stall: "write", count: 17, ttl: 5 });
    try {
      const first = await get("/api/status");
      assert.equal(first.fleet.active_codex_jobs, 17);
      await new Promise((resolve) => setTimeout(resolve, 5_500));
      await post("/__proof/lifetime", { advance: true, count: 18, ttl: 5 });
      const next = await get("/api/status");
      assert.equal(next.fleet.active_codex_jobs, 18);
      const beforeRelease = await observeUntil((value) => value.snapshot_publications === 1);
      assert.equal(beforeRelease.snapshot_writes, 2);
      assert.equal(beforeRelease.stored_status.active_codex_jobs, 18);
      assert.equal(beforeRelease.stored_status.generated_at, next.generated_at);
      await post("/__proof/release");
      const afterRelease = await observeUntil((value) => value.snapshot_publications === 2);
      assert.equal(afterRelease.stored_status.active_codex_jobs, 17);
      assert.equal(afterRelease.stored_status.generated_at, first.generated_at);
      assert.equal(afterRelease.stored_status.canonical_freshness.state, "stale");
      const observed = await get("/api/status");
      if (observed.fleet.active_codex_jobs === 17) {
        assert.equal(observed.generated_at, first.generated_at);
        assert.equal(observed.freshness.state, "stale");
      } else {
        assert.equal(observed.fleet.active_codex_jobs, 18);
        assert.equal(observed.freshness.state, "fresh");
      }
      return {
        held_write_does_not_block_new_publication: true,
        before_release: beforeRelease,
        after_release: afterRelease,
        durable_freshness_proof: "canonical publicStatusFreshness projection of stored body",
        next_http_status: {
          active_codex_jobs: observed.fleet.active_codex_jobs,
          generated_at: observed.generated_at,
          freshness: observed.freshness,
        },
      };
    } finally {
      await post("/__proof/release");
    }
  }

  async function observeUntil(predicate) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const observations = await get("/__proof/observations");
      if (predicate(observations)) return observations;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("durable publication did not reach the expected terminal state");
  }

  async function proveClients() {
    await post("/__proof/lifetime", { stall: "read" });
    const browser = await chromium.launch({ headless: true });
    const errors = [];
    const responses = [];
    const denied = [];
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.route("**/*", (route) => {
        const request = route.request();
        if (new URL(request.url()).origin !== origin || request.method() !== "GET") {
          denied.push(new URL(request.url()).protocol);
          return route.abort();
        }
        return route.continue();
      });
      const pages = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of pages) {
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", async (response) => {
          if (new URL(response.url()).pathname === "/api/status") {
            responses.push(await response.json());
          }
        });
      }
      await Promise.all(
        pages.map((page, index) =>
          page.goto(origin + (index ? "/bay" : "/"), { waitUntil: "domcontentloaded" }),
        ),
      );
      await pages[0].waitForFunction(() => loading === false, undefined, { timeout: 19_500 });
      await pages[1].waitForFunction(
        () => document.getElementById("notice").textContent === "Live status unavailable",
        undefined,
        { timeout: 19_500 },
      );
      assert.equal(
        responses.filter((value) => value.public_projection_complete === false).length,
        2,
      );
      assert.equal(
        await pages[0].evaluate(() => localStorage.getItem("clawsweeper:last-status")),
        null,
      );
      const unavailableCaption = await pages[0].locator("#updated").textContent();
      assert.equal(
        unavailableCaption,
        "Status freshness unavailable · GitHub telemetry is incomplete.",
      );
      for (let index = 0; index < pages.length; index += 1) {
        await pages[index].screenshot({
          path: path.join(artifacts, `lifetime-${index ? "bay" : "dashboard"}-unavailable.png`),
        });
      }
      await post("/__proof/release");
      // Dashboard polls every 15 seconds and Bay every 20; neither is reloaded or given a replacement response.
      await pages[0].waitForFunction(
        () => {
          const stored = localStorage.getItem("clawsweeper:last-status");
          return stored && JSON.parse(stored).fleet.active_codex_jobs === 17;
        },
        undefined,
        { timeout: 25_000 },
      );
      await pages[1].waitForFunction(
        () => !document.getElementById("notice").classList.contains("show"),
        undefined,
        { timeout: 25_000 },
      );
      const recoveredCaption = await pages[0].locator("#updated").textContent();
      assert.match(recoveredCaption, /^Updated /);
      assert.doesNotMatch(recoveredCaption, /unavailable|incomplete/);
      assert.ok(responses.filter((value) => value.public_projection_complete === true).length >= 2);
      assert.deepEqual(errors, []);
      for (let index = 0; index < pages.length; index += 1) {
        await pages[index].screenshot({
          path: path.join(artifacts, `lifetime-${index ? "bay" : "dashboard"}-recovered.png`),
        });
      }
      return {
        version: browser.version(),
        surfaces: ["Dashboard", "Bay"],
        automatic_next_poll: true,
        unavailable_caption: unavailableCaption,
        recovered_caption: recoveredCaption,
        unavailable_responses: 2,
        script_errors: errors,
        external_requests_denied: denied.length,
      };
    } finally {
      await post("/__proof/release");
      await browser.close();
    }
  }
  async function get(route) {
    const response = await fetch(origin + route, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  async function post(route, body = {}) {
    const response = await fetch(origin + route, {
      method: "POST",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, await response.clone().text());
  }
}
