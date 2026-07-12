# Operations

For the internal feature map across job creation, PR generation, comment
commands, finalizers, self-heal, gates, and ledgers, see
[`docs/INTERNAL_FEATURES.md`](INTERNAL_FEATURES.md).

For the trusted ClawSweeper-to-ClawSweeper PR repair loop, see
[`docs/repair/auto-update-prs.md`](auto-update-prs.md).

## Cluster Repair Operations Counters

The README dashboard and hosted live dashboard expose passive counters for the
cluster repair lanes. These counters are observational only; they do not
enable repair, merge, close, proof dispatch, or label mutation.

Record-backed dashboard counters read recent markdown records and count these
signals:

- `replacement_label_cleanup` or `inherited_label_cleanup` for replacement-label cleanup;
- `clawsweeper_self_rebase` or `conflict_self_heal` for ClawSweeper-owned conflict repair;
- `failed_review_retry_status: dispatched` or an action containing
  `failed_review_retry` for an exact failed-review retry dispatch;
- `failed_review_retry_status: exhausted` or an action containing
  `failed_review_retry_exhausted` for retry cap exhaustion;
- `bot_proof_decision_planned`, `bot_proof_decision_posted`, or
  `needs_maintainer_proof_decision` for status-only maintainer proof decisions;
- `bot_proof_mantis_request_planned` or `bot_proof_mantis_request_posted` for
  approved Mantis proof requests.

The hosted dashboard counts the same names from `/api/events` payloads when the
event type, mode, stage, or status contains the matching token. Lanes that
mutate GitHub or dispatch another workflow should emit a durable record or
status comment and a hosted-dashboard event when that hook is available.

Manual workflow status updates can publish the same counters directly:

```bash
pnpm run status -- \
  --state "Working" \
  --detail "Cluster repair dry-run completed." \
  --inherited-label-cleanups 3 \
  --self-heal-conflict-repairs 1 \
  --failed-review-retries 2 \
  --failed-review-retry-exhaustions 1 \
  --bot-owned-proof-decisions-requested 1 \
  --bot-owned-proof-dispatches 0
```

For commit-review findings, ClawSweeper dispatches
`clawsweeper_commit_finding` to this repository. ClawSweeper fetches the latest
markdown report, writes `results/commit-findings/<repo-slug>/<sha>.md`, and
only opens a PR when the finding is an ordinary narrow bug/regression candidate.
Security/privacy/supply-chain and broad findings are audit-only.

## Batch Flow

1. Create or export cluster job markdown files under `jobs/<repo>/`.
2. Exclude security-sensitive clusters before staging. ClawSweeper Repair does not handle vulnerability, advisory, CVE/GHSA, leaked secret, credential/token exposure, plaintext secret storage, exploitability, security-class injection, SSRF/XSS/CSRF/RCE, or sensitive-data exposure work.
3. Run local validation:

   ```bash
   pnpm run repair:validate
   ```

4. Dispatch plan jobs:

   ```bash
   pnpm run repair:dispatch -- jobs/openclaw/cluster-001.md jobs/openclaw/cluster-002.md --mode plan
   ```

5. Review artifacts from GitHub Actions.
6. Require `pnpm run repair:review-results -- <artifact-dir>` to pass before promotion.
7. Change selected jobs to `mode: execute` or `mode: autonomous`.
8. Set repo variable `CLAWSWEEPER_ALLOW_EXECUTE=1` only for the execution window.
9. Set `CLAWSWEEPER_ALLOW_FIX_PR=1` only when reviewed fix artifacts are allowed to repair branches or open credited replacement PRs.
10. Dispatch execute/autonomous jobs for reviewed clusters only. Workers still return JSON; `execute-fix-artifact` owns branch repair/replacement PR creation, and `apply-result` performs remaining safe GitHub mutations afterward.
11. Reset `CLAWSWEEPER_ALLOW_EXECUTE=0` and `CLAWSWEEPER_ALLOW_FIX_PR=0`.

## Manual Fix PR From Issue or PR Refs

Use `scripts/create-job.ts` when ClawSweeper or a maintainer has identified a
valid issue/PR cluster that should get one implementation PR. It writes one
idempotent job file and checks for an existing open PR or branch before creating
another job.

```bash
pnpm run repair:create-job -- \
  --repo openclaw/openclaw \
  --refs 123,456 \
  --prompt-file /tmp/clawsweeper-prompt.md
```

From a ClawSweeper report, reuse the stored work prompt, related refs,
validation, and likely files:

```bash
pnpm run repair:create-job -- --from-report ../clawsweeper/records/openclaw-openclaw/items/123.md
```

The generated job defaults to `mode: autonomous`, `allow_fix_pr: true`,
`allow_instant_close: false`, `allow_merge: false`, and
`require_fix_before_close: true`. `close_duplicate` actions can still consolidate
duplicate threads, but `close_fixed_by_candidate` waits for a merged candidate
fix unless a maintainer explicitly sets `allow_unmerged_fix_close: true`.
Commit and push the new job file, then dispatch it:

```bash
pnpm run repair:validate-job -- jobs/openclaw/inbox/clawsweeper-openclaw-openclaw-123.md
pnpm run repair:dispatch -- jobs/openclaw/inbox/clawsweeper-openclaw-openclaw-123.md --mode autonomous
```

To ask for a replacement PR from an existing useful but uneditable source PR,
make the prompt explicit:

```md
Treat #123 as useful source work. If the branch cannot be safely updated
because it is uneditable, stale, draft-only, or unsafe, create a narrow
ClawSweeper replacement PR instead of waiting. Preserve the source PR author as
co-author, credit the source PR in the replacement PR body, and close only that
source PR after the replacement PR is opened.
```

Keep `CLAWSWEEPER_ALLOW_MERGE=0` unless a human explicitly opens the merge gate.

## Manual Fix PR From Commit Finding

Use the `commit finding intake` workflow for a ClawSweeper commit report:

```bash
gh workflow run repair-commit-finding-intake.yml \
  --repo openclaw/clawsweeper \
  -f target_repo=openclaw/openclaw \
  -f commit_sha=<sha> \
  -f report_repo=openclaw/clawsweeper \
  -f report_path=records/openclaw-openclaw/commits/<sha>.md
```

The workflow is idempotent for the commit SHA. It updates the same audit file,
job file, branch, and PR path on rerun.

If latest `main` no longer needs a fix, the generated artifact allows a clean
no-PR outcome and the audit file records the skip.

## Security Boundary

Security-sensitive work is centrally managed outside ClawSweeper Repair by default. The importer skips those clusters by default, the job schema rejects `security_sensitive: true`, the planner marks hydrated security-sensitive items only from explicit security labels or structured ClawSweeper security markers, `review-results` fails mutating recommendations against those items unless they carry an explicit `clawsweeper:autofix` or `clawsweeper:automerge` opt-in, and live merge/close finalizers re-check those deterministic signals before mutating.

Use the central OpenClaw security path for:

- vulnerability reports, advisories, CVEs, GHSAs, exploitability, or security-class injection bugs;
- leaked secrets, credentials, tokens, API keys, private keys, plaintext secret storage, or sensitive-data exposure;
- SSRF, XSS, CSRF, RCE, auth-token leakage, or similar security-class bugs.

This boundary is intentionally conservative. If a cluster is borderline, do not stage it here.
For adopted automerge jobs, do not classify security from review prose at planning, repair, merge, or closeout time. ClawSweeper must emit a deterministic marker such as `<!-- clawsweeper-security:security-sensitive item=<pr> sha=<head-sha> -->` when the automerge loop should treat the PR as security-sensitive. If that PR, or a linked replacement PR, has an explicit maintainer automation label, bounded repair may continue, but merge still waits for a later clean exact-head review and the normal gates.

## Auto-Closure

`pnpm run repair:apply-result -- <job.md> --latest` is the deterministic mutation path.

It only applies closure actions when all of these are true:

- the job and result are both `mode: execute`;
- or the job and result are both `mode: autonomous`;
- `CLAWSWEEPER_ALLOW_EXECUTE=1`;
- the job allows both `comment` and `close`;
- the action is `close_duplicate`, `close_superseded`, or `close_fixed_by_candidate`;
- the action includes a canonical/candidate fix ref and live `target_updated_at`;
- GitHub still reports the same `updated_at`;
- the target is open and not maintainer-authored.
- the target is not security-sensitive.
- `close_fixed_by_candidate` has a merged candidate fix unless
  `allow_unmerged_fix_close: true` was set by a maintainer.

The applicator writes an idempotency marker into the close comment before closing. Re-runs skip already-applied comments/closures instead of posting twice.

## OpenClaw Event Notifications

The repair publish workflow sends OpenClaw notifications for important
ClawSweeper events. The notifier reads `repair-apply-report.json` plus the
published run record under `results/runs/<run-id>.json`, then posts
`/hooks/agent` to the Hetzner OpenClaw gateway.

Current event classes:

- merged PRs from executed `merge_candidate` and `merge_canonical` rows;
- item closures from executed close actions;
- blocked or failed merge/close actions;
- opened replacement fix PRs and repaired contributor branches;
- blocked or failed repair actions.

The standalone `repair:notify-merge` script remains for compatibility, but the
workflow uses `repair:notify-events`.

The generic ClawSweeper-to-OpenClaw hook pattern, Gateway configuration, session
isolation, idempotency contract, and add-a-new-event checklist are documented in
[`docs/openclaw-event-hooks.md`](../openclaw-event-hooks.md).

Required repository configuration:

- `CLAWSWEEPER_OPENCLAW_HOOK_URL` secret: OpenClaw hook base URL or full
  `/hooks/agent` URL.
- `CLAWSWEEPER_OPENCLAW_HOOK_TOKEN` secret: bearer token for the hook.
- `CLAWSWEEPER_DISCORD_TARGET` variable: Discord delivery target such as
  `channel:<id>`.
- `CLAWSWEEPER_OPENCLAW_AGENT_ID` variable: optional, defaults to `clawsweeper`.

Successful event notifications are recorded in
`notifications/clawsweeper-event-ledger.json` in
`openclaw/clawsweeper-state`, keyed by event type, repo, target, action, status,
and stable mutation evidence. This prevents duplicate Discord posts when the
publish workflow reruns.

## Autonomous Flow

`pnpm run repair:build-fix-artifact -- <job.md>` hydrates the job refs, linked refs, current `main`, PR files, commits, and checks, then writes:

- `cluster-plan.json`: live cluster inventory and canonical candidates;
- `fix-artifact.json`: drive plan, gates, permissions, and per-item matrix.

Autonomous workers receive those artifacts in the prompt. They can emit instant close actions for high-confidence duplicate/superseded/fixed-by-candidate items, and they can emit `build_fix_artifact` when a canonical fix PR is needed.

They still must not mutate GitHub directly. Missing checkout, failing checks, conflicts, unclear canonical choice, or stale item state means `needs_human`.

When a canonical PR exists, autonomous follow-through must not skip the maintainer loop. The required path is: review current PR state, clear security-sensitive concerns, inspect actionable review comments, inspect review-bot comments from Greptile, Codex, Asile, CodeRabbit, Copilot, and similar reviewers, address findings or mark them blocked, run Codex `/review`, address every Codex review finding, rebase/refactor to the narrowest safe change, run targeted validation, confirm changelog/credit, then only recommend merge after checks and review state are clean. After the PR lands, rerun duplicate classification against the landed PR/commit before recommending closeout.

Every merge action must carry `merge_preflight`. Missing security clearance, unresolved human or bot comments, missing/failed Codex `/review`, unaddressed findings, or missing validation commands blocks merge. The fix executor runs the agentic prep loop before pushing: give Codex the normalized changed-surface gate, edit, have Codex run and fix validation fallout, deterministic revalidate, Codex `/review`, address findings, revalidate again, then resolve review threads when `CLAWSWEEPER_RESOLVE_REVIEW_THREADS=1`. The applicator also checks live GitHub review threads immediately before squash merge.

## Runner Strategy

Use `ubuntu-latest` for ClawSweeper parity and correctness smoke tests.
Use `openclaw/clawsweeper` as the target repo when you need a self-contained
event, review, comment-router, or automerge smoke that should not touch product
repositories.

Use Blacksmith labels only when you intentionally want a non-parity hosted runner for bulk planning/execution:

```bash
pnpm run repair:dispatch -- jobs/openclaw/cluster-*.md --mode plan --runner blacksmith-4vcpu-ubuntu-2404
```

The workflow uses Node 24 and starts a local Codex Responses proxy from
`OPENAI_API_KEY` inside an isolated per-run `CODEX_HOME`. Codex subprocesses use
that proxy config and run without raw OpenAI or Codex API key environment
variables. The legacy `codex login` path remains available only through the
local `setup-codex` action's `auth-mode: login` input.

Codex runs without GitHub write credentials. Before execution, the workflow binds
the immutable job and result to the exact source item and revision, target
`main`, output branch and operation, and repair action identity. The executor
can create only a local commit, tree, deterministic publication metadata, and
Git bundle; it cannot push, comment, close, merge, or publish status.

A separate no-credential job reconstructs that bundle in a disposable checkout,
installs dependencies with lifecycle scripts disabled, rejects source mutation,
and replays the exact normalized staged-proof plan. Only a successful,
digest-bound validation receipt lets the final token-only job publish the exact
commit and receipt-bound PR. Generic result actions, target tagging, arbitrary
report URLs, and post-merge closeouts are not trusted by this lane. Retryable
report-only outcomes may use a central `openclaw/clawsweeper` token to requeue,
but failed or cancelled execution and failed validation cannot mutate the target
repository.

The repair worker wrapper emits a heartbeat while Codex is running. Execute-side
edit, review, final rebase, and write-preflight subprocesses emit the same
heartbeat. If a model call is slow, Actions logs should show
`[clawsweeper repair] ... still running` about once a minute instead of ending
with a silent no-output timeout.

Automerge repair execution also updates the existing mutable automerge status
comment at coarse milestones: validation plan, write preflight, Codex edit
passes, validation/review loops, final base sync, and the post-repair automerge
wait. These updates append or replace rows in the single progress timeline
instead of adding new comments.

Network calls in fix execution are also bounded. Contributor-branch clone,
fetch, push, status-comment, and review-thread calls should time out before the
GitHub Actions step limit, leaving the final repair report and debug artifacts
for the comment router instead of a bare step timeout.

For deep debugging, download the `clawsweeper-codex-debug-cluster-*` and
`clawsweeper-codex-debug-execute-*` artifacts from the repair worker run. They
contain recent Codex session/log files, ClawSweeper-captured `codex exec --json`
outputs from `.clawsweeper-repair/runs`, and a manifest. The collector skips
Codex auth/config files, honors the isolated `CODEX_HOME`, and redacts common
token shapes before upload; retention is seven days by default.

The final repair artifact keeps only capped tail copies of executor debug files
under `fix-executor-debug/` so failed runs do not spend minutes uploading huge
Codex JSONL files. Use the dedicated `clawsweeper-codex-debug-*` artifact when
the full session/log backup is needed. The cap defaults to 8 MiB per copied file
and is configurable with `CLAWSWEEPER_FIX_DEBUG_MAX_BYTES`.

If a replacement repair finishes with no diff against the latest base branch,
the executor records a skipped no-op outcome instead of calling `gh pr create`.
This avoids failing on GitHub's "No commits between" response when the repair is
already represented on `main` or the resumed replacement branch collapsed to an
empty diff after rebase.

Runs for the same job path and mode share a concurrency group. Different cluster jobs can still run in parallel.

Live preflight hydrates job-provided refs by default and records linked refs without expanding them. Set repo variables `CLAWSWEEPER_MAX_LINKED_REFS` above `0` only for small clusters that need first-hop context and `CLAWSWEEPER_HYDRATE_COMMENTS=1` when comment bodies are necessary evidence; normal scale runs use issue/PR metadata, body excerpts, PR files, and PR checks.

## Maintainer Comment Routing

`pnpm run repair:comment-router` scans recent issue and PR comments in the target repo.
Target repositories can also forward matching `issue_comment` events as
`clawsweeper_comment` repository dispatches with the exact comment id. Those
comments get an immediate `eyes` reaction from the ClawSweeper app. Maintainer
commands also get one queued status comment that the router edits in place after
it classifies the command, so the visible reply is available as soon as the
target dispatcher starts. Exact comment dispatches scan only the source comment
and use per-comment receiver concurrency; the scheduled sweep remains a
five-minute fallback.
The status comment itself uses one compact badge: `🦞👀` for acknowledgement,
`🦞🧹` for review, `🦞🔧` for repair/build/fix work, and `🦞✅` for completed or
paused work.
It accepts only maintainer-authored commands, gated by GitHub
`author_association` values `OWNER`, `MEMBER`, or `COLLABORATOR` by default.
Contributor comments are ignored without a reply.

For lower latency than GitHub Actions startup can provide, the GitHub App
webhook receiver runs at `/github/webhook` on the dashboard Worker, with
`pnpm run repair:comment-webhook` as the local equivalent. It verifies
`CLAWSWEEPER_WEBHOOK_SECRET`, accepts eligible public `openclaw/*` and
`steipete/*` `issue_comment`, `issues`, and `pull_request` events, posts the
same queued status comment for maintainer commands, reacts with `eyes`, and
queues exact `clawsweeper_comment` or `clawsweeper_item` work. The durable
Worker queue coalesces item revisions and leases the executor before checkout.
The target workflow remains a compatibility fallback when the webhook service
is down or not installed for a repository; its direct event is bridged into the
same queue.

Supported triggers:

```text
/review
/clawsweeper status
/clawsweeper re-review
/clawsweeper implement
/clawsweeper build
/clawsweeper build override
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
@clawsweeper review
@clawsweeper implement
@clawsweeper fix
@clawsweeper build
@clawsweeper create pr
@clawsweeper fix issue
@openclaw-clawsweeper fix ci
```

`review` and `re-review` dispatch ClawSweeper review again for an open issue or PR.
Issue implementation commands (`implement`, `fix`, `build`, `create pr`, `fix issue`)
dispatch the repair worker for one open issue and ask it to create or update a
single ClawSweeper implementation PR. The generated job uses
`source: issue_implementation`, `repair_strategy: new_fix_pr`, blocks merge and
close actions, and reuses `clawsweeper/issue-<repo>-<number>` on reruns.
Workers can reconstruct this minimal job from the requested `jobs/.../issue-*.md`
path when a dispatch races ahead of state propagation, so the request does not
silently skip as stale.
After opening the PR, the worker updates the existing ClawSweeper command status
comment with the generated PR link.
If an issue implementation request is refused, the visible status comment must
include the concrete reason, whether it is a soft or hard blocker, relevant
evidence when available, the override command `/clawsweeper build override`,
and what the override will do for that blocker class. Soft blockers include
automatic-lane ineligibility, medium/large/unclear implementation complexity,
new-feature or new-config shape, missing validation commands, incomplete review
shape, and expected decomposition. A maintainer override for a soft blocker
allows one bounded attempt to create or update a reviewable implementation PR.
Hard blockers include security-sensitive signals, protected labels, locked or
closed issues, existing linked PRs, existing ClawSweeper implementation PRs,
unsupported target repos, and missing usable request/context. A maintainer
override for a hard blocker does not permit code generation; it asks the worker
to produce the safest useful non-code artifact, such as a plan, decomposition,
or human-review handoff.
When `CLAWSWEEPER_AUTO_IMPLEMENT_REPRO_BUGS=1`, review publish can also dispatch
the same lane automatically for strict bug reports only: `item_category: bug`,
`reproduction_status: reproduced`, `reproduction_confidence: high`, high
work confidence, and no feature/config/product-decision blockers. Those PRs are
labeled `clawsweeper:autogenerated`.
When `CLAWSWEEPER_AUTO_IMPLEMENT_VISION_FIT=1`, review publish can also
dispatch the sibling vision-fit lane for small `VISION.md`-aligned issue work:
`auto_implementation_candidate: vision_fit`, `vision_fit: aligned`,
`implementation_complexity: small`, high-confidence `queue_fix_pr` work, no
security/protected signal, no product-decision blocker, and complete repair
shape. Those jobs use `trigger_source: review_vision_fit` and still only open or
update one generated PR.
Repair commands apply to existing ClawSweeper PRs and to PRs opted into
`clawsweeper:autofix` or `clawsweeper:automerge`. Existing ClawSweeper PRs are
identified by the `clawsweeper/*` branch prefix. Opted-in non-ClawSweeper PRs
get an adopted job at `jobs/<owner>/inbox/automerge-<owner>-<repo>-<pr>.md`.
The router posts one idempotent reply with a hidden marker and dispatches the
normal `repair-cluster-worker.yml` repair path. It records processed comment versions
in `results/comment-router.json`. For durable ClawSweeper comments,
idempotency is per comment id plus GitHub `updated_at`, and response markers
include the target PR head SHA. That lets edited ClawSweeper comments wake
ClawSweeper again after the PR branch changes while unchanged comment versions
remain idempotent.

Scheduled router runs also sweep current `clawsweeper:autofix` and
`clawsweeper:automerge` labels and synthesize an internal trusted command for
open labelled PRs that have no fresh matching command in the scan. If checks
are failing, or automerge is blocked by a dirty or behind merge state, the
synthetic command dispatches the normal repair worker. PRs paused with
`clawsweeper:human-review` stay paused.

Use `--comment-id <id>`, `--comment-ids <a,b>`, `--item-number <number>`, or
`--item-numbers <a,b>` to route only specific comments or specific open issue
or PR comments. The event review workflow uses this targeted path after syncing
its durable ClawSweeper verdict so automerge can act on a fresh `pass` marker
without waiting for the scheduled comment-router sweep. No-op targeted
acknowledgements, such as already-processed commands or already-enabled
automerge commands, do not publish a durable ledger commit.

Same-branch automerge repairs also use a shepherd wait inside the repair
executor. After a deterministic rebase or known mechanical conflict repair is
pushed, the executor polls the repaired head for GitHub checks and the
exact-head ClawSweeper pass marker, then dispatches the comment router as soon
as merge gates are ready. Codex fix/edit remains the fallback when the
deterministic repair path cannot complete cleanly.

For the full automerge decision table, including why pending checks wait instead
of dispatching repair and how to replay a fixed router against an exact trusted
comment, see [`automerge-flow.md`](automerge-flow.md).

For operator replays after a parser or router fix, pass `--force-reprocess`
or the `force_reprocess` workflow-dispatch input together with `comment_ids`;
that ignores the current ledger version and reroutes the selected comment.

If the adopted automerge worker returns no executable fix artifact, the
executor posts one idempotent outcome comment on the opted-in PR. That status
comment is the audit trail for no-op repair passes: it says no branch update,
replacement PR, merge, or new ClawSweeper review was started, then lists the
worker summary and actions.

The router also has a trusted automation path for ClawSweeper comments on
ClawSweeper PRs and PRs labeled `clawsweeper:autofix` or
`clawsweeper:automerge`. Default trusted authors are `clawsweeper[bot]` and
`openclaw-clawsweeper[bot]`; override with
`CLAWSWEEPER_TRUSTED_BOTS`. Preferred
ClawSweeper comments include `clawsweeper-verdict:*` markers plus a
`clawsweeper-action:fix-required` marker when ClawSweeper should wake up. The
router dispatches at most ten automatic repair iterations per PR and at most
two auto-repairs per PR head SHA by default, controlled by
`CLAWSWEEPER_MAX_REPAIRS_PER_PR` and
`CLAWSWEEPER_MAX_REPAIRS_PER_HEAD`. The per-PR cap is total across
head SHA changes, so the automatic loop stops after ten ClawSweeper-triggered
repair passes.

Maintainers can start the bounded review/fix loop on any open PR with
`/clawsweeper autofix`, or the bounded review/fix/merge loop with
`/clawsweeper automerge`. The router adds `clawsweeper:autofix` or
`clawsweeper:automerge`, creates an adopted job when needed, dispatches
ClawSweeper for the current head, and then reacts to trusted ClawSweeper
markers. `needs-changes` repairs the source branch when safe or opens a credited
replacement when it is not. `pass`, `approved`, or `no-changes` never merge
autofix or draft PRs. Automerge may merge only when the marker SHA matches the
current head, checks and mergeability are clean, pause labels have been cleared,
the PR is not draft, and `CLAWSWEEPER_ALLOW_MERGE=1` is set. The
`clawsweeper:automerge` opt-in is the per-PR merge authorization. A trusted
`needs-human` or `human-review` verdict on an opted-in PR adds
`clawsweeper:human-review` and pauses the loop; a later trusted pass for the
exact current head clears stale pause labels before continuing automerge.
ClawSweeper must emit an accepted repair verdict or action marker to dispatch
the repair/rebase loop.

After a pause, `/clawsweeper approve` is maintainer-only exact-head approval. It
clears `clawsweeper:human-review`, then merges through the same readiness checks
and global merge gate as a trusted ClawSweeper pass marker.

Repair workers do one final latest-`main` sync before pushing a repaired branch.
If `main` advanced after validation, the worker rebases again; any conflicts are
handed back to Codex for resolution, then validation and Codex `/review` rerun
before push.

The scheduled workflow is dry by default. Set
`CLAWSWEEPER_COMMENT_ROUTER_EXECUTE=1` in repo variables to let scheduled runs
post replies and dispatch workers. Manual workflow dispatch can also pass
`execute=true`. Branch mutation still requires the downstream execution gates,
including `CLAWSWEEPER_ALLOW_EXECUTE=1` and `CLAWSWEEPER_ALLOW_FIX_PR=1`.

## Token Strategy

CI mints one short-lived GitHub App token and passes it to deterministic repair steps as `GH_TOKEN`.

Minimum useful app permissions depend on action tier:

- classification/preflight: metadata read, issues read, pull requests read, contents read
- comments and closeout: issues write, pull requests write
- merge/automerge: contents write, pull requests write, issues write
- fix PRs: contents write, pull requests write, issues write

Do not put tokens in job files. Codex receives no GitHub token; the read token is scoped to preflight, and the write token is scoped to the deterministic apply step.

## Promotion Rules

Promote from `plan` to `execute` or `autonomous` only when:

- the canonical item is clear;
- `pnpm run repair:review-results` passes for the exact artifact;
- no unique reports are being closed;
- comments preserve contributor credit;
- idempotency keys are present;
- `target_updated_at` was fetched from live GitHub state;
- merge actions include passing `merge_preflight` with security clearance, resolved comments, resolved bot comments, passed Codex `/review`, addressed findings, and validation commands;
- high-risk work is marked `needs_human`.
