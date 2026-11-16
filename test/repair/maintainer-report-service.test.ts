import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { readPublishedDailyReport } from "../../dist/repair/maintainer-report-service.js";
import {
  renderMaintainerReportMessage,
  runMaintainerReportNotifier,
} from "../../dist/repair/notify-maintainer-report.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const destination = "https://reports.example/service/";
const snapshotRevision = `report-publications-v1:${"a".repeat(64)}`;
function fixture() {
  const period = {
    period: "day",
    key: "2026-05-22",
    title: "Daily Report 2026-05-22",
    hours: 24,
    since: "2026-05-22T00:00:00.000Z",
    until: "2026-05-23T00:00:00.000Z",
  };
  const coverage = [
    {
      source: "github",
      family: "commits",
      state: "partial",
      snapshot_id: "fixture",
      since: period.since,
      until: period.until,
      covered_until: "2026-05-22T12:00:00.000Z",
    },
  ];
  const acknowledgment = {
    policyRevision: "report-publication/v1",
    mode: "reviewed",
    sourcePolicyRevision: "",
    sourceCheckpoints: [],
    coverageSha256: sha(JSON.stringify(coverage)),
    gapsSha256: sha(JSON.stringify(coverage)),
    acknowledgedGaps: 1,
    githubWarningsSha256: sha("[]"),
  };
  const report = {
    period,
    window: { since: period.since, until: period.until },
    sources: {
      publicProjection: "report-public/v1",
      coverage,
      github: { errors: [] },
      database: {
        version: "version-1",
        cutoff: "2026-05-22T12:00:00.000Z",
        identitySha256: "b".repeat(64),
        complete: false,
        acceptance: acknowledgment,
      },
    },
    totals: { github: { commits: 3, prsMerged: 0, issueComments: 0 }, discord: { messages: 0 } },
    activeMaintainers: 2,
    maintainerCount: 4,
    summary: { highlights: ["Unicode 🦊 full text"] },
    maintainers: [],
  };
  const decoded = JSON.stringify(report);
  const wire = JSON.stringify({
    schema: "report-json/v1",
    encoding: "deflate+base64",
    decodedBytes: Buffer.byteLength(decoded),
    decodedSha256: sha(decoded),
    data: deflateSync(decoded).toString("base64"),
  });
  const receipt = {
    schema: "report-accepted-export/v1",
    publicProjection: "report-public/v1",
    policyRevision: "report-publication/v1",
    acceptance: "c".repeat(64),
    bindingSha256: "d".repeat(64),
    identitySha256: "b".repeat(64),
    scopeSha256: "e".repeat(64),
    coverageSha256: acknowledgment.coverageSha256,
    gapsSha256: acknowledgment.gapsSha256,
    version: "version-1",
    cutoff: report.sources.database.cutoff,
    period,
    artifacts: { html: "f".repeat(64), markdown: "f".repeat(64), report: sha(wire) },
  };
  const page = {
    schema: "report-publication-catalog/v1",
    destination,
    snapshotRevision,
    totalEntries: 1,
    entries: [{ publishedAt: "2026-05-22T13:00:00.000Z", receipt }],
    nextCursor: null as string | null,
  };
  return { report, receipt, page, wire };
}

test("service notifier verifies encoded HTTP reports in dry-run without sending a hook", async () => {
  const data = fixture(),
    requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    assert.equal(request.headers["cf-access-client-id"], "fixture-id");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    response.end(
      request.url!.includes("/data?")
        ? data.wire
        : request.url!.includes("/acceptances/")
          ? JSON.stringify(data.receipt)
          : JSON.stringify(data.page),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const result = await runMaintainerReportNotifier(["--dry-run"], {
      log: () => {},
      env: {
        REPORTS_SERVICE_URL: `http://127.0.0.1:${address.port}/service-preview/`,
        REPORTS_SERVICE_DESTINATION: destination,
        REPORTS_ACCESS_CLIENT_ID: "fixture-id",
        REPORTS_ACCESS_CLIENT_SECRET: "fixture-secret",
        CLAWSWEEPER_OPENCLAW_HOOK_URL: "https://hook.invalid/",
        CLAWSWEEPER_OPENCLAW_HOOK_TOKEN: "fixture-hook",
      },
    });
    assert.equal(result.date, data.receipt.period.key);
    assert.equal(requests.length, 3);
    assert(requests.every((url) => url.startsWith("/service-preview/v1/reports/publications")));
    assert(
      requests.some((url) => url.includes(`snapshot=${encodeURIComponent(snapshotRevision)}`)),
    );
    assert.equal(result.reportUrl, "https://reports.openclaw.ai/#current-reports");
    assert(!result.reportUrl.includes("/day/"));
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("published report client rejects corrupt bytes, changed snapshots and unacknowledged coverage", async () => {
  for (const failure of ["wire", "snapshot", "coverage", "decoded"]) {
    const data = fixture();
    let calls = 0;
    if (failure === "coverage") {
      data.report.sources.database.acceptance.acknowledgedGaps = 0;
      data.wire = JSON.stringify(data.report);
      data.receipt.artifacts.report = sha(data.wire);
    }
    if (failure === "decoded") {
      const envelope = JSON.parse(data.wire);
      envelope.decodedSha256 = "0".repeat(64);
      data.wire = JSON.stringify(envelope);
      data.receipt.artifacts.report = sha(data.wire);
    }
    const fetcher: typeof fetch = async (input) => {
      calls++;
      const url = new URL(String(input));
      const body = url.pathname.endsWith("/data")
        ? data.wire + (failure === "wire" ? " " : "")
        : url.pathname.includes("/acceptances/")
          ? JSON.stringify(data.receipt)
          : JSON.stringify({
              ...data.page,
              ...(failure === "snapshot"
                ? {
                    totalEntries: 2,
                    nextCursor: calls === 1 ? "next" : null,
                    snapshotRevision:
                      calls === 1 ? snapshotRevision : `report-publications-v1:${"0".repeat(64)}`,
                  }
                : {}),
            });
      return new Response(body, { headers: { "Cache-Control": "no-store" } });
    };
    await assert.rejects(
      readPublishedDailyReport({
        baseUrl: "https://reports.example/service-preview/",
        destination,
        fetcher,
      }),
      /verification failed/,
    );
  }
});

test("catalog pagination is complete and pinned; explicit absent date never selects latest", async () => {
  const data = fixture(),
    calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const page = { ...data.page, totalEntries: 2 };
    if (url.searchParams.has("cursor")) {
      page.entries = [
        {
          ...data.page.entries[0]!,
          receipt: {
            ...data.receipt,
            period: { ...data.receipt.period, period: "week", key: "2026-W21" },
          },
        },
      ];
    } else page.nextCursor = "fixture_cursor";
    return Response.json(page, { headers: { "Cache-Control": "no-store" } });
  };
  assert.equal(
    await readPublishedDailyReport({
      baseUrl: "https://reports.example/",
      destination,
      date: "2026-05-21",
      fetcher,
    }),
    null,
  );
  assert.equal(calls.length, 2);
  const repeated: typeof fetch = async () =>
    Response.json(
      { ...data.page, totalEntries: 2, nextCursor: "repeat" },
      { headers: { "Cache-Control": "no-store" } },
    );
  await assert.rejects(
    readPublishedDailyReport({
      baseUrl: "https://reports.example/",
      destination,
      fetcher: repeated,
    }),
    /verification failed/,
  );
});

test("notification preserves coverage instead of rendering unavailable sources as zero", () => {
  const message = renderMaintainerReportMessage({
    report: fixture().report,
    reportUrl: "https://reports.example/#current-reports",
    service: true,
  });
  assert.match(message, /3 observed \(partial\) commits/);
  assert.match(message, /Unavailable merged PRs/);
  assert.match(message, /Partial source coverage/);
  assert.match(message, /Unicode 🦊 full text/);
  assert.match(message, /Report reader: https:\/\/reports\.example\/#current-reports/);
  assert.doesNotMatch(message, /Full report:|\/day\//);
});

test("live workflow reads the report service without a maintainer checkout", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/maintainer-report-discord.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /REPORTS_SERVICE_URL: https:\/\/reports\.openclaw\.ai\/service-preview\//);
  assert.match(workflow, /REPORTS_SERVICE_DESTINATION: https:\/\/reports\.openclaw\.ai\/service\//);
  assert.match(workflow, /REPORTS_ACCESS_CLIENT_ID/);
  assert.match(workflow, /REPORTS_ACCESS_CLIENT_SECRET/);
  assert.doesNotMatch(workflow, /REPORTS_BASE_URL|openclaw\/maintainers|create-github-app-token/);
});
