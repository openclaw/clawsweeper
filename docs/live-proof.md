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

The existing maintainer comment router recognizes
`/clawsweeper proof web-ui-chat-proof <40-character-head-sha>` (or the
`@clawsweeper proof ...` form). This initial contract accepts only open,
same-repository PR heads in `openclaw/openclaw`. It exercises browser UI chat
with a mocked Gateway, not live providers, channels, authentication, or arbitrary
changed behavior. The human maintainer's current repository permission, exact
comment version, repository ID, PR number, head, and body are checked again
before dispatch and before independent reassessment.

The existing ExactReviewQueue Durable Object stores the immutable request before
any producer dispatch. Admission is transactional, with one active pilot request;
repeat delivery cannot issue another producer POST. A new human comment version
can request another attempt after the active request finishes. Unknown dispatch
outcomes are never blindly retried. The bounded reconciliation step in the
existing comment-router workflow follows only explicit stored requests and
expires incomplete work as inconclusive. It is not on ordinary review
publication's critical path and does not inspect `liveProofPlan`.

### Producer dependency and configuration

Execution is disabled until the operator supplies these repository variables:

- `CLAWSWEEPER_PROOF_WORKFLOW_PATH`: the path of the producer's
  [Mantis web-chat workflow](https://github.com/openclaw/openclaw/blob/main/.github/workflows/mantis-web-ui-chat-proof.yml)
- `CLAWSWEEPER_PROOF_WORKFLOW_REF`: a named branch/tag, not a bare SHA
- `CLAWSWEEPER_PROOF_WORKFLOW_SHA`: the reviewed, approved producer revision
- `CLAWSWEEPER_PROOF_HARNESS_SHA`: the same revision for this first contract

The named ref must resolve to the expected SHA before dispatch. The completed
run and artifact metadata must independently match that SHA. Configuration does
not create refs, provision credentials, or authorize live QA accounts. Do not
point these pins at a producer lacking the request-bound trusted-observer and
finalizer implementation. The existing OpenClaw docs-only companion does not
supply that implementation.

The consumer uses the versioned GitHub dispatch response's run ID as the durable
execution identity. Only an unknown POST response permits bounded recovery by
an explicit request-ID run name, followed by the same complete verification;
it never chooses the latest run by timestamp, actor, or head. The only producer
inputs are `candidate_ref`, `request_id`, and `pr_number`.

### Evidence, assessment, and authority

The closed `mantis.request-proof.v1` receipt is correlated, not self-authorizing.
The consumer verifies the current target, pinned workflow/harness, run attempt,
successful trusted observer and finalizer jobs, both GitHub artifact inventories,
archive digests, and the three observation-file digests. Receipt and evidence are
separate artifacts: `mantis-request-receipt-<run>-<attempt>` contains
`receipt.json`; `mantis-request-web-ui-<run>-<attempt>` carries `chat-send.json`,
`final-reply.json`, and `final-reply.png`. ZIP parsing is bounded, in memory,
and rejects traversal, links, duplicate names, corrupt entries and oversized
expansion. Receipt fields and observation metadata reject unknown keys.

Complete trusted observations can yield scenario assertion **pass** or **fail**.
Candidate-reported, missing, partial, malformed, stale, unverifiable, cancelled,
timed-out or infrastructure-failed evidence is **inconclusive**, never pass.
A video, successful process exit, digest, or receipt authority string alone is
not sufficient proof. GitHub throttles defer stored reconciliation until its
retry time; no immediate dispatch retry follows an uncertain POST.

Verified evidence enters the existing read-only review queue. The reviewer must
independently decide whether this limited scenario proves the changed behavior.
The proof-only fold changes only the behavioral-proof assessment in an existing
same-head full review; code/security/CI decisions, findings, ratings, and the last
full-review age survive. Missing or failed prior/current review data blocks this
fold. Additional non-proof findings require a full review rather than being
silently discarded. This mocked-Gateway scenario cannot replace required
authority-chain proof. Exact head/body checks also run at review time, and existing publication
freshness checks still apply. Publication is report/comment-only: no label
setter, repair/close/merge action, or verdict-router handoff is authorized by
this path. A sufficient assessment may remove the report's proof blocker, not
any other blocker or the human merge-approval boundary.

The existing command-status owner reports assertion/inconclusive outcomes and
independent-review handoff separately; queued or pass is not a readiness claim.
The new HTTP adapter records explicitly incomplete GitHub invocation telemetry,
not fabricated complete wire-attempt metrics. Public observer payloads gain no
request IDs, evidence, queue controls, or new actions. Bay uses its existing
review/no-router lifecycle representation; no Bay browser GitHub calls or
mutation controls are added.

### Validation scope

`scripts/e2e/command-proof-consumer-loopback.mjs` exercises the compiled CLI,
real Worker HTTP handlers, file-backed SQLite claims across DO recreation,
artifact verification, the existing review queue/status owner, and proof-only
folding. GitHub metadata/artifact delivery and the independent model's response
are controlled external fixtures. It does not claim a live GitHub workflow run,
Mantis UI execution, or semantic model accuracy. The producer dependency owns
its separate trusted-observer runtime proof. The earlier admission-only harness
`scripts/e2e/proof-command-loopback.mjs` remains narrower evidence.

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
