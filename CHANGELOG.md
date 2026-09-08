# Changelog

All notable ClawSweeper changes are tracked here.

This file was reconstructed from first-parent git history. Generated dashboard,
checkpoint, and status-only commits are intentionally omitted.

## 0.3.1 - Unreleased

### Removed

- Deleted the separate live-proof dispatch/execute/attach workflow and its composite dispatcher; live verification now stays inside the review artifact lifecycle.
- Deleted the retired append-window compactor end to end: the `state-materializer.yml` workflow (a runner every 20 minutes to drain zero rows), its drain module, and the producer-free `/internal/state/{append,drain,ack,dispose}` Worker endpoints plus the five `state_append_*` Durable Object tables, which are dropped on upgrade.
- Deleted the commit-review lane (`commit-review.yml`, the hosted commit sweeper CLI commands, classifier/check publishing, and the `repair-commit-finding-intake.yml` intake) after zero successful runs in its final 20 attempts; the offline `pnpm local-review` engine and existing `commit_finding` repair jobs remain.
- Deleted the crawl-remote production deployment system (`deploy-crawl-remote.yml`, its pinned Wrangler toolchain, and CI integration job) after three runs ever with no success.
- Deleted the dormant `repair-finalize-open-prs.yml` dispatch workflow (last success April 29); the finalizer report module stays because `repair-publish-results.yml` still writes it after every worker-result publish.
- Deleted the proof-nudge lane (`proof-nudges.yml`, the `proof-nudges`/`bot-proof` CLI commands, and their eligibility/rendering policy); historical proof-nudge comment markers still count as dated proof requests in the stalled-unproven close policy.
- Deleted the monthly `state-compaction.yml` history rewrite of `openclaw/clawsweeper-state`, removing one of the last writers ahead of that repository's retirement.

### Changed

- Recover failed aggregate review shards only from recognized retryable item terminals in the complete exact-attempt ledger. Keep completed, nonretryable, uncertain, and unstarted items out of recovery, and retain identity- and digest-verified completed reports for normal guarded publication.

- Move optional aggregate review-ledger uploads out of the target publisher lock into a bounded artifact-backed job, preserving producer artifacts and required record/comment receipts when telemetry is slow or unavailable.

- Give Codex reviewers the existing short-lived, read-only target-repository GitHub App token as `GH_TOKEN` for authenticated reads, and describe token availability from the actual reviewer environment, including OpenClaw's credential filter.
- Give hosted issue/PR reviewers allowlisted public research access through a managed proxy while keeping the checkout read-only; describe token, blocked-host, and downloaded-media capabilities accurately and fail setup when sandbox enforcement regresses.
- Describe review capabilities from the active runner so OpenClaw gateway execution is not mistaken for the Codex allowlisted sandbox; prove Linux review sandbox enforcement in credential-free PR CI.

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
