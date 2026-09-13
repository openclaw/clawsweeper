import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  renderMaintainerReportMessage,
  resolveDailyReportPointer,
  runMaintainerReportNotifier,
} from "../../dist/repair/notify-maintainer-report.js";

const report = {
  period: { period: "day", key: "2026-05-22", title: "Daily Report 2026-05-22" },
  totals: {
    github: { commits: 271, prsMerged: 82, issueComments: 250 },
    discord: { messages: 327 },
  },
  maintainerCount: 45,
  activeMaintainers: 24,
  summary: {
    highlights: [
      "Core platform shipped runtime and UI work.",
      "Security and policy threads covered secret redaction.",
      "Integration work spanned Discord, Slack, and Telegram.",
      "This fourth item is intentionally omitted.",
    ],
  },
  maintainers: [],
};

test("resolveDailyReportPointer picks the requested daily entry", () => {
  const pointer = resolveDailyReportPointer({
    baseUrl: "https://reports.openclaw.ai/",
    date: "2026-05-21",
    index: {
      latest: {
        day: {
          period: "day",
          key: "2026-05-22",
          href: "day/2026-05-22/",
          data: "day/2026-05-22/data.json",
        },
      },
      entries: [
        {
          period: "day",
          key: "2026-05-21",
          href: "day/2026-05-21/",
          data: "day/2026-05-21/data.json",
        },
      ],
    },
  });

  assert.deepEqual(pointer, {
    date: "2026-05-21",
    reportUrl: "https://reports.openclaw.ai/day/2026-05-21/",
    dataUrl: "https://reports.openclaw.ai/day/2026-05-21/data.json",
  });
});

test("renderMaintainerReportMessage summarizes metrics, highlights, and link", () => {
  const message = renderMaintainerReportMessage({
    report,
    reportUrl: "https://reports.openclaw.ai/day/2026-05-22/",
  });

  assert.match(message, /OpenClaw maintainer report: May 22, 2026/);
  assert.match(
    message,
    /24\/45 active; 271 commits, 82 merged PRs, 250 issue\/PR comments, 327 Discord messages/,
  );
  assert.match(message, /Core platform shipped runtime and UI work/);
  assert.doesNotMatch(message, /fourth item/);
  assert.match(message, /Full report: https:\/\/reports\.openclaw\.ai\/day\/2026-05-22\//);
});

test("runMaintainerReportNotifier fetches the live report and posts the hook", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-maintainer-report-"));
  const requests: {
    url: string;
    body: Record<string, unknown> | null;
    idempotency: string | null;
  }[] = [];
  const reportFetchHeaders: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://reports.openclaw.ai/")) {
      reportFetchHeaders.push(new Headers(init?.headers).get("cf-access-client-id") ?? "");
    }
    if (url.endsWith("/index.json")) {
      return Response.json({
        latest: {
          day: {
            period: "day",
            key: "2026-05-22",
            href: "day/2026-05-22/",
            data: "day/2026-05-22/data.json",
          },
        },
        entries: [],
      });
    }
    if (url.endsWith("/day/2026-05-22/data.json")) {
      return Response.json(report);
    }
    requests.push({
      url,
      body: JSON.parse(String(init?.body)),
      idempotency: new Headers(init?.headers).get("idempotency-key"),
    });
    return Response.json({
      runId: "hook-run-1",
      completion: {
        status: "ok",
        replyDisposition: "visible",
        delivered: true,
        deliveryAttempted: true,
      },
    });
  };

  const summary = await runMaintainerReportNotifier(["--write-report"], {
    root,
    fetch: fetcher,
    log: () => undefined,
    now: () => new Date("2026-05-22T12:00:00.000Z"),
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
      REPORTS_ACCESS_CLIENT_ID: "access-id",
      REPORTS_ACCESS_CLIENT_SECRET: "access-secret",
    },
  });

  assert.equal(summary.sent, 1);
  assert.equal(summary.date, "2026-05-22");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://claw.example/hooks/agent");
  assert.equal(requests[0]?.idempotency, "maintainer-report:2026-05-22");
  assert.equal(requests[0]?.body?.deliver, true);
  assert.equal(requests[0]?.body?.waitForCompletion, true);
  assert.deepEqual(reportFetchHeaders, ["access-id", "access-id"]);
  assert.match(
    String(requests[0]?.body?.message),
    /Full report: https:\/\/reports\.openclaw\.ai\/day\/2026-05-22\//,
  );

  const notification = JSON.parse(
    fs.readFileSync(path.join(root, "notifications/maintainer-report-discord.json"), "utf8"),
  );
  assert.equal(notification.hook_run_id, "hook-run-1");
  assert.deepEqual(notification.delivery, {
    status: "delivered",
    suppression_reason: null,
    error: null,
  });
  assert.equal(notification.report_url, "https://reports.openclaw.ai/day/2026-05-22/");
});

test("runMaintainerReportNotifier supports dry-run and strict missing config", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/index.json")) {
      return Response.json({
        latest: {
          day: {
            period: "day",
            key: "2026-05-22",
            href: "day/2026-05-22/",
            data: "day/2026-05-22/data.json",
          },
        },
      });
    }
    return Response.json(report);
  };

  const dryRun = await runMaintainerReportNotifier(["--dry-run"], {
    fetch: fetcher,
    log: () => undefined,
    env: {
      CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://claw.example/hooks",
      CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "secret",
      CLAWSWEEPER_DISCORD_TARGET: "channel:123",
    },
  });
  assert.equal(dryRun.sent, 1);

  const missingConfig = await runMaintainerReportNotifier(["--strict"], {
    fetch: fetcher,
    log: () => undefined,
    env: {},
  });
  assert.equal(missingConfig.status, "skipped");
  assert.equal(missingConfig.exitCode, 1);
});
