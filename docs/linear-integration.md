# Linear Sidecar Workflow

Status: maintained operator-run sidecar on current upstream ClawSweeper. It is not
a native tracker provider and does not participate in the GitHub review, apply,
repair, or automerge workflows.

The sidecar keeps the useful Linear workflow from the historical fork without
retaining the removed lifecycle implementation. `src/linear/` owns deterministic
mapping, classification, scope, policy, authorization, comments, repository
inference, and analysis helpers. `scripts/linear-*.mjs` owns the network and CLI
boundaries.

## Safety Contract

- All commands are dry-run or read-only by default.
- Snapshot and triage commands have no mutation path.
- Codex analysis uses a workspace-read-only permission profile that denies host
  filesystem reads outside minimal runtime paths, disables command networking,
  web search, and MCP servers, and receives no GitHub or Linear write credential.
- The sidecar never closes a Linear issue or changes its workflow state or
  priority.
- Comment creation and updates are planning-only. `--apply` plus
  `OPENCLAW_NOTIFY_LINEAR=1` records apply intent but still reports
  `wouldWrite: false` and stops before OAuth credential access, token minting,
  or mutation.
- Existing marker comments are reused only when their stable Linear bot actor ID
  matches `LINEAR_APP_ACTOR_ID`; display names are never treated as ownership.
- The expected actor ID remains part of the reviewed comment plan hash and
  receipt so ownership evidence is preserved for a future settled lane. The
  current operator entrypoints do not mint an app token or issue a comment
  mutation.
- `--apply-labels` produces a reviewed routing-label plan, but live label mutation
  remains disabled because Linear's replace-all label update cannot atomically
  preserve labels added concurrently.
- Every proposal is bound to its issue snapshot and reviewed plan hash.
- Label plans preserve labels not owned by this sidecar; no live label write is
  attempted until an atomic additive or compare-and-swap boundary exists.
- Review comments are marker-backed. Existing actor-owned comments produce an
  `update` plan and missing comments produce a `create` plan; neither action is
  executable.

## Prerequisites

Use Node 24 or newer, install dependencies, and build before running a sidecar
command:

```bash
corepack enable
pnpm install
pnpm run build
```

Read access is resolved in this order:

1. `LINEAR_API_KEY`
2. `LINEAR_TOKEN`
3. macOS Keychain generic password, service `openclaw-linear-api-key`, account
   `partnerai-config`

The OAuth Keychain coordinates remain reserved for a future durably settled
write lane. Current comment and label plans do not resolve those credentials or
mint a write token. Do not pass credentials on the command line.

## Read-Only Workflow

Capture one team or the whole workspace:

```bash
pnpm linear:snapshot -- --team PAR --out .artifacts/linear-snapshot.json
pnpm linear:snapshot -- --out .artifacts/linear-workspace.json
```

A requested `--team` that matches no team is an error. This prevents an empty
snapshot from being reported as a successful triage.

Generate a deterministic review-only digest:

```bash
pnpm linear:triage:review -- \
  --snapshot .artifacts/linear-snapshot.json \
  --protected-label human-review
```

Or stream snapshot directly into triage:

```bash
pnpm linear:review -- --team PAR
```

The streamed form is convenient for inspection. Use a saved snapshot when the
output will be independently reviewed or used to establish apply approvals.

## Exact-Item Analysis

Inspect what an exact-item analysis would do without calling a model:

```bash
pnpm linear:analyze -- --identifier PAR-244 --json
```

When Linear has no unambiguous repository link or label, an operator or trusted
workflow receipt may supply the configured target explicitly:

```bash
pnpm linear:analyze -- \
  --identifier PAR-597 \
  --repo openclaw/clawhub \
  --json
```

An explicit repository fills only a missing signal. It cannot override a
conflicting GitHub URL, conflicting repository labels, an unsupported target, or
any other ambiguous source evidence.

Run the read-only model against the inferred local repository checkout:

```bash
pnpm linear:analyze -- --identifier PAR-244 --analyze --json
```

Analysis fails closed unless that checkout is clean, on `main`, and exactly at
the live canonical remote's `main` tip. Close-leaning advice additionally
requires at least one cited commit reachable from that revision. The Codex
subprocess receives neither Linear read tokens nor Linear OAuth credentials,
and its generated commands cannot read the operator's home or Codex credential
store. Policy-protected items are skipped before model execution.

Repository inference fails closed when links and labels do not identify exactly
one supported repository. Model output is validated with ClawSweeper's current
decision schema, cited Git SHAs are re-verified by the host, and any close leaning
is advisory only. Analysis does not write to Linear.

A completed model review writes one canonical-shaped local proposal, isolated
from the GitHub lane's materialized `records/` tree:

```text
.artifacts/linear-records/records/<repository-slug>/items/<linear-identifier>.md
```

For example, a local `openclaw/clawhub` proposal for `PAR-597` is
`.artifacts/linear-records/records/openclaw-clawhub/items/PAR-597.md`. Its front
matter binds the decision to `target_repo`, Linear `source_provider`/`source_id`,
the Linear snapshot hash, repository head, model, analyzer version, and review
runtime. The body is the exact proposed marker-backed comment. A dry run writes
no record.

The local file is a review artifact, not yet proof of publication to the
canonical Worker store. Canonical publication and read-back are separate apply
work that must be added before unattended operation is claimed.

## Separate Review and Proposal Lanes

Review and proposal validation are separate authority lanes even where the
current operator CLI shares planning helpers. Review owns model execution and
record generation; it has no Linear write credential. Apply-intent mode accepts
an independently reviewed record/receipt and recomputes the proposal, but it
cannot synchronize a comment. Routing-label changes also remain reviewed plans;
live label mutation is disabled. Repair and commit review remain separate
ClawSweeper lanes and are not performed by these commands.

First create and save a dry-run report for an exact issue, a list, a project, or
a team:

```bash
LINEAR_APP_ACTOR_ID=<linear-bot-actor-id> \
pnpm linear:review-apply:dry-run -- \
  --team PAR \
  > .artifacts/linear-par-dry-run.json
```

Review the proposed comment and label changes plus every `planHash` and
`snapshotHash`. The report can then serve as the approvals file for exactly that
reviewed state.

An apply-intent probe validates the reviewed receipt but still writes nothing:

```bash
LINEAR_APP_ACTOR_ID=<linear-bot-actor-id> \
OPENCLAW_NOTIFY_LINEAR=1 pnpm linear:review-apply -- \
  --team PAR \
  --apply \
  --approvals .artifacts/linear-par-dry-run.json \
  --rate-ms 400 \
  --json
```

New marker comments and updates to existing managed comments are never executed
by the operator entrypoints. Any number of operators may independently produce
`create` or `update` plans, but every summary reports `wouldWrite: false` and
every apply path stops before OAuth credential access, token minting, or
mutation. A shared durable business-action identity and atomic claim/CAS or
canonical ledger, plus attempted/succeeded/failed/unknown settlement,
exact-attempt receipts, and unknown-outcome reconciliation are required before
either action can be enabled across machines.

Generate and review a fresh dry-run report before reviewing the proposed
routing-label plan:

```bash
LINEAR_APP_ACTOR_ID=<linear-bot-actor-id> \
pnpm linear:review-apply:dry-run -- \
  --team PAR \
  > .artifacts/linear-par-label-dry-run.json

```

`--apply-labels` remains dry-run even with `OPENCLAW_NOTIFY_LINEAR=1`. Linear's
available `issueUpdate(labelIds: ...)` operation replaces the complete set and
cannot atomically preserve a label added after the final pre-write read. Keep
the reviewed label plan as operator evidence; do not treat it as applied.

A changed issue, changed plan, missing approval, closed gate, ineligible item, or
ambiguous scope is skipped rather than written.

For a single existing managed comment, use
`LINEAR_APP_ACTOR_ID=<linear-bot-actor-id> pnpm linear:comment:dry-run -- --identifier PAR-244`,
review and save that receipt, then optionally pass it to
`linear-comment-apply.mjs` with `--apply --dry-run-receipt <path>` and the same
actor ID and environment gate to exercise receipt validation. Whether the
receipt proposes `create` or `update`, apply reports it as disabled and performs
no write.

## Current Scheduling Seam

Scheduling belongs to the operator layer, not this repository's GitHub Actions.
A scheduler should invoke the committed snapshot and review-only triage commands,
require a final `TRIAGE_OK` or `TRIAGE_ALERT_SENT` sentinel, enforce a maximum run
age, and alert on missing delivery or Linear rate-limit failures.

`src/linear/trigger.ts` provides deterministic OpenClaw cron specifications and
expectation evaluation for that operator integration. Creating or updating the
actual cron remains an explicit deployment action.

MCP and discovery tooling operate read-only. They are never used for batch apply.

### Future webhook trigger

No webhook receiver is implemented by this sidecar. A future Linear webhook may
be an optional low-latency trigger, but never an authority or record
store. Linear documents issue and issue-comment webhooks as retried HTTP POSTs;
the receiver must authenticate the delivery, acknowledge quickly, deduplicate,
and enqueue the same review lane used by scheduled/on-demand work. A webhook may
never call apply directly.

Client-credentials OAuth tokens represent the application actor. Linear's
`actor=app` parameter applies to the interactive authorization-URL flow, not the
client-credentials token request. Personal API-key reads remain suitable for
operator inspection but cannot establish managed-comment ownership.

## Future-Phase End-to-End Acceptance Requirements

The publication, webhook, repair handoff, and process-level end-to-end behavior
below is not implemented by this sidecar. These are acceptance requirements for
future wiring, not current capability claims. An end-to-end run will be complete
only when all applicable phases have current receipts.

### 1. Intake and snapshot

- Fetch the exact Linear issue by durable UUID and human identifier.
- Fully paginate comments, attachments, labels, team state, and creator identity;
  fail closed on any truncated connection.
- Canonically hash every source field that can change the decision or proposed
  mutation.
- Record the webhook delivery ID or operator invocation ID without treating it
  as authority.
- Replay of the same event must select the same source item and snapshot hash.

### 2. Repository binding and review

- Infer one configured repository from trusted issue evidence, or accept one
  explicit repository from an authenticated workflow receipt.
- Reject explicit/inferred conflicts and unsupported repositories.
- Verify the checkout remote matches the target repository, the branch is
  `main`, the worktree is clean, and local HEAD equals live canonical `main`.
- Run model-generated commands without Linear, GitHub-write, or model-provider
  credentials and restrict their reads to the reviewed workspace plus minimal
  runtime paths.
- Validate output with ClawSweeper's decision schema and re-verify every cited
  SHA as reachable from the reviewed head.
- Maintainer-authored items must remain open regardless of model confidence.

### 3. Durable record

- Write exactly one `records/<repository-slug>/items/<identifier>.md` artifact.
- Persist decision, close reason, confidence, evidence, proposed comment,
  runtime/model metadata, source identity, target repository/head, and snapshot
  hash.
- Re-read and parse the persisted record; byte-identical reruns must noop or
  replace the same path rather than create another record.
- Publish to the canonical Worker store and read it back before claiming the
  review is durable. A local file alone is insufficient.

### 4. Comment plan and apply

- Plan exactly one marker-backed comment using the durable Linear source UUID.
- Reuse a comment only when both marker and stable app actor ID match.
- Load independently approved `planHash` and `snapshotHash` values from the
  durable review receipt.
- Re-fetch immediately before mutation and reject source, plan, repository-head,
  actor, or authorization drift.
- Validate GraphQL `errors`, mutation `success`, returned IDs, and read-back
  content; HTTP 200 alone is not success.
- Rerunning the same approved review must update/noop the same comment ID and
  must never stack a second ClawSweeper comment.

### 5. Labels and state

- Comment writes and label plans require separate snapshot/review cycles.
- Label plans preserve unrelated labels and fail closed when the label
  connection is truncated. Live label apply remains disabled until an atomic
  additive or compare-and-swap operation can preserve concurrent labels.
- Review never changes Linear workflow state, priority, cycle, or project.
- A close/state proposal is limited to implemented, unreproducible, duplicate,
  incoherent, or obviously stale items and remains blocked for maintainer-authored
  or protected items. Any future state mutation needs its own apply lane.

### 6. Future repair and local re-review

- A future repair handoff consumes accepted finding IDs from the durable record
  and is bound to the reviewed source revision.
- Repair completion cannot mark review complete or edit Linear directly.
- `pnpm local-review` evaluates the exact repaired range. Future sidecar wiring
  may update the same record lineage and propose replacement content for the
  same managed comment only after that review succeeds.
- A changed head, tree, issue snapshot, or PR body invalidates affected proof and
  review approval.

### 7. Failure recovery

- Webhook redelivery, process restart, and duplicate operator invocation are
  idempotent.
- An ambiguous mutation result is never automatically retried; read-back decides
  whether it landed.
- Record-published/comment-failed and comment-landed/read-back-failed outcomes are
  explicit, recoverable states with no false `applied` claim.
- A rerun resumes from durable state and does not depend on temporary files or a
  previous agent transcript.

### Representative live proof

Use one dedicated, non-production Linear issue tied to a configured disposable
repository/branch. Exercise snapshot, review, record publication/read-back,
comment create/read-back, unchanged rerun, comment update/read-back, injected
snapshot drift rejection, wrong-actor marker rejection, ambiguous-mutation
recovery, repair handoff, commit re-review, and final idempotent rerun. Comment,
label, and any future state mutation tests require separate explicit operator
approval and fresh snapshots.

## Boundaries

This integration intentionally does not add a `TrackerProvider`, Linear webhook,
Linear state machine, native Linear record store, or Linear automerge lane. Those
would create a second production control plane and should be considered only
after the sidecar has sustained operational evidence.

Linear's real-time sync/API does not replace ClawSweeper records. Do not place
snapshot hashes in issue descriptions or custom fields as the sole audit source,
do not scrape free-form Symphony/operator comments as mutation authority, and do
not map ClawSweeper routing labels to workflow statuses. Linear remains an intake
and public-comment surface around ClawSweeper's existing review/apply boundaries,
repair machinery, and local-review command.
