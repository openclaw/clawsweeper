# Census observation-window repair

## Claim and causal limit

The natural post-2173 producer run https://github.com/openclaw/clawsweeper/actions/runs/42282518998
completed successfully, but its preserved 29 diagnostic lines include 28
accept/unclassified/checkpoint/observation_window failures and one independent
query/read_failed. The exact source exception is "census observation window conflict".
This change addresses that temporal boundary, not every persisted read-failed
reason and not the separate failed query. Deployment success is not census recovery.

Production source inspection found no frozen producer clock: target-fanout calls
runReviewCoverageCensus without a now override; count reads use new Date(), and
page parsing uses Date.now after the successful query. The DO independently takes
Date.now on each start/next/accept request. Previously it compared the producer's
query-completion timestamp against DO-owned generation/pass start and request
receipt. Those clocks are not synchronized by the signed protocol. The native
proof reproduces the exact live fault with a producer 500 ms behind and a real
300 ms successful query. An ahead producer reproduces start/invalid_checkpoint.
These are causal counterfactuals, **not a measurement of the live clock direction
or offset**. Existing public diagnostics cannot establish that missing live fact.

## Authority and time semantics

The optional server-query-window-v1 extension retains wire version 2. A signed
prepare request reserves the existing five-minute lease and returns a random,
stored metadata-window ID and DO start time **before** target-fanout reads count
metadata. Start must echo that exact witness and its conservative query-start
lower bound; it cannot stamp previously collected data as newly observed.
Counts freshness is conservative from that lower bound, not a claim that the
counts are an atomic snapshot at query completion. A prepare failure does not
block ordinary fanout planning; it prevents that census publication through the
existing warning/error path. No GitHub query or rate budget increases.

Next issues a stored random witness per existing assignment and lease attempt.
Negotiated pages carry that witness and observedAt:null, explicitly distinguishing
the server-bounded interval from a producer query-end timestamp. Acceptance checks
the stored ID, exact start, active attempt, generation/revision/pass/cursor,
pass-start lower fence, and server receipt upper fence. Identity updated/reopened
times may advance **inside** the query interval but cannot exceed receipt. The
existing completed witness records the DO receipt as its interval end. This is
not a claim of an atomic GitHub as-of snapshot, nor a renamed/filled coverage
value. Two stable identity witnesses and existing max-update/drift fences remain
mandatory. There is no clock tolerance, future-time exception, stale-generation
retry loop, queue reset, or credential change.

Old producer/new Worker keeps the strict legacy timestamp path. New producer/old
Worker falls back only on an explicit 404 from the new signed prepare route.
Lease/auth/checkpoint failures never downgrade. Once prepared, start cannot omit
the witness; assigned pages cannot downgrade to legacy time. Old assignments do
not cross lease/metadata epochs. Successful identical receipt replay remains
idempotent; different receipt/checkpoint replay remains rejected.

## Reproduction contract

Run from this repository on Linux with Node >=24 and the pinned test-only cached
Miniflare 5.20260911.0-alpha / workerd 1.20260911.1 dependencies:

~~~sh
node docs/proof/ui-live-coverage/coverage-observation-window.mjs 066e625998e61b8045704618e21d3ab9d73d7329
node docs/proof/ui-live-coverage/coverage-accept-operations.mjs c1d3aebd59790a33e7fc18e61631c06bc5b0761c
~~~

The executable proof bundles real base/candidate producers and Workers, sends
HMAC-signed HTTP through Worker/ExactReviewQueue, and uses actual workerd SQLite.
The fixture injects an independent advancing DO clock at production method
boundaries; it does not replace SQL or the signed authority route. Arbitrary
HTTP headers are stripped by the production forwarder, so fixture clock setup
uses a separate fixture-only endpoint before the untouched signed request.
Trace artifacts capture the actual request-owned server time, producer time,
query success, response diagnostics, exact source HEAD/tree/clean status, runtime
versions, bundle hashes, and proof limits under .openclaw/tmp/observation-window-fix.

Scenarios include producer offsets +/-500 ms and +/-120 seconds, real query
delays, pass promotion/second witnesses, advanced server epochs, a 145-repository
8,149-identity fleet over 40 invocations, old/new rolling pairs, forged/future/
stale windows, future identities, mismatched pass/revision/generation/cursor,
previous metadata epochs, HMAC/method rejection, receipt replay, an update during
a two-second query, and the unchanged 25,000-identity capacity rejection. Focused
regression tests additionally exercise downgrade and old lease/assignment cases.
The canonical pre-existing proof preserves its 145/8,149 workload and identity
bound counterfactual; no old fixture/error identity is weakened.

Both native proofs assert all 58 non-census SQL tables, KV and null alarm remain
unchanged, no R2 is bound, and outbound network is zero. All identities/secrets are
synthetic. No live API/control calls, Store reads/writes, deploy, workflow dispatch,
credential retrieval, or state reset occurs. Bay UI/coverage math is unchanged;
its affected producer observation boundary is covered by this proof. Hosted CI,
current ClawSweeper review and explicit future merge approval remain separate gates.
