import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";

import { exactReviewTerminalRun } from "../dashboard/exact-review-queue.ts";
import { githubAppJson, GitHubRequestError } from "../dashboard/github-api.ts";

const readers = {
  queue: () => exactReviewTerminalRun("synthetic-token", { runId: "1", claimGeneration: 1 }),
  app: () => githubAppJson("/fixture", "synthetic-token"),
};

for (const [name, read] of Object.entries(readers)) {
  for (const status of [200, 503, 429]) {
    test(`${name} bounds a stalled ${status} body and preserves its error class`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort("timeout"), milliseconds);
        return controller.signal;
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let bodyController!: ReadableStreamDefaultController;
      t.mock.method(globalThis, "fetch", async (_input, init: RequestInit) => {
        const response = new Response(
          new ReadableStream({
            start(controller) {
              bodyController = controller;
              init.signal!.addEventListener(
                "abort",
                () => controller.error(new DOMException("body aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { status, headers: status === 429 ? { "retry-after": "7" } : {} },
        );
        const text = response.text.bind(response);
        response.text = () => {
          markStarted();
          return text();
        };
        return response;
      });
      const outcome = read().then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      t.after(() => bodyController.error(new Error("fixture cleanup")));
      await started;
      t.mock.timers.tick(4500);
      const result = await Promise.race([outcome, nextTurn().then(() => null)]);
      assert.notEqual(result, null, "body remained pending after the request deadline");
      assert.ok(result && "error" in result);
      assert.ok(result.error instanceof GitHubRequestError);
      assert.equal(result.error.timedOut, status === 200);
      assert.equal(result.error.status, status === 200 ? undefined : status);
      assert.equal(result.error.rateLimited, status === 429);
      if (status === 429) assert.ok(result.error.rateLimitHint);
    });
  }

  test(`${name} preserves JSON parse failures after a successful body read`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
    await assert.rejects(read(), SyntaxError);
  });
}
