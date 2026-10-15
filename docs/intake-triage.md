# Intake triage

- Status: active classifier contract; workflow publication is a separate integration
- Owner: ClawSweeper maintainers
- Source of truth: `src/intake-triage-contract.ts`, `src/intake-triage-api.ts`, `src/intake-triage-decisions.ts`
- Last verified: based on `66bc4576148f0659d1d3f91bc9d323c3e77516a2`
- Update when: questions, input limits, backends, or provisional labels change

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
The Responses adapter uses `gpt-6-luna` unless its caller explicitly selects a
model, with strict structured output and response storage disabled.

Labels in the finite `clawsweeper:intake:*` family are preliminary. They never
set priority, impact, reproduction proof, good-first-issue eligibility, maturity,
merge risk, or readiness. They must be removed by the normal completed-review
publication. Intake must not satisfy review requests or populate review caches.

Adding a cheap call before a full review adds spend. Cost savings require moving
an existing metadata task to intake, not counting both calls as a saving.

The optional Decisions adapter calls `POST /v1/decisions` with `gpt-6-luna` and
three choice questions. It validates names, choices, complete distributions,
finite probabilities, and refusals. Native choice distributions are retained
separately; Responses does not invent matching confidence values. No probability
threshold is presented as calibrated without labeled production examples.

See the [official Decisions contract](https://developers.openai.com/api/docs/guides/decisions).
Decisions failures abstain. They do not automatically spend on Responses or
resubmit scanner-refused content. The ordinary Responses adapter remains an
independent path for deployments without Decisions access.
