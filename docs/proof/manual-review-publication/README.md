# Explicit manual publication proof

- Status: controlled Linux local-container runtime proof and full gate passed; runtime/test changes are independently scoped-clean at P0–P2
- Owner: ClawSweeper queue and publication maintainers
- Source of truth: [driver](../../../scripts/e2e/manual-review-publication.mjs)
  and [entry script](../../../scripts/e2e/manual-review-publication-crabbox.sh)
- Base: `a9ed9b5ba7eb12357da7cc2360d87cc5397c3c36`
- Update when: policy, admission, publication ownership, retry, or consumer behavior changes

## Controlled Linux result

The operator explicitly approved `local-container` after two AWS coordinator
creation failures (`HTTP 500 / 1101`); both attempted AWS leases were released.
This result is **not AWS proof** and does not claim production GitHub or
Cloudflare validation.

The actual runtime path passed in local-container run `run_40f0334e1c9c`, lease
`cbx_ef6d1b5d0da1`, on
`node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2`.
Local runs have no remote run URL. Runtime source SHA256 was
`ad5d3a4c94eb800d74dbef9eb0c2db8c43e2ee35cbf25d906b6e2681be68c6a4`;
the base commit above is not represented as the candidate commit.

The built CLI and real isolated Worker/SQLite/R2 path verified the current-head
PR completion receipt, original review time, direct and batch publication,
unknown-acknowledgement recovery, source/head drift, expired and replaced owners,
artifact exhaustion without a review rerun, and an independently requested later
review. Each of seven explicit requests produced one synthetic review. Forbidden
requests and sibling requests were zero; the stale publisher exited 1 and its
comment-write count stayed **14 → 14**. Worker shutdown and temporary-state removal
were verified. Ordinary producer `review-cache-metrics.json` sidecars were present
alongside the selected report.

Collected evidence remains local under
`.artifacts/manual-review-publication-container-proof/`, including `summary.json`,
`current-head-pr-completion.json`, `proof.json`, `trace.json`, `commands.json`, and
`cleanup.json`. Node was 24.20.0, pnpm 11.10.0, Wrangler 4.107.0, stock GH 2.98.0,
jq 1.6, and tmux 3.3a. Raw Crabbox sync required initialization of Git metadata from
the verified existing base and staging only the supplied candidate inventory;
working source bytes were not replaced by a checkout. No Actions credentials were
hydrated. The full gate used four test workers without excluding tests or changing
coverage thresholds.

The first container attempt exposed missing jq/tmux/pnpm setup. After correcting
that environment, the runtime proof passed and the full suite had one existing
terminal cleanup-test race: a process could lose its command text before its PID
was reaped. The test-only correction polls all existing cleanup conditions within
the same two-second deadline and retains every final assertion. Its separate
independent review is also scoped-clean. Final full-gate run `run_5f72e33f93a7`
passed: **5,026 passed, 18 platform-specific skips, zero failures**, plus all static,
build, lint, and coverage gates. The cleanup regression passed three focused runs
before that full gate. Evidence is under
`.artifacts/manual-review-publication-final-check/`; runtime source identity stayed
unchanged. The initial combined run's nonzero overall exit is not hidden by the
successful runtime proof.

## Scenarios and historical local evidence

Claim under test: explicitly selected manual items enter the existing exact queue before
review and publish only their records and durable comments. A successful review
can retry publication without widening authority or rerunning the model. The
canonical restriction remains visible to background consumers.

The current-head PR completion scenario explicitly admits synthetic
`https://github.com/openclaw/openclaw/pull/76` and obtains its producer claim from
the actual coordinator. It creates a synthetic report and bundle under that claim,
then invokes the built publisher and direct canonical-publication CLI. The accepted
trusted bot comment must end in the publisher-generated review-version and identity
markers for that PR, its exact head and source revision, the **original** `reviewed_at`,
and the actual review lease owner and positive lease-comment ID. The accepted comment
ID must also be positive and match the canonical record. Neither report fixtures nor
initial comment state contain a completion marker or receipt. Combined status stays
`pending` with empty statuses and checks; production code determines the output.
The report's review-activity cursor comes from two matching stock-GH GraphQL reads
decoded by the built production cursor code. After canonical acceptance, the harness
executes the checked-in `finalize-direct-exact-review-lifecycle` workflow step's
unchanged shell body locally. That step determines and records `not_required` without
dispatching the router; its shell body is retained as
`current-head-pr-76-lifecycle.sh`. This does not exercise the Actions scheduler or
expression evaluator.

The observable result is canonical acceptance with zero label, repair, merge, router,
or close effects, plus a completed lifecycle whose router receipt is `not_required`.
Artifacts include `current-head-pr-completion.json`, the exact accepted
`current-head-pr-76-comment.md`, publisher mutation and canonical record, request
trace, per-request review counts, and `summary.json`. The separate synthetic
`https://github.com/openclaw/openclaw/pull/73` head-drift refusal and all ownership,
expiry, artifact-loss, and repeated-request guards still run. The unselected sibling
`https://github.com/openclaw/openclaw/issues/99` receives zero requests.

For this addition the controlled proof command is the direct local invocation below,
after building the current source. Its environment is Node 24, pnpm 11.10.0, pinned
local Wrangler 4.107.0 and stock GH with the mandatory socket probe and invalid
`GH_HOST`. Provider is `local-smoke`, lease `none`, image `host-node24`; all upstream
GitHub/Actions context and review text remain synthetic. The actual coordinator,
SQLite, R2, publisher and canonical path run locally. This adds no production or
OpenClaw Bay contract; the existing Bay limits below apply.

```bash
PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/node@24/bin:$PATH" pnpm run build:all
candidate_source_sha256="$(PATH="/opt/homebrew/opt/node@24/bin:$PATH" node scripts/e2e/manual-review-publication.mjs source-id)"
PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/node@24/bin:$PATH" \
MANUAL_PUBLICATION_WRANGLER="$PWD/.artifacts/manual-publication-tools/node_modules/.bin/wrangler" \
MANUAL_PUBLICATION_GH=/opt/homebrew/bin/gh \
MANUAL_PUBLICATION_PROVIDER=local-smoke MANUAL_PUBLICATION_LEASE=none \
MANUAL_PUBLICATION_IMAGE=host-node24 \
MANUAL_PUBLICATION_OUTPUT="$PWD/.artifacts/manual-publication-local-22" \
node scripts/e2e/manual-review-publication.mjs run \
  a9ed9b5ba7eb12357da7cc2360d87cc5397c3c36 "$candidate_source_sha256"
```

Run 22 exited **0** on source SHA256
`37ba02350edef914b2074d9b882625c40d7cd75ee417d69ec7d1c07f6e59de46`.
Evidence is in `.artifacts/manual-publication-local-22/`. The accepted trusted bot
comment ID is **104**, with review lease owner `github-run-1076-1` and lease-comment
ID **103**. Its trailing markers retain original `reviewed_at`
`2026-09-05T13:28:08.488Z`, head `dddddddddddddddddddddddddddddddddddddddd`, and source
revision `2ee4b3ba366bfc49d6b2e2290869c8708cd82bdec5ad86ca6cecb854092c022b`.
Canonical acceptance and completed lifecycle passed; forbidden effects and sibling
requests were **0**. All seven review requests (`1071`–`1076`, `3072`) produced one
synthetic review each; the independent claim-only ownership control produced none.
The repeated request used revision **2**. Stale-owner comment writes stayed **14 → 14**;
all three artifact-loss attempts and the existing guards passed. `cleanup.json` and
`cleanup-process-check.json` confirm worker shutdown, removed temporary state/socket,
and no remaining matching processes.

The current production source was built with `pnpm run build:all`; focused harness
oxlint, formatting, `node --check`, and scoped `git diff --check` passed. Tooling was
Node **24.20.0**, pnpm **11.10.0**, Wrangler **4.107.0**, stock GH **2.98.0**.
No full `pnpm run check`, AWS proof, final review, Git mutation, or production/cloud
operation was performed for this bounded addition.

Local runs `manual-publication-local-13` and `manual-publication-local-14`
retain the original ownership reproduction: an independently newer lease received
the same revision and generation, and the old publisher wrote its comment. The
fixed guard requires the actual producer lease/run/attempt or active batch claim,
lease owner, and runner identity. These fields are authenticated transient metadata;
no ownership table, schema, receipt replacement, or counter change is added.
Canonical submission checks ownership again after asynchronous target admission,
and retained receipts cannot authorize old owners.

Run 18 passed the full isolated scenario set, including the unchanged stale-owner
refusal assertion with zero additional comment writes, valid batch publication and
expiry/reclaim, head/body drift, canonical receipt acceptance, ordinary/restricted
implementation discovery, lifecycle inventory, and three artifact-loss attempts
without a second review. A new explicit request after completed publication used
the coordinator's existing next revision and published successfully. Each request
produced exactly one synthetic review. Its evidence is in
`.artifacts/manual-publication-local-18/`: `proof.json`, `summary.json`, `trace.json`,
`commands.json`, `newer-owner-reproduction.json`, and `cleanup.json`.
The run 18 candidate source SHA256 was
`9d88ab8afe399b3e5a265befb5fcf156f7dd7424f1ef2b989742a29e753533a0`.
The run exited 0, recorded zero forbidden and sibling requests, and confirmed
worker shutdown and temporary-state removal. None of these local observations
is AWS proof.

Runs 19–21 remain available as failed harness-development traces with successful
cleanup. Run 19's synthetic PR report omitted required review-activity context.
Run 20 accepted the PR comment and canonical record, then the new effect assertion
incorrectly counted read-cache population and the production heartbeat as forbidden.
Run 21 also accepted publication, then its lifecycle assertion exposed the omitted
workflow finalization step. The final harness derives the missing cursor from real
fixture reads, bounds those cache/heartbeat operations, and executes the actual
workflow shell step. No production code or existing refusal assertion was changed.

Earlier focused validation for run 18 passed 436 tests, Node/repair/dashboard
builds and typechecks, focused lint and formatting, and a negative source-identity
check using an altered TypeScript-config digest. The absent-report regressions
verify ordinary terminal behavior and restricted `missing_record_tuple` refusal
without adopting hydrated old content. Receipt regressions preserve immutable
same-request retries, including an interrupted canonical-to-queue handoff.

The operator provisions and owns the configured or explicitly approved Crabbox
backend. This harness allocates nothing and loads no production credentials.
Supply installed Wrangler 4.107.0, Node 24+, pnpm 11.10.0, Bash 4+, jq,
GitHub CLI with `http_unix_socket`, Python 3, and repository dependencies.
The full repository gate additionally needs tmux and a pnpm executable available
on the sanitized child PATH. Supply the
absolute stock GitHub CLI path (tested with 2.98.0), not a host wrapper that hydrates credentials.
The harness verifies an actual synthetic HTTP read before it attempts admission.

Install Wrangler in task-local scope without changing repository dependencies:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install \
  --prefix .artifacts/manual-publication-tools --no-audit --no-fund \
  --package-lock=false wrangler@4.107.0
```

```bash
candidate_source_sha256="$(node scripts/e2e/manual-review-publication.mjs source-id)"
MANUAL_PUBLICATION_WRANGLER=/absolute/path/to/wrangler \
MANUAL_PUBLICATION_GH=/absolute/path/to/stock/gh \
MANUAL_PUBLICATION_PROVIDER=aws \
MANUAL_PUBLICATION_LEASE=parent-owned-lease-id \
MANUAL_PUBLICATION_IMAGE=parent-verified-image-id \
bash scripts/e2e/manual-review-publication-crabbox.sh \
  a9ed9b5ba7eb12357da7cc2360d87cc5397c3c36 "$candidate_source_sha256"
```

For a local smoke run, use `MANUAL_PUBLICATION_PROVIDER=local-smoke`,
`MANUAL_PUBLICATION_LEASE=none`, and `MANUAL_PUBLICATION_IMAGE=host-node24`.
When invoking the JavaScript driver directly, run `pnpm run build:all` first;
the Crabbox entry script performs that build itself.
This is **not AWS and not final live proof**. Each attempt should use its own
`MANUAL_PUBLICATION_OUTPUT` directory so failures remain inspectable.

The script verifies the base with `git cat-file` and hashes actual tracked and
new candidate source, including TypeScript configuration, schemas, and prompts.
The base commit is never labeled as the patched code's
commit. It runs the actual built admission CLI, coordinator claim API, bundle
CLI, direct publisher, fallback enqueue, batch claim/preparation/commit, and
lifecycle completion against isolated Wrangler Durable Object SQLite and R2.
Synthetic GitHub/Actions HTTP responses supply upstream services and synthetic
review output is generated under a real producer claim. Claims and successful
comment receipts are never seeded.
GitHub-shaped fixture metadata uses the base SHA; the separately verified source
manifest identifies the uncommitted candidate that actually runs.

Output under `.artifacts/manual-review-publication` includes source identity,
commands, request traces, original review timestamps and invocation counts,
canonical acceptance receipts, failed-run diagnostics, forbidden effects, and cleanup.
The Worker workspace is disposable and uses a generated local configuration;
the GitHub socket and CLI configuration are also isolated. Review the actual results
before claiming proof. A failed assertion is a proof gap, not successful E2E.

This cannot establish production GitHub permissions/throttling, Actions
scheduling or artifact provenance, model review quality, or Cloudflare production
durability. Ownership checks do not make GitHub comment acceptance and canonical
submission atomic across services: ownership can change between those operations,
and the canonical handoff must then refuse the stale publisher. Retrying direct
canonical publication still requires its immutable accepted plan.

OpenClaw Bay is affected only through the existing lifecycle facts. No Bay code
or public data-schema change is needed because owner metadata stays within the
authenticated publication boundary and existing lifecycle states and receipts are
retained. The harness checks authenticated lifecycle inventory for completed
publication; the public Bay UI, browser behavior, and Actions scheduling are not
exercised. Bay remains observer-only, with no mutation controls. The operator owns
backend selection, proof execution, cleanup, and independent review. Documentation-site
classification uses the existing `proof/` lifecycle entry.
