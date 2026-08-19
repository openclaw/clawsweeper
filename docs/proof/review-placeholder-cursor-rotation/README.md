# Review-placeholder cursor rotation proof contract

## Claim

Bounded placeholder recovery retains independent open and closed discovery
offsets in the authenticated ExactReviewQueue cursor store. Successive runs
inspect distinct GitHub Search windows, a complete rotation returns to the
first window, and a revision-CAS conflict leaves the old offset available for a
safe retry instead of skipping candidates.

## Exercised surface

`run-proof.sh` starts the real dashboard Worker with local Wrangler and a
disposable persisted SQLite Durable Object. The proof then drives the compiled
recovery implementation through its normal network boundary:

```text
runReviewPlaceholderRecovery()
  -> signed GET /internal/state/cursors/<open-or-closed-mode>
  -> bounded GitHub Search and live comment validation
  -> signed POST /internal/exact-review/enqueue
  -> signed PUT /internal/state/cursors/<open-or-closed-mode>
  -> Worker authentication and ExactReviewQueue revision-CAS storage
```

Only GitHub is substituted with deterministic responses. Cursor reads/writes
and enqueue requests cross a real local HTTP server, the Worker router, HMAC
authentication, and the Wrangler Durable Object implementation. The cursor
client requires an HTTPS production URL, so the injected transport rewrites
only the disposable Wrangler origin's scheme from `https` to `http`; the URL
path, method, body, and signature are unchanged.

## Controlled scenarios

The rotation scenario supplies 180 open and 180 closed search matches with a
60-candidate budget per state. Three runs must inspect offsets `0..59`,
`60..119`, and `120..179`; the next run must revisit `0..59`. A closed orphan at
rank 144 is cleaned only in the third window. An open placeholder in the first
window is initially younger than the two-hour activity guard and is enqueued
only after the cursor wraps and the synthetic clock advances.

The CAS scenario uses a new repository cursor. Immediately before recovery
persists offset 1, the harness sends a correctly signed competing write that
keeps offset 0 but advances the revision. Recovery's stale write receives 409.
The next invocation reads offset 0 again, revalidates the same candidate, and
the real queue accepts the repeated idempotent enqueue before offset 1 is
persisted.

## Command and artifacts

```bash
docs/proof/review-placeholder-cursor-rotation/run-proof.sh
```

The script requires Node 24+, pnpm, and a local Wrangler runtime. It writes
`proof-summary.json`, `runtime-transcript.md`, build output, focused test output,
and the Wrangler log beneath
`.artifacts/review-placeholder-cursor-rotation/` by default.

## Expected observation

```text
rotation windows: open=1001..1060 | 1061..1120 | 1121..1180 | 1001..1060
cursor offsets: 60 -> 120 -> 0 -> 60
closed cleanup: rank 144
age guard: first-window open placeholder enqueued only after wrap
CAS retry: checked 8001 twice; offset stayed 0 after 409, then advanced to 1
RESULT: PASS
```

## Limits

This is controlled local Worker/Durable Object evidence, not a production
deployment trace. GitHub Search, comment reads, and destructive deletion are
modeled with synthetic data, and no live repository, workflow, Cloudflare
account, secret, queue, R2 object, or production Durable Object is contacted.
The proof establishes the real local authenticated routing and persistence
contract but cannot establish production network availability or GitHub Search
ordering under concurrent live mutations.
