# Parked command finalization behavior proof

## Contract

Claim: exhausted command producers are not deleted or restarted on a GitHub close. A bounded, exact-revision plan schedules only the existing acknowledgement finalizer. Producer cleanup follows an observed receipt or explicit locked/missing skip. Reopen/takeover/unknown states cannot authorize cleanup. Bay distinguishes retained exhausted records, scheduled retries, and live workers without changing its public allowlist or introducing actions.

Surface: production dashboard Worker, ExactReviewQueue, real local workerd/SQLite persistence and signed HTTP routes; production Bay HTML in real Chromium. The fixture-only Worker wrapper seeds exhaustion and invokes the production alarm; it does not replace the runtime logic. External GitHub responses are loopback synthetic fixtures.

Command: `node docs/proof/parked-command-finalization/run-proof.mjs` in Docker-backed Crabbox `--provider local-container --local-container-image node:24-bookworm`. Requires frozen-lockfile dependencies, Wrangler, Chromium, and Node >=24.

Scenarios: marker-only/comment-ID-only commands; closed/merged/open/ambiguous; repeat and Worker restart; reopen and source takeover; failed receipt then retry; observed receipt and explicit locked/missing receipt skip. Mixed Bay queue state and no browser GitHub traffic. Unit/workflow regressions additionally cover the 11+1 skip census and pre-disposition retry wording.

Artifacts: `.artifacts/parked-command-finalization/result.json`, bounded HTTP trace, browser screenshot, and current-head/runtime identity. Record Crabbox lease/provider/image/run identity in the PR body after execution.

Limits: no live queue, real contributor, production dispatch, deployed Worker, or complete hosted Actions job. Fixture control routes exist only in this local proof configuration. No audit inventory/private repository identifiers are used or published. Tests alone do not replace this proof.

Build `pnpm run build:all` before the proof: it executes the compiled production
command-status CLI as a subprocess. The proof-only `gh-fixture.mjs` adapter
transports that CLI's GitHub requests to the loopback fixture. One case advances
the producer during comment lookup and proves zero PATCHes; another proves the
just-in-time fence, actual PATCH, release, and correlated receipt. The existing
Worker routes and SQLite owner are used, not an extracted-function replacement.

A parked finalizer reserves a bounded status-write window. After comment reads,
the CLI revalidates the original producer, target, lease and acknowledgement
attempt. Successor dispatch waits while that write window is owned. Known stale
conflicts skip without a status mutation; unclassified failures remain failures.
PATCH has a shorter transport deadline than the reservation, and a successful
write releases ownership. Missing receipt and locked-conversation outcomes retain
the existing explicit terminal-skip path.

The finalizer workflow runs terminal eligibility admission before requesting its
target write token. The runtime proof executes that exact Bash/curl step against
the real local Worker with no runner GitHub credential, proves revocation returns
allowed=false, and then proves restored eligibility authorizes the later step.
The token action is gated on allowed=true; status PATCH additionally requires
successful token creation. This is controlled workflow-boundary proof, not a
hosted GitHub Actions execution.
