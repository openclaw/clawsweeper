# GitHub API Limits At openclaw Scale

- Status: active audit reference
- Owner: ClawSweeper maintainers
- Source of truth: the GitHub readers named in each row, `/api/github-egress-observability`,
  and live probes against `openclaw/openclaw`
- Last verified: `openclaw/clawsweeper@2d6eb4d561` on 2026-11-08 (after [#2183](https://github.com/openclaw/clawsweeper/pull/2183), [#2184](https://github.com/openclaw/clawsweeper/pull/2184) and [#2185](https://github.com/openclaw/clawsweeper/pull/2185) merged)
- Update when: a reader starts calling a new GitHub route, changes its page size or
  pagination, or openclaw crosses another documented limit

Read when adding or changing any GitHub read. On 2026-11-07 `openclaw/openclaw`
outgrew the recursive tree listing and most reviews failed ([#2183](https://github.com/openclaw/clawsweeper/pull/2183)). This page
records, for every route ClawSweeper reads, the hard limit GitHub enforces, how
GitHub signals it, what our code does at the limit, and where openclaw stands.

## openclaw scale on 2026-11-08

| Measure | Value |
|---|---|
| Tracked tree entries (`main`) | 67,554 (recursive tree listing now `truncated: true`) |
| Open pull requests | about 2,900 |
| Check runs on an open PR head | over 100 on 144 of 200 sampled heads (72%); max 299 |
| Changed files on one PR | 5,018 ([#194566](https://github.com/openclaw/openclaw/pull/194566)) |
| Commits on one PR | 2,522 ([#129388](https://github.com/openclaw/openclaw/pull/129388)) |
| Timeline events on one PR | 703 ([#129388](https://github.com/openclaw/openclaw/pull/129388); 3.8 MB, 13.4 s to read in full) |
| Comments on one PR | 476 ([#141004](https://github.com/openclaw/openclaw/pull/141004); 1.4 MB, 4.3 s) |
| Repository labels | 405 |
| `is:pr is:open` search results | 3,046 |

## Route table

Ranked by risk: **silent** means partial data was used as if complete; **fails**
means the reader stops safely at the limit; **ok** means the reader handles the
limit or openclaw is far from it.

| Route | Hard limit and signal | Our reader at the limit | openclaw live probe | Status |
|---|---|---|---|---|
| `GET git/trees/{sha}?recursive=1` | 100,000 entries or 7 MB; `truncated: true` | Was: refused (`review_blob_metadata_unavailable`) | `truncated: true` since 2026-11-07 ~16:00 UTC | **Fixed** by [#2183](https://github.com/openclaw/clawsweeper/pull/2183): GraphQL `object(oid)` byte sizes for only the missing blobs |
| `GET commits/{sha}/check-runs` | 100 per page; `total_count` | Before [#2184](https://github.com/openclaw/clawsweeper/pull/2184)/[#2185](https://github.com/openclaw/clawsweeper/pull/2185): first page only in review hydration, apply guard and dashboard CI. Now: every page, bounded at 10, with completeness reported | 72% of open heads over 100; failures past page 1 on 14 of 30 checked | **Was silent; fixed** by [#2184](https://github.com/openclaw/clawsweeper/pull/2184) (hydration and guard, merged) and [#2185](https://github.com/openclaw/clawsweeper/pull/2185) (dashboard, merged) |
| `GET commits/{sha}/status` | statuses paged (default 30, max 100); `total_count` | Before [#2184](https://github.com/openclaw/clawsweeper/pull/2184): guard read the first 30. Now: every page | 3 statuses per head today | **Was silent at scale; fixed** by [#2184](https://github.com/openclaw/clawsweeper/pull/2184) (merged) |
| `GET pulls/{n}/files` | 3,000 files total (page 31+ is empty, no error) | Prompt window marks truncated; capacity guard refuses when count differs from `changed_files` | [#194566](https://github.com/openclaw/openclaw/pull/194566): page 30 has 100 files, page 31 returns 0 of 5,018 | ok: no reader treats the list as complete |
| `GET pulls/{n}/commits` | 250 commits (page 4+ is empty, no error) | Prompt window marks truncated, but its "latest commits" tail is empty past 250 | [#129388](https://github.com/openclaw/openclaw/pull/129388): page 3 returns 50, page 4 returns 0 of 2,522 | ok for decisions (head SHA comes from the PR); prompt context shows only the oldest 250 |
| `GET pulls/{n}` diff media type | 300 files; HTTP 406 `too_large` | Not used for review source (local git diff) | [#194566](https://github.com/openclaw/openclaw/pull/194566) returns `too_large` | ok |
| `GET compare/{a}...{b}` | 250 commits and 300 files in the body | Only `status` is read | — | ok (single fields; response size bounded) |
| `GET search/issues` | 1,000 results; `incomplete_results` | Mixed. Count guards (author open-PR budget, bulk-filer counts) use `per_page=1` and reject `incomplete_results`. Placeholder recovery pages within 1,000 and records the flag. The structural relation probe (`structuralExternalRelationSensitivity`) treats an incomplete search with no match as unknown, so the review is not reused from cache. The related-item and merged-PR prompt-context searches and the recovery-label backfill read `items` without the flag: they only add context or act on matches they find, and the backfill revisits every page on rotation | `is:pr is:open` has 3,046 | ok; no decision trusts an incomplete empty result |
| `GET actions/runs?status=…` | 1,000 results per filtered query | Dashboard census bounded at 3 pages and marks `census_incomplete`; apply continuation in `sweep.yml` swallows errors (`|| true`) | about 60 queued after the cleanup | ok today; the `sweep.yml` reader fails open (follow-up) |
| `GET actions/runs` (unfiltered) | history listing; slow at large run counts | Removed from the status refresh by [#2154](https://github.com/openclaw/clawsweeper/pull/2154) | 10–11 s, occasional 502 | **Fixed** by [#2154](https://github.com/openclaw/clawsweeper/pull/2154) |
| `GET issues/{n}/timeline` | none documented; paged at 100 | Apply guard reads every page to find force-push events for the head | [#129388](https://github.com/openclaw/openclaw/pull/129388): 703 events, 3.8 MB, 13.4 s | ok but wasteful (follow-up: filtered GraphQL `timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT])`) |
| `GET issues/{n}/comments` | none; paged at 100 | Paged in full where completeness matters; prompt windows otherwise; ETag-conditional in the publisher (93% 304s in telemetry) | [#141004](https://github.com/openclaw/openclaw/pull/141004): 476 comments, 1.4 MB | ok |
| `GET pulls/{n}/reviews`, `pulls/{n}/comments` | none; paged at 100 | Paged in full or with an explicit limit | — | ok |
| `GET repos/{repo}/labels` | none; paged at 100 | Paged in full | 405 labels, 5 pages | ok |
| GraphQL connections | 100 nodes per page; `pageInfo` | Review cache, activity cursor and census query `pageInfo` / `totalCount` and treat overflow as incomplete | — | ok |
| GraphQL `closingIssuesReferences(first: 100)` | 100 | No `pageInfo` | no PR close to 100 | ok (follow-up: request `pageInfo`) |
| `GET contents/{path}` | inline body only up to 1 MB (1–100 MB returns no `content`; use the raw media type); directories list 1,000 entries | Apply-guard path checks read existence only. The dashboard apply-health reader (`readApplyHealthMarker`) decodes the inline body of the sweep-status JSON in the state repository | status file is a few KB | ok while the status file stays under 1 MB (follow-up: request `application/vnd.github.raw` so size cannot remove the body) |

## How the live probes were run

Read-only `gh api` calls with a maintainer token against `openclaw/openclaw` on
2026-11-08: the largest open PRs by changed files, commits, comments and review
threads came from a GraphQL scan of the 200 most recently updated open PRs, and
check-run counts from `statusCheckRollup.contexts.checkRunCount`. Production
call volume comes from `/api/github-egress-observability` (six-hour window).

## Gaps

- `/api/github-egress-observability` does not classify `git/trees`, so the
  failing route of 2026-11-07 appeared only as `unknown`. Routes added to
  readers must also get a route template, or the telemetry hides them.
- The egress feed truncates at 2,000 rows (`rows_truncated: true`). Rows are
  ordered by `bucket_start` ascending, so truncation keeps the earliest buckets
  of the six-hour window; how much time that covers depends on row density, and
  the most recent buckets are the ones dropped.
