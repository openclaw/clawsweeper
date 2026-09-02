# OpenClaw Bay

- Status: active public observer guide
- Owner: ClawSweeper maintainers
- Source of truth: `dashboard/bay-page.ts`, public Worker and queue projectors,
  Bay tests, and the read-only `/bay` route
- Last verified: `openclaw/clawsweeper@647503ec44b8e777dd172adf974a945367da0d19`
- Update when: lane names, stage mapping, public projection or completeness
  rules, private-state ownership, routes, or navigation changes

OpenClaw Bay is a public, indexable, read-only visualisation of the live
ClawSweeper pipeline. It lives at `/bay` on the existing dashboard Worker and
turns bounded activity into animated rows moving across a shoreline. The count
maps remain the authoritative pipeline view. A bounded card sample may also
show a canonical repository and issue or pull-request number when the
repository is on the deployment's verified-public allowlist. It is linked from
the Overview, issue-triage, and PR-proof headers as a normal ClawSweeper
web-page destination.

Bay is an observer-only surface: it displays bounded public status and may
provide view-only navigation to verified-public GitHub repository, item,
workflow-run, and job pages. Those canonical GET links are references, not
action controls. Bay never calls GitHub from the browser or triggers or offers
queue, workflow, GitHub, DLQ, recovery, deploy, rollback, or other mutation
controls. Its public visibility is not an authorization boundary; any future
restricted surface would require separate authentication or access-control
design.

## Historical Review Artifact

![Historical OpenClaw Bay review artifact](openclaw-bay-demo.jpg)

[Watch the 32-second browser recording](openclaw-bay-demo.mp4). It shows the
historical shoreline, movement between lanes, and terminal pools from the
earlier review-time UI. It does not describe or prove the current bounded
public-reference contract. The recording is a 1280×720 H.264 review artifact with
audio and capture metadata removed.

The lightweight records under `docs/proof/openclaw-bay` describe historical
review-time evidence. The full-resolution trace and storyboard introduced in
commit `1a5becc69fc1bdbc11e16aa22f5caaa44f05a59d` have been pruned from the docs
tree and remain available in git history. The package's recorded source
identifier, `0cf6b147fe86f56e4ec8c77352e3d31433e3a1d2`, is not reachable from current
repository history, so neither the records nor archived media are current
proof. Current pull requests must publish exact-head proof and provenance in
the PR body. The historical run used the real page and artwork with a fully
synthetic, redacted status sequence and made no live dashboard reads.

## What It Shows

Bay uses one closed set of six active stages:

- Arriving
- Setting up
- Reviewing
- Publishing
- Repair cove
- Applying & writing

Each complete public activity snapshot contains exactly those six queue counts,
the same six live counts, and a total equal to their sum. Counts are bounded
non-negative integers; extra stage names and unexpected fields are discarded.
The Worker privately correlates queue and live state long enough to subtract
active overlaps from the queue counts. It drops that correlation material
before serialization, so the two public maps are disjoint without publishing a
join key.

The page draws the bounded verified-public reference sample as cards. Each card
contains only a canonical `owner/repository`, positive issue or pull-request
number, closed Bay stage, and closed queue/live source. The browser constructs
the canonical GitHub issue URL from those fields; GitHub resolves pull-request
numbers on that route. Clicking a referenced card opens a local detail blade
with the closed stage and source plus canonical links to the repository and
issue or pull request. When the action belongs to a verified-public repository,
the blade also reconstructs canonical run and job links and shows a closed step
timeline: fixed step categories, completed steps in green, and the current step
in orange. Raw workflow and step names never enter the public projection.
Repository filters and the finder accept an item number or
`owner/repository#number`. They search only the current bounded sample and do
not call GitHub. Press `/` outside form controls to focus the finder. The
shortcut stays inactive while a detail blade is open. The `+N more` control opens
the same bounded sample in a blade; it does not imply that unsampled aggregate
work has an identity.

The reference exception is intentionally narrow. Verified-public repository,
issue or pull-request numbers, GitHub run and job identifiers, a validated
action start timestamp, and closed action/step categories are allowed. The
browser constructs links from those fields. Workflow titles, item titles, raw
step names, source URLs, query strings, raw failure payloads, failure keys,
credentials, tokens, internal queue keys, and repositories outside
`PUBLIC_BAY_REPOS` remain excluded. Invalid configuration yields no public
references. Malformed or over-cap samples fail closed without weakening the
aggregate counts.

Completed, failed, and cancelled pools contain explicitly observed terminal
outcomes. A terminal card carries the same verified-public repository and item
reference, and its closed action timeline when available; otherwise it remains
count-only. A
disappearing worker is never treated as successful. Because completed-job
evidence can trail the active feed, an unconfirmed disappearance remains in the
checking state for up to 150 seconds and enters a terminal pool only after
explicit outcome evidence arrives.

The terminal buffer is deliberately small. At 20 proved outcomes, the tide
animation clears the visible pools. Private Bay state retains fewer than 20
buffered outcomes, the most recent 20 washed outcomes, and at most 256
deduplication entries under the existing seven-day event TTL. The public
projector retains only bounded tide values, closed outcome categories, and safe
timestamps. The Preview tide button changes only the browser animation and does
not mutate stored state.

The exact-review control board above the shoreline separates review admission
from result publication. It shows aggregate lane totals, bounded 6-hour,
24-hour, or 7-day history, and closed observed cause counts. It does not infer
an upstream reason for a cancellation or failure and exposes no queue,
recovery, deploy, or rollback controls.

The durable lifecycle board contains three inventory counts and six closed
lifecycle-lane counts: pending, acknowledgement pending, completed, superseded,
requeued, and terminal attention. A complete projection may include at most 24
cards drawn only from `PUBLIC_BAY_REPOS`. Each card contains the canonical
repository and issue or pull-request number, a closed lane/state, a current
revision boolean, and a canonical timestamp. The browser constructs the GitHub
item link. Revision identifiers, target keys, facts, titles, raw URLs, and
failure detail remain private. The store scan is bounded at 10,000 records and
returns an unavailable projection rather than a partial result beyond that
limit.

Queue completion preserves a previously committed final lifecycle outcome when
a later callback reports a different final result. Explicit requeue transitions
remain available, and a requeued revision can acquire its next terminal outcome.
The lifecycle store still rejects conflicting direct terminal writes; completion
and acknowledgement drivers use the committed outcome as their authority.

## Completeness And Private State

Combined queue/live activity is published only when the queue projection, the
active-worker census, and their closed schemas are complete. An incomplete or
over-cap worker census, a stale snapshot, malformed nested data, or an unsafe
legacy cache shape yields an unknown aggregate: `activity.complete` is false
and the queue map, live map, and total are unavailable. Bay does not substitute
a partial count or recover detail from an unbounded field. Fresh responses,
cached responses, and restart or legacy paths all pass through the same
fail-closed public projection.

The ExactReviewQueue Durable Object may retain the internal metadata required
for ownership, deduplication, retries, and restart recovery. That state is
binding-only and is not itself a public response. Before the Worker serves the
durable lifecycle view, it validates the complete private shape and creates a
new fixed aggregate object. Unknown, stale, malformed, mixed, or over-cap state
produces an unavailable projection with no inventory, lane, or sample payload.
This boundary preserves useful private operations state without making it a
public or cache-serializable identity surface.

## Data And GitHub API Load

Bay is a presentation over the cache-backed public `/api/status` snapshot and
the bounded `/api/durable-lifecycle-bay` projection. It adds no
browser-to-GitHub requests and no new GitHub REST or GraphQL query path. Active
stage counts, the bounded verified-public reference sample, explicit terminal
outcomes, and observed completion timing are derived from data already
collected for the Overview page. Overview uses the same projected reference
sample for its public-work cards, search, and equivalent public-reference
blade. Private correlation fields used during collection are not part of
either rendered surface or blade. Crab chat uses only the validated action
start timestamp to report an elapsed wait; if that timestamp is unavailable it
uses the generic wording.

Bay polls the Worker every 20 seconds, compared with Overview every 15 seconds:
three rather than four browser status requests per minute after initial load.
That is 25% fewer requests to the Worker, not a claim of 25% fewer GitHub API
calls. The existing 20-second server cache, snapshot age, edge location, and
other viewers determine when either page causes a GitHub refresh. In
particular, Bay's 20-second timer can align with cache expiry, so Bay does not
claim a lower upstream GitHub refresh rate than Overview.

The displayed end-to-end timing is an observed sample of the latest completed
jobs found in the previous hour, not a complete one-hour census. Per-lane wait
times are not shown because the current data cannot support them accurately.

## Assets And Deployment

The page, status API, and image assets all belong to `openclaw/clawsweeper`:

- `dashboard/bay-page.ts` renders the page.
- `dashboard/worker.ts` serves `/bay`, permanently redirects legacy `/bay-demo`
  bookmarks, and derives the bounded Bay state.
- `dashboard/public/bay-assets/` contains the three WebP assets.
- `dashboard/wrangler.toml` binds that public asset directory.
- `.github/workflows/dashboard.yml` deploys the existing
  `clawsweeper-status` Worker to `clawsweeper.openclaw.ai`.

The Bay HTML is `no-store`, frame-blocked, and protected by a content security
policy. `/bay` is the single canonical public route; `/bay-demo` is retained
only as a permanent redirect to the query-free canonical route.

## Local Proof

Start the Worker:

```bash
pnpm run dashboard:dev
```

Then open <http://127.0.0.1:8787/bay>. When local GitHub telemetry is
unavailable, the localhost page may read the existing public, cache-backed
production status snapshot for visual proof. The hosted page remains
same-origin in its request behavior; the CSP allows only self and OpenClaw
HTTPS subdomains so Wrangler's localhost preview can reach that production
snapshot.

The deployment smoke test also checks the Bay route, security headers,
legacy `/bay-demo` redirect, other unpublished route variants, and all three WebP assets:

```bash
pnpm run dashboard:smoke -- http://127.0.0.1:8787
```
