# Intake triage

- Status: active by default with native OpenAI authentication
- Owner: ClawSweeper maintainers
- Source of truth: `src/intake-triage-contract.ts`, `src/intake-triage-api.ts`, `src/intake-triage-decisions.ts`, `src/intake-triage-workflow.ts`, `.github/workflows/sweep.yml`; independent PR classification: `src/pr-classification.ts`, `src/pr-classification-workflow.ts`, `.github/workflows/pr-classification.yml`, `dashboard/worker.ts`
- Last verified: 2026-11-23; intake configuration and ordering covered by intake/sweep tests; independent classification covered by focused API, workflow and webhook tests plus its controlled runtime proof
- Update when: credentials, model defaults, questions, input limits, backends, provisional labels, or workflow ordering change

Intake classifies the author's submission before source review. It answers three
bounded questions: request category, whether trigger steps are supplied, and
whether version and environment are supplied. It does not establish that a bug
exists or that a patch is correct.

The ordinary Responses adapter works without the Decisions API. Both adapters
use the same packet and rubric. A caller must record request intent before a
billable request and record returned usage separately from full-review usage.
Missing credentials, timeouts, refusals and malformed output produce no labels.
An input scanner refusal propagates and must not trigger another backend.

The packet includes only repository, item number, kind, title and body. It is
limited to 12 KB; oversized submissions abstain rather than silently truncate.
No source checkout, comments, tools or full-review prompt is sent. Each request
has a 20-second deadline, a 32 KB response limit, and no application retry.
Both adapters default to `gpt-6-luna`. Responses uses strict structured output
and disables response storage.

Labels in the finite `clawsweeper:intake:*` family are preliminary. They never
set priority, impact, reproduction proof, good-first-issue eligibility, maturity,
merge risk, or readiness. They must be removed by the normal completed-review
publication. Intake must not satisfy review requests or populate review caches.

Adding a cheap call before a full review adds spend. Cost savings require moving
an existing metadata task to intake, not counting both calls as a saving.

The default Decisions adapter calls `POST /v1/decisions` with the selected model and
three choice questions. It validates names, choices, complete distributions,
finite probabilities, and refusals. Native choice distributions are retained
separately; Responses does not invent matching confidence values. No probability
threshold is presented as calibrated without labeled production examples.

See the [official Decisions contract](https://developers.openai.com/api/docs/guides/decisions).
Decisions failures abstain. They do not automatically spend on Responses or
resubmit scanner-refused content. The ordinary Responses adapter remains an
independent path for deployments without Decisions access.

## Hosted enablement and lifecycle

Intake uses the existing repository secret `OPENAI_API_KEY` and is enabled by
default in native OpenAI modes. The separate OpenClaw runner can use the same
key. Private ClawRouter Codex routes keep upstream keys withheld; their workload
credential is never forwarded to the public OpenAI API. An absent native key
disables intake without model, GitHub, queue or ledger work.

The default backend is `decisions` and the default model is `gpt-6-luna`. Set
the repository variable `CLAWSWEEPER_DECISION_MODEL` to override the model, or
to `off` to disable intake. Unset and blank values use the default. This model
is independent of the full-review model; the selected value is sent to the
provider and recorded in the paid inference intent.

Set `CLAWSWEEPER_INTAKE_BACKEND=responses` to use ordinary Responses without
Decisions access. The model must be supported by the selected API. Unsupported
models abstain without an automatic cross-backend retry.

For admitted exact reviews, intake runs after the review-in-progress reservation
and trusted scanner setup, before target-source checkout and review hydration.
Held or superseded reservations skip runner and target-source preparation.
Its preliminary labels remain visible during target-source preparation and the
full review. This is a bounded serial intake phase, not a second background
writer. Oversized metadata-only reviews skip it, and so does an item that
already carries a published ClawSweeper review comment: its labels would only
be removed again by that review's publisher, and each removal looked like new
source activity. A failed optional phase does not block full review. The automatic acknowledgement changes to reviewing only
after source preparation succeeds.

The publisher checks the queue lease/generation and unchanged item snapshot
before each label-definition or item write. Only the six known intake labels
can change; all other labels stay owned by their existing publishers. Request
intent, usage and mutation receipts use a distinct intake operation in the
existing action ledger. Interrupted writes are finalized as unknown outcomes,
even when the later full review succeeds. They never complete a review request
or its cache.

Enabled intake that may write invalidates the earlier PR-admission handoff even after an
uncertain write or process failure, so source review hydrates current labels
and timestamps. Only a current complete review removes preliminary labels,
through the existing guarded label batch. Failed, stale and incomplete reviews
leave them explicitly preliminary. There is no automatic cross-backend retry.

## Independent PR priority classification

Priority/impact classification is a separate lane, not the intake phase above.
The authenticated GitHub App webhook dispatches
`.github/workflows/pr-classification.yml` for public hosted PRs on opened,
reopened, edited and ready-for-review events, before maintainer opt-in and full
review admission. Drafts and review-skipped maintainer PRs are eligible. Existing
priority labels, closed/locked PRs, and label/push events do not dispatch it.
The target OIDC review dispatcher does not start this lane. There is no backlog
sweep or automatic retry of failed dispatches; the workflow can be dispatched
manually for an eligible PR. Review admission itself is unchanged.

Dispatch runs as a Worker `waitUntil` task: neither classification token acquisition
nor the dispatch response is awaited by review admission or webhook acknowledgement.
Dispatch failures are advisory and caught independently. The standalone workflow
has its own `pr-classification-*` concurrency group, not a review queue lease or
sweep concurrency slot, so a classification run does not gate or cancel a review.
Both lanes still share GitHub API limits and hosted Actions account capacity.

The workflow checks current PR metadata again and fills a missing P0–P3 priority
and supported `impact:*` labels from the existing taxonomy. Existing priorities
are never replaced; if any impact classification exists, it is preserved without
adding competing impacts. Other labels are untouched. A later full review remains
authoritative and can replace the preliminary classification. This lane never
reviews source, posts a verdict/comment, marks proof/readiness, completes a review
request, or populates a review cache.

It makes at most one native OpenAI Responses request using `gpt-6-luna` by
default, independent of the review and intake models. Set repository variable
`CLAWSWEEPER_CLASSIFICATION_MODEL` to override it or `off` to disable it.
The existing `OPENAI_API_KEY` secret is required. Only repository, PR number,
title and body are sent, after trusted secret scanning: 12 KB input, 256 maximum
output tokens, a 20-second scan/request budget, strict finite JSON output, no tools,
no stored responses, and no application retry or model fallback. Oversized,
unclear, refused, malformed or unavailable results publish no labels. This is
submission-based prioritization, not verification of the author's claims or
code correctness. No calibrated classification accuracy or production latency is
claimed; Actions startup and scanner setup add wall-clock overhead beyond the
model call.

Runs serialize per PR and reread metadata before paid inference and each label
write. Source/head/label/timestamp drift aborts publication. This uses the existing
freshness guards, not a cross-writer transaction; concurrent human edits or full
reviews can still invalidate a run. Distinct action-ledger inference intent,
usage and mutation receipts exclude title/body/prompt/output text. An uncertain
mutation is not blindly retried. Deployment requires the workflow on main, the
Worker dispatch change, and the existing App's Actions-write permission on
`openclaw/clawsweeper` and label-write permissions on the target.

To reproduce the controlled runtime proof after building and installing the
trusted scanner, run `node scripts/prove-pr-classification.mjs`. It executes the
compiled workflow main in child processes against a loopback Responses service
and an executable GitHub fixture, with the real scanner, metadata reader,
label publisher and durable receipt path. The JSON trace defaults to
`.artifacts/pr-classification-proof.json` and covers missing-priority maintainer
classification, a no-spend repeat, refusal, source drift, locked and closed PRs.
It does not spend on a real model or change GitHub; model accuracy, actual costs,
hosted Actions startup and production deployment are outside this proof.
