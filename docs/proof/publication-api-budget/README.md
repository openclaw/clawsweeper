# Publication quota request-budget proof

Claim: stop repeatedly calling an exhausted GitHub credential during publication
without reusing stale responses or changing publication/worker capacity.

Surface: the production GitHub runtime and retry executor, run in eight separate
publisher processes sharing the same batch observation and fallback-lock files.
The controlled fixture uses native HTTP on loopback and synthetic credentials.
An exhausted public read pool returns 403, one App fallback succeeds, and later
reads must defer. After the fixture expires the observations and changes the
source, permitted reads must observe the changed metadata and comments.

Command: `node scripts/e2e/publication-quota-budget.mjs` after `pnpm run build`.
The driver compares the checked-out base runtime with the changed runtime,
asserts equivalent deferred outcomes, counts actual loopback requests, and checks
fresh reads after reset. Its JSON result records the base and source hashes.

Measured on Crabbox provider `aws`, lease `cbx_ba682171e2d0`, Linux/Node 24.18.1,
image `ami-0461d919be7deb53c`. The [focused validation and proof run](https://crabbox.openclaw.ai/portal/runs/run_1ce115249f201d871658f100a5a62b15)
passed all 90 focused tests and the request-budget driver.

The [retained result](result.json) records 11 requests before the change versus
3 afterward: exhausted public reads dropped from 9 to 1, with one reset lookup
and one App fallback retained in both cases. All eight publisher outcomes remain
deferred. The changed runtime carries the authoritative reset across all eight
outcomes; the baseline replaces it with a fallback delay on later failures.
After reset, both versions make two fresh requests and observe the changed item
and comment bytes. No cached response substitutes for those fresh reads.

This establishes controlled runtime behavior, not production throughput or GitHub
quota accounting. Healthy-publication request counts are outside this claim.

OpenClaw Bay is unaffected: no public response fields, lifecycle meanings, or
observer-only behavior change. Existing v1 circuit-skip metrics record deferrals;
no synthetic wire-attempt or throttle observations are emitted.
