# Historical proof classification

- Status: historical repair proof recipe; not an execution runbook
- Owner: ClawSweeper review and publication maintainers
- Baseline: `f72ea010c1d7fd134b1bd0826b3a707778c312bc`
- Update when: historical receipt folding, report proof classification, labels,
  ratings, or merge markers change

This proves ClawSweeper's classification of historical artifacts, **not Gateway
authorization**. Automatic live proof remains retired. The recipe runs the
retained production CLI and public report projections, without executing a
target checkout or creating a replacement proof lane.

## Reproduce locally

From this checkout, using existing Node >=24 and pinned pnpm 11.10.0:

```sh
pnpm run build:all
node docs/proof/historical-proof-classification/run-proof.mjs .artifacts/historical-proof-classification
```

The output directory must not exist. The recipe works with local Node on macOS
and Linux; it needs no tmux, browser, video toolchain, accounts, or credentials.
It passes only PATH, a new local HOME, and LANG to the child CLI. Every bundle
lacks a media manifest, so there is no R2 upload. The production publication
command rejects live-head lookup and folds local records without syncing GitHub
comments. The synthetic `clawsweeper:automerge` label tests marker generation
only; nothing enables or executes automerge.

`result.json` records the source HEAD, production diff hash, recipe and fixture
hashes, Node/platform/provider, and each observation. Each scenario retains a
small receipt where applicable, folded report, rendered comment, publication
result, and markers. Generated outputs are local evidence, not files to commit.

## Input provenance and boundary

[The receipt](help-only-receipt.json) originated in a real PTY capture of a
synthetic help-only package on 2026-08-28. Its only behavior was printing
`Usage: openclaw [options] [command]`. No Gateway implementation existed in that
fixture. The captured output and assertion results are preserved, including
the historically reported pnpm version; that version is not a setup instruction.
Only repository, item, and head identity metadata were normalized to
`openclaw/clawsweeper`, `42`, and forty `a` characters. The original plan digest
and capture timestamp are retained.

[The sample report](help-only-report.md) is deliberately synthetic. Its claim
concerns authorization while its ordinary proof assessment is missing. Its
dummy PR binding is never looked up. The recipe also constructs failed and
malformed controls and independent reviewer assessments; these are explicitly
fixture data, not claimed fresh executions or newly verified owner traces.

The exercised production path is `src/clawsweeper-runtime.ts` →
`src/live-proof/publication-artifacts.ts` →
`src/live-proof/attach.ts` (`attachReviewLiveProofArtifact`), followed by
`renderReviewCommentFromReport` and `reviewAutomationMarkersFromReport`.
Classification comes from `src/clawsweeper-report-parser.ts`, status ownership
from the label/presentation owners, and merge proof gates from
`src/clawsweeper-orchestration-foundation.ts`. Schema-v1 plan/identity validation
is still the unmodified production verifier.

## Before and after

[The compact observations](observations.json) record the same original receipt
replayed before and after the repair. Both publications attached successfully;
the erroneous `Verified` and sufficient-label results changed from true to
false. All 22 maintained recipe cases passed locally. The observations record
the tested production diff and recipe hashes; rerun after changing either.

On the baseline, replaying the original captured receipt through the actual
publication CLI returned `published` / `attached`, marked real behavior
`Verified`, and proposed `proof: sufficient` despite the missing authorization
assessment. The intended rejection assertion failed. The fresh terminal
attempts on that baseline instead failed cleanup and produced no receipt;
they are a separate driver issue and are not evidence for this repair.

The maintained recipe expects publication to remain `published` / `attached`,
while the same help success leaves missing proof unresolved, proposes no
sufficient label, and cannot produce a merge-pass marker. It also checks that
independent recording, linked-artifact, and terminal assessments retain their
summary, media attribution, patch cap, and rank-up advice across passed and
failed receipts. Failed/malformed receipts still block merge; unresolved
authority-chain proof is enforced for trusted and external authors. Exemptions,
explicit override, invalid identity rejection, and direct publication without
an attachment are separate controls. Independently sufficient proof clears stale
contributor and maintainer proof-status justifications for both attached and
direct publication, without treating receipt success as proof.

The residual guidance/PASS-scope follow-up extends the recipe to 27 cases. Five
synthetic cases cover an `ExecHostExecutor.swift` coverage gap with unrelated help,
relevant changed-help evidence, substantive native terminal observations, and
independent signed-native linked-artifact/recording attribution. Native scenarios
distinguish successful normal write-half-close from explicit caller-abort
cancellation, PID teardown, and delayed-sentinel absence. These are constructed
classification inputs, not native runs or evidence that the prompt produced the
right assessment. Every attached case also checks that only the Live Proof
section changes, a second production CLI publication leaves the report identical,
and only PASS renders the scenario-scope disclaimer. The original 22 cases and
their core-fix observations above remain intact; current main already passes
them before this wording follow-up.

Limits: this is local publication/runtime evidence, not a live GitHub, R2,
Gateway, native, queue, or terminal-driver test. It does not judge whether a reviewer's
semantic assessment is correct. Bay needs no change: no observer API, lifecycle,
telemetry, timing, or action contract changes, and its retired-path display
switch remains presentation-only.
