# Remediation throttle skip proof

- Status: historical proof
- Owner: ClawSweeper maintainers
- Source of truth: `scripts/stuck-queued-run-remediation.mjs`, `scripts/operator-skip-reasons.mjs`, and `.github/workflows/exact-review-dead-letter-reconcile.yml`
- Base revision: `openclaw/clawsweeper@e0dc54438e6562f144623fcde2263b3b839fe28d`
- Update when: the remediation throttle contract, dead-letter workflow ordering, or focused loopback fixtures change

The proof claim is that GitHub rate-limit and abuse throttles are an operator-visible graceful skip for opportunistic queued-run remediation, including after earlier cancellations, while persistent 5xx and authorization failures remain hard failures. The exercised surface is the production CLI routed through its real `GITHUB_API_URL` seam to loopback HTTP listeners, plus the parsed production workflow.

[`red-green-transcript.txt`](red-green-transcript.txt) records the red test-only run against the base production script and the green focused run. The fixtures cover a 403 installation rate-limit body, a 429 secondary-rate-limit response after one successful cancellation, a non-throttle 403, persistent 503 responses with three attempts, an invalid inventory shape, and the workflow sequencing/upload contract. No live credentials or external mutations are used.

The source-blind behavior contract is in [`behavior-contract.md`](behavior-contract.md). All five clauses passed through the operator CLI/workflow artifact surfaces. Anti-cheat probes varied both status and body, distinguished authorization from throttling, retained a completed mutation before the mid-run skip, and verified the persistent failure path.

OpenClaw Bay is unaffected: this changes only an internal housekeeping CLI and workflow sequencing, with no dashboard data contract or observer surface change. No dashboard files were touched, so the requested scripts/workflow proof replaces a Crabbox real-Worker receipt.

Limits: the transport is loopback HTTP rather than live GitHub, and workflow behavior is validated structurally rather than by dispatching the production schedule. Full repository gates provide the broader integration check.
