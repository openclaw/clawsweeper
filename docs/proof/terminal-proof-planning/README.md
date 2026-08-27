# Terminal proof planning

Status: local proof for an uncommitted change based on
`f211e21fb89d00777ac07cc13c358f9f7b02a939`. This record does not authorize a
commit, publication, or live mutation.

## Claim and provenance

The planner should describe a one-shot terminal proof once, while the parser and
driver preserve every intentional command and all existing failure gates. Entry
runs automatically before steps; a run step is another execution, never a
restatement of entry.

[The successful entry and failed replay on PR 1240](https://github.com/openclaw/clawsweeper/pull/1240#issuecomment-5403433718)
exposed a plan that ran a non-overwriting proof twice. The
[PR 1254 producer artifact](https://github.com/openclaw/clawsweeper/actions/runs/33033345816)
also repeated entry as its first run: that run failed waiting for entry, even
though the captured output later contained exit zero and successful validation.
Those are distinct failure observations. The producer and this base have identical
terminal drivers. Independent real-tmux probes confirmed that a previous-command
timeout remains failed even if entry finishes successfully during final capture:
the requested next command never ran. That probe deliberately injected capture
latency to establish the ordering, not to claim the producer experienced it. The
original artifact lacks status-sample timestamps, so no distinct driver status bug
is established. Driver supervision, deadlines, and failure latching are unchanged.

[PR 1256](https://github.com/openclaw/clawsweeper/pull/1256), present in the base,
silently removed an exact leading duplicate. This change removes only that
normalization, restores command-preservation tests, and clarifies the production
prompt and schema descriptions. Its cold-build/final-output verification changes
remain intact. The public schema's properties, types, required fields, enums,
and bounds are unchanged.

Release-note context, retained here following the release-owned changelog
disposition in PR 1256: terminal proof planning now explicitly separates automatic
entry execution from subsequent commands, avoids accidental one-shot replays for
media, and preserves intentional repeated commands.

## Reproduce

Use Node 24 or newer, the repository pnpm, real tmux, and an authenticated Codex
CLI using the host's approved routing. Do not put private model identifiers or
raw agent transcripts in proof records. Run from this checkout after building:

```bash
pnpm run build
mkdir -p .artifacts/terminal-proof-planning
node scripts/e2e/terminal-proof-planning.mjs prepare .artifacts/terminal-proof-planning/fast fast
```

`prepare` uses the production review-prompt assembly and full decision schema.
The only extra input is a synthetic, fully supplied local fixture review request;
it supplies commands and expected output, not a hand-written plan. It writes the
exact prompt/schema inputs and their hashes. Generate the decision with real
Codex inference, without executing any commands from the prompt:

```bash
proof_bundle="$PWD/.artifacts/terminal-proof-planning/fast"
planner_cwd=$(mktemp -d)
codex exec --yolo --ephemeral --skip-git-repo-check -C "$planner_cwd" \
  --output-schema "$proof_bundle/schema.json" \
  -o "$proof_bundle/decision.json" - < "$proof_bundle/prompt.md" \
  > /dev/null 2> "$planner_cwd/codex.stderr"
node scripts/e2e/terminal-proof-planning.mjs run "$proof_bundle" fast
```

Repeat with a fresh directory and `delayed` instead of `fast` in both script
invocations. The delayed command emits a startup line, then takes 34 seconds,
longer than entry startup polling. No driver timeout is extended. Existing
directories are refused; use new names for subsequent captures.
Inspect temporary Codex diagnostics locally if generation fails; do not copy
them into the proof bundle or public artifacts. Retain only the structured
decision and a sanitized generation receipt.

The replay script parses the full model decision through the production parser,
requires the generated plan to survive unchanged, checks its command allowlist,
and executes it through the production terminal driver on a dedicated real tmux
server. It requires all five assertions to be observed, not merely schema-v1
successful-exit fallback. Files and invocation traces prove single execution and
byte preservation on a refused replay. Hand-written negative controls are clearly
marked separately from model-generated proof: an exact leading duplicate must
execute and fail, identical later commands must observe a changed state, exit 7
must fail, and a silent 40-second command must hit the real 30-second timeout.

`inputs.json`, `decision.json`, `generation.json` (when captured by the parent),
per-scenario `live-verification.json`, and `receipt.json` remain under ignored
`.artifacts/terminal-proof-planning/`. Compact receipts beside this note record
actual results, provenance, and hashes; no raw transcripts are included. The
source-hash guard rejects replay after any recorded implementation input changes.
The recorded head is the base plus those uncommitted input hashes, not a claim
that the change has been committed; record the final head if it is committed later.

## Observed results

Both fresh Codex generations passed on local macOS with Node `v26.7.0` and
tmux `3.7c`. The fast plan put the command only in entry and chose static text.
The delayed plan chose setup entry, one run, a 35-second wait, and expectations.
Both observed all five success assertions and invoked the proof exactly once.
Both refused a replay with exit 17 and preserved the original result bytes. In
each run, the exact leading duplicate executed and failed, the intentional later
repeat observed changed file state, exit 7 failed, and the silent command hit the
existing 30-second timeout. `receipt.json` records normalized plans, outcomes,
generation provenance, source hashes, and hashes of the full ignored receipts.

An independent repeat generated two more plans from the same production inputs
and replayed them on Node `v24.19.0` with tmux `3.7c`. Both again invoked once,
observed all five assertions, preserved bytes on refused replay, and passed all
four negative/intentional-rerun controls. The delayed generation used setup plus
one run without an explicit wait; existing expectation polling observed completion.
This is four observed generations, not a guarantee of all future planner output.

Focused validation passed all 138 tests:

```bash
node --test test/decision-parser.test.ts test/review-prompt-policy.test.ts \
  test/review-prompt-context.test.ts test/live-proof.test.ts
```

Documentation checks and `git diff --check` passed. The full repository check was
started with `pnpm run check`; see `.artifacts/terminal-proof-planning/check.log`
for the actual final outcome, rather than inferring success from focused proof.

## Limits

This is a controlled terminal fixture, not Worker/apply functional correctness,
live GitHub behavior, or evidence that every future model plan is correct. The
driver runs with recording disabled even if the planner chooses a media payoff;
setup/action/expectation execution can be verified, but video recording and
publication are not claimed. No accounts, target services, live apply/close,
workflow changes, or external artifact uploads are used by the fixture.

OpenClaw Bay is unaffected: the schema shape, verification lifecycle, publication
contract, and observer-only ownership are unchanged. The PR 1254 artifact does not
prove when the supervised entry exited; later target JSON saying exit zero is not
authority to erase a timeout or pass an unexecuted run.
