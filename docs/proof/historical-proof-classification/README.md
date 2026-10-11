# Historical proof classification

> **Historical-only.** The obsolete driver was removed with the post-review
> proof stack. Recover the original driver and README from pinned pre-cutover
> commit `dbb40525904c2176d192ef6e92c588853e676207` to inspect that implementation.
> Saved evidence is unchanged. Current readers ignore historical attachments;
> they no longer fold receipts, render recordings, or derive blockers from them.
>
> Current record authority and proof projections are covered by
> `test/review-record.test.ts`, `test/review-comment-rendering.test.ts`, and
> `test/pr-review-quality.test.ts`.
> The saved S6b `proof.ts` and `readers.mjs` handoff drivers cover saved-corpus
> render/apply/packet parity, not every synthetic legacy receipt case in this
> recipe. Missing records now require fresh review rather than prose recovery.

- Status: historical repair proof recipe; not an execution runbook
- Owner: ClawSweeper review and publication maintainers
- Baseline: `f72ea010c1d7fd134b1bd0826b3a707778c312bc`
- Current contract: [Live proof](../../live-proof.md#retired-post-review-proof).

The observations below describe the historical classification repair, not the
current runtime. There is no runnable receipt-republication recipe in this
checkout. Current attachment-ignore regression coverage is in
`test/live-proof-report.test.ts`.

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

The historical path used the now-retired post-review artifact publication and
attachment modules followed by comment rendering and automation projections.
That execution and compatibility contract has expired.

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

At that revision, the recipe expected successful attachment publication while
preserving the independent proof assessment, patch rating and authority-chain
requirements. Current readers instead ignore those attachments entirely.

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
