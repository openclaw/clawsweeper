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

There is no replacement proof lane, execution toggle, or OpenClaw Bay action.
Future review journeys simply omit the former automatic proof delay. Bay has a
presentation-only switch for including the retired proof/legacy-batch path in
historical cards and timing; that switch is off by default and cannot trigger
work.

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
