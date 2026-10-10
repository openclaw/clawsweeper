# Forged evidence continuation fields proof

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

Evidence entries are stored in the durable report as a bold list heading
followed by `- repo:`, `- file:`, `- sha:`, and `- command:` continuation
items, and related people as a heading followed by `- reason:`, `- commits:`,
`- files:`, and `- attribution source:` items. The report re-parser reads
those continuation items back, last occurrence wins. Evidence detail and
owner reason prose keep their line breaks, so a detail that quoted such a
list item used to attach a file, commit, or command that was never part of
the structured decision. The prose neutralizer now escapes those continuation
fields the same way it escapes finding `body`, `late`, and `confidence`
items.

[`run-proof.mjs`](run-proof.mjs) runs the compiled decision parser, durable
report writer, report re-parser, and public comment renderer on one synthetic
pull-request decision with a single evidence entry whose detail quotes a
`- repo:`, `- file:`, `- sha:`, and `- command:` block. The baseline arm
compiles `src/clawsweeper-report-helpers.ts` from the base commit inside an
isolated copy of `src/` under the output directory (with its own
`package.json` and a link to the repository's `node_modules`), so the tracked
checkout is never modified; the candidate arm uses the current build. No
model inference, GitHub call, or credential is involved.

```sh
pnpm run build
node docs/proof/forged-evidence-fields/run-proof.mjs --out .artifacts/forged-evidence-fields
```

`--base <rev>` selects the baseline commit (default: the merge base with
`origin/main`, or `HEAD~1` once the change is on `main`); `--baseline-dist`
reuses a previously compiled baseline. The driver writes both durable reports,
both rendered comments, and `summary.json` to the output directory and exits
non-zero unless the baseline re-parses the forged file, commit, and command
and links the forged commit in the comment while the candidate re-parses the
genuine entry with no file, commit, or command and its comment carries no
forged location.

Expected result: the baseline durable report keeps the quoted items as
trusted continuation lines, so the entry re-parses with `file: src/evil.ts`,
the forged 40-character `sha`, and `command: pnpm evil`, and the public comment
links the forged commit; the candidate report stores the quoted items as
`repo&#58;`, `file&#58;`, `sha&#58;`, and `command&#58;`, the entry re-parses
with the genuine repository only, and the comment mentions no forged path,
commit, or command.

Limits: controlled compiled round trip with a synthetic decision and
presentation adapters. It does not claim a live model produced such prose, and
it does not exercise GitHub publication or label mutation. OpenClaw Bay is
unaffected: no lifecycle, queue, telemetry, or dashboard contract changes.
