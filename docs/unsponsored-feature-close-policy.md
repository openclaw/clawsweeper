# Unsponsored Feature Request Close Policy

Read when changing automatic handling for old feature requests that still need
a maintainer product decision.

ClawSweeper can propose `unsponsored_feature_request` only for
`openclaw/openclaw` issues that meet every deterministic review gate:

- `item_category: feature`;
- `requires_product_decision: true`;
- `maintainer_decision.required: true` with `kind: product_direction`;
- no label whose normalized name contains `security`, including
  `impact:security` or `clawsweeper:needs-security-review`.

The review lane only writes a durable close proposal. Apply is default-off and
requires the repository variable
`CLAWSWEEPER_UNSPONSORED_FEATURE_CLOSE_ENABLED=true`. When the gate is disabled,
apply records the skip without consuming or rewriting the durable proposal.

Even when enabled, apply fails closed unless the issue is older than 90 days.
It re-fetches live state and keeps the issue open when it is assigned,
milestoned, no longer open, already meets the positive-reaction revival
threshold, has 20 or more total reactions, has a
`clawsweeper:linked-pr-open` label, has any security-named label, has any
maintainer comment, or has any non-bot comment from the last 60 days.

GitHub reads are mandatory evidence. Any issue or paginated-comment read
failure becomes a recorded keep-open reason. Snapshot drift and the standard
protected-label gates still apply.

Successful closes use GitHub's `not_planned` state reason but are reversible
idea-archive parks, not rejections. Apply creates and adds the
`clawsweeper:idea-archive` label before closing. The public comment explains
that the issue automatically reopens after a maintainer or configured
allowlisted login comments `@clawsweeper revive` (or `@clawsweeper sponsor`),
or after its `+1`, heart, and hooray reactions reach
`CLAWSWEEPER_IDEA_REVIVAL_REACTIONS` (default 5), and points to ClawHub when the
request can live as an extension. Apply and revival workflow jobs read the same
repository variable so an issue already at that threshold is never parked only
to be reopened by the next watcher run.

`.github/workflows/idea-archive-revival.yml` checks the archive every six hours.
It uses a target-repository GitHub App token with `issues: write`, scans a
bounded number of closed labeled issues and comment pages, and reopens at most
10 issues per run by default. A two-page updated-descending pass finds new
sponsorship commands regardless of archive size. Successive six-hour UTC slots
then alternate created-descending and created-ascending scans for reaction-only
revivals. Those revivals can lag in a very large archive; tune the bounded scan
with `CLAWSWEEPER_IDEA_ARCHIVE_SCAN_PAGES`. Comment requests sort newest-first
and use one second before the issue's close timestamp as `since`, then locally
reject pre-close comments. This includes close-second commands despite GitHub's
strictly-after, second-precision filter.

Reopen, archive-label removal, and revival-comment posting are isolated
mutations. A bounded open-and-archive-labeled reconciliation pass retries
cleanup in the same run. It posts only when complete post-close comment history
shows no existing bot revival comment; uncertain history stays uncommented.
An indeterminate apply close keeps the archive label so this reconciliation can
remove it if the issue remained open; a successfully closed issue remains
discoverable for revival.
API or mutation failures are logged and skipped so the next issue can still be
evaluated.
