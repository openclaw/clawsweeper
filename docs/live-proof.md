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

The retained verifier also preserves the final watchdog cleanup contract for
historical terminal records: cleanup is bound to the original pane, terminal,
nonce, and lease, requires an exact zero-survivor receipt after the pane dies,
and fails visibly for missing, stale, replaced, surviving-process, or timeout
evidence. Target commands do not inherit `TMUX`, `TMUX_PANE`, or `TMUX_TMPDIR`.

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

## OpenClaw Bay

OpenClaw Bay remains observer-only. Its default beach and one-hour review-time
metric show the normal direct-publication path. A presentation-only **Include
retired proof/batch** switch can add historical automatic-proof and other legacy
batch-path journeys for comparison. The switch is deliberately off by default,
does not affect durable queue state, and adds no queue, workflow, GitHub,
recovery, or other mutation control.
