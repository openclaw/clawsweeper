# GitHub publication egress telemetry real-boundary proof

## Claim

Phase 0 observes the real publication `gh` transport without changing command
stdout, cleaned ordinary stderr, or exit status. A paginated invocation records
one invocation and one wire attempt per page. Credential pool, normalized
method/route, first/repeat, claim generation, response status/latency, and
sanitized 403/429 reset headers remain bounded. Unsafe classification fails
open with `telemetry_complete=false` and no raw request data.

The resulting aggregate uploads through the production HMAC serializer to a
real local Worker and SQLite-backed `ExactReviewQueue` Durable Object. Stored
rows survive a Worker restart and an identical producer receipt is deduplicated.

## Exercised surface

- The production `scripts/github-egress-observer.sh` wrapper and built observer
  parser/CLI
- A real GitHub CLI binary over loopback TLS, including three REST pagination
  pages, an opaque artifact archive download, and an HTTP 403 with
  `Retry-After` and `X-RateLimit-*` headers
- `repository_actions`, `target_app`, and `public_read_fallback` call-site
  attribution
- A real signed telemetry upload and public query through `wrangler dev --local`
- The real SQLite Durable Object storage, receipt deduplication, and restart
  persistence
- Sentinel scans across workflow JSONL and public output
- Twelve baseline and twelve observed loopback invocations for bounded observer
  overhead measurement

## Run

From a clean repository root on Node 24 or later:

```bash
docs/proof/github-egress-telemetry/run-proof.sh
```

The script uses pinned Wrangler 4.107.0 and a disposable self-signed loopback
certificate. If `gh` is unavailable, it downloads GitHub CLI 2.88.1 into the
disposable proof directory. It uses only synthetic credentials and loopback
application endpoints. It does not call GitHub APIs, mutate production, or
touch queue, schedule, gate, deployment, or credential state.

## Required result

- 18 invocations conserve to 19 observed wire attempts and one durable member;
  one artifact invocation is explicitly opaque and invents no wire count.
- The paginated invocation accounts for exactly three page attempts.
- The authoritative 403 produces exactly one sanitized reset observation.
- Public-read fallback and target-App each retain their actual selected pool.
- The unrecognized route is incomplete but preserves command behavior.
- A missing observer parser preserves the original throttled command's stderr,
  stdout, and exit status while stripping unsafe debug frames.
- Public output withholds pool identity and all raw sentinels.
- Worker restart preserves rows and replaying the same receipt is deduplicated.
- Median loopback observer overhead remains below the proof's one-second safety
  ceiling; the measured value is reported, not treated as a production latency
  forecast.

## Artifacts and limits

Generated evidence is written to `.artifacts/github-egress-telemetry-proof/`:
a machine-readable summary, the bounded public observability response,
build/install logs, and a secret-redacted Wrangler log. The generated evidence
is intentionally outside the committed proof package; exact-head provenance is
recorded in the pull request.

The GitHub responses are deterministic loopback fixtures, not live quota
consumption. Artifact downloads remain deliberately opaque because GitHub CLI
debug output can cross a binary redirect; deterministic tests cover their
incomplete invocation accounting. This is observation proof only and makes no
claim about Phase 1 admission, circuit, permit, probe, or ramp behavior.
