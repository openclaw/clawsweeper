# Review Cache

Scheduled keep-open reviews use two independent cache stages.

## Structural Stage

Before ClawSweeper creates a review lease or hydrates full GitHub context, it
loads bounded metadata for the selected item. The metadata record contains only
digests, timestamps, item identifiers, and commit SHAs. Bodies and comment text
are never persisted.

A structural hit requires all of the following:

- the prior review completed with an original keep-open verdict;
- the review is less than 14 days old;
- the review policy and public model are unchanged;
- the item kind and bounded source revision are unchanged;
- human issue comments, bounded timeline events, PR reviews, review threads,
  and linked-item metadata are unchanged and complete;
- the target branch head is unchanged;
- a PR head is unchanged; and
- any item activity timestamp change is covered by the recorded ClawSweeper
  comment or label synchronization boundary.

Explicit reviews, maintainer prompts, close verdicts, failed reviews, legacy
records, truncated metadata, malformed API responses, and probe failures always
continue to full hydration.

## Content Stage

When the structural stage misses, ClawSweeper hydrates the normal comments,
timeline, relations, PR files, commits, and review comments. The existing
content digest may still reuse an unchanged keep-open verdict after that full
context is proven.

Neither cache stage can promote a report to close.

## Metrics

Each review run writes `review-cache-metrics.json` in its artifact directory.
It reports structural checks, hits, probe failures, probe time, miss reasons,
content-cache hits, and full hydration count. The final review log emits the
same high-level counters.
