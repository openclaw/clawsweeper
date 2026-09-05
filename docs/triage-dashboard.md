# Triage Dashboard

Read when changing the unauthenticated ClawSweeper issue-triage observer surface.

The triage dashboard is a read-only aggregate view of open-issue advisory
categories. It reports bounded counts for a fixed set of views. It does not
publish issue rows or mutate GitHub issues, project items, labels, comments,
close state, or repair state.

## Routes

- `/triage`: browser UI for aggregate issue-triage counts
- `/api/triage`: aggregate JSON snapshot used by the UI

The live pipeline dashboard remains at `/`. Pull-request proof aggregates live
separately at `/pr-proof-triage`. OpenClaw Bay is unaffected by this collection
change: it does not consume `/api/triage`.

## Public Contract

The API response uses schema version 2 and contains only:

- a normalized `generated_at` timestamp;
- `complete` and a bounded `error_count`;
- a `counts` map keyed by the closed view IDs below; and
- one entry per view with its fixed ID, title, description, bounded
  `total_count`, bounded internal `item_limit`, and an always-empty `items`
  compatibility array.

The fixed issue-triage views are:

| View ID                   | Public title            | Static public description                                                         |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| `clawsweeper`             | ClawSweeper             | Open issues carrying any ClawSweeper label.                                       |
| `ready-candidates`        | Ready candidates        | Queueable fixes without a no-new-fix-pr blocker.                                  |
| `queueable-blocked`       | Queueable but blocked   | Queueable-looking fixes where ClawSweeper also recommends no new fix PR.          |
| `already-has-pr`          | Already has PR          | Issues where ClawSweeper found an open linked pull request.                       |
| `needs-info`              | Needs info              | Issues needing reporter details before ClawSweeper can verify behavior.           |
| `needs-maintainer-review` | Needs maintainer review | Issues where a human maintainer decision is the next useful step.                 |
| `product-security`        | Product or security     | Issues needing product, behavior, or security-sensitive review.                   |
| `needs-live-repro`        | Needs live repro        | Issues where source evidence exists but live validation would improve confidence. |

View IDs, titles, and descriptions come from server-side definitions. The
projector rejects missing, duplicate, extra, malformed, or inconsistent views
instead of accepting a new public dimension implicitly. Counts are safe
integers no greater than 1,000,000. `item_limit` is between 1 and 1,000 for a
valid snapshot and describes only the bounded private collection used to
calculate the view; it is not a promise that public item rows are available.

`complete` is true only when label and Search collection produced no
diagnostics. Real source failures and exhausted Search budgets remain incomplete
and contribute to `error_count`; their text is never serialized. Linked-PR
GraphQL enrichment is not performed, so missing enrichment auth, GraphQL
failures, and enrichment truncation cannot mark otherwise valid counts incomplete.
Invalid or uncertain input produces a fixed unavailable aggregate:
`generated_at` is null, `complete` is false, `error_count` is 1, every count and
limit is null, and every `items` array is empty.

The response never contains repository names, item numbers, titles, URLs or
query strings, authors, assignees, labels, linked-item metadata, routing groups,
or error text. Query parameters do not select or reveal a narrower identity
set.

## Collection and Cache Boundary

The Worker currently collects GitHub Search results privately in memory. It
discovers configured advisory labels, loads a bounded broad issue sample, and
uses fixed focused searches when a capped broad sample cannot support a
complete view. View membership uses labels (including `clawsweeper:linked-pr-open`
for Already has PR); Search counts use `total_count`. The Worker does not fetch
linked-PR metadata or compute routing groups. None of the raw records is a
public or ordinary persisted triage model.

The Worker applies the public projector before serializing either the fresh or
stale cache body. It applies the same projector again on every cache read. A
legacy cache body that contains raw issue rows is parsed and reprojected before
it can be returned; it is never forwarded as stored. New cache writes contain
only the schema-version-2 aggregate response. If collection fails, the Worker
may serve the last valid stale aggregate, but it does not expose the collection
exception.

This creates the required order:

1. collect private GitHub data in memory;
2. validate and reduce it to the closed aggregate schema;
3. serialize that projection to fresh and stale caches; and
4. reproject any cached body before public output.

## Browser Surface

The unauthenticated page shows the aggregate category counts and completeness
state only. It intentionally has no per-item table, repository or item filter,
search box, label chips, item links, linked-PR links, or browser-local item
sorting. Those capabilities require a separately designed and authenticated
operator surface with an explicit access boundary; that surface does not
currently exist.

Before public schema version 2, the page rendered issue rows and browser-local
filters from raw cached snapshots. That behavior is historical compatibility
context, not the current public contract. Do not restore it on these routes.

## Local Development

Use an authenticated GitHub token for stable Search API limits:

```bash
GITHUB_TOKEN="$(gh auth token)" \
TRIAGE_TARGET_REPOS="owner/repository" \
pnpm run dashboard:dev
```

Then open:

```text
http://127.0.0.1:8787/triage
```

Set `TRIAGE_CACHE_TTL_SECONDS` to a lower value while testing. The default is
two minutes.

## Boundaries

Keep this public dashboard aggregate-only and read-only:

- no raw GitHub records in responses, caches, snapshots, logs, or errors
- no repository, item, workflow, URL, person, label, or free-text dimensions
- no GitHub Project writes, label mutations, comments, close or merge actions,
  or repair dispatch
- no assumption that Cloudflare Access is the privacy boundary

Any future item-level inspection or action flow must be separately
authenticated, explicitly authorized, and designed with its own persistence
and audit boundaries.
