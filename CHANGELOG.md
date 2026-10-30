# Changelog

All notable ClawSweeper changes are tracked here.

This file was reconstructed from first-parent git history. Generated dashboard,
checkpoint, and status-only commits are intentionally omitted.

## 0.3.4 - Unreleased

## 0.3.3 - 2026-10-29

- Stop placeholder-recovery polls from retaining unrelated comment bodies while preserving event ordering, pending placeholders, and the full comment API.
- Tell authors of stale PR reviews to comment `@clawsweeper re-review`, since later pushes are not reviewed automatically.
- Allow credential-free Team work-session provenance links on RoboClaw and GitHub-verified OpenClaw organization PRs without weakening privacy or proof requirements. Thanks @brokemac79.
- Restore scheduled audits, which failed on every run since 2026-10-19 because the workflow token was rejected as an invalid audit read token.
- Require one fresh final whole-branch review before publication or handoff, with optional early feedback and fresh review after relevant changes; retain separate proof, ClawSweeper, CI, and landing gates.
- Keep issue close proposals open when a human locks the issue after review. Thanks @brokemac79.
- Keep local committed-range contributor proof requirements independent of Git author display names, without treating local names as verified bot or Team identities.
- Skip unusable polling cache repairs without webhook coverage, and honor equal-timestamp comment deletions so stale bodies do not remain protected.
- Defer exact reviews the model provider throttles instead of retrying them as failures every few minutes.
- Prepare target-bound permission acquisition for review authority without changing active admission, transport retries, or caches.
- Confirm the human-review hold before removing existing stop-command protection, and fail safely instead of acknowledging failed or unverified label changes.
- Measure webhook payload bytes eligible for retirement in the bounded, read-only storage census.
- Count current exact and scheduled review runs in the dashboard's worker error rate, which was reporting 0% because it sampled none of them.

## 0.3.2 - 2026-10-28

- Distinguish submitted publication outcome kinds from accepted and skipped acknowledgements in batch completion and cleanup summaries.
- Admit the existing browser CDP discovery URI fixture after OpenClaw renamed its test variable, so reviews of PRs touching `pw-session.connections.test.ts` are no longer refused.
- Preserve canonical verification baseline provenance across operator updates and require an independently reviewed baseline checksum for rechecks.
- Expose the local review package as `clawsweeper`, with matching help and installation examples while keeping the scoped package private.
- Refresh the dashboard review corpus hourly from only the canonical records changed since the last refresh, in its own workflow, so publishing the dashboard never waits on or times out in a full record export.
- Publish reviews successfully when a repository has no labels, using paginated REST label catalogs.
- Refresh the isolated GitHub telemetry proof to checksum-pinned GitHub CLI 2.102.1 and the local release rehearsal to its qualified patched Node producer.
- Skip package installation for routine GitHub activity by applying the shared event admission policy before workflow setup, while preserving delivery reports and maintainer command routing.
- Keep local package release rehearsals as the default and permit explicit publication only from the matching signed version tag, verified against the frozen signer policy and the current protected default-branch policy before every release write; preserve the original draft and asset bytes on publisher retries.
- Local PR review reports compare advisory preflight source with the observed target, merge base, and head, without treating self-reported completion as review proof.
- Compress retained webhook snapshots and lifecycle projections losslessly, preserving placeholder protection and logical state, with bounded explicit maintenance for historical rows and a codec-capable deployment rollback floor.
- Skip dashboard-only typechecking in Node-only audit, review, apply and failed-review retry jobs while retaining both Node compiler profiles and required dashboard CI.
- Skip three-platform local package qualification for explicitly classified operational-only pull requests while preserving full qualification for package inputs and unknown changes.
- Keep audit and failed-review retry jobs on the source revision used for hydration, dependency installation, and build; let the existing state publisher refresh the separate operational-state repository.
- Hydrate only claimed publication records under the batch heartbeat and preparation deadline, avoiding whole-repository setup stalls.
- Clarify that the queue runaway alert counts claimed review runs, including runs that skip model execution, and that Cloudflare storage size excludes free pages.
- Let a dashboard corpus rebuild span several hourly runs instead of timing out when stored snapshots lag far behind the journal.
- Let the canonical record snapshot resume across runs instead of timing out on a large backlog, which had stopped scheduled re-reviews of openclaw/openclaw.
- Repair review decisions that use an issue-only or PR-only close reason on the wrong subject before publication, and classify older invalid artifacts as policy failures instead of unknown publication errors.
- Reuse npm download caches in the secretless review-network smoke job while preserving fresh pinned Codex installations and isolated sandbox homes.
- Reuse the pinned review scanner archive between hosted setups while verifying a fresh scanner installation on every run.
- Refresh hosted review tools to Codex 0.164.0 and checksum-pinned TruffleHog 3.99.4.

## 0.3.1 - 2026-10-24

- Coalesce organic pushes and edits for 10 minutes (capped at 15) on items that already completed two exact reviews in the last hour, so churning PRs get one review of their latest revision instead of one per push; commands, publication, scheduled, and recovery work keep their timing.
- Preserve Endor review ownership and retry state across repeated sweeps, keep newer pull request input, and check live holds before automated Endor work continues; legacy Endor rows get one fresh review on their first continuation after deployment. Thanks @jesse-merhi.
- Qualify existing OCE URL-rejection fixtures so unrelated test changes can receive automated reviews.
- Restrict obsolete OCE URL-rejection fixture qualifications to exact historical source blobs still held by open pull requests after the source fixtures stopped embedding credential-like URLs.
- Judge pull requests on product value, provenance, and end-to-end proof first: record `productReview`, `provenance`, and `testingReview`, cap ratings for in-process or unit-only proof, partial fixes, unexplained intent overrides, and owner-decision changes, block merges the review judges not worth it, restructure the review prompt into headed sections, and compact the PR comment around verdict, product, and findings.
- Count bulk-filer issues in the window that ends when the reviewed issue was filed, so a later filing burst no longer adds `clawsweeper:bulk-filed` retroactively to issues filed below the threshold; a confirmed below-threshold count also removes such a label and refreshes a cached review decided under bulk suppression (https://github.com/openclaw/clawsweeper/issues/1769).
- Leave issues closed as completed out of the bulk-filer count: a fixed report no longer pushes its author into `clawsweeper:bulk-filed`, while open, rated, not-planned, and duplicate issues still count (https://github.com/openclaw/clawsweeper/issues/1770). Thanks @holgergruenhagen.
- Check out only the current ClawSweeper commit in the scheduled review planner, target fanout, and apply-existing jobs. None of their steps reads ClawSweeper Git history. Audit and failed-review retry keep full history because they run `git pull --rebase`.
- Revert the post-publication comment-router exemption (#1935) and the gated GitHub App webhook activity forwarding (#1940); publications dispatch the comment router again and GitHub activity stays on the existing relay.
- Distinguish keyless dispatcher token rejection from transient OIDC verifier failures, returning retryable 503 responses for JWKS outages and failing dispatcher runs on timeouts or throttling.
- Refresh revoked dashboard GitHub App tokens once within their original repository and permission scope, and fail closed if the replacement is rejected.
- Harden GitHub Actions by passing untrusted values through environment variables, rejecting forged output records, arithmetic payloads, and parent traversal, and limiting activity notifications to read-only access and same-repository workflow runs.
- Simplify action-ledger CLI wiring to direct module imports, and exercise publication validation through the real CLI, filesystem, and Worker HTTP interface instead of a test-only parser export.
- Collect bounded follow-up pages of active workflow runs so backlogs above 100 do not unnecessarily hide operational health.
- Give execution timing, failed attempts and repeated claims one home on Agent performance; keep review and publication flow on Operations and freshness on Coverage.
- Replace agent outcome placeholders with operational charts and preserve actual publication delivery history independently of other queue counters.
- Answer a maintainer's command status when ClawSweeper skips a retry of that request for lacking request authority: the review job now sets "Waiting" with a re-review hint instead of leaving "Review in progress" forever.
- Record token usage for reviews that run through the Codex app-server (queue-leased `openclaw/openclaw` pull requests with proof tools). Their ephemeral threads write no session file, so the worker now sums `thread/tokenUsage/updated` for the turns it started, minus usage from earlier attempts on a resumed thread.
- Scope dashboard and dead-letter GitHub App tokens to explicit repositories and read permissions, and isolate cached tokens by their repository and permission sets.
- Log why apply treats an item as changed since review: `[apply] source drift #N` and `[apply] post-proof drift #N` lines name the stored and live `updated_at`, which ClawSweeper-owned-write receipts were checked, and the first receipt condition that failed. The lines reuse values apply already read and add no GitHub requests.
- Give every Node process in the apply-existing job a 12 GB heap, so the checkpoint publisher fits after the review_record backfill (#1874).
- Fix apply heap exhaustion after review-record backfills by excluding typed decision payloads from the local related-title index and copying its retained metadata instead of pinning whole reports.
- Make the apply hung-GitHub-command budget test prove the bound from the child's own clock (the hung mock never finishes) instead of a 4s wall bound that also charged process boot on loaded CI runners.
- Import `asRecord` and `login` from `value-coerce` instead of five local copies and dependency-interface injection; arrays now coerce to an empty record everywhere.
- Preserve verified active review lease reasons and retry deadlines when publication defers through a batch.
- Keep ClawSweeper's bot logins and review-lease comment markers in one place each; the dashboard Worker, repair code and the exact-review workflow's lease and reaction cleanup now read them from there instead of keeping their own copies.
- Bound retained placeholder discovery data to the requested item groups while preserving their complete matching comments; database scans are unchanged.
- Stream explicit R2 ledger/assets hydration one listing page at a time instead of retaining every object descriptor in memory before downloads start.
- The repair budget tests and the validation and overall budget proofs now read the expected validation budget from `config/target-repositories.json` and the budget module, so a retuned target budget no longer needs matching edits there.
- Add explicitly activated canonical body tiering with verified immutable R2 bodies, bounded lossless migration, and preserved review admission and export metadata.
- Accept bucket-wide R2 multipart-abort rules during canonical body migration preflight while continuing to reject rules that expire canonical records.
- Qualify one canonical local-review package envelope on Linux, Windows, and macOS using its original locked dependencies and producer file inventory.
- Add bounded canonical record verification to manual queue maintenance, keeping signing credentials in the workflow and reporting body hashes, revisions, and coverage gaps without logging record contents.
- Report bounded, redacted canonical-body maintenance failures with transport status, platform category, trace correlation, and last acknowledged migration progress, while preserving existing retry and migration limits.
- Prepare canonical body migration uploads in four bounded, deduplicated pipelines and explicitly requalify incomplete checkpoints across reviewed deployments without resetting progress.
- Retry canonical tuple publication on HTTP 5xx, rate limits, and transient network failures using the same delivery ID, up to five attempts and 120 seconds of jittered backoff per mutation; honor Retry-After without exceeding that wait budget, keep authentication errors immediately fatal, and preserve the existing infrastructure-failure and all-failed reconciliation guards after retry exhaustion.
- Identify failed canonical verification requests with bounded stage, status, attempt and failure-kind diagnostics without exposing record bodies or credentials.
- Retry a failed changed-gate validation command only when its remaining budget can fit the failed attempt again. A late `pnpm check:changed` failure no longer starts a retry that can only time out, so issue and repair workers get the real failure to fix instead of ending the run on that timeout.
- Record new ClawSweeper changelog entries as one-bullet `changelog.d/` fragments that `pnpm run changelog:stitch` folds into `CHANGELOG.md` at release time, so concurrent pull requests no longer conflict on the top of the Unreleased section or need a fresh review after each conflict resolution; `pnpm run check:changelog` rejects malformed, duplicate, or stale fragments.
- Split the CI `pnpm check` gate into parallel test shards whose raw V8 coverage is replayed through Node's own coverage report with unchanged thresholds, behind one aggregate `pnpm check` status, cutting the PR critical path.
- Replace the `test/clawsweeper.test.ts` tests that read production source and raw workflow text: the coverage-proof timeout, recorded label-sync truncation, and repair-worker sandbox/no-result/timeout paths now run through the real apply CLI, `createApplySourceFreshness`, and `run-worker`; the deliberate workflow, token, sandbox, pinned-CLI, and raw-Codex-launch guards move to `test/structural-invariants.test.ts`; plumbing pins and checks already covered elsewhere are gone.
- Replace the action-ledger tests that read `src/**` text with behavior tests that drive the real review and apply ledgers and the built `apply-decisions` and `retry-failed-reviews` CLIs, and remove the `applyPhaseSequenceForTest` and apply business-identity `ForTest` exports.
- Replace workflow and boundary source-text tests with behavior tests of the real admission, dispatcher, setup-state, assist, and publisher paths, and keep the hosted-admission, exact-review secret, and assist token guards as parsed structural invariants.
- Import `sha256` from `src/content-hash.ts` directly instead of threading it through ten review/apply dependency interfaces and eight runtime wiring sites.
- Route single-shot SHA-256 hex digests through `src/content-hash.ts` instead of 56 hand-rolled `createHash("sha256")` chains; digests are byte-identical.
- Close automation now reads only typed review fields, GitHub facts, and exact labels: removed the "Keep open:" prose veto, the git-history and release keyword checks on close evidence, the supersession keyword matcher (canonical PRs now come from `rootCauseCluster.canonicalRef` or a GitHub-verified fixing PR, and a model duplicate PR close without `canonicalRef` stays open), and the word-count "concreteness" override of the coverage-proof model; fixing-PR provenance and security-label protection use exact values instead of substring matches.
- Require current-main-bound independent scope coverage for obsolete PR closes, preserve recent human engagement, and keep product-scope rejection recommendations on the manual maintainer route.
- Update the pinned Codex CLI to 0.162.1 (the Responses proxy stays at 0.159.2). The `codex exec --json` events, `--output-schema` and `--output-last-message` behavior, the `clawsweeper-review` permission profile, and the `gpt-6.1-sol` catalog entry stay the same.
- Treat "Selected model is at capacity" Codex failures as retryable provider throttling instead of non-retryable execution failures, so reviews retry with backoff during model capacity spikes; the capacity patterns now live in one shared matcher.
- Keep explicit review requests answerable when their publication is deferred: the publisher's source-drift requeue continues the request while it still holds the request's newest publication, command continuations are no longer shed by backpressure or a GitHub throttle, both publishers requeue one review generation under one delivery id, an artifact refresh no longer overwrites a newer queued request (the older request is answered as superseded), and an organic event after a finished request no longer inherits its command status.
- Verify review publication against unchanged GitHub comment bytes when the CLI sanitizes literal escape examples in its response.
- Move comment-router command parsing, trusted automation marker reading, maintainer command admission and GitHub actor checks into one `src/repair/comment-router/admission.ts` owner, and delete the `isIssueImplementationCommandAllowed` pass-through; routing and admission decisions are unchanged.
- Comment router, command status and repair requeue tests now drive the real CLIs and workflow steps instead of reading their source text; the router loopback proof covers throttle deferral, deleted acknowledgements, forced replay identity and the autofix review dispatch with its kept status comment, and the two remaining source guards live in `test/structural-invariants.test.ts`.
- Comment router core tests no longer read router source text: `comment-router-core.ts` now owns merge readiness (`automergeReadinessBlockReason`) and automerge job mode selection (`automergeJobRepairPlan`), and the router loopback proof covers dispatch claim recovery and the linked-PR block on implementation requests.
- Move comment-router job paths, automerge and issue implementation job rendering, automerge repair reasons, the assist dispatch payload and dispatch claim and receipt decisions into one `src/repair/comment-router/dispatch.ts` owner, and fold the repair loop comment read model into `src/repair/comment-router/admission.ts`; job files, dispatch keys and routing decisions are unchanged.
- Move the comment-router ledger (read, append, atomic write and the state-branch merge) into one `src/repair/comment-router/ledger.ts` owner, and delete `comment-router-ledger-merge.ts` and its duplicate entry-key rule; the stored ledger format is unchanged.
- Assemble review guidance from host facts: omit inapplicable close reasons and first-review continuity, honor conditional sections in LF and CRLF checkouts, include prepared-media instructions only with artifacts, retain all security and proof-assessment rules, preserve maintainer/protected guards and the oversized-PR exception, and move live-proof instructions to the available tool. Review policy advances to v42 without changing stored decisions.
- Let contained target `pnpm` 12.6–12.8 open its fixed `/tmp/pnpm-store-operation-locks-0` store lock through a private in-sandbox tmpfs, so repair workers no longer stop on `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` before dependency setup while the rest of `/tmp` stays read-only.
- Containment, repair worker and E2E workflow tests no longer match production source or raw workflow text: the namespace init stage order, filesystem plan, remount flags, capability drop and child reaping now run through the embedded Python runtime; the non-Linux refusal, planning downgrade, planning completion, self-heal plan default and automerge telemetry steps run the real worker, CLI and workflow `run` blocks; the namespace, preflight, execute-gate and read-only E2E guards move to `test/structural-invariants.test.ts`.
- Use owning-module imports for stateless review context hydration and status helpers while preserving related-item and fixed-PR cache lifetimes.
- Retry workflow control-plane calls through a 15-30 second Worker deploy or Durable Object reset instead of failing finished reviews: `control_plane_curl` now allows up to six attempts within 62 seconds of total backoff (previously four attempts within 14 seconds), with `Retry-After` waits drawn from the same budget.
- Sign control-plane requests from workflows in one place: `control_plane_signed_post` in `scripts/control-plane-curl.sh` replaces the 14 copied HMAC one-liners in `sweep.yml` and `exact-review-reconcile-run.yml`, with byte-identical signatures and bodies.
- Launch the app-server Codex stand-in in `test/codex-app-server-output.test.ts` and the orphaned blocker in `test/review-output-policy.test.ts` without `NODE_V8_COVERAGE`, so a signal landing during their exit-time profile write can no longer leave an empty coverage file that fails `pnpm check` after every test passed.
- Distinguish overdue dispatcher retries from active backoff and legitimate queue waits in handoff health.
- Add an agent performance view through the public dashboard Worker that separates repeated claims, pending publications and retained acknowledgements from verified outcomes, and identifies missing quality, human-effort, latency and cost evidence.
- Prioritize refreshed dashboard attention lists by reviewer priority and age, show the assigned priority, and preserve legacy cache ordering until a full corpus refresh.
- Refresh the dashboard corpus by its age instead of one exact cron line: a scheduled build in the 00 or 12 UTC hour refreshes a corpus over 11 hours old, and any scheduled build refreshes one over 13 hours old. GitHub had delayed and dropped the 00:07 UTC run, so review totals went stale.
- Fix dashboard durations showing 60 seconds at minute and hour boundaries.
- Show isolated chart observations as points so sparse timing history stays visible without joining across missing data.
- Show the maintainer-authored share of daily reviews on the dashboard: a dashed "By maintainers" line on the Overview daily activity and Throughput reviews charts, and a "Maintainer share" tab on Throughput. Maintainer means owner, member or collaborator, or the `maintainer` label. Days from corpus caches built before this change show no data until the next `refresh_corpus` run.
- Make dashboard metric labels distinguish latest-reviewed items, model execution time and reviewer assessments; disclose recorded run-history days and avoid treating higher activity as better performance.
- Use bounded GitHub polling exclusively for dashboard workflow health, retiring the unused webhook-source switch and repair path while preserving webhook ingress and queue APIs.
- Restore dashboard Worker deployment after Bay removal by dropping its obsolete static-assets directory.
- Refresh the dashboard corpus (review totals, quality and closes) twice a day at 00:07 and 12:07 UTC instead of only by hand, so the Overview no longer shows a stale-totals warning. The warning now appears only when a scheduled refresh has been missed (older than 14 hours).
- Wait up to 10 minutes (was 3) for the queue Durable Object to report the new deployment in the dashboard deploy smoke test. On 2026-10-14 it kept serving the previous version for 4 min 45 s, so a good deploy was marked failed.
- Keep the dashboard state when a dashboard-site build is rerun. The state cache key now includes the run attempt; before, a rerun could not save (cache keys are immutable), so the 30-day Actions backfill from a rerun was lost and the Agent performance run-time chart showed 1 of 30 days. The Agent performance page also gets its own sidebar icon.
- Remove unused dashboard telemetry summaries and Bay aggregation wrappers, keeping public lifecycle metrics, publication outcomes, and queue compatibility unchanged.
- Add a verification-only dashboard workflow mode that checks an explicit deployed revision without syncing secrets or deploying the Worker.
- Restore the automatic dead-letter reconcile lane: look up the prior queued-run zombie state by one fixed artifact name instead of the repository-wide artifact listing, which GitHub answers with an empty HTTP 500, and fail with the HTTP status when that lookup does not succeed.
- Delete the dead `automergeChangelogBlockReason` gate, which always returned null, with its call in the deterministic automerge result and the tests that only pinned it; automerge fix artifacts are unchanged.
- Share review/apply mutation receipt mechanics while retaining their business identities, and replace unused ledger convenience APIs with root-scoped and safe-target operations.
- Validate the immutable reviewed-attribution policy in the mandatory scanner regression suite instead of repeating policy validation on every scan; retain per-scan native/material checks and validation for supplied test policies.
- Retire unused core parsing and GraphQL blob-size helpers, and exercise checkout, structural-cache, and typed-record safety directly through retained APIs instead of test-only wrappers.
- Make command-proof loopback requests independent of pooled-socket retirement, synchronize Git acquisition timeout fixtures with child readiness, and assert diagnostic privacy without depending on host-specific redaction boundaries.
- Fall back to the `repository_dispatch` relay unless direct target-dispatch intake answers 2xx; the dispatcher template used `curl --fail`, which accepts a 3xx, so a redirect from the intake route would have logged a queued review and silently dropped the event. The template also requires a non-empty OIDC token before posting, because jq 1.6 exits 0 on empty input and the step runs without pipefail.
- Apply the source-drift loop breaker to direct-publication lifecycle requeues, which bypassed `/enqueue`: items whose apply step reported `updated_at changed` after every review were re-reviewed at the same head every few minutes (one pull request reached queue revision 542, about 180 full reviews a day), and now park as `source_drift_loop` after three automatic generations like every other source-drift requeue.
- Hold automatic reviews by maintainers before dispatch, so they start no runner. The queue live check before each dispatch now applies the maintainer-request rule, reads repository permission for `CONTRIBUTOR` authors (GitHub hides private org membership from the App), and parks the item under `maintainer_request_required`. This covers target-repository dispatcher and every other intake path, not only the App webhook; about 56% of successful exact-review runs were such skips.
- The target dispatcher template no longer posts the maintainer opt-in reminder or skips maintainer events; the queue applies the first-review rule for maintainer items (openclaw/openclaw#172830 made the same change in OpenClaw's copy).
- Remove retired Bay tables, indexes, and StatusStore history keys at startup instead of repeatedly pruning dead command journeys (1.45 million rows read across 137 production statements); intentionally retain the inert pending-telemetry column to avoid rewriting 435,000 lifecycle rows on replicated storage during startup.
- Let issue fixes reach their trusted changed gate when well-formed planner validation hints are not allowlisted; record redacted dropped hints in the run summary while preserving shell-injection and mutation tripwires.
- Stop asking the review model for host-owned owner explanations and redundant AGENTS.md policy fields; preserve host-projected attribution, legacy reports, and version-1 review records, and invalidate cached reviews for the slimmer schema.
- Stop the GitHub egress telemetry store from rewriting its diagnostics row on every queue start once the one-time legacy backfill is done.
- Pin managed Node and native pnpm releases that reject the compromised certificate authority keys.
- Build every exact-review lease heartbeat body in `event-review-apply` with one typed command, `dist/repair/exact-review-queue-request.js heartbeat`, which validates the lease tuple and phase options; this replaces nine copied inline Node builders and two shell derivations.
- Build the exact-review lease claim and completion bodies and classify their safe 409 conflicts with `exact-review-queue-request.ts claim` and `complete`, downloaded for the pinned workflow commit, instead of four inline Node scripts in `sweep.yml`.
- Build the legacy `repository_dispatch` intake route and body in `sweep.yml` with `exact-review-queue-request.ts enqueue`, downloaded for the pinned workflow commit, instead of two inline Node scripts.
- Build the exact-review lifecycle router receipts, canonical receipt and terminal disposition after checkout with `exact-review-queue-request.js lifecycle`, which validates the target revision, outcome and terminal kind; this replaces six copied inline Node builders in `sweep.yml`.
- Build the pre-checkout direct-lifecycle replay bodies in `event-review-publish` with `exact-review-queue-request.ts`, downloaded for the pinned workflow commit like the curl helper, instead of two inline Node builders in `sweep.yml`.
- Reuse unchanged scheduled review verdicts again by giving each hosted exact review its prior canonical record, so unchanged items are no longer re-reviewed and re-rated every pass.
- Build the exact-review publication claim and completion bodies and classify the publication claim's safe 409 conflicts with `exact-review-queue-request.ts claim publication`, `complete publication` and `claim conflict`, downloaded for the pinned workflow commit, instead of three inline Node scripts in `sweep.yml`.
- Fail "Queue durable exact review publication" when the publication enqueue returns a non-2xx status, no response, or a body that is not one queued, deduped or superseded JSON response. Before, the step dropped the curl failure and passed on the empty response with jq 1.6, so a 400 or 503 could pass the step and skip the lease release.
- Build the publication enqueue body in `event-review-apply` and the source-drift requeue body in `event-review-publish` with `exact-review-queue-request.js enqueue publication` and `enqueue source-drift`, instead of two inline Node scripts in `sweep.yml`; no step in `sweep.yml` builds a queue request body inline now.
- Allocate every exact-review item revision from the durable per-item counter, floored on retained direct-publication receipts, lifecycle projections (including GitHub-cased targets), and the publication head, so a re-admitted item no longer reuses a directly published revision (`conflicting direct publication retry`) and an artifact-refresh recovery is no longer superseded by its own publication head.
- Build the terminal-finalization claim and requeue bodies and classify the claim's safe 409 conflicts with `exact-review-queue-request.ts claim body --require-tuple`, `claim conflict` and `terminal-finalization retry`, downloaded for the pinned workflow commit, instead of three inline Node scripts in `sweep.yml`; the publication claim uses the same `--require-tuple` claim.
- Build the terminal-finalization attempt and skip bodies and the command-acknowledgement failed and observed receipts with `exact-review-queue-request.js`, which validates the lease tuple, status address, skip reason and completion; this replaces four copied inline Node builders in `sweep.yml`.
- Match the seven owned security labels exactly across advisory, apply-close, and repair gates while preserving existing automation holds and ignoring automation-only source-revision changes, recheck live labels and structured security markers before repair merges, and use explicit security metadata instead of advisory IDs or prose when selecting cleanup work.
- Move the fix executor's Git work (target checkout, remote branch lease reads, mechanical rebase completion, checkpoint commits, history compaction and recoverable branch pushes) from `src/repair/execute-fix-artifact.ts` into `src/repair/execute-fix/git-ops.ts`, built over one small run context; repair branches, pushes and reports are unchanged.
- Move the fix executor's Codex handoff (the heartbeat worker process, the read-only `/review`, the review-fix and validation-fix workers and the review result checks) and the fix execution report (write, debug artifacts and deferred publication) from `src/repair/execute-fix-artifact.ts` into `src/repair/execute-fix/run-and-report.ts`, built over two small run contexts; Codex calls, prompts and reports are unchanged.
- Break self-feeding exact-review loops: after `EXACT_REVIEW_SOURCE_DRIFT_REQUEUE_LIMIT` (3) consecutive automatic `source_drift_requeue` generations the queue parks the item as `source_drift_loop` until an organic event or command (a newer scheduled offer releases one review without resetting the count), and `/api/exact-review-queue` gains `review_runaway_health` (degraded with `review_runaway` above `EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY` claimed reviews per item per day, with up to five public sample keys).
- Keep audit health scans from retaining full report bodies through metadata string slices, avoiding heap exhaustion on large report corpora.
- Charge the scheduled review budget when a claimed run starts Codex generation instead of at claim, so runs that exit before generation no longer starve scheduled backfill.
- Fix direct-lifecycle publication recovery completing as `superseded`/`live_terminal`: the publisher now keeps the replayed `published`/`publication_applied` result, so a recovered requeue completes instead of getting `invalid_direct_lifecycle_requeue`.
- Qualify the exact synthetic catalog-icon URL rejection fixture so OpenClaw reviews pass input scanning without relaxing credential or source checks.
- Preserve pull request identity in webhook item and placeholder snapshots so review leases use the PR head and reject head drift instead of reserving an issue digest.
- Stop scheduled re-review loops on deterministic no-ops: scheduled planning skips open-but-locked conversations, and the exact-review queue holds a completed locked-conversation or oversized-PR generation as `locked_conversation` / `oversized_pull_request` so later scheduled offers and automatic recoveries dedupe without claiming a run until an organic event, command, pushed head, or parked-review reconciliation releases it.
- Charge the exact-review budget when a workflow run claims a review lease instead of when organic work is admitted, so organic items closed, superseded, coalesced or deduped before they run no longer hold the global balance at its debt floor and scheduled hot intake and normal backfill receive the share of the 220/hour budget that executed organic reviews leave; scheduled admissions still pay up front and prepay their first claim.
- Allow runner snapshot uploads to bootstrap repositories beyond the cold hydration limit while preserving bounded ordinary hydration and incremental restores.
- Complete stale publication retries as superseded when a newer review of the same source reused the command lease, while rejecting ambiguous or incomplete review identities.
- Dashboard: rebuild inconsistent active-run censuses once and bound advisory ETag cache operations so transient collection failures do not leave operations telemetry unknown.
- Fix signed exact-review enqueue, branch-authority, and source-authority intake so a `decision.targetRepo` that a header cannot carry (CR, LF, NUL, or a character above U+00FF) gets the queue's route-specific 400 instead of an uncaught Worker 500; every other value, including a space-padded slug, behaves as before.
- The fix PR labels that come from a job's source (autogenerated and autofix for generated issue PRs, which also lose automerge; commit-finding for commit jobs) are now decided by one exported function, and a behavior test replaces the source-text match that pinned the executor's code shape.
- Read ClawSweeper's commit author name and noreply email from the bot identity module in repair code; the repair workflows now pass only the repository variables, so an unset variable falls back to that one default.
- The state publisher's push rules are now tested against real git remotes: a stale publisher never overwrites a concurrent commit or leaves side refs, and an enabled coordinator gates publication before any push, instead of grepping the source for forbidden strings.
- Gitcrawl low-signal PR selection scores facts only (no update in `--stale-days`, outside author, draft, broad file count) instead of title, body and path keywords, and no longer holds back PRs whose text mentions a bug or fix; the repair worker judges `close_low_signal`.
- Send eligible issue, comment, and pull-request activity from the signed GitHub App webhook directly to the ClawSweeper agent behind a deployment gate, sharing the relay's filters and message format, with a bounded best-effort retry budget; retain relay delivery for unsubscribed event families and skip covered relay notifications after cutover.
- Remove GitHub execution and context factories and their test-only exports; isolate mutation receipt runners at review/apply command boundaries, retain repository-qualified activity fallbacks only for the current run, and parse ETag Accept headers without backtracking.
- Remove the CLI's GitHub runtime factory and isolate GitHub retry budgets, credential reservations and retained ETag responses to each command invocation, including asynchronous continuations.
- Prepare a Go toolchain for Go targets before validation: derive `GOROOT` from the `go` on the validation PATH or the runner's published tool-cache roots (choosing one that satisfies the target's `go.mod` when the PATH one is too old), bind it read-only in the validation sandbox, pin `GOTOOLCHAIN=local`, and turn off Go telemetry in the disposable profile, so repair validation no longer fails with `cannot find GOROOT directory` on runners whose Go binary is trimmed or with a leftover telemetry sidecar.
- Complete verified activity-based close-policy holds as guarded-open publication outcomes, preserving source-drift and failed-verification safeguards, and create issue-close payload directories on fresh checkouts.
- Keep issues and pull requests with concealed shell payloads open for human security moderation across all repository profiles, including older close proposals.
- Fix the hosted canary terminal stop so the controller's own post-DONE teardown, which can end the tmux server and remove its socket between two reads, goes through the fresh-receipt and quiescence proof instead of failing on a second identity read or a vanished socket.
- Raise the Node heap for record hydration in setup-state to 12 GB, so openclaw-openclaw hydration fits after the review_record backfill (#1874).
- Publish preliminary intake labels before target-source checkout, and skip runner and source preparation when an exact-review reservation is held or superseded.
- Stop parallel issue intakes from deleting each other's queued jobs: intake now publishes only the job and audit files it wrote, not the whole `jobs` and `results` directories from its older checkout.
- Enable preliminary intake labels with the existing native OpenAI key, default to Decisions, and support a decision-model override or explicit off.
- Add bounded, submission-only intake classification through ordinary structured model responses, with raw-field secret scanning and a deadline covering durable intent recording; make the deployment revision timeout test deterministic.
- Add an optional Decisions backend for bounded submission triage without changing the ordinary Responses path.
- Add opt-in preliminary submission labels before full source review, with queue/source guards, separate usage receipts, preserved interruption recovery, and cleanup by the current completed review.
- Parse and age-check ISO timestamps through one `iso-time` module (`parseIsoMs`, `isIsoTimestamp`, `isOlderThanDays`) instead of three `timestampMs` copies, two `isOlderThanDays` copies and three timestamp regexes.
- Keep automatic issue builds updating their issue comment: a worker that must restore a missing issue job now takes the last version from the state branch history with its original permissions, or writes a job that cannot change code and reports why on the issue; status updates and the execute gate read the source issue through one `issueImplementationSource` reader; and a planning failure now marks the issue comment blocked instead of leaving it at Queued or Planning.
- Pause automatic issue implementation when its own worker runs keep failing: before it dispatches a candidate, the dispatcher counts the target's finished issue implementation worker runs from the last 7 days by GitHub run conclusion, writes the counts and success rate to the run summary, and dispatches nothing below a 50% floor once 10 runs have finished. `CLAWSWEEPER_AUTO_IMPLEMENT_MIN_SUCCESS_PERCENT` sets the floor; `0` overrides the pause.
- Keep issue next steps focused on the concrete repair, missing evidence, or maintainer decision instead of internal worker queue instructions.
- Reuse an unchanged keep-open issue verdict for up to one day when only the target branch moved since its last full review, so busy target branches no longer buy a full re-review and fresh labels on every hourly pass of an untouched issue.
- Make target dispatchers OIDC-only, with Worker-owned live comment authorization and acknowledgements, while retaining legacy receivers during migration.
- Give each ClawSweeper automation label name and the ClawSweeper bot logins one defining site, derive `MergeRiskLabelName` from the policy label list, and delete the duplicate label and trusted-author constants in the repair lane.
- Build the apply guards over one memoized read context (`ghJson`, `ghPaged`, `targetRepo`) instead of a 25-member dependency interface. Pure guard checks such as `prAutoCloseExemptLabel` and the age skip reasons are module exports that callers import, and `apply-guard-dependencies` is gone.
- Make the label policy, label selection, proof policy and PR readiness plain module exports that callers import. Label writes keep one mutation instance over the gh shell, and the sync operations build on it. This removes `label-sync`, `label-dependencies`, 21 label `*ForTest` twins and their dependency-interface members.
- Make the report readers (`clawsweeper-report-parser`, `clawsweeper-record-metadata`, `clawsweeper-report-helpers`) plain module exports that callers import, instead of runtime factories threaded through eight dependency interfaces and the runtime spreads.
- Check local Codex login status without a model request with `pnpm run codex:local:check -- --diagnostics`.
- Retain qualified private local-review package inputs and their observed npm resolution as per-platform CI artifacts.
- Qualify isolated local review packages on Windows and macOS, including the native npm Windows launcher.
- Prepare a dry-run-only release caller that reuses the exact local package envelope qualified on Linux, Windows, and macOS.
- Extract the full committed-range review engine behind a lazy source-checkout entrypoint, preserving native reports and history while keeping hosted orchestration outside local review.
- Add a private local-review package staging path with isolated installation checks and an executable local command.
- Qualify the installed local package on GitHub's macOS 27 Apple Silicon runner.
- Give maintainer-authored items created from 2026-10-15 03:50 UTC (when the first-review rule deployed) their automatic first review instead of waiting for 12:00 UTC, and release a `maintainer_request_required` hold at the periodic parked-item check once the live item no longer requires a request, so items held in the meantime get reviewed.
- Prevent empty maintainer decisions from carrying populated fields in structured review output, avoiding unnecessary failed review and repair turns.
- Maintainer-authored and `maintainer`-labeled items created from 2026-10-15 12:00 UTC are reviewed like everyone else's: a PR gets one automatic review and later reviews need `@clawsweeper review`; an issue follows the ordinary issue cadence. Older maintainer items keep the request-only rule, so the change starts no backlog of reviews.
- Stop dispatching exact-review runs for maintainers whose org membership is private. GitHub shows them to the App as `CONTRIBUTOR`, so the webhook gate let their item events through and each run only claimed a lease, checked out, set up and skipped. The gate now reads the author's repository permission (admin or maintain counts as a maintainer, as in the runner admission check), cached per author for an hour.
- Keep an explicit `@clawsweeper re-review` alive on maintainer-authored items when the item changes during that review (for example another bot posts a PR review): the queue's in-place source-drift requeue now continues the unanswered request instead of skipping it as automatic, so the review publishes and the command status no longer sticks at "Review in progress". A source-drift requeue that finds no queued request (finished or replaced) keeps the command status but drops the request's verification, so it cannot authorize another review.
- Stop repeated automatic claims of maintainer items that require an explicit review request; retain the skipped result as a queue hold until new input arrives.
- Make maintainer issues and PRs opt-in for ClawSweeper review, with one reminder to request a review only when needed after completing work and validation.
- Fix PRs awaiting only explicit maintainer approvals or product decisions being routed as author work, while preserving merge blockers and contributor proof/fix requirements.
- Keep the media proof URL cap and per-URL deadline in one dependency-free module; media proof preparation, the adaptive review budget and the exact-review workflow (its media allowance cap and its media preprocessing reserve) now read them from there instead of repeating 4, 120 seconds and 480 seconds.
- Share ANSI stripping across repair command, GitHub, and Codex diagnostics through the repair text utility owner.
- Give `openclaw/openclaw` repair validation 50 minutes per command instead of 25. Its cold `pnpm check:changed` typechecks all 27 core test graphs one at a time for changes in shared core code and now also runs the Knip dead-export scans; from 2026-10-03 to 10-09, 44 issue-fix runs timed out at 25 minutes on that gate.
- Stop another same-head re-review loop on PR close proposals: when apply syncs its durable review comment, GitHub can report the item's `updated_at` before it reflects that write and move it to the write's own time later. The self-mutation receipt now also records the write's own `updated_at`, so the final freshness gate recognizes the owned write instead of reading it as source drift. The receipt's structural checks are unchanged.
- Add two small indexes to the exact-review queue: a partial index on reclaimed publication batch memberships (the stats count no longer scans every membership; 2.7 ms → 0.13 ms at 88k rows) and an age index on GitHub egress rollups (cap eviction no longer sorts rowid ties; 1.6 ms → 0.02 ms in the single-timestamp worst case). Each builds once at startup in about 5–11 ms.
- Reduce canonical-record SQLite reads without changing the schema or export protocol: seek each tuple section, merge bounded per-section export pages, seek repository revision heads, use the snapshot watermark index, and look up publication fences through their primary keys. Run publication-identity backfills only when adding their missing columns, preserving legacy receipt retries without repeated startup work. A local `node:sqlite` proof with 411,576 records, 40 repositories, and 28,357 publication receipts preserved results while reducing median tuple lookup 11.883→0.005 ms, export page 17.653→0.531 ms, repository heads 19.880→0.051 ms, snapshot identities 57.022→0.376 ms, and fence lookup 0.799→0.001 ms; the former steady-state fence backfill scanned 28,357 rows and changed none. Canonical listing and snapshot counting already use bounded index ranges; publication counting remains on the memoized stats cadence.
- Collect review context faster: related-item issue and pull reads, check-run and status reads, and the head and tail pages of large file and commit windows now start together (up to 8 `gh` processes), while retries, rate-limit fallback, runtime budget, and the resulting context stay the same.
- Let target dispatchers enqueue issue and PR events directly through the OIDC-authenticated `/github/target-dispatch` Worker route instead of starting one `Review event item` relay run per `repository_dispatch` (about 218 runs/hour, almost all from `openclaw/openclaw`); the token must match the payload's repository, event, branch, and workflow, a replayed run dedupes, and any direct failure falls back to the unchanged dispatch. Targets stop relaying once they adopt the updated dispatcher template. The shared Actions OIDC verifier now fetches GitHub's JWKS with `redirect: "manual"`, because Workers reject `redirect: "error"` and every review-proof producer token was failing closed.
- Reduce GitHub egress telemetry SQLite work with transaction-safe cached row counts, indexed cap candidates, eviction evidence returned by deletes, shared five-minute retention maintenance, and cached six-hour totals. At 50,000 rollups and 35,001 receipts, a 24-submission proof preserved every observability window and reduced mean ingest time from 4.785 ms to 0.211 ms; cap candidate scans fell from 50,000 rows to 101. Bound webhook item pruning to indexed overflow ranges and skip global workflow sorting without overflow (500-comment prune: 0.0982 ms to 0.00958 ms; 1,000-workflow prune: 0.1145 ms to 0.00383 ms). No schema changes; single-timestamp rollup overflow and actual global workflow overflow still require sorting with the existing indexes.
- Reduce exact-review queue SQLite work without changing admission or lease semantics: keep exact delivery counts with append-only delta reads (132k-row fixture: 15.44M repeated rows avoided across 117 warm polls), use existing indexes for command receipt retention and publication history (53.5× and 73.7× faster in SQLite proofs), narrow item/credential lookups, reuse intake snapshots, run telemetry cleanup at most every five minutes (140→12 scans per 56-minute fixture), and skip redundant state-writer timestamps while retaining ingress compatibility across rollback and re-upgrade.
- Ask the target `pnpm` for its own `dlx` cache key during OpenClaw setup and link the pinned Knip helper there, so the offline `check:changed` dead-export scan reuses the reviewed helper instead of failing with `ERR_PNPM_NO_OFFLINE_TARBALL` when a pnpm release changes its key inputs.
- Read the close-policy env flags from one `policy-flags` module for both the review lane and the comment router, and reject the retired `--codex-reasoning-effort`/`--codex-service-tier` flags through one arg-parser check.
- Add opt-in local-range preflight summaries to JSON review output, preserving native reports and refusing export when the reviewed source changes.
- Post-flight's "never closes" rule is now tested on the gh calls a real merge run makes, instead of grepping its source for `"close"`.
- Stop PR close proposals from re-reviewing the same head forever: the post-proof freshness check now starts from the `updated_at` that the pre-apply gate already accepted, so ClawSweeper's own review-progress acknowledgement edit no longer reads as source drift. Any change after that point still blocks the close and requeues.
- Qualify the unchanged synthetic Cron FTP fixture in the exact reviewed source blobs for OpenClaw PR #168996 without relaxing native scanning or source attribution.
- PR repair intake selects PRs on typed GitHub state (failed checks, DIRTY/BLOCKED merge state, changes requested, unresolved threads) and passes recent comment and review bodies to the worker as plain context; comment keyword matching and `--include-review-comments-only` are removed.
- Wait ten quiet minutes before the first automatic PR review, then require an explicit re-review request after a completed answer; preserve unfinished retries and autofix/automerge opt-ins.
- Exclude one strictly validated local preflight annotation from PR review content and semantic hashes while preserving human text, raw event guards, and advisory-only trust.
- Complete verified product-direction age and inactivity holds without reporting a publication failure.
- Preserve publication failure reasons in durable telemetry and expose aggregate reason counts without publishing target identities or error details.
- Stop launching redundant comment-router scans after review publication; retain durable lifecycle completion, real-command intake, and scheduled missed-command recovery.
- Compare record trees one file pair at a time when publishing a whole repository's records, so apply checkpoints no longer exhaust the heap by holding the working tree and the hydrated state tree in memory at once.
- Wait for the exact-review queue deployment revision before marking a dashboard rollout ready.
- Move expired webhook payload retirement off request transactions and keep bounded maintenance alarms running through idle queues and restarts, with committed progress counters.
- Stop the exact-review queue from rewriting thousands of rows on every Durable Object start. Two publication-batch backfills now write only rows that change, and the finished export-index seed (a full scan of all canonical records) is removed. A temporary storage meter showed one start writing 7,520 rows and reading 957k, which matches the 40–46 s queue freezes on cold restarts.
- Add a read-only storage report for the exact-review queue: the **Maintain exact review queue** workflow's new `storage-stats` mode lists each SQLite table's row count and estimated size, and how many full-table Bay tide scans ran since the queue object started. Cloudflare shows only the total size.
- Preserve action-ledger transaction boundaries when publishing to R2 and hydrating state: validate complete publication manifests, publish completion last, recover missing committed members, and report omitted unfinished imports without replacing the previous ledger on validation failure.
- Prevent concurrent single-request ledger and exact-review artifact uploads from overwriting immutable R2 objects while preserving identical replay.
- Replace the source-text tests of the repair executor with behavior tests that run `dist/repair/execute-fix-artifact.js` against a local Git remote and fake `gh`/`codex`, move its failure classifiers into `execute-fix-policy`, and check the repair workflow ordering through parsed steps; executor behavior is unchanged.
- Read the media proof URL cap and per-URL deadline from the media proof module in the adaptive review budget, and the Bay tide size from the lifecycle telemetry module in the dashboard Worker, instead of keeping second copies; tests now read label, tide, and media budget values from their owners instead of pinning literals and workflow site counts.
- PR review Before-merge items now come only from typed model fields: every `risks` entry blocks, a required `nextStep` is one item, D/F rating steps are all required, and labels no longer show a priority that keyword rules guessed; a report without a valid typed next step asks for a fresh review instead of guessing from prose, and the host no longer rewrites self-references or owner roles in model text.
- Stop the deferred-publication `source_drift_requeue` loop for close proposals kept open by their producer: a later apply of the same review (the batch publisher) now accepts an `updated_at` moved only by ClawSweeper-recorded writes, including the producer's released review lease, when the reviewed source, timeline, head, and review-activity receipt still match and no non-automation activity follows the review snapshot. Human comments, title/body or label edits, PR reviews, and new heads still block apply and requeue.
- Remove the public Bay page and its dedicated read APIs: the expensive lifecycle read used roughly 20 seconds of CPU and 45 seconds of wall time, stalling Durable Object claims and heartbeats. Preserve lifecycle telemetry writes, authenticated audit evidence, and Overview public references.
- Stop unused Bay telemetry writes and recovery after the 2026-10-13 06:55 UTC `/lifecycle/router-receipt` spent 41.6 seconds wall time and 15.0 seconds CPU before a Durable Object storage timeout/reset; preserve canonical lifecycle records, publication outcomes, and Overview queue projections.
- Remove inline Mantis proof tools from PR reviews and their Codex app-server execution path: Telegram proof never reached its test in 126 runs (125 failed, one cancelled); the last 60 Web UI runs had no completed PR-bound proof, and recent successes were standalone maintainer runs. No proof updates have arrived since 2026-10-11; roughly 600 daily proof endpoint calls were only review-start capability checks. Ordinary reviews and PR-close coverage proof remain unchanged.
- Give the ClawSweeper command-ack, command-status, command response and automerge-requested-by markers one owner (`src/repair/markers.ts`) that builds and parses them, and delete the duplicate builders and regexes in the router, executor, webhook and dashboard Worker.
- Run repair's gh dispatch, planner, proof-request and fence subprocesses through `command-runner.ts` instead of raw `spawnSync`/`execFileSync`, so a spawn failure or timeout now reports its cause instead of an empty error, and `create-job --dispatch` runs `repair:dispatch` instead of the missing `npm run dispatch` script.
- Repair, automerge and issue-implementation lanes no longer judge prose: needs-human verdict markers carry typed `hold=` and `findings=` attributes that drive auto-repair, human-review guidance and maintainer approval (automerge opt-in or `@clawsweeper approve` waives `not_opted_in`, `maintainer_decision` and lone `proof` holds; security and integrity holds stay hard); issue intake reads only the typed Security Review status (missing status fails closed); repair-worker validators and the executor read typed actions, classifications and repair strategies; covering-PR label checks use exact label names.
- Route every repair Git call through one `runGit`/`runGitResult` owner in `src/repair/git.ts` (formerly `git-repo-utils.ts`) instead of 58 inline `execFileSync`/`spawnSync`/`runCommand("git")` sites, so a Git spawn failure always throws, and build the review lane's offline Git env in one helper.
- Repair tests for stale publication, command status, post-flight closeout promotion, target fanout, cluster intake, issue build overrides and exact-review batch claims now drive the real CLIs, workflow steps and exported functions instead of matching production source text; the issue build override blocker class moves to `comment-router-core.ts`, and the remaining safety guards live in `test/structural-invariants.test.ts`.
- Make the report comment helpers plain module exports that callers import, and move the close-comment wording into them. The close-comment renderers take the repository profile as an argument. This removes the `createReportCommentHelpers` factory, the close-comment forward reference in report orchestration, and the stale-review history member of the review-comment dependency interface.
- Read and write report front matter and sections through one shared module, so the repair lane no longer reads metadata from fenced report samples and front matter or section writes no longer expand `$&`, `$1` or `` $` `` in stored values.
- Make the fixed-in and regression report readers, the review-notes lines and the report orchestration foundation (close wording, PR surface, review metrics, proof blocker) plain module exports that callers import. Functions that link to the target repository take the repository profile as an argument. This removes the `createReportOrchestrationFoundation` factory, its forward reference to the renderer, and the reader members of the report-rendering and report-orchestration dependency interfaces.
- Replace stateless report rendering and promotion collaborator bags with direct module imports, preserving report formats and the existing related-context cache and live-revision adapter lifetimes.
- Centralize command repository selection in the repository profile owner and use plain path and link imports, preserving per-repository records, nested profile restoration, and public report links without factory-only configuration.
- Retire the leftover autofix/automerge review behavior: `clawsweeper:autofix` and `clawsweeper:automerge` no longer exempt an item from the maintainer request rule, the once-per-PR review rule or the initial quiet window, ClawSweeper no longer applies the `status: 🚀 automerge armed` label, and review decisions drop the unused `automergeInstruction` field (stored records that still carry it keep loading). The labels still protect items from close proposals.
- Retire the leftover OpenClaw Bay guidance: the AGENTS.md rule becomes a public-dashboard rule with the same observer-only boundary, and the PR template drops its Bay Impact section.
- Retire unreachable non-commit backfill payloads after canonical publication, and drain historical shadows in bounded, restartable idle maintenance while preserving live imports and commits.
- Retire the dead `liveProofPlan` and `mantisRecommendation` review decision fields: the model no longer fills them, new reports drop their sections and front matter, and review comments stop suggesting `@openclaw-mantis` comments that no OpenClaw workflow answers; stored reports still parse and keep their automation markers.
- Retire automatic idea-archive reopening and sponsorship commands; preserve guarded feature-request closes, community-traction exemptions, archive labels, and explicit maintainer reopening.
- Retire completed one-off proof drivers and unused manual maintainer-report and metadata-audit workflows while preserving active regression harnesses and historical proof records.
- Stop persisting PR hydration caches in review records and remove unused prior-snapshot reads. Retire existing cache fields in bounded, restartable maintenance while preserving review evidence, publication receipts, answered state, and tuple provenance.
- Retire the old post-review proof executor, CLI, media publication and compatibility readers; historical attachments no longer affect review readiness or comments, while current inline proof and stored reports remain intact.
- Retire repair, autofix, automerge, cluster intake, and automatic issue implementation while keeping exact review, apply, and re-review commands backed by the Worker records queue.
- Remove retired repair, cluster, automatic issue implementation, and automerge telemetry from the dashboard and Worker APIs while preserving review, publication, queue, and generic worker health.
- Remove retired Telegram proof and vision-fit review output while preserving stored review records and existing proof labels.
- Fix publication of a newer review when a queued command reuses an earlier status-comment lease ID. Keep ambiguous ownership and unverified supersession blocked.
- Review and apply tests no longer read `src/` or workflow text: sweep status, placeholder recovery, activity cursor, start lease, release lookup, coordination hold and close-time lease rules now run through the status and recovery CLIs or their exported owners, and `sweepStatusApplyHealthForTest` is gone.
- Stop asking authors to sync a cleanly mergeable PR with the target branch: base drift blocks only on a GitHub conflict, overlapping hunks, or a named target-branch change the PR depends on.
- Treat an exact review target that closes during setup as an empty selection so the workflow can verify its terminal state without reporting a model failure.
- Drop the `# ClawSweeper review` heading from review comments and move the `Reviewed <time>` stamp from the verdict line to the end of the comment.
- Make PR review comments state each proof gap once: the Before merge item owns the proof ask (no doubled "Needs real behavior proof before merge:" prefix), the Proof confidence row shows the rated proof summary instead of "Not applicable" or points to Before merge when proof blocks, and status-label justifications state only the label meaning. Likely related people now lists only commit-verified people, the PR surface counts native `apps/` code (Swift, Kotlin) as Source with Swift/Gradle test targets as Tests, and "Added test files" counts only files whose GitHub status is `added` (the model no longer supplies this count; local-range reviews now record GitHub file status words).
- Simplify review-comment ownership by importing state, publication, policy, and formatting operations directly while retaining fresh live-revision checks during lease confirmation; CLI behavior and stored report formats are unchanged.
- Stop `/api/review-coverage` from stalling the exact-review queue. The coverage scan read every canonical item record in one synchronous query (2–4 s of Durable Object CPU, up to 12 s wall), once a minute while any dashboard tab was open, and claims, heartbeats and enqueues waited behind it until review runs hit their 20 s timeout. The scan now runs in 2,000-row keyset pages with a yield between pages, at most once every 15 minutes, and the endpoint serves the last finished counts with the current inventory.
- Stop rewriting reviewer decisions in code: changelog findings, next steps, correctness, and environment-access risks stay as the model wrote them; the model's PR rating is no longer capped by proof receipts or replaced by a computed score (a missing rating shows `NA` and asks for a fresh review); and the model's `not_applicable` proof status now decides docs-only and other proof exemptions instead of a `docs/` path rule, with missing proof on external PRs still failing closed.
- Give a Codex review one repair turn on the same thread when its final decision fails validation, so a fixable cross-field error no longer fails the whole review.
- Keep only cross-field rules in the review prompt and let the decision schema own per-field guidance and the label catalogs, including a real `closeComment` description, so each field contract and label definition is stated once.
- Hosted PR reviews can read old file contents again: before the sandboxed review, the host fetches the full history of the PR's changed files and their earlier names in one batched request (bounded to 5,000 blobs, 128 MiB estimated per file, and 60 seconds), the prompt names earlier file names and any history left out, and behind the read-only review proxy the reviewer runs with `GIT_NO_LAZY_FETCH=1`, so a missing blob fails at once instead of an HTTP 403; the unrestricted OpenClaw runner keeps lazy fetch.
- Keep evidence-backed metadata exceptions, backed-up invalid-data repairs, and authorized repair implementation choices with the PR owner instead of requesting maintainer design acceptance, while preserving compatibility proof and public-contract decisions.
- Keep the review prompt an index instead of an archive: send a pull request body once instead of under both `issue` and `pullRequest`, count passing checks and list only the checks that did not pass, and omit linked-item bodies when the reviewer can read GitHub, which it does with `gh` when a linked item matters.
- A written decision by a maintainer (OWNER, MEMBER, or COLLABORATOR) on a pull request or its linked issue now resolves an owner call; reviews no longer ask for a second maintainer or a specific area owner.
- Stop low patch ratings and security concerns from restating typed findings as extra Before-merge items.
- Reserve maintainer decisions for concrete unresolved choices, honor recorded design acceptance, keep stored-state compatibility proof separate from routine landing sign-off, and reconcile legacy packets without clearing their review holds.
- Keep PR-body paperwork (timings, CI seconds, headings, reruns of passing commands) out of Before-merge items, claim merge conflicts only from GitHub's merge state for the reviewed head, ask for plain-word author actions, count a regression test as proof path above `none`, and keep tool plumbing out of public review prose.
- Make review presentation plain module exports that callers import, and export the repository link builders with an explicit repo or profile. `closeEvidenceLine` and `likelyOwnerLines` take the repository profile as an argument. This removes the `createReviewPresentation` factory, its runtime wiring, and the presentation members of the report-rendering (26) and report-orchestration (27) dependency interfaces.
- Cut the review prompt and decision schema text by about 40% per review without dropping a rule: each rule is stated once, schema descriptions say only what a value is, and the pull request template follows the review order step by step.
- Split the review prompt into a shared core plus issue and PR templates, fold the PR review rules into the PR template, render close reasons from the repository profile for the item kind, and move OpenClaw-only Telegram proof, maturity, VISION.md, changelog, and locale-branch rules into the OpenClaw profile, so issue reviews and other repositories no longer receive guidance that does not apply to them.
- Add bounded private queue logs for committed enqueue outcomes and acknowledged review starts, with opaque joins on source-drift park warnings, without changing review admission or cadence.
- The apply close checks read the reviewed decision from the report's typed `review_record`. A report without the line still reads its decision from the report text until the backfill gives every report a record. Apply does not close or promote an item whose `review_record` does not read: it records `skipped_changed_since_review`, and the item gets a fresh review.
- Publish ReviewRecord backfills with at most eight canonical tuple requests in flight, preserving per-tuple compare-and-swap and transient retries; ordinary reconciliation and publication remain serial.
- Add the read-only `backfill-review-records` command and the "Review record backfill dry run" workflow. For every stored items and closed report, they report whether it already has a `review_record`, whether its line is invalid, whether the typed decision cannot be made, or whether it can be made and renders back the same decision fields ("lossless"), differs only in fields the report never stored ("filled"), or changes a stored value ("lossy", with per-field counts and samples). A difference that only the current renderer makes (the evidence `repo:` line, the public likely-owner policy, the retired added-test-files line, a section older than the front matter it restates, escaped or reordered JSON text) keeps a report lossless and is counted in `renderedFields`. `review_status` is host lifecycle state and is not compared. The typed decision keeps a security concern file without a line, the proof assessment of a maintainer-authored PR, a verified or suspected regression provenance, and an empty risk item, and fills the default AGENTS.md policy status for a report that has none. They write nothing.
- Add opt-in `backfill-review-records --write --include-lossy` and the Review record backfill workflow's `include_lossy` input (default false). Lossy reports receive the same `origin: backfill` record containing the parsed decision without changing their existing text; detail omitted by the parser no longer appears in record-based renders. Dry-run artifacts retain per-field loss counts and up to five samples per field. Invalid and unparseable reports remain untouched, with the existing write limits, compare-and-swap, and retry behavior preserved.
- Import the review-record backfill renderer directly, removing its stateless factory without changing report classification, dry-run behavior, or compare-and-swap publication.
- Add the write mode of the review record backfill. `backfill-review-records --write [--limit <n>]` adds the `review_record` line (origin `backfill`) to lossless and filled reports only, in batches of 50, skips and counts a report that changed since it was classified, captures each canonical tuple baseline before it writes, and lists the written reports in `changedRecordFiles`. The "Review record backfill" workflow gets a `mode` input (default `dry-run`); `mode: write` runs a separate job that uses setup-state like apply, publishes the written tuples through `publish_reconciled_records` with compare-and-swap on the baseline digest, keeps a report that a fresh review changed since hydration, and counts those skips in the step summary. A written report is typed, so a run that stops part way can run again.
- Issue-implementation intake hashes a report without its `review_record` line. The line repeats the review, so adding it (by a new review or by the backfill) no longer looks like a new review revision that refreshes implementation jobs or makes worker retries due.
- Priority, impact, maturity, merge-risk, Telegram proof, and issue advisory labels, and the label details of the review comment, read the reviewed decision from the report's typed `review_record`. A report without the line still reads these labels from the report text until the backfill gives every report a record. A `review_record` that does not read stops the review comment render, so no comment is posted from it.
- Review reports now store the typed decision as one front-matter line, `review_record: {"version":1,"decision":{…}}`, written last in the front matter. Apply promotions and coverage-proof blocks update that record together with the markdown they change, and promotion evidence is typed. The record must read back unchanged; a decision that would not is left out (the report then reads like an older report) and logged. Nothing reads the record yet, and the rest of the report bytes do not change.
- Read decision packets, repair eligibility, and dashboard outcomes from the typed review record, retaining legacy-report compatibility and rejecting unreadable records rather than trusting stale report prose; refresh prepared repair jobs when their recorded instructions change without invalidating equivalent backfills.
- Remove legacy report decision parsers and the backfill converter after the typed-record-only cutover; retain only a revision-identity projection, host-owned lifecycle readers, and the stored record format.
- Read PR proof, ratings, showcase and status labels, merge readiness, and review comments from the saved typed review decision, retaining legacy reports and rejecting unreadable records.
- Require a readable typed review record before applying or publishing reviewer decisions and retire the completed backfill command, without changing stored intake revision identities. Missing or corrupt records require a fresh review without GitHub mutations, remain metadata-only in dashboards, and no longer interrupt unrelated items in bulk scans. A newer canonical review also supersedes an explicitly supplied older report before implementation job recovery or GitHub calls.
- Read remaining apply, promotion, review-context and live-proof decision fields from the stored review record, retaining legacy-report fallback and rejecting unreadable records before acting.
- Point reviewers at REST `gh api` reads: the review network allows only read methods, so the GraphQL-backed `gh issue view`, `gh pr view`, `gh issue list`, `gh pr list`, and `gh release list` the prompt suggested failed with HTTP 403.
- Show review scores right under What this changes, above the product verdict, in PR review comments.
- Review pull requests against the target repository's pr-simplify skill and flag machinery and tests the smallest complete fix does not need.
- Teach PR reviews the maintainers' standing rules: root cause over symptom patches, fixes in the shared owner, model judgement over regex judges, no restrictions without a trust boundary, helpful user messages, public-text hygiene, upgrade proof from the latest stable release, and one place per remaining gap so a proof gap no longer repeats as a merge risk.
- Stop an exact-review target checkout when its git fetch, clone, or the checkout after a failed tip-blob fetch stalls, instead of holding the review slot until the job limit.
- Stop reviewing transferred issues under their former repository and number, preventing repeated retries and unrelated-item context or publication.
- The review command now takes the Codex failure log kind and the local-history `review_status` from the typed failure and decision it already holds, instead of regex-reading its own rendered report. Model output that quotes host failure wording no longer changes the `codex-failure classification=` log line.
- Add bounded private review-usage reads and separately authorized canary qualification to the existing maintenance workflow.
- Record token-only review-attempt usage and duration in Analytics Engine through signed direct Worker ingestion, with operator queries for daily token costs and per-repository/lane duration percentiles.
- Prepare review-usage ingestion and weighted queries for unknown cache writes while keeping the existing producer strict until the receiver rollout is qualified.
- Classify one reviewed generated event UUID through exact source and patch witnesses without relaxing secret detection for other UUIDs or event files.
- Simplify repository-scoped PR reference parsing and review comment identity and automation wiring without changing durable markers, close safety, or publication behavior.
- Simplify dashboard rendering and planning activity presentation through shared production imports without changing review selection or report loading.
- Simplify review source identity and close-decision policy wiring while preserving source-change guards and repository-specific close safety.
- Expose the scheduled review budget in the public exact-review queue status: the global and per-lane token balances (negative while organic debt is outstanding), burst, GitHub-throttle pause timestamps, and review shed counts by reason, so operators can see why scheduled backfill is or is not being admitted.
- Fix HTTP 500 on scheduled review intake for pull requests that already have a completed review. The queue now stores the delivery receipt before it records the `review_request_required` answer, so the answer is saved and replayed instead of failing every retry (about 40% of review-plan runs failed since #1997).
- Conflict self-heal's publish-before-dispatch order is now tested by running the script against a local state remote and a stub `gh` that refuses a dispatch whose job is not on the remote, instead of comparing call positions in its source text.
- Stop the scheduled repair self-heal lane from fetching every repository's review records. It never reads them, and since 2026-10-04 every run had failed in setup with `cold_hydration_bound_exceeded` for an unsnapshotted repository. It now hydrates only the Git repair state (jobs and run results) that it uses.
- Recognize the exact table-driven Signal URL-rejection fixture without weakening source-line, path, decoder, or verification checks.
- Give every repository without a canonical record snapshot its first one on the six-hourly snapshot schedule, so a growing unsnapshotted repository no longer fails every fleet-wide hydration past the 2,000-record cold limit, and scope Audit state hydration to its target repository.
- Answer explicit review requests whose deferred publication drifted while another review was already queued for the item: a pending review without a request of its own now takes over the still-current request, and when no queued review can carry it (active, parked, or answering another request) the request ends as superseded instead of staying at "Review in progress".
- Spam scanning sends every unprotected comment of at least 12 characters (or with a link or GitHub minimization) to the model and passes keyword hits as labelled facts; keyword patterns no longer decide which comments the model sees.
- Add a static operator dashboard (`dashboard-site/`): Overview, Throughput, Quality, Queue, Coverage and per-repository pages built from the canonical-record corpus, the public queue and coverage APIs and GitHub Actions history. A workflow rebuilds it every 15 minutes and publishes it to Cloudflare Pages; the record corpus refreshes only on a manual run because the record export loads the queue Durable Object.
- Keep newer dashboard snapshots when an older refresh finishes publishing late.
- Stop issue implementation, cluster repair, autofix, automerge and self-heal admission; retired commands receive a short reply while review, re-review, explain, stop and apply remain available.
- Count encoded text bytes, including embedded NUL characters, in per-table storage estimates so non-ASCII content is not underreported.
- Restore the queue storage report for the current diagnostic response and label sampled content estimates clearly.
- Stream canonical record journal pages into the hydration staging tree instead of retaining every report in memory, preserving snapshot validation, latest-revision selection, cold-hydration limits, and fail-closed publication for large repositories.
- `src/value-coerce.ts` now owns `stringOrUndefined` (any string) and `nonBlankStringOrUndefined` (a string with non-whitespace text, returned unchanged); callers import them instead of taking `stringOrUndefined` through dependency objects, and the two divergent local copies are gone.
- The exact-review heartbeat test now runs the review step's heartbeat with a stub control plane and checks the lease body, an interval well inside the Worker heartbeat grace window, review-group termination on a lost lease, and the EXIT-trap stop, instead of pinning `sleep 60` and shell snippets; the schedule test now checks distinct crons, that every compared schedule is registered, and fleet fanout spacing instead of cron literals and a retired-cron list.
- Move audit runs from `sweep.yml` to `audit.yml`, preserving the six-hour schedules, admission and concurrency; route fanout audits to the dedicated workflow and accept only `target_repo` for manual audits.
- Move the hourly failed-review retry lane from `sweep.yml` to its own `failed-review-retry.yml` workflow with the same schedule, concurrency group, admission gate, permissions, environment and steps; the review-run observer no longer starts a runner for these support-only runs.
- Move normal and hot review planning to `review-plan.yml` (`ClawSweeper Review Plan`), preserving schedules, admission, and planner inputs. Route manual reviews and target fanout there; keep exact-event review and manual/scheduled apply in `sweep.yml`.
- Move scheduled target fanout from `sweep.yml` to `target-fanout.yml`, preserving its schedules, concurrency, admission gate, permissions, environment and steps. Review planning, audit dispatch destinations and apply lanes stay in `sweep.yml`.
- Replace the `test/sweep-workflow.test.ts` boundary tests that read raw workflow and source text: the queue claim, review-only publication, direct-publication lifecycle, state publishers and review target branch now run the real step or CLI, and the token-scope guards read parsed workflow steps.
- Delete `test/sweep-workflow.test.ts` tests that only pinned workflow plumbing, wording, constants and source text, or that other parsed-step and behavior tests already cover.
- Move exact-review claim, reservation and lifecycle response parsing from inline workflow scripts into typed queue CLI owners while preserving lease outcomes and pre-checkout recovery; verify repeat-revision telemetry through executable claim steps for both protocol versions.
- Replace inline batch lifecycle request builders and terminal-run reconciliation scripts with typed exact-review queue commands while preserving request bytes and failure semantics.
- Derive the PR status label from the published Before-merge items, so `status: 👀 ready for maintainer look` appears only when nothing remains before merge; remove the host config/stored-data/SQLite path classifiers and their generic blockers, `Stored data model` section, and SQLite warning, and take the stored-data blocker only from the model's `dataModelCompatibility: insufficient`; route a kept-open superseded PR to a maintainer close-or-keep item and give `Correct the reviewed patch` the review's own reason.
- Reuse timeline pages and legacy inline-comment pagination for complete review context without changing bounded windows or missing-Link fallback behavior.
- Retire ordinary webhook payloads after 30 minutes of item-family inactivity in bounded batches, preserving active collections, unresolved placeholders, source ordering, and deletion tombstones while allowing complete comment repair to restore cache usability.
- Turn on Workers Logs for the `clawsweeper-status` Worker and its Durable Objects (every invocation, 7-day retention), so queue stalls and HTTP 500s can be traced to the request and exception that caused them.
- Serve the operator dashboard at `/` from the Cloudflare Pages site: the Worker proxies the dashboard page paths and assets to `clawsweeper-dashboard.pages.dev` and the old Worker-rendered dashboard HTML (about 3,800 lines) is removed. A new Operations page shows 7 days of hourly review flow, shed offers, waiting work, handoff incidents and close-sweep failures, and the sidebar links to CrabFleet's live terminals. Webhooks, the queue, `/api/*`, Bay and the triage pages are unchanged.
- Retire expired workflow-job coverage in bounded alarm passes and add an optional, bounded logical-content census to queue storage diagnostics.
- Give authors with live `write`, `maintain`, or `admin` repository permission the same priority (fast) Codex service as OWNER/MEMBER/COLLABORATOR authors in review and repair, even when GitHub redacts their association, and run maintainer-only assist answers on priority service.
- Move every ClawSweeper Codex lane in the direct API auth modes to `gpt-6.1-sol` with medium reasoning (maintainer-authored items keep fast service; `clawrouter` mode keeps its private alias) and update the pinned Codex CLI to 0.159.3 with the Responses proxy at 0.159.2.
- Let scheduled normal backfill use the review budget: charge new organic admissions and successors (including reconciled completions) against a 220/hour, 24-burst scheduled budget with bounded organic debt, cap hot intake at 30/hour, and offer `openclaw/openclaw` normal backfill every 20 minutes. Organic work remains unconditional; this is not a total-work cap.
- Requalify OpenClaw's rewritten `src/logging/redact.test.ts` connection-string fixtures for the exact-review input scan, so pull requests touching that file are no longer refused before review; each exact post-rewrite identity may carry the `PLAIN`, `ESCAPED_UNICODE`, or `HTML` label the pinned scanner assigns nondeterministically.
- Report retained stale-revision publication rows as parked (`stale_revision`) instead of ready, so the publication lane no longer advertises a weeks-old ready head that no batch can claim; health keeps age-based severity with `stale_revision_over_1h`/`_over_6h`, and fail-closed command retention and cleanup are unchanged.
- Qualify the exact OpenClaw SDK browser CDP fixtures by their observed native URI identities, complete source lines, and committed path while preserving scanning and changed-input refusal.

- Requalify the unchanged OpenClaw Cron notification redaction fixture for expanded routing/webhook coverage and its canonical review base, preserving complete-source and native-finding checks.

- Stop endless `source_drift_requeue` reviews of PR close proposals: apply no longer treats ClawSweeper's own review-acknowledgement progress edit as source drift when it is the latest item update and the reviewed source, timeline, head, and review-activity receipt still match. Human comments, title/body edits, non-managed label changes, PR reviews, and new heads still block apply and requeue.
- Speed up exact-review target checkouts by restoring an hourly blobless cache that already holds the branch-tip blobs and cloning it locally, keeping at most two target cache entries per branch instead of saving a new ~1 GB entry on every review run; warm checkouts refresh moved/deleted tags and rebuild after branch rewinds, and the pinned Codex source cache is now saved once per Codex version.

- Admit the existing OpenClaw completion-webhook FTP redaction fixture only when its exact native finding and complete committed source bytes match the reviewed qualification, keeping scanning and verification enabled.

- Speed up exact-event publication apply: repeated metadata and comment reads revalidate their already-read body directly with GitHub instead of repeating Worker ETag lookups and confirmations, and each held-lease mutation boundary runs the pull-request review-activity check once; every guard still reads GitHub live.

- Fix `@clawsweeper automerge` and `autofix` command reviews failing with `invalid queue-owned command review lease` before review: when the claimed decision has no source head, the command acknowledgement lease now uses the live PR head from admission or the head in the command status marker, and fails with a clear message only when neither exists.
- Hold automatic reviews after a terminal scanner refusal until a fresh explicit re-review or intentional scanner-policy update, preventing repeated attempts and notifications across sweep, event, and recovery producers. Retire per-run sweep batch/shard and immediate-apply controls in favor of the shared queue and separate apply lane. Thanks @yetval.
- Recover pinned review bases after branch rewrites or deletion within the existing acquisition deadline. Record the failed pin and completeness state, and stop optional evidence work when Git process settlement is unverified.

- Stop pnpm setup at a failed store lookup, preserving its exit status instead of reporting a missing cache path.

- Keep Endor test-repository reviews owned by the automerge loop and preserve current PR command identity through repair follow-ups and source-event supersession. Thanks @jesse-merhi.

- Enforce strict TypeScript checks for the extracted Bay activity, review-status, and observed-failure modules, bringing the dashboard strict ratchet to 52 of 54 modules.

- Defer failed-shard review recovery while an earlier publication is pending, preserving the recovery request and allowing explicit re-reviews and source changes.

- Clarify that automatic implementation builds a fix for an issue. Thanks @jihoon-ernesto and @awhite0030.

- Recognize test-helper directories in stored-data classification so synthetic fixture writes do not request migration proof, while preserving production and rename checks. Thanks @serg0x and @awhite0030.

- Avoid data-model compatibility blockers for static error messages recommending an upgrade outside storage code, while retaining checks for executable upgrades and persistence evidence.

- Qualify the exact Git-source redaction fixture while preserving native verification, literal patch witnesses, and refusal of changed or unrelated input.

- Qualify the exact repeated proxy CLI redaction fixture while preserving native verification, full-line witnesses, and occurrence counts.

- Qualify the exact Autoreview proxy fixture under BASE64 labeling only when its approved literal source witnesses match.

- Qualify exact historical acpx Autoreview URI test fixtures by native digests, ordered line witnesses, and committed source path while preserving verification and rejection of unreviewed findings.

- Preserve worker results and Git cleanup on macOS when a process group contains only owned zombies, while retaining live-process permission errors and settlement deadlines.

- Isolate documentation-test build output so concurrent publication proofs can copy the compiled runtime without losing files.

- Explain missing local review checkouts without a stack trace after Git source preparation, preserving the existing command error guidance.

- Keep targeted apply and comments-only sync from starting broad review backstops; preserve backstops for automatic close-mode apply.

- Retain oversized PR proposals as explicit policy no-ops when close or comment-only gates prevent publication, without retrying the same review or claiming a GitHub comment was delivered.

- Recover longer review source fetches through bounded Git acquisition, preserving fresh branch checks and verified-object reuse. Settle interrupted Git processes before retry and retain uncertain workspaces for recovery.

- Stop memory prompt and tool contracts from triggering stored-data compatibility holds on incomplete patches while preserving conservative checks for other memory persistence owners. Thanks @LLagoon3.

- Reduce retained-lifecycle Bay refresh CPU by skipping repeated sample sorting for older cards while preserving full-history validation, counts, and ordering.

- Preserve app-server turn failures so capacity errors remain retryable and unavailable models remain terminal instead of surfacing a missing result file. Thanks @Yigtwxx.

- Restore OpenClaw Bay live status when reviews are parked for incompatible sources or unknown reasons; preserve the validated queue contract across cached reads, and polish the shoreline header, filters, and lane labels.

- Keep scheduled and manual review intake independent of aggregate telemetry failures while preserving signed admission, pacing, replay, and publication-policy checks. Require signed capability proof in exact-revision deployment smoke checks before rolling out the new producers.

- Admit canonical Git-metadata false positives for modified executable files without weakening source-content or supplemental-scan checks.

- Reuse the command acknowledgement as the active review status so exact re-reviews no longer post a second temporary comment.

- Stop scheduled sweeps from repeatedly preparing an unchanged PR with an incompatible pinned Codex version, while preserving source-change recovery and explicit maintainer re-review.

- Avoid migration-proof blockers for newly captured in-memory `statePath` routing while preserving existing path edits, file-read, persisted-format, and incomplete-storage checks.

- Route maintainer-authored issues and pull requests to GPT-6 Sol with high reasoning and fast service while other items use medium reasoning and standard service, retiring the legacy per-run profile overrides.

- Qualify the relocated Gateway config CDP-redaction fixture by its exact old and new source lines while preserving complete input scanning and changed-input refusal.

- Move ClawSweeper review and fix lanes to GPT-6 Sol with high reasoning and fast service, and refresh the hosted Codex tools to the latest green main snapshot.

- Admit generated Git object metadata findings in raw diffs only after canonical source witnesses and a complete supplemental scan, including added and deleted files, while preserving all primary source scanning.

- Keep re-review acknowledgements owned by the durable queue so a delayed recovery router cannot overwrite a completed or failed status.

- Qualify three synthetic OpenClaw model-egress URI fixtures by exact native identities, complete source lines, and committed paths while preserving input scanning and refusal controls.

- Bound pinned Codex source fetches at their shared setup owner, stopping native Git and transport descendants while preserving retry classification and Git low-speed settings. Thanks @SebTardif.

- Stop POSIX Codex descendants when their leader exits naturally, including descendants holding output pipes, without turning clean exits into review timeouts. Thanks @SebTardif.

- Reduce publication backlog churn with shared inline-comment reads, bounded source-fetch retries that reuse verified Git objects, transient scanner-download retries, page-bounded dead-letter membership reads, and two isolated preparation workers per batch.

- Stop publication metadata and comment reads from repeatedly probing exhausted GitHub credentials within a batch; preserve scoped fallback and resume fresh reads at the recorded reset.

- Bound conflict self-heal, failed-run self-heal, and issue-implementation workflow dispatches with the existing GitHub CLI deadline. Thanks @SebTardif.

- Qualify the existing Crabbox Azure endpoint-rejection fixture by exact native URI identity and committed source witnesses while retaining full input scanning and refusal controls.

- Qualify six existing Crabbox scope and redaction fixtures by exact URI identities, complete ordered source lines, and committed source references while retaining full input scanning.

- Show an explicit no-op label plan when the publisher confirms unchanged labels, without inferring confirmation from report metadata. Thanks @saariuslystoned.

- Reduce CI review/publication REST calls by hydrating comment threads once per read generation and deriving prompt windows locally, while preserving fresh mutation guards.

- Retry transient terminal-review telemetry publication failures with the same signed run identity, preserving bounded deadlines and duplicate suppression.

- Qualify the existing Gateway question URL-rejection fixture by exact native identities, complete source line, and original test path while preserving full input scanning.

- Keep passive review-run telemetry writes independent of queue size by removing the retired per-item reconciliation alarm scan.

- Share artifact-cache cleanup across overlapping publication requests to avoid duplicate R2 scans and cursor writes.

- Retry timed-out review blob fetches through the existing bounded source-preparation recovery instead of permanently rejecting the unchanged review as a scanner refusal.

- Preserve approved URI provenance when scanner replay masks Git object IDs, while keeping the replay byte and source-identity checks intact. Thanks @vincentkoc.

- Defer automatic Endor reviews until the existing automerge enrollment is ready, preserving explicit requests and holds and finishing skipped review lifecycles as policy no-ops. Thanks @jesse-merhi.

- Use Codex's explicit stored-data compatibility assessment instead of English proof-matching rules; retain compatibility holds for unassessed historical reports and preserve independent proof gates. Thanks @fuller-stack-dev.

- Bound scheduled target-fanout GitHub CLI calls with the existing shared timeout, preserving explicit audit-wave deadlines. Thanks @SebTardif.

- Strip inherited process-local Git configuration from review and repair model environments while preserving Git isolation and repair identity. Thanks @saariuslystoned.

- Finish Codex worker process-group cleanup after repeated cancellation, early child exit, or app-server turn completion, preventing orphaned descendants. Thanks @Yigtwxx.

- Use plain language for issue follow-up and preserve Codex's requested next action without inventing generic reproduction checklists. Thanks @PollyBot13.

- Redact private model identifiers from spam-scanner errors before publishing logs, audit records, reports, and ledger entries. Thanks @Yigtwxx.

- Raise the worker budget to 128, exact-review capacity to 80 with 64 reviews per repository, and scheduled concurrency to 32 while retaining scheduled intake pacing, publication headroom, and the separate imported-cluster cap.

- fix(dashboard): report bounded status diagnostics when the deployment smoke rejects the Bay contract, while preserving its failure gate.

- Stop superseded review workers from repeatedly posting start comments, and reuse the same worker's active comment when queue checks temporarily fail.

- Qualify the approved TypeSafe local URL-rejection fixture using its exact native identity and source line while retaining complete input scanning.

- Keep POSIX synthetic GitHub CLI fixtures out of inherited Node coverage so interrupted fixture shutdown cannot corrupt the coverage report; real ClawSweeper subprocesses remain covered.

- Keep explicitly accepted PR tradeoffs visible as evidence without asking maintainers to resolve them again, while retaining blockers for unresolved or changed risks.

- Qualify the existing OpenClaw browser CDP discovery fixture using exact native identities, its complete source line, and committed source references while preserving scanner enforcement.

- Avoid migration-proof blockers when Node Console stream routing shares a patch hunk with unchanged storage, while retaining gates for real stored-field and persistence changes.

- Qualify the exact OpenClaw Gateway readiness privacy-test fixture using observed native URI identities and its complete source-line witness, without changing scanner enforcement.

- Qualify the existing OpenClaw question URL-rejection fixture using exact native identities, the complete source-line witness, and its original test path without weakening input scanning.

- Qualify reviewed autoreview hardening URI fixtures at both canonical and mirrored source paths using exact native identities and complete source-line witnesses.

- Avoid migration-proof blockers for plain source-file reads while retaining gates for persisted readers, storage writes, and schema changes.

- Qualify the existing marketplace entries telemetry fixture using both exact source-line witnesses while preserving the refresh fixture’s separate approval.

- Restore adaptive publication capacity from newly accepted batch publications after cooldown, while preserving quota backoff and replay safety.

- Classify the reviewed Git-remote rejection and scanner-proof fixtures using exact native detector, decoder, source-line, and regular-file attribution.

- Classify generated Git blob IDs mistaken for Cloudflare credentials only after complete source witnesses and an independent native patch replay rule out decoded content matches, while keeping verified or incomplete scans blocked.

- Let exact-review admission use the existing one-shot scoped read-token fallback when the public Actions quota is exhausted, while preserving private-repository access and retry behavior.

- Avoid migration-proof blockers for read-only doctor dispatch changes while retaining doctor warnings under persistence owners and beside same-hunk storage evidence.

- Allow reviewed browser configuration URL fixtures through input scanning with exact occurrence witnesses, preserving native explicit-default-port metadata and rejection of changed or unrelated input.

- Admit approved synthetic URI fixtures in unchanged patch context only with exact before/after Git source witnesses, and qualify the existing OpenClaw create-profile redaction fixture without hiding raw scan input.

- Keep standalone notification commands alive during transient hook retry backoff so they finish retries and write their report instead of silently exiting successfully.

- Run full repair acceptance in the executor instead of duplicating it in edit workers, and derive the overall repair budget from validation allowances with a hard ceiling and report headroom.

- Preserve bounded native Git diagnostics when a source-blob fetch exhausts the hydration deadline, without changing the terminal refusal or exposing scanner output.

- Give OpenClaw's combined changed-gate command 25 minutes so lint can finish after its long core-test typecheck, and log successful typecheck/lint stage timings, while retaining the eight-minute default elsewhere and the overall repair deadline.

- Keep PR source hydration's GitHub metadata requests, retries, and rate-limit checks within its existing deadline.

- Keep confirmed validation timeouts primary when the subsequent checkout identity proof is inconclusive, retaining both errors and blocking reuse until recovery.

- Report confirmed validation timeouts after reaping command trees and cleaning newly generated ownership locks.

- Admit the existing OpenClaw browser CDP proxy and target fixtures through exact URI, source-line, decoder, and source-path bindings so unrelated test imports do not block exact review.

- Recognize the existing approved browser documentation fixture after its page split, preserving exact-value and source-path restrictions.

- Keep repair-result publication within its job budget by hydrating only the operational Git state it consumes, without loading unrelated canonical review records.

- Bound dashboard status collection to 18 seconds so stalled dependencies show unavailable freshness and the next Dashboard or Bay poll can recover; retain complete snapshots without persisting timeout results or blocking later writes, and avoid showing a synthetic age when freshness is unavailable.

- Wait for the exact-review queue to become available before declaring a dashboard deployment ready, while retaining the deployment deadline and all smoke checks.

- Fix OpenClaw Bay refusing to load inside the Team dashboard while continuing to block embedding by other sites.

- Keep webhook receipt validation deterministic when fixed test timestamps pass their 30-day retention window.
- Refresh Markdown rendering and Wrangler patches, Node 24.21.0 repair runners and E2E images, Bun 1.4.2, and the OpenClaw 2026.9.4 runner while preserving the 48-hour dependency release window.

**Highlights:** Preserve later review evidence, reject forged report findings, bound stalled repair calls, and recheck paired-close eligibility before mutations.

### Removed

- Deleted the separate live-proof dispatch/execute/attach workflow and its composite dispatcher; live verification now stays inside the review artifact lifecycle.
- Deleted the retired append-window compactor end to end: the `state-materializer.yml` workflow (a runner every 20 minutes to drain zero rows), its drain module, and the producer-free `/internal/state/{append,drain,ack,dispose}` Worker endpoints plus the five `state_append_*` Durable Object tables, which are dropped on upgrade.
- Deleted the commit-review lane (`commit-review.yml`, the hosted commit sweeper CLI commands, classifier/check publishing, and the `repair-commit-finding-intake.yml` intake) after zero successful runs in its final 20 attempts; the offline `pnpm local-review` engine and existing `commit_finding` repair jobs remain.
- Deleted the crawl-remote production deployment system (`deploy-crawl-remote.yml`, its pinned Wrangler toolchain, and CI integration job) after three runs ever with no success.
- Deleted the dormant `repair-finalize-open-prs.yml` dispatch workflow (last success April 29); the finalizer report module stays because `repair-publish-results.yml` still writes it after every worker-result publish.
- Deleted the proof-nudge lane (`proof-nudges.yml`, the `proof-nudges`/`bot-proof` CLI commands, and their eligibility/rendering policy); historical proof-nudge comment markers still count as dated proof requests in the stalled-unproven close policy.
- Deleted the monthly `state-compaction.yml` history rewrite of `openclaw/clawsweeper-state`, removing one of the last writers ahead of that repository's retirement.

### Changed

- Attribute GitHub CLI throttles to the credential used by the failed request, preserving one-shot public-read recovery and the original command diagnostics.

- Restore OpenClaw changed-gate receipts, caches, and disposable outputs for strict `pnpm run`, selector, and environment-prefixed commands without granting root artifact exemptions to workspace scripts.

- Automatically enroll eligible Endor Pro PRs in the dedicated test repository’s autofix loop while retaining human merge and proof-approval gates. Thanks @jesse-merhi.

- Keep Codex turn state updates in order so a slow `active` write cannot overwrite `validating` after completion; stop late heartbeats and abort queued telemetry when the worker exits.

- Refresh pnpm to 12.4.1 and Wrangler to 4.131.0, pin setup-node v7, share workflow setup, and expose a test-concurrency environment override while preserving the adaptive CI default, full suite, coverage gates, Node 24 floor, and 48-hour release-age policy.

- Prepare the target's reviewed Knip helper for selected OpenClaw changed-gate scans, including current TypeScript runners and native pnpm 12 cache keys. Restore its offline cache between attempts without weakening frozen dependency or release-age checks.
- Refresh the hosted review tools to Codex and its Responses proxy 0.154.0, OpenClaw 2026.9.3, and checksum-pinned TruffleHog 3.97.4; use the qualified managed scanner when an older release remains on PATH.
- Compatibility: the optional OpenClaw runner now requires Node 24.16+ within Node 24 (or Node 26.1+), matching its upstream CLI requirement; hosted workflows already install the latest Node 24. ClawSweeper's own Node floor is unchanged.
- Preserve the original validation failure or timeout when a checkout identity rejection also occurs, keeping protected-input and publication gates intact.
- Retain blocked execution reports and recovery requests when a validation-fix worker times out or exits without diagnostics, while preserving failed validation and publication gates.
- Fetch and materialize the pinned commit before creating or resuming replacement repair branches, preserving dirty-checkout and concurrent-head safeguards.
- Keep dashboard publication counts and time windows through refresh and cached reload, preserving explicit zeroes and incomplete data; thanks @vincentkoc.
- Preserve PR versus issue identity and retained source provenance in failed-shard recovery; thanks @yetval.
- Extend strict TypeScript checks over review-failure telemetry and source/storage helpers without changing their runtime behavior.
- Restore Vite config scratch after OpenClaw changed-gate validation so a successful cold run does not fail checkout identity checks; preserve cache and disposable-output permissions under restrictive umasks and cross-device moves without weakening unrelated runtime-input protection.

- Refresh Node 24 type definitions, the Oxc lint/format toolchain, and immutable checkout pins to v7.0.1 while retaining the 48-hour release-age policy and Node 24 minimum.

- Isolate the GitHub ETag cache in repository-sharded Durable Objects so cache reads and writes no longer compete with exact-review admission, claims, or webhooks.

- Refresh durable review freshness after unchanged exact-head re-reviews while preserving idempotent publication retries, and record bounded activity-cursor diagnostics for drift-blocked publication.

- Preserve bounded, recognized command-intake HTTP failure codes in review-request diagnostics without exposing raw responses or changing retry behavior.

- Refresh markdown-it to 15.0.1 and Playwright to 1.63.0, retaining the repository's release-age policy and Node 24 runtime floor.

- Recover failed aggregate review shards only from recognized retryable item terminals in the complete exact-attempt ledger. Keep completed, nonretryable, uncertain, and unstarted items out of recovery, and retain identity- and digest-verified completed reports for normal guarded publication.

- Move optional aggregate review-ledger uploads out of the target publisher lock into a bounded artifact-backed job, preserving producer artifacts and required record/comment receipts when telemetry is slow or unavailable.

- Give Codex reviewers the existing short-lived, read-only target-repository GitHub App token as `GH_TOKEN` for authenticated reads, and describe token availability from the actual reviewer environment, including OpenClaw's credential filter.
- Give hosted issue/PR reviewers allowlisted public research access through a managed proxy while keeping the checkout read-only; describe token, blocked-host, and downloaded-media capabilities accurately and fail setup when sandbox enforcement regresses.
- Describe review capabilities from the active runner so OpenClaw gateway execution is not mistaken for the Codex allowlisted sandbox; prove Linux review sandbox enforcement in credential-free PR CI.
- Made persistent local review output opt-in: ordinary local reviews now use
  private transient scratch by default, explicit summary/debug modes retain
  bounded output, and hosted review refuses before execution unless its required
  artifact route explicitly selects debug retention. Required PR checkouts now
  use a separately admitted private workspace with conservative Git metadata
  sizing and unbounded filter refusal, and media producers share run-owned byte
  and file allowances before writing. Existing debug destinations, metadata,
  cached and fresh reports, and bounded failure diagnostics use the same output
  admission owner. These limits bound retained managed output, not arbitrary
  model writes or peak child-process disk use. Managed local sources stay checkout-free until the
  admitted exact-head materializer runs, Git 2.39-compatible attribute checks
  use a bounded private index, and non-debug batches prune each item's engine
  files after ledger evidence is hashed. Ordinary and caught-failure cleanup remains automatic;
  operating-system signals keep default termination semantics and may leave
  bounded private scratch. Checkout and Git object-store capacity are admitted
  separately unless both destinations share a filesystem. Bounded Git reads
  ignore unconsumed wrapper diagnostics while continuing to cap stdout.
- Add reviewed-plan retirement of one merged-target publication through the existing maintenance workflow, keeping signing credentials confined to its execution step.
- Admit the two approved Signal URL-rejection fixtures through exact URI, source-line, path, and native decoder bindings while retaining all scanner and verification checks.
- Admit the reviewed Crabbox PostgreSQL operations example through exact Postgres detector, observed `PLAIN`/`HTML` decoder, value-hash, source-line, path, mode, metadata, and committed base/head bindings.
- Admit the reviewed OpenClaw logging redaction fixtures through exact detector, native decoder, role, value-hash, source-line, path, mode, and metadata bindings while preserving legacy URI fixture behavior.
- Keep canonical OpenClaw locale refresh PRs open across apply and repair close paths so their publisher can reconcile and auto-merge them after normal checks.

- Keep publication reconciliation dry runs from recording terminal lifecycle state or reclaiming expired publication batches.

- Reduce the review ceiling to 32, cap scheduled background reviews at eight, pace scheduled intake at 60 per hour with a six-item burst, and scan normal backlog hourly while retaining manual-review priority and existing leases.
- Honor the configured Codex reasoning effort in sweep planning, event and shard reviews, assist answers, and close-coverage proofs instead of forcing high reasoning; assist uses the shared fast service tier.

- Authenticated publication reconciliation now diagnoses missing, ambiguous, and mismatched successor fences without changing supersede behavior.
- Exact-review maintenance clients now expose and strictly validate successor-fence diagnostics after the Worker-first rollout.
- Redact publication identities in maintenance output with stable row fingerprints and refuse redirects for signed queue requests.
- Explicit manual item reviews now enter the durable exact-review queue independently and retain record/comment-only publication policy through retries, without enabling labels, closes, routing, or issue implementation. Restricted comment and canonical publication require the actual current producer or batch owner; retained receipts cannot revive stale authority. Repeated authorized requests remain publishable after earlier completion, and absent new reports cannot borrow hydrated review authority. Isolated proof status and deployment limits are recorded in `docs/proof/manual-review-publication/README.md`.

- Resolve publication completion to the exact producer journey in lifecycle audit and OpenClaw Bay through immutable lineage in existing JSON, preserving independent receipt revisions and preventing duplicate completion telemetry.
- Keep lineage-aware Bay reads indexed by repository and identity, without sorting retained projection JSON.
- Preserve explicit manual reviews' selected branch, requested timeout, and one-off instructions through admission and ordinary-event coalescing, while accepting fresh source facts and option changes from a new manual request; the existing exact-review timeout cap remains unchanged.
- Keep exact-review imports and snapshot validation in the selected publication workspace when invoked from a separate code checkout.
- Preserve temporary publication-authority outages as coordinator retries instead of exhausting the shorter unknown-failure budget; ownership rejection remains fail-closed and separate from GitHub throttling.
- Publication reconciliation diagnostics now report the exact acknowledgement-unavailable reason while preserving fail-closed supersede behavior.

- Admit the reviewed mocked marketplace telemetry-redaction and Gateway config CDP-redaction fixtures through exact URI, source-line, path, and decoder bindings without relaxing native scanner checks.

- Preserve legacy review lease completions without lifecycle admission rows and reschedule queue alarms even when a lifecycle update fails.

- Reduce cold Bay snapshot work by reading full projections through the existing parser, preserving the 30-second TTL memo and edge cache.

- Keep queue stats fresh when alarm or auxiliary-state writes overlap a memo computation, without changing the cache TTL or response fields.

- Admit the reviewed OpenClaw MCP Apps sandbox-origin test fixture using exact URI, source-line, path, and decoder bindings so config reviews can proceed through the existing scanner rules.

- Retain only Cloudflare failure flags in queue transport logs so backend faults can be diagnosed without exposing exception details.

- Hydrate review blobs from cached PR snapshots that store an absent previous filename as `null`, preventing repeat reviews from refusing otherwise available source.

- Preserve Codex keep-open verdicts during publication instead of treating related PR links as independent supersession decisions.

- Let Codex own transport recovery within one review process; the durable queue owns fresh attempts. Batch publication now loads only reviewed item tuples and syncs their comments directly, removing full-repository hydration, source Git pulls, and a second comment-sync dispatch.

- OpenClaw PR reviews now count explicitly named test support as Tests and exclude test-role files from config-surface warnings while preserving contributor-proof and storage gates.
- Review continuity now carries bounded prior rank-up items and explicit context coverage so intentionally filtered self-comments do not recursively become new merge warnings, while preserving concrete blockers and existing review gates.
- Proof-review guidance now maps changed source behavior to exercised scenarios and observed results, and historical Live Verification PASS comments clarify their declared scenario and assertion scope.
- Reviewer input now retains bounded late proof/trace excerpts with explicit body coverage and treats PR patches as reviewer-only media inputs, without increasing the body budget, adding media fetches, or weakening proof requirements; OpenClaw Bay is unaffected.
- PR reviews now separate introduced changes from main-only drift, verify test-merge parents, and avoid stored-data warnings for ordinary Markdown prose beside source.
- Review and repair fetches preserve the target branch ref when Git pruning is enabled.
- Default close-mode apply runs now requeue up to five exact re-reviews for records whose close was blocked by source drift or an unverified-checkout review, so stale backlog records converge to closeable instead of being skipped by every cursor sweep.
- Live verification now publishes a sanitized, capped dev-server log tail when browser startup fails, and detects a start command that exits before its URL becomes reachable without waiting for the readiness timeout.
- Live verification now installs a missing target package manager on demand after execution is approved, publishes installer failures as verification results, and guides plans toward stable assertions the run can satisfy.
- Live verification now runs immediately after review in the same job and exact reviewed checkout; review judgment gates execution, target children receive a denylist-and-heuristic-sanitized environment, package installs suppress lifecycle scripts unless a repository explicitly opts in, and review jobs default to `ubuntu-latest` without requiring Linux namespaces. Existing publication jobs still validate and upload media before publishing the normal record and comment.
- Live verification comments now keep terminal captures but render browser proof as sanitized per-step outcomes with explicit failure reasons, never document-wide page text or empty assertion sections.
- Live verification now runs real PR behavior by default, publishes bounded command output and assertion results even without video, and treats recordings as optional presentation.
- Browser live proofs treat scroll-into-view as best effort so continuously animated targets stay clickable.
- Live-proof recordings can now be retracted through a trusted manual workflow dispatch without rerunning target code or requiring an artifact, manifest, or matching head SHA.
- Live-proof recordings now wait for post-action command or page expectations, hold the final state on screen, and attach only when an initially absent expectation proves a semantic change.
- Live-proof recording retraction now uses a small trusted maintenance workflow that preserves the review plan and verification result while synchronizing the canonical record and public comment.
- Short live-proof recordings fall back to a single poster frame when the contact-sheet tile cannot emit one.
- Terminal recorders flush WebM packets immediately and treat a live ffmpeg session as healthy while the muxer buffers.
- Terminal live-proof recordings tune VP9 for realtime capture and accept the recorder once any payload is written, matching the encoder's bursty muxer output.
- OpenClaw browser live proofs run against the repository's mock control-UI dev server.
- Folder reconciliation now defers with a zero-mutation result when the open-state scan hits GitHub rate limiting, so throttled proof/apply/publish runs proceed to their close and publication work instead of failing before `Apply close proposals` can run.
- Comment-only sync now defers its remaining batch as a runtime-budget-style yield when GitHub rate limits a live read, instead of failing the scheduled run; the next 15-minute cycle resumes the interrupted item, and close-mode apply keeps its loud failure.
- Close-mode apply now takes the same rate-limit yield as comment sync: a throttled live read mid-scan defers the remaining window to the next cycle instead of failing the run, after production runs kept losing 600-record scan windows to mid-run 403s.
- Increased the AWS Crabbox root volume from 160 GB to 400 GB so trusted checks can provision with the repository's current dependency and build footprint.
- GitHub-throttled terminal status updates no longer fail the finalization run; the requeue step already re-arms the acknowledgement for after the rate window.

- GitHub-throttled live-item checks now release the review claim for a delayed retry instead of failing the run and spending failure budget.
- Event-review artifact publication completes as a superseded no-op when the reviewed branch vanished upstream (force-push or deletion) instead of failing the run.
- Worker record requests now retry transient blank/invalid 2xx bodies from the edge within the bounded budget instead of failing hydration on the first occurrence.
- Exact reviews of items that closed after enqueue now complete as superseded no-ops, and GitHub-throttled reservations defer as held retries — neither spends the item's review-failure budget.
- Trimmed the exact-review feed rate from 600/h to 450/h after the resumed apply and comment-sync lanes pushed the shared GitHub App installation token into rate-limit 403s.
- Exact reviews whose pull request head moved past the queued authority now complete as superseded no-ops (the newer push owns its own review) instead of failing and burning the item's review-failure budget.
- Close-coverage proof runs now remove their model scratch files (`N-M.model.json`, `N-M.prompt.md`) from the proof artifact tree, which the apply-lane validator was correctly rejecting and failing every apply run.
- Repaired legacy exact-review decisions whose empty branch was shifted to the string `0`, resolved invalid queued branches from the target repository default, and requeued temporary branch-resolution failures without spending the eight-attempt review-failure budget.
- Made scheduled exact reviews immediately ready after fleet admission, automatically retried recoverable parked reviews on a bounded 5/10/20-minute cycle, and exposed backoff/park reason counts in queue status and the dashboard.
- Aligned normal fanout and planner priority with the dashboard's canonical tuple coverage identities, so legacy backfill reports no longer hide untracked open items behind canonical re-reviews.
- Sized scheduled candidate batches from live free review capacity, apportioned fleet fanout by untracked backlog while retaining round-robin fairness, and skipped empty repositories before both normal and hot fanout so a dominant backlog can fill idle review slots without starving smaller targets.
- Isolated review admission, pressure, and backpressure accounting from the publication lane so stale publication work cannot throttle review throughput, made top-level queue health review-specific, and added durable shed counters by reason.
- Made exact-review reservation races and mid-generation supersession successful no-ops with bounded jittered retries, surfaced provider throttling separately from content/output failures, prioritized never-reviewed open items before oldest-reviewed canonical refreshes, and based dashboard coverage on signed live open-item inventory with explicit expired, untracked, protected, and unmanaged cohorts.
- Routed scheduled review through the durable exact-review queue, raised each target plan from one to 50 candidates, and added oldest-age funnel telemetry plus a fleet-wide 600-review/hour admission budget with duplicate, backlog, and lease-safe backpressure.
- Scoped per-target canonical record hydration to the selected repository and skipped unused ledger/assets downloads in workflow lanes, preventing exact-item review publication from collapsing under concurrent full-fleet state setup.
- Doubled exact-review admission to 128 global and 120 per target with a separate 194-slot Actions budget that preserves verdict publication at full review load, doubled scheduled fleet review fanout and canonical publication batch preparation, prioritized six-day oldest-review coverage before hot-item churn, exposed a six-hour fleet coverage summary, and raised automatic apply to 40 closes with proportional scan/runtime budgets without changing close eligibility.
- Completed the Cloudflare-canonical state migration: records publish only to the Durable Object, action ledgers and assets publish only to R2, canonical-only workflows no longer check out `clawsweeper-state`, the former materializer only compacts the legacy append window, and the remaining `jobs`/`results`/`notifications`/apply-report Git writers use the Durable Object coordinator without Git lease refs or rebuild recovery.
- Generated live-proof plans now receive the effective cold-checkout setup contract and guidance to supply missing build or code-generation prerequisites before dependent commands.

### Fixed

- Accept sufficient recorded upgrade proof without treating serialized contributor-action metadata as a compatibility blocker; preserve missing-proof and override safeguards. Thanks @roboclaw-bot for the report and @goutamadwant for the fix.

- Prevent label sweeps from reactivating autofix after a ready review handler completes it in the same router run.
- Keep OpenClaw Bay controls compact and show more sampled cards in crowded lanes while preserving readable labels, focus, and observer-only navigation. Thanks @brokemac79.
- Restore OpenClaw boundary receipts with changed-gate outputs, and preserve recovery state instead of retrying validation whose completion cannot be verified.
- Keep comment and automerge timeline previews within their requested character limits, including the ellipsis and tiny caps.

- Keep quoted rating-list labels and evidence/owner fields from replacing structured rank-up moves, evidence links, or attribution when durable reports are parsed again; thanks @Yigtwxx.
- Stop the OpenClaw child process group when its worker is interrupted, including signal-ignoring descendants; thanks @Yigtwxx.
- Retry replay-safe lifecycle receipts and terminal dispositions after transient queue failures while preserving newer requeues and leaving publication enqueue single-attempt.
- Restore scheduled cluster intake after the snapshot materializer update by refreshing its reviewed digest and verifying bounded expansion before import.

- Retry the pinned control-plane helper download on TLS and connection errors so a single handshake failure no longer drops an exact-review event before enqueue.
- Keep large repository reviews within the GitHub CLI response limit by projecting recursive-tree metadata before capture, preserving complete blob sizes and strict private-checkout admission.

- Carry the durable review lease through oversized PR close proposals so direct exact publication can close eligible PRs; queued fallback still keeps PRs open with `skipped_changed_since_review` after lease expiry, pending the follow-up to create the final metadata proposal under publication ownership and re-evaluation at the next event or head.

- Accept the exact-event PR admission handoff for mixed-case target repositories such as fallback-profile repos, whose profile slug is lowercased; the strict repo comparison failed every review of such pull requests after the oversized-PR policy landed.
- Recheck current close policies and known same-author counterparts before close mutations, keeping the parent open when a counterpart locks, reopens, or cannot be refreshed; thanks @vincentkoc.
- Bound cluster dispatch and target cloning with operator-configured deadlines, useful timeout errors, and clone process-tree cleanup; thanks @SebTardif.
- Bound cluster-selector model and GitHub requests through response completion, failing without new selection output on stalled transports; thanks @SebTardif.
- Show later PR review revisions beside the freshness timestamp while preserving same-review resyncs and lifetime history counts; thanks @elijahfriedman.
- Prevent quoted finding and security-concern prose from adding findings or replacing confidence when durable reviews are parsed again; thanks @Yigtwxx.
- Preserve later discussion evidence and invalidate cached reviews when omitted inline-comment text changes instead of silently dropping comment tails; thanks @TommyLei666.
- Mask credentialed URLs in supplementary review context and ignore foreign timeline issue numbers; thanks @yetval.
- Bound app-server CrabFleet status updates so a stalled endpoint cannot block the review turn indefinitely; thanks @Yigtwxx.
- Accept direct local `.sh` validation through shared guarded Bash normalization for command strings and resolved arguments; thanks @Jhacarreiro.
- Complete exact-review leases during Worker/workflow deploy skew by retrying rejected terminal reasons once without the reason/status, preserving diagnostics and warning operators.

- Stop exact-review retries for every non-retryable scanner refusal, including scan deadlines, and retain terminal guidance for the unchanged revision.
- Retry transient control-plane failures across exact-review workflow calls, preserve retryable admission 503 responses and Retry-After headers through webhook/internal ingress, and attribute failed fences and reservations to queue infrastructure. Bootstrap pre-checkout helpers with commit-pinned downloads so later full checkouts retain local setup actions, and keep lease cleanup working when checkout is skipped or fails.

- Prepare GitHub user-attachment and legacy repository asset proof locally, resolving image/video types after download and reserving bounded preprocessing time for attachments.

- Avoid stored-data warnings for validation-only schema helpers by separating ambiguous schema filenames from explicit storage owners, while preserving database operations and incomplete-patch warnings on storage paths.
- Stop transient JSON diagnostics and SQLite helper filenames from creating false stored-data and migration-proof blockers, while retaining compatibility gates for real persistence owners and stored-shape changes.
- Scoped unchanged SQLite table context to the changed column's diff hunk and stopped treating runtime property values as schema declarations.
- Align generated evidence commands with the parser's single-line contract so multiline proof commands remain in evidence detail instead of failing completed reviews.
- Retire stale comment-router reports before each invocation so early GitHub throttles do not claim prior commands or fail empty action-ledger finalization.

- Keep GitHub request deadlines active through response-body reads so stalled responses cannot hold queue operations indefinitely, while preserving HTTP and rate-limit classification.

- Accept compressed Gitcrawl store snapshots in cluster intake and treat empty portable cluster tables as a successful empty import.
- Terminalize stale command publications after batch expiry without losing shared acknowledgement obligations; thanks @vincentkoc.
- Bound GitHub activity hook prompts to one received event and filtered trusted self-authored review chatter before model intake.
- Replay durable scheduled enqueue dispositions after transient response loss while preserving signed delivery identity, rejecting mismatched bytes, failing closed on legacy ambiguous receipts, and leaving publication post-effects single-attempt.
- Report completed notification delivery, suppression, failure, and unknown acknowledgements; keep inconclusive attempts retryable and preserve legacy admission deduplication. Thanks @vincentkoc.
- Use the producer Actions run URL in failed-review retry receipts so ledger validation no longer prevents dispatch and fails the retry command.
- Preserve canonical repository slugs when reading persisted apply records, including dots, underscores, and repeated or trailing hyphens.
- Make timeout tests tolerate loaded macOS hosts by isolating checkout timing, synchronizing lock contention, and budgeting snapshot admission fixtures separately from deadline tests.
- Preserve a valid stale Bay lifecycle snapshot when a background refresh is unavailable or malformed, without extending its original 60-second expiry.
- Preserve explicit contributor credits in source-PR link comments for both direct replacements and fallback publication after a blocked fork push.

- Reject parent-directory validation symlinks, preserve porcelain paths when selecting repair checks, retain the fast-rebase base SHA for replacement publication, and mark omitted PR comments in close-coverage proof.
- Run dashboard smoke checks through symlinks and continue dead-letter recovery after a repository without an App installation.

- Count oversized ETag responses as durable cache skips using size-only store requests, preserving telemetry without sending or storing the response bodies.

- Bound standalone webhook bodies to 2 MiB before signature verification, preserving chunked deliveries and flushing rejection responses before closing oversized requests. Thanks @SebTardif.
- Preserve committed lifecycle outcomes when later queue completions disagree, preventing terminal-state conflicts from failing completion callbacks and acknowledgement drivers.
- Retain numeric queue failure source locations inside the Durable Object before remote transport discards the original stack, without logging private error text.
- Bound shared repair GitHub CLI calls with native process deadlines and honor per-call timeout settings. Thanks @SebTardif.
- Bound standalone webhook GitHub requests to 15 seconds, including response bodies, so stalled calls return a retryable response. Thanks @SebTardif.
- Kept leading report metadata authoritative through ordinary and fenced body quotes across review, repair intake, workflow selection, and decision packets; shared structural parsing rejects competing records and duplicate packet keys while preserving legacy promotion guards. Thanks @dwin-gharibi for the original report and proposed fix in [#1137](https://github.com/openclaw/clawsweeper/pull/1137).

- Completed obsolete exact-review publications when apply verifies a strictly newer durable review for the same revision, preserving retry behavior for unproven results. Thanks @vincentkoc. (#1249)

- Required the saved lease's accepted or deduplicated receipt for direct-publication requeues, preventing superseded receipts or mutable current decisions from inventing or dropping follow-up reviews.
- Preserved owed source-drift reviews when completion callbacks are lost, and distinguished queue-completion failures from review failures. Thanks @yetval. (#1251)

- Stopped retrying unchanged PR revisions after an incomplete-source scan refusal while preserving newer queued revisions. Thanks @sallyom. (#1311)
- Stopped stored-data and SQLite warnings for colocated test-support files while preserving production persistence, rename, and incomplete-evidence warnings.
- macOS action-ledger locks use stable process identity, treat unavailable observations as unknown, and fail closed for live legacy owners during the version 2 lock transition.
- Aligned PR proof comments and status labels with the existing host requirement when a reviewer records proof as not applicable, while preserving recorded assessments and merge gates.
- Preserved authoritative whole-range Git line counts in local reviews and report rendering, allowing review to complete with unavailable best-effort statistics while requiring complete file enumeration under its prior capture and timeout contract and never showing unknown counts as verified zero totals.
- Classified the explicitly approved autoreview fixture only by its exact full-URI digest and canonical or vendored source path, enforcing the same digest/path/mode policy at every scanned endpoint for all reviewed fixtures while preserving scanner gates and value-free audits.
- Stopped treating pane-local runtime state as stored data while retaining warnings for explicit persistence changes and incomplete storage patches.
- Recover hosted PR reviews that refused `incomplete_source` by fetching reviewed-head history before the bounded base/head fallback, preserving merge-base verification and secret-scanning gates. Thanks @masatohoshino. ([#1308](https://github.com/openclaw/clawsweeper/pull/1308))
- Corrected retained terminal-proof cleanup for independent process-exit and PTY-close events, preserving the original wrapper failure and draining dead-pane capture only after verified cleanup.
- Prevented rejected model inputs from surviving in generated prompt artifacts; retained diagnostics now follow admission with owner-only access, and unused prompt copies are no longer written.
- Provisioned pinned TruffleHog for hosted reviews and enforced complete host-owned input scans before native review or cache reuse, preserving read-only workers, proxy authentication, and redacted fail-closed errors.
- Removed redundant pnpm setup identity work by reusing the verified post-install identity without changing deadlines or mutation guards.
- Guided package-version live proofs toward validated machine-readable output and exact resolution checks instead of guessed terminal formatting, while preserving literal expectations and successful-exit requirements.
- Preserved empty-step live-proof plans through report rendering and inspection, with explicit JSON empty arrays and strict compatibility for existing solitary `- none` reports.
- Added schema constraints and explicit prompt guidance for single-line live-proof commands and nonblank run steps while preserving strict parsing.
- Scoped the `openclaw/openclaw` release-note review restriction to its repository profile so ClawSweeper and other targets follow their own policies without granting release-file edit permission.
- Routed default apply's bounded source-drift refreshes through exact-event queue intake so full-repository hydration cannot fail before admission.
- Indexed webhook receipt expiry by receipt time to avoid scanning and sorting retained history on each accepted delivery, preserving 30-day retention and transactional cleanup.
- Bounded apply/proof/comment-sync record retention to selected records and paired dependencies, avoiding unrelated archive loads during ledger finalization without changing close guards.
- Kept projected GitHub reads out of the durable ETag cache so incompatible response shapes cannot hide requested reviewers from close guards. Thanks @goutamadwant! (#1242)
- Normalized unexpected exact-review failures at the Worker boundary without weakening Durable Object transaction rollback. Thanks @yetval and @vincentkoc! (#1240)
- Terminal live verification waits for finite commands to complete within the existing proof budget before judging output, keeps missing assertions unverified, and preserves usable PTY descriptors for detached child processes.
- Replaced public Worker exception text with endpoint-owned error codes and bounded direct-publication rejection categories, preserving distinct operational fingerprints without exposing submitted values or stack traces.
- Replaced terminal live proof's authenticated `xvfb-run` wrapper with a TCP-disabled local Xvfb display so readiness probes and recording can connect without X authorization failures.
- Made terminal live-proof recording wait for Xvfb and ffmpeg readiness and clean finalization, with tmux pane diagnostics on failure.
- Routed every durable review-record publication lane through one shared, host-authenticated live-proof dispatcher, including queued exact-review batches grouped per target repository.
- Exact-event reviews now dispatch recommended live proofs with host-repository credentials, while generic and configured OpenClaw and steipete profiles opt into browser or terminal proof as appropriate.
- Hosted webhook 🦞👀 receipts now dedupe per pull request across `opened` and `ready_for_review`, so back-to-back webhook actions keep one receipt instead of posting near-identical duplicates. (#1084)
- The target dispatcher no longer double-posts pull request receipt acknowledgements when `opened` and `ready_for_review` fire seconds apart: the ack step now waits and rechecks for any existing marker immediately before posting. (#1083)
- Restored pull request 🦞👀 receipt comments by granting fast-ack tokens `pull_requests: write`. (#1082)
- Scoped GitHub App tokens to their named repositories via the documented `repositories` parameter. (#1082)
- Legacy reports with canonical proof or rating keys outside the apparent leading front-matter block now fail closed, with a read-only workflow to inventory affected canonical records. (#1049)
- Prevented model-authored report prose and body-shaped front matter from spoofing proof or rating sections, keeping unproven external pull requests in human review instead of routing them into automated repair. (#951)

### Added

- Propose closing pull requests above 50,000 changed lines before hydration, scanning, or model review, with a configurable threshold, maintainer size exemption, and live-revalidated gated apply that preserves human-activity freshness and queue supersession.

- Enabled browser live proof for ClawSweeper with a self-contained local OpenClaw Bay launcher and seeded lifecycle/workflow demo data.
- Added an opt-in live-proof lane that records typed browser or terminal plans in a secretless PR-head job, validates and uploads media from a separate trusted job, and attaches only trusted R2 URLs to the durable review comment.
- Status dashboard facelift: an at-a-glance subsystem health strip in the hero (review handoff, work execution, incidents, apply lane, coverage) and a new Fleet Review Coverage section backed by a public `/api/review-coverage` endpoint that summarizes trailing-7-day review coverage per fleet (coverage %, stale/failed/pending counts) from canonical Durable Object item records.
- Cut cluster repair intake over to durable state publication: intake appends an authenticated intent (exact job bytes, digest, store identity, selector report) and hydrates with a read-only non-persisted state credential; result publication mints its target-read token for the validated worker target repositories, projects exact changed state paths, and publisher-rerun failures no longer block subsequent self-heal. Thanks @RomneyDa! (#873)
- Added authenticated Worker blob endpoints (`/internal/state/blobs/*`) that serve the `ledger/v1` and `assets` state trees from R2 with create-only immutable ledger writes, a cursor-resumable `migrate-state-blobs` workflow with digest verification, and an opt-in `CLAWSWEEPER_LEDGER_SOURCE=worker` dual-read in `hydrate-state` (default stays git).

- Durable cluster intake now dispatches through the state materializer with receipt-verified recovery: git ledger/job files stay projection (dispatch requires the HMAC accepted-intent receipt minted at durable acceptance), the dispatch claim is published before the workflow side effect, malformed intake rows dead-letter per row instead of re-failing the drain, and the shell receipt gate matches the observer's successful-planning-job definition. At-least-once workflow creation with exactly-once worker execution intent. Thanks @RomneyDa! (#884)
- Ranked imported repair clusters for landable bugs using conservative historical dedupe, live-state, security, and quality gates. Thanks @RomneyDa! (#881)
- The OpenClaw runner ships a built-in Z.AI provider: `CLAWSWEEPER_OPENCLAW_MODEL=zai/glm-5.2` runs GLM-5.2 on the GLM Coding Plan endpoint with only `ZAI_API_KEY` (validated live end to end).
- The OpenClaw runner ships a built-in Cerebras provider: `CLAWSWEEPER_OPENCLAW_MODEL=cerebras/zai-glm-4.7` needs only `CEREBRAS_API_KEY` (validated live at ~474 tok/s on Cerebras Code Max); provider-key allowlist extended for Cerebras, Z.AI, DeepSeek, and Mistral.
- Redesigned PR review comments into a scan-first layout: outcome and merge readiness up top, ratings and verification as compact tables, before-merge work as native checklists, evidence folded into details — with hardened fence-aware section parsing and Mermaid sanitization. Thanks @Patrick-Erichsen! (#776)
- Screenshot-only real-behavior proof (PNG/JPEG/WebP/GIF) is now hydrated through the bounded media path so sandboxed reviewers can assess it instead of marking it insufficient. Thanks @goutamadwant! (#595)
- The repair owner policy (`CLAWSWEEPER_ALLOWED_OWNER`) accepts a multi-owner list enforced identically at intake and every execution gate; disallowed owners are rejected before a durable job is written. (#809)
- Added a pluggable `CLAWSWEEPER_RUNNER` agent-process seam with Codex as the unchanged default and isolated OpenClaw CLI execution for provider/model fallbacks.

- Added review-time bulk-filer detection, transparent labeling, duplicate scrutiny, fix-lane suppression, and within-bucket scheduling de-prioritization for high-volume issue authors.
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
- Added the default-off, PR-only `author_pr_budget_exceeded` close reason to gradually trim external authors' oldest lowest-signal PRs after live count, inactivity, proof/rating, protected-label, maintainer-engagement, and per-run-cap checks.
- Added default-off `stale_version_bug` and `obsolete_fix_pr` close reasons for genuinely obsolete issues and small fix PRs, with fail-closed live age, activity, engagement, security, popularity, and per-path main-branch verification gates.
- Exposed the oldest pending exact-review item key per lane so operators can identify stuck review and publication work from the public queue status API.
- Added apply-health telemetry and a quiet-by-default dashboard alert for stalled, cursorless, or fully blocked pruning windows. Thanks @brokemac79.
- Added author-wide PR repair intake across configured public repositories, with private and unsupported repositories excluded before job generation. Thanks @Jhacarreiro.
- Added a system, light, and dark theme switcher to the generated documentation site. Thanks @joshka.

### Changed

- Treat apply runtime-budget exhaustion as a successful resumable yield, preserve the safe next-cycle cursor, and stage immutable action events safely from sparse state checkouts.
- The `migrate-state-blobs` workflow uploads with bounded concurrency (default 12, input-configurable) instead of strictly sequential per-file round trips, reports a contiguous-prefix resume cursor that stays valid under out-of-order completion, and backs off adaptively on 429/5xx pressure; three prior runs had hit the job timeout before finishing the ledger tree.
- Bound durable cluster dispatch recovery to a verifiable accepted-intent receipt and strictly validated v2 intake ledgers. Thanks @RomneyDa! (#883)
- Prioritized durable cluster intake without starving sweep, router, proof, or canonical tuple rows during sustained intake. Thanks @RomneyDa! (#882)
- Made every item/closed/plan/decision-packet writer publish an atomic canonical Worker tuple first, leaving the git state tree as materializer-only projection; added bounded canonical projection replay for migration convergence.
- Removed the Claude CLI runtime layer; ClawSweeper is Codex-only.
- Allowed eight isolated exact-review batches to prepare concurrently while
  retaining one fenced state-writer mutation boundary.
- Snapshot exact-review batch clone credentials once before worker fanout so
  parallel preparation no longer drops members during repeated shared-repo
  bootstrap reads, and report any remaining member-specific setup failure.
- Completed tuple-missing stale publication artifacts as superseded in batch
  mode instead of retrying them forever without a mutation outcome.
- Isolated each exact-review batch member's records, action ledger, snapshots,
  and apply reports under its private work root while serializing imports into
  the shared Git object database, preventing parallel publishers from moving
  each other's records or losing prepared mutation blobs.
- Restored the state materializer to GitHub-hosted runners after the dedicated
  runner label left the sole publication drain queued without an eligible
  runner.
- Split exact-item review from Git-backed publication: read-only reviewers now upload hash-bound, 90-day artifacts and enqueue separate durable publication leases before one globally serialized publisher validates, comments, routes, and commits state without rerunning Codex after ordinary publisher failure; handoffs still blocked after 80 days safely fall back to one fresh exact review.
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

- Codex subprocess containment now actually suppresses target `.pnpmfile.cjs` execution: pnpm 11 only honors `npm_config_*` environment settings, so the previously used `PNPM_CONFIG_IGNORE_PNPMFILE` spelling was inert and a target repository's pnpmfile could run arbitrary code during repair installs.
- Reconcile observers now start only for review titles they can classify, so queue-backed `Review exact item` and support runs no longer consume runner slots merely to report `skipped`; a new hourly janitor also cancels runs stuck in `queued` for over 24 hours before they decay into uncancellable zombies.
- Deployment runs waiting for human approval no longer count as runner-queue congestion in operational health: a forgotten approval gate had pinned `oldest_queued_minutes` at eight-plus days and held work-execution status away from healthy; approval-gated runs now report separately (count and oldest age) in the API and the execution alert.
- Terminal command acknowledgements whose status comment was deleted (or never existed) now complete as a durable `missing_status_comment` skip instead of requeueing the finalization driver forever every ~20 minutes.
- Apply and comment-sync publications now recover from canonical record tuple 409 conflicts instead of crashing mid-checkpoint: an equivalent concurrent write is absorbed, an unrelated-section race is rebased onto CURRENT with a single deterministic retry, and a same-section race skips just that item while the rest of the run continues.
- Prevented weekly coverage from endlessly refreshing tracked records while never-reviewed live items remained invisible behind a full candidate batch; normal fanout now refreshes and consumes the signed live inventory, skips empty repositories, and prioritizes repositories with untracked work.
- Reconciled apply backlogs now publish record tuples in bounded batches, re-verify authority-superseded canonical revisions without weakening source/verdict guards, and always carry an explicit coverage-proof artifact manifest under reduced state hydration.
- Restored close-backlog throughput by keeping apply jobs off the enormous immutable state-blob hydration path, and isolated operator-dispatched sweeps from background concurrency coalescing.

- Prevented exact-review cancellation storms by sparsely checking out Worker-projected state and keeping completed review-generation leases fenced through final publication.
- Apply now rechecks close proposals previously blocked by protected labels, PR close-exemption labels, or locked conversations, and resumes the normal conservative close gates when the live blocker is gone instead of stranding the verdict permanently; canonical audit output is uploaded before state publication so a later tuple conflict cannot discard the close-verdict inventory.
- Worker-mode hydration now cold-hydrates a slug that has no stored snapshot yet (records created canonically after the R2 seeding, e.g. a repository's first review) by replaying its journal from revision 0, bounded at 2000 records, instead of refusing cutover for the entire fleet; over-bound slugs still produce the named `snapshot_not_found` refusal (`cold_hydration_bound_exceeded`) telling the operator to trigger a snapshot, and snapshot cache key preparation excludes cold slugs instead of disabling the cache.
- Worker-mode hydration now discovers record repo slugs from the authenticated `/internal/state/records/slugs` Worker endpoint (canonical DO store, per-slug revisions) instead of reading the git state checkout's `records/` directory, which the worker-mode sparse checkout never materializes — this ended the permanent `no_record_repo_slugs` cutover refusal; explicit `CLAWSWEEPER_RECORDS_REPO_SLUGS`/`--records-repo-slugs` still wins, git-only (un-backfilled) slugs are warned about, and the snapshot cache key preparation uses the same discovery.
- Worker record request failures now surface the real status, error code, and a body snippet instead of dying on `Response.clone: Body has already been consumed`, and signed Worker requests retry transient 5xx/network failures (3 attempts, exponential backoff) so Cloudflare 502s no longer kill long export/reconcile runs.
- Made canonical record replay normalize revision-ordered legacy tuple remnants, continue after per-item validation rejections, and fail once at the end with every rejected item id.
- Allowed stuck-placeholder recovery to label pull requests by granting its target token pull-request write permission alongside issue write. Thanks @masatohoshino! (#865)
- Kept root-level apply reports as digest-only action-ledger evidence so ledger-enabled apply runs can finish, publish their compatibility report, and advance their cursor. Thanks @yetval! (#833)
- Restored repair and spam workflows by keeping the multi-owner repair policy out of the GitHub App token action's single-owner input. Thanks @yetval! (#834)
- Stopped the review pipeline stranding delivered verdicts: a single drifted state item is quarantined instead of aborting its whole batch, the commit_refs recovery path retries its final state-branch push with exponential backoff like its receipt and lease siblings, the superseded-placeholder sweep runs on every apply pass instead of only right after posting the durable verdict comment, and placeholder recovery spends its per-run budget on the oldest orphans first and labels long-stuck ones. Thanks @yetval! (#816)
- State publishes rebase onto the live remote head after lease admission, the coordinator ticket poll has a hard deadline with a still-queued heartbeat, and network pushes carry timeouts — ending the materializer's stale-base rejections and silent hangs. (#805)
- The state materializer is admitted through the publication-batch coordinator lane so the bulk writer no longer starves behind batch lease turns; queued state now drains on schedule. (#806)
- The `@clawsweeper re-review` acknowledgement describes the durable review comment's real create-or-update behavior. Thanks @anagnorisis2peripeteia! (#587)
- `normalizeGitHubActor` strips every trailing `[bot]` suffix, so stacked suffixes can no longer survive normalization and collide with a real bot identity. (#808)
- Validation identity capture and near-exhausted command budgets fail with classified budget errors instead of raw few-millisecond subprocess timeouts on loaded machines. (#817)
- Coalesced retried exact-review publication deliveries after provenance refresh without breaking same-producer revision handoff. Reported by @snowzlmbot automation.
- Synchronized review-derived labels on high-activity pull requests when complete hydration proves omitted activity is automation-only, while continuing to fail closed on hidden human activity or incomplete hydration. Thanks @veteranbv.
- Stopped stale "review started" placeholder comments from accumulating on reviewed items: publishing the durable review comment now sweeps superseded placeholders.
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
