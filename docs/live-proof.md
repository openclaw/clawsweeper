# Live proof

- Status: retired for automatic review generation; compatibility support only
- Owner: ClawSweeper review and publication maintainers
- Source of truth: `schema/clawsweeper-decision.schema.json`,
  `src/live-proof/`, `.github/workflows/sweep.yml`,
  `.github/workflows/exact-review-batch-publish.yml`, and
  `.github/workflows/live-proof-maintenance.yml`
- Update when: the compatibility decision shape, historical artifact validation,
  publication folding, media storage, comment rendering, or retraction changes

ClawSweeper no longer generates live proof during exact-event or scheduled
reviews. Review jobs do not inspect `liveProofPlan`, provision proof-specific
tools, execute pull-request code, record proof results, or upload newly generated
proof files. Exact review bundles contain the review and action ledger only, and
ordinary exact reviews remain eligible for direct publication without waiting
for proof.

There is no automatic replacement proof lane or OpenClaw Bay action. Explicit
maintainer requests use the separate, opt-in consumer described below.
Future review journeys simply omit the former automatic proof delay. Bay has a
presentation-only switch for including the retired proof/legacy-batch path in
historical cards and timing; that switch is off by default and cannot trigger
work.

## Explicit command-triggered proof

Comment once as a human maintainer:

```text
@clawsweeper proof
```

ClawSweeper captures the current PR head automatically. A bounded model judgment
reads the PR description, changed-file patches and existing review/comment context,
then selects the smallest useful set of configured scenarios below. It records
the plan once and runs the selected checks sequentially. It cannot invent shell
commands, candidate YAML, workflows or messaging targets. Missing patches and
uncovered behavior remain explicit gaps; no matching scenario means no dispatch.

To override selection, supply one or more comma-separated scenario IDs:

```text
@clawsweeper proof web-ui-chat-proof,telegram-markdown-parser-fidelity
```

All three IDs can be supplied together. An optional full 40-character SHA after
the list requires that exact current head; otherwise ClawSweeper resolves it.
You never need separate comments for the checks within one request.

| Scenario                            | What it exercises                                                                                               | Limits                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `telegram-markdown-parser-fidelity` | Existing QA catalog scenario: real candidate Gateway send and Telegram formatting for four Markdown regressions | Crabline Bot API emulator; no Test Server, TDLib or live model                               |
| `telegram-bot-e2e-proof`            | One bot DM through TelegramTestServer/TDLib with an external mock provider                                      | A separately named smoke scenario, not general Telegram, groups, commands or streaming proof |
| `web-ui-chat-proof`                 | Browser chat send/render against a mocked Gateway                                                               | A UI smoke scenario, not real providers, channels or authentication                          |

A passing smoke cannot clear a proof blocker for unrelated behavior. The reviewer
must connect the scenario's actual observations to the changed production path.

### Admission and execution

The pilot accepts open, same-repository PR heads in `openclaw/openclaw`; fork
heads are not yet supported. It rechecks human maintainer permission, repository
identity, exact candidate, PR body, target branch and immutable command version.
The recorded base SHA is context, not a candidate-only evidence freshness gate:
ordinary advancement of the same base branch does not invalidate an unchanged
candidate. Retargeting, a changed body/head or edited command needs a new request.

The existing ExactReviewQueue Durable Object persists the immutable claim before
model selection or dispatch, permits one active pilot request and deduplicates
delivery. A multi-check request owns that single slot until all selected checks
finish and one review is queued. Another request while the pilot is busy is
rejected rather than queued. Retries never select again or move to a newer head.
Uncertain
dispatch is reconciled by authoritative run ID or bounded exact request-title
lookup, never blindly retried. Incomplete work expires as inconclusive.
Reconciliation belongs to the existing comment router; ordinary review does not
wait for proof and automatic post-review execution remains retired. Failed or
inconclusive completed checks are retained while the remaining selected checks
continue. An unknown dispatch waits for reconciliation, never starts a replacement.

Automatic planning uses the existing scanned, read-only Codex runner, without
GitHub mutation or queue credentials. It has a two-minute model deadline and
bounded context (at most 300 changed files and fewer than 100 entries on each
review/comment endpoint). Over-budget or unavailable context is inconclusive,
not silently truncated into a confident selection. The hosted router prepares
its existing Codex setup only for enabled proof producers and executable routing;
setup failure leaves automatic proof unavailable without blocking other commands.
A lost planning process is not automatically rerun and expires as inconclusive.

Execution is disabled without an operator-approved workflow/harness pin set:

| Surface                       | Variable prefix              | Workflow                                                                                                                         |
| ----------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Web UI                        | `CLAWSWEEPER_PROOF`          | [OpenClaw Web UI workflow](https://github.com/openclaw/openclaw/blob/main/.github/workflows/mantis-web-ui-chat-proof.yml)        |
| Both named Telegram scenarios | `CLAWSWEEPER_TELEGRAM_PROOF` | [OpenClaw Telegram workflow](https://github.com/openclaw/openclaw/blob/main/.github/workflows/mantis-telegram-bot-e2e-proof.yml) |

Each prefix requires `_WORKFLOW_PATH`, `_WORKFLOW_REF`, `_WORKFLOW_SHA` and
`_HARNESS_SHA`. The two SHAs must identify the same reviewed revision. The named
ref must still resolve to that exact SHA. Use a stationary protected branch at
an approved ancestor of main when main advancement must not move the pin.
The producer independently checks its protected ref, exact workflow revision
and ancestry. These settings do not create/protect branches, provision
credentials, activate other gates or authorize public Telegram traffic.

The consumer sends `candidate_ref`, `request_id`, `pr_number`, and, for
Telegram, the selected `scenario`. Each selected child has a distinct request ID
under the frozen parent plan; producers keep their single-scenario contracts.
The producer echoes the opaque request ID;
it must not derive a replacement. Titles are `Mantis request [<request_id>]`
or `Mantis Telegram request [<request_id>]`. Only run attempt 1 is accepted;
request new evidence instead of rerunning an old workflow run.

### Evidence and the normal readiness decision

The closed `mantis.request-proof.v1` receipt does not authorize itself. The
consumer verifies live target identity, pinned workflow/harness, exact run,
successful trusted observer/finalizer jobs, artifact inventories, archive
digests and observation-file hashes. ZIP parsing rejects unsafe paths, links,
duplicates, corruption and oversized expansion.

The receipt artifact is `mantis-request-receipt-<run>-1`, containing
`receipt.json`. Evidence inventories are scenario-specific:

- Web UI: `mantis-request-web-ui-<run>-1` contains `chat-send.json`,
  `final-reply.json`, `final-reply.png`, and `observer.json`. The last file is
  the trusted observer's inventory manifest, authenticated by the whole-archive
  digest, not a fourth behavioral observation. All four exact paths are required;
  undeclared files and missing or substituted paths are rejected.
- Test Server DM: `mantis-request-telegram-<run>-1` contains
  `telegram-send.json`, `provider-request.json`, `telegram-reply.json`.
  Closed hash-only records bind exact source, run, nonce and salted conversation
  identity. Raw transcripts, credentials, private identifiers and hashes of
  raw provider requests are not public evidence.
- Markdown QA: the same Telegram artifact prefix contains `qa-execution.json`,
  `qa-result.json`, `qa-observations.json`. These bind the exact candidate and
  trusted harness, state `transport: "Crabline"` and `live_service: false`,
  and record the canonical scenario's completed assertions and four observed
  payloads. The consumer rejects cross-scenario or incomplete packages.

Complete observations may establish scenario assertion pass or fail. Missing,
partial, candidate-reported, malformed, stale, unverifiable or infrastructure
failures remain inconclusive. Media, exit zero and authenticated provenance
alone do not establish behavioral sufficiency.

After the selected checks finish, the consumer revalidates all verified evidence
and queues **one normal full independent re-review**, even without
a usable previous full report. It does not splice proof fields into the old
report or preserve stale ratings/decisions. The current review may discover new
code/security concerns and must evaluate current CI and proof applicability.
Normal publication freshness and mutation gates apply. Existing label owners
may clear a justified proof blocker and update readiness only if all remaining
blockers permit it. There is no evidence-granted repair, close or merge
authority, and no special label-suppression or no-router publication path.
The combined package includes the plan, uncovered behavior, every complete
verified child context and explicit inconclusive outcomes. A bounded 18,000-character
allowance applies only to the batch-proof handoff; normal command prompt limits
are unchanged. Evidence is never silently truncated to fit.

### Validation scope

`scripts/e2e/command-proof-batch-loopback.mjs` exercises the compiled request and
reconciliation CLI over loopback HTTP with the real Worker and file-backed SQLite,
reopening the store between invocations. `--auto` uses controlled model output
through the real scanner/runner; `--auto --no-match` verifies no execution for
uncovered behavior. This fixture proves orchestration, not semantic selection.

`scripts/e2e/command-proof-consumer-loopback.mjs` exercises the compiled
consumer, Worker HTTP handlers, file-backed SQLite recreation, receipt/archive
verification, review enqueue and command status using controlled GitHub APIs.
Select `--scenario` for a named profile. Add `--producer-root` to exercise
the actual OpenClaw finalizer; Web UI additionally requires
`--web-ui-observations` from a real retained browser observer run.

Focused review workflow and publication tests exercise full-review execution
and normal label/router ownership. These tests do not prove semantic model
judgment, hosted deployment, live Telegram or permission to activate the lane.
Actual isolated producer execution is separate proof; record its source,
scenario, transport, observations and limits in the PR body.

## Decision compatibility

`liveProofPlan` remains a required decision and report field so older records
continue to parse. New model output is constrained to this empty compatibility
shape:

```json
{
  "status": "not_applicable",
  "surface": "none",
  "terminalCompletion": "not_applicable",
  "reason": "Automatic live proof is retired.",
  "payoff": {
    "kind": "static_text",
    "justification": "No recording payoff is assessed."
  },
  "entry": "",
  "steps": []
}
```

The runtime parser deliberately continues to accept historical
`recommended` and `declined_suspicious` plans, browser and terminal surfaces,
visual payoff kinds, entries, and typed steps. Report generation and parsing
also retain those values. This backward compatibility does not authorize new
automatic execution.

Repository `live_test` profiles and the low-level live-proof modules remain
only because historical tooling and records still depend on their types and
validation behavior. Review prompts no longer receive repository proof setup,
tooling, checkout, or browser-startup execution context.

Historical terminal verification remains compatible with the authoritative
`terminalCompletion` result added before retirement. Existing `exit_zero` and
`ready_while_running` records keep their controller-observed exit, viewport,
and cleanup evidence; new decisions always use `not_applicable`.

For historical `exit_zero` plans, finite commands wait within the remaining
terminal budget before assertions are evaluated against sealed,
controller-observed output. A successful exit does not waive a missing output
assertion. Historical `ready_while_running` plans retain their bounded marker,
stability, and liveness checks. Child standard I/O stays bound to the concrete
PTY path so detached subprocesses can preserve their inherited descriptors.

Retained terminal assertions join only tmux soft wraps, preserving hard newline
boundaries and whitespace for literal matching. The final visual viewport keeps
screen rows, including soft wraps.

The retained verifier also preserves the final watchdog cleanup contract for
historical terminal records: cleanup is bound to the original pane, terminal,
nonce, and lease, requires an exact zero-survivor receipt after the pane dies,
and fails visibly for missing, stale, replaced, surviving-process, or timeout
evidence. Target commands do not inherit `TMUX`, `TMUX_PANE`, or `TMUX_TMPDIR`.
The watchdog sends TERM once with 150 ms total grace, then rediscovers and
identity-checks survivors for KILL and requires two empty scans. It does not
repeat the expensive macOS per-process lease checks in additional TERM sweeps.
Up to eight independent signal workers run together, each revalidating the
lease or original terminal immediately before signaling. Every worker is joined
and its failure retained before the next scan. The controller's cleanup budget
is unchanged. The watchdog removes its private scan file before publishing the
completion receipt, so the controller cannot finish while that file remains.
Failed removal produces a cleanup-error receipt instead of success.

Process exit and PTY closure are separate tmux observations; cleanup waits for
both rather than rejecting their intermediate states. If the original pane
wrapper dies, its exit signal remains the failure reason even when watchdog
cleanup produces a later child status. An already-dead pane is removed only
after its identity and zero-survivor cleanup are verified, allowing tmux to
close the capture pipe. The capture helper must still confirm clean EOF.

## Historical artifact publication

Existing and already-queued proof-bearing artifacts remain supported while they
age out:

- exact-review bundle validation still accepts the historical
  `live-proof/<item>/` inventory
- exact-event, batch, and scheduled publication jobs still validate and fold
  `live-verification.json` into review reports
- valid historical manifests, MP4 recordings, and posters can still be uploaded
  to the established R2 paths
- review comments still render the **Live Verification** section and optional
  recording block
- historical terminal results retain their bounded authoritative final viewport,
  exit status, and cleanup evidence
- the manual **Maintain live proof** workflow can still retract a published
  recording without removing the underlying historical verification

These publication paths consume trusted workflow artifacts; they do not inspect
a new plan or execute target code.

Historical receipts are diagnostic execution evidence. A passed command or
assertion does not establish that the changed behavior was exercised. The
ordinary recorded `realBehaviorProof` assessment owns that judgment, including
relevant deterministic owner evidence assessed by the reviewer. Attaching a
receipt cannot manufacture sufficient proof, replace contributor evidence or
its media attribution, or waive required authority-chain proof. Reviewer patch
ratings and rank-up advice remain independent; stale receipt-era proof credit
may only be capped against the recorded behavioral assessment.

Failed or malformed receipts still block merge independently of proof
exemptions and overrides. When independent behavioral proof is valid, the
receipt failure belongs to the maintainer, not the contributor. Identity and
plan validation, bounded output, historical media publication, and retraction
remain unchanged. No new execution or assessment lane is introduced.

Reviewers should connect the changed production owner and behavior from the diff
to the exercised entrypoint, scenario, environment, and observed result or gap in
the existing proof summary and evidence entries. Generic help, version, startup,
or exit-zero smoke does not prove unrelated runtime or native behavior; help
output can prove a changed help/CLI-output contract. For exec-host cancellation,
distinguish normal write-half-close success from cancellation triggered by
explicit caller abort, full disconnect, or server shutdown. Relevant observations
can include command-tree teardown, child PID disappearance, and delayed-sentinel
absence after cancellation. Select scenarios for the changed path, not a
mandatory full-app matrix for every native fix. Terminal traces of the real path
are valid proof; video is not required. Signing establishes provenance, not
coverage by itself. Independently sufficient native before/after evidence keeps
its classification alongside an unrelated passing help smoke. The PASS rendering
reminds readers that only the declared scenario and assertions passed; the
semantic assessment determines changed-behavior coverage.

## OpenClaw Bay

OpenClaw Bay remains observer-only. Its default beach and one-hour review-time
metric show the normal direct-publication path. A presentation-only **Include
retired proof/batch** switch can add historical automatic-proof and other legacy
batch-path journeys for comparison. The switch is deliberately off by default,
does not affect durable queue state, and adds no queue, workflow, GitHub,
recovery, or other mutation control.
