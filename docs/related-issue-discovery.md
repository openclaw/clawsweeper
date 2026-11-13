# Related Issue Discovery

ClawSweeper includes compact related issue and PR context in each review prompt so
the reviewer can spot duplicates, superseded work, adjacent reports, and already
active fix paths. This context is advisory. It gives the review model evidence;
it does not itself close issues, change labels, open PRs, or merge anything.

## Sources

Related item context is built from a small set of bounded sources:

- Explicit links in the item body, comments, timeline, PR body, and PR review
  comments, including `#123` references and same-repository GitHub issue or PR
  URLs.
- GitHub closing-PR references for issues, such as PRs that use `Fixes #123`.
- Existing local ClawSweeper reports with overlapping title terms.
- Optional local gitcrawl cluster data, when a gitcrawl SQLite database is
  available.
- Optional live GitHub issue search for exact event reviews.

The review prompt still requires a conservative canonical-search pass before
using `duplicate_or_superseded`. The related context is a starting point, not a
standalone duplicate verdict.

Supplementary bodies mask scanner-recognized credentialed HTTP(S) URL userinfo
before entering the prompt. The complete prompt still passes the normal input
scan; primary review input does not receive this supplementary redaction.
Timeline source issues from another repository are not looked up by their bare
number in the target repository.

## Root-Cause Assessment

Each new review records a typed `rootCauseCluster` assessment separately from
the existing work-lane `workClusterRefs`. It classifies the current item and up
to 12 evidence-backed same-repository issue or PR URLs, records at most one
canonical item, and preserves a short reason for every member.

The independent low-confidence assessment is the default when no cluster is
established. High-confidence assessments with a canonical item may be shown in
the public review comment to make maintainer decisions easier. The assessment
is proposal-only: it does not dispatch repair, suppress jobs, mutate sibling
items, close, or merge anything.

## Live GitHub Search

Live GitHub Search is intentionally opt-in because the Search API has tighter
rate limits than normal issue reads. Exact event reviews enable it by default in
the ClawSweeper workflow:

```text
CLAWSWEEPER_RELATED_GITHUB_SEARCH=1
```

Set `CLAWSWEEPER_RELATED_GITHUB_SEARCH=0` in repository variables to disable the
live search enrichment without changing code.

The search is issue-only, scoped to the target repository, and based on a small
set of non-generic title terms. Results are included in the prompt as candidate
related items so the reviewer can decide whether they are truly duplicates,
adjacent reports, or irrelevant matches.

## Gitcrawl

When a local gitcrawl database exists, ClawSweeper reads same-cluster issue
siblings from the same target repository as the reviewed issue and adds them to
the same related-item prompt section. ClawSweeper does not run a gitcrawl fetch
or download issues during review; it only reads an existing SQLite database.

Database lookup order is:

```text
CLAWSWEEPER_GITCRAWL_DB
../gitcrawl-store/data/<owner>__<repo>.sync.db
~/.config/gitcrawl/stores/gitcrawl-store/data/<owner>__<repo>.sync.db
~/.config/gitcrawl/gitcrawl.db
```

Use `CLAWSWEEPER_GITCRAWL_DB=/path/to/gitcrawl.db` to point at a different
database. If the database or `sqlite3` is unavailable, this source is skipped
silently and the review continues with the other context sources.

For portable gitcrawl-store checkouts, freshness is maintained by the store
workflow and by refreshing the local checkout, for example with
`git pull --ff-only` before a run. Both current portable gitcrawl tables and the
older legacy cluster tables are supported on a best-effort basis.

### Service-backed review context

An explicit service selector replaces SQLite discovery for review context:

```text
CLAWSWEEPER_GITCRAWL_ENDPOINT=https://archive.example.org
CLAWSWEEPER_GITCRAWL_ARCHIVE=public-clusters
CLAWSWEEPER_GITCRAWL_READER_TOKEN=<reader token>
```

Use HTTPS, or loopback HTTP for an isolated preview. Do not also set
`CLAWSWEEPER_GITCRAWL_DB`. A token alone does not select the service. Review
preparation fails if the selected service is unavailable or unqualified; it
never falls back to SQLite or treats that failure as an empty cluster.

Each service probe reads the current immutable binding, then queries at that
same completed snapshot. The reader admits only the public durable cluster
profile, bounds responses and related issues, and retains native IDs as decimal
text. Explicit links and local report relations still merge through the existing
dedupe and 12-item context limit. No acquisition runs during a probe.

Cluster completeness describes the retained historical view, not current GitHub
freshness. Positive related evidence marks structural sensitivity; an empty
service result remains unknown even when the view is structurally complete.
Context includes capture and source/analysis clocks without inventing a freshness
threshold. Credentials and service URLs are not included in context or errors.

Service-selected review-start reservations check the live issue and comments or
PR head without hydrating related context. Their queue authority, revision checks,
and owned-lease cleanup still apply. `apply-artifacts` can publish completed
review records and their work plans without reading cluster context. Its live
GitHub state checks and reconciliation behavior are unchanged. `apply-decisions`
and synchronous context hydration remain held until their guards support service
preparation. Local
read-only review remains available; no service selector preserves the existing
SQLite behavior.

## Guardrails

- Related discovery does not create new labels.
- Related discovery does not auto-close an item by itself.
- Related discovery does not make repair or automerge decisions.
- Root-cause assessments do not dispatch or deduplicate repair jobs.
- Duplicate or superseded close proposals still require concrete evidence in
  the review and must pass the existing apply-time live-state checks.
- GitHub Search is enabled only for exact one-item event reviews by default, not
  broad scheduled sweeps.
