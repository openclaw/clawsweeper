# Stopped review attention: controlled real-runtime proof

- Status: active controlled proof recipe; result receipts are revision-specific.
- Owner: ClawSweeper maintainers
- Source of truth: production queue/lifecycle/public projection, status CLI and Bay; this directory owns only the loopback fixture and assertions.
- Verified scope: local workerd/SQLite, signed HTTP, compiled status CLI and Chromium; no production recovery or live provider-health claim.
- Update when: failure vocabulary, acknowledgement fences, queue disposition or Bay rendering contracts change.

## Contract

The real local Worker and SQLite Durable Object must preserve a closed, safe
review-failure classification through signed claim/completion and restart, settle
open exhausted command acknowledgements with the compiled production CLI, retain
operator-attention producers and retry budgets, and show stopped reviews separately
from live repair activity in real Bay Chromium. Only GitHub is replaced with a
loopback transport fixture. The proof Worker arranges expensive exhaustion counts,
scheduling timestamps and deliberate concurrent producer races; it does not
implement completion, finalization, admission, acknowledgement or projection.

The public examples are **32 total failed attempts across four cycles, three
recoveries, cause unknown**. Their stored final-cycle counters are eight:

- https://github.com/openclaw/openclaw/pull/120887
- https://github.com/openclaw/openclaw/pull/131455
- https://github.com/openclaw/openclaw/pull/131604
- https://github.com/openclaw/openclaw/pull/131464

Their fixture identifiers are not evidence of historical failure causes or of any
current GitHub state. Separate controlled IDs 990081–990084 submit real completion
payloads for source_preparation/review_history_unavailable,
source_preparation/review_commit_fetch_failed, timeout/timeout and workflow/unknown.
The fixture never seeds the failure explanation itself. Its controlled source
identity is complete; legacy cause unknown does not waive source fencing. Records
missing original identity remain parked without a write. Live title/body/review
labels/lock and PR head/base/draft changes are tested separately from harmless
bot-comment timestamp churn. One invalid private-text
reason is rejected by the real completion endpoint. Public projection negatives
exercise unknown reasons and an empty verified-public allowlist.

## Prerequisites and exact interface

Run from the repository root **inside the parent's owned, isolated Crabbox
local-container environment**, after frozen-lockfile dependencies and Chromium
have been provisioned by the parent. Authoring does not launch a container,
Worker or browser, install dependencies, or claim this proof passed.

- Node >=24 with native TypeScript stripping (same import pattern as the existing
  parked-command proof).
- `pnpm run build:all` has compiled the production status CLI for this source.
- Wrangler **4.131.1**, provisioned separately. The runner refuses another version
  and never invokes npx or installs anything.
- `playwright-core` and a real Chromium executable.

```sh
pnpm run build:all
WRANGLER_PATH=/absolute/path/to/wrangler/bin/wrangler.js \
CHROMIUM_PATH=/usr/bin/chromium \
PROOF_OUTPUT_DIR=.artifacts/review-failure-attention/candidate \
node docs/proof/review-failure-attention/run-proof.mjs
```

To compare the immutable baseline, copy **only this new proof directory** into the
parent's owned baseline checkout (the exact comparator recorded in the PR proof), compile
that checkout's production CLI, and run:

```sh
PROOF_EXPECT_BASELINE=1 \
WRANGLER_PATH=/absolute/path/to/wrangler/bin/wrangler.js \
CHROMIUM_PATH=/usr/bin/chromium \
PROOF_OUTPUT_DIR=.artifacts/review-failure-attention/baseline \
node docs/proof/review-failure-attention/run-proof.mjs
```

`WRANGLER_PATH` defaults to `node_modules/wrangler/bin/wrangler.js`. Output defaults
to a timestamped baseline/candidate directory. Always use a fresh output path.
Baseline mode imports only the existing Worker, queue and Bay APIs; it does not
call new explanation/classifier exports. It asserts the old Repair cove label, no
open acknowledgement driver and no public preserved failure cause. Candidate
asserts a failure acknowledgement with explicit Stopped detail, safe copy and preserved cause; these are assertions, not a
fallback to baseline behavior if implementation is missing.

## Exercised production interfaces

- Signed `/internal/exact-review/enqueue`, `/claim`, `/complete`.
- `/internal/exact-review/terminal-finalization/attempt` and the compiled CLI's
  existing just-in-time write fence, release and receipt verification routes.
- Signed `/internal/exact-review/lifecycle/command-ack/observed` with actual CLI
  output, replayed to check idempotence.
- Actual `/api/exact-review-queue` state passed to production
  `publicStatusProjection`, with a separately identified controlled live repair
  descriptor. Queue rows and failure classifications are not fabricated.
- Production `bayHtml()` delivered over loopback HTTP to Chromium, with empty
  ancillary lifecycle/health/egress responses; non-loopback browser requests are
  blocked **and fail the proof**. No browser GitHub actions or credentials.

Desktop/mobile comparisons use the same legacy, known-cause, retry and live
references before adding race fixtures. Dense cards are opened using their real
keyboard action so expanded hover labels do not obscure adjacent pointer targets.
A separate candidate case settles an open stopped command, then closes its target
and proves fresh revision-fenced acknowledgement cleanup without restarting review.

The additional real `/command-intake` case supplies no source fingerprint, base
or draft identity. Production verification captures them from the loopback GitHub
item, persists them across restart, and then settles the stopped command.

Known completion fixtures and that real intake produce exactly five preliminary review dispatches,
reported separately. Settlement may dispatch only
`exact_review_command_acknowledgement`, never review, repair or merge work. Lookup
races change command identity, revision or head before the compiled CLI's final
fence, expecting zero PATCHes. Duplicate receipts plus Worker restart must not
produce duplicate writes/dispatches. A repository visibility revocation prevents
settlement dispatch. A scheduled review retry and a controlled live repair
descriptor must not render as stopped review records. An exhausted dispatch-rejected
record with zero review attempts is projected and opened in the real Bay browser
as neutral queue attention, never as an exhausted review.

## Artifacts and limits

`result.json`, `source-manifest.json`, signed HTTP request/response trace (synthetic
fixture data only; never authorization headers or keys), final queue and persisted
state snapshots, completion/acknowledgement receipts, CLI outputs/logs, dispatch
census, resulting comments, Worker log, browser observations and screenshots.
Screenshots use viewport captures at **1440×1000** and **390×844** (not full-page
images that silently change output dimensions), including legacy and known-cause
drawers. Parent must inspect the images; screenshots alone are not claimed visual
validation. Source manifest includes tracked production files plus new proof and
new classification modules; source HEAD/diff hash are recorded separately.

Ephemeral loopback ports, a nonce-authenticated fixture and exclusive `.dev.vars`
creation prevent accidental cross-proof connections. Finally cleanup closes the
browser, all owned subprocess groups, HTTP servers, and the file it created. A
second run sharing this exact proof checkout is deliberately refused while
`.dev.vars` exists; use another owned checkout. Abrupt SIGKILL/container destruction
cannot run JavaScript cleanup; the owner must dispose of that isolated environment.

Limits: controlled fixture exhaustion rather than 32 real failing executions;
loopback GitHub rather than live contributor comments; controlled live repair
**descriptor**, not execution of a repair; not a hosted Actions job or deployed
Worker; no conclusion that any historical PR now passes or had a known cause.
The parent owns provider/image/lease provenance, full checks, reviews and delivery.
