<img width="1584" height="672" alt="clawsweeper_banner" src="https://github.com/user-attachments/assets/6b2a0d0f-aca8-47e5-8a1f-eb266c760646" />

# 🐠 ClawSweeper

ClawSweeper is a conservative OpenClaw maintainer tool for one-cluster issue and PR cleanup.

It takes a curated GitHub issue/PR cluster, asks a Codex worker to classify the items, and applies only narrow, auditable cleanup actions when the evidence is strong. It shares the same ClawSweeper repo and GitHub App as the commit and backlog sweepers, but runs as a separate repair lane with stricter mutation gates.

For the canonical repair `job_intent` contract and workflow/TypeScript boundary,
see [`docs/orchestration.md`](../orchestration.md).
For the complete GitHub Actions, durable Codex thread, CrabFleet steering,
GitCrawl intake, dashboard, completion, and recovery lifecycle, see
[`docs/steerable-repair-automation.md`](../steerable-repair-automation.md).

Allowed automated close reasons:

- duplicate of a clear canonical thread
- superseded by a clear canonical thread
- fixed by a specific candidate fix

Manual backlog-cleanup jobs may also use
[`instructions/low-signal-prs.md`](../../instructions/low-signal-prs.md) for
drive-by PRs that are clearly blank-template, docs-only discoverability churn,
test-only coverage spam, refactor-only noise, third-party capabilities that
belong on ClawHub, risky unapproved infra, or dirty branches. This policy is
opt-in per job and should return `needs_human` for plausible bug fixes or
anything with active maintainer signal.

Everything else stays open or is escalated for maintainer review.

Security-sensitive reports are deliberately out of scope. ClawSweeper
routes those refs to central OpenClaw security handling and keeps processing
unrelated ordinary bugs, provider gaps, and duplicate cleanup in the same
cluster. It follows OpenClaw `SECURITY.md`: trusted-operator exec behavior,
provider gaps, feature gaps, and hardening-only parity drift are not treated as
vulnerabilities unless there is a real trust-boundary bypass.

## Status

The repair lane is intentionally narrower than the sweep lanes. The sweepers scan OpenClaw commits and backlog items on a cadence; repair handles targeted clusters that were already grouped by a human, gitcrawl, or another dedupe tool.

Cluster discovery currently comes from [openclaw/gitcrawl](https://github.com/openclaw/gitcrawl).
ClawSweeper reads existing gitcrawl SQLite state; it does not crawl or download
issues during repair import. By default, import scripts prefer a checked-out
portable store at `../gitcrawl-store/data/<owner>__<repo>.sync.db`, then
`~/.config/gitcrawl/stores/gitcrawl-store/data/<owner>__<repo>.sync.db`, then
the legacy `~/.config/gitcrawl/gitcrawl.db`. Use `--db` or
`CLAWSWEEPER_GITCRAWL_DB` to override. Store freshness is maintained outside
ClawSweeper by the gitcrawl-store refresh workflow and by refreshing the local
checkout, for example `git -C ../gitcrawl-store pull --ff-only`, before
importing jobs.

<img width="3582" height="2160" alt="image" src="https://github.com/user-attachments/assets/20b816cc-72ab-479e-bc18-84f5b2b53745" />

The default workflow is proposal-first. It does not comment or close unless a job is explicitly promoted and the deterministic applicator confirms live GitHub state has not changed.

## State Boundaries

`jobs/` and `results/` are durable operational state in
`openclaw/clawsweeper-state`, not generated source in this repo. They may
contain historical run text and audit evidence. Active code, prompts, workflows,
docs, schemas, and tests are covered by `pnpm run check:active-surface`, which
rejects retired project names and old token variables before the full gate runs.

## Dashboard

Live dashboard and generated state: https://github.com/openclaw/clawsweeper-state

## How It Works

For a maintainer-facing architecture map of the automation lanes, see
[`internal-features.md`](internal-features.md).

For the ClawSweeper feedback loop that updates existing generated PRs, see
[`docs/repair/auto-update-prs.md`](auto-update-prs.md).
For the exact automerge state machine, wait behavior, and operator replay, see
[`docs/repair/automerge-flow.md`](automerge-flow.md).

That loop is marker-driven. ClawSweeper comments use hidden
`clawsweeper-verdict:*` markers, and only actionable PR feedback includes
`clawsweeper-action:fix-required`. ClawSweeper skips stale head SHAs and caps
automatic repairs at ten per PR and one per PR head SHA.

Maintainers can opt an existing PR into the bounded repair-only loop with
`/clawsweeper autofix`, or into the bounded merge loop with
`/clawsweeper automerge`. Autofix adds `clawsweeper:autofix`, dispatches
ClawSweeper for the current head, and lets ClawSweeper repair trusted
`needs-changes` findings for up to ten rounds without merging. Automerge adds
`clawsweeper:automerge` and can merge only after a trusted pass verdict for the
exact current head plus a non-draft PR, green checks, clean mergeability, and
explicit `CLAWSWEEPER_ALLOW_MERGE=1` global merge permission.

Issue-generated PRs always enter the autofix mode. Each actionable review
dispatches repair and another exact-head review. A clean review waits for
required checks to appear and settle green, then removes the repair-loop label
and leaves the PR open; generated issue PRs never automerge.

ClawSweeper commit findings have a separate intake lane. A
`clawsweeper_commit_finding` dispatch fetches the latest markdown commit report,
writes an audit record under `results/commit-findings/`, and only sends the
finding into the PR executor when the issue is narrow, non-security, and still
worth repairing on latest `main`.

Each cluster job:

1. Starts from one markdown job file under `jobs/`.
2. Hydrates the listed issue/PR refs and first-hop linked refs.
3. Builds a cluster plan and fix artifact for autonomous jobs.
4. Runs Codex with repo-local policy prompts and JSON output schema in a read-only sandbox when a planning pass is needed. Adopted automerge/autofix PR repairs skip this read-only model pass after live hydration and emit a generic fix artifact directly.
5. Writes structured run artifacts under `.clawsweeper-repair/runs/`.
6. Reviews the worker artifact with deterministic safety checks.
7. Executes credited fix artifacts through `scripts/execute-fix-artifact.ts` when the fix gate is open: repair a writable contributor branch first, treating same-repo head branches as writable even when GitHub reports `maintainer_can_modify=false`; otherwise raise a narrow replacement PR, copy source labels, add non-bot source PR authors as replacement co-authors, and close the uneditable source PR after the replacement push succeeds.
8. Applies guarded close/comment and explicit merge actions through `scripts/apply-result.ts`.
9. Publishes a sanitized result ledger back to `openclaw/clawsweeper-state`
   under `results/`, `jobs/openclaw/closed/`, `repair-apply-report.json`, and
   `notifications/`; the external dashboard and Discord notification dedupe
   render from that ledger.

Codex does not receive a GitHub token during classification. The runner preflights GitHub state before model execution, then Codex receives those artifacts and returns JSON only when a planning pass is required; adopted automerge/autofix repairs use the hydrated live PR to produce the generic repair artifact without that extra Codex pass. When a reviewed fix artifact is executed, Codex gets a temporary target checkout without GitHub credentials; the deterministic executor owns commit, push, PR creation, and source-PR closeout using the short-lived GitHub App token exposed to the executor as `GH_TOKEN`. Commit author metadata defaults to `clawsweeper-repair` and can be overridden with `CLAWSWEEPER_GIT_USER_NAME` and `CLAWSWEEPER_GIT_USER_EMAIL`; this is separate from the GitHub token used to push. The applicator re-fetches the target item, checks `updated_at`, blocks unsafe closeouts, writes idempotent close comments, closes supported duplicate/superseded/fixed-by-candidate actions, and can squash-merge explicitly allowed clean PR actions.

Merge is deliberately harder than closeout. A merge action must include `merge_preflight` proving security clearance, resolved human comments, resolved review-bot findings, addressed review findings, and clean validation commands. The fix executor gives Codex the normalized changed-surface validation gate up front, so the agentic edit loop is edit, run validation, fix validation fallout, rerun validation, and only then return. The deterministic executor still re-runs validation as the final safety rail, then feeds any remaining validation failure back through a narrow Codex validation-fix pass, runs Codex `/review`, feeds actionable review findings back into Codex for the configured review-fix budget, and revalidates after each pass. If the final internal `/review` still finds something actionable, the worker gives Codex one last review-fix prompt and pushes only if changed-surface validation passes; the normal exact-head ClawSweeper review, GitHub checks, and live unresolved-thread checks still gate the merge.

Replacement fix work uses a recoverable target branch named `clawsweeper/<cluster-id>`. The executor resumes that branch if it already exists and pushes checkpoint commits after agent edits and review-fix edits, adding `Co-authored-by` trailers for non-bot source PR authors when a contributor PR is replaced. It then opens or updates the PR only after validation and internal review/fix handling. If validation or Codex itself still blocks after retries, the run writes a blocked fix report and leaves the checkpoint branch recoverable instead of losing the patch.

Runs for the same job path and mode are queued instead of running concurrently. The workflow uses Node 24, `blacksmith-4vcpu-ubuntu-2404` for cluster planning/review, and `blacksmith-16vcpu-ubuntu-2404` for fix/apply execution. Fix execution prepares the target checkout with Corepack and the target `pnpm` package manager before validation; the execution job caches Codex, npm, Corepack, and the target pnpm store. Fix validation is pinned to OpenClaw's fast changed-lane posture by default: `pnpm check:changed` plus diff checks are the hard local gate, and target validation commands normalize to `pnpm check:changed` unless `CLAWSWEEPER_TARGET_VALIDATION_MODE=strict` or `CLAWSWEEPER_STRICT_TARGET_VALIDATION=1` is explicitly set. Adopted OpenClaw automerge repairs force strict target validation and add `pnpm lint` plus `pnpm check:test-types`, so maintainer-approved automerge branches keep iterating on common terminal CI failures before push. The deterministic repair artifact also carries failing exact-head check names and links when available, and the prompt treats those failed checks as automerge repair scope even when the failing file is outside the original `likely_files`; Codex must rebase, inspect logs, fix the narrow failure, or prove current `main` is independently blocked. That normalized gate is also passed to Codex in the write prompt; Codex is expected to run it, fix failures it introduced, and report the exact command/result before returning. Unrelated flaky main CI, broad `pnpm check`, full tests, live, docker, and e2e lanes do not block narrow ClawSweeper Repair fixes by default.

If Codex itself fails an edit pass with a transient tool-transport error, such
as a closed stdin session from the Codex tool router, the executor consumes an
edit retry and keeps the branch recoverable instead of failing the whole repair
worker immediately. Timeouts and validation failures still use their dedicated
timeout, validation-fix, and review-fix paths.

Full worker prompts, Codex transcripts, and raw artifacts stay in GitHub Actions. The committed ledger keeps only the cluster summary, run URL, action counts, apply outcomes, closed targets, and human-review entries.

## Modes

- `plan`: produces recommendations only.
- `execute`: can apply reviewed safe close and explicit clean merge actions from structured JSON.
- `autonomous`: adds live cluster preflight and fix-artifact generation. It may recommend and drive a canonical fix path; direct mutation still goes through the fix executor and applicator gates.
- `route_security`: quarantines true security-sensitive refs without poisoning unrelated cluster work.
- `needs_human`: only product-direction, trust-boundary, canonical-choice, merge-path, or contributor-credit decisions that remain unclear after the hydrated artifact and single-item review/check/decide pass.
- Automated reviewer feedback must be cleared during autonomous PR work. Greptile, Codex, Asile, CodeRabbit, Copilot, and similar bot comments must be addressed, proven non-actionable, or escalated before any merge or post-merge closeout recommendation.
- Merge preflight: no PR can merge until `CLAWSWEEPER_ALLOW_MERGE=1`, security issues are cleared, comments are resolved, review findings are addressed, changed-surface validation is clean, and the pushed head passes exact-head ClawSweeper review plus GitHub checks. With the merge gate closed, ClawSweeper Repair labels merge-ready targets for human review instead of merging.
- Final base sync: before pushing a repaired branch, ClawSweeper fetches latest `origin/main`. If main moved after validation, the worker rebases once more and pushes that synchronized head; conflict resolution still goes back through Codex, but the fresh exact-head ClawSweeper review and GitHub checks gate the final merge instead of repeating local validation indefinitely. Set `CLAWSWEEPER_FINAL_BASE_SYNC_ATTEMPTS` above `1` only for controlled backfills where extra local validation is worth the latency.
- Repair ladder: make the useful contributor PR mergeable when its branch is writable; same-repo PRs are writable by the GitHub App contents permission even when the raw maintainer-edit flag is false. If a fork push is rejected because the rebase would create or update workflow files without effective workflow permission, publish the already-prepared repair as a base-repo replacement PR instead of rerunning Codex. Otherwise replace draft, stale, unmergeable, uneditable, or unsafe branches with a narrow credited fix PR. When fix PR mode is enabled, "wait or replace" is already answered: replace, preserve credit and labels, then supersede only the source PR that could not be safely updated.

## Maintainer Comment Commands

ClawSweeper can route maintainer comments from target repositories back into the
cloud repair workflow. It recognizes both command styles:

```text
/clawsweeper status
@openclaw-clawsweeper status
@clawsweeper status
```

Accepted mentions are `@clawsweeper`, `@clawsweeper[bot]`,
`@openclaw-clawsweeper`, or `@openclaw-clawsweeper[bot]`.

Only maintainers can trigger it. The router checks GitHub `author_association`
and accepts `OWNER`, `MEMBER`, and `COLLABORATOR` by default. Contributor and
unknown comments are ignored without a reply.

Supported commands:

```text
/review
/clawsweeper status
/clawsweeper re-review
/clawsweeper re-run
/clawsweeper implement
/clawsweeper build
/clawsweeper fix ci
/clawsweeper address review
/clawsweeper rebase
/clawsweeper autofix
/clawsweeper automerge
/clawsweeper auto merge
/clawsweeper approve
/clawsweeper explain
/clawsweeper stop
@clawsweeper re-review
@clawsweeper re-run
@clawsweeper review
@clawsweeper implement
@clawsweeper fix
@clawsweeper build
@clawsweeper create pr
@clawsweeper fix issue
@openclaw-clawsweeper fix ci
@clawsweeper why did automerge stop here?
```

`status` and `explain` post a short status reply. `review`, `re-review`, and
`re-run` dispatch ClawSweeper review again for an open issue or PR. Issue and PR
authors may use only these read-only review commands on their own open item.
`fix ci`, `address review`,
and `rebase` dispatch the normal `repair-cluster-worker.yml` repair path, but only for
existing ClawSweeper PRs identified by the `clawsweeper/*` branch.
`implement`, `fix`, `build`, `create pr`, and `fix issue` work only on open issues.
The router creates or reuses one durable `issue-<repo>-<number>` job and
dispatches the normal repair worker to verify the issue on latest `main` and
open or update one narrow implementation PR. This lane never merges or closes
the issue; broad, underspecified, security-sensitive, or already-fixed issues
become a blocked repair result instead of a public PR.
Outside `openclaw/openclaw` and `openclaw/clawhub`, the normal review publisher
also dispatches this same worker for newly reviewed issues and bounded backfill
from existing open issue reports when automatic issue implementation is
enabled. Codex discovers the implementation and validation from the
repository; deterministic intake still blocks protected/security signals,
opt-outs, stale issue state, queued issue jobs, and duplicate or linked PRs.
Generated PRs receive `clawsweeper:autogenerated` plus
`clawsweeper:autofix`, continue through exact-head review/fix/re-review, and
remain open for manual merge.
Freeform maintainer mentions such as `@clawsweeper why did automerge stop here?`
dispatch a read-only assist review. The answer lands in the next ClawSweeper
comment; action-looking prose can only become existing structured
recommendations and still passes the normal deterministic gates.
`autofix` opts an open PR into the bounded review/fix loop and never merges.
`automerge` opts an open PR into the bounded review/fix/merge loop, but draft
PRs stay fix-only until GitHub marks them ready for review. `approve` is
maintainer-only exact-head approval after a human-review pause; it clears pause
labels and merges only when the normal automerge readiness checks and merge
gate pass. A later trusted pass for the exact current head also clears stale
pause labels before continuing automerge. `stop` labels the item for human review.
It also removes repair-loop labels, so older automerge/autofix commands and
trusted pass markers cannot continue the loop after the stop.

The router writes an idempotency marker into each reply and records processed
comments in `results/comment-router.json`. The scheduled workflow is dry by
default; set `CLAWSWEEPER_COMMENT_ROUTER_EXECUTE=1` to let scheduled runs post
replies and dispatch workers.

Scheduled runs also sweep open PRs with `clawsweeper:autofix` or
`clawsweeper:automerge` labels. When a labelled PR is stale, failing checks, or
dirty/behind its base branch, the router can synthesize an internal trusted
repair-loop command and re-enter the normal repair path without waiting for a
new GitHub comment. `clawsweeper:human-review` still pauses that path.

## Local Run

Requires Node 24.

```bash
# Validate all job files.
pnpm run repair:validate

# Render a plan-mode prompt without running Codex.
pnpm run repair:render -- jobs/openclaw/inbox/cluster-example.md --mode plan

# Dry-run a worker without calling Codex.
pnpm run repair:worker -- jobs/openclaw/inbox/cluster-example.md --mode plan --dry-run

# Build an offline autonomous cluster/fix artifact.
pnpm run repair:build-fix-artifact -- jobs/openclaw/inbox/autonomous-example.md --offline

# Stage low-signal PR sweep jobs from local gitcrawl data.
# Uses --db/CLAWSWEEPER_GITCRAWL_DB, a local gitcrawl-store checkout, or the
# legacy ~/.config/gitcrawl/gitcrawl.db; it never fetches GitHub issues itself.
pnpm run repair:import-gitcrawl-low-signal -- --limit 20 --batch-size 5 --mode autonomous --sort stale

# Stage the next largest active gitcrawl clusters, skipping already-imported,
# security-sensitive, feature-request, and 75%+ closed clusters by default.
# Mixed clusters can route security refs while continuing ordinary bug/dedupe work.
pnpm run repair:import-gitcrawl -- --from-gitcrawl --limit 40 --mode autonomous --suffix autonomous-smoke --allow-instant-close --allow-merge --allow-fix-pr --allow-post-merge-close

# Automatic imported-cluster intake runs through repair-cluster-intake.yml.
# gitcrawl-store refreshes openclaw/openclaw every 15 minutes; the ClawSweeper
# intake runs daily, records the processed portable DB SHA in
# results/cluster-repair-intake/<repo>.json, and skips repeated ticks for the
# same store snapshot. It imports at most one cluster by default and dispatches
# through the two-worker cluster_repair lane.

# Dispatch reviewed jobs. Dispatch derives its default live-worker cap from the
# job's job_intent and config/automation-limits.json. Existing repair lanes
# keep the normal 40%-of-workers.max cap, currently 51; imported gitcrawl
# cluster jobs default to lanes.repair.cluster_max_live_runs, currently 2.
# Use CLAWSWEEPER_MAX_LIVE_WORKERS/--max-live-workers for a one-lane override.
# With --wait-for-capacity, dispatch can drain a larger file
# list in capacity-sized waves instead of refusing the whole batch.
CLAWSWEEPER_MAX_LIVE_WORKERS=51 pnpm run repair:dispatch -- jobs/openclaw/inbox/ordinary-example.md \
  --mode autonomous \
  --runner blacksmith-4vcpu-ubuntu-2404 \
  --execution-runner blacksmith-16vcpu-ubuntu-2404

# Imported gitcrawl cluster jobs drip-feed by default.
CLAWSWEEPER_MAX_LIVE_WORKERS=2 pnpm run repair:dispatch -- jobs/openclaw/inbox/cluster-example.md \
  --mode autonomous \
  --runner blacksmith-4vcpu-ubuntu-2404 \
  --execution-runner blacksmith-16vcpu-ubuntu-2404

# Find failed cluster jobs that have not been superseded by a later success.
pnpm run repair:self-heal

# Resolve a job from a run id or job path and show the requeue plan.
pnpm run repair:requeue -- 24947178021

# Requeue one reviewed job/run into the live queue. This briefly opens both
# write gates when the job is execute/autonomous, waits for the run to start,
# then closes the gates.
pnpm run repair:requeue -- 24947178021 --execute --open-execute-window \
  --runner blacksmith-4vcpu-ubuntu-2404 \
  --execution-runner blacksmith-16vcpu-ubuntu-2404

# Execute a reviewed fix artifact locally. Requires both execution gates and a write token.
CLAWSWEEPER_ALLOW_EXECUTE=1 CLAWSWEEPER_ALLOW_FIX_PR=1 pnpm run repair:execute-fix -- jobs/openclaw/inbox/cluster-example.md --latest --dry-run

# Rebuild the open ClawSweeper PR finalization report without mutating GitHub.
pnpm run repair:finalize-open-prs -- --write-report

# Dry-run maintainer comment routing. Recognizes `/clawsweeper ...`,
# `@clawsweeper ...`, and `@openclaw-clawsweeper ...` in recent issue/PR comments.
pnpm run repair:comment-router -- --repo openclaw/openclaw --lookback-minutes 180

# Execute maintainer comment routing: post replies, dispatch re-reviews, and
# dispatch repair workers for existing ClawSweeper PRs when maintainers ask for
# `fix ci`, `address review`, or `rebase`.
pnpm run repair:comment-router -- --repo openclaw/openclaw --execute --wait-for-capacity

# Dry-run job hygiene: classify old smoke jobs, outbox-ready jobs, unprocessed
# jobs, and requeue candidates without deleting, moving, or dispatching.
pnpm run repair:sweep-openclaw-jobs -- --live

# Apply reviewed job hygiene. This deletes old smoke jobs, moves finalized jobs
# to jobs/openclaw/outbox/finalized, and parks never-run backlog in
# jobs/openclaw/outbox/stuck; it never dispatches workers.
pnpm run repair:sweep-openclaw-jobs -- --live --apply-delete-tests --apply-outbox --apply-stuck

# Dry-run a parked-backlog promotion from outbox/stuck back into inbox.
pnpm run repair:promote-stuck-jobs -- --limit 20

# Promote the largest parked-backlog jobs into the active queue.
pnpm run repair:promote-stuck-jobs -- --sort size --limit 20 --apply

# Promote every parked-backlog job, largest clusters first.
pnpm run repair:promote-stuck-jobs -- --sort size --limit all --apply

# Dry-run the ClawSweeper label backfill. This verifies live GitHub state and
# reports the exact PRs/issues that would receive the "clawsweeper" label.
pnpm run repair:tag-clawsweeper -- --live

# Apply the label backfill after reviewing the dry-run report.
CLAWSWEEPER_ALLOW_EXECUTE=1 pnpm run repair:tag-clawsweeper -- --live --apply

# Retry failed jobs once. This briefly opens the execution gate, waits for the
# dispatched workers to start, records the self-heal ledger, and closes the gate.
pnpm run repair:self-heal -- --execute --open-execute-window --max-jobs 5 \
  --max-live-workers 12 \
  --runner blacksmith-4vcpu-ubuntu-2404 \
  --execution-runner blacksmith-16vcpu-ubuntu-2404
```

## Checks

```bash
pnpm run repair:validate
pnpm run check
pnpm run repair:review-results -- .clawsweeper-repair/runs
pnpm run repair:publish-result -- .clawsweeper-repair/runs
git diff --check
```

## GitHub Actions Setup

The workflow needs:

- Codex/OpenAI authentication for model execution
- a read-only GitHub token for worker inspection
- a separate write-scoped GitHub token for the deterministic applicator
- execution gates that default closed: set `CLAWSWEEPER_ALLOW_EXECUTE=1` and `CLAWSWEEPER_ALLOW_FIX_PR=1` only for an intentional execution window; otherwise execute/autonomous dispatches render plan-only output and skip mutation steps
- `CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED=1` opt-in for the scheduled
  `repair-cluster-intake.yml` imported-cluster intake. Direct repair import and
  dispatch commands are not blocked by this variable; they keep the existing
  repair execution gates. Gitcrawl cluster import skips clusters with at least
  75% closed members by default; pass `--skip-closed-percent` only for an
  intentional broader import.
- optional `CLAWSWEEPER_CLUSTER_REPAIR_IMPORT_LIMIT` variable for the scheduled
  imported-cluster intake; default is `1` cluster per daily run.
- merge is separately gated by `CLAWSWEEPER_ALLOW_MERGE`, which defaults to `0`; merge-ready PRs are labeled `clawsweeper:human-review` and `clawsweeper:merge-ready` for a maintainer to merge manually when the global gate is closed
- required `CLAWSWEEPER_MODEL` GitHub Actions secret containing the actual
  internal model name; workflows, dispatch payloads, comments, and reports use
  only the public `internal` alias
- Codex CLI and its responses API proxy install from their latest npm tags on
  every worker run
- repair workers default to high reasoning on the fast service tier, and
  accidental `xhigh` reasoning overrides are normalized back to `high`
- optional `CLAWSWEEPER_MAX_LIVE_WORKERS` variable for dispatch/requeue/self-heal worker fan-out; dispatch defaults are derived from `job_intent`, cluster-lane classification, `workers.max`, and `lanes.repair.cluster_max_live_runs`
- optional `CLAWSWEEPER_MAX_ACTIVE_PRS_PER_AREA` variable for replacement PR backpressure; default is `50` open ClawSweeper PRs per touched area, `0` disables the area cap, and common changelog/release-note files are ignored for this check
- ClawSweeper commit-finding repair PRs are labeled `clawsweeper:commit-finding`
- optional `CLAWSWEEPER_CODEX_TIMEOUT_MS`, `CLAWSWEEPER_FIX_CODEX_TIMEOUT_MS`,
  and `CLAWSWEEPER_FIX_STEP_TIMEOUT_MS` variables; worker planning defaults to
  30 minutes, while fix execution defaults to a 20 minute per-Codex-call budget
  inside a 40 minute executor budget. The cluster execute job keeps a 45 minute
  timeout and a 40 minute execute-step cap so long edit/test passes still leave
  room for internal `/review`, post-flight, and timeout artifact upload instead
  of falling into a 30-second review floor near the end of the run.
- optional `CLAWSWEEPER_CODEX_RETRY_DELAY_MS` variable for edit-worker backoff
  after retryable Codex transport or TPM rate-limit exits; default is `15000`.
- If a contributor branch changes while a repair is preparing its push, the
  executor records `requeue_required: true` and the same workflow dispatches a
  fresh repair run for the latest head after publishing the result. This keeps
  the force-with-lease guard intact without waiting for a later scheduled sweep.
- optional `CLAWSWEEPER_NETWORK_COMMAND_TIMEOUT_MS` variable; repair execution
  uses bounded Git/GitHub network calls so a stuck clone, fetch, push, or API
  request fails in time for the executor to write a blocked report and upload
  debug artifacts. `CLAWSWEEPER_GIT_NETWORK_TIMEOUT_MS` and
  `CLAWSWEEPER_GH_COMMAND_TIMEOUT_MS` can override the Git and GitHub CLI
  portions separately.
- optional `CLAWSWEEPER_CODEX_REVIEW_ATTEMPTS` and `CLAWSWEEPER_RESOLVE_REVIEW_THREADS` variables for agentic merge-prep review loops; the review attempt default is `4`, with the last failed internal review converted into one final Codex review-fix pass when changed-surface validation can still prove the branch safe to push for exact-head review
- optional `CLAWSWEEPER_MAX_REPAIRS_PER_PR` and
  `CLAWSWEEPER_MAX_REPAIRS_PER_HEAD` variables for trusted
  ClawSweeper review feedback; defaults are `10` automatic repair iterations per
  PR and `2` repairs per PR head SHA. The per-PR cap is total across changing
  head SHAs and stops the automatic review/repair loop.
- In-flight branch repair workers re-fetch the live PR before mutation and block
  if `clawsweeper:human-review` is present, so a trusted needs-human verdict or
  maintainer stop wins over stale queued repair jobs.
- optional `CLAWSWEEPER_COMMENT_ROUTER_EXECUTE=1` to let the scheduled comment
  router respond to maintainer-only `/clawsweeper ...` and
  `@clawsweeper ...` / `@openclaw-clawsweeper ...` commands. Without it,
  scheduled runs only write a dry report.

Keep exact secret names, token scopes, and execution-window procedures in private operations docs or repository settings notes. Do not put token values or live operational credentials in job files.
