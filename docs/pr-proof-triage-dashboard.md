# PR Proof Triage Dashboard

Read when changing the read-only ClawSweeper pull-request proof triage surface.

The PR proof triage dashboard is a maintainer visibility surface for open pull
requests that are blocked on real behavior proof. It does not mutate GitHub pull
requests, labels, comments, reviews, merge state, or repair state.

## Routes

- `/pr-proof-triage`: browser UI for proof-label views
- `/api/pr-proof-triage`: JSON snapshot used by the UI

The issue triage dashboard remains at `/triage`.

## Data Model

The worker reads a fixed set of proof-related labels from the target repository:

- `triage: needs-real-behavior-proof`
- `triage: mock-only-proof`
- `proof: sufficient`
- `proof: override`
- `mantis: telegram-visible-proof`

The focused views are derived from high-signal label combinations:

| View                     | Query shape                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Proof triage             | any configured proof-related label                                                                       |
| Needs proof              | `triage: needs-real-behavior-proof`                                                                      |
| Needs proof review       | `triage: needs-real-behavior-proof` without `proof: sufficient` or `proof: override`                     |
| Proof sufficient         | `proof: sufficient`                                                                                      |
| Mock-only proof          | `triage: mock-only-proof`                                                                                |
| Telegram proof           | `mantis: telegram-visible-proof`                                                                         |
| Sufficient + needs label | `triage: needs-real-behavior-proof` and `proof: sufficient`                                              |

The API queries each proof view directly so the main stuck buckets are not
undercounted by a broad first-page snapshot. The `Needs proof review` view loads
up to `PR_PROOF_ITEMS_PER_VIEW`; the default
is 500, with an upper bound of 1,000 because GitHub Search only exposes the
first 1,000 results for a query. Broader summary views load fewer rows while
still using GitHub's `total_count`, so the metric cards stay accurate without
spending extra Search requests on less-actionable tabs. The endpoint uses the
same short-lived and stale-cache pattern as the issue triage dashboard to reduce
repeat GitHub Search pressure.

The table includes author, assignees, priority, proof state, labels, updated
time, and comments. Maintainers can filter the loaded snapshot by title, pull
request number, author, assignee, proof state, priority, or label. Priority,
proof-state, author, and label chips are clickable shortcuts that write that
value into the filter box.

## Local Development

Use an authenticated GitHub token for stable Search API limits:

```bash
GITHUB_TOKEN="$(gh auth token)" \
TRIAGE_TARGET_REPOS="openclaw/openclaw" \
pnpm run dashboard:dev
```

Then open:

```text
http://127.0.0.1:8787/pr-proof-triage
```

## Boundaries

Keep this dashboard read-only:

- no PR comments or reminders
- no label mutations
- no reviews
- no merge actions
- no repair dispatch

A later phase could add contributor reminders for PRs that remain in the
`Needs proof review` view for a maintainer-defined period, or route selected PRs
to maintainers who can validate behavior in Crabbox. That should be a separate
opt-in workflow with clear wording, cooldowns, and maintainer control.
