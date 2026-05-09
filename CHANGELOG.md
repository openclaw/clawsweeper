# Changelog

All notable ClawSweeper changes are tracked here.

This file was reconstructed from first-parent git history. Generated dashboard,
checkpoint, and status-only commits are intentionally omitted.

## 0.2.1 - Unreleased

### Added

- Added a light privacy reminder and stronger screenshot-or-video nudge to real behavior proof review guidance.
- Added agent-led real behavior proof judgement so ClawSweeper can inspect linked screenshots, videos, logs, and terminal output with a read-only GitHub token, explain the proof verdict in the review comment, tell contributors how to trigger a fresh review after adding proof, and sync `proof: sufficient` when the evidence is convincing.
- Added a real behavior proof assessment to PR reviews so missing, mock-only, or insufficient contributor proof blocks pass/automerge markers and asks for screenshots, terminal output, redacted logs, recordings, linked artifacts, or copied live output instead.
- Added `config/automation-limits.json` plus docs and a drift check so review,
  commit-review, repair, and issue-implementation capacity defaults have one
  checked-in source of truth.
- Replaced per-lane capacity config with a single `workers.max` budget and
  dynamic background lane scheduling.
- Added generated coding-plan artifacts for fresh `queue_fix_pr` work candidates
  and linked them from the dashboard work-candidate tables. Thanks @FerFroid.
- Added a generated 1200x630 social preview card plus large-image Open Graph and
  Twitter metadata for the docs site.

### Fixed

- Ignored non-SHA likely-owner provenance values when rendering public commit
  links, avoiding broken `/commit/...` URLs in review comments. Thanks @samzong.
- Kept missing changelog entries as maintainer-owned ClawSweeper repair work instead of asking PR authors to add them. Thanks @obviyus.
- Suppressed changelog-only OpenClaw PR review findings after model output so
  contributor PRs do not get needs-changes or fix-required markers solely for
  maintainer-owned release notes. Thanks @rubencu.
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
