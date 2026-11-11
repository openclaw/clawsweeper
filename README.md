# 🦞🧹 ClawSweeper

![ClawSweeper banner](docs/assets/readme-banner.jpg)

ClawSweeper is the conservative review bot for OpenClaw repositories. It keeps
the backlog reviewed, keeps maintainer-visible GitHub comments tidy, and applies
unchanged, high-confidence close proposals through deterministic safety gates.

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
- closes only unchanged, high-confidence, policy-allowed proposals
- routes maintainer commands `@clawsweeper review`, `@clawsweeper re-review`,
  `@clawsweeper explain`, and `@clawsweeper stop`
- can acknowledge maintainer comment commands through an optional GitHub App
  webhook before the GitHub Actions fallback starts
- can review local branch ranges with repository and GitHub access kept local
  while Codex connects to the configured model service
- publishes canonical review records to the Cloudflare Worker, action ledgers
  and assets to R2, and the remaining operational state to
  `openclaw/clawsweeper-state`

The [oversized PR close lane](docs/oversized-pr-close-policy.md) proposes closing
pull requests above 50,000 changed lines before hydration, scanning, or model
review, with a maintainer `size: accepted-large` exemption. See the
[close-policy index](docs/README.md#close-policy) for the guarded close lanes.

ClawSweeper is not a generic auto-close bot. Review is proposal-only, apply is
guarded, Codex never gets write credentials during review, and every GitHub
mutation is rechecked against live target state immediately before it happens.

## Capabilities

### Issue and PR Reviews

Scheduled runs scan open issues and pull requests, while target repositories can
forward exact issue/PR events through keyless OIDC Worker intake for low-latency
one-item reviews. Each review writes
`records/<repo-slug>/items/<number>.md` with the decision, evidence, proposed
maintainer-facing comment, runtime metadata, and GitHub snapshot hash.

PR checkout preparation captures only the recursive tree's entry types, object
IDs, sizes, and truncation flag from the GitHub CLI. This keeps path and URL
metadata from exhausting the response buffer while preserving the existing
checkout size limits and rejection of incomplete or malformed trees.

Media proof preparation recognizes image/video filename extensions and GitHub
attachment URLs, including legacy repository asset links. Attachments are fetched
with GET and classified by the response content type; images are saved locally
and videos are probed and converted to contact sheets. PR patches and supplemental
body excerpts never supply host download URLs.

ClawSweeper syncs one marker-backed public review comment per item and edits it
in place instead of posting repeated completed reviews. Scheduled review workers
use a separate temporary status comment for lease coordination. Command-triggered
exact reviews instead rewrite their existing acknowledgement and use the durable
queue claim as their coordination lease, so they do not add a second visible status
comment. Exact-review workers verify queue ownership before generation and during
finalization. Temporary lease comments are removed after publication. Pull request
comments include hidden verdict/action markers for trusted automation ownership.
See
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

### Commit Reviews (retired)

The push/manual commit-review lane was retired in July 2026. Use
`pnpm local-review` for GitHub-isolated local branch reviews.

### Operations

Repository-specific rules live in `src/repository-profiles.ts`, so OpenClaw,
ClawHub, and ClawSweeper can share the same engine while keeping different apply
limits. Review supports manual workflow dispatch, reruns, and backfills.

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

Maintainer-authored issues and PRs, and items labeled `maintainer`, created from
2026-10-15 03:50 UTC are reviewed like everyone else's: a PR gets one automatic
review and later reviews need a request; an issue follows the ordinary issue
cadence. Older maintainer items stay excluded from automatic reviews and
scheduled sweeps, and got one opening/ready reminder explaining how to opt in.
Only request `@clawsweeper review` when a review is needed and the
work and validation are complete; agents must not request reviews automatically
or repeat requests while one is queued or running. A one-off request does not
opt future pushes into reviews, but it stays open until it is answered: if the
item changes while it is reviewed, ClawSweeper re-reviews and still answers that
request. The retired `clawsweeper:autofix` and `clawsweeper:automerge` labels no
longer change review admission; they still protect an item from close proposals.

## Maintainer Commands

The canonical comment commands are:

```text
@clawsweeper review
@clawsweeper re-review
@clawsweeper explain
@clawsweeper stop
```

`review` and `re-review` request a fresh read-only issue/PR review; `explain`
summarizes the current result, and `stop` prevents further automatic handling.
Stop adds `clawsweeper:human-review` before it removes repair-loop protection
labels. A failed label write fails the command without a reply, and a later run
retries it.
The router checks repository permissions and the command's current source
comment before accepting work. Contributors may request a review of their own
items under the configured authorization policy.

The GitHub App webhook durably records eligible review comment versions before
acknowledging them. Exact item work is coalesced and leased by the Worker, so a
webhook burst does not create capacity-waiting Actions runners. Repair, autofix,
automerge, issue implementation, fix-ci, and address-review commands are retired.

## Dashboard

Live dashboard and generated state: https://github.com/openclaw/clawsweeper-state

Live pipeline dashboard: https://clawsweeper.openclaw.ai/

The Cloudflare control plane exposes read-only queue, review, publication,
and health telemetry. It never delegates GitHub mutations to the browser.
See [`docs/live-dashboard.md`](docs/live-dashboard.md).

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

ClawSweeper has two operational lanes:

- review lane: scheduled and event-driven issue/PR reviews, durable reports, and
  public review comment sync
- apply lane: guarded close/comment mutations, audit, reconcile, and state
  publishing

### Scheduler

The issue/PR scheduler decides what to scan and how often. New and active items
get more attention; older quiet items fall back to a slower cadence. Detailed
scheduling, capacity, and monitoring behavior is documented in
[`docs/scheduler.md`](docs/scheduler.md).

- hot/new and recently active items are checked hourly, with a 5-minute intake
  schedule for the newest queue edge
- target repositories can forward issue and PR events through OIDC Worker intake;
  the queue leases a dedicated executor to
  review one item, sync the durable comment, and apply only safe close
  proposals for that same item
- pull requests and issues younger than 30 days are checked daily once they
  leave the hot window
- older inactive issues are checked weekly
- apply wakes every 15 minutes and exits quickly when there are no unchanged
  high-confidence close proposals

### Review Lane

Review is proposal-only. It never closes items.

- The `ClawSweeper Review Plan` workflow (`review-plan.yml`) selects due items
  and offers them to the shared exact-review queue.
- Manual review runs in `review-plan.yml` can select `item_number` or comma-separated
  `item_numbers`, target branch, prompt, timeout, and hot-intake mode. Broad runs
  use the same queue capacity and pacing as scheduled feeds; per-run `batch_size`, `shard_count`,
  and `apply_after_review` inputs are retired. Use the separate `sweep.yml` `apply_existing`
  lane to apply eligible proposals.
- Each admitted item gets its own review workflow for the selected target.
- Codex reviews use `gpt-6.1-sol` with medium reasoning in the direct API auth
  modes (`login` and `proxy`); `clawrouter` mode instead runs its private
  inference alias. Issues and pull requests authored by an OWNER, MEMBER, or
  COLLABORATOR, or by anyone whose live repository permission is `write`,
  `maintain`, or `admin`, use priority (fast) service; other items use standard
  service. Write access alone does not make an item maintainer-authored for
  close policy. Assist answers always use priority service because only
  write-access maintainers can request them. Sweep planning and close-coverage
  proofs use the configured ordinary-item defaults. Reviews have
  a 10-minute per-item timeout.
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

Reviewer decisions come only from the typed `review_record` stored in each report.
A missing or unreadable record requires a fresh review: apply records
`skipped_changed_since_review` without calling GitHub, and decision packets and
public decision renderers do not infer decisions from report prose. The completed
backfill command and workflow have been retired.

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
It defaults to all item kinds, no age floor, a 2-second close delay, and 40
fresh closes per checkpoint, with a hard cap of 40 to keep each GitHub App
token within its lifetime. After a checkpoint closes at least one item, it
queues another apply run with a fresh token; a saturated scan that closes
nothing stops and waits for the next scheduled tick instead of self-dispatching
indefinitely.

Apply health keeps the scheduler-admitted `apply_ready_count` separate from the
full promotion backlog, cooldown-eligible probes, proof-required work, guarded
retries, and inconsistent records. Its cycle estimate covers work actionable in
the current scheduler window rather than presenting every probe as immediately
closable.

All review execution uses the exact-item queue; broad runs only feed its planner. The read-only reviewer
handles only the selected item, uploads a hash-bound GitHub Actions artifact,
enqueues a separate durable publication lease, and then releases its review
lease without checking out or pushing the state repository. The queue retries
publication independently, so a cancelled publisher does not rerun Codex. The
source fallback uses adaptive minimum/base/maximum values of 4/24/48; production
overrides them with 8/32/32 and enables direct
publication plus up to 8 concurrent size-8 batches, with two isolated preparation
workers per batch. The Durable Object validates
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
Durable Object lane while batch publishers remain per-target serialized. Exact publishers and the separate issue-implementation backfill workflow retain their guarded intake. Publication still does not claim an
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

### Commit Review Lane (retired)

The hosted commit-review lane was retired in July 2026 (zero successful runs in
its final month). The local, GitHub-isolated review engine survives as
`pnpm local-review`; see [docs/commit-sweeper.md](docs/commit-sweeper.md).

### Safety Model

Native reviews require host-owned TruffleHog admission before any model-backed
checkout inspection or review. The host scans the explicit initial prompt and
schema plus complete raw before/after blobs and the full introduced diff. Scan
coverage is independent of the 80-path/24K-character display evidence limits.
Clean text-converted checkouts retain both canonical Git and raw working bytes
in scan coverage. The host never starts a target-bundled autoreview helper or
second reviewer.

Hosted Codex and OpenClaw setup share `.github/actions/setup-review-tools`, which
caches only the checksum-pinned release archive. Every setup verifies its bytes,
extracts a fresh private binary, checks the exact version, and runs the benign
scan before advertising its path. Cache misses and corrupt archives use the
pinned download; installed binaries and review data never enter the Actions
cache. For local review,
ClawSweeper first qualifies a trusted host executable outside both checkouts; when it
is absent or reports a different TruffleHog release, it bootstraps the exact checksum-pinned release asset into a
user-owned cache outside both checkouts. The local bootstrap accepts no URL or
version override, verifies the download and cached executable, and runs a clean
environment version check before scanning. Missing tools, unclassified findings, scan errors, source
drift, incomplete ancestry/objects, changed gitlinks, and LFS pointers refuse the
review. The scan stages at most 256 MiB in private external temporary files and
uses the remaining review deadline; it never silently truncates or bypasses.
Diagnostics omit scanner output and source values. Restore prerequisites or
remove sensitive input before retrying a refusal.
Managed scanner setup failures also emit one bounded stderr diagnostic with a
fixed phase and category, and the observed HTTP status when a download is
rejected. Raw network errors, response bodies, and local paths remain omitted;
the review still refuses with `scanner_unavailable` before starting a provider.
Exact-review failure manifests distinguish a native output/scan-contract failure
from an unclassified finding. The latter records the first blocking finding's
bounded detector metadata and host-staged material identity: prompt, schema,
additional input, raw diff, patch, raw working bytes, or Git blob. Source
references contain Git revisions and hashed paths, with at most four references
and their total count. No raw paths, matched values, literal digests, or
verification messages are retained; this provenance does not authorize a finding.

TruffleHog runs with `--results=verified,unknown`: it refuses credentials it
could log in with and credentials it could not test, and lets through
credentials it tested and found dead. Test data almost always lands in the
"could not test" group because its host does not exist. The host therefore
classifies an unverifiable JDBC, URI, MongoDB, FTP, or Postgres finding as
non-sensitive when every host it names is reserved for testing or loopback:
`*.test`, `*.example`, `*.invalid`, `*.localhost`, `localhost`,
`example.com`/`.net`/`.org` and their subdomains, `127.0.0.0/8`, and `::1`
(RFC 2606 and RFC 6761). A credential for such a host cannot unlock anything
reachable. Verified findings, other detectors, any public or unparseable host,
and incomplete scans still refuse. Host-generated Git object IDs in diff
`index` lines that the Cloudflare global-key detector mistakes for keys are
proven to be that metadata and require a masked re-scan to clear everything
else. There is no per-file allowlist. See `src/agent-input-scan-classifier.ts`.
After successful cleanup and final source fences, each classification emits a
host-side structured stderr notice with `event`, `classification`, `detector`,
and `findings` entries containing `blob`, `scannerLine`, `decoder`, and
`occurrences`. Raw values and verification diagnostics never appear in it.

Generated review and repair prompt diagnostics retire the previous attempt's
copy before admission and persist only successfully scanned exact prompt bytes
with owner-only access. Commit review, assist, and close-coverage proof do not
retain unused prompt copies. Original input records remain operator-owned outputs.

This admission boundary is not universal provider-egress scanning. Automatically
loaded project docs, resumed/steered history, later tool results, and unchanged
repository history are outside its scope. Planning, assist, and close-coverage
calls scan their explicit prompt/schema; they do not attest a source review.
No dashboard projection or observer API changes; OpenClaw Bay is unaffected.

Maintainers can run the dispatch-only `Hosted native review scan smoke` job in
`ci.yml`. It uses the existing `OPENAI_API_KEY` and `CLAWSWEEPER_MODEL` secrets
only during host setup, with no App mutation token. The proof artifact records
zero Codex launches on refusal, then proves the production review path completed
a read-only command over a synthetic committed diff before returning a
schema-valid decision and terminal turn. Raw commands, output, prompts,
transcripts, fixture values, runner identities, and model identities stay in
ephemeral private files; the uploaded artifact contains only booleans and counts,
including explicit false coverage flags for external repositories, review
publication, and queue lifecycle.

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
- CI keeps the target checkout read-only and gives Codex issue/PR reviewers a managed
  network proxy restricted to the hosts in
  [the review permission profile](.github/actions/setup-codex/review-permissions.toml):
  GitHub, npm, Node, MDN, and OpenClaw documentation. Limited mode inspects HTTPS
  and permits only GET/HEAD/OPTIONS; other hosts are blocked. When supplied by the
  review job, Codex tools receive the target repository's read-only GitHub App token
  only as `GH_TOKEN` (contents, issues, and pull requests read; expires within the
  hour). Use authenticated GitHub reads to avoid public rate limits; never put
  the token in a URL, log it, or send it to a non-GitHub host. Without a token,
  use public endpoints and pre-fetched context. Read downloaded media through
  the local proof manifest. A blocked request is not evidence against a PR.
  Setup must prove allowed HTTPS, denied unlisted HTTPS, and denied checkout
  writes before reviews can publish. Offline local reviews retain their existing
  network restriction. The `review-network-smoke` PR CI job proves the same
  enforcement on Ubuntu without secrets. Capability text follows the active
  runner: OpenClaw uses gateway network execution without the Codex proxy or
  filesystem sandbox, strips GitHub tokens through its final child environment
  allowlist, and must keep the checkout read-only by instruction.
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
reviews from that state. The separate `audit.yml` workflow refreshes audit state
on the existing six-hour schedules. Every manual dispatch of `audit.yml` runs an
audit; it accepts only `target_repo`, with no `audit_dashboard` input:

```bash
gh workflow run audit.yml -f target_repo=openclaw/openclaw
```

Review planning dispatch uses `review-plan.yml`; target fanout dispatches review
plans there and audits to `audit.yml`. Exact event review and apply remain in
`sweep.yml`. The read-only audit lane covers `openclaw/openclaw`,
`openclaw/clawhub`, and `openclaw/clawsweeper`; it falls back to public
workflow-token reads when the ClawSweeper App token is not available for a target.

## Local Run

Requires Node 24.

Issue/PR sweeper:

```bash
source ~/.profile
corepack enable
pnpm install
pnpm run build
pnpm run plan -- --target-repo openclaw/openclaw --batch-size 5 --shard-count 89 --max-pages 250 --codex-model internal
pnpm run review -- --target-repo openclaw/openclaw --target-dir ../openclaw --batch-size 5 --max-pages 250 --artifact-dir artifacts/reviews --output-retention debug --codex-model internal --codex-timeout-ms 600000
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
pnpm run codex:local:check -- --diagnostics
pnpm run review -- --local-only --target-repo owner/name --item-number 123
```

`--diagnostics` checks the selected Codex binary and its login status without a
model request. It does not prove model access or review readiness. Omit
`--diagnostics` to also run the existing model smoke test, which consumes model
usage.

`review` is the single issue/PR review command. `--local-only` makes it an
advisory local run: it skips the review-start placeholder comment, defaults the
Codex service tier to `fast` for local CLI compatibility, and preserves local
Codex auth. Persistent output is opt-in. The default `--output-retention none`
uses private run-owned scratch, prints the result, and removes scratch after
ordinary completion or a caught failure. Operating-system termination keeps its
default behavior so cancellation is not delayed by synchronous review work; an
unhandled signal or `SIGKILL` can leave the bounded private scratch behind. Use
`--output-retention summary` for the report
without raw prompt/stream files, or `--output-retention debug` for the existing
artifact tree. An explicit legacy `--artifact-dir` still selects debug
retention. Summary destinations are created exclusively for one invocation.
Managed transient output is capped at 96 MiB/256 files; managed debug output is capped at
1 GiB/4,096 files with per-item allocations and at most 128 selected items per
invocation. Existing destination files count toward these limits. Metadata,
cached and fresh reports, and model output use the same run admission checks.
None and summary batches hash each item's report and stream evidence
into the canonical ledger before pruning that item's run-owned engine files;
summary retains only the reports. Required pull-request checkouts use a separate private run workspace:
tracked paths and Git blob sizes are admitted before materialization, with a 2x
allowance for bounded EOL expansion. Active filters, working-tree encodings, and
ident expansion are refused through a bounded private Git index compatible with
Git 2.39. That index reserves at most two files/128 MiB plus the workspace disk
reserve before creation and is removed after inspection. Checkout hooks are disabled. Projected and
actual checkout usage is capped at 200,000 files/2 GiB, and 1 GiB remains
reserved on each filesystem used for checkout materialization or missing Git
object acquisition; a shared filesystem is charged once. Media proof downloads
use at most 64 MiB per debug item and derived metadata/contact sheets at most
16 MiB, subject to the remaining run byte and file allowances. Non-debug items
use at most 32 MiB and 8 MiB respectively. Media admission reserves the non-media
output pools before starting another download or transcode. These are producer
admission and retained-output limits, not a peak disk quota: curl and ffmpeg can
temporarily exceed their requested limits, and arbitrary model-written files
are not quota-controlled. Oversized managed media output is discarded.
Existing or unrelated retained runs are
never pruned automatically.
`--result-format json` returns the same result as valid JSON. For a committed-range
review, add `--preflight` to generate a bounded advisory PR-body block in that
JSON without another model call or GitHub write. See the
[local preflight summary](docs/portable-review-receipt.md) for source checks and
limitations; it does not grant a hosted-review exemption.

```bash
pnpm run review -- --local-only \
  --target-repo owner/name \
  --item-number 123 \
  --target-dir ../target-checkout \
  --output-retention summary
```

Pre-submission committed-range review uses the same full proof-aware review
without requiring an open GitHub item. From the clean checkout containing the
branch to review:

```bash
pnpm run review -- --local-range \
  --target-repo openclaw/clawsweeper \
  --base origin/main
```

The built source checkout also provides a local-only entrypoint:

```bash
node dist/clawsweeper-local.js review --target-repo openclaw/clawsweeper --base origin/main
node dist/clawsweeper-local.js --help
node dist/clawsweeper-local.js --version
```

Both range commands use the same review engine, scanner, reports, history and
output cleanup. The local entrypoint loads that engine only when review starts;
help and version do not invoke Codex. Hosted admission, leases, action-ledger
publication and cache metrics stay in the hosted command. This is a source
checkout entrypoint, not an installable package. Diagnostics integration remains
separate; `codex:local:check` still invokes its existing model smoke test.

Without `--target-dir`, `--local-range` reviews the checkout where the command
was invoked. Pass `--target-dir <path>` when invoking ClawSweeper from a
different checkout. Local range review accepts unlisted and private repositories
without central registration. `--target-repo owner/repo` overrides the existing
`CLAWSWEEPER_TARGET_REPO` / `TARGET_REPO` selectors; otherwise the checkout's
GitHub `origin` supplies its identity. For a checkout without a GitHub origin,
pass `--target-repo` explicitly. Unlisted targets use their own `AGENTS.md`, docs,
tests, and Git history; known targets retain their full repository guidance.
Local profiles have empty close rules and do not enroll targets in hosted review
or apply. The range is `merge-base(<base>, HEAD)..HEAD`, includes
committed work only, and refuses a dirty working tree. `--body-file` can supply
the proposed PR body and `--additional-policy` can layer an extra local policy.

This mode withholds GitHub token variables, points `gh` at an empty config
directory inside private run scratch, disables Codex web search, skips host-side
URL/media preprocessing, and makes no GitHub reads or writes. It is not
air-gapped: the Codex model invocation still uses its configured network
service. Debug local reviews preserve the latest local result in the same
bounded review-history format used by hosted review. The next debug run receives
the previous findings and dispositions so it can verify fixes and avoid
re-raising resolved findings. Summary retention keeps only the current reports.
In debug mode, exact-item history stays in the selected artifact directory.
Committed-range debug history stays under `.git/clawsweeper/reviews/` and is reused
only for the same target repository and resolved base when its reviewed commit
is an ancestor of the current `HEAD`; changing the base or switching to an
unrelated branch starts a fresh history.

Summary/debug reports use a unique
`.git/clawsweeper/reviews/local-range-<time>-<pid>/` directory unless
`--artifact-dir` overrides it. Default no-retention runs leave no persistent
ClawSweeper review directory.

When output is retained at the default local artifact destination, read the
report at `artifacts/local-review-<number>/<number>.md`. Key fields are
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

Manual review runs in `review-plan.yml` are proposal-only. Dispatch `sweep.yml`
with `apply_existing=true` to apply unchanged proposals later. Scheduled apply runs process both issues and pull requests by
default, subject to the selected repository profile; pass `target_repo`,
`apply_kind=issue`, or `apply_kind=pull_request` to narrow a manual run.

Scheduled runs cover the configured product profiles. `openclaw/openclaw` runs
normal backfill every 20 minutes in `review-plan.yml`, alongside hot-intake schedules;
scheduled hot intake and normal backfill share a
32-worker cap in the durable review queue. `openclaw/clawhub` runs on offset review/apply/audit crons so its reports
live under `records/openclaw-clawhub/` without colliding with default repo
records. `openclaw/clawsweeper` has a scheduled read-only audit row and is
available for manual and event self-review smoke tests. Broad hot-intake sweeps
use the queue's scheduled admission budget; manual normal and hot-intake matrices
have at most 89 and 44 slots when quiet, while exact event reviews still use one shard.
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
Lane limits are derived from that number: manual normal review defaults to 89
requested shards and hot intake to 44; the interactive and expansion reserves
leave 104 background slots when quiet. Scheduled work has a separate
32-slot admission cap and fills what organic reviews leave of a 220-review/hour
admission target with a 24-item burst; hot intake is capped at 30/hour. Organic
work remains unconditional, so this is not a total-execution or spend cap. The
existing repair/issue implementation lanes use 40% of `workers.max`, currently
51 live workers. Imported gitcrawl cluster repair allows 2 live workers by default.
Exact-item review, repair, and issue implementation are priority work; normal
review and hot intake are background work and automatically
yield when priority work is active. Exact-item runs use a durable Worker queue
that coalesces item deliveries, leases at most 80 concurrent reviews, and admits
up to 64 active exact reviews per target repository. Other lanes use the
checked-in 128-worker scheduling model. A separate 194-slot exact-review
Actions budget supports the production maximum of 32 legacy publisher slots, the
enforced 16-slot control-plane reserve, and additional Actions headroom without
raising the Codex review ceiling.
Use `workers.max` first when turning total Codex usage up or down; use
`lanes.repair.cluster_max_live_runs` to tune the imported legacy cluster-repair
lane separately, and individual environment overrides only for temporary
lane-specific exceptions.

Target repositories can opt into event-level latency by installing the
dispatcher workflow in [docs/target-dispatcher.md](docs/target-dispatcher.md).
The keyless dispatcher sends the target repo and exact item number to the Worker
using GitHub Actions OIDC; ClawSweeper then leases one event executor that
reviews, comments, and checks immediate safe apply instead of waiting for the
next hot-intake cron or bulk publish lane. The independent App webhook remains
enabled; legacy `repository_dispatch` receivers remain during migration.

## Checks

```bash
pnpm run check
pnpm run oxformat
```

`oxformat` is an alias for `oxfmt`; there is no separate `oxformat` pnpm package.
The `CI` GitHub Actions workflow uses the latest Node 24 release. Locally,
`pnpm run check` runs the whole gate: the full test suite, a strict
changed-surface coverage threshold, and a full compiled-repo coverage ratchet.
It builds once, runs `check:fast` (static checks, build, lint, and the
changed-surface coverage), then the full coverage run. CI splits the same gate
into parallel jobs on pushes, pull requests, and manual dispatches:
`check fast gates` runs `check:fast`; `check tests (i/N)` jobs each run one
round-robin shard of the suite and upload its raw V8 coverage profiles; and
`check coverage` replays every shard's profiles through Node's own coverage
report with the same thresholds. The single `pnpm check` job passes only when
all of them pass. Standalone `test`, `test:repair`, and coverage commands still
build their required outputs; their internal `*:no-build` variants are for the
composed gate after `build:all`.

Node test files are expanded by `scripts/run-node-tests.mjs` instead of the
shell, so the same targets work on Linux, macOS, and Windows. The runner defaults
to the smaller of the machine's available parallelism and 16, prints the chosen
value, and accepts an explicit `--test-concurrency` override for diagnostics.
`CLAWSWEEPER_TEST_CONCURRENCY` sets the default for CLI runs when that flag is
absent, allowing controlled concurrency experiments through package scripts.
CI retains the adaptive default. The runner owns each target's coverage
thresholds (`--coverage`), and its `--shard`, `--coverage-out`, and
`--coverage-from` options are the CI shard and merge steps; see
`node scripts/run-node-tests.mjs --help`. Crabbox diagnostic bundles under `.crabbox/` are generated scratch
and are ignored by Git.

On Linux and macOS, the shared synthetic GitHub CLI fixtures clear
`NODE_V8_COVERAGE` before starting their Node stand-ins. Those fixtures do not
execute ClawSweeper source; interrupting their profile writes must not break the
real coverage report. Production subprocesses keep inherited coverage. Other
fixture launchers and Windows retain their existing behavior.

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

- Review jobs create an isolated per-run `CODEX_HOME`, start a local Responses
  proxy from `OPENAI_API_KEY`, write proxy-only Codex config there, and run Codex
  without OpenAI or Codex token environment variables.
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

- Contents: read/write for state publication and contents-scoped dispatch.
- Issues: read/write, for issue comments, labels, closes, and maintainer command
  authorization context.
- Pull requests: read/write for PR comments and labels.
- Actions: read/write on `openclaw/clawsweeper` for run cancellation and dispatch.
- Checks: read/write on target repositories, for structural cache state and
  commit Check Run publication.
- Commit statuses: read on target repositories, for structural cache state.

ClawSweeper no longer falls back to PAT-based write tokens. If the GitHub App
installation does not grant the requested permission set, the workflow fails at
token creation instead of silently switching identity.

Target repository setup:

- install the issue/PR dispatcher from
  [docs/target-dispatcher.md](docs/target-dispatcher.md) for exact item event
  reviews
