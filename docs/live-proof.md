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

The existing maintainer comment router recognizes explicit
`/clawsweeper proof <scenario-id> <40-character-head-sha>` commands
(or the `@clawsweeper proof ...` form). The closed scenario registry accepts:

| Scenario                 | Pinned producer workflow            | Scope and limits                                                                                                                                   |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-ui-chat-proof`      | `mantis-web-ui-chat-proof.yml`      | Existing browser UI chat with a mocked Gateway; not live providers, channels or authentication.                                                    |
| `telegram-bot-e2e-proof` | `mantis-telegram-bot-e2e-proof.yml` | TelegramTestServer/TDLib bot DM with an external mock provider; not live Telegram, real providers, groups/topics or blanket authority-chain proof. |

Both accept only open, same-repository PR heads in `openclaw/openclaw`.
Neither permits freeform execution or arbitrary messaging targets. The human
maintainer's repository permission, immutable source-comment version, repository
ID, PR number, head, body, base ref and base SHA are rechecked before dispatch
and independent reassessment. One unchanged human command version cannot start
another transport/configuration after target or producer drift.

Both profiles have closed consumer validation. Telegram acceptance additionally
requires the hash-only public observation contract below; a registry entry or
renamed browser fixture is not Telegram proof. The actual producer adapter must
separately prove how it maps trusted captures into these observations before
any operator enables its pins.

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

The four existing WebUI variables retain their names. Telegram has an independent,
all-or-nothing pin set with no fallback to WebUI configuration:

- `CLAWSWEEPER_TELEGRAM_PROOF_WORKFLOW_PATH`: the producer
  [Mantis Telegram bot workflow](https://github.com/openclaw/openclaw/blob/main/.github/workflows/mantis-telegram-bot-e2e-proof.yml), required separately
- `CLAWSWEEPER_TELEGRAM_PROOF_WORKFLOW_REF`: a named reviewed branch/tag
- `CLAWSWEEPER_TELEGRAM_PROOF_WORKFLOW_SHA`: approved producer revision
- `CLAWSWEEPER_TELEGRAM_PROOF_HARNESS_SHA`: the same revision for this contract

Both transports are disabled when their own complete valid pins are absent.
Configuring either profile does not authorize real messaging accounts, public
Telegram delivery, activation of the other profile, merge, or automatic proof.

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
archive digests, and the three profile-specific observation-file digests. Receipt and evidence are
separate artifacts: `mantis-request-receipt-<run>-<attempt>` contains
`receipt.json`; `mantis-request-web-ui-<run>-<attempt>` carries `chat-send.json`,
`final-reply.json`, and `final-reply.png`. ZIP parsing is bounded, in memory,
and rejects traversal, links, duplicate names, corrupt entries and oversized
expansion. Receipt fields and observation metadata reject unknown keys.

Telegram uses the same request-bound receipt envelope and receipt artifact, but
only its Telegram workflow and the trusted job `Run request-bound Telegram bot proof`
plus `Finalize request-bound evidence`. Its evidence artifact is
`mantis-request-telegram-<run>-<attempt>` and its required observations are
`telegram-send/telegram-send.json`, `provider-request/provider-request.json`, and
`telegram-reply/telegram-reply.json`. These must describe actual TDLib/TestServer
and external mock-provider observations, not renamed browser files. Wrong
scenario/workflow/job/artifact/file/schema combinations remain inconclusive.

Each Telegram observation is a closed UTF-8 JSON object of at most 8 KiB with
schema `mantis.telegram-observation.v1`. Common fields bind `request_id`,
`scenario`, `candidate_sha`, `harness_sha`, `run_id` and `run_attempt`.
All three must agree on their public 64-hex `nonce` and salted run-local
`conversation_digest`, and declare `transport: "TelegramTestServer"`,
`test_dc: true`, `chat_type: "dm"` and `capture: "complete"`.

| Kind / file                                  | Transport-specific facts                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telegram-send` / `telegram-send.json`       | Canonical positive-decimal `message_id`; `text_sha256` must hash exactly `Mantis Telegram request <nonce>`.                                          |
| `provider-request` / `provider-request.json` | `request_sha256`, matching `input_nonce`, `response_nonce` and `response_sha256`; response hash must match `MANTIS_TELEGRAM_REPLY_<response_nonce>`. |
| `telegram-reply` / `telegram-reply.json`     | A distinct positive-decimal `message_id`, `in_reply_to` equal to the sent ID or null, actual `text_sha256`, and `from_sut: true`.                    |

Only after all identities and provenance/coherence fields validate is the reply
hash compared with the mock-provider response hash: equality yields assertion
pass and inequality yields assertion fail. A wrong send/provider hash, wrong
nonce/peer binding, duplicate message ID, non-SUT reply, missing/partial capture,
unknown key, invalid UTF-8 or oversized file is inconclusive. The enclosing
receipt outcome must agree with the independently derived outcome. Reviewer
summaries are derived from validated facts, not freeform receipt claims.

The public exporter emits only these three records; raw skill events, TDLib
recordings, gateway/provider logs, account/chat/user IDs and credentials are not
public artifacts. There are no fabricated timestamps or wall-clock claims.
The pinned producer must select actual post-send, matching-peer TDLib events
before declaring capture complete; the consumer cannot reconstruct that private
recording from hashes. This is a trusted-producer boundary, not an internal app
attestation or proof of live/public Telegram delivery.

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
silently discarded. Neither limited scenario can replace required authority-chain proof. Exact head/body checks also run at review time, and existing publication
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
its separate trusted-observer runtime proof. Run the consumer loopback without
arguments for the unchanged 15 WebUI cases, or with
`--scenario telegram-bot-e2e-proof` for the same 15 cases plus eight Telegram
cross-transport/schema/coherence cases. Telegram fixtures are generated by the
same public hash-only exporter/validator contract, not by relabeling browser
observations. The deliberately renamed-browser negative case must fail closed.

| Boundary      | Consumer coverage                                                                                        | Still requires separate proof                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| WebUI         | Compiled consumer CLI, signed Worker/SQLite/ZIP/reassessment fixture paths                               | Actual pinned browser producer execution                                             |
| Telegram      | Hash-only schema/semantic source tests and compiled consumer CLI/Worker/SQLite/ZIP/reassessment fixtures | Actual TelegramTestServer/TDLib adapter capture and external provider mapping        |
| Publication   | Existing proof-only label/promotion/freshness guards and focused apply fixtures                          | End-to-end canonical deployment/publication validation                               |
| Live Telegram | Not enabled or claimed                                                                                   | Exact runtime readiness, explicitly authorized target and lease/credential preflight |

The earlier admission-only harness
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
