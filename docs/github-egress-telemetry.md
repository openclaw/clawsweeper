# GitHub publication egress telemetry

- Status: active operator reference
- Owner: ClawSweeper publication and dashboard maintainers
- Source of truth: `src/github-egress-observer.ts`,
  `src/github-egress-telemetry-contract.ts`,
  `dashboard/github-egress-telemetry.ts`, and the publication workflows
- Last verified: `openclaw/clawsweeper@a1795973a9e6bb00b73cd6adc21a4ea02ca78ced`
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

`hours` accepts only `1`, `6`, or `24`. The response contains closed aggregate
dimensions and sanitized rate-limit observations. It never contains private
pool identities, repository or item identifiers, branches, raw SHAs, paths,
queries, cursors, URLs, request IDs, ETags, bodies, tokens, or installation IDs.

The exact-review queue status also includes a compact six-hour
`publication.github_egress_metrics_v2` summary. Use the dedicated endpoint when
the operation, route, page, outcome, or rate-limit-header breakdown is needed.

## Counting units

Do not add unlike units. Each row declares one of these units:

| Unit           | What one count means                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `member`       | One durable publication member entering a direct, artifact, or batch publication boundary.       |
| `invocation`   | One `gh` command invocation, including a pre-wire failure or an opaque artifact download action. |
| `wire_attempt` | One HTTP request observed in a safe `GH_DEBUG=api` transport frame; each pagination page counts. |

A paginated invocation therefore contributes one `invocation` and N
`wire_attempt` rows. An artifact download whose binary redirect is unsafe to
debug contributes an incomplete `invocation` but no invented wire count.
`attempted=false` is emitted only for a directly observed pre-wire condition or
an existing batch circuit skip. Phase 0 does not manufacture requests that a
future coordinator might have avoided.

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

`deployment_revision` is a one-way 16-hex fingerprint derived from the exact
checked-out deployment SHA. `config_revision` is a separate 16-hex fingerprint
of a versioned allowlist of non-secret egress controls. Operators can correlate
a known SHA or configuration locally without publishing a raw SHA or control
payload.

## Rate-limit observations

Only HTTP 403 and 429 responses produce detail rows. The observer records the
approximate response receive time (request timestamp plus measured duration),
status, closed request dimensions, and presence plus bounded numeric values for:

- `Retry-After`;
- `X-RateLimit-Limit`;
- `X-RateLimit-Remaining`;
- `X-RateLimit-Used`;
- `X-RateLimit-Reset`;
- the allowlisted `X-RateLimit-Resource` value.

`reset_authority_candidate` reports `retry_after`, `rate_limit_reset`, `absent`,
or `invalid`. It does not choose a shared `blocked_until`, authorize a probe, or
alter retry behavior. A present but non-numeric authority remains present and is
classified `invalid`.

## Completeness and safe failure

`telemetry_complete=true` requires a known credential boundary, stage, source
class, durable claim generation, first/repeat fact, safe route template, parsed
method/status, and response receive time. Unsafe parsing emits or uploads an
incomplete bounded marker. It never uploads a partially parsed raw frame.

Completeness is computed independently for each requested one-, six-, or
24-hour window. `rows_truncated` and `rate_limit_rows_truncated` identify a
bounded public response, while `rollup_window_complete` and
`rate_limit_window_complete` identify any cap eviction during the requested
window. `query_complete` is true only when neither condition applies. These
query bounds are separate from transport `telemetry_complete`.

The public view also returns full-window `units` totals for members,
invocations, and wire attempts. These conservation denominators remain exact
when the bounded dimensional `rows` array is truncated; operators must still
treat `completeness.query_complete=false` as insufficient for a complete
per-route breakdown.

The `gh` wrapper preserves the command's stdout, cleaned non-debug stderr, and
exit status. Observation and upload failures do not fail publication. This
fail-open rule means a completely missing upload cannot report its own absence;
use stage conservation against durable publication starts and workflow results
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

| Boundary                         | Limit                                  |
| -------------------------------- | -------------------------------------- |
| Workflow JSONL input             | 2,000 lines per file                   |
| Signed upload                    | 128 metrics and 16 rate rows per chunk |
| Five-minute rollups              | 7 days                                 |
| Hourly rollups                   | 30 days                                |
| Sanitized 403/429 detail         | 24 hours                               |
| Deduplication receipts           | 7 days                                 |
| Durable rollup rows              | 50,000                                 |
| Durable rate-limit detail rows   | 10,000                                 |
| Public aggregate rows per query  | 2,000 plus a truncation flag           |
| Public rate-limit rows per query | 256                                    |

The Durable Object validates every enum, digest length, timestamp window,
numeric header, count, and chunk limit before committing a receipt. It stores
both five-minute and hourly rollups transactionally and deduplicates upload
retries by producer-run-scoped, content-derived receipt ID. Cap evictions are
cumulative diagnostics and mark affected public windows incomplete.

## Rollback and Phase 1 boundary

Rollback removes the workflow setup and upload steps and the public route. The
version-2 tables are additive and may remain dormant; version-1 metrics and
publication behavior continue unchanged. No queue drain, schedule change,
credential change, or state migration is required.

Phase 1 may use this denominator to justify a shared credential-pool
coordinator. Epochs, permits, blocked-until decisions, probes, ramps, shared
backoff, enforcement kill switches, and coordinator-derived avoided requests
are deliberately absent here.
