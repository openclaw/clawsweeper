# Review Cache

Scheduled keep-open reviews use three independent cache stages.

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

## Semantic Stage

After hydration, pull requests can reuse a prior completed keep-open report when
the code is semantically unchanged even if the head SHA or ordinary formatting
changed. TypeScript and JavaScript patches are tokenized with the TypeScript
compiler scanner. Whitespace and ordinary comments are ignored, while
`@ts-*`, triple-slash reference, source-map, source URL, and shebang directives
remain part of the digest. Complete JSON hunks are parsed and canonicalized.

Semantic reuse requires:

- complete bounded patches for every changed file;
- a supported modified or added TypeScript, JavaScript, or complete JSON file;
- unchanged title, body, human discussion, relations, reviews, review threads,
  labels, base and target state, release state, commit messages, merge
  readiness, checks, policy, and model;
- a prior completed keep-open report within the normal 14-day ceiling; and
- the normal durable review lease.

Unsupported languages, deletions, renames, binary or missing patches, prompt
truncation, malformed hunks, lexical ambiguity, partial JSON, incomplete check
state, and truncated commit context retain an exact digest for audit but cannot
use semantic reuse.

Before carrying a semantic hit, ClawSweeper repeats the structural metadata and
check-state probes under the lease. Any drift releases the lease and defers the
item for a fresh hydrated review. Full cache-only patches are never included in
the model prompt, report frontmatter, or metrics.

## Content Stage

When the structural and semantic stages miss, the existing exact content digest
may still reuse an unchanged keep-open verdict after the full context is
proven.

No cache stage can promote a report to close.

## Metrics

Each review run writes `review-cache-metrics.json` in its artifact directory.
It reports structural checks, hits, probe failures, probe time, miss reasons,
semantic eligibility and miss reasons, post-lease revalidation results,
content-cache hits, and full hydration count. The final review log emits the
same high-level counters. Metrics contain only counts, timings, and bounded
reason names.
