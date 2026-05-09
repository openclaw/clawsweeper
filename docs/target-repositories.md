# Target Repositories

Read when enabling ClawSweeper for another OpenClaw repository, changing
`config/target-repositories.json`, or debugging `Unsupported target repo`
failures.

ClawSweeper has two target-repository paths:

- configured dashboard targets in `config/target-repositories.json`
- a conservative generic fallback for exact event/manual reviews of
  `openclaw/*` repositories

`openclaw/openclaw` remains a built-in profile because it has broader
auto-close policy. Other configured targets default to safer repo-local rules:
issues are review/comment-only, and PRs may auto-close only when the same
change is certainly already implemented on `main`.

## Generic OpenClaw Fallback

The fallback lets a newly installed OpenClaw repo dispatch to ClawSweeper
without a TypeScript change. It is intentionally narrow:

- owner must be `openclaw`
- repo name must match `allow_repo_name_pattern`
- denied repositories are rejected
- issues cannot be auto-closed
- PRs can auto-close only for `implemented_on_main` or age-gated
  `mostly_implemented_on_main`
- scheduled dashboard/backfill rows are not added automatically

This is enough for event-driven review after the target repo has the dispatcher
workflow and GitHub App installation. It is not a blanket scheduled rollout.

## Add One Repository

1. Install the ClawSweeper GitHub App on the target repository.
2. Add or merge the target dispatcher from
   [`docs/target-dispatcher.md`](target-dispatcher.md).
3. Ensure the target repo can read the org or repo
   `CLAWSWEEPER_APP_PRIVATE_KEY` secret.
4. Open, edit, or comment on a target issue/PR and confirm a dispatcher run
   appears in the target repo.
5. Confirm the receiver run appears in
   `https://github.com/openclaw/clawsweeper/actions`.
6. Confirm the target item gets one durable ClawSweeper review comment.

For a repo that should appear in the README dashboard or scheduled queues, add
it to `config/target-repositories.json` with an explicit prompt note and
close-policy block. Keep the default policy unless the repo has a documented
reason to allow broader issue closes.

## Add Many Repositories

Batch rollout should be incremental:

- install the app and dispatcher on a small group first
- leave scheduled backfill off
- verify event review/comment sync on one issue or PR per repo
- add config entries for repos that should show in the dashboard
- enable scheduled backfill/apply only after repo-specific safety rules exist

If a target dispatch reaches ClawSweeper but receiver token creation fails, the
App is usually not installed on that target repo. If the target workflow skips
before dispatch, the target repo usually cannot access
`CLAWSWEEPER_APP_PRIVATE_KEY`.
