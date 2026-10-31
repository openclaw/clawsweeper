// External-only fixtures for proof-repository-collections.mjs; never imported by production.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const fixture = JSON.parse(
  readFileSync(
    resolve(process.env.CS1_PROOF_ROOT, "dashboard-site/fixtures/dashboard.json"),
    "utf8",
  ),
);
// Controlled external snapshot for the landed warning-evidence consumer, not live telemetry.
fixture.queue.warning_evidence = {
  sample_limit: 10,
  groups: [
    {
      kind: "scanner_refused",
      total: 1,
      items: [
        {
          repository: "openclaw/clawsweeper",
          item_number: 1,
          item_kind: "issue",
          revision: 1,
          review_failure_attempts: null,
          observed_at: "2026-10-30T12:00:00Z",
          next_retry_at: null,
          failure: null,
        },
      ],
    },
    { kind: "review_retry_exhausted", total: 0, items: [] },
    { kind: "stale_revision", total: 0, items: [] },
  ],
  repeated_claims: { total: 0, items: [] },
};
const fixed = Date.parse("2026-10-30T12:00:00Z");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [fixed]));
  }
  static now() {
    return fixed;
  }
};
const response = (data, status = 200) => Response.json(data, { status });
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (options?.method && options.method !== "GET") throw new Error("Fixture forbids mutations");
  const publicNames = ["openclaw/openclaw", "openclaw/clawsweeper", "openclaw/clawhub"];
  if (url.origin === "https://api.github.com") {
    if (url.pathname === "/users/openclaw/repos")
      return response(
        publicNames.map((full_name) => ({ full_name, visibility: "public", private: false })),
      );
    if (url.pathname === "/users/fixture-withdrawn/repos") return response([]);
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs")
      return response({ total_count: 0, workflow_runs: [] });
    if (url.pathname.startsWith("/repos/")) {
      const name = url.pathname.slice(7);
      if (publicNames.includes(name))
        return response({ full_name: name, visibility: "public", private: false });
      if (name === "fixture-private/not-published") return response({}, 404);
      if (name === "fixture-withdrawn/not-published")
        return process.env.CS1_PROOF_PHASE === "corpus"
          ? response({ visibility: "public", private: false })
          : response({}, 404);
    }
  }
  if (url.origin === "https://clawsweeper.openclaw.ai") {
    if (url.pathname === "/api/exact-review-queue") return response(fixture.queue);
    if (url.pathname === "/api/review-coverage") return response(fixture.coverage);
    if (url.pathname === "/api/health-history")
      return response({ generated_at: new Date().toISOString(), samples: [] });
    if (url.pathname === "/api/apply-observability") return response({});
  }
  throw new Error(`Unexpected external proof request: ${url.origin}${url.pathname}`);
};
