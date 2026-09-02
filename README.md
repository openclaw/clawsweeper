# 🦞🧹 ClawSweeper

![ClawSweeper banner](docs/assets/readme-banner.jpg)

ClawSweeper is the conservative maintenance bot for OpenClaw repositories. It
keeps the backlog reviewed, keeps maintainer-visible GitHub comments tidy, and
turns narrow trusted findings into guarded repair or automerge work.

The dashboard Worker's explicit production targets are `openclaw/openclaw`,
`openclaw/clawhub`, `openclaw/clawsweeper`, and `openclaw/fs-safe`. Additional
public `openclaw/*` and `steipete/*` repositories can use configured profiles or
conservative generic fallback review through event dispatch and scheduled
fanout.

Project vision and boundaries: [`VISION.md`](VISION.md)

Documentation by task and audience: [`docs/README.md`](docs/README.md)

## Contributing

For local setup, PR scope, main-body proof, and the author-owned review loop,
read [CONTRIBUTING.md](CONTRIBUTING.md) before opening or updating a pull
request. Use the [documentation index](docs/README.md) to reach architecture,
configuration, dashboard, policy, and operator references without scanning this
entire README. The contributing guide explains when to use
`@clawsweeper re-review`, why a changed head or PR body needs fresh evidence,
and why readiness is not merge authority.

The OpenClaw-hosted ClawSweeper instance is not a public review service and does
not provide free reviews for third-party repositories. If you want ClawSweeper
for your own project, fork this repository, deploy it in your own organization,
and configure that self-hosted instance for your repositories.

At a high level ClawSweeper:

- reviews open issues and pull requests on a schedule and on exact GitHub events
- writes one durable markdown report per item in generated state
- syncs one marker-backed public review comment per issue or PR, edited in place
- preserves validation, rendering, media publication, and retraction for
  historical live-proof artifacts; new reviews do not generate live proof
- closes only unchanged, high-confidence, policy-allowed proposals
- routes maintainer commands such as `@clawsweeper review`,
  `@clawsweeper fix`, `@clawsweeper autofix`, and `@clawsweeper automerge`
- can acknowledge maintainer comment commands through an optional GitHub App
  webhook before the GitHub Actions fallback starts
- repairs opted-in PRs through a bounded Codex review/fix loop before merge
- automatically opens guarded implementation PRs for viable reviewed issues in
  eligible public `openclaw/*` and `steipete/*` projects outside
  `openclaw/openclaw` and `openclaw/clawhub`
- can review local branch ranges with repository and GitHub access kept local
  while Codex connects to the configured model service
- publishes canonical review records to the Cloudflare Worker, action ledgers
  and assets to R2, and the remaining operational state to
  `openclaw/clawsweeper-state`

For the complete architecture and operator guide covering issue-to-PR work, PR
repair, GitCrawl intake, durable Codex threads, CrabFleet steering, completion
gates, quotas, dashboards, and recovery, see
[`docs/steerable-repair-automation.md`](docs/steerable-repair-automation.md).

ClawSweeper is not a generic auto-close bot. Review is proposal-only, apply is
guarded, Codex never gets write credentials during review, and every GitHub
mutation is rechecked against live target state immediately before it happens.

## Capabilities

### Issue and PR Reviews

Scheduled runs scan open issues and pull requests, while target repositories can
forward exact issue/PR events with `repository_dispatch` for low-latency
one-item reviews. Each review writes
`records/<repo-slug>/items/<number>.md` with the decision, evidence, proposed
maintainer-facing comment, runtime metadata, and GitHub snapshot hash.

ClawSweeper syncs one marker-backed public review comment per item and edits it
in place instead of posting repeated comments. If a review starts before a
completed comment exists, it first posts a short status placeholder, then
replaces that same comment with the final review. Pull request comments include
hidden verdict/action markers so trusted repair and automerge flows can continue
without scraping visible prose. See
[`docs/pr-review-comments.md`](docs/pr-review-comments.md).

Review prompts include compact related issue and PR context from explicit links,
linked closing PRs, existing local ClawSweeper reports, optional gitcrawl
clusters, and opt-in live GitHub issue search for exact event reviews. This is
advisory context for duplicate/superseded reasoning, not a standalone close
decision. Reviews also persist a typed, proposal-only root-cause assessment with
same-repository URLs and at most one evidence-backed canonical item; it does not
dispatch repair, suppress jobs, mutate siblings, close, or merge. See
[`docs/related-issue-discovery.md`](docs/related-issue-discovery.md).

For open issues with complete, current kept-open reviews, ClawSweeper also
projects selected structured review conclusions into advisory GitHub labels for
maintainer filtering and project views. These labels expose states such as
current-main reproduction, source reproduction, linked open PRs, queueable
fixes, verified small bugs suitable for `good first issue`, missing info, and
product/security review needs. They are advisory only
and do not trigger repair, merge, or close behavior. Label-only syncs record
`labels_synced_at` in the durable report so GitHub `updated_at` changes caused
by ClawSweeper-owned label writes do not look like fresh target-side activity to
the scheduler. See
[`docs/work-lane.md`](docs/work-lane.md).

### Apply and State

Apply mode re-fetches live GitHub state, checks labels, maintainer authorship,
paired issue/PR state, snapshot drift, and repository profile rules before
commenting or closing anything. Closed or already-closed reports move to
`records/<repo-slug>/closed/<number>.md`; reopened archived items move back to
`items/` as stale work.

Apply and artifact replay also maintain Codex-authored decision packet JSON at
`records/<repo-slug>/decision-packets/<number>.json` for reports that need a
maintainer ruling. Codex supplies the exact question, rationale, options,
recommendation, and likely owner as structured review output. Deterministic
code validates that intent, persists it, refreshes item state, and removes stale
packets; labels and report prose do not reconstruct the decision. Pass
`--decision-packets-dir` to write those packet files somewhere other than the
profile's default records directory.

Canonical review records live in the Cloudflare Durable Object store and are
snapshotted to R2. Immutable `ledger/v1/` action events, published `assets/`,
and the bounded content-addressed `artifacts/exact-review/v1/` retry cache also
live in R2. The `state` branch of `openclaw/clawsweeper-state` now retains
only `jobs/`, `results/`, `notifications/`, `apply-report.json`, and
`repair-apply-report.json`; its `main` branch remains the dashboard renderer
source. `scripts/hydrate-state.ts` combines those sources for local commands.
See [`docs/state-storage.md`](docs/state-storage.md) for the ownership table.

### Repair and Automerge

Maintainer commands can opt PRs into `autofix` or `automerge`, dispatch a fresh
exact-head review, and run a bounded Codex review/fix loop. Codex handles the
code repair and local validation loop; deterministic executor steps own every
GitHub mutation, branch push, label update, and final merge gate.

Operators can create repair-only jobs for one author's blocked pull requests in
one repository with `pnpm repair:pr-intake -- --repo owner/name --author login`,
or across all configured public repositories with
`pnpm repair:pr-intake -- --author login --all-open`. Author-wide discovery
skips private, unsupported, and unverifiable repositories without persisting
their names. Generated jobs cannot close or merge their source pull requests.

Automerge waits for exact-head review, required checks, mergeability, and policy
gates. If repair was needed, the mutable status comment records each review,
repair, re-review, and merge step with timing and links. The final merge result
summarizes both the original PR change and any ClawSweeper fixups.

For issues, high-confidence bug reviews that identify a reproduced or small,
source-proven fix, do not already have a linked PR, and do not require
feature/config expansion automatically dispatch Codex to open one guarded
implementation PR labeled `clawsweeper:autogenerated` whenever
`CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES=1`. An exact issue review dispatches its fix
as soon as that review is published; scheduled sweeps also backfill eligible
existing reports. The worker reproduces or establishes a failing regression
before opening the PR.
When the separate vision-fit lane is enabled, reviewed issues that clearly fit
the target repository `VISION.md`, are small enough for one focused PR, and have
clear repair shape can use the same PR-only implementation path without
weakening the strict bug gate.

### Commit Reviews (retired)

The push/manual commit-review lane was retired in July 2026. Use
`pnpm local-review` for GitHub-isolated local branch reviews.

### Operations

Repository-specific rules live in `src/repository-profiles.ts`, so OpenClaw,
ClawHub, and ClawSweeper can share the same engine while keeping different apply
limits. Both review and repair lanes support manual workflow dispatch, reruns,
and backfills.

## Guardrails

ClawSweeper may propose a close only when the item is clearly one of these:

- implemented on current `main`
- not reproducible on current `main`
- better suited for ClawHub skill/plugin work than core
- duplicate or superseded by a canonical issue/PR
- low-signal pull request whose branch is mostly unrelated or unmergeable churn
- external low-rated pull request whose requested real-behavior proof never
  arrived and whose branch has been idle for 14+ days
- external pull request abandoned for 30+ days as a draft, waiting on its
  author, or failing checks on its live head
- concrete but not actionable in this source repo
- incoherent enough that no action can be taken
- stale issue older than 60 days with too little data to verify

Maintainer-authored items stay open unless ClawSweeper can verify that the
request is already implemented on current `main`. Everything else stays open.
Issues with an open PR that references them using GitHub closing syntax such as
`Fixes #123` stay open until that PR merges, is closed, or ClawSweeper closes
that high-confidence PR candidate earlier in the same apply run.
Open issue/PR pairs from the same author stay open together unless the paired
item is already resolved or a maintainer explicitly asks to close one side.
Related PR links do not promote a completed keep-open review into a close
proposal. Codex owns that supersession decision; comment publication preserves
the verdict. Independent no-diff, stale-PR, and author-budget policies still
apply.

PR-to-PR duplicate/superseded closes also require a safe canonical target:
ClawSweeper refuses to close one PR as replaced by another PR that is closed
unmerged, missing positive real behavior proof, F-rated, already proposed for
close, not cleanly mergeable, or otherwise not a viable landing path.

Repository profiles can further narrow apply. ClawHub and ClawSweeper self-review
are intentionally stricter: they review issues and PRs, but apply may close only
PRs where current `main` already implements the proposed change with
source-backed evidence.

## Maintainer Commands

Maintainers can steer ClawSweeper from target-repo issue and PR comments. The
preferred form is `@clawsweeper ...`. The router also accepts
`@clawsweeper[bot] ...`, `@openclaw-clawsweeper ...`,
`@openclaw-clawsweeper[bot] ...`, and legacy slash aliases such as
`/clawsweeper ...`, `/review`, `/automerge`, `/auto merge`, and
`/autoclose <reason>`.

Common commands:

```text
@clawsweeper status
@clawsweeper re-review
@clawsweeper re-run
@clawsweeper review
@clawsweeper fix ci
@clawsweeper address review
@clawsweeper rebase
@clawsweeper autofix
@clawsweeper automerge
@clawsweeper approve
@clawsweeper explain
@clawsweeper ask is this blocked by flaky CI?
@clawsweeper visualize state
@clawsweeper stop
@clawsweeper why did automerge stop here?
```

- `status` and `explain` post a short target summary.
- `review`, `re-review`, and `re-run` dispatch a fresh ClawSweeper issue/PR
  review without starting repair.
- Command status replies are marker-backed and edited in place per
  issue/PR, intent, and head SHA. The visible badge is one lobster plus the
  current state: `👀` for acknowledgement, `🧹` for review, `🔧` for repair, and
  `✅` for completed/paused work.
- Freeform `@clawsweeper ...` mentions and explicit `ask ...` questions dispatch
  the maintainer-only assist lane. Assist runs the internal model with high reasoning,
  a 120-second per-item timeout, and its own five-job cap. It posts a separate
  non-durable answer comment and never edits the durable ClawSweeper review
  comment, closes, merges, labels, pushes, repairs, or emits review/apply
  markers. The model job has read-only GitHub access and emits a bounded artifact;
  a fresh trusted publisher validates its workflow request, target revision, PR
  head, and source comment before minting a narrow comment-write token.
- `visualize [lens]` dispatches the read-only visual assist lane and posts or
  updates a marker-backed visual brief comment for the requested lens.
- `fix ci`, `address review`, and `rebase` dispatch the repair worker only for
  ClawSweeper PRs or PRs already opted into `clawsweeper:autofix` or
  `clawsweeper:automerge`.
- `autofix` labels an open PR, creates or reuses the adopted job, dispatches
  review, and enters the bounded review/fix loop without merging.
- `automerge` labels an open PR, creates or reuses the adopted job, dispatches
  review, and enters the bounded review/fix/merge loop. Draft PRs are fix-only
  until GitHub marks them ready for review.
- `implement issue` on an open issue creates or reuses one issue implementation
  job and dispatches the issue-to-PR lane. OpenClaw organization members may
  request this explicitly even without repository write permission.
- With automatic issue implementation enabled, newly reviewed issues and
  existing eligible open issue reports enter the enabled bounded lanes. Codex
  inspects the issue and repository, chooses the
  implementation, discovers validation, and stops without a PR when the request
  is no longer viable. Generated PRs receive `clawsweeper:autogenerated` and
  `clawsweeper:autofix`, then repeat exact-head review and repair until no
  actionable findings remain, required checks appear and settle green, and
  GitHub reports merge-state readiness. ClawSweeper removes the repair-loop
  label and leaves the PR open; generated issue PRs never automerge.
- User-facing OpenClaw `fix`, `feat`, and `perf` automerge PRs preserve
  release-note context in PR bodies and commit messages before merge;
  contributors are not asked to edit `CHANGELOG.md`.
- Security-sensitive findings can be repaired only after explicit
  `autofix`/`automerge` opt-in; ClawSweeper still will not merge until a later
  exact-head review is clean.
- `approve` lets a maintainer clear a ClawSweeper human-review pause and merge
  only after the normal exact-head, checks, mergeability, and gate checks pass.
- `stop` removes repair-loop labels, adds `clawsweeper:human-review`, and makes
  older automerge/autofix comments ineligible to continue. `/autoclose <reason>`
  closes the item and any open same-repo targets explicitly referenced in the
  command text.
- `clawsweeper:human-review` and `clawsweeper:manual-only` stop automatic PR
  repair and issue-to-PR mutation. Issue implementation rechecks the live issue
  immediately before every branch push and before PR creation.

Only maintainers are accepted for write actions. The router checks repository
collaborator permission (`admin`, `maintain`, or `write`) and falls back to
trusted `author_association` values when permission lookup is unavailable.
Users with repository write access and issue/PR authors may ask
`@clawsweeper re-review` or `@clawsweeper re-run` for a fresh read-only review.
Other contributor commands are ignored without a reply. Scheduled comment routing is dry unless
`CLAWSWEEPER_COMMENT_ROUTER_EXECUTE=1`; workflow dispatch with `execute=true`
can be used for one-off live routing.
For fast intake, the ClawSweeper GitHub App webhook durably records eligible
`review` and `re-review` comment versions before it acknowledges them. Other
commands still enqueue exact `clawsweeper_comment` work, and item events enqueue
`clawsweeper_item` work, from eligible public `openclaw/*` and `steipete/*`
repositories. Exact
item work is coalesced and leased by the dashboard Worker before it dispatches
an executor, so webhook bursts do not create capacity-waiting Actions runners.
The target-side dispatcher remains a scheduled-intake fallback until it adopts
the queue lease contract. Legacy target dispatches are bridged into that queue
before any Codex executor starts.

## Dashboard

Live dashboard and generated state: https://github.com/openclaw/clawsweeper-state

Live pipeline dashboard: https://clawsweeper.openclaw.ai/

The Cloudflare dashboard is observability-only: it shows the system flow, live
worker capacity, per-worker current steps and drill-down timelines,
separate issue-to-PR and PR-repair worker views, automatic issue-build cards
with lifecycle drill-down, repair/automerge pipeline rows, CI state, recent
failures, and automerge timing without owning GitHub mutations.
Its Live terminals link opens CrabFleet for browser steering of registered
GitHub Actions sessions. See [`docs/live-dashboard.md`](docs/live-dashboard.md).
The end-to-end session lifecycle is documented in
[`docs/steerable-repair-automation.md`](docs/steerable-repair-automation.md).

The optional triage dashboard page at `/triage` exposes ClawSweeper advisory
issue labels as read-only maintainer views, including local routing groups
derived from existing `impact:*` labels. It is backed by GitHub Search snapshots
instead of GitHub Project writes. See
[`docs/triage-dashboard.md`](docs/triage-dashboard.md).

The optional PR proof triage page at `/pr-proof-triage` exposes open pull
requests that are blocked on real behavior proof labels, including missing
proof, supplied-but-not-sufficient proof, mock-only proof, and proof label
mismatches. See
[`docs/pr-proof-triage-dashboard.md`](docs/pr-proof-triage-dashboard.md).

OpenClaw Bay at `/bay` is a public, indexable ClawSweeper dashboard
destination that renders the same read-only operational status as an animated
shoreline. It is linked from the Overview, issue-triage, and PR-proof headers,
and adds no browser-to-GitHub requests or new GitHub query path. See
[`docs/openclaw-bay-demo.md`](docs/openclaw-bay-demo.md).

The default-off unconfirmed product-direction policy can propose closure for a
strictly bounded class of technically correct, well-proven external feature PRs
that still lack maintainer-confirmed direction. Live maintainer signals and
automation opt-ins veto apply. See
[`docs/product-direction-close-policy.md`](docs/product-direction-close-policy.md).

The default-off per-author PR-budget policy gradually trims an external
author's oldest lowest-signal PRs only after apply verifies the live repository
count, seven-day inactivity, rating/proof eligibility, protected labels, and
maintainer engagement. See
[`docs/author-pr-budget-close-policy.md`](docs/author-pr-budget-close-policy.md).

## How It Works

ClawSweeper is split into three operational lanes:

- review lane: scheduled and event-driven issue/PR reviews, durable reports, and
  public review comment sync
- apply lane: guarded close/comment mutations, audit, reconcile, and state
  publishing
- repair lane: maintainer-command routing, autofix, automerge, issue
  implementation PRs, and repair result publishing

### Scheduler

The issue/PR scheduler decides what to scan and how often. New and active items
get more attention; older quiet items fall back to a slower cadence. Detailed
scheduling, capacity, and monitoring behavior is documented in
[`docs/scheduler.md`](docs/scheduler.md).

- hot/new and recently active items are checked hourly, with a 5-minute intake
  schedule for the newest queue edge
- target repositories can forward issue and PR events with
  `repository_dispatch`; those exact item runs use a dedicated single job to
  review one item, sync the durable comment, and apply only safe close
  proposals for that same item
- pull requests and issues younger than 30 days are checked daily once they
  leave the hot window
- older inactive issues are checked weekly
- apply wakes every 15 minutes and exits quickly when there are no unchanged
  high-confidence close proposals

### Review Lane

Review is proposal-only. It never closes items.

- A planner scans open issues and PRs, then assigns exact item numbers to shards.
- Manual runs can pass `item_number` or comma-separated `item_numbers` to review
  exact Audit Health findings without scanning for a normal batch. Batch
  dispatchers can use `shard_count` to bound parallel shards and `batch_size`
  to set the number of items assigned to each worker.
- Each shard checks out the selected target repository at `main`.
- Codex reviews with the internal model, high reasoning, the default service tier, and a
  10-minute per-item timeout.
- Each item becomes a flat report under
  `records/<repo-slug>/items/<number>.md` with the decision, evidence,
  Codex `/review`-style PR findings, suggested comment, runtime metadata, and
  GitHub snapshot hash. When GitHub exposes a merged closing PR for an issue,
  the report records that PR and the close comment links it as fix provenance.
- High-confidence allowed close decisions become `proposed_close`.
- After publish, the lane checks the selected items' single marker-backed Codex
  review comment. Missing comments and missing metadata are synced immediately;
  existing comments are refreshed only when stale, currently weekly.
- PR review comments keep the top-level note concise, put source links and full
  evidence in collapsed details, and use hidden verdict/action markers for the
  trusted ClawSweeper repair loop; see
  [`docs/pr-review-comments.md`](docs/pr-review-comments.md).

### Apply Lane

Apply reads existing reports and mutates GitHub only when the stored review is
still valid.

- Updates the single marker-backed Codex automated review comment in place.
- Closes only unchanged high-confidence proposals.
- Keeps the durable review comment. Applied PR closes also post one idempotent,
  marker-backed close receipt; issue closes currently leave the durable review
  as ClawSweeper's sole comment.
- Moves closed or already-closed reports to
  `records/<repo-slug>/closed/<number>.md`.
- Moves reopened archived reports back to the repo’s `items/` folder as stale.
- Commits checkpoints and machine-readable status during long runs.

Apply wakes every 15 minutes, no-ops when there are no unchanged
high-confidence close proposals, and narrows scheduled runs to the currently
eligible proposal list so idle runs do not scan unrelated keep-open records.
It defaults to all item kinds, no age floor, a 2-second close delay, and 20
fresh closes per checkpoint, with a hard cap of 20 to keep each GitHub App
token within its lifetime. After a checkpoint closes at least one item, it
queues another apply run with a fresh token; a saturated scan that closes
nothing stops and waits for the next scheduled tick instead of self-dispatching
indefinitely.

Apply health keeps the scheduler-admitted `apply_ready_count` separate from the
full promotion backlog, cooldown-eligible probes, proof-required work, guarded
retries, and inconsistent records. Its cycle estimate covers work actionable in
the current scheduler window rather than presenting every probe as immediately
closable.

Exact event runs skip the bulk planner and shard matrix. The read-only reviewer
handles only the selected item, uploads a hash-bound GitHub Actions artifact,
enqueues a separate durable publication lease, and then releases its review
lease without checking out or pushing the state repository. The queue retries
publication independently, so a cancelled publisher does not rerun Codex. The
source fallback uses adaptive minimum/base/maximum values of 4/24/48; production
overrides them with 8/32/40 and enables direct
publication plus up to 8 concurrent size-8 batches. The Durable Object validates
each artifact's workflow run, queue tuple,
target, decision digest, file inventory, sizes, and SHA-256 hashes before a
publisher receives write tokens.
Publication leases reserve the bounded publisher lane's maximum queue wait;
terminal-run reconciliation releases dead dispatches early. The publisher then
uses the same review and apply paths with only the
immediate-safe reasons enabled by default:
`implemented_on_main`, `duplicate_or_superseded`, and
`low_signal_unmergeable_pr`. A stale tuple now terminates as `superseded`
instead of retrying, while permanent failures enter a bounded dead-letter store
after their confirmation retries. Artifacts remain available for 90 days; three
confirmed unavailable-artifact attempts queue one fresh exact review instead of
waiting for the retention deadline.

Deterministic terminal and remain-open outcomes flow through the same publisher.
Ordinary synced verdicts publish their exact durable comment, then queue an
executing target-wide comment-router scan. Exact publishers use the bounded
Durable Object lane while batch publishers remain per-target serialized. Direct
exact-event viable-issue
implementation dispatch stays disabled; the bounded broad publish/backfill lane
owns that separately revalidated intake. Publication still does not claim an
atomic state-publish-and-route boundary.
`stale_insufficient_info` issue reports and `mostly_implemented_on_main` PR
reports are never applied to young items; apply requires those reports to be at
least 60 days old unless a manual run explicitly changes the threshold. A stale
issue also stays open when a non-bot comment was posted in the last 60 days.

The external state dashboard is fleet-scoped. Each configured repository gets
its own canonical record collection, status JSON, audit state, cadence counts,
and recent activity section, so event runs from one repo do not hide the state
of another.

There is still one deterministic apply path for writes. Review can propose and
sync stale public review comments, but closing remains guarded by apply so a
fresh GitHub snapshot, labels, maintainer-authorship, and unchanged item state
are checked immediately before mutation. Maintainer-authored or
`maintainer`-labeled items can still close when the only protected state is
maintainer ownership and the close reason is verified `implemented_on_main`.
Configured OpenClaw targets may close issues as `implemented_on_main` when the
fix is proven on current `main`, even before the next release ships.

### Repair Lane

Repair starts from maintainer intent or trusted ClawSweeper review metadata. The
comment router accepts commands from target repositories, validates maintainer
permissions, updates one mutable command/status comment, and dispatches the
appropriate repair job.

- `autofix` and `automerge` adopt the PR branch and run exact-head review before
  making changes.
- If review or CI finds actionable issues, Codex rebases, addresses PR review
  comments, fixes CI, runs the requested validation, and returns a structured
  repair artifact.
- The deterministic executor applies the artifact, pushes only after validation,
  re-dispatches exact-head review, and waits for required checks.
- `autofix` completes by removing its repair-loop label after a clean exact-head
  review and green required checks, then leaves the PR open for maintainer
  review and merge.
- `automerge` merges only after review verdict, checks, mergeability,
  security, maintainer stop/approve state, and repository policy gates pass.
- Repair workers coalesce pending runs for the same durable job while allowing
  an active execute run to finish its gate cleanup. Stale-head retries use a
  dedicated run-scoped lane so they can start during that temporary gate
  window. Before a contributor branch push, ClawSweeper waits 90 seconds by
  default, fetches the live PR head again, and requeues instead of pushing when
  that head changed. It also refuses to push when the PR closed during the
  wait. Override the window with `CLAWSWEEPER_BRANCH_PUSH_SETTLE_SECONDS`
  (bounded to 0-120 seconds) when a manual backfill is already settled.
- An OpenClaw organization member can comment `@clawsweeper implement issue`;
  ClawSweeper refuses when an open PR already mentions the issue, a generated
  branch PR is already open, the issue is paused, or security blockers remain.
- `CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES=1` enables newly reviewed issues and
  bounded backfill from existing eligible open issue reports. General viable
  implementation remains limited to public sibling repositories;
  `openclaw/openclaw` uses its separately gated strict-bug and vision-fit lanes,
  and `openclaw/clawhub` remains excluded.
- Issue intake and dispatch use `ubuntu-latest` by default, independently of the
  Blacksmith runner selected for Codex planning and repair execution.

Repair internals are documented in
[`docs/repair/README.md`](docs/repair/README.md), and the automerge state
machine is documented in
[`docs/repair/automerge-flow.md`](docs/repair/automerge-flow.md).
The production automerge command chain can be validated before merge with the
local-container, CI, and Crabbox harness in
[`docs/repair/automerge-e2e.md`](docs/repair/automerge-e2e.md).

### Commit Review Lane (retired)

The hosted commit-review lane was retired in July 2026 (zero successful runs in
its final month). The local, GitHub-isolated review engine survives as
`pnpm local-review`; see [docs/commit-sweeper.md](docs/commit-sweeper.md).

### Safety Model

Native reviews require host-owned TruffleHog admission before any model-backed
checkout inspection or review. The host scans the explicit initial prompt and
schema plus complete raw before/after blobs and the full introduced diff. Scan
coverage is independent of the 80-path/24K-character display evidence limits.
Repair reviews scan the committed, staged, unstaged, and applicable untracked
bytes of the validated checkout. Clean text-converted checkouts retain both
canonical Git and raw working bytes in scan coverage. The host never starts a target-bundled autoreview helper or second reviewer.

Hosted Codex and OpenClaw setup share the checksum-pinned TruffleHog 3.97.1
installer in `.github/actions/setup-review-tools/install.sh`. For local review,
ClawSweeper first uses a trusted host executable outside both checkouts; when it
is absent, it bootstraps the exact checksum-pinned release asset into a
user-owned cache outside both checkouts. The local bootstrap accepts no URL or
version override, verifies the download and cached executable, and runs a clean
environment version check before scanning. Missing tools, unclassified findings, scan errors, source
drift, incomplete ancestry/objects, changed gitlinks, and LFS pointers refuse the
review. The scan stages at most 256 MiB in private external temporary files and
uses the remaining review deadline; it never silently truncates or bypasses.
Diagnostics omit scanner output and source values. Restore prerequisites or
remove sensitive input before retrying a refusal.
Exact-review failure manifests distinguish a native output/scan-contract failure
from an unclassified finding. The latter records the first blocking finding's
bounded detector metadata and host-staged material identity: prompt, schema,
additional input, raw diff, patch, raw working bytes, or Git blob. Source
references contain Git revisions and hashed paths, with at most four references
and their total count. No raw paths, matched values, literal digests, or
verification messages are retained; this provenance does not authorize a finding.

The host classifies the reviewed synthetic malformed-configuration URI in
`test/action-ledger-runtime.test.ts` and the explicitly approved autoreview
negative-test URI in the [canonical autoreview test](https://github.com/openclaw/agent-skills/blob/a8466c1d860588a083610fe41fd277c1d88b14e0/skills/autoreview/tests/test_autoreview_hardening.py)
or its [vendored OpenClaw copy](https://github.com/openclaw/openclaw/blob/136eab023035dd5943818f791d3c3db7d92e4491/.agents/skills/autoreview/tests/test_autoreview_hardening.py)
as non-sensitive after a complete scan. The same exact-fixture policy covers
the reviewed OpenClaw Browser CDP authentication and credential-redaction fixtures in
[`chrome.test.ts`](https://github.com/openclaw/openclaw/blob/8e03b0c62e76dc25c77045a84ab3098a111a7be3/extensions/browser/src/browser/chrome.test.ts),
the [remote-CDP coverage](https://github.com/openclaw/openclaw/blob/58da2f5897feb6840937d8e50cf7ee6f26aa57d7/extensions/browser/src/browser/chrome.test.ts),
the [server-context redaction test](https://github.com/openclaw/openclaw/blob/4b5987829d0f82ea44ae50f2f418ffe5ea445e7f/extensions/browser/src/browser/server-context.ensure-browser-available.waits-for-cdp-ready.test.ts),
the [remote-CDP documentation example](https://github.com/openclaw/openclaw/blob/bf15c87d2b1223610b42775b8154b8eec60b541d/docs/tools/browser.md),
the [credentialed-page rejection fixtures](https://github.com/openclaw/openclaw/blob/d5fb4903f1b13a4309d479f1011d995b1fc706ae/extensions/browser/src/browser-tool.test.ts),
the [guarded CDP authentication fixtures](https://github.com/openclaw/openclaw/blob/1cf6ff3bdc08a6ac08facb1006b1d7aabc0eaff4/extensions/browser/src/browser/cdp.helpers.test.ts),
the [MCP endpoint-redaction fixture](https://github.com/openclaw/openclaw/blob/ac21e89c13e42f6a7d152bf9be143e67edd44ed3/extensions/browser/src/browser/chrome-mcp.test.ts),
the [Mac dashboard credentialed-subframe rejection fixture](https://github.com/openclaw/openclaw/blob/9ba01d6c7b1c308e7b41eac11ba6f43e0fd0393d/apps/macos/Tests/OpenClawIPCTests/DashboardWindowSmokeTests.swift#L273),
the [Mattermost slash-error sanitization fixtures](https://github.com/openclaw/openclaw/blob/9c0975c1c20ed635532c7aa0f510154224adee7f/extensions/mattermost/src/mattermost/slash-http.test.ts),
and the OpenClaw config [URL-redaction](https://github.com/openclaw/openclaw/blob/5fe22a7d88919f260e7999fc775733feff3cb1fa/src/config/redact-snapshot.test.ts)
and [restoration fixtures](https://github.com/openclaw/openclaw/blob/5fe22a7d88919f260e7999fc775733feff3cb1fa/src/config/redact-snapshot.restore.test.ts)
after a complete scan. Static host policy associates each
exact detector-matched URI SHA-256 with only its approved source paths and exact
scanner `Raw` digest, including when `Raw` omits a path retained by `RawV2`. The
matched value must be a literal in a host-staged Git blob from mode `100644`.
The three guarded-CDP/MCP entries, Mac dashboard entry, and four Mattermost entries also bind complete
reviewed source lines, including surrounding query text that TruffleHog's URI
detector does not match. Changes to those lines or additional literal occurrences
refuse classification. These witnesses do not expand native query detection.
The table binds exact values and paths across revisions, not particular commits.
The host locates that exact literal independently in the staged blob. Decoder
coordinates can shift, and TruffleHog can omit a companion plain-text finding,
so admission does not depend on another finding or a reported line matching the
original source. Repeated literals remain eligible unless an entry is bound to
an approved complete-line digest; those entries require exactly one occurrence
in the staged blob. Finding order and duplicate records do not change the exact
value, path, and mode checks.
Findings must use `PLAIN` or `HTML`, except the Mac dashboard entry permits only
its observed `PLAIN` decoder and the two guarded-CDP fixtures also permit `BASE64`.
The pinned Base64 decoder preserves the rest of a chunk after
decoding another token, so an unchanged literal can acquire that decoder label
and win cross-decoder deduplication. Those entries still require the literal in
its exact original source line; encoded-only content remains blocking.
One source path may contain multiple independently reviewed fixtures; each
digest/path/mode tuple must match exactly, so source membership alone never
qualifies a finding.
Deduplicated blobs retain every scanned logical endpoint's path and Git mode,
including mode-only transitions and shared-path aliases. Every captured reference
must qualify under the same digest's exact path and mode `100644` policy before
any source is eligible for classification or an audit notice.
The policy does not trust checkout ignore rules, domain patterns, fixture words,
test names, or unchanged-line inference; no nearby fixture is implicitly approved.
Findings attributed to prompt, schema, diff, additional-input, other-path, or
encoded-only blobs remain blocking, as do other findings, verified findings,
and incomplete scans. Unverified findings alone never qualify: every finding must
match the exact bytes, source association, and strict detector contract. This
classification does not expand TruffleHog's detection coverage.
The classification is pinned to TruffleHog 3.97.1's output contract; scanner
upgrades require requalification. See `src/agent-input-scan-fixtures.ts`.
After successful cleanup and final source fences, each accepted fixture/source
pair emits a host-side structured stderr notice with `event`, `fixtureSha256`,
`source`, `detector`, and `findings` entries containing `blob`, `decoder`, and
`occurrences`. Each finding retains its reported `scannerLine` and a `literalLine`
for the first exact literal in the staged blob. This bounded witness establishes
literal presence; it does not identify which occurrence produced a decoded hit.
Counts are per source: a shared blob can appear in both source
notices and those counts must not be summed across sources. A refused or drifted
scan emits no success notice. Raw values and verification diagnostics never
appear in that audit notice.

Generated review and repair prompt diagnostics retire the previous attempt's
copy before admission and persist only successfully scanned exact prompt bytes
with owner-only access. Commit review, assist, and close-coverage proof do not
retain unused prompt copies. Original inputs and explicitly requested prompt
exports (`repair:render` or worker `--dry-run`) remain operator-owned outputs.

This admission boundary is not universal provider-egress scanning. Automatically
loaded project docs, resumed/steered history, later tool results, and unchanged
repository history are outside its scope. Planning, assist, and close-coverage
calls scan their explicit prompt/schema; they do not attest a source review.
No dashboard projection or observer API changes; OpenClaw Bay is unaffected.

Maintainers can run the dispatch-only `Hosted native review scan smoke` job in
`ci.yml`. It uses the existing `OPENAI_API_KEY` and `CLAWSWEEPER_MODEL` secrets
only during host setup, with no App mutation token. The proof artifact records
zero provider starts on refusal, one clean native structured run, exact fixture
and runner identities, and coverage limits without exposing the configured model.

- Review and repair base fetches use fully qualified branch refspecs so inherited
  `fetch.prune` or `remote.origin.prune` settings do not delete the requested
  tracking ref. Validation uses the same repair fetch helper; no host Git
  configuration changes are required.
- Maintainer-authored items are excluded from automated closes unless the close
  reason is verified `implemented_on_main`.
- Protected labels block close proposals.
- Apply rechecks older skipped fixed-close reports and archives skipped item
  records when GitHub already shows the item closed.
- Apply can retry older `kept_open` close reports and clear linked-PR issue
  blockers after ClawSweeper closes the PR earlier in the same apply run.
- Open PRs with GitHub closing references block issue closes until the PR is
  resolved or closed earlier in the same apply run.
- Open same-author issue/PR pairs block one-sided closes.
- Codex runs without GitHub write tokens.
- Issue/PR event jobs create target write and report-push credentials only after
  Codex exits.
- The retired hosted commit-review lane no longer mints target credentials;
  `pnpm local-review` operates on the local branch range without GitHub writes.
- CI makes the target checkout read-only for reviews.
- Reviews fail if Codex leaves tracked or untracked changes behind.
- Snapshot changes block apply unless the only change is the bot’s own review
  comment.
- The retired hosted commit-review lane no longer publishes Commit Check Runs.

### Audit

`pnpm run audit` compares live GitHub state with generated records without moving
files. It reports missing open records, archived open records, stale records,
duplicates, protected-label proposed closes, and stale review-status records.
Protected proposed closes are reported only for active repo `items/` records
because archived repo `closed/` records are historical and cannot be applied.
Missing open records are classified as eligible, maintainer-authored, protected,
or recently created so strict audit mode can flag actionable drift without
treating expected queue lag or excluded items as failures.
Use `--update-dashboard` to publish the latest audit state under
`results/audit/` in `openclaw/clawsweeper-state` without making every normal
status update scan all open GitHub items. The state repo renders reviewable
findings such as missing eligible records, reopened archived records, and stale
reviews from that state. The
workflow refreshes audit state on a separate six-hour schedule, and it can be run
manually with `audit_dashboard=true`. The read-only audit lane covers
`openclaw/openclaw`, `openclaw/clawhub`, and `openclaw/clawsweeper`; it falls
back to public workflow-token reads when the ClawSweeper App token is not
available for a target.

## Local Run

Requires Node 24.

Issue/PR sweeper:

```bash
source ~/.profile
corepack enable
pnpm install
pnpm run build
pnpm run plan -- --target-repo openclaw/openclaw --batch-size 5 --shard-count 89 --max-pages 250 --codex-model internal --codex-reasoning-effort high
pnpm run review -- --target-repo openclaw/openclaw --target-dir ../openclaw --batch-size 5 --max-pages 250 --artifact-dir artifacts/reviews --codex-model internal --codex-reasoning-effort high --codex-timeout-ms 600000
pnpm run apply-artifacts -- --target-repo openclaw/openclaw --artifact-dir artifacts/reviews --skip-dashboard
pnpm run audit -- --target-repo openclaw/openclaw --max-pages 250 --sample-limit 25 --update-dashboard
pnpm run reconcile -- --target-repo openclaw/openclaw --dry-run
```

Advisory exact local issue/PR review:

For Codex users, the repo-local skill `$local-clawsweeper-review` wraps this
workflow with setup checks, target checkout hygiene, and artifact readout. Skill
usage is documented in
[`docs/local-clawsweeper-skill.md`](docs/local-clawsweeper-skill.md).

```bash
codex login --device-auth -c 'service_tier="fast"'
pnpm run codex:local:check
pnpm run review -- --local-only --target-repo owner/name --item-number 123
```

`review` is the single issue/PR review command. `--local-only` makes it an
advisory local run: it skips the review-start placeholder comment, defaults the
Codex service tier to `fast` for local CLI compatibility, preserves local Codex
auth, and leaves generated output under the selected artifact directory. With a
single `--item-number` and no `--target-dir`, it creates a managed PR checkout
under `artifacts/local-review-<number>/target`. To use an already-cloned
checkout, or to review an issue, pass `--target-dir <path>`:

```bash
pnpm run review -- --local-only \
  --target-repo owner/name \
  --item-number 123 \
  --target-dir ../target-checkout
```

Pre-submission committed-range review uses the same full proof-aware review
without requiring an open GitHub item. From the clean checkout containing the
branch to review:

```bash
pnpm run review -- --local-range \
  --target-repo openclaw/clawsweeper \
  --base origin/main
```

Without `--target-dir`, `--local-range` reviews the checkout where the command
was invoked. Pass `--target-dir <path>` when invoking ClawSweeper from a
different checkout. The range is `merge-base(<base>, HEAD)..HEAD`, includes
committed work only, and refuses a dirty working tree. `--body-file` can supply
the proposed PR body and `--additional-policy` can layer an extra local policy.

This mode withholds GitHub token variables, points `gh` at an empty config
directory inside the run artifacts, disables Codex web search, skips host-side
URL/media preprocessing, and makes no GitHub reads or writes. It is not
air-gapped: the Codex model invocation still uses its configured network
service. Repeated local reviews preserve the latest local result in the same
bounded review-history format used by hosted review. The next run receives the
previous findings and dispositions so it can verify fixes and avoid re-raising
resolved findings. Exact-item history stays in the selected artifact directory.
Committed-range history stays under `.git/clawsweeper/reviews/` and is reused
only for the same target repository and resolved base when its reviewed commit
is an ancestor of the current `HEAD`; changing the base or switching to an
unrelated branch starts a fresh history.

Reports use a unique
`.git/clawsweeper/reviews/local-range-<time>-<pid>/` directory so the default
run leaves the checkout clean. `--artifact-dir` overrides that location.

Read the report at `artifacts/local-review-<number>/<number>.md`. Key fields are
`review_status`, `main_sha`, `pull_head_sha`, `decision`, `confidence`, and
`Review Findings`. Do not run `apply-artifacts` or `apply-decisions` unless you
intentionally want to move reports into durable state or sync GitHub comments.
Add `--verbose` when you need the underlying `[review]` diagnostic logs.

If you prefer API-key auth, keep the key out of the repository and shell
history. For POSIX shells:

```sh
printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key -c 'service_tier="fast"'
unset OPENAI_API_KEY
```

For PowerShell:

```powershell
$env:OPENAI_API_KEY = Read-Host "OpenAI API key"
$env:OPENAI_API_KEY | codex login --with-api-key -c 'service_tier="fast"'
Remove-Item Env:OPENAI_API_KEY
```

`--local-only` preserves local Codex auth environment variables only for that
advisory local run. Normal production review workers still strip Codex, OpenAI,
and GitHub write credentials before invoking the model. Set `CODEX_BIN` to an
absolute executable path if the desired Codex CLI is not the first spawnable
binary on `PATH`.

Apply unchanged proposals later:

```bash
source ~/.profile
corepack enable
pnpm run apply-decisions -- --target-repo openclaw/openclaw --limit 40 --apply-kind all --skip-dashboard
```

Sync durable review comments without closing:

```bash
source ~/.profile
corepack enable
pnpm run apply-decisions -- --target-repo openclaw/openclaw --sync-comments-only --comment-sync-min-age-days 7 --processed-limit 1000 --limit 0 --skip-dashboard
```

Manual review runs are proposal-only. Use `apply_existing=true` to apply unchanged
proposals later. Scheduled apply runs process both issues and pull requests by
default, subject to the selected repository profile; pass `target_repo`,
`apply_kind=issue`, or `apply_kind=pull_request` to narrow a manual run.

Scheduled runs cover the configured product profiles. `openclaw/openclaw` runs
normal backfill every 5 minutes with up to 89 review shards when the system is
quiet; `openclaw/clawhub` runs on offset review/apply/audit crons so its reports
live under `records/openclaw-clawhub/` without colliding with default repo
records. `openclaw/clawsweeper` has a scheduled read-only audit row and is
available for manual and event self-review smoke tests. Broad hot-intake sweeps
cap scheduled fan-out at 44 one-item shards per run when quiet; manual normal
backfill can use up to 89 shards, while exact event reviews still use one shard.
Normal review and hot intake are
background lanes, so they shrink automatically while repair or exact-item work
is active. Throughput defaults live in
[docs/limits.md](docs/limits.md) and `config/automation-limits.json`.

### Worker Budget

ClawSweeper has one main capacity knob:
`config/automation-limits.json` -> `workers.max`. The current value is `128`.
This is a Codex worker budget, not a GitHub Actions runner limit. Deterministic
exact-review publishers, comment routers, and lease reconcilers are
control-plane workflows and do not consume these 128 slots.
Lane limits are derived from that number: normal review defaults to 89 shards
for manual/backstop and scheduled runs, hot intake up to 44 shards, and
existing repair/issue implementation lanes use 40% of `workers.max`, currently
51 live workers. Imported gitcrawl cluster repair allows 2 live workers by default.
Exact-item review, repair, and issue implementation are priority work; normal
review and hot intake are background work and automatically
yield when priority work is active. Exact-item runs use a durable Worker queue
that coalesces item deliveries, leases at most 128 concurrent reviews, and admits
up to 120 active exact reviews per target repository. Other lanes retain the
checked-in 128-worker scheduling model. A separate 194-slot exact-review
Actions budget supports the production maximum of 40 publisher slots, the
enforced 16-slot control-plane reserve, and 10 additional slots of current
configuration headroom even when all 128 review leases are active.
Use `workers.max` first when turning total Codex usage up or down; use
`lanes.repair.cluster_max_live_runs` to tune the imported legacy cluster-repair
lane separately, and individual environment overrides only for temporary
lane-specific exceptions.

Target repositories can opt into event-level latency by installing the
dispatcher workflow in [docs/target-dispatcher.md](docs/target-dispatcher.md).
The dispatcher sends `repository_dispatch` events to this repository with the
target repo and exact item number; ClawSweeper then runs one event job that
reviews, comments, and checks immediate safe apply instead of waiting for the
next hot-intake cron or bulk publish lane.

## Checks

```bash
pnpm run check
pnpm run oxformat
```

`oxformat` is an alias for `oxfmt`; there is no separate `oxformat` pnpm package.
The `CI` GitHub Actions workflow uses the latest Node release and runs
`pnpm run check` on pushes, pull requests, and manual dispatches. The check gate
includes the full test suite, a strict changed-surface coverage threshold, and a
full compiled-repo coverage ratchet. It builds once, runs independent static and
lint checks with bounded phase-level parallelism, and uses the full coverage run
as the single source of complete test results. Standalone `test`, `test:repair`,
and coverage commands still build their required outputs; their internal
`*:no-build` variants are for the composed gate after `build:all`.

Node test files are expanded by `scripts/run-node-tests.mjs` instead of the
shell, so the same targets work on Linux, macOS, and Windows. The runner defaults
to the smaller of the machine's available parallelism and 16, prints the chosen
value, and accepts an explicit `--test-concurrency` override for diagnostics.

## GitHub Actions Setup

Required secrets:

- `OPENAI_API_KEY`: OpenAI API key used by the per-job local Codex Responses
  proxy. Codex subprocesses inherit only the proxy-backed `CODEX_HOME`, not the
  raw API key.
- `CLAWSWEEPER_APP_CLIENT_ID`: public GitHub App client ID for `clawsweeper`.
  Currently `Iv23liOECG0slfuhz093`.
- `CLAWSWEEPER_APP_PRIVATE_KEY`: private key for `clawsweeper`; plan/review
  jobs use a short-lived GitHub App installation token for read-heavy target API
  calls, and apply/comment-sync/check jobs use the app token for comments,
  closes, and optional checks.
  Keep App credentials scoped to the `actions/create-github-app-token` step.
  Review shards run Codex over attacker-controlled issue/PR text, so
  `codexEnv()` also strips these App variables before spawning Codex.

Token flow:

- Review jobs create an isolated per-run `CODEX_HOME`; steerable repair jobs
  use a stable per-work cache path. Both start a local Responses proxy from
  `OPENAI_API_KEY`, write proxy-only Codex config there, and run Codex without
  OpenAI or Codex token environment variables.
- Steerable repair jobs cache only the app-server `sessions/` directory and
  ClawSweeper thread-id file. Planning and execution resume the same logical
  Codex thread; CrabFleet credentials stay in the wrapper and are stripped
  before Codex starts.
- ClawSweeper uses the `clawsweeper` GitHub App token for read-heavy target
  context.
- Apply mode uses the same app token for review comments and closes, so GitHub
  attributes mutations to the app bot account instead of a PAT user.
- GitHub-isolated `pnpm local-review` does not mint target write/check
  credentials or publish hosted commit-review results; Codex still connects to
  the configured model service.
- The ClawSweeper GitHub App commits only the remaining operational paths to
  `openclaw/clawsweeper-state`; reports publish to the canonical Worker store.

Required `clawsweeper` app permissions:

- Contents: read/write, for report commits, repair branches, and repository
  dispatch inputs that need a contents-scoped installation token.
- Issues: read/write, for issue comments, labels, closes, and maintainer command
  authorization context.
- Pull requests: read/write, for PR comments, labels, merge readiness, repair PRs,
  and guarded automerge.
- Workflows: write, for adopted automerge repairs that need to rebase or update
  source branches containing `.github/workflows/*` changes.
- Actions: read/write on `openclaw/clawsweeper`, for run cancellation, manual
  dispatch, and self-heal.
- Checks: read/write on target repositories, for structural cache state and
  commit Check Run publication.
- Commit statuses: read on target repositories, for structural cache state.

Optional steerable Action setup:

- secret `CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN`: CrabFleet OpenClaw service
  token used only to register or resume the Action session
- variable `CLAWSWEEPER_STEERABLE_CODEX=1`: enables app-server thread
  persistence and browser steering in the repair cluster workflow
- variable `CLAWSWEEPER_CRABFLEET_URL`: optional CrabFleet API/dashboard base;
  defaults to `https://crabfleet.openclaw.ai`

See
[`docs/steerable-repair-automation.md`](docs/steerable-repair-automation.md)
for the registration, token, heartbeat, thread-resume, steering, completion,
dashboard, and recovery contracts.

ClawSweeper no longer falls back to PAT-based write tokens. If the GitHub App
installation does not grant the requested permission set, the workflow fails at
token creation instead of silently switching identity.

Target repository setup:

- install the issue/PR dispatcher from
  [docs/target-dispatcher.md](docs/target-dispatcher.md) for exact item event
  reviews
