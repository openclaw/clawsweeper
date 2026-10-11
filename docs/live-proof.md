# Live proof

- Status: inline review proof active; old post-review proof execution and publication retired
- Owner: ClawSweeper review and publication maintainers
- Source of truth: `src/review-proof-client.ts`, `src/codex-app-server-worker.ts`,
  `dashboard/review-proof-execution.ts`, `dashboard/exact-review-queue.ts`,
  `src/proof-artifact-contract.ts`, and `src/repair/comment-router.ts`
- Last verified: expiry acknowledgement repair `5d5fd577d2`
- Update when: supported tools, admission, producer bindings, deadlines, evidence,
  command routing, or evidence contracts change

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

## Validation

`test/dashboard-review-proof-requests.test.ts` exercises durable ownership,
scope, budget and deadline boundaries. `test/dashboard-review-proof-execution.test.ts`
exercises real ZIP verification and acknowledgement fencing.
The `inline proof returns real HTTP` case in `test/codex-process.test.ts`
exercises observations delivered to the same original app-server turn.
These controlled fixtures do not establish deployed producer availability,
live Telegram coverage or semantic correctness of a model-selected plan.

## Retired post-review proof

The old post-review `liveProofPlan` executor, compatibility CLI commands,
artifact folding, media uploads and manual recording retraction are retired.
New decisions and reports do not contain `liveProofPlan`, a `## Live Proof`
section or `live_proof_*` front matter.

Existing stored reports are not rewritten. Historic plans, attached verification
receipts and recording markers are ignored by readiness, automation and comment
presentation. They neither grant proof credit nor add merge blockers. Existing
publication bundles may still carry opaque historical files, but publication
does not fold or upload those attachments.

Current inline proof continues to return verified observations to the original
review turn. Its behavioral assessment, normal publication and security
boundaries are unchanged by retiring the separate post-review stack.
