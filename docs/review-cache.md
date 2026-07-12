# Review Cache

Scheduled keep-open reviews use two independent cache stages.

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
- the target branch head is unchanged;
- the complete hydrated PR state is unchanged, including head and base SHAs,
  draft and mergeability state, diff counts, and commit count; and
- any item activity timestamp change is covered by the recorded ClawSweeper
  comment or label synchronization boundary.

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
lease for the unchanged PR head or issue source revision. Missing coordination,
an incomplete lease tuple, or a concurrent review always disables reuse.
ClawSweeper then repeats the bounded probe under that lease; any intervening
non-ClawSweeper activity forces full hydration.

## Content Stage

When the structural stage misses, ClawSweeper hydrates the normal comments,
timeline, relations, PR files, commits, and review comments. The existing
content digest may still reuse an unchanged keep-open verdict after that full
context is proven.

Neither cache stage can promote a report to close.

## Metrics

Each review run writes `review-cache-metrics.json` in its artifact directory.
It reports structural checks, hits, probe failures, probe time, miss reasons,
post-lease revalidation results, content-cache hits, and full hydration count.
The final review log emits the same high-level counters.
