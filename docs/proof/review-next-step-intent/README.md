# PR next-step intent renderer proof

- Status: historical proof recipe, not an operator runbook
- Owner: ClawSweeper review maintainers
- Source: [replay](replay.mjs), [report producer](../../../src/clawsweeper-report-document.ts),
  [intent reader](../../../src/clawsweeper-next-step.ts), and
  [checklist renderer](../../../src/clawsweeper-report-comment-helpers.ts)
- Baseline: `39592f04448bdc34d37b9e7f8d5c5d7c828b73f2`
- Update when: next-step serialization, checklist projection, ratings, or markers change

## Claim and limits

Explicit `nextStep: {kind: "none", text: ""}` removes the spurious PR checklist
item and readiness count for “No concrete repair remains after this review.”
Required actions survive contrast, negation, and missing action keywords.
Independent findings and security blockers remain visible; legacy or malformed
intent retains conservative inference. Scores and automation markers stay identical.

The trigger was the [public review comment](https://github.com/openclaw/clawsweeper/pull/1341#issuecomment-5499517784)
reviewed at `2026-09-01T21:41:39.976Z` on
`a9455acae0abc0f3025d5944e0cd1db7fc9ddd92`. **Its historical raw structured record
was not recovered.** All inputs here are synthetic, including the 5/6 ratings,
proof assessment, source IDs, and typed intent. This does not claim the original
review contained the new field or reconstruct its missing data.

## Run

Use Node 24+ and this repository's installed, pinned pnpm dependencies. From
the repository root, build the pinned baseline in a new temporary directory
without switching or editing any checkout:

```sh
REPLAY_ROOT="$(git rev-parse --show-toplevel)"
BASELINE_SHA=39592f04448bdc34d37b9e7f8d5c5d7c828b73f2
BASELINE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clawsweeper-next-step-baseline.XXXXXX")"
git archive --output="$BASELINE_DIR/source.tar" "$BASELINE_SHA"
tar -xf "$BASELINE_DIR/source.tar" -C "$BASELINE_DIR"
cmp pnpm-lock.yaml "$BASELINE_DIR/pnpm-lock.yaml"
ln -s "$REPLAY_ROOT/node_modules" "$BASELINE_DIR/node_modules"
"$REPLAY_ROOT/node_modules/.bin/tsc" -p "$BASELINE_DIR/tsconfig.json"
"$REPLAY_ROOT/node_modules/.bin/tsc" -p "$BASELINE_DIR/tsconfig.repair.json"
pnpm run build:node
node docs/proof/review-next-step-intent/replay.mjs \
  --baseline-dist "$BASELINE_DIR/dist" --baseline-sha "$BASELINE_SHA"
```

Stop if any command fails. The baseline needs its archived `package.json` and
`config/` beside `dist/`, with dependencies resolvable through `node_modules/`.
No install, toolchain changes, network, model calls, or GitHub operations are
needed. The temporary baseline can be removed after inspection.
The baseline invokes the same installed compiler/configurations as
`build:node` directly because pnpm's automatic dependency check may otherwise
try to reinstall through the shared dependency symlink in a temporary archive.

`--baseline-dist` accepts another trusted compiled baseline with its full
`--baseline-sha`. That SHA is a declared provenance reference, not proof that
arbitrary supplied build bytes came from it; the receipt records compiled hashes.
The candidate always comes from `dist/` in the script's repository.
`--output-dir` defaults to `.artifacts/next-step-intent/proof` relative to that
repository; absolute paths are also accepted. Keep generated output locally ignored.

## Observable proof

Ten paired cases feed the **same serialized report bytes directly to both real
compiled renderers**, not to different schemas or different input versions. Each
asserts checkbox and readiness counts, all three 5/6 scores, identical score
text, and identical nonempty automation markers. The six original cases cover
the reported phrase with explicit none, legacy required action, required
contrast, keyword-free required human action, an independent finding, and the
legacy none sentinel. Four controls add required negation, the reported phrase
without metadata, malformed none metadata, and an independent security concern.

A separate producer roundtrip runs the real decision parser, report writer,
intent reader, and renderer. Only surrounding context/formatting dependencies
use synthetic wiring; no model or reviewer runs. The resulting report must
preserve explicit none and render no next-step item or remaining count.

Inspect `result.json`, `before.md`, `after.md`, per-case `.report.md` / `.before.md`
/ `.after.md`, and `producer-roundtrip.report.md` / `.after.md`. The receipt
records current Git SHA and dirty state, fixture and source hashes, compiled
owner hashes, baseline SHA/provenance, runtime, and each observable assertion.
The provider is local Node, with no container image or lease. Rebuild and rerun
after committing before using the receipt as committed-head evidence.

This proves local producer/persistence/rendering behavior, not live publication
or repair/automerge eligibility. No old records are migrated. Other independent
blockers have focused regression coverage, not an exhaustive replay here.
OpenClaw Bay needs no change: its observer projection does not consume this
checklist, and no observer routes or controls change.
