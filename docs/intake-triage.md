# Intake triage

- Status: active by default with native OpenAI authentication
- Owner: ClawSweeper maintainers
- Source of truth: `src/intake-triage-contract.ts`, `src/intake-triage-api.ts`, `src/intake-triage-decisions.ts`, `src/intake-triage-workflow.ts`, `.github/workflows/sweep.yml`
- Last verified: configuration and admission behavior checked against `983558446396c3f44ad7f24e22582c5a2906c58d` and focused intake tests
- Update when: credentials, model defaults, questions, input limits, backends, or provisional labels change

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
and before source hydration. Its preliminary labels remain visible while full
review runs. This is a bounded serial intake phase, not a second background
writer. Oversized metadata-only reviews skip it. A failed optional phase does
not block full review.

The publisher checks the queue lease/generation and unchanged item snapshot
before each label-definition or item write. Only the six known intake labels
can change; all other labels stay owned by their existing publishers. Request
intent, usage and mutation receipts use a distinct intake operation in the
existing action ledger. Interrupted writes are finalized as unknown outcomes,
even when the later full review succeeds. They never complete a review request
or its cache.

Enabled intake invalidates the earlier PR-admission handoff even after an
uncertain write or process failure, so source review hydrates current labels
and timestamps. Only a current complete review removes preliminary labels,
through the existing guarded label batch. Failed, stale and incomplete reviews
leave them explicitly preliminary. There is no automatic cross-backend retry.
