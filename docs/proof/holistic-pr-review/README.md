# Code-first PR review: controlled model proof

> Historical pre-rebase evidence: the receipt below records the earlier source,
> not the candidate rebased onto fe750d1779208b067c1f694dba70f494cb29c401. The
> replay harness now builds that selected baseline from its pinned source and
> renders the current procedure slot. Rebased validation must be recorded
> separately before publication; old results are not relabeled.

- Status: historical proof, not an operator runbook or a production trigger
- Owner: ClawSweeper review maintainers
- Surface: `buildReviewPrompt` through `review --local-range`, including the
  normal input scanner, native Codex process, decision parser, and local report
- Source baseline: `34cc1aa014a16295779cdca4e336479bad5636ec`

## Claim and limits

The production PR prompt now leads with understand → integrated behavior →
challenge/verify → synthesize, before proof/readiness policy. The output contract
remains unchanged, and issue prompt composition is byte-for-byte equal to the
baseline. This proof exercises that prompt with a real model and real source
inspection; string assertions and schema validation alone cannot demonstrate
holistic reasoning.

Two small, self-authored, three-module PR fixtures exercise the same cancellation
feature. One loses the signal between queue draining and execution even though
the immediate path forwards it; the other preserves the task across both paths.
The queue itself preserves tasks and isolates failures, so the reviewer must
trace the caller/queue/worker contract rather than blame the queue or transport.
Expected observations and the evaluator remain outside the reviewer checkout.
`openclaw/review-fixture` is a synthetic local identity, not a GitHub repository.

This is a bounded integration/coverage example, not a representative accuracy
benchmark, a measured improvement in recall/precision, or proof that a model
always follows the intended stages. There is one review per fixture/prompt, no
seed control or repeated trials, and no blinded human adjudication. No extra
model call, provider, confidence threshold, or fan-out is added to production.

## Environment and reproduction

Executed on Linux x64 with Node 26.8.2, pnpm 12.4.1, Codex CLI 0.147.0, model
`gpt-6.1-sol`, medium reasoning effort, read-only sandbox, and approval policy
`never`. The existing author-association profile selects the same effort and
service tier for every run. The runner withholds GitHub credentials, isolates
GitHub configuration, and disables model web search. It still calls the model
service: this is not air-gapped.

No container was used: this is a Linux host, Docker is unavailable, and the
Windows-specific local-container instruction does not describe this environment.
Provider/image/lease: native host / not applicable / not applicable. No GitHub
review, comment, label, merge, deployment, apply, or queue operation was issued.

After `pnpm install --frozen-lockfile` and `pnpm run build`:

```sh
node docs/proof/holistic-pr-review/run-proof.mjs .artifacts/holistic-pr-review/isolated gpt-6.1-sol
```

Choose a new output directory for another run. This is an opt-in paid model
experiment, not part of tests or CI. The harness constructs deterministic Git
fixture histories and clones a fresh target for every review, so previous review
history cannot inform the comparison. It retains exact commands, times, pinned
fixture revisions, prompt/result hashes, decisions, and target-clean checks.

The legacy comparison uses the baseline `review-item.md` under the same current
runner (with an empty PR procedure, adding only leading blank lines). It compares
prompt content, not two different execution engines. The normal scanner/bootstrap
is retained in both runners; no admission guard is mocked or disabled.

## Evidence

See [receipt.json](receipt.json) for exact input identities, UTC run windows,
commands, result digests, and the selected final decision fields. Local paths in
that published receipt are normalized to `$WORKTREE`/`$OUTPUT`; raw prompts,
model tool transcripts, reports, and process logs remain in the ignored output
directory. No hidden reasoning transcript is published.

The fixtures deliberately omit contributor runtime proof. The model must keep
that policy assessment separate from its source-backed correctness judgment;
`realBehaviorProof: missing` for a fixture is not a failed model integration.

## Observed comparison

| Prompt | Cross-path defect | Clean control |
| --- | --- | --- |
| Candidate | One P2 signal-forwarding finding; incorrect | No findings; correct |
| Legacy | One P2 signal-forwarding finding; incorrect | No findings; correct |

All four local-range runs exited successfully and left their target checkouts
clean. Both candidate summaries explain before/after behavior; their evidence
traces the immediate and queued paths and failure isolation. The candidate
rejects the suspected queue-loss explanation by observing that the queue retains
the complete task and the service drain drops the signal. The clean control
keeps missing contributor proof separate from a correct patch verdict.

The legacy prompt also catches this defect and accepts the control. This sample
therefore demonstrates integration and the requested output coverage, **not an
accuracy improvement over the legacy prompt**. An evaluator-only execution of
the fixture independently confirmed pre-aborted immediate rejection, loss versus
preservation of queued cancellation and signal identity, and successful later
queued work; those observations were not placed in model context.

## Validation scope

Production-construction tests distinguish PR and issue paths, stage ordering,
static-prompt telemetry, intact shared guards, source context, and maintainer
input. Existing prompt/closure regressions exercise policy preservation. The
controlled runs add observed model behavior and source inspection on top of
those deterministic checks.

Focused production/policy regression run: **148 passed, 0 failed**.
`pnpm run check` completed static checks, all builds, lint, and the focused
coverage gate; the full coverage run reported **7,194 passed, 4 failed, 19
skipped (7,217 total)**. All four failures reproduce against an isolated archive
of the unchanged source baseline on this host:

- `apply-drift-refresh`: shell fixture resolves real pnpm and fails without a
  package manifest in its temporary directory.
- `exact-review-queue-maintenance-workflow`: shell fixture invokes the real CLI
  rather than its expected argument recorder and reports `retirement_failed`.
- `setup-codex-action`: corrupt-download fixture unexpectedly exits zero.
- `target-dispatcher-workflow`: dispatcher fixture fails its worker-rejection
  scenario.

These are not waived or repaired by this prompt change; the aggregate gate is
**not green**. Baseline reproduction used the same Node/pnpm dependencies,
baseline source compiled with the repository tsconfigs, and the four named test
files. Raw receipts remain in the task artifacts (`check.log`, `base-check.log`,
and `base-dispatcher-check.log`). No live mutation was authorized by these
fixture tests.

OpenClaw Bay is unaffected: no decision schema, report field, publication
contract, lifecycle, queue, or public observer data contract changes.
