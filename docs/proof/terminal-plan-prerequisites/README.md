# Generated terminal-plan prerequisites

## Claim and owner

A generated terminal plan must include build/code-generation prerequisites not
provided by the effective repository setup. The production review prompt now
supplies that trusted setup and explicitly identifies the separate cold checkout.
The executor still runs declared commands faithfully; it neither guesses missing
builds nor deduplicates commands. Public schema, profile defaults, assertions,
timeouts, and publication are unchanged. OpenClaw Bay needs no change.

This is separate from [PR1259](https://github.com/openclaw/clawsweeper/pull/1259),
whose command-preservation/one-shot proof remains sufficient and whose landing
was not changed by this work.

## Historical evidence

The [review](https://github.com/openclaw/clawsweeper/pull/1259#issuecomment-5434890771)
at `2026-08-27T07:17:28.253Z` covered head
`a08acddf53cc688d4fd38206898fb35023c9c1f6`. Its
[producer](https://github.com/openclaw/clawsweeper/actions/runs/33048926593) ran
source `ff813ac2fa76d853d8a9129e6763d09624cafe72`. The retained report supplied the
actual generated plan below; the original full model-output JSON was not retained.

```bash
node --test --test-name-pattern='preserves every terminal command including exact entry repeats|terminal entry with expectations executes once' test/decision-parser.test.ts test/live-proof.test.ts
```

Both test modules import `dist/clawsweeper.js`. The report's verification records
`ERR_MODULE_NOT_FOUND` in both, then the first `expect_output` timing out and the
second not running. There are no `run` actions in this plan, so command replay is
not its cause. Building the controller did not build the independently materialized
proof target. The configured target setup installs dependencies with scripts
suppressed; it does not compile the target.

The producer already had general build-sequencing guidance. Its prompt builder
injected the profile's policy note but not the effective execution setup or cold
checkout contract. Thus this is a prerequisite omission despite general guidance,
with an explicit context gap—not proof that the model never saw build information.
The complete historical prompt/tool-read sequence is unavailable, so whether it
assumed a warm checkout or overlooked the imports is not established.

## Controlled real proof

The controller used the uncommitted follow-up over fresh main
`71df3a1ce714d737e250008597075bb5eaeb2ac4`; source/build hashes are retained in
[evidence.json](evidence.json). Independent cold targets used that unchanged main
snapshot, which already contains the landed PR1259 semantics. This did not rerun
or dispatch the historical GitHub workflow.

Production prompt assembly and the unchanged production decision schema were
used for a fresh constrained Codex generation. The request fixed the original
test pattern/files and two expectations, supplied their real source context,
and prohibited tools. It did **not** instruct the generator to build or supply
an expected plan. The existing generation helper attested restricted filesystem
and network access, denied outside reads/writes, and zero tool calls.

The unedited generated entry was:

```bash
pnpm run build && node --test --test-name-pattern='preserves every terminal command including exact entry repeats|terminal entry with expectations executes once' test/decision-parser.test.ts test/live-proof.test.ts
```

A source-blind validator replayed the retained and fresh plans through production
parsing, `executeLiveProof`, real dependency installation, and real tmux. The
local `--checkout` equivalent deliberately bypassed GitHub lookup/publication.
Each independent target began without `node_modules` or `dist`; after production
setup, dependencies existed but `dist` did not.

| Observation | Retained plan | Fresh generated plan |
| --- | --- | --- |
| Declared / actual entry commands | 1 / 1 | 1 / 1 |
| Test invocations | 1 | 1 |
| Actual terminal exit | 1 | 0 |
| Missing compiled module | Both test files | None |
| Tests | 0 passed, 2 failed | 2 passed, 0 failed |
| Expectations | Both not run | Both observed, `detail: ok` |
| Overall verification | Failed | Passed |
| Compiled output after execution | Absent | Present |

The replay failure is classified as `execution`, unlike the historical
expectation timeout. This proves the same prerequisite defect, not an explanation
of the historical status sampling. The successful proof does not use the existing
`NOT OBSERVED` successful-exit fallback.

Execution used local macOS, Node `v26.7.0`, pinned pnpm `11.10.0`, and tmux `3.7c`,
with separate HOME/cache/tmp, an exact noncredential environment allowlist, and a
dedicated socket. Both task-owned tmux servers were cleaned up. Environment/socket
facts are operator telemetry, not a claim of kernel isolation for target code.
An intermediate receipt incorrectly counted socket-free `tmux -V` as a socket
operation and failed its own safeguard; correcting that observation classification
and rerunning both cases passed without changing target execution.

## Supporting checks and limits

All 159 focused tests passed across prompt context/policy, repository profiles,
parser, live-proof, and review-environment suites. Independent Codex autoreview
reported no actionable findings at its default P0 threshold.

The initial full `pnpm run check` passed static checks, all builds, and lint, but
its full suite reported 3,730 passed, 42 failed, and 9 skipped. All 42 failures
report missing `origin/main` fixture refs. On untouched base, three representative
cases reproduced those failures with the host's `fetch.prune=true`; the identical
cases all passed with only a process-local `fetch.prune=false` override. This
confirms a pre-existing Git-fetch interaction, not a prerequisite-patch regression.
The three affected files under that override had 225 passed, 1 failed, and 3
skipped, with no missing-ref failure remaining. The remaining fixture could not
resolve its separate `pnpm@10.33.0` in the package mirror. Neither broad gate is
claimed green. No persistent Git settings, assertions, or unrelated code changed.

This is a bounded generation → parser → setup → terminal proof, deliberately
using the originally selected tests. It does not prove unconstrained future
planner compliance, recording, publication, or outer review-job materialization.
Existing execution regression tests support repeated-command/one-shot semantics;
this diagnostic itself invokes its selected tests only once. No live apply/close,
workflow pause/dispatch, GitHub write, raw transcript, or private model identifier
was used in this evidence.
