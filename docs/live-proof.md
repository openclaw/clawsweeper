# Live proof

- Status: inline review proof active in code; retired post-review artifacts remain compatible
- Owner: ClawSweeper review and publication maintainers
- Source of truth: `src/review-proof-client.ts`, `src/codex-app-server-worker.ts`,
  `dashboard/review-proof-execution.ts`, `dashboard/exact-review-queue.ts`,
  and `src/repair/comment-router.ts`
- Last verified: expiry acknowledgement repair `5d5fd577d2`
- Update when: supported tools, admission, producer bindings, deadlines, evidence,
  command routing, or historical publication compatibility changes

ClawSweeper can request relevant behavioral checks during an eligible
`openclaw/openclaw` PR review. Results return to that same review turn before
its decision. This is not the retired automatic post-review recording step:
there is no mandatory check on every PR and no second review after proof finishes.

## Maintainer commands

A human maintainer can request proof-focused review with one comment:

```text
@clawsweeper proof
```

The router captures the current PR head automatically and queues the normal
exact review with proof-focused instructions. The reviewing agent selects useful
supported checks from the PR and code changes. To restrict its tools, name one
or both supported scenarios:

```text
@clawsweeper proof web-ui-chat-proof,telegram-bot-e2e-proof
```

An optional full 40-character SHA after the selection requires that exact current
head. The admitted decision carries the captured SHA and scenario allowlist;
an edited command or changed head cannot silently widen or retarget it.
The explicit selection is enforced by the backend, not just prompt guidance.

| Scenario | Current coverage | Limits |
| --- | --- | --- |
| `web-ui-chat-proof` | Fixed browser chat send and final-reply rendering against a mocked Gateway | No arbitrary browser plan, real channel, provider or authentication claim |
| `telegram-bot-e2e-proof` | Bounded PR-specific data-only Telegram plan executed by the trusted producer | Coverage depends on the accepted plan and captured observations, not a generic Telegram pass |

`telegram-markdown-parser-fidelity` is not an inline tool. Legacy recipe names
may still parse for compatibility, but unsupported selections expose no matching
tool and must be reported as coverage gaps. Do not request a third automatic
check or assume the legacy Markdown recipe will execute from a comment.

## Review-owned admission and execution

The current path accepts open, unlocked, same-repository PR heads in
`openclaw/openclaw`; fork heads are not supported. The host queries allowed
capabilities using the full live exact-review lease. Unavailable capabilities
mean no proof tools, not unrestricted defaults. The model receives neither a
global queue secret nor GitHub mutation credentials.

Each proof request is bound to its owner lease, candidate head, scenario and
canonical plan digest in the existing queue item. A review may admit at most
three distinct plans; repeated requests deduplicate without dispatching again.
These are three plans, not three supported scenario types. All plans share a
20-minute ceiling starting with the first request, not 20 minutes each. Completed
checks return immediately; the ceiling is not a mandatory wait. The client uses
the queue's authoritative expiry and retains the earliest deadline for the same
review capability; later plans cannot restart the clock. Checks also
consume the existing review budget, with up to 90 seconds reserved for its final
decision. With the default 20-minute review timeout, proof can use at most
18 minutes 30 seconds if requested immediately, and less after review analysis.
There is no promise of a fixed duration or sequential three-check batch on every
review. The enclosing review timeout, producer job limit, credential lifetime and
Crabbox limits are unchanged.

Client timeout or cancellation returns inconclusive and aborts its HTTP wait; it
does not itself cancel a dispatched workflow or physically reap its box. Existing
producer admission checks reject expired proof authority or a lost review owner.
Producer renewal and cleanup retain their own existing boundaries; do not infer
physical resource cleanup solely from the client returning.

The trusted Worker prepares the producer identity and dispatches the matching
OpenClaw workflow on `main`. It verifies the live PR body, base/head and branch,
workflow/harness SHA, run and artifacts. Telegram execution redeems an Actions
OIDC claim bound to the authorized producer run and active review owner.
Incomplete work, expired deadlines, owner loss and unverifiable results stay
inconclusive. Terminal updates cannot acknowledge a rejected completion as a
success; dispatch and evidence delivery require matching durable acknowledgements.

A lost dispatch response is never blindly retried. Telegram producer redemption
can recover the authoritative run identity. If `main` advances between its
pre-dispatch pin and GitHub dispatch, the mismatch fails closed as inconclusive.
This known availability race does not authorize rebinding the producer or
weakening the pin.

Deploy the paired consumer Worker/runtime and reviewed producer workflows before
claiming hosted availability. The inline path does not require the legacy
`CLAWSWEEPER_PROOF_*` or `CLAWSWEEPER_TELEGRAM_PROOF_*` pin configuration,
and does not require a Convex schema deployment. The Telegram producer still
needs its existing credential service and disposable sandbox prerequisites;
the absence of a schema change does not remove those dependencies.

## Evidence and readiness

The consumer verifies exact receipt/run identity, trusted jobs, artifact
inventories, archive digests and observation hashes. Unsafe ZIP paths, duplicates,
corruption, missing files and oversized expansion are rejected. Web UI evidence
includes the observer manifest, two JSON observations and screenshot metadata.
Telegram observations bind the requested plan. Captured text is untrusted data,
never instructions to the reviewer.

Verified observations return to the original review, which decides whether they
actually support the PR's claimed behavior. Completed execution, a video or an
exit code alone is not behavioral sufficiency. The normal publication and label
owners may clear a justified proof blocker only when all remaining blockers
permit readiness. There is no proof-granted repair, close or merge authority.

## Validation and retained compatibility

`test/dashboard-review-proof-requests.test.ts` exercises durable ownership,
scope, budget and deadline boundaries. `test/dashboard-review-proof-execution.test.ts`
exercises real ZIP verification and acknowledgement fencing.
The `inline proof returns real HTTP` case in `test/codex-process.test.ts`
exercises observations delivered to the same original app-server turn.
These controlled fixtures do not establish deployed producer availability,
live Telegram coverage or semantic correctness of a model-selected plan.

The older `command-proof-cli` batch consumer and its reconciliation tests are
retained compatibility tooling for previously admitted requests. New maintainer
proof comments route through `dispatch_clawsweeper` and the inline review,
not `dispatch_proof`; legacy batch tests do not prove the new command route.
Historical `liveProofPlan` artifacts retain the publication compatibility below.

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
validation behavior. The retired planner's setup and browser-startup context is
not restored; the new inline tools have their own bounded request contract.

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
remain unchanged by the inline proof path described above.

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
