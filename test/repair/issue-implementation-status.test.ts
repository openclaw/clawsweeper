import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";

import {
  ISSUE_STATUS_INGEST_TIMEOUT_MS,
  issueImplementationStatusMarker,
  postDashboardStatus,
  renderIssueImplementationStatusComment,
} from "../../dist/repair/issue-implementation-status.js";

const options = {
  repo: "steipete/example",
  itemNumber: 42,
  state: "Planning",
  detail: "Codex is inspecting the issue and repository.",
  runUrl: "https://github.com/openclaw/clawsweeper/actions/runs/100",
  prUrl: "",
  title: "Add compact export mode",
};

test("issue implementation status creates a stable public progress comment", () => {
  const body = renderIssueImplementationStatusComment("", options);

  assert.match(body, new RegExp(issueImplementationStatusMarker(42)));
  assert.match(body, /automatically building a fix for this issue/);
  assert.match(body, /State: Planning/);
  assert.match(body, /clawsweeper:manual-only/);
  assert.match(body, /clawsweeper:human-review/);
});

test("issue implementation status includes a generated pull request", () => {
  const body = renderIssueImplementationStatusComment("", {
    ...options,
    state: "Blocked",
    prUrl: "https://github.com/steipete/example/pull/51",
  });

  assert.match(body, /PR: https:\/\/github\.com\/steipete\/example\/pull\/51/);
});

test("issue implementation status updates progress without replacing worker results", () => {
  const initial = renderIssueImplementationStatusComment("", options);
  const withResult = `${initial}\n\n## Implementation result\n\nPull request opened.`;
  const updated = renderIssueImplementationStatusComment(withResult, {
    ...options,
    state: "Complete",
    detail: "Implementation workflow completed.",
  });

  assert.doesNotMatch(updated, /Automatic implementation progress:/);
  assert.match(updated, /Automatic implementation completed\./);
  assert.doesNotMatch(updated, /## Implementation result/);
});

test("issue implementation status collapses an opened PR to a concise terminal comment", () => {
  const body = renderIssueImplementationStatusComment("", {
    ...options,
    state: "PR Opened",
    detail: "Checks continue on the pull request.",
    prUrl: "https://github.com/steipete/example/pull/51",
  });

  assert.match(
    body,
    /Implementation PR opened: https:\/\/github\.com\/steipete\/example\/pull\/51/,
  );
  assert.match(body, /Status: Checks continue on the pull request\./);
  assert.doesNotMatch(body, /Automatic implementation progress|Opt out|State:/);
});

test("issue build workflow reports an opened PR without calling pending CI blocked", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");

  assert.match(workflow, /state="PR Opened"/);
  assert.match(workflow, /The implementation PR is open\. Post-flight status:/);
  assert.doesNotMatch(
    workflow,
    /detail="The automatic implementation worker stopped before all post-flight gates passed:/,
  );
});

test("issue implementation status ingest skips when no token is configured", async () => {
  const previousToken = process.env.CLAWSWEEPER_STATUS_INGEST_TOKEN;
  const previousUrl = process.env.CLAWSWEEPER_STATUS_INGEST_URL;
  delete process.env.CLAWSWEEPER_STATUS_INGEST_TOKEN;
  delete process.env.CLAWSWEEPER_STATUS_INGEST_URL;
  try {
    assert.equal(await postDashboardStatus(options), "skipped");
  } finally {
    restoreEnv("CLAWSWEEPER_STATUS_INGEST_TOKEN", previousToken);
    restoreEnv("CLAWSWEEPER_STATUS_INGEST_URL", previousUrl);
  }
});

test(
  "issue implementation status ingest aborts a hung dashboard fetch",
  { timeout: 3_000 },
  async (t) => {
    const previousTimeout = AbortSignal.timeout;
    const previousToken = process.env.CLAWSWEEPER_STATUS_INGEST_TOKEN;
    const previousUrl = process.env.CLAWSWEEPER_STATUS_INGEST_URL;
    t.after(() => {
      AbortSignal.timeout = previousTimeout;
      restoreEnv("CLAWSWEEPER_STATUS_INGEST_TOKEN", previousToken);
      restoreEnv("CLAWSWEEPER_STATUS_INGEST_URL", previousUrl);
    });

    const server = http.createServer((_request, _response) => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;

    const seenTimeouts: number[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      seenTimeouts.push(ms);
      return previousTimeout(50);
    });

    process.env.CLAWSWEEPER_STATUS_INGEST_TOKEN = "status-secret";
    process.env.CLAWSWEEPER_STATUS_INGEST_URL = `${origin}/api/events`;

    await assert.rejects(
      () => postDashboardStatus(options),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.name, /AbortError|TimeoutError/);
        return true;
      },
    );
    assert.deepEqual(seenTimeouts, [ISSUE_STATUS_INGEST_TIMEOUT_MS]);
    assert.ok(ISSUE_STATUS_INGEST_TIMEOUT_MS >= 15_000);
    assert.ok(ISSUE_STATUS_INGEST_TIMEOUT_MS <= 30_000);
  },
);

test("issue implementation status ingest still publishes a successful event", async (t) => {
  const previousToken = process.env.CLAWSWEEPER_STATUS_INGEST_TOKEN;
  const previousUrl = process.env.CLAWSWEEPER_STATUS_INGEST_URL;
  t.after(() => {
    restoreEnv("CLAWSWEEPER_STATUS_INGEST_TOKEN", previousToken);
    restoreEnv("CLAWSWEEPER_STATUS_INGEST_URL", previousUrl);
  });

  const requests: Array<{ method?: string; url?: string; authorization?: string }> = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  process.env.CLAWSWEEPER_STATUS_INGEST_TOKEN = "status-secret";
  process.env.CLAWSWEEPER_STATUS_INGEST_URL = `http://127.0.0.1:${address.port}/api/events`;

  assert.equal(await postDashboardStatus(options), "sent");
  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "/api/events",
      authorization: "Bearer status-secret",
    },
  ]);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
