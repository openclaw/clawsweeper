import { assert, test, worker } from "./dashboard-worker-harness.ts";

const ORIGIN = "https://clawsweeper.openclaw.ai";

test("agent pages preserve GET, HEAD and redirects without proxying mutations or credentials", async () => {
  const originalFetch = globalThis.fetch;
  const upstream: Array<{ url: string; method: string; headers: Headers }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    upstream.push({ url: request.url, method: request.method, headers: request.headers });
    if (new URL(request.url).pathname === "/agent") {
      return new Response(null, {
        status: 308,
        headers: { location: "https://clawsweeper-dashboard.pages.dev/agent/" },
      });
    }
    return new Response(request.method === "HEAD" ? null : "<title>Agent performance</title>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
  try {
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}/agent/?view=proof`, {
          method,
          headers: { accept: "text/html", authorization: "Bearer private", cookie: "private=1" },
        }),
        {},
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(
        await response.text(),
        method === "HEAD" ? "" : "<title>Agent performance</title>",
      );
      const request = upstream.at(-1)!;
      assert.equal(request.url, "https://clawsweeper-dashboard.pages.dev/agent/?view=proof");
      assert.equal(request.method, method);
      assert.deepEqual([...request.headers], [["accept", "text/html"]]);
    }
    const redirect = await worker.fetch(new Request(`${ORIGIN}/agent`), {});
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/agent/");
    const count = upstream.length;
    for (const request of [
      new Request(`${ORIGIN}/agent/`, { method: "POST" }),
      new Request(`${ORIGIN}/agent-admin`),
      new Request(`${ORIGIN}/agents/`),
    ]) {
      assert.equal((await worker.fetch(request, {})).status, 404);
    }
    assert.equal(upstream.length, count);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
