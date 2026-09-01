# Review Cache

Scheduled keep-open reviews use two exact-input cache stages. Codex judges
changed content; ClawSweeper does not infer source equivalence.

## Structural Stage

Before ClawSweeper hydrates full GitHub context, it loads bounded metadata for
the selected item. It inspects bounded item, comment, and review-comment bodies
only for same-repository relation links; body text is never persisted. The
metadata record contains only digests, booleans, timestamps, item identifiers,
and commit SHAs.

A structural hit requires all of the following:

- the prior review completed with an original keep-open verdict;
- the review is less than 14 days old;
- the review policy and public model are unchanged;
- the item kind and bounded source revision are unchanged across probes taken
  immediately before and after hydration, and the post-hydration probe matches
  the hydrated title, body, labels, and human comments exactly;
- human issue comments, bounded timeline events, PR reviews, review threads,
  and linked-item metadata are unchanged and complete;
- no explicit relation, matching local report, Gitcrawl cluster member, or
  enabled GitHub related-item search result can contribute review context;
- bounded PR check runs and commit statuses are unchanged and complete;
- the target branch head is unchanged;
- the complete hydrated PR state is unchanged, including head and base SHAs,
  draft and mergeability state, diff counts, and commit count; and
- any item activity timestamp change is covered by the recorded ClawSweeper
  comment, label synchronization, or validated review-reservation boundary.

Explicit reviews, maintainer prompts, close verdicts, failed reviews, legacy
records, truncated metadata, malformed API responses, and probe failures always
continue to full hydration.

ClawSweeper evaluates those cheap eligibility conditions before issuing the
bounded GraphQL query. Eligible legacy reports may still be probed so a
structural record can be seeded after hydration. A record is seeded only when
the pre-hydration and post-hydration snapshots describe the same complete
timeline, review, and review-thread input; the final verdict probe must match
that anchor again.

Before carrying a structural hit, ClawSweeper acquires the normal durable review
lease for the unchanged PR head or issue source revision. Scheduled deliveries
claim the lease already reserved by their workflow instead of posting a second
lease comment. Missing coordination, an incomplete lease tuple, or a concurrent
review always disables reuse. ClawSweeper then refreshes target and release state
and repeats the bounded metadata and check-state probes under that lease; any
intervening drift forces full hydration.

## Content Stage

When the structural stage misses, the exact content digest
may still reuse an unchanged keep-open verdict after the full context is
proven.

No cache stage can promote a report to close.

Every reused review passes the host-owned scan preflight before checkout
inspection. Structural reuse scans current reuse metadata and the pinned source
delta against the base/head pair from the same fresh structural probe; hydrated
content reuse also scans current context and complete raw before/after blobs. Historical
outcomes predating scan admission are rejected by the review policy version.
Scan refusal cannot return a cached success or launch a fallback reviewer.

## Changed Input and Runtime

Changed PR content, including source comments and formatting, goes to Codex.
Git history and blob hydration still make both sides of the PR available in
the restricted review checkout. There is no compiler-backed cache, separate
cache-only patch payload, or source-equivalence revalidation path.

When full context collection requests a review checkout, source preparation runs
independently of cache-digest eligibility and the API's 80-file context window.
It reads the exact raw Git delta for the pinned merge-base/head (and pinned
base/head endpoint evidence), including deleted and historical blobs. Current
main never replaces the pinned REST base. Commit acquisition fetches complete
blobless ancestry, including when the branch has advanced past that base, and
unshallows existing shallow checkouts. Branch, release-tag, and test-merge
fetches never introduce new depth boundaries. A missing pinned commit still
blocks preparation; no newer revision substitutes for it. Blob-size metadata uses
batches of at most 160 objects; one explicit fetch per delta retrieves missing blobs only after
the complete set fits the scanner's shared 256 MiB upper bound. Local metadata
reads remain bounded to 4 MiB and source hydration has a 30-second Git-work
deadline; metadata requests retain the existing GitHub transport timeout policy.
The scanner separately enforces its aggregate budget, including prompts and the
binary patch, and still refuses incomplete or unsupported source without fetching.

Preparation remains in full-context collection, before restricted checkout
inspection. Structural reuse keeps its existing pinned-source scan and refusal
behavior; it does not gain a separate hydrator. Context-only callers that do not
request a Git checkout do no source preparation. OpenClaw Bay is unaffected:
no observer fields, routes, or controls change.

The deployed review artifact contains compiled JavaScript, runtime libraries,
and matching configuration, prompts, and schemas. TypeScript is a build
dependency; review shards neither load nor install a compiler. Historical
`review_semantic_*` report fields are ignored and disappear when a full review
replaces the report. Existing reports keep their normal freshness deadline;
this change does not trigger a fleet-wide re-review.

## Metrics

Each review run writes `review-cache-metrics.json` in its artifact directory.
It reports structural checks, hits, probe failures, probe time, miss reasons,
post-lease revalidation results,
content-cache hits, and full hydration count. The final review log emits the
same high-level counters. Metrics contain only counts, timings, and bounded
reason names.
