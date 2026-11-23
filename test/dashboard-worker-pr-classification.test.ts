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
