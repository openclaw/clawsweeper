# GitHub publication egress telemetry

- Status: active operator reference
- Owner: ClawSweeper publication and dashboard maintainers
- Source of truth: `src/github-egress-observer.ts`,
  `src/github-egress-telemetry-contract.ts`,
  `src/review-activity-cursor.ts`, `dashboard/github-egress-telemetry.ts`, and
  the publication workflows
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: a publication request path, credential selection rule, telemetry
  dimension, retention limit, or public response changes
- Checked by: focused telemetry tests plus `pnpm run check:docs`

ClawSweeper records bounded observations of GitHub requests made while publishing
exact reviews. The observer is diagnostic only: it does not admit, defer, retry,
cancel, or reprioritize work, and it does not open or close a credential circuit.
Existing version-1 request and circuit metrics continue in parallel during the
version-2 observation period.

## Read the six-hour view

Use the public, read-only endpoint for time-aligned diagnosis:

```bash
curl --fail --silent --show-error \
  'https://clawsweeper.openclaw.ai/api/github-egress-observability?hours=6'
```

`hours` accepts only `0.25` (15 minutes), `1`, `6`, `24`, or `168` (7 days).
Use the 15-minute view for periodic collection when a high-cardinality one-hour
aggregate would reach the public row cap. The response contains
revision-independent closed rollup dimensions, a bounded `throttle_series`,
and aggregate rate-limit counts. It never contains private pool identities,
repository or item identifiers, deployment or configuration revision digests,
branches, raw SHAs, paths, queries, cursors, URLs, request IDs, ETags, bodies,
tokens, installation IDs, individual rate-limit rows, or raw header/reset
values.

`throttle_series.rows` is the operational chart projection. It re-aggregates
the existing rollup store by closed bucket, `pool_class`, and exact `403` or
`429` status for complete, attempted `wire_attempt` rows whose outcome is
`throttle`. It does not include invocations, pagination metadata, circuit
deferrals, avoided requests, or raw rate-limit observations. The seven-day
maximum is bounded at 1,344 rows: 168 hourly buckets, four closed pool classes,
and two statuses. `closed_through` excludes the still-open clock bucket.
`first_available_bucket_start`, `coverage_complete`, `rows_truncated`, and
`complete` identify pre-instrumentation, retention, and cardinality boundaries
without inventing zero-count history. Coverage is complete only when a retained
bucket predates the requested lower-bound bucket; a first observation in that
boundary bucket is conservatively treated as partial. Any incomplete egress
evidence in the displayed closed window increments `excluded_incomplete_count`
and makes `complete=false`, including an opaque invocation whose wire status
could not be parsed. A parsed 403/429 whose attribution is incomplete is
likewise omitted from the trustworthy pool split. Neither case can be rendered
as a zero-throttle interval. Older cached version-2 responses without this
projection remain readable through their detailed `rows` array.

The binding-only exact-review queue status retains a compact six-hour
`publication.github_egress_metrics_v2` summary for internal workflows. The
public `/api/exact-review-queue` projection omits it. Use the dedicated egress
endpoint for the closed operation, route, page, outcome, and rate-limit count
breakdowns.

## Counting units

Do not add unlike units. Each row declares one of these units:

| Unit                   | What one count means                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `member`               | One durable publication member entering a direct, artifact, or batch publication boundary.       |
| `invocation`           | One `gh` command invocation, including a pre-wire failure or an opaque artifact download action. |
| `wire_attempt`         | One HTTP request observed in a safe `GH_DEBUG=api` transport frame; each pagination page counts. |
| `broker_lookup`        | One durable ETag broker lookup decision: hit, miss, or skip.                                     |
| `conditional_response` | One GitHub 200 stored by the broker or one 304 whose durable body was confirmed and served.      |

A paginated invocation therefore contributes one `invocation` and N
`wire_attempt` rows. An artifact download whose binary redirect is unsafe to
debug contributes an incomplete `invocation` but no invented wire count.
`attempted=false` is emitted only for a directly observed pre-wire condition or
an existing batch circuit skip. Phase 0 does not manufacture requests that a
future coordinator might have avoided.

A public rollup row is an aggregate over these units, not a durable member or
request record. Otherwise-identical closed rows from different deployment or
configuration revisions are combined before serialization.

Do not equate a broker hit with a quota saving. `cache_hit` means only that an
ETag was available for the next live request. The separate
`cache_304_served` conditional-response row proves that GitHub returned 304 and
the matching durable body was confirmed. A 304 costs zero REST quota points but
still contributes a normal `wire_attempt`; the broker reduces quota charges,
not wire requests. `cache_200_stored`, `cache_miss`, and `cache_skip` remain
separate outcomes so operators can distinguish population, absence, and
bounded/fail-open exclusions.

## Durable ETag broker

The first brokered surfaces are publication-apply issue/pull metadata and
page-stable issue comments, pull comments, and pull reviews, plus the dashboard
Actions run/job health reads. Publication reads continue to use the existing
in-generation memoizer; the broker is consulted only when a real cross-run or
new-generation GitHub request is about to be sent.

The version-1 key is the canonical JSON tuple
`[1, credential_pool, route_with_sorted_query, media_type]`. Collection routes
materialize default `per_page` and `page=1`, so every page is independent and a
page-1 304 never validates page 2. Credential pool remains one of
`repository_actions`, `target_app`, or `public_read_fallback`; raw tokens and
private pool identities are never persisted or exposed.

Entries live in the exact-review queue Durable Object for 30 days, matching the
artifact-receipt retention convention. The store is capped at 2,048 entries and
128 KiB of UTF-8 JSON per body; missing ETags, malformed JSON, and larger bodies
are counted as `cache_skip` and read normally. Each entry retains its response
timestamp, last validation timestamp, ETag, body digest, and body. Automated
runner access uses the publisher-scoped webhook HMAC because publication jobs
already hold that narrowly scoped credential; the operator secret stays
reserved for human recovery.

Publication clients and dashboard health reads count oversized bodies as skips
via a size-only store request: `body_bytes` carries the UTF-8 byte count and
`body` is omitted. The store records `cache_skip` with reason `body_size_bound`
without accessing the body table. Publication clients also retain their local
`cache_skip` event. Store requests that include a body keep the existing
validation and storage behavior; `body_bytes` does not override that body.
The store keeps an in-memory entry count, reconciling it with SQLite on the
first store and every 64 stores thereafter. Inserts and expiry/oldest-validation
evictions maintain that count so the 2,048-entry cap holds after every store.
Expiry housekeeping runs at most once per minute per object instance; lookup
and 304 confirmation still check expiry on every read.

Lookup returns only ETag and digest. After GitHub returns 304, a separate
confirmation must still match that ETag/digest before the Worker returns the
body. If lookup or confirmation fails, the caller performs an unconditional
live read. Final pre/post-mutation guards therefore preserve their live
authority: they may save quota with a 304, but they cannot consume a bare cached
body.

Stable pull-request activity validation uses the version-2 GraphQL cursor when
reviews, review threads, and every nested inline review comment fit in the
bounded query. The safety invariant remains two independent reads: a normal
single-PR check therefore contributes two GraphQL invocations instead of two
sets of reviews, inline-comment, and review-thread reads. The same query shape
can alias up to eight PRs, so a bounded publication batch still contributes two
GraphQL invocations. Any GraphQL error, pagination, partial connection, or
missing required field activates the complete version-1 path for that PR and
emits one `reviewed_pr_activity_cursor_v2_fallback` JSON line; the decoder never
accepts a partial activity identity.

Use the unit totals as a conservation check:

1. Compare `member` counts with durable direct, artifact, and batch publication
   starts for the same window.
2. Compare `invocation` with `wire_attempt` by stage and operation. A larger wire
   count is expected for pagination; an incomplete opaque invocation has no wire
   denominator.
3. Compare attempted and non-attempted members with the existing publication
   completion, retry, and circuit-skip counters. A gap indicates missing or
   incomplete telemetry, not zero demand.

## `first` and `repeat`

`first_repeat` is fixed when the durable item is claimed for publication:

- `first` means `publicationFailureAttempts` is zero for that exact durable item
  revision at claim time.
- `repeat` means the same durable item revision already has at least one charged
  publication failure at claim time.
- `unknown` means the workflow could not safely bind this command to that
  durable fact; the row is incomplete.

This dimension does not mean a second HTTP request, another pagination page,
another member in the same batch, or every later claim generation. Every GitHub
invocation and wire request performed for one claim inherits the same
first/repeat value. `claim_generation_bucket` separately records the bounded
claim generation (`1`, `2`, `3_5`, `6_10`, `11_32`, or `33_plus`).

## Credential and request dimensions

Pool attribution follows the token actually selected at the call site. It is
never inferred from GitHub's generic error text.

| `pool_class`           | Meaning                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `repository_actions`   | The ClawSweeper repository Actions credential used for artifacts, workflow dispatch, or explicit calls. |
| `target_app`           | The target owner's GitHub App installation credential.                                                  |
| `public_read_fallback` | A public target read deliberately moved to the repository Actions credential after pool selection.      |
| `other`                | Attribution was unsafe; the row is incomplete.                                                          |

The private pool identity is a one-way, versioned fingerprint of the real
credential boundary: ClawSweeper repository Actions or target owner. It is
retained only inside the Durable Object and is omitted from public rows.

The remaining dimensions are closed allowlists:

- `stage`: preparation, apply, router, or recovery;
- `source_action`: exact event, command, scheduled hot, scheduled normal,
  repair, or publication retry;
- `operation`: artifact download, item metadata, comments, reviews, labels,
  reactions, checks, contents, authorization, GraphQL, workflow dispatch, rate
  status, or other;
- `method`: an allowlisted HTTP method or `UNKNOWN`;
- `route_template`: a normalized route family such as `issue_comments` or
  `actions_workflow_dispatch`;
- `page_bucket`, `status_bucket`, and `latency_bucket`: bounded buckets rather
  than raw values.

Private rollup and rate-limit records retain `deployment_revision`, a one-way
16-hex fingerprint derived from the exact checked-out deployment SHA, and
`config_revision`, a separate fingerprint of a versioned allowlist of
non-secret egress controls. These digests support binding-only provenance and
are not a public correlation surface. The public projector validates them,
removes them from the grouping key, and combines otherwise-identical rows across
revisions.

## Rate-limit observations

Only HTTP 403 and 429 responses produce private detail rows. The observer records
the approximate response receive time (request timestamp plus measured
duration), status, closed request dimensions, and presence plus bounded numeric
values for:

- `Retry-After`;
- `X-RateLimit-Limit`;
- `X-RateLimit-Remaining`;
- `X-RateLimit-Used`;
- `X-RateLimit-Reset`;
- the allowlisted `X-RateLimit-Resource` value.

`reset_authority_candidate` reports `retry_after`, `rate_limit_reset`, `absent`,
or `invalid`. A present but non-numeric authority remains present and is
classified `invalid`.

The public response never serializes those rows or numeric header values. It
returns a bounded `rate_limits` summary with the total, latest observation time,
aggregate completeness, counts by status, pool class, operation,
`reset_authority_candidate`, and resource category, plus counts indicating
which header families were present. Deployment/configuration revisions and
per-observation reset times remain private.

The signed ingest path also reuses a narrowly attributable subset of complete
observations as durable queue circuit evidence. `repository_actions` and
`public_read_fallback` both identify the workflow `GITHUB_TOKEN` quota and may
advance the shared repository-Actions `blocked_until` when `Retry-After` is
numeric, or when `X-RateLimit-Reset` is numeric and
`X-RateLimit-Remaining: 0`. The reset must be in the future and within two
hours. Recovery is released per durable publication member at that reset plus
one to 30 seconds of deterministic jitter. An observation never authorizes an
early probe.

`target_app` telemetry remains observational because the privacy-safe payload
does not carry the target owner needed to select an App credential pool.
Owner-aware Worker and batch paths continue to populate those circuits
directly. Incomplete observations, permission-style 403 responses with quota
remaining, invalid headers, stale resets, and unattributable pools never alter
admission.

Receipt deduplication also binds downstream circuit evidence to the first
accepted payload. A retry may replay that payload's stored circuit candidates
after an interrupted handoff, but reusing the receipt ID with different rate
limit evidence cannot introduce or extend a circuit.

## Completeness and safe failure

`telemetry_complete=true` requires a known credential boundary, stage, source
class, durable claim generation, first/repeat fact, safe route template, parsed
method/status, and response receive time. Unsafe parsing emits or uploads an
incomplete bounded marker. It never uploads a partially parsed raw frame.

Completeness is computed independently for each requested 15-minute, one-,
six-, 24-hour, or seven-day window. Rollup queries include the complete
five-minute or hourly bucket that overlaps the window's lower boundary, so
totals can include at most one bucket of observations immediately before the
exact cutoff. Private rate-limit source selection uses the exact cutoff before
aggregation and is retained for only 24 hours; a seven-day response therefore
always reports
`rate_limit_window_complete=false` and `query_complete=false` even when its
rollup-backed `throttle_series.complete` is true. `rows_truncated` and
`rate_limit_rows_truncated` identify a bounded public response, while
`rollup_window_complete` and `rate_limit_window_complete` compare the requested
lower boundary with the latest timestamp actually removed by a cap. Running a
cap cleanup does not make a later intact window incomplete merely because the
cleanup happened during that window. A missing legacy eviction boundary fails
closed. `query_complete` is true only when neither retention boundary nor a
public row cap affects the query. These query bounds are separate from transport
`telemetry_complete`.

`retention.last_rollup_evicted_bucket_start` and
`retention.last_rate_limit_evicted_observed_at` expose those sanitized evidence
boundaries alongside per-kind cumulative eviction counts. They are evidence
timestamps, not the time cleanup ran. `rollup_eviction_count_exact=false`
marks a legacy migration where the per-kind counts are conservative upper
bounds; completeness still uses the per-kind evidence watermark and fails
closed when that boundary is unavailable.

No-traffic buckets are not materialized. Therefore `query_complete=true` means
all stored evidence for the requested window is available; it is not a claim
that every clock bucket had a workflow or publication member. Use durable queue
starts, workflow results, and receipt timing to distinguish no qualifying
traffic from a missing producer.

The public view also returns full-window `units` totals for members,
invocations, and wire attempts. These conservation denominators remain exact
when the bounded dimensional `rows` array is truncated; operators must still
treat `completeness.query_complete=false` as insufficient for a complete
per-route breakdown.

The `gh` wrapper preserves the command's stdout, cleaned non-debug stderr, and
exit status. Observation and upload failures do not fail publication. This
fail-open rule means an uploader that finds no readable metric records sends
one bounded, incomplete, unattempted invocation marker; it never invents a wire
attempt or member count. A completely missing uploader still cannot report its
own absence, so use stage conservation against durable publication starts and workflow results
to detect that case.

Known incomplete boundaries are explicit:

- `gh run download` and `actions/download-artifact` remain opaque because debug
  output can include redirected archive bytes;
- direct-lifecycle replay performed before the repaired implementation checkout
  is not observed;
- calls outside the direct, artifact, and batch publication paths are outside
  this Phase 0 denominator;
- public views expose pool class, not the private owner-sharded pool identity;
- a closed route family cannot separate endpoint variants that are not in the
  allowlist.

## Retention and cardinality

| Boundary                                             | Limit                                  |
| ---------------------------------------------------- | -------------------------------------- |
| Workflow JSONL input                                 | 2,000 lines per file                   |
| Signed upload                                        | 128 metrics and 16 rate rows per chunk |
| Five-minute rollups                                  | 7 days                                 |
| Hourly rollups                                       | 30 days                                |
| Sanitized 403/429 detail                             | 24 hours                               |
| Deduplication receipts                               | 7 days                                 |
| Durable rollup rows                                  | 50,000                                 |
| Durable rate-limit detail rows                       | 10,000                                 |
| Public aggregate rows per query                      | 2,000 plus a truncation flag           |
| Private rate-limit observations aggregated per query | 256                                    |

The Durable Object validates every enum, digest length, timestamp window,
numeric header, count, and chunk limit before committing a receipt. It stores
both five-minute and hourly rollups transactionally and deduplicates upload
retries by producer-run-scoped, content-derived receipt ID. Cap evictions are
cumulative diagnostics. The highest timestamp actually evicted for each rollup
kind and for sanitized rate-limit detail marks only overlapping public windows
incomplete.

The 15-minute view does not raise or bypass either source cap. A collector must
preserve `rows_truncated`, `rate_limit_rows_truncated`, and `query_complete` and
record a gap if even the smaller view exceeds a bound. A rate-limit truncation
flag describes the private observations summarized into counts; it does not
imply that individual rows were returned publicly.

## Rollback and Phase 1 boundary

Rollback removes the workflow setup and upload steps and the public route. The
version-2 tables are additive and may remain dormant; version-1 metrics and
publication behavior continue unchanged. No queue drain, schedule change,
credential change, or state migration is required.

Phase 1 may use this denominator to justify a shared credential-pool
coordinator. Epochs, permits, blocked-until decisions, probes, ramps, shared
backoff, enforcement kill switches, and coordinator-derived avoided requests
are deliberately absent here.
