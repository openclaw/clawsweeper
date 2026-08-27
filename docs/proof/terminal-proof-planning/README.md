# Terminal proof planning

Status: fresh constrained generation and local proof at runtime head
`ca48d41487affa905cb775da8a985d1b128b18c3`, with the generator and documentation
fix still uncommitted. Exact final-head replay remains pending. This record does
not authorize a commit, publication, or live mutation.

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
CLI with the built-in ChatGPT-backed provider. The generation helper currently
attests macOS Seatbelt and CLI `0.150.0-alpha.13`; other platforms or versions
must be re-attested, not allowed to fall back to full access. Do not put private
model identifiers or raw agent transcripts in proof records. Run from this
checkout after building:

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
node scripts/e2e/terminal-proof-generate.mjs "$proof_bundle"
node scripts/e2e/terminal-proof-planning.mjs run "$proof_bundle" fast
```

An optional second helper argument selects the host-approved model for this
invocation only; it is never written into the sanitized receipt. User routing
configuration is intentionally ignored. Authentication uses the existing login;
no credentials are copied or extracted.

Generation is a distinct constrained workflow. The helper supplies the entire
production prompt and schema as data to `codex exec --ignore-user-config
--ignore-rules --ephemeral --strict-config`, with approval `never` and the named
`terminal-proof` permission profile. That profile allows minimal OS reads and
reads of an empty workspace, no writable paths, and no child network access.
The CLI adds read access to its bundled shell and executable shim; the helper
also verifies those effective runtime roots from the session-start trace.
Shell execution, image reads, web search, MCP, plugins, skills, hooks, and nested
agents are disabled; no executable fixture is placed in the workspace. Ancestor
project configuration is refused and project instructions are disabled. Only
the CLI's own inference/authentication transport may contact the configured
service. A temporary cwd or a textual instruction alone is not this boundary.

Before inference, a trusted sandbox probe must fail to read a harmless sentinel
outside the workspace and fail to create a file inside it. After inference, the
helper checks actual startup settings and the model-facing request's tool
inventory, requires zero tool calls, and only then copies the generated decision
into the bundle. This CLI has no blanket no-tools flag: its remaining
`apply_patch` tool is restricted by the same read/write sandbox. Model metadata
can require Code Mode despite feature flags, so the helper fingerprints the
inspected `exec`/`wait` wrappers: their V8 environment has no Node, filesystem,
or network primitives and exposes only sandboxed `apply_patch`. An optional
user-message tool has no filesystem or network authority. Unexpected tools,
changed wrapper definitions, missing trace evidence, or failed checks stop the
helper. Do not replay a decision until its attestation passes.

Repeat with a fresh directory and `delayed` instead of `fast` in both script
invocations. The delayed command emits a startup line, then takes 34 seconds,
longer than entry startup polling. No driver timeout is extended. Existing
directories are refused; use new names for subsequent captures.
Inspect temporary Codex diagnostics locally if generation fails; do not copy
them into the proof bundle or public artifacts. The helper retains only the
structured decision and sanitized `generation.json` in the bundle. Local raw
traces are diagnostic evidence, never publication artifacts.

The replay script parses the full model decision through the production parser,
requires the generated plan to survive unchanged, checks its command allowlist,
and executes it through the production terminal driver on a dedicated real tmux
server. It requires all five assertions to be observed, not merely schema-v1
successful-exit fallback. Files and invocation traces prove single execution and
byte preservation on a refused replay. Hand-written negative controls are clearly
marked separately from model-generated proof: an exact leading duplicate must
execute and fail, identical later commands must observe a changed state, exit 7
must fail, and a silent 40-second command must hit the real 30-second timeout.

`inputs.json`, `decision.json`, `generation.json`,
per-scenario `live-verification.json`, and `receipt.json` remain under ignored
`.artifacts/terminal-proof-planning/`. Compact receipts beside this note record
actual results, provenance, and hashes; no raw transcripts are included. The
source-hash guard rejects replay after any recorded implementation input changes.
The receipt distinguishes the runtime head, original base, source hashes, and
generator hash. It does not claim proof of a later commit.

## Observed results

Both fresh constrained Codex generations passed on local macOS with Node `v24.19.0` and
tmux `3.7c`. The fast plan put the command only in entry and chose static text.
The delayed plan chose setup entry, one run, and expectations, with no explicit
wait; existing expectation polling observed the delayed completion.
Both observed all five success assertions and invoked the proof exactly once.
Both refused a replay with exit 17 and preserved the original result bytes. In
each run, the exact leading duplicate executed and failed, the intentional later
repeat observed changed file state, exit 7 failed, and the silent command hit the
existing 30-second timeout. `receipt.json` records normalized plans, outcomes,
generation provenance, source hashes, and hashes of the full ignored receipts.

Each generation trace shows one actual inference request and zero tool calls,
approval `never`, the active `terminal-proof` profile, restricted filesystem
reads, no writable paths, and restricted network access. The harmless outside
sentinel read and workspace write were both denied. The generated workspace
remained empty. No model-directed fixture execution occurred during generation.

The latest receipt comes from two fresh inference calls using the final helper
unchanged, followed by real-tmux execution. Both calls passed the built-in
permission and tool-inventory checks directly; neither decision was edited,
reused from an earlier generation, or retrospectively re-attested. Diagnostic
attempts during helper development remain local and are not the published proof.

This receipt supersedes the full-access generation receipt preserved at
[the previous head](https://github.com/openclaw/clawsweeper/blob/ca48d41487affa905cb775da8a985d1b128b18c3/docs/proof/terminal-proof-planning/receipt.json).
The earlier four runtime demonstrations are historical observations, not evidence
of isolated generation. None of their decisions was reused here. These two new
observations are not a guarantee of all future planner output.

Focused validation passed all 138 tests:

```bash
node --test test/decision-parser.test.ts test/review-prompt-policy.test.ts \
  test/review-prompt-context.test.ts test/live-proof.test.ts
```

Build, helper syntax/lint/format, documentation checks, and `git diff --check`
passed. The full repository suite was not rerun for this narrow correction:
the earlier run's 49 diagnosed host-fixture failures (Git pruning, offline pnpm,
and timing) remain outside this patch. No full-suite success is claimed; CI must
run again after the parent-reviewed commit.

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
