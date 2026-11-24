import {
  assert,
  test,
  worker,
  MemoryDurableNamespace,
  jsonResponse,
  signedGithubWebhookRequest,
} from "./dashboard-worker-harness.ts";

for (const [action, labels, state, locked, expected] of [
  ["opened", [], "open", false, 1],
  ["edited", [], "open", false, 1],
  ["reopened", [], "open", false, 1],
  ["ready_for_review", [], "open", false, 1],
  ["opened", [{ name: "p0" }], "open", false, 0],
  ["synchronize", [], "open", false, 0],
  ["labeled", [], "open", false, 0],
  ["opened", [], "closed", false, 0],
  ["opened", [], "open", true, 0],
] as const) {
  test(
    "standalone PR classification: " +
      action +
      " " +
      state +
      " " +
      JSON.stringify(labels) +
      " locked=" +
      locked,
    async (t) => {
      const dispatches: unknown[] = [];
      const pending: Promise<unknown>[] = [];
      let reviews = 0;
      t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/actions/workflows/pr-classification.yml/dispatches")) {
          assert.equal(init?.method, "POST");
          dispatches.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith("/permission")) return jsonResponse({ permission: "admin" });
        if (url.pathname.endsWith("/comments")) return jsonResponse([]);
        throw new Error("Unexpected request " + url.pathname);
      });
      const response = await worker.fetch(
        signedGithubWebhookRequest({
          event: "pull_request",
          secret: "fixture",
          payload: {
            action,
            installation: { id: 123 },
            repository: {
              full_name: "openclaw/fs-safe",
              private: false,
              archived: false,
              fork: false,
              has_issues: true,
              default_branch: "main",
            },
            sender: { login: "maintainer" },
            pull_request: {
              number: 42,
              title: "Fix startup",
              body: "Startup crashes",
              state,
              locked,
              labels,
              draft: true,
              author_association: "MEMBER",
              created_at: "2026-10-01T00:00:00Z",
              user: { login: "maintainer" },
              head: { sha: "a".repeat(40) },
            },
          },
        }),
        {
          CLAWSWEEPER_WEBHOOK_SECRET: "fixture",
          GITHUB_TOKEN: "synthetic",
          CLAWSWEEPER_FAST_ACK_SETTLE_DELAYS_MS: "0",
          hostedPublicTargetProbe: async () => "public" as const,
          EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
            async fetch(request: Request) {
              if (new URL(request.url).pathname === "/enqueue") reviews++;
              return jsonResponse({ ok: true });
            },
          }),
        },
        { waitUntil: (promise) => pending.push(promise) },
      );
      assert.ok(response.status >= 200 && response.status < 300, await response.clone().text());
      await Promise.all(pending);
      assert.equal(dispatches.length, expected);
      if (expected)
        assert.deepEqual(dispatches[0], {
          ref: "main",
          inputs: { target_repo: "openclaw/fs-safe", item_number: "42" },
        });
      assert.equal(reviews, 0, "classification must not admit a maintainer full review");
    },
  );
}

for (const maintainer of [false, true]) {
  for (const failDispatch of [false, true]) {
    test(
      "classification dispatch does not block review: maintainer=" +
        maintainer +
        " failure=" +
        failDispatch,
      async (t) => {
        const pending: Promise<unknown>[] = [];
        const trace: string[] = [];
        let settle!: () => void;
        const gate = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const pull = {
          number: 42,
          title: "Fix startup",
          body: "Startup crashes",
          state: "open",
          locked: false,
          labels: [],
          draft: false,
          author_association: maintainer ? "MEMBER" : "CONTRIBUTOR",
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:01:00Z",
          user: { login: maintainer ? "maintainer" : "contributor" },
          head: { sha: "a".repeat(40) },
        };
        t.mock.method(globalThis, "fetch", async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith("/actions/workflows/pr-classification.yml/dispatches")) {
            trace.push("classification-started");
            await gate;
            trace.push("classification-settled");
            if (failDispatch) throw new Error("controlled dispatch outage");
            return new Response(null, { status: 204 });
          }
          if (url.pathname.endsWith("/permission"))
            return jsonResponse({ permission: maintainer ? "admin" : "read" });
          if (url.pathname.endsWith("/pulls/42")) return jsonResponse(pull);
          throw new Error("Unexpected request " + url.pathname);
        });
        const responsePromise = worker.fetch(
          signedGithubWebhookRequest({
            event: "pull_request",
            secret: "fixture",
            payload: {
              action: "edited",
              installation: { id: 123 },
              repository: {
                full_name: "openclaw/fs-safe",
                private: false,
                archived: false,
                fork: false,
                has_issues: true,
                default_branch: "main",
              },
              sender: { login: "contributor" },
              pull_request: pull,
            },
          }),
          {
            CLAWSWEEPER_WEBHOOK_SECRET: "fixture",
            GITHUB_TOKEN: "synthetic",
            hostedPublicTargetProbe: async () => "public" as const,
            EXACT_REVIEW_QUEUE: new MemoryDurableNamespace({
              async fetch(request: Request) {
                const endpoint = new URL(request.url).pathname;
                if (endpoint === "/source-authority")
                  return jsonResponse({ source_authority_seq: 1 });
                if (endpoint === "/enqueue") {
                  trace.push("review-enqueued");
                  return jsonResponse({ ok: true, queued: true });
                }
                return jsonResponse({ ok: true });
              },
            }),
          },
          { waitUntil: (promise) => pending.push(promise) },
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([
            responsePromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Webhook blocked on classification")),
                2000,
              );
            }),
          ]);
          assert.equal(response.status, 202);
          const body = await response.json();
          assert.equal(trace.includes("classification-started"), true);
          assert.equal(trace.includes("classification-settled"), false);
          assert.equal(trace.includes("review-enqueued"), !maintainer);
          if (maintainer)
            assert.equal(body.reason, "maintainer review requires an explicit request");
          else assert.equal(body.queued, true);
          assert.ok(pending.length > 0, "Worker lifetime owns classification dispatch");
        } finally {
          clearTimeout(timer);
          settle();
          await Promise.all(pending);
          await responsePromise;
        }
        assert.equal(trace.at(-1), "classification-settled");
      },
    );
  }
}
