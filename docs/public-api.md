# Public observer API

- Status: active operator reference
- Owner: ClawSweeper dashboard maintainers
- Source of truth: `dashboard/worker.ts` request routing and its focused tests
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: a public observer route, method, query parameter, response source, or authentication boundary changes
- Checked by: `pnpm run check:docs`

The dashboard Worker exposes the following unauthenticated observer routes. They
support current dashboard and operator diagnostics; this inventory does not
promise a versioned compatibility period. Routes under `/internal/`, event
ingest, and the GitHub webhook are mutation or trust-boundary surfaces and are
deliberately not public API. `ANY` records a current method-agnostic routing
branch, not a promise that every method will remain supported.

| Route                                    | Method | Purpose and authoritative source                                                                     |
| ---------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `/api/health`                            | `ANY`  | Service liveness and deployed source marker from the Worker environment.                             |
| `/api/exact-review-queue`                | `GET`  | Closed queue aggregates plus a bounded allowlisted public repository/item reference sample.          |
| `/api/durable-lifecycle-bay`             | `GET`  | Lifecycle inventory, six closed lane counts, and a bounded verified-public item-card sample.         |
| `/api/live-activity-bay`                 | `GET`  | Five closed live-activity kind counts; fails closed for an incomplete census.                        |
| `/api/recent-durable-publication-events` | `GET`  | Closed outcome counts in a normalized `6h`, `24h`, or `7d` window.                                   |
| `/api/exact-review-queue/item`           | `GET`  | Stable aggregate-only unavailable response; does not perform a per-item lookup.                      |
| `/api/exact-review-queue/reviews`        | `GET`  | Stable empty aggregate-only envelope; ignores identifying query parameters.                          |
| `/api/review-observability`              | `GET`  | Global closed lane aggregates for a normalized `6h`, `24h`, or `7d` range.                           |
| `/api/github-egress-observability`       | `GET`  | Closed egress rollups and bounded throttle series for `hours=0.25`, `1`, `6`, `24`, or `168`.        |
| `/api/review-coverage`                   | `GET`  | Fleet-wide coverage counts; repository rows are retained only in the private store.                  |
| `/api/apply-observability`               | `GET`  | Global closed apply-lane counts and failure categories without repository or run links.              |
| `/api/health-history`                    | `GET`  | Historical health from `healthHistoryJson`.                                                          |
| `/api/automerge-metrics`                 | `GET`  | Global automerge counts, rates, buckets, and outcomes without filters or session rows.               |
| `/api/status`                            | `ANY`  | Closed status plus bounded allowlisted public references, reprojected on every cache/store boundary. |
| `/api/triage`                            | `ANY`  | Closed issue-triage view descriptors, bounded counts, and completeness only.                         |
| `/api/pr-proof-triage`                   | `ANY`  | Closed proof-triage view descriptors, bounded counts, and completeness only.                         |

`config/operator-documentation.json` is the checked route inventory. Adding or
removing a literal observer route in `dashboard/worker.ts` requires updating
that manifest and this table. The checker excludes `/api/events`, because it is
an ingest mutation rather than an observer route.

For egress field interpretation, use
[GitHub publication egress telemetry](github-egress-telemetry.md). For other
fields, use [Live dashboard](live-dashboard.md). For the rendered lane model,
use [OpenClaw Bay](openclaw-bay-demo.md).

Public observer routes are projections, not private-store serializers. Internal
Durable Object state may retain item keys, repository selectors, workflow/job
metadata, failure details, run links, revision digests, and sampled records for
binding-authenticated workflows. The Worker allowlists fixed aggregate fields
before an unauthenticated response is serialized. Unknown or malformed shapes
fail closed and caught storage errors use fixed categories without interpolating
the underlying exception.

The two triage APIs use schema version 2 and expose only a normalized
`generated_at`, `complete`, bounded `error_count`, a count map keyed by closed
view IDs, and static view descriptors with bounded `total_count` and
`item_limit`. Every compatibility `items` array is empty. Their private
in-memory GitHub collection may use repository, item, title, URL, query, author,
assignee, label, linked-item, proof-state, and diagnostic data, but the public
projector drops those fields before fresh or stale cache serialization. The
projector runs again on cache reads, including raw legacy cache bodies. Invalid
or uncertain input returns a fixed incomplete projection with null counts; raw
diagnostic text is never returned. The unauthenticated triage pages therefore
have no per-item lists, filters, chips, or links. Those capabilities require a
separately authenticated operator surface, which does not currently exist.

`/api/exact-review-queue` retains closed recovery-reason counts for
`claim_timeout`, `execution_timeout`, `workflow_cancelled`, and
`workflow_failed`, but omits per-member, per-target, ownership, fingerprint,
detail, raw timing, and internal-key records. Bay activity is producer-composed
from a complete census so queue/live overlap is counted once; incomplete or
legacy shapes cannot claim a complete activity aggregate. Its optional bounded
reference sample contains canonical `repository`, positive `item_number`,
closed `stage`, and closed `source` fields for repositories in
`PUBLIC_BAY_REPOS`. It may also carry a validated action descriptor: canonical
public repository/run/job identifiers, a canonical start timestamp, and a
bounded ordered list of fixed step kinds and closed states. A reference may
carry a separate timing descriptor containing only `kind=queue` with the
validated queue creation time or `kind=run` with the validated public action
start time. These clocks are elapsed queue/run context, not inferred visual
lane-entry times. The same sample feeds Bay and Overview cards, search,
overflow lists, and detail blades. Titles,
raw step names, source URLs, queries, opaque keys, failure payloads, credentials,
tokens, and non-allowlisted repositories are not projected. The lifecycle
route applies the same allowlist to its bounded 24-card sample and retains only
the item reference, closed lane/state, current-revision boolean, and canonical
timestamp.

The GitHub-egress response exposes only revision-independent closed dimensions
and sanitized retention watermarks. `query_complete` describes retained
evidence, not the existence of traffic in every clock bucket.

Local monitoring must apply the same data-minimization rule. Persist only the
bounded counts, closed categories, timestamps, and allowlisted repository/item
references required by the monitor. Do not archive complete raw observer
responses, arbitrary response fields, titles, source URLs, failure payloads, or
internal keys for later filtering.
