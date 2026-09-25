# Backlog recovery behavior proof

Claim: reduce redundant inline-review reads and retry churn without relaxing
source integrity, source freshness, scanner checks, or queue ownership. Prepare
two members per batch while preserving identical publication plans and outcomes.
OpenClaw Bay needs no change: public payloads, lifecycle meanings, and its
observer-only boundary are unchanged.

## Environment and commands

Measured on macOS with Node 24.21.0, using the production hydration functions,
Git binaries, curl/bootstrap script, batch controller/publisher/apply paths, and
queue handler. Fixtures are synthetic. Baseline: `438cd3b870ca4355a6e78eaf4e4e94b162170f96`.
No credentials or live GitHub mutations are used by these drivers.

```sh
pnpm run build:all
node scripts/e2e/ci-comment-read-budget.mjs --inline
node scripts/e2e/backlog-source-recovery.mjs
node scripts/e2e/backlog-dead-letter-inventory.mjs
node scripts/e2e/backlog-batch-concurrency.mjs
```

To reproduce the inline baseline, save the baseline version of
`src/clawsweeper-item-context.ts` as
`dist/clawsweeper-item-context-baseline.js` with Node's
`stripTypeScriptTypes`, retaining the same sibling runtime dependencies, then
run `node scripts/e2e/ci-comment-read-budget.mjs --inline --baseline`.

## Observed results

- [Inline before](inline-before.json) / [after](inline-after.json): 10/40 inline
  comments require 2 → 1 reads when followed by a same-generation full read;
  250 inline comments require 5 → 3. Prompt windows and complete revision bytes
  match. A middle-comment edit is detected after explicit bypass and after
  generation invalidation. The transport is a loopback HTTP fixture, not GitHub.
- [Source recovery](source.json): real partial Git clone and native fetch install
  one of three missing blobs before an injected transport failure. The retry
  fetches only the remaining two. A warm rerun fetches nothing. The completion checks reuse the older-Git-safe
  tree-scoped missing-object probe; they never feed known-missing promisor blobs
  to `cat-file`. Real curl retries
  a refused connection and one loopback 503, then the unchanged pinned checksum refuses a corrupt archive.
  The fixture redirects the scanner URL and supplies Linux platform detection on
  macOS; it does not execute a synthetic scanner or weaken production validation.
- [Inventory](inventory.json): the production dead-letter handler uses two key
  lookups and no active-item payload scan despite 1,000 unrelated SQLite rows
  containing 32 MB of payloads. Active publication/recovery entries still block
  fresh recovery. Native file-backed SQLite is real; Cloudflare KV/scheduling
  are local adapters.
- [Preparation](concurrency.json): eight members finish in 5.33 seconds at one
  worker and 2.67 seconds at two, with byte-identical plans, actions and outcomes.
  The real controller, validator, apply and publisher paths use synthetic GitHub
  transport and artifacts. Quota failure admits only the two in-flight members;
  the other six defer without attempts. Heartbeat failure admits zero members.
- [Mixed circuit regression](mixed-circuit.json): one initial download is throttled
  while its sibling succeeds. The quota lookup is held until the next member
  reaches an outcome. At baseline `4f75de1dc7fec35e006f2781eafc3620df7fcf3a`, that member made a third artifact request;
  afterward only the original two download, the successful sibling prepares its
  result, and six members defer without attempts. A provisional circuit is written
  before awaiting the reset lookup, which is bounded to 30 seconds. Authoritative
  reset data can subsequently extend the initial one-minute fallback.

These controlled measurements establish behavior, not production throughput or
resolution of every historical HTTP 500. A bounded production error tail did not
reproduce the intermittent claim failures; existing claim retries and ownership
checks remain unchanged. The bounded inventory lookup removes an observed
unnecessary queue-wide read, without asserting it caused those failures.

## Older Git compatibility

ClawSweeper identified a regression in the initial completion probe. The corrected
production source and native proof also pass on Git 2.39.5 / Node 24.18.1 in
`node:24-bookworm` on Crabbox provider `aws`, lease `cbx_60711a84a0c5`,
[run `run_d12c06776f33ae027a6d0c20556235e5`](https://crabbox.openclaw.ai/portal/runs/run_d12c06776f33ae027a6d0c20556235e5),
exit 0 with 18 focused retry tests passed. [Retained result](source-old-git.json)
binds the corrected source hash and records partial-pack reuse, zero warm
fetches, connection-refusal/503 recovery, and corrupt-archive refusal. The native
source failure uses Git's standard `returned error: 503` wording. The scanner
server starts only after observing curl's connection refusal, avoiding a timer race. The
existing Git trace regression also requires every availability probe to use
exact tree roots, with zero nested lazy fetches and one explicit successful fetch.

## Rollout and rollback

Worker/review limits remain 128 total, 80 exact globally, 64 per target and 32
scheduled. Intake remains 60/hour with burst 6; publication max is 32, Actions
budget 194, imported-cluster cap 2. Only batch preparation moves from 1 to 2.
Compare complete 15-minute GitHub egress observations, publication completions,
oldest-ready age and quota deferrals after deployment. If throughput regresses
or sustained throttling worsens, restore
`EXACT_REVIEW_BATCH_PREPARE_CONCURRENCY: "1"` in the batch workflow. Missing
telemetry is unknown, never evidence of zero errors.

Source metadata retains its 30-second budget. Commit/history and missing-blob
fetches each have a separate 120-second transport budget, at most two attempts
of 60 seconds, including local object verification between attempts. Full-tree
materialization uses the same acquisition owner; attribute blobs retain the
caller's absolute metadata deadline. Installed blobs are reused only after their
type and size match the admitted tree metadata. History completeness is still
required; shallow repositories are unshallowed. Target-branch refresh requires a
successful remote fetch, even when a local tracking ref exists. Only transport
failures retry; authentication/ref failures fail normally. Fetch attempts reserve
graceful Git termination, forced escalation, and owned-process settlement inside
their deadline. Git performs its own lock cleanup; ClawSweeper never deletes Git
locks. Fetch-owned automatic maintenance is disabled. Missing supervisor receipts
or uncertain settlement stop the current acquisition without object reuse or an
exact-SHA fallback, and retain unsafe private workspace state for recovery.
Windows aborts require successful bounded `taskkill` while the parent still owns
its tree; an uncertain result cannot authorize a retry. Offline verification
processes use bounded hard termination. Commit-existence probes also deny all
transport protocols, including Git versions without the `GIT_NO_LAZY_FETCH` guard.
Scanner download uses 15-second connection and 60-second request deadlines with
at most two curl retries, including failures before an HTTP response; digest, version and benign scan gates remain.
