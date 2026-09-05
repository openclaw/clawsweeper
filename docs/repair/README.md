<img width="1584" height="672" alt="clawsweeper_banner" src="https://github.com/user-attachments/assets/6b2a0d0f-aca8-47e5-8a1f-eb266c760646" />

# 🐠 ClawSweeper

- Status: active repair entry point and local command reference
- Owner: ClawSweeper maintainers
- Source of truth: repair source, workflows, `package.json`, and focused repair
  tests; [operations](operations.md) is canonical for live procedures
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: repair modes, command entry points, job/result shape, or linked
  canonical guides change

## Use the right repair document

| Need | Canonical page |
| --- | --- |
| Understand repair concepts, modes, artifacts, or local CLI entry points | This page |
| Run or recover live repair work | [Operations](operations.md) |
| Change implementation objects, stages, ledgers, or extension points | [Internal feature map](internal-features.md) |
| Change trusted PR autofix/automerge behavior | [Auto-updating PRs](auto-update-prs.md) |
| Understand the end-to-end steerable session protocol | [Steerable repair automation](../steerable-repair-automation.md) |

The operations runbook is the single source for live command trust, mutation
gates, runner selection, token boundaries, routing, recovery, and promotion.
This entry point keeps the conceptual model and local command catalog. It does
not grant authority to open an execution or merge gate.

ClawSweeper is a conservative OpenClaw maintainer tool for one-cluster issue and PR cleanup.

It takes a curated GitHub issue/PR cluster, asks a Codex worker to classify the items, and applies only narrow, auditable cleanup actions when the evidence is strong. It shares the same ClawSweeper repo and GitHub App as the backlog sweeper, but runs as a separate repair lane with stricter mutation gates.

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

Before internal review, the host scans the explicit prompt/schema and complete
introduced before/after source bytes from the actual validated dirty checkout.
The index and raw worktree snapshots stay alive through admission, including
staged bytes that differ from the working file. Drift, scanner failures, and findings stop the run as infrastructure
refusals; they never enter the review-fix or JSON-repair paths. No target-bundled
autoreview helper or second reviewer is started. See the
[safety model](../../README.md#safety-model) for the trusted scanner prerequisite,
staging/deadline limits, and the distinction from later tool/history scanning.

`jobs/` and `results/` are durable operational state in
`openclaw/clawsweeper-state`, not generated source in this repo. They may
contain historical run text and audit evidence. Active code, prompts, workflows,
docs, schemas, and tests are covered by `pnpm run check:active-surface`, which
rejects retired project names and old token variables before the full gate runs.
Review records are canonical in the Cloudflare Worker; action ledgers and assets
are canonical in R2. See [`../state-storage.md`](../state-storage.md).

## Dashboard

Live dashboard and generated state: https://github.com/openclaw/clawsweeper-state

## How It Works

For a maintainer-facing architecture map of the automation lanes, see
[`internal-features.md`](internal-features.md).

For the ClawSweeper feedback loop that updates existing generated PRs, see
[`docs/repair/auto-update-prs.md`](auto-update-prs.md).
For the exact automerge state machine, wait behavior, and operator replay, see
[`docs/repair/automerge-flow.md`](automerge-flow.md).
For the repository-owned local-container, CI, and Crabbox end-to-end validation,
see [`docs/repair/automerge-e2e.md`](automerge-e2e.md).
For the separate path that can turn an eligible issue into a generated PR, see
[`docs/repair/automatic-issue-prs.md`](automatic-issue-prs.md).

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

The commit-finding intake lane was retired with the commit-review lane in July
2026; existing `commit_finding` jobs remain executable through the cluster
worker.

Each cluster job:

1. Starts from one markdown job file under `jobs/`.
2. Hydrates the listed issue/PR refs and first-hop linked refs.
3. Builds a cluster plan and fix artifact for autonomous jobs.
4. Runs Codex with repo-local policy prompts and JSON output schema in a read-only sandbox when a planning pass is needed. Adopted automerge/autofix PR repairs skip this read-only model pass after live hydration and emit a generic fix artifact directly.
5. Writes structured run artifacts under `.clawsweeper-repair/runs/`.
6. Reviews the worker artifact with deterministic safety checks.
7. Executes credited fix artifacts through `src/repair/execute-fix-artifact.ts` when the fix gate is open: repair a writable contributor branch first, treating same-repo head branches as writable even when GitHub reports `maintainer_can_modify=false`; otherwise raise a narrow replacement PR, copy source labels, add non-bot source PR authors as replacement co-authors, and close the uneditable source PR after the replacement push succeeds.
8. Applies guarded close/comment and explicit merge actions through `src/repair/apply-result.ts`.
9. Publishes a sanitized result ledger back to `openclaw/clawsweeper-state`
   under `results/`, `jobs/openclaw/closed/`, `repair-apply-report.json`, and
   `notifications/`; the external dashboard and Discord notification dedupe
   render from that ledger.

Codex does not receive a GitHub token during classification. The runner preflights GitHub state before model execution, then Codex receives those artifacts and returns JSON only when a planning pass is required; adopted automerge/autofix repairs use the hydrated live PR to produce the generic repair artifact without that extra Codex pass. When a reviewed fix artifact is executed, Codex gets a temporary target checkout without GitHub credentials; the deterministic executor owns commit, push, PR creation, and source-PR closeout using the short-lived GitHub App token exposed to the executor as `GH_TOKEN`. Commit author metadata defaults to `clawsweeper-repair` and can be overridden with `CLAWSWEEPER_GIT_USER_NAME` and `CLAWSWEEPER_GIT_USER_EMAIL`; this is separate from the GitHub token used to push. The applicator re-fetches the target item, checks `updated_at`, blocks unsafe closeouts, writes idempotent close comments, closes supported duplicate/superseded/fixed-by-candidate actions, and can squash-merge explicitly allowed clean PR actions.

Merge is deliberately harder than closeout. A merge action must include `merge_preflight` proving security clearance, resolved human comments, resolved review-bot findings, addressed review findings, and clean validation commands. The fix executor gives Codex the normalized changed-surface validation gate up front, so the agentic edit loop is edit, run validation, fix validation fallout, rerun validation, and only then return. The deterministic executor still re-runs validation as the final safety rail, then feeds any remaining validation failure back through a narrow Codex validation-fix pass, runs Codex `/review`, feeds actionable review findings back into Codex for the configured review-fix budget, and revalidates after each pass. If the final internal `/review` still finds something actionable, the worker gives Codex one last review-fix prompt and pushes only if changed-surface validation passes; the normal exact-head ClawSweeper review, GitHub checks, and live unresolved-thread checks still gate the merge.

Replacement fix work uses a recoverable target branch named `clawsweeper/<cluster-id>`. The executor resumes that branch if it already exists and pushes checkpoint commits after agent edits and review-fix edits, adding `Co-authored-by` trailers for non-bot source PR authors when a contributor PR is replaced. It then opens or updates the PR only after validation and internal review/fix handling. If validation or Codex itself still blocks after retries, the run writes a blocked fix report and leaves the checkpoint branch recoverable instead of losing the patch.

Runs for the same job path are queued instead of running concurrently (the workflow concurrency group is keyed by job path only, not by mode). The workflow uses Node 24, `blacksmith-4vcpu-ubuntu-2404` for cluster planning/review, and `blacksmith-16vcpu-ubuntu-2404` for fix/apply execution. Planning defaults to Codex's `read-only` sandbox. Maintainers may select `planner_sandbox: danger-full-access` only when moving a job to a trusted ephemeral runner whose host cannot start the Linux sandbox; the default and all automated dispatches stay read-only. Fix execution prepares the target checkout with Corepack and the target `pnpm` package manager before validation; the execution job caches Codex, npm, Corepack, and the target pnpm store. Fix validation is pinned to OpenClaw's fast changed-lane posture by default: `pnpm check:changed` plus diff checks are the hard local gate, and target validation commands normalize to `pnpm check:changed` unless `CLAWSWEEPER_TARGET_VALIDATION_MODE=strict` or `CLAWSWEEPER_STRICT_TARGET_VALIDATION=1` is explicitly set. Adopted OpenClaw automerge repairs require that changed-surface command without adding full-repository lint or typecheck gates; exact-head hosted CI remains the authority for broader repository health. The deterministic repair artifact also carries failing exact-head check names and links when available, and the prompt treats those failed checks as automerge repair scope even when the failing file is outside the original `likely_files`; Codex must rebase, inspect logs, fix the narrow failure, or prove current `main` is independently blocked. That normalized gate is also passed to Codex in the write prompt; Codex is expected to run it, fix failures it introduced, and report the exact command/result before returning. Unrelated flaky main CI, broad `pnpm check`, full tests, live, docker, and e2e lanes do not block narrow ClawSweeper Repair fixes by default.

Target dependency metadata may retain npm's positive `min-release-age` and
package-name `min-release-age-exclude[]` settings. Registry overrides and other
active package-manager configuration remain rejected; every YAML lockfile
document is checked against the approved destinations. OpenClaw changed-gate
validation restores `.cache/vitest`, `node_modules/.cache`, and
`node_modules/.vite` after success or failure. Neighboring ignored inputs remain
protected. A pending runtime build also retains its bound output until archive
smoke completes; cache restoration does not exempt that output from verification.

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

Reviewer-feedback, base-sync, repair-ladder, exact-head, and merge requirements
are canonical in [Auto-Updating ClawSweeper PRs](auto-update-prs.md). Live gate
handling and runner/token procedure are canonical in [Operations](operations.md).

## Maintainer Comment Commands

ClawSweeper routes trusted review, status, issue implementation, PR repair,
autofix, automerge, approval, explanation, and stop requests through its
maintainer comment router. The command matrix, accepted authors and mentions,
idempotency behavior, execution switch, and recovery procedure are canonical in
[Operations: Maintainer Comment Routing](operations.md#maintainer-comment-routing).
The trusted PR state contract and label behavior are canonical in
[Auto-Updating ClawSweeper PRs](auto-update-prs.md).

Keep these boundaries visible from the entry point:

- item authors may request read-only review of their own open item; repair and
  mutation commands require maintainer trust
- `autofix` never merges, and `automerge` still requires every exact-head,
  proof, review, check, mergeability, security, and global merge gate
- issue implementation never merges or closes the source issue
- `stop` pauses repair and removes continuation labels
- freeform questions are read-only and cannot bypass structured command gates

## Local Run

Requires Node 24.

Validation, rendering, dry-run, and artifact-building commands below are local
development surfaces. Commands that dispatch workflows, pass `--execute`, open
gates, alter labels, or publish live state are operator-only; use
[Operations](operations.md) for their authority, preflight, and recovery steps.

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

# Stage unprocessed active gitcrawl clusters. The scheduled intake gives their
# live evidence to the selector model, which chooses one useful cluster or none.
pnpm run repair:import-gitcrawl -- --from-gitcrawl --limit 40 --mode autonomous --suffix autonomous-smoke --allow-instant-close --allow-merge --allow-fix-pr --allow-post-merge-close

# Automatic imported-cluster intake runs through repair-cluster-intake.yml.
# gitcrawl-store refreshes openclaw/openclaw every 15 minutes; the ClawSweeper
# intake runs daily, records the processed portable DB SHA in
# results/cluster-repair-intake/<repo>.json, and skips repeated ticks for the
# same store snapshot. New snapshots are materialized by the store's own
# portable-artifact helper pinned to a reviewed digest, supporting raw and
# verified gzip archives. A helper update requires a reviewed digest change. Empty
# portable cluster tables produce no candidates; intake does not reconstruct
# clustering omitted by the upstream export. The selector model compares the candidate batch without
# word lists, scores, or semantic thresholds, and dispatches at most one cluster
# through the two-worker cluster_repair lane. Clusters with one live candidate
# and useful closed context remain eligible for model evaluation. Intake appends
# the selected job, store identity, model rationale and per-cluster decisions,
# and stable dispatch key directly to the coordinator-guarded operational Git
# state before dispatch. Decisions persist in a versioned sidecar, leaving the strict v2 dispatch
# ledger readable by in-flight older workers. Rejected cluster IDs are remembered
# instead of being offered again on the next snapshot. The intake workflow
# recovers pending dispatch before selecting new work.
#
# Durable intake dispatch guarantee: at-least-once workflow creation with
# exactly-once worker execution intent. GitHub workflow_dispatch has no atomic
# run receipt, so the intake owner publishes a durable dispatch claim before
# dispatching; a crash between claim publication and dispatch (or between
# dispatch and observing the run) may create another workflow run, and the
# worker-side dispatch receipt gate skips the duplicate planning pass.
# Recovery redispatches only ledger entries whose HMAC accepted-intent receipt
# verifies against the webhook secret.

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

This section is the canonical inventory of repair Actions configuration. It
does not authorize changing a live variable or secret. Gate-window and token
procedures remain canonical in [Operations](operations.md).

The workflow needs:

- Codex/OpenAI authentication for model execution
- a read-only GitHub token for worker inspection
- a separate write-scoped GitHub token for the deterministic applicator
- execution gates that default closed: set `CLAWSWEEPER_ALLOW_EXECUTE=1` and `CLAWSWEEPER_ALLOW_FIX_PR=1` only for an intentional execution window; otherwise execute/autonomous dispatches render plan-only output and skip mutation steps
- `CLAWSWEEPER_FEATURE_CLUSTER_REPAIR_ENABLED=1` opt-in for the scheduled
  `repair-cluster-intake.yml` imported-cluster intake. Direct repair import and
  dispatch commands are not blocked by this variable; they keep the existing
  repair execution gates. The selector model compares live cluster evidence and
  may reject the entire batch.
- optional `CLAWSWEEPER_CLUSTER_REPAIR_CANDIDATE_BATCH` variable for the scheduled
  intake; default is `8` candidates, from which the model selects at most one.
- imported-cluster intake is accepted into the Cloudflare durable window before
  materialization or dispatch; publication recovery retains the exact selected
  job and selector decision.
- merge is separately gated by `CLAWSWEEPER_ALLOW_MERGE`, which defaults to `0`; merge-ready PRs are labeled `clawsweeper:human-review` and `clawsweeper:merge-ready` for a maintainer to merge manually when the global gate is closed
- optional private alias routing through ClawRouter; see
  [`../private-inference.md`](../private-inference.md) for the isolated deployment,
  workload credential, and native metadata contract
- required `CLAWSWEEPER_MODEL` GitHub Actions secret for direct Codex modes, containing the actual
  internal model name; workflows, dispatch payloads, comments, and reports use
  only the public `internal` alias
- Codex CLI and its responses API proxy install from their latest npm tags on
  every worker run
- repair planning defaults to high reasoning on the fast service tier;
  automatic issue fix/PR execution uses `gpt-5.6-sol` with `xhigh` reasoning
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
  portions separately. Shared repair GitHub CLI calls use the merged per-call
  environment for these settings, default to two minutes, and enforce a
  30-second minimum for environment-configured budgets. An explicit `timeoutMs`
  call option takes precedence and may select a shorter positive deadline.
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
