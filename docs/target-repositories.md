# Target Repositories

- Status: active configuration and onboarding reference
- Owner: ClawSweeper maintainers
- Source of truth: `config/target-repositories.json`, repository profiles,
  target inventory, dashboard/apply configuration, and profile tests
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: profile policy, supported owners, inventory, dashboard targets,
  apply membership, or onboarding requirements change

Read when enabling ClawSweeper for another OpenClaw repository, changing
`config/target-repositories.json`, or debugging `Unsupported target repo`
failures.

ClawSweeper has two target-repository paths:

- configured runtime profiles in `config/target-repositories.json`
- conservative generic fallbacks for exact event/manual reviews of configured
  owner inventories such as `openclaw/*` and `steipete/*`

`openclaw/openclaw` remains a built-in profile because it has broader
auto-close policy. Every other configured profile declares its own issue and PR
close rules in `apply_close_rules`; do not infer those rules from whether the
repository appears in the dashboard or receives scheduled work. The current
configured profiles allow `implemented_on_main` for issues and PRs, and some
profiles additionally allow age-gated `mostly_implemented_on_main` for PRs.

Review guidance belongs to the selected profile's `promptNote` in
`src/repository-profiles.ts` or `config/target-repositories.json`. The production
prompt assembler selects it with `repositoryProfileFor(item.repo)`, using the
normalized exact owner/repository, not the organization, display name, PR body,
linked repository, or author association. The built-in `openclaw/openclaw`
profile alone supplies its release-owned `CHANGELOG.md` review restriction.
`openclaw/clawsweeper`, ClawHub, and generic targets follow their own release-note
policies; being a non-core target does not grant contributors or workers
permission to edit release-owned files.

OpenClaw’s generated locale PRs are publisher-owned. Automatic apply and repair
close paths leave PRs open when live GitHub metadata identifies
`openclaw-mantis[bot]` as author, both head and base repositories as
`openclaw/openclaw`, base branch `main`, and head branch
`automation/native-app-locale-refresh` or `automation/control-ui-locale-refresh`.
GraphQL reports the same App author as `app/openclaw-mantis`. Titles and labels
do not grant this exemption, nor do matching branches in forks. The publisher
owns freshness reconciliation and auto-merge; this close guard grants no merge
authority and preserves normal review and CI requirements. Existing kept-open,
blocked, and skipped outcomes explain the decision, with no Bay schema or
control changes.

Toolchain and setup ownership is also per repository. The explicit
`openclaw/crabbox` profile selects npm and installs its nested worker package
with `npm ci --prefix worker` from the target root. It retains the generic
OpenClaw fallback's close rules, empty validation commands, and absent changed
gate; selecting target-native setup does not broaden apply policy or inherit
the core OpenClaw policy.

Dashboard targets are configured separately with `TARGET_REPOS` in
`dashboard/wrangler.toml`. Scheduled target selection comes from
`target_inventory`, and apply-enabled targets use the dashboard's
`APPLY_TARGET_REPOS` and `APPLY_OPTIONAL_TARGET_REPOS`. A runtime profile alone
does not enable any of those surfaces.

`PUBLIC_BAY_REPOS` is a separate public-output allowlist for the minimal
repository/item reference cards shown by OpenClaw Bay and Overview. Add a
repository only after confirming that it is public and intended to be visible
on the unauthenticated dashboard. The Worker treats an absent or malformed
allowlist as empty. Membership does not authorize titles, URLs, queries,
failure data, opaque keys, credentials, tokens, or any private-repository data.

## Generic Fallbacks

The fallback lets a newly installed repository dispatch to ClawSweeper
without a TypeScript change. It is intentionally narrow:

- owner must be listed in `generic_fallbacks`
- repo name must match `allow_repo_name_pattern`
- denied repositories are rejected
- scheduled fanout is public-only unless a private state publication path exists
- auto-close policy comes from that owner fallback
- `live_test`, when present, is retained for compatibility with historical
  live-proof records and tooling; automatic review-time live proof is retired
- generic `openclaw/*` issues can auto-close only for
  `implemented_on_main`; PRs can auto-close for `implemented_on_main` or
  age-gated `mostly_implemented_on_main`
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

Add a `config/target-repositories.json` entry when a repository needs explicit
review guidance, toolchain configuration, or close rules. Dashboard and
scheduled-queue membership are separate changes; update their owning
configuration only when that rollout is intended. Keep close rules narrow
unless the repository has a documented reason for broader policy.

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
