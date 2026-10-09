import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

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
  const workflow = parse(
    fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8"),
  ) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const run = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.name === "Publish automatic implementation completion status")?.run;
  assert.ok(run);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-status-step-"));
  try {
    const prUrl = "https://github.com/steipete/example/pull/43";
    const runDir = path.join(root, ".clawsweeper-repair/runs/run-1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "fix-execution-report.json"),
      JSON.stringify({ actions: [{ action: "open_fix_pr", status: "opened", pr_url: prUrl }] }),
    );
    fs.writeFileSync(
      path.join(runDir, "post-flight-report.json"),
      JSON.stringify({
        actions: [
          {
            action: "finalize_fix_pr",
            source_action: "open_fix_pr",
            status: "blocked",
            target: prUrl,
            reason: "checks are still running: build",
          },
        ],
      }),
    );
    const argsPath = path.join(root, "args");
    const result = spawnSync("bash", ["-c", `pnpm() { printf '%s\\0' "$@" > "$ARGS"; }\n${run}`], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ARGS: argsPath,
        EXECUTE_OUTCOME: "success",
        POST_FLIGHT_OUTCOME: "success",
        CLUSTER_JOB_PATH: "jobs/steipete/inbox/issue-42.md",
        CLUSTER_RUN_URL: options.runUrl,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = fs.readFileSync(argsPath, "utf8").split("\0");
    assert.equal(args[args.indexOf("--state") + 1], "PR Opened");
    assert.equal(
      args[args.indexOf("--detail") + 1],
      "The implementation PR is open. Post-flight status: checks are still running: build",
    );
    assert.equal(args[args.indexOf("--pr-url") + 1], prUrl);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
