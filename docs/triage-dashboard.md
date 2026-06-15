# Triage Dashboard

Read when changing the read-only ClawSweeper advisory-label triage surface.

The triage dashboard is a maintainer visibility surface for open issues. It
does not mutate GitHub issues, project items, labels, comments, closes, or
repair state. It reads GitHub Search results server-side, caches a short-lived
snapshot, and renders views from labels that ClawSweeper already applies. If a
refresh is temporarily rate-limited by GitHub, the API keeps serving the last
good stale snapshot when one is available.

## Routes

- `/triage`: browser UI for advisory-label views
- `/api/triage`: JSON snapshot used by the UI

The existing live pipeline dashboard remains at `/`.

The pull-request proof triage dashboard lives separately at `/pr-proof-triage`.

## Data Model

The worker discovers labels in the target repository whose names start with
`clawsweeper:`. That lets newly-created ClawSweeper labels appear in the broad
view without adding each one to a project board or changing browser-side code.

The focused views are derived from fixed high-signal label combinations:

| View                    | Query shape                                                                 |
| ----------------------- | --------------------------------------------------------------------------- |
| ClawSweeper             | any discovered `clawsweeper:` label                                         |
| Ready candidates        | `clawsweeper:queueable-fix` without `clawsweeper:no-new-fix-pr`             |
| Queueable but blocked   | `clawsweeper:queueable-fix` and `clawsweeper:no-new-fix-pr`                 |
| Already has PR          | `clawsweeper:linked-pr-open`                                                |
| Needs info              | `clawsweeper:needs-info`                                                    |
| Needs maintainer review | `clawsweeper:needs-maintainer-review`                                       |
| Product or security     | `clawsweeper:needs-product-decision` or `clawsweeper:needs-security-review` |
| Needs live repro        | `clawsweeper:needs-live-repro`                                              |

The API loads the broad ClawSweeper-labelled issue snapshot once per repository
and derives the focused views from that loaded snapshot when the broad snapshot
is complete. This keeps the page within GitHub Search rate limits instead of
firing one Search request for every tab. If the broad snapshot is capped, the API
falls back to direct Search queries for focused views so tab counts and loaded
rows do not silently look complete. Fallback focused queries load one Search page
per view by default to stay under GitHub Search rate limits while preserving
authoritative total counts. The API also keeps a global Search request budget,
reducing the broad per-repo load when multiple triage repositories are configured
and falling back to loaded broad rows with a diagnostic after the budget is spent.
If no root Search budget remains for later repositories, those repositories are
skipped for that snapshot with a diagnostic instead of overrunning GitHub Search
limits.
The broad snapshot loads up to `TRIAGE_ITEMS_PER_VIEW`; the default is 500, with
an upper bound of 1,000 because GitHub Search only exposes the first 1,000
results for a query.
Each returned view includes its own effective `item_limit`, so the dashboard can
show when a focused fallback view intentionally loaded fewer rows than the broad
snapshot while still reporting the authoritative total count.

The issue table includes assignees and, for issues carrying
`clawsweeper:linked-pr-open`, linked pull requests from GitHub timeline data. It
defaults to newest created issue first. Maintainers can filter the loaded
snapshot by title, issue number, author, assignee, linked PR number or state,
repository, priority, impact group, or label, and can switch the local sort
between created time, issue number, update time, and comment count without
changing GitHub state.

Impact groups are a read-only projection of existing `impact:*` labels:

| Group            | Labels                                    |
| ---------------- | ----------------------------------------- |
| Message delivery | `impact:message-loss`                     |
| Auth providers   | `impact:auth-provider`                    |
| State and data   | `impact:session-state`, `impact:data-loss` |
| Reliability      | `impact:crash-loop`                       |
| Security         | `impact:security`                         |
| Other impact     | `impact:other`                            |
| Unclassified     | no recognized impact label                |

An issue may appear in multiple groups. The dashboard does not pick a primary
group, create labels, assign maintainers, or route work. Group filters operate
on the loaded snapshot and persist in the URL plus browser-local storage.

Priority values and label chips are clickable shortcuts. Clicking a chip writes
that value into the filter box and narrows the current view in place.

The table is browser-local state only. Issue titles wrap so maintainers can
read more context without opening GitHub, and each column can be resized from
the header edge. Column widths are saved in `localStorage`; they do not affect
other users or any GitHub state.

The UI displays the loaded-row count and the per-view snapshot limit so users
can tell when filtering is operating on a bounded local result set rather than
an unbounded GitHub search.

## Local Development

Use an authenticated GitHub token for stable Search API limits:

```bash
GITHUB_TOKEN="$(gh auth token)" \
TRIAGE_TARGET_REPOS="openclaw/openclaw" \
pnpm run dashboard:dev
```

Then open:

```text
http://127.0.0.1:8787/triage
```

Set `TRIAGE_CACHE_TTL_SECONDS` to lower values while testing. The default is
two minutes.

## Boundaries

Keep this dashboard read-only:

- no GitHub Project writes
- no label mutations
- no comments
- no close or merge actions
- no repair dispatch

If a future iteration adds actions, they should use a separate explicit
maintainer-controlled flow rather than piggybacking on advisory labels.

## Future Ideas

A later phase could refine these broad impact groups with repository-specific
component labels, then add assignee suggestions or auto-assignment rules. For
example, a `clawsweeper:needs-product-decision` issue mentioning Telegram could
suggest or assign the maintainer who owns Telegram behavior. That should be
designed separately from this read-only dashboard, with clear ownership rules,
auditability, and an opt-in maintainer-controlled path before any GitHub
assignee mutation happens.
