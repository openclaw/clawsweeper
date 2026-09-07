# Explicit manual publication proof

- Status: active proof recipe; current execution evidence belongs in the PR body
- Owner: ClawSweeper queue and publication maintainers
- Source of truth: [driver](../../../scripts/e2e/manual-review-publication.mjs) and [entry script](../../../scripts/e2e/manual-review-publication-crabbox.sh)
- Update when: admission, policy, branch selection, artifact inventory, ownership, retry, lifecycle lineage, or consumer behavior changes

## Behavior contract

Explicitly selected manual items enter the existing exact queue **before review**
and publish only records and durable comments. A completed review can retry
publication without rerunning the model or widening authority. The canonical
restriction remains effective for background consumers after queue completion.

The driver runs the built CLI and actual local Wrangler Worker, Durable Objects,
SQLite, and R2. GitHub/Actions HTTP responses and review output are synthetic.
Claims and successful comment receipts are never seeded. Synthetic PR 76 must
receive publisher-generated completion markers for its exact head/source,
original `reviewed_at`, and real coordinator-owned review lease. An uploaded
report, progress comment, or imported old record cannot satisfy that assertion.

The runtime scenarios exercise:

- Checked-in manual admission with `release/proof`; a dispatch outage leaves
  requests pending while an ordinary `main`-branch event refreshes source facts.
  The eventual claim must preserve the manual branch, requested timeout, and
  one-off instructions, and advance its revision. The checked-in event-payload
  resolver must retain the requested 40-minute timeout instead of the default.
- Checked-in direct-publication and lifecycle shell steps. Selected bundle input,
  imported records, snapshots, and early refusal output stay in the chosen work
  root, even when the caller runs from another checkout. Raw producer diagnostics
  remain intact; extra sibling files, directories, and symlinks are refused.
- Authority-service HTTP 503 at initial validation, apply-child entry, mutation,
  and batch preparation. All retain `retryable_failure` / `state_contention` with
  zero comment writes and no GitHub inline retry. Mutation-failure cleanup makes
  its separate guarded authority read; that also refuses during the outage.
- Direct and batch canonical acceptance, unknown-acknowledgement recovery,
  source/head drift, replaced owners, real lease expiry, and artifact exhaustion
  without fresh review. An independently requested later review remains possible.
- Policy-aware implementation discovery and zero label, close, router, repair,
  merge, or sibling effects. Every request invokes synthetic review exactly once;
  all selected bundles and diagnostic files remain byte-identical.
- Current lifecycle audit and the public Bay endpoint, including producer
  revision 2 completed through publication revision 1. A later producer journey
  stays pending until its own publication. Public Bay exposes no lineage or
  owner material and remains observer-only.

Focused lifecycle tests additionally cover immutable lineage conflicts, missing
links, queue deletion/reconstruction, replay without duplicate telemetry, and
retained publication keys whose producer provenance is refreshed. Transport tests
cover timeouts, network failures including curl HTTP/2 exit 16, HTTP 429, error
sanitization, and hard ownership/authentication rejection. Existing retry budgets
and receipt/lease identities are unchanged.

## Run

Provision a fresh task-owned lease using the configured or explicitly approved
backend. The approved fallback for this task is **local-container**, not AWS or
Testbox. The driver allocates no resources and loads no production credentials.
Use Node 24+, pnpm 11.10.0, Wrangler 4.107.0, Bash 4+, jq, Python 3, tmux, and a
checksum-verified stock GitHub CLI with `http_unix_socket` support (tested with
2.98.0). Supply its absolute path, never a host wrapper that hydrates credentials.
The mandatory synthetic socket read and invalid `GH_HOST` guard outbound access.

Use a self-contained checkout with its actual Git objects. Verify the exact head
with `git rev-parse` and `git cat-file`; do not manufacture checkout metadata.
When copying from macOS, disable AppleDouble and extended-attribute files. Keep
HOME/XDG and application state isolated, install with the frozen lockfile, and
pass only the named non-secret toolchain settings into child commands.

The source digest covers actual source, workflows, configuration, compiler inputs,
schemas, and prompts independently of the checkout SHA. In the prepared environment:

```bash
node scripts/e2e/manual-review-publication.mjs source-id
```

Set `MANUAL_PUBLICATION_WRANGLER`, `MANUAL_PUBLICATION_GH`,
`MANUAL_PUBLICATION_PROVIDER`, `MANUAL_PUBLICATION_LEASE`,
`MANUAL_PUBLICATION_IMAGE`, and a fresh `MANUAL_PUBLICATION_OUTPUT`, then run:

```bash
bash scripts/e2e/manual-review-publication-crabbox.sh <verified-head> <source-sha256>
```

The entry script builds the source before running the driver. Collect `summary.json`,
`proof.json`, `result.json`, `trace.json`, `commands.json`,
`current-head-pr-completion.json`, runtime logs, and `cleanup.json` before stopping
and verifying deletion of the owned lease. Review captures for incidental secrets
before publishing evidence. Record the provider, image, lease, exact command,
head/source digest, observed result, and cleanup in the main PR body; local-container
runs have no hosted run URL. Failed runs remain failed evidence, not successful E2E.

## Limits and rollout

This does not establish production GitHub permissions or throttling, Actions
scheduling/expression evaluation or artifact provenance, model review quality,
production Cloudflare durability, or browser UI behavior. GitHub comment write
and canonical acceptance are separate services, not an atomic transaction.
Ownership changes between them require the canonical handoff to refuse. Direct
canonical retries still require the immutable accepted plan.

The approved lifecycle lineage is observational metadata in existing JSON, not
publication authority. Physical receipts and leases retain their original fences.
Missing or conflicting lineage cannot complete another producer journey. Bay's
public field set and mutation-free UI remain unchanged; its data projection is
part of this proof. Admission remains default-off until the separately authorized
[coordinated rollout](../../repair/operations.md#manual-publication-rollout).
No historical batch or foreign target is recovered or mutated by this harness.
