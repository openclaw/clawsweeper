import { assert, test, worker } from "./dashboard-worker-harness.ts";

const ORIGIN = "https://clawsweeper.openclaw.ai";

test("dashboard pages come from the Pages site; webhooks, APIs and Bay stay on the Worker", async () => {
  const originalFetch = globalThis.fetch;
  const upstream: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    upstream.push(url);
    if (url.endsWith("/queue")) {
      return new Response(null, {
        status: 308,
        headers: { location: "https://clawsweeper-dashboard.pages.dev/queue/" },
      });
    }
    return new Response("<title>Overview · ClawSweeper</title>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
  try {
    const overview = await worker.fetch(new Request(`${ORIGIN}/`), {});
    assert.equal(overview.status, 200);
    assert.match(await overview.text(), /Overview · ClawSweeper/);
    assert.deepEqual(upstream, ["https://clawsweeper-dashboard.pages.dev/"]);

    // A Pages trailing-slash redirect keeps the visitor on the Worker host.
    const queue = await worker.fetch(new Request(`${ORIGIN}/queue`), {});
    assert.equal(queue.status, 308);
    assert.equal(queue.headers.get("location"), "/queue/");

    upstream.length = 0;
    for (const path of ["/repos/openclaw-openclaw/", "/operations/"]) {
      await worker.fetch(new Request(`${ORIGIN}${path}`), {
        DASHBOARD_SITE_ORIGIN: "https://preview.clawsweeper-dashboard.pages.dev",
      });
    }
    assert.deepEqual(upstream, [
      "https://preview.clawsweeper-dashboard.pages.dev/repos/openclaw-openclaw/",
      "https://preview.clawsweeper-dashboard.pages.dev/operations/",
    ]);

    upstream.length = 0;
    for (const request of [
      new Request(`${ORIGIN}/`, { method: "POST" }),
      new Request(`${ORIGIN}/github/webhook`, { method: "POST" }),
      new Request(`${ORIGIN}/bay`),
      new Request(`${ORIGIN}/triage`),
      new Request(`${ORIGIN}/api/health`),
      new Request(`${ORIGIN}/queue-admin`),
    ]) {
      await worker.fetch(request, {}).catch(() => undefined);
    }
    assert.equal(
      upstream.some((url) => url.includes("clawsweeper-dashboard.pages.dev")),
      false,
      "only GET/HEAD dashboard page paths go to Pages",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
