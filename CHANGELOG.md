# Changelog

All notable ClawSweeper changes are tracked here.

This file was reconstructed from first-parent git history. Generated dashboard,
checkpoint, and status-only commits are intentionally omitted.

## 0.3.1 - Unreleased

### Added

- Added end-to-end exact-review handoff health with phase ages, delayed/stalled claim classification, and a phase-aware operator rail on the live dashboard.
- Added a maintainer-only two-runner workflow that builds a hash-bound
  crawl-remote release artifact without production credentials, then requires
  that exact SHA to remain the current main tip on a fresh protected runner
  using an environment-specific Cloudflare token, a committed lockfile-backed
  Wrangler toolchain, pre- and post-migration D1 fence proof, a second
  current-main check immediately before Worker deployment, an explicit
  dormant-or-active selectors for observation ordering and snapshot
  provenance, fail-closed single-output Worker packaging, 31-day
  approval-window artifact retention, exact release-identity and contract
  polling on workers.dev, and a fail-closed compatibility contract that accepts
  only the reviewed pending migration suffix. Migrations 0007 and 0008 are
  mechanically checked as additive, including immutable archive-retirement
  state and the old-worker publish-candidate bridge, and the still-serving
  previous Worker's public,
  D1-backed contract must remain healthy without regressing routes,
  capabilities, or notes after migration and before Worker deployment. The
  protected
  environment must explicitly own the deployment authority and bind the
  production token fingerprint; mandatory custom-route proof uses Cloudflare
  Access service-token headers, and failed or stale deployments roll back only
  the Worker to the exact prior stable version; D1 migrations remain applied.
  The 40-minute protected job enforces a 35-minute internal mutation deadline,
  leaves eleven minutes for bounded setup before the D1 cutoff, reserves seven
  minutes between D1 and Worker cutoffs plus two minutes for late ownership
  recovery, and reauthorizes both repository main tips again after production
  proof before accepting success.
  The former crawl-remote deployment workflow must be deleted, not merely
  disabled, and all Wrangler reads, mutations, ownership probes, and rollback
  commands have explicit deadlines. Absolute pre-mutation cutoffs refuse D1 or
  Worker changes once the protected job can no longer preserve the complete
  proof and rollback window. A timed-out ownership recovery remains
  indeterminate even when every observed status still shows the previous
  Worker, so a delayed Cloudflare mutation is never misreported as absent.
  Environment variables resolve only
  inside protected steps, route-proof mode is mandatory, and D1 packaging
  accepts only the exact reviewed migration sequence and content hashes.
- Added conservative, add-only `good first issue` labeling for unlocked, small, current-main reproduced bugs with a high-confidence repair prompt and validation steps and no linked-PR, feature, config, product, security, protected-label, or maintainer-opt-out blocker.
- Added durable maintainer decision packets whose exact question, rationale, options, recommendation, and likely owner come from Codex structured review output while deterministic code only validates and persists the result. Thanks @brokemac79.
- Added close-candidate quality telemetry to apply status while keeping reporting separate from close eligibility and comment-only sync. Thanks @brokemac79.
- Added the PR-only `stalled_unproven_pr` close reason: external D/F-rated pull requests whose requested real-behavior proof stayed missing, mock-only, or insufficient can close after 14 idle days, guarded by live checks that the proof request itself was visible for 14 days plus proof-label, draft, head-commit, and human-engagement gates.
- Added the PR-only `abandoned_pr` close reason: external pull requests idle for 30 days that are still drafts, waiting on their author, or failing checks on the live head can close, while high-quality proven work stays open for repair/adopt paths. See `docs/stalled-pr-close-policies.md`.
- Added the default-off, issue-only `unsponsored_feature_request` close reason for 90-day-old feature requests awaiting product direction, with live sponsorship, activity, popularity, linked-PR, and security gates.
- Added apply-health telemetry and a quiet-by-default dashboard alert for stalled, cursorless, or fully blocked pruning windows. Thanks @brokemac79.
- Added author-wide PR repair intake across configured public repositories, with private and unsupported repositories excluded before job generation. Thanks @Jhacarreiro.
- Added a system, light, and dark theme switcher to the generated documentation site. Thanks @joshka.

### Changed

- Preserved crawl-remote's reviewed `limits.cpu_ms` value through immutable
  release packaging and post-transfer deployment verification.
- Reverted the action-lifecycle expansion from PR #521, restoring the pre-merge ClawSweeper paths while retaining later exact-review throughput fixes and retrying coalesced reconciliations after any partial lookup failure.
- Raised exact-review capacity from 48/44 global/per-target workers to 64/60, shortened unclaimed dispatch recovery from ten to six minutes, and coalesced terminal-run reconciliation bursts into one bounded aggregate claim scan.
- Expanded exact-review backlog capacity while making background review yield, released exact-review leases before ledger publication, and aggregated healthy retry scans into one bounded ledger summary.
- Accepted package-manager argument separators in the action-ledger CLI and
  allowed proven zero-command router runs to finish without empty publication.
- Made action-ledger publication include every transactional import binding,
  added pre-dispatch apply and retry receipts with conservative unknown-outcome
  recovery, failed active apply items on runtime yield, preserved skipped apply
  outcomes independently from incidental mutations, separated durable comment
  writes from metadata reconciliation, propagated ambiguous retry dispatches
  and final Codex retryability exactly, and ordered every apply mutation attempt
  and outcome with monotonic causal phases.
- Dual-write review batches, items, retries, Codex log publications, durable
  review comments, apply actions, apply batches, and apply reports into the
  immutable action ledger, including partial, interrupted, timeout, and failed
  executions.
- Dual-write comment-router command receipt, classification, durable claim,
  claim refresh, receipt-aware command-side GitHub mutation attempts and
  outcomes, dispatch, wait, recovery, completion, skip, and failure transition,
  status-comment progress, and report-only repair requeues into immutable
  per-attempt action chains. Each retried request receives its own causal
  receipt pair while retaining stable business idempotency; forced replays use
  production-wired durable attempt identities through dispatch claims and worker
  receipt keys; and bounded requeues dispatch the same original source path
  bound to their digest and depth before fail-closed immutable publication from
  the setup-provided action-ledger output root to the state repository. Each
  command lane binds publication to a canonical, run-scoped finalized-shard
  manifest and rejects any missing producer path before state import.
- Short-circuited authenticated duplicate comment deliveries when their exact
  body version is already terminal in the durable router ledger, while edited,
  retryable, and state-drifted commands retain the full routing path.
- Expanded stale-insufficient-info issue handling to materially outdated reports with no current-version confirmation for 60 days, and counted live merge conflicts as an abandoned-PR stalled state.
- Upgraded Codex review and repair workers to GPT-5.6 Sol with high reasoning, invalidating cached reviews from the prior model policy.
- Added a fail-closed structural review cache that can reuse unchanged scheduled keep-open verdicts before comments, timelines, diffs, and commits are hydrated, with same-second human edit detection, complete hydrated PR-state binding, per-run savings metrics, and the existing full-content cache retained as a second stage.
- Added a fail-closed semantic review cache for hydrated pull requests, using TypeScript compiler tokens and structured JSON to ignore ordinary formatting or comment churn while requiring unchanged discussion, reviews, checks, readiness, policy, and target context plus post-lease revalidation.
- Raised durable exact-review admission from 20 to 28 global leases and from 16 to 24 leases per target while preserving four slots for other repositories.
- Redesigned the live dashboard and triage pages: an editorial status headline, borderless stat ticker, pipeline stepper, single capacity bar, and dense worker rows replace the boxed card layout, with a warm theme that follows the system light/dark preference, one lobster-coral accent, quiet outline pills, GitHub label colors as neutral dot-pills, and emoji-free metric and section labels.
- Reused unchanged scheduled keep-open reviews for up to 14 days while forcing fresh reviews after content, policy, target-head, or human-activity changes and before any close promotion. Thanks @yetval.
- Expanded untargeted close-apply scans from 300 toward a capped 900 records after skip-heavy zero-close windows without changing close or worker limits. Thanks @brokemac79.
- Made ClawHub diversion comments a practical self-serve handoff with package-shape, manifest, configuration, documentation, usage, and smoke-proof guidance. Thanks @brokemac79.
- Reduced duplicate GitHub API reads in each live-dashboard status snapshot and batched recent automerge hydration into one GraphQL request with a REST fallback. Thanks @brokemac79.
- Raised the apply-existing close limit and checkpoint size from 5 to 20 fresh closes per run so continuation chains drain the proposal queue faster while each GitHub App token stays within its lifetime.
- Restored the global Codex worker budget to 128, reserved 24 slots for interactive work and matrix expansion, and let serialized background planners refill capacity while older review waves finish publishing.
- Made ClawSweeper review reports and `proof: sufficient` or `proof: override` the proof-nudge authority, retiring `proof: supplied` and PR-context hygiene labels from proof state. Thanks @hannesrudolph.

### Fixed

- Kept dispatch receipts durable across superseding spam edits, notifier
  failures, concurrent outcome completion, unavailable comment dispatch, and
  idle receipt expiry scheduling.
- Published crash-safe `workflow.attempt` and `repair.execute` receipts around
  repair-cluster execution, terminalizing dangling child mutations before their
  parent, terminating the complete credentialed execute process group before
  timeout finalization, and allowing later observed outcomes to supersede stale
  unknown state.
- Preserved the repair worker's original replay-safe Action inputs in an early,
  attempt-scoped artifact so bounded requeues and failed-run self-heal retries
  reuse the actual effective mode, runners, sandbox, model, and dry-run state
  instead of mutable workflow defaults.
- Revalidated the exact pull request head and bounded review, thread, and
  conversation activity before every proof comment or label request, including
  a post-hydration head read, fresh contributor activity, and bound live
  policy/label state, with privacy-bounded immutable request receipts,
  conservative unknown outcomes, exact comment/label crash reconciliation,
  replay-safe bot-proof POST/PATCH recovery, and best-effort recovery-state
  publication before cursor progress.
- Bound pull-request review reuse, apply, and automerge actions to a size-capped digest of reviews, inline comments, and review-thread resolution state, so legacy reports, late activity, or resolved-thread drift force a fresh verdict before mutation.
- Hardened repair target validation and publication so package scripts run in
  isolated disposable environments, checkout identity is rebound after every
  accepted validation, checkpoint and compaction commits bypass target hooks,
  and branch pushes publish the exact validated commit through isolated Git
  authentication.
- Stopped narrow OpenClaw automerge repairs from chasing unrelated full-repository lint and typecheck failures.
- Removed the synthetic Codex write preflight that could block repair before Codex saw the real task.
- Kept exact-review handoff health live when the dashboard serves a stale fleet snapshot, so recovered claims no longer leave the operator rail stuck in a delayed or stalled state.
- Restored exact-review intake by deriving cancellation from `job.status`, avoiding an unsupported status-check function in step environment expressions that made GitHub reject the sweep workflow, and added checksum-pinned workflow-semantic linting to CI.
- Made comment-router ledger updates retain refreshed claims at the bounded
  history limit, publish through fsynced atomic replacement, and fail closed on
  malformed existing state so interrupted forced replays cannot dispatch twice.
- Completed exact-review events when a fresh low-signal close guard keeps the
  item open, instead of retrying the same safely rejected close forever.
- Coalesced self-continuing hot and normal review runs per target so scheduled
  backstops cannot create permanent parallel continuation chains that overwhelm
  serialized review publication, while exact-item, apply, and comment-sync
  lanes remain independent.
- Gated review artifact application, record publication, exact-review queue
  completion, apply dispatch, and review/apply continuations on explicit
  primary success markers so action-ledger setup, import, finalization, upload,
  or publication failures remain visible but fail open, while real review,
  sync, proof, and apply failures still block dependent mutations.
- Bound apply receipts to each actual GitHub request attempt while preserving
  stable business idempotency across transient retries, recorded review lease
  creation and cleanup independently, bound retry dispatches to review and
  decision digests, aggregated every exact-attempt mutation outcome, and made
  pre-spawn budget exhaustion a definite no-mutation yield. Interruption
  recovery now terminalizes exact open mutation receipts before their enclosing
  item and batch summaries with causal, collision-free phases; immutable ledger
  finalization and publisher failures remain visible without suppressing valid
  isolated apply dispatch or proof-backed apply work; selected-comment and
  failed-review retry lanes finalize interrupted receipts before publication;
  scheduled retry failures remain failed after cleanup; active coverage-proof
  yields cannot become kept-open terminals; and review mutation, retryability,
  and cancellation status survive finalization.
- Recovered exact-review intake from Cloudflare SQLite value-size exhaustion by normalizing delivery receipts and queue items into independently bounded rows, committing dedupe and admission atomically, restoring the seven-day idempotency window, and migrating live queue state through a transaction-coupled, generation-aware, size-bounded rollback bridge that retains the complete active dedupe set and safely reimports rollback-era changes. Thanks @brokemac79.
- Hardened action-ledger privacy, import identity and causal validation,
  multi-shard capacity, crash-safe completion publication, portable paths,
  bounded shard, marker, and spool reads, producer-lock and finalization races,
  direct shard collection invariants, calendar timestamp parity, single-label
  email and common service-credential rejection, root-scoped projection drains,
  bounded optional CrabFleet delivery, eager apply mutation receipts, exact
  active-item timeout recovery, and item/revision-stable apply and retry
  idempotency across checkpoint and batch reordering.
- Bounded every repair git helper subprocess while retaining the shorter configurable network timeout, ordinary nonzero and signal status semantics, platform-aware command launching, and explicit spawn-error reporting. Thanks @hex-AI12.
- Waited for the exact dashboard Worker commit to reach the live health endpoint before running post-deploy smoke checks, preventing Cloudflare rollout propagation from producing false CI failures.
- Separated review publication from apply/comment-sync concurrency so long
  mutation runs no longer block completed reviews from publishing, and retried
  GitHub CLI commands whose jq process reports truncated JSON.
- Bound structural, semantic, and content review reuse to the canonical
  persisted durable-comment body hash under the acquired lease, normalizing
  surrounding whitespace while preserving label
  transitions and linked-item render context; versioned security scanner
  directive hashing, isolated durable-comment refresh failures to the affected
  item, rejected malformed eligibility records, and skipped unreachable
  compiler work for local-range reviews.
- Packaged only planned prior review reports into scheduled shard runtimes and
  rebound structural cache probes to the explicit latest release state,
  restoring safe cache reuse without broad generated-state artifacts.
- Coalesced superseded sweep and planner concurrency entries instead of retaining up to 100 pending runs per group, while keeping durable leased reviews and explicit manual apply or comment-sync runs isolated.
- Required a live `DIRTY` merge conflict and at least 30 days without contributor comments or head activity before publishing or applying low-signal pull-request close verdicts, honoring longer configured stale thresholds and applying the same fail-closed policy to stale-review promotion and trusted close routing.
- Retried successful GitHub CLI JSON-lines responses when their output is truncated, preventing transient list-page corruption from aborting close-apply runs.
- Allowed conflict-free canonical PRs that only need a base update to back duplicate or superseded closures while retaining proof, review, check, draft, and conflict guards.
- Completed exact-item reviews whose captured record matches a deterministic remain-open guard instead of requeueing them indefinitely, carried tuple-verified terminal closes through cleanup, handed ordinary synced verdicts to an executing target-wide serialized router after authoritative publication, and treated repository-confirmed missing items as cleanup-free terminal results, while preserving latest-revision retries for review drift.
- Requeued stale exact-event preflights instead of letting a successful no-disposition publisher route an older verdict.
- Completed locked exact-event intake as a guarded-open result before setup or Codex, preventing review-start comment failures from retrying indefinitely.
- Requeued exact reviews when locked issues or pull requests are unlocked or close-blocking labels are removed, so a guarded-open or close-exempt completion does not delay the next eligible review until unrelated activity.
- Bounded broad reconciliation with batched Git I/O and tuple checkpoints that report progress and resume safely under concurrent state writers.
- Retried tuple-safe broad reconciliation after full push batches lose continuous exact-state races, including candidates that normalize to no changes.
- Serialized explicit workflow-dispatch planners through a non-dropping target queue and accounted for recovery runs by their requested or live shards, preventing overlapping target planning and false 89-shard reservations without undercounting multi-shard retries.
- Released workflow-owned review leases after unsuccessful exact reviews, deferred coordination-held retries until lease expiry, and skipped state checkout without fresh artifacts, preventing held-lease loops from wasting exact-review capacity.
- Bound exact-review execution to immutable queue claims and preserved both Worker/workflow deployment orders through a versioned rolling-upgrade protocol, avoiding stalled leases without disabling ClawSweeper.
- Isolated maintainer-report Codex generation from GitHub and deployment write credentials by publishing its bounded report artifact on fresh runners.
- Hardened structural and semantic review reuse against check-state, proof-override, release-lookup, Git tree-mode, and full commit-message drift; omitted AST syntax and tooling controls; diff-marker ambiguity; unsafe runtime staging and symlinked compiler-install parents; unverified, mode-lost, missing, or architecture-mismatched compiler packages; and order-sensitive JSON.
- Reconciled terminal exact-review runs by requested run instead of sampling the first 32 claimed leases, while preserving attempt and claim-generation guards across larger worker waves.
- Dequeued already-closed exact-review events before setup and treated items closed during review as terminal no-ops, preventing permanent retry churn from consuming live worker capacity.
- Kept broad reconciliation draining independent record repairs when one valid tuple has ambiguous legacy contents, while timestamping closed-record sidecar cleanup as an orderable atomic mutation.
- Kept assist, spam classification, local smoke checks, and transport recovery on GPT-5.6 Sol high reasoning instead of accepting lower-effort fallback results as completed reviews.
- Published exact-review records, plans, and decision packets as one validated tuple, and made broad sweep publishers preserve the semantically newer tuple and independently merged status health instead of replaying stale review state.
- Requeued cancelled and failed exact-review leases, kept pre-terminal success provisional, and added signed exact-attempt reconciliation with claim-generation guards that releases only GitHub-confirmed terminal runs while preserving live workers.
- Kept exact-review work pending with an explicit bounded retry when GitHub Actions cannot confirm that the executor workflow is active, instead of reporting silent repository dispatches to a disabled workflow as occupied capacity.
- Refreshed generated source paths after each state publish so later checkpoints cannot overwrite concurrent record, cursor, or report updates learned during a push rebase.
- Preserved bounded command status and prompt context through durable exact-review queue leases so successful re-reviews advance their original acknowledgement instead of remaining queued.
- Preserved independently updated sweep status and nested apply-health snapshots across concurrent state publication retries with timestamp-safe three-way merging.
- Prevented completed apply and comment-sync runs from republishing stale hydrated records after their checkpoint commits, preserving concurrent apply bookkeeping while retaining a narrow final-status retry.
- Persisted apply preselection reconciliation even when stricter policy or an empty candidate queue makes the run a no-op, publishing only changed record tuples, deferring concurrently updated tuples, and cleaning stale plans and decision packets for already-closed items.
- Prevented overlapping exact-item reviews and stale verdict replay with owned, bounded PR-head and issue-source leases; tuple-bearing reports now enforce apply-time revision and durable-verdict CAS across label, comment, and close mutations, and failed exact reviews no longer publish event results.
- Prevented comment-only synchronization from replaying duplicate or superseded close verdicts after the linked canonical PR closes without merging.
- Retried infrastructure-failed issue reviews against their exact source revision through bounded one-shot asynchronous dispatch, requeued source drift once, and preserved retry attempts in separate durable state so ambiguous timeouts cannot overwrite completed reviews.
- Stopped later CI reruns from resetting PR inactivity clocks by anchoring head activity to the latest source-triggered workflow run associated with that pull request.
- Prioritized ready close decisions and bounded PR close-coverage proofs before slow policy-gated candidates, kept default 20-item continuations shareable, and retried malformed successful GitHub JSON responses.
- Kept automatic close-apply checkpoints within their runtime budget by bounding GitHub commands and retry waits while preserving resumable report and cursor output.
- Kept stale F-rated PR promotions semantically consistent by recording them as low-signal unmergeable closes and replacing contradictory keep-open summaries.
- Removed exponential backtracking from durable review-marker parsing so adversarial comment bodies cannot stall apply or comment synchronization.
- Scoped Mantis recommendations to supported proof capture and kept code changes, PR repair, and GitHub mutations in ClawSweeper's deterministic lanes. Thanks @brokemac79.
- Bounded automatic close-apply checkpoints to ten minutes, persisted exact cursor progress before immediate continuation, and limited close-coverage proofs to the time remaining in the checkpoint.
- Kept close-limit apply checkpoints from advancing their resumable cursor past an unexecuted close candidate. Thanks @brokemac79.
- Stopped zero-progress automatic apply runtime yields from queueing immediate continuations, leaving the scheduled apply run as the retry backstop. Thanks @brokemac79.
- Kept automatic apply windows responsive by reserving up to two PR close-coverage proofs, capped by the effective close budget, and advancing independent fast/proof cursors only through records actually examined.
- Prevented malformed `maintainer_decision` records from repeatedly consuming apply queue slots by recording their deterministic apply bookkeeping. Thanks @brokemac79.
- Preserved ready-for-maintainer labels when a newer durable review matches the current PR head, while still removing readiness from stale-head reviews. Thanks @brokemac79.
- Surfaced apply-health `needs_attention` state in the dashboard hero and added explicit System, Light, and Dark theme controls. Thanks @brokemac79.
- Skipped stale PR close reports before expensive close-coverage proof when a newer durable review already makes the mutation unsafe.
- Prioritized confirmed close proposals ahead of speculative live promotion probes so expensive no-op promotion scans cannot starve ready OpenClaw closures.
- Split apply workflow helpers out of the oversized inline expression so GitHub can validate and start sweep runs again.
- Bounded apply-existing checkpoints to five fresh closes, renewed the GitHub
  App token between continuation runs, and stopped zero-progress scans from
  chaining indefinitely.
- Kept issue implementation intake and dispatch off the Codex worker runner by default so saturated repair capacity cannot stall eligible issue backfills before worker admission.
- Kept unresolved rebase conflicts inside the bounded Codex repair loop and reported exhausted conflicts as human-required with exact paths. Thanks @Jhacarreiro.
- Restored the Codex spawn helper to spam workflow sparse checkouts so repair builds can start.
- Removed unconditional ffmpeg provisioning from review startup so optional media proof cannot block exact-review leases; unavailable media tools remain per-item evidence failures.
- Prevented contributor-branch repairs and changelog-free repair artifacts from adding release-owned changelog entries, keeping contributor credit and release-note context in PR bodies or commit history instead.
- Added an explicit trusted ephemeral-runner fallback for repair planning when the host cannot start Codex's Linux read-only sandbox.
- Replaced runner-side exact-review capacity waiting and self-retries with a durable 8-slot Worker queue that coalesces item deliveries, leases executors before checkout, and reclaims abandoned leases.
- Stopped all issue and pull request label mutations, including human and third-party bot labels, from directly triggering exact reviews.

## 0.3.0 - 2026-06-15

### Added

- Added typed, durable, proposal-only root-cause cluster assessments to reviews, with strict same-repository canonical-item validation and no repair dispatch, job suppression, sibling mutation, close, or merge behavior.
- Added a fail-closed `CLAWSWEEPER_CODEX_LOGIN_METHOD=chatgpt` override for local Codex OAuth runs while retaining API authentication by default. Thanks @anagnorisis2peripeteia.
- Added repair-only PR intake that scans an author's open pull requests for actionable failures and creates durable PR-repair jobs. Thanks @Jhacarreiro.
- Added automatic issue-build lifecycle comments and dashboard cards with issue titles, queued/planning/building/completed/blocked history, live worker links, Actions runs, and generated PR drill-down.
- Show issue and pull request titles alongside target numbers on active dashboard worker cards and worker detail links.
- Added comprehensive documentation for steerable repair automation, covering issue-to-PR and PR-repair intake, GitCrawl Actions consumption, deduplication, opt-out labels, GitHub App token boundaries, durable Codex thread resumption, CrabFleet steering, worker budgets, completion gates, dashboards, and failure recovery.
- Added steerable, resumable Codex app-server sessions for repair GitHub Actions, with CrabFleet terminal attach, durable thread restoration across planning/execution runners, work-state heartbeats, and deterministic completion reporting.
- Added explicit issue-to-PR and PR-repair worker categories to the live dashboard, plus direct live-terminal fleet access and issue/PR-aware drill-down links.
- Added organization-member issue implementation commands while keeping automatic issue pickup behind a new default-off master gate and honoring `clawsweeper:human-review` or `clawsweeper:manual-only` before branch pushes and PR creation.
- Doubled the global worker budget to 64 and the imported GitCrawl cluster-repair lane to 2 while preserving proportional interactive and expansion reserves.
- Added a live fleet overview and per-worker dashboard drill-down with actual GitHub Actions job identity, current step, progress, target, lane, elapsed time, and full step timeline.
- Added coverage-proof gating before duplicate or superseded PR close proposals, so ClawSweeper verifies a covering PR really subsumes the source before closing it. Thanks @jesse-merhi.
- Added proof nudge reminders that periodically prompt PR authors to attach real behavior proof before review or merge automation can progress. Thanks @brokemac79.
- Added richer related issue context in review prompts from linked PRs, local reports, gitcrawl clusters, and exact-event GitHub issue search. Thanks @brokemac79.
- Added the first Cloudflare live dashboard for ClawSweeper observability, with
  active worker counts, pipeline rows, CI state, automerge timing, and optional
  signed status-event ingest.
- Added a live-dashboard panel for the latest closed issues and pull requests
  across configured target repositories.
- Added 24-hour ClawSweeper-owned close stats to the live dashboard.
- Added a live-dashboard CI refresher workflow that posts target pull request
  check summaries into Worker storage, so active rows can show stored PR check
  state without slow browser-time GitHub fanout.
- Added Cloudflare GitHub App webhook intake for eligible `openclaw/*` and `steipete/*` issue, pull request, and maintainer comment events so target repos can dispatch exact ClawSweeper runs without waiting for scheduled scans.
- Fixed automerge repair evidence so third-party check detail URLs are summarized without tripping ClawSweeper's strict GitHub-only evidence validator.
- Added a read-only live triage dashboard for ClawSweeper advisory-label views, focused issue queues, and linked pull request visibility. Thanks @brokemac79.
- Added a canonical repair `job_intent` contract and orchestration docs so
  automerge, issue implementation, commit finding, low-signal cleanup, and
  ordinary repair jobs share one routing surface.
- Added an audit-only spam scanner lane for new GitHub issue comments and PR
  review comments. It uses deterministic prefilters plus the internal model to
  write durable spam audit records without blocking users or mutating
  repositories.
- Added a light privacy reminder and stronger screenshot-or-video nudge to real behavior proof review guidance.
- Added agent-led real behavior proof judgement so ClawSweeper can inspect linked screenshots, videos, logs, and terminal output with a read-only GitHub token, explain the proof verdict in the review comment, tell contributors how to trigger a fresh review after adding proof, and sync `proof: sufficient` when the evidence is convincing.
- Added a durable review-context budget ledger to generated reports so prompt section sizes, hydrated counts, and truncation state are visible after each run, thanks @stainlu.
- Added a real behavior proof assessment to PR reviews so missing, mock-only, or insufficient contributor proof blocks pass/automerge markers and asks for screenshots, terminal output, redacted logs, recordings, linked artifacts, or copied live output instead.
- Added advisory issue labels for reproduction, linked-PR, work-lane,
  missing-info, product-decision, and security-review routing states, projected
  from existing review report fields without changing repair, merge, or close
  behavior. Label-only syncs now record `labels_synced_at` so scheduler cadence
  ignores ClawSweeper-owned label `updated_at` churn. Thanks @brokemac79.
- Added `config/automation-limits.json` plus docs and a drift check so review,
  commit-review, repair, and issue-implementation capacity defaults have one
  checked-in source of truth.
- Replaced per-lane capacity config with a single `workers.max` budget and
  dynamic background lane scheduling.
- Added generated coding-plan artifacts for fresh `queue_fix_pr` work candidates
  and linked them from the dashboard work-candidate tables. Thanks @FerFroid.
- Added a generated 1200x630 social preview card plus large-image Open Graph and
  Twitter metadata for the docs site.
- Added target fanout so ClawSweeper can dispatch conservative scheduled review and audit batches across eligible `openclaw/*` and `steipete/*` repositories.
- Added a PR-only low-signal close reason so ClawSweeper can automatically close net-negative branches whose useful part is tiny but whose diff is mostly unrelated or unmergeable churn.
- Added current-main issue close policy for configured OpenClaw targets, so reviews can close issues that are proven fixed on `main` even before a release ships.
- Added stronger ClawSweeper storm controls: exact event reviews now get job-level per-item cancellation, GitHub activity coalesces more aggressively, noncritical intake skips when GitHub core quota is low, hot target fanout is lower, and state hydration avoids partial-clone checkout auth failures by default.

### Changed

- Removed the unsupported ephemeral-session flag from repair Codex subprocess invocations. Thanks @Jhacarreiro.
- Enabled automatic implementation plus bounded durable-report backfill for eligible open issues; general viable implementation remains limited to public sibling repositories, while separately gated strict-bug and vision-fit lanes can backfill `openclaw/openclaw`. Codex discovers viable implementation and validation strategy, while deterministic security, opt-out, source-state, quota, report-revision receipt, queued-job, and PR/cluster deduplication gates remain.
- Increased quiet scheduled review capacity from 48 to 64 workers, switched scheduled backfill to three-item shards to reduce setup and tail-idle overhead, and made seven-day review freshness an explicit scheduler priority.
- Doubled the global Codex worker budget to 128 with proportional reserves, added job-level dashboard error and recovery rates, and moved the bounded failed-review retry backstop to hourly.
- Raised the shared Codex worker budget from 24 to 32, tripling quiet scheduled normal-review capacity from 4 to 12 shards while preserving interactive and matrix-expansion reserves, and synchronized live-dashboard budget reporting.
- Automatically dispatch high-confidence `queue_fix_pr` issue reviews outside `openclaw/openclaw` and `openclaw/clawhub` into the existing implementation worker, then opt generated PRs into a bounded review/autofix/re-review loop that stops clean and leaves them open for maintainer merge. Retryable Codex worker failures now requeue through the bounded repair self-heal path.
- Install the latest Codex CLI for every worker run and keep the actual model name in the `CLAWSWEEPER_MODEL` GitHub Actions secret, exposing only the `internal` alias in workflows, reports, and comments.
- Removed PR egg hatching, including the `@clawsweeper hatch` command, hatch dispatch path, generated PR egg comments, and `assets/pr-eggs` publishing (#210). Thanks @vincentkoc.

### Fixed

- Included the shared Codex spawn helper in repair comment-router sparse checkouts, restoring repair builds in that workflow. Thanks @849261680.
- Rendered Mantis proof suggestions as complete copyable PR comments inside fenced text blocks without triggering the suggested command. Thanks @hxy91819.
- Added a cancellation-safe four-slot exact-review semaphore, replacing the proposed state-repository lease with deterministic live Actions ranking. Thanks @hxy91819.
- Made every Codex subprocess honor `CODEX_BIN`, safely launch npm-installed `codex.cmd` wrappers on native Windows, and terminate their process trees on timeout. Thanks @anagnorisis2peripeteia.
- Reserved the full bounded media preprocessing allowance for exact-event review deadlines and command-dispatch fallbacks, including media discovered only after comment hydration.
- Keep generated implementation PR bodies and terminal issue comments concise, avoid stale blocked states while PR checks are pending, and stop adding ClawSweeper itself as a commit co-author.
- Prevented trusted ClawSweeper command status comments from re-entering GitHub activity handling and churning review automation. Thanks @ooiuuii.
- Routed proof-sufficient security reviews that recommend maintainer risk acceptance to maintainer review instead of waiting on the contributor. Thanks @brokemac79.
- Prevented automatic issue backfill from spending Codex workers on reports explicitly blocked by product-decision, no-new-fix-PR, or maintainer-review signals.
- Kept issue-generated PRs out of automerge, migrated their labels to `clawsweeper:autofix`, and made clean exact-head autofix reviews wait for required checks to appear, settle green, and reach GitHub merge-state readiness before removing the repair-loop label instead of repeating blocked merge attempts.
- Correlated active issue-build workers by workflow run when GitHub job titles omit the target, preserved source issue titles and generated PR links across repair lifecycle events, and stopped generic repository repairs from requiring a nonexistent `pnpm check:changed` script.
- Persisted dashboard lifecycle events in a globally consistent Cloudflare Durable Object so automatic issue-build cards remain visible across edge locations, and accepted Ansible plus repository-local shell-script validation commands without permitting inline shell execution.
- Prevented ClawSweeper-owned advisory labels from invalidating queued issue implementation source revisions, and accepted quoted arguments plus common validation toolchains while blocking shell/eval runners and removing GitHub write credentials from target validation.
- Compacted completed ClawSweeper-generated replacement branches to one reviewed commit before publication, removing transient checkpoint and review-repair noise while preserving contributor branch history.
- Skip optional ClawSweeper label additions when an issue or pull request already has GitHub's 100-label maximum, so one saturated item cannot abort a comment-sync batch.
- Served stale dashboard status immediately while coalescing a background refresh, bounded job-detail fanout, and cached and parallelized historical GitHub lookups to reduce cold-load latency, diagnostic timeouts, and API usage.
- Recover transport-exhausted reviews with one bounded lower-effort fallback while preserving the original failure classification when recovery also fails. Thanks @yetval. (#283)
- Preserved records written by concurrent workers during generated-state publish races while retaining deliberate item-to-closed moves and plan cleanup.
- Raised and unified Codex review timeouts at 20 minutes, including exact event reviews, so high-context reviews do not fall back at the previous 10-minute ceiling.
- Scale pull request review timeouts across webhook, command, and post-repair dispatches for large diffs and video proofs while preserving the configured Codex timeout as a floor and budgeting media preprocessing separately. Thanks @TurboTheTurtle.
- Treat failed Codex reviews as infrastructure failures, suppress readiness verdicts, and remove stale PR rating labels until a fresh review completes. Thanks @SYU8384.
- Deferred workflow utility CLI execution until module initialization completes, preventing apply preselection from crashing on close-action constants.
- Prevented verbose Codex review and repair subprocess output from overflowing memory, retained capped durable logs and bounded redacted diagnostic tails, stopped retrying terminal model-access failures, and pinned the CLI/proxy pair to compatible version 0.139.0. Thanks @fuller-stack-dev.
- Hydrated generated pull request review findings into automerge repair jobs instead of routing repairs through the original issue-only artifact.
- Rechecked stale active worker state and durably retried pending repair dispatches instead of leaving review-fix loops waiting after a worker finishes.
- Released automerge repair workers immediately when an exact-head ClawSweeper review requests another repair, allowing the router to dispatch the next Codex worker without waiting for the shepherd timeout.
- Limited issue implementation intake and repair worker state hydration to required records, jobs, and results, avoiding unrelated generated state and proof assets.
- Fixed the GitHub activity bridge's spam-comment dispatch shell block so ordinary activity events continue into normal processing.
- Prevented an older failed re-review command from starting another Codex review after the same requester submitted a newer re-review for the item.
- Retried transient Codex review failures in fresh bounded sessions and redacted the internal model identifier from review failures and debug artifacts.
- Kept sparse repair workflows building after the shared Codex transient helper moved outside the repair subtree.
- Kept ordinary auth-provider and token terminology from being misclassified as a security-sensitive issue implementation blocker.
- Fixed issue implementation duplicate-PR searches to use GitHub's GET endpoint, restoring automatic and explicit issue-build intake.
- Allowed viable issue implementation intake to treat merged or closed pull requests as historical context while retaining live blockers for open matching and generated pull requests.
- Made generated-state checkouts shallow by default so publish, audit, and apply jobs do not download the multi-gigabyte state history before their existing fetch/rebase retry loop.
- Added merged PRs that reference an issue to issue review context when GitHub has no formal closing link, so implemented-on-main decisions can see relevant fix provenance. Thanks @openperf.
- Skipped open-but-locked repair apply targets before close or merge mutations and converted GitHub locked-conversation write denials into terminal skipped records. Thanks @AsishKumarDalal.
- Kept stale queued workflow ghosts out of commit-review capacity probes after GitHub refuses to cancel old queued runs.
- Required OpenClaw config-surface changes to pause automerge for maintainer review instead of emitting pass markers, with durable config-surface report metadata. Thanks @osolmaz.
- Disabled automatic push-triggered commit review while keeping manual commit-review workflow dispatch available.
- Treated target `AGENTS.md` files as optional repository-authored review policy
  in item and commit review prompts while preserving ClawSweeper repository
  profile and fallback behavior (#185, building on #173). Thanks @Takhoffman.
- Reduced spam-scanner false positives on legitimate technical GitHub comments by teaching the audit model that on-topic repros, patches, logs, tests, measurements, and migration reports are expected project participation, not spam.
- Allowed verified `implemented_on_main` close proposals to close
  maintainer-authored or `maintainer`-labeled items automatically, while keeping
  other protected-label and non-fixed maintainer closes blocked.
- Retried legacy `skipped_maintainer_authored` and `skipped_invalid_decision`
  reports when they are now verified `implemented_on_main` close candidates.
- Retried older `kept_open` close reports and cleared linked-PR issue blockers
  after ClawSweeper closes the linked PR earlier in the same apply run.
- Closed live no-diff pull requests as duplicate/superseded during apply and
  let same-author PR/issue close pairs finish together when both sides already
  have closeable reports.
- Promoted old F-rated stale PRs, recommended `pause_or_close` PRs, and PRs
  superseded by linked pull requests into duplicate/superseded apply closes when
  no human has responded after the durable review.
- Archived live-closed skipped apply records from `items/` during apply so the
  open-state dashboard sheds stale records faster.
- Kept stale GitHub Actions queued ghosts out of the live dashboard capacity and pipeline counts after GitHub leaves old queued runs around for hours.
- Kept event apply runs from failing when GitHub rejects ClawSweeper advisory label sync with a 401; the item is now recorded as kept open for a later retry instead of crashing the workflow.
- Restored UTF-8 emoji labels on the live dashboard after mojibake slipped into the Worker HTML template.
- Sanitized non-`github.com` URLs out of repair worker `result.json` evidence (including `actions[].evidence`, `needs_human`, and every `merge_preflight` evidence list) before review so deploy-preview and other external links no longer trip the `evidence contains non-GitHub external URL` deterministic gate; deterministic automerge results, dry-run/blocked fallbacks, the Codex-written result, the result-repair retry, and synthetic commit-finding-intake results all share a single `src/repair/url-safety.ts` allow-list. The intake also rejects dispatched `report_url` overrides that are not on `github.com` and falls back to the canonical report path.
- Kept scheduled target fanout covering public `steipete/*` repositories when the ClawSweeper GitHub App is not installed for that owner.
- Reduced the shared Codex worker budget from 72 to 57 so background review, commit-review, repair, and issue-implementation lanes run about 20% fewer parallel workers.
- Clarified re-review guidance so PR/issue authors and users with repository write access can request a fresh read-only review without a maintainer relay.
- Mirrored ClawSweeper repair publish events into the live dashboard ingest so the Recent Activity panel shows fleet signals.
- Filled the live dashboard Recent Activity panel from recent ClawSweeper closes when no explicit activity events have arrived yet.
- Deduped live-dashboard PR close activity across explicit `/issues/` events and backfilled `/pull/` rows.
- Kept live-dashboard worker pressure focused on ClawSweeper worker runs by separating support workflows such as GitHub activity, spam intake, dashboard CI, CI, and CodeQL.
- Fetched live-dashboard closed-item pages concurrently so the ClawSweeper close stats do not time out and render as zero during busy periods.
- Coalesced duplicate spam comment intake deliveries by target comment so noisy edited-comment bursts stop wasting runner slots.
- Required exact trusted-bot login matches before allowing comment-router mutation actions.
- Limited `/autoclose` linked-target expansion to same-repo items explicitly referenced in the maintainer command text.
- Restored target checkout file modes after read-only review runs and kept `.git` metadata writable for local Git inspection.
- Counted unverified local-checkout apply records against the apply processed limit so one stale report cannot be retried forever while later records still mutate.
- Ignored stale queued repair workflow runs when reserving live worker capacity, so abandoned Actions queue entries no longer block automerge repair dispatches.
- Kept active automerge opt-ins moving through canonical no-finding human-review pauses instead of requiring a second maintainer approval.
- Retried sweep target repository checkouts without cached Git references when
  a stale partial-clone cache breaks shard startup.
- Reduced the shared Codex worker budget by 10% so review, commit-review,
  repair, automerge, issue-implementation, and dashboard utilization lanes use
  lower default fan-out.
- Cleared ClawSweeper-owned `eyes` reactions from target issues and pull
  requests when event reviews complete, while preserving user reactions. Thanks
  @samzong.
- Kept event re-review progress updates scoped to ClawSweeper-owned status
  comments, so empty command markers cannot cause unrelated human comments to be
  edited. Thanks @hxy91819.
- Added live spam comment intake for GitHub activity events so deterministic
  spam candidates dispatch exact comment scans immediately instead of waiting
  for the hourly audit sweep.
- Counted both trusted ClawSweeper bot logins in live-dashboard close stats.
- Counted active live-dashboard workflow runs from GitHub status-filtered Actions pages so older in-progress reviews are not hidden by newer completed runs.
- Reworked live-dashboard tables into compact linked rows so pipeline run links,
  CI state, and side-panel items fit without cramped columns.
- Replaced the state-repository PAT dependency with a short-lived GitHub App token for ClawSweeper state checkouts and publishes, so rotated PATs no longer break `openclaw/clawsweeper-state` access.
- Clarified uneditable source PR replacement comments and PR bodies so they state
  the push-rights blocker, explain why source PRs are closed after a replacement
  opens, and show preserved co-author credit.
- Kept the live dashboard's playful icon treatment while tightening the pipeline
  grid so long commit-review SHAs no longer overlap the automerge/status rail.
- Replaced `ci unknown` on active live-dashboard rows with immediate workflow
  run health and stored target-check badges when the CI refresher has published
  pull request status.
- Enabled a bounded live PR-check fallback for the first visible dashboard rows
  so CI badges still show target checks when KV is absent or cache locality
  hides a posted status event, while preserving workflow status if GitHub
  rejects the live enrichment request.
- Tightened the live dashboard desktop layout so the pipeline table scrolls
  inside its lane instead of colliding with the side panels, with compact mode
  labels for dense worker rows.
- Stopped browser-caching the live dashboard HTML shell so UI fixes appear
  immediately after Worker deploys.
- Served the last good live dashboard snapshot from a longer edge cache when
  GitHub rate limits transient live refreshes, avoiding zeroed-out status pages.
- Kept the live dashboard stable during refreshes by caching status snapshots at
  the edge, retaining the last good browser snapshot, and reducing rate-prone
  GitHub detail calls so transient 403s no longer blank the pipeline.
- Cleared stale `clawsweeper:human-review` and `clawsweeper:merge-ready` pause labels when a later exact-head trusted pass arrives for an automerge PR, so transient cancelled reviews no longer strand maintainer opt-ins.
- Tightened spam scanner prefilters so GitHub context links, contributor proof
  comments, and ordinary external evidence/log links do not trigger audit
  records as spam candidates, while broad scans prioritize real spam-shaped
  candidates across recent comment churn.
- Kept repeated broad spam sweeps from spending their scan cap on already
  processed deterministic candidates.
- Put duplicate/superseded canonical issue and pull request links directly in
  the public close sentence instead of only inside review details.
- Kept event re-reviews from failing when a target repository has not created
  the optional `proof: sufficient` label yet.
- Removed stale spam audit files when a reprocessed comment no longer matches
  the scanner candidate filters.
- Derived repair dispatch worker caps from `job_intent` when no explicit cap is
  provided, reducing per-workflow lane branching while preserving the global
  worker budget.
- Treated explicit `clawsweeper:automerge` opt-in as the per-PR automerge
  authorization, leaving only the global merge gate so maintainer-approved
  automerge PRs do not stall behind a second environment flag.
- Strengthened adopted OpenClaw automerge repairs so they run lint and type
  checks locally instead of pushing after changed-surface validation alone.
- Tightened implemented-on-main review prompts and schema descriptions so close
  proposals include the git-history and release/current-main provenance required
  by the apply gate.
- Added age-gated `mostly_implemented_on_main` PR cleanup so ClawSweeper can
  close older pull requests when current `main` already contains the useful
  change and the remaining diff is obsolete, minor, risky churn, or separately
  tracked.
- Rendered deterministic close comments during review even when the model omits
  `closeComment`, while keeping apply strict about requiring a stored usable
  close comment before mutating GitHub.
- Counted live normal and hot review capacity from active `Review shard` jobs
  instead of reserving an entire 35-70 shard lane for every planning or
  publishing background run, so saturated backlog runs keep using available
  Codex capacity.
- Reserved pending/planning background sweep matrices at their quiet lane size
  and capped broad manual `shard_count` inputs by live scheduler allowance, so
  overlapping manual or scheduled review runs stay inside the Codex worker
  budget while GitHub expands matrix jobs.
- Bounded the initial planner dashboard publish to 20 seconds so slow generated
  state pushes cannot delay candidate selection or review shard startup.
- Switched review and commit-review capacity probes from `gh run list` to the
  GitHub Actions REST runs list so repository-dispatch review workers are counted
  when sizing new shard and commit-review batches.
- Ignored non-SHA likely-owner provenance values when rendering public commit
  links, avoiding broken `/commit/...` URLs in review comments. Thanks @samzong.
- Kept missing changelog entries as maintainer-owned ClawSweeper repair work instead of asking PR authors to add them. Thanks @obviyus.
- Suppressed changelog-only OpenClaw PR review findings after model output so
  contributor PRs do not get needs-changes or fix-required markers solely for
  maintainer-owned release notes. Thanks @rubencu.
- Clarified likely-owner role wording in generated review comments and reports
  so history-based routing does not imply official maintainer status. Thanks
  @rubencu.
- Taught PR review prompts to inspect matching maintainer notes before reviewing
  diffs, avoiding findings that would revert intentional repository decisions.
  Thanks @obviyus.
- Added explicit timeouts for disabled-target workflow guard jobs and
  concurrency groups for write-side repair workflows. Thanks @ds4psb-ai.
- Gave manual exact-item review dispatches their own concurrency group so
  targeted maintainer reviews no longer wait behind broad normal backfill runs.
- Downgraded screenshot-only browser runtime proof so ClawSweeper no longer accepts "no visible console/CSP violation" screenshots as sufficient real behavior proof. Thanks @BunsDev.
- Classified optional bundled skill PRs as `skill` items and routed skill-only
  OpenClaw core additions to the ClawHub upload path with clearer close copy.
- Required generated public review comments to use full GitHub URLs for
  cross-issue and cross-PR references instead of shorthand `#123` refs.
- Added `openclaw/fs-safe` as an event-driven review target with conservative
  PR implemented-on-main close rules and issue review-only behavior.
- Scoped sweep record/status publishing to the active target repository slug so
  concurrent runs for other repositories cannot overwrite newly added target
  records from stale generated state.
- Added data-driven target repository config plus a conservative `openclaw/*`
  fallback so newly installed OpenClaw repositories can use exact event review
  without a TypeScript profile change.
- Reduced default worker fan-out by about 20% across review shards, hot intake,
  commit review pages, repair live-worker caps, and automatic implementation
  dispatches.
- Made background review lanes yield to active repair and exact-item work to
  lower GitHub and Codex rate-limit pressure during busy periods.
- Fixed live worker scheduling to filter GitHub Actions runs through supported
  `workflowName` JSON fields instead of silently falling back to zero active
  workers when `gh run list --workflow` is unavailable.
- Reduced repair live-capacity polling from one GitHub Actions API request per
  active status to a single recent-runs request filtered locally, and avoided an
  immediate duplicate capacity probe in the dispatch loop.
- Cached comment-router open-label issue lookups per run so repair-loop comment
  discovery and command synthesis do not repeat identical GitHub searches.
- Cached comment-router issue comment lookups per run so targeted command routing
  and replay/status checks do not repeat identical comment pagination.
- Retried Codex edit workers after TPM/rate-limit exits and collapsed JSONL failure transcripts into concise repair status reasons.
- Added deterministic merged closing-PR provenance to issue close reports and
  public close comments when GitHub exposes a high-confidence closing PR.
- Allowed repair cluster execute tokens to request workflow-file write
  permission, so adopted automerge repairs can rebase PR branches that already
  contain `.github/workflows/*` changes.
- Stopped forcing Codex fast mode in review and commit-review runs.
- Marked automerge repair loops as failed or blocked when fix execution ends on
  an unrecovered Codex transport error, instead of leaving the PR timeline at a
  running step.
- Marked GitHub App workflow-file push denials as blocked repair outcomes
  instead of failing the repair worker after Codex prepares an otherwise useful
  fix.
- Published already-prepared fork repairs as credited replacement PRs when
  GitHub rejects the contributor-branch push because rebasing would create or
  update workflow files without effective workflow permission.
- Capped repair Codex prompt payloads by compacting oversized fix artifacts and
  repository snippets, and classified Codex context-limit responses as blocked
  repair outcomes instead of red workflow failures.
- Fetched contributor PR repair heads through the target repository pull-request
  ref instead of directly from contributor forks, and treated git fetch timeouts
  and push timeouts as blocked repair outcomes.
- Skipped self-heal repair redispatches when the same repair job is already
  queued or running, avoiding duplicate pending workers for active PR repairs.
- Let self-heal rediscover recent failed repair workers from live GitHub run
  metadata when a hard execute failure happens before durable run records are
  published.
- Included the automation limits config in the CI sparse checkout so the new
  limits drift check can run on GitHub as well as locally.
- Accepted positional automation-limit paths in workflow utilities again so
  high-volume commit-review and scheduler workflows keep using the compact
  `workflow -- limit <path>` form.
- Included the automation limits config in the repair comment-router sparse
  checkout so scheduled maintainer commands can load shared worker caps.
- Let the final internal Codex `/review` in a repair loop feed one last
  review-fix pass before blocking, pushing only after changed-surface validation
  passes so exact-head review and GitHub checks can finish the merge decision.
- Expanded validation-failure detail passed into Codex repair follow-up prompts
  so lint/typecheck failures keep the actionable diagnostic instead of only the
  package-manager epilogue.
- Reduced the default final-base sync loop to one local validation pass before
  pushing the synchronized head, relying on exact-head review and GitHub checks
  to gate fast-moving automerge branches.
- Limited commit-review fan-out to 6 commits per workflow page by default, with
  a `CLAWSWEEPER_COMMIT_REVIEW_PAGE_SIZE` override for controlled backfills.
- Made trusted human-review and security-sensitive pause reasons include the
  actionable review sections instead of only the structured marker.
- Removed `actions/setup-node` from the high-volume GitHub activity lane and
  kept that notifier compatible with runner-provided Node 20+ so bursty
  activity forwarding is not blocked by codeload action download timeouts.
- Switched repair target checkouts to retryable blobless Git clones with a
  shorter per-attempt timeout, avoiding five-minute `gh repo clone` hangs before
  Codex can repair a PR.
- Preferred human GitHub Actions URLs when reporting active repair workers,
  avoiding API URLs in ClawSweeper status comments and dashboards.
- Raised the same-head automatic repair cap to two attempts so a transient
  checkout or runner failure does not permanently block the PR head from a
  retry.
- Skipped routine native and forwarded pull request synchronize events plus
  successful workflow-run events before checkout in the GitHub activity lane.
- Kept human-review pauses from being cleared by stale trusted pass markers or
  replayed automerge commands.
- Updated targeted re-review command comments with live progress while the review
  workflow runs.
- Avoided full-file token scans for repair repository snippets when no discovery
  tokens exist, keeping untargeted fix prompts cheaper to build.
- Requested 100-item REST pages for paginated GitHub list calls, reducing
  review and repair API page fan-out on large issues and pull requests.
- Bounded repair cluster PR file and commit hydration to the context carried
  into generated plans, avoiding full pagination for very large pull requests.
- Compacted review prompt context lazily so large comment, timeline, file, and
  commit lists no longer process entries that are omitted from Codex input.
- Scoped every sweep workflow status write to the active target repository so
  `openclaw/clawhub` and `openclaw/clawsweeper` runs no longer overwrite
  `openclaw/openclaw` dashboard telemetry.
- Cached the static review prompt and decision schema within each ClawSweeper
  process instead of re-reading them during review planning and item prompts.
- Thanks @stainlu for the repair prompt, GitHub pagination, lazy context
  compaction, review telemetry, live-capacity probe, comment-router cache, and
  prompt asset cache PRs.

## 0.2.0 - 2026-05-03

### Added

- Accepted `@clawsweeper fix` as a short issue implementation command that creates or updates one guarded ClawSweeper PR for an open issue.
- Added an `openclaw/openclaw` active review-shard floor so scheduled normal review keeps capacity warm around the clock even when the due backlog is temporarily below full shard capacity.
- Added coarse automerge repair progress updates to the existing mutable status timeline for validation, Codex edit, review, base-sync, and wait phases.

### Changed

- Switched the shared Codex setup action to a per-run `CODEX_HOME` with a local Responses proxy so Codex subprocesses no longer inherit raw OpenAI/Codex API key environment variables.
- Replaced duplicate-lobster command status badges with one lobster plus a state emoji for acknowledgement, review, repair, and completed/paused work.
- Kept broad review continuations warm and faster by preserving the `openclaw/openclaw` active shard floor, stopping saturated planning once capacity is full, capping optional pre-shard dashboard publishes, and moving broad continuation comment sync into the separate comment-sync lane.
- Removed the expensive record reconciler from pre-shard planning status so review jobs can start without waiting on a full GitHub state scan; publish, apply, and audit still reconcile before mutating records.
- Made read-only review planning hydrate generated state from a shallow checkout instead of cloning the full generated-state history.
- Removed generated-state checkout and hydration from review shards; the planner already passes exact item numbers, so shards can start Codex after checkout and runtime setup instead of copying historical records first.
- Moved exact event review state hydration after the Codex review step so maintainer-triggered single-item reviews can start the model before generated records are copied.
- Made the GitHub activity notifier workflow use a lean uncached Node/pnpm setup so bursty events do not wait on `actions/cache` downloads before notifying OpenClaw.
- Wrapped review shard execution in a computed shell timeout so one hung broad review shard records failed-shard artifacts and enters recovery instead of blocking publish until the full GitHub job timeout.
- Updated sweep and commit-review artifact upload/download actions to their Node 24-compatible versions so review runs no longer emit artifact action runtime deprecation annotations.
- Updated TypeScript tooling while preserving the existing `pnpm` workflow.

### Fixed

- Kept review continuations warm when the normal backlog is below the target active shard floor.
- Retried transient Codex edit-pass transport failures where the Codex tool router reports a closed stdin session, instead of failing the whole repair worker after an otherwise recoverable automation run.
- Accepted scoped `scripts/run-opengrep.sh --error -- <paths>` validation hints so automerge repair execution does not fail preflight before normalizing OpenClaw repairs to the changed-surface gate.
- Accepted spaced `auto merge` command aliases everywhere `automerge` and `auto-merge` are accepted, including the top-level `/auto merge` shorthand.
- Updated issue implementation command comments after a fix PR opens, linking the generated PR from the original ClawSweeper status comment instead of leaving the acknowledgement at "queued".
- Recovered issue implementation workers from state propagation races by reconstructing minimal `source: issue_implementation` jobs from the dispatched job path instead of skipping the worker as stale.
- Routed trusted ClawSweeper verdicts with P0/P1/P2/P3 findings through the repair loop even when the same review also contains a pass marker.
- Made `/clawsweeper stop` revoke repair-loop labels and block older automerge/autofix comments from continuing, so a trusted pass marker cannot clear a human-review pause and merge after a maintainer stop.

## 0.1.0 - 2026-05-03

### Added

- Scaffolded ClawSweeper as a conservative OpenClaw maintainer bot that writes one
  markdown review record per open issue or pull request.
- Added proposal-only review flow plus an explicit apply mode for unchanged,
  high-confidence close proposals.
- Added targeted single-item review support.
- Added README dashboard links to generated item reports, fixed evidence, issue
  and PR close-rate metrics, cadence coverage, workflow status, and apply status.
- Added archived `closed/` records so `items/` can stay focused on open tracked
  items.
- Added a read-only audit command for checking live GitHub state against
  generated `items/` and `closed/` records. Thanks @stainlu.
- Added review runtime metadata to detail reports, including model and reasoning
  effort.
- Added MIT licensing.
- Added durable Codex automated review comments that are updated in place before
  any close action.
- Added a separate hourly apply/comment-sync workflow lane that can run
  alongside review work.
- Added a five-minute hot-intake review lane for new and recently active issues
  or pull requests, fanning out single-item review shards.
- Added targeted comment-sync mode so hot-intake reviews can publish durable
  Codex review comments immediately without closing items.
- Separated targeted comment-sync workflow concurrency from bulk apply so hot
  comment runs are not displaced by apply continuation backlog.
- Switched comment and close mutations to the `openclaw-ci` GitHub App
  installation token so GitHub attributes automated comments to the bot.
- Added Latest Run Activity dashboard counters for recent reviews, close
  decisions, comment syncs, apply skips, and close actions.
- Added a README Audit Health section plus a separate scheduled/manual workflow
  path to refresh it without making normal dashboard heartbeats scan GitHub.
  Thanks @stainlu.
- Added comma-separated targeted review dispatch so Audit Health findings can be
  reviewed together without waiting for normal batch selection. Thanks @stainlu.
- Added copyable targeted review inputs to Audit Health for reviewable drift
  findings. Thanks @stainlu.
- Added maintainer issue commands that let ClawSweeper create or update one
  guarded implementation pull request from an open issue.
- Added `build` as an issue implementation command alias.
- Added an automatic reproducible-bug implementation lane: strict bug reviews
  with high-confidence reproduction, no linked PR, and no feature/config scope can
  dispatch Codex to open an implementation PR.
- Added the `clawsweeper:autogenerated` label for PRs created by ClawSweeper's
  issue implementation lane.
- Added dedicated ClawSweeper event and merge notifications for OpenClaw agent
  hooks.
- Added automerge progress timelines that keep repair, review, wait, and merge
  events in one mutable status comment.
- Added automerge merge messages that summarize the reviewed PR change and any
  ClawSweeper repair/fixup work that was needed before merge.
- Added separate Codex debug artifacts for repair planning and repair execution
  so raw sessions and logs can be inspected without bloating normal published
  state.
- Added docs for scheduler capacity, automerge wait behavior, auto-update PRs,
  repair internals, and OpenClaw event hooks.

### Changed

- Released ClawSweeper as `0.1.0`.
- Let automerge fix execution run up to three Codex review-fix rounds by
  default, so new actionable findings found after validation feed back into the
  agent instead of stopping after one review-fix attempt.
- Updated repair workflow defaults to pass the four-attempt review loop through
  GitHub Actions instead of overriding the executor default with two attempts.
- Added bounded Git/GitHub network timeouts to repair execution so hung
  contributor-branch fetches fail with artifacts instead of exhausting the
  whole automerge job.
- Simplified substantive automerge repair so Codex owns the initial rebase,
  PR-comment review, CI inspection, and test/fix loop while the deterministic
  executor keeps GitHub mutations and final validation.
- Increased the repair executor budget inside the existing 45-minute Actions
  job so long Codex edit/test passes still have time for internal `/review`,
  post-flight, and artifact upload instead of wasting a retry on a 30-second
  end-of-budget review timeout; the workflow step timeout now leaves room for
  that larger internal budget to complete cleanly.
- Requeue repair runs immediately when a contributor branch advances during the
  safe push window, preserving the source-head race guard without waiting for a
  later sweep to retry against the latest head.
- Let scheduled comment-router sweeps re-enter labelled autofix/automerge PRs
  without a fresh comment, and dispatch repair when automerge activation sees a
  dirty or behind merge state.
- Filter routine GitHub activity before posting OpenClaw hook turns, retry
  transient hook failures with the same idempotency key, and document the retry
  controls for the activity lane.
- Switched review runs to GPT-5.5 with high reasoning.
- Limited protected-proposed audit failures to active item records so archived
  historical reports do not keep Audit Health in action-needed state.
- Increased sweep throughput over time with larger worker batches, 100 shards,
  chained continuation runs, and 50-review checkpoints.
- Renamed workflow run and job displays so review, apply, comment-sync, and
  audit runs are distinguishable in GitHub Actions.
- Made review cadence activity-aware: active items and items created in the last
  7 days are checked hourly, older PRs and young issues are checked daily, and
  older inactive issues are checked weekly.
- Made policy changes force previously fresh reports back into review planning.
- Improved close evidence and comments with structured review notes, public docs
  links, ClawHub links, source links, fixed-version evidence, and nicer Markdown
  formatting.
- Added best-possible-solution review output so both close and keep-open comments
  explain the recommended path.
- Made review prompts acknowledge prior plugin links and prefer public
  `docs.openclaw.ai` links where appropriate.
- Clarified `incoherent` close-reason wording so rendered reports no longer
  collide with `not_actionable_in_repo` (#29). Thanks @xthunder0.
- Normalized repository profile lookup against configured target repos so
  mixed-case profile entries resolve correctly (#27). Thanks @xthunder0.
- Made apply runs issue-only by default, with no age floor, while still excluding
  maintainer-authored items.
- Made apply runs checkpoint their progress, publish dashboard heartbeats, and
  continue automatically while work remains.
- Made scheduled apply runs process both issues and pull requests by default,
  with manual `apply_kind` narrowing still available.
- Made apply checkpoint publish retries auto-resolve generated item/closed
  rename-delete conflicts from concurrent review publishes.
- Reduced the default apply close delay from 5 seconds to 2 seconds.
- Prioritized matching close proposals ahead of broad comment sync during apply
  runs so close batches do not stall on keep-open comment backfill.
- Increased scheduled apply wakeups to every 15 minutes and made idle apply runs
  exit after checking for close proposals instead of scanning keep-open records.
- Added a Recently Closed dashboard table with links to the target item and
  archived ClawSweeper report.
- Classified missing-open audit findings so strict mode reports only actionable
  missing-open drift while preserving total visibility. Thanks @stainlu.
- Added transient GitHub API/network retries with short backoff while preserving
  long secondary-rate-limit backoff and throttle heartbeats. Thanks @stainlu.
- Split the README dashboard into focused sections and collapsed the recent
  review table so the project page is easier to scan.
- Made PR review comments easier to scan with a compact summary, review details
  in collapsible sections, reproducibility surfaced for issues, and empty
  security sections omitted when there is nothing useful to say.
- Shortened review workflow startup and moved generated state to the state repo
  so review shards spend less time on setup.
- Kept repair workers on GPT-5.5 high reasoning with the fast service tier.
- Let trusted ClawSweeper verdicts with P0/P1/P2/P3 findings trigger repair even
  when the same review also contains a pass marker.
- Made repair label tagging non-blocking so label sync failures do not fail an
  otherwise useful repair worker.
- Capped final repair artifact debug copies to tail slices while keeping full
  Codex debug backups in dedicated debug artifacts.

### Fixed

- Skipped missing or stale comment IDs in the comment router instead of failing
  the whole router on GitHub 404.
- Skipped replacement PR creation when a repair branch has no diff against the
  latest base branch, avoiding GitHub's "No commits between" failure.
- Prevented oversized executor JSONL/debug files from making final repair
  artifacts hundreds of megabytes.
- Emitted repair-worker heartbeats while Codex is running so GitHub Actions does
  not treat long silent model calls as stalled jobs before debug artifacts upload.
- Emitted execute-side Codex heartbeats during repair edit, review, and preflight
  subprocesses so automerge runs stay observable until debug artifacts upload.
- Kept final base-reconcile Codex workers from being squeezed down to the
  30-second timeout floor by aligning the executor budget with the 40-minute
  repair step.
- Included ClawSweeper-captured `codex exec --json` outputs in Codex debug
  artifacts and kept execute-side logs under uploaded repair run artifacts.
- Kept substantive automerge repairs in the Codex edit loop after a clean rebase
  instead of treating base-sync head movement as the repair itself.
- Fed changed-surface validation failures back into Codex repair so automerge
  fixes can correct lint/typecheck fallout instead of stopping after the first
  failed `pnpm check:changed`.
- Passed the normalized changed-surface gate into Codex repair prompts so the
  agent runs, fixes, and reruns validation before returning to the deterministic
  executor.
- Backed up redacted Codex session/log artifacts from repair worker Actions runs
  so automerge stalls can be debugged from the raw model transcript.
- Prevented automerge repair workers from treating a clean rebase as a complete
  repair when the current ClawSweeper review still requires a substantive fix.
- Skipped event comment-router ledger publishes when a cancelled run exits before
  pnpm setup, avoiding noisy `pnpm: command not found` failures.
- Prevented duplicate automerge repair dispatches when the configured run-name
  prefix is trimmed but an active worker already exists for the same job path.
- Kept Codex review access read-only and verified the OpenClaw checkout before
  and after review.
- Authenticated Codex in CI without exposing GitHub write tokens to nested review
  sessions.
- Hardened strict review schema parsing and failure-evidence shape validation.
- Compacted related GitHub context for review prompts.
- Bounded shard runtime and continued after individual item review failures.
- Made review publishing reliable under concurrent workflow pushes.
- Reconciled tracked item folders when issues or PRs close or reopen.
- Hardened apply close safety with maintainer-author exclusions, protected-label
  checks, snapshot-change checks, idempotent reruns, and already-closed handling.
- Reduced apply snapshot API calls and added GitHub read/write retry backoff for
  long sweeps.
- Preserved close comment formatting and rendered applied comments from stored
  review evidence.
- Ensured README dashboard cadence metrics reflect the current review rules.
- Avoided duplicate close comments by adopting existing Codex review comments and
  adding a hidden marker for future updates.
- Corrected the GitHub Actions setup docs to describe app-token comment and
  close attribution.
- Documented the current bot/app operating model and the optional Actions write
  permission needed for app-token run cancellation.
- Cancelled stale pre-app apply run 24944438478 so it cannot keep posting
  maintainer-attributed comments.
- Guarded Codex process failure output so missing stdout/stderr does not hide the
  original review failure. Thanks @ZHOUKAILIAN.
