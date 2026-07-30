# Target Repositories

Read when enabling ClawSweeper for another OpenClaw repository, changing
`config/target-repositories.json`, or debugging `Unsupported target repo`
failures.

ClawSweeper has two target-repository paths:

- configured dashboard targets in `config/target-repositories.json`
- conservative generic fallbacks for exact event/manual reviews of configured
  owner inventories such as `openclaw/*` and `steipete/*`

`openclaw/openclaw` remains a built-in profile because it has broader
auto-close policy. Other configured targets default to safer repo-local rules:
issues are review/comment-only, and PRs may auto-close only when the same
change is certainly already implemented on `main`.

## Generic Fallbacks

The fallback lets a newly installed repository dispatch to ClawSweeper
without a TypeScript change. It is intentionally narrow:

- owner must be listed in `generic_fallbacks`
- repo name must match `allow_repo_name_pattern`
- denied repositories are rejected
- scheduled fanout is public-only unless a private state publication path exists
- auto-close policy comes from that owner fallback
- `openclaw/*` issues cannot be auto-closed; PRs can auto-close only for
  `implemented_on_main` or age-gated `mostly_implemented_on_main`
- `steipete/*` starts review/comment-only for issues and PRs
- scheduled dashboard/backfill rows are added only through target fanout

This is enough for event-driven review after the target repo has the dispatcher
workflow and GitHub App installation.

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

Batch rollout should use target fanout:

- install the app and dispatcher on a small group first
- leave auto-close disabled unless the owner/repo profile explicitly enables it
- verify event review/comment sync on one issue or PR per repo
- use `pnpm run target-fanout -- plan --mode hot-intake --limit 10 --dry-run`
  to inspect the current owner inventory and selected dispatch commands
- let the scheduled fanout cursor dispatch small batches across
  `target_inventory.owners`; the cursor is stored in the authenticated
  ExactReviewQueue Durable Object rather than `clawsweeper-state`
- fanout passes each repository's default branch as `target_branch`, so repos
  that use `master` or another branch do not fall back to `main`
- add config entries only for repos that need repo-specific guidance or broader
  close policy

If a target dispatch reaches ClawSweeper but receiver token creation fails, the
App is usually not installed on that target repo. If the target workflow skips
before dispatch, the target repo usually cannot access
`CLAWSWEEPER_APP_PRIVATE_KEY`.
