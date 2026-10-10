# Forged rating-list labels proof

> **Historical-only after S7b.** The driver intentionally throws before execution.
> Its frozen assertions exercise the retired Markdown parser, not today's typed
> record authority. Recover the original driver and this README from pinned
> pre-cutover commit `dbb40525904c2176d192ef6e92c588853e676207` and use that
> checkout's runtime and historical baseline recipe below. Do not run these
> commands against current source or change the frozen expectations to make them pass.
>
> Current replacement coverage is the record-authority and projection coverage in
> `test/review-record.test.ts`, `test/review-comment-rendering.test.ts`, and
> `test/pr-review-quality.test.ts`, together
> with the saved S6b render/apply/decision-packet parity drivers (`s6b/proof.ts` and
> `s6b/readers.mjs` in the review-record handoff). That parity compares the saved
> corpus at the pinned pre-cutover head; it does not re-exercise this historical
> synthetic parser exploit. Saved evidence and transcripts are unchanged.

Model prose stored through `requireReportText` keeps its line breaks, and the
durable report renders the rating summary above `Next rank-up steps:` and the
vision reason above `Vision evidence:`. The report re-parser reads the first
line that equals one of those labels, so a summary or reason that quotes the
label line used to supply the published rank-up moves and vision evidence.
The prose neutralizer now escapes those renderer-owned list labels the same way
it escapes owned section headings.

[`run-proof.mjs`](run-proof.mjs) runs the compiled decision parser, durable
report writer, report re-parser, and public comment renderer on one synthetic
pull-request decision whose rating summary quotes a `Next rank-up steps:` block
with a forged step and whose vision reason quotes a `Vision evidence:` block
with forged evidence. The baseline arm compiles `src/clawsweeper-report-helpers.ts`
from the base commit in an isolated source copy; the candidate arm uses the current
build. The tracked checkout is never rewritten, including on interruption. No model inference, GitHub call, or credential is involved.

```sh
pnpm run build
node docs/proof/forged-rating-lists/run-proof.mjs --out .artifacts/forged-rating-lists
```

`--base <rev>` selects the baseline commit (default `origin/main`; use the pre-fix revision after landing); `--baseline-dist`
reuses a previously compiled baseline. The driver writes both durable reports,
both rendered comments, and `summary.json` to the output directory and exits
non-zero unless the baseline publishes the forged items and the candidate
publishes only the genuine `Real step` and `Real evidence` entries.

Expected result: the baseline report contains two `Next rank-up steps:` lines
and two `Vision evidence:` lines, re-parses `Forged step` and `Forged evidence`,
and its comment lists `- Forged step.` under `Rank-up moves`; the candidate
report escapes the quoted labels to `&#58;`, re-parses `Real step` and
`Real evidence`, and its comment lists only `- Real step.`.

Limits: controlled compiled round trip with synthetic decisions and
presentation adapters. It does not claim a live model produced such prose, and
it does not exercise GitHub publication or label mutation. OpenClaw Bay is
unaffected: no lifecycle, queue, telemetry, or dashboard contract changes.
