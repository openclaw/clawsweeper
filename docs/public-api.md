# Public observer API

- Status: active operator reference
- Owner: ClawSweeper dashboard maintainers
- Source of truth: `dashboard/worker.ts` request routing and its focused tests
- Last verified: `openclaw/clawsweeper@a1795973a9e6bb00b73cd6adc21a4ea02ca78ced`
- Update when: a public observer route, method, query parameter, response source, or authentication boundary changes
- Checked by: `pnpm run check:docs`

The dashboard Worker exposes the following unauthenticated observer routes. They
support current dashboard and operator diagnostics; this inventory does not
promise a versioned compatibility period. Routes under `/internal/`, event
ingest, and the GitHub webhook are mutation or trust-boundary surfaces and are
deliberately not public API. `ANY` records a current method-agnostic routing
branch, not a promise that every method will remain supported.

| Route                                    | Method | Purpose and authoritative source                                                            |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `/api/health`                            | `ANY`  | Service liveness and deployed source marker from the Worker environment.                    |
| `/api/exact-review-queue`                | `GET`  | Exact-review queue statistics from the queue Durable Object.                                |
| `/api/durable-lifecycle-bay`             | `GET`  | Durable lifecycle Bay projection from `durableLifecycleBaySnapshot`.                        |
| `/api/live-activity-bay`                 | `GET`  | Live activity Bay projection from `liveActivityBaySnapshotForRequest`.                      |
| `/api/recent-durable-publication-events` | `GET`  | Recent durable publication events from the queue Durable Object; forwards query parameters. |
| `/api/exact-review-queue/item`           | `GET`  | One queue item's status; forwards query parameters.                                         |
| `/api/exact-review-queue/reviews`        | `GET`  | Per-item review lookup used by observer surfaces.                                           |
| `/api/review-observability`              | `GET`  | Review observability from the queue Durable Object; forwards query parameters.              |
| `/api/github-egress-observability`        | `GET`  | Sanitized publication GitHub egress rollups for `hours=0.25`, `1`, `6`, or `24`.              |
| `/api/review-coverage`                   | `GET`  | Review coverage from the queue Durable Object.                                              |
| `/api/apply-observability`               | `GET`  | Apply-lane observability from `applyObservabilityJson`.                                     |
| `/api/health-history`                    | `GET`  | Historical health from `healthHistoryJson`.                                                 |
| `/api/automerge-metrics`                 | `GET`  | Automerge metrics from `automergeMetricsJson`.                                              |
| `/api/status`                            | `ANY`  | Main dashboard status payload from `statusJson`.                                            |
| `/api/triage`                            | `ANY`  | Issue-triage payload from `triageJson`.                                                     |
| `/api/pr-proof-triage`                   | `ANY`  | Pull-request proof-triage payload from `prProofTriageJson`.                                 |

`config/operator-documentation.json` is the checked route inventory. Adding or
removing a literal observer route in `dashboard/worker.ts` requires updating
that manifest and this table. The checker excludes `/api/events`, because it is
an ingest mutation rather than an observer route.

For egress field interpretation, use
[GitHub publication egress telemetry](github-egress-telemetry.md). For other
fields, use [Live dashboard](live-dashboard.md). For the rendered lane model,
use [OpenClaw Bay](openclaw-bay-demo.md).
