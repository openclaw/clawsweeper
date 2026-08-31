# PR Proof Triage Dashboard

Read when changing the unauthenticated ClawSweeper pull-request proof-triage
observer surface.

The PR proof triage dashboard is a read-only aggregate view of open pull
requests grouped by fixed proof categories. It does not publish pull-request
rows or mutate pull requests, labels, comments, reviews, merge state, or repair
state.

## Routes

- `/pr-proof-triage`: browser UI for aggregate proof-triage counts
- `/api/pr-proof-triage`: aggregate JSON snapshot used by the UI

Issue-triage aggregates remain at `/triage`.

## Public Contract

The API uses the same closed schema-version-2 envelope as `/api/triage`: a
normalized timestamp, `complete`, bounded `error_count`, a closed `counts` map,
and fixed view descriptors. Each view contains a bounded `total_count`, the
bounded private collection `item_limit`, and an always-empty `items`
compatibility array.

The fixed proof-triage views are:

| View ID                      | Public title             | Static public description                                                           |
| ---------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `proof-triage`               | Proof triage             | Open pull requests carrying proof or proof-triage labels.                           |
| `needs-proof`                | Needs proof              | Open PRs where real behavior proof is still requested.                              |
| `missing-proof`              | Needs proof review       | Proof is requested, but ClawSweeper has not marked it sufficient or overridden.     |
| `sufficient-proof`           | Proof sufficient         | ClawSweeper judged the real behavior proof sufficient.                              |
| `mock-only-proof`            | Mock-only proof          | Proof appears to rely only on tests, mocks, snapshots, lint, typecheck, or CI.      |
| `telegram-proof`             | Telegram proof           | PRs that need Telegram Test Server proof with the repository E2E skill.              |
| `sufficient-with-need-label` | Sufficient + needs label | PRs that have sufficient proof but still carry the needs-real-behavior-proof label. |

View IDs, titles, and descriptions are server-owned constants. The projector
rejects missing, duplicate, extra, malformed, or inconsistent views. Counts
are safe integers no greater than 1,000,000; a valid `item_limit` is between 1
and 1,000. The limit describes private bounded collection and does not make
item rows public.

`complete` is true only when private collection produced no diagnostics. The
public response retains only a bounded diagnostic count, never diagnostic
text. Invalid or uncertain input becomes the same fixed unavailable aggregate
used by issue triage: a null timestamp, false completeness, one error, null
counts and limits, and empty item arrays.

The response contains no repository names, pull-request numbers, titles, URLs
or query strings, authors, assignees, labels, proof text, comments, or error
text. Query parameters do not expose item-level filters or identities.

## Collection and Cache Boundary

The Worker executes the fixed proof searches against GitHub and holds the
resulting pull-request rows only in the private in-memory collection model. It
uses authoritative Search totals while bounding the loaded rows to control
Search pressure. No raw row is part of the public or ordinary persisted model.

The public projector runs before every fresh or stale cache write and again on
every cache read. Raw schema-version-1 legacy cache bodies are reprojected into
the aggregate schema before a response is serialized; they are never forwarded
directly. New cache bodies contain aggregate counts only. A failed collection
may use the last valid stale aggregate, and the underlying exception remains
private.

## Browser Surface

The unauthenticated page shows fixed proof-category counts and completeness
state only. It has no pull-request table, repository or item filter, search
box, author or assignee filter, proof or label chips, pull-request links, or
browser-local item sorting. Item-level proof inspection requires a separately
authenticated operator surface, which does not currently exist.

Before public schema version 2, the page rendered pull-request rows and local
filters from raw cached snapshots. That is historical compatibility context,
not current behavior. Do not restore it on the public routes.

## Local Development

Use an authenticated GitHub token for stable Search API limits:

```bash
GITHUB_TOKEN="$(gh auth token)" \
TRIAGE_TARGET_REPOS="owner/repository" \
pnpm run dashboard:dev
```

Then open:

```text
http://127.0.0.1:8787/pr-proof-triage
```

Set `PR_PROOF_TRIAGE_CACHE_TTL_SECONDS` to a lower value while testing. The
default is two minutes.

## Boundaries

Keep this public dashboard aggregate-only and read-only:

- no raw GitHub records in responses, caches, snapshots, logs, or errors
- no repository, item, workflow, URL, person, label, proof-text, or free-text
  dimensions
- no PR comments or reminders, label mutations, reviews, merge actions, or
  repair dispatch
- no assumption that Cloudflare Access is the privacy boundary

Any future item-level inspection, reminders, routing, or proof actions must use
a separately authenticated, explicitly authorized operator flow with its own
persistence and audit boundaries.
