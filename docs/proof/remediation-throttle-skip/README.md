# Remediation throttle skip proof

- Status: historical proof
- Owner: ClawSweeper maintainers
- Source of truth: `scripts/stuck-queued-run-remediation.mjs`, `scripts/operator-skip-reasons.mjs`, and `.github/workflows/exact-review-dead-letter-reconcile.yml`
- Base revision: `openclaw/clawsweeper@e0dc54438e5e346f573af5e6d2cb07c6c1620a8f`
- Update when: the remediation throttle contract, dead-letter workflow ordering, or focused loopback fixtures change

The proof claim is that GitHub rate-limit and abuse throttles are an operator-visible graceful skip for opportunistic queued-run remediation, including after earlier cancellations, while persistent 5xx and authorization failures remain hard failures. The exercised surface is the production CLI routed through its real `GITHUB_API_URL` seam to loopback HTTP listeners, plus the parsed production workflow.

[`red-green-transcript.txt`](red-green-transcript.txt) records the original macOS red test-only run against the base production script and the green focused run. [`container-transcript.txt`](container-transcript.txt) records the required repeat of that same suite inside Docker-backed Crabbox. The fixtures cover a 403 installation rate-limit body, a 429 secondary-rate-limit response after one successful cancellation, a non-throttle 403, persistent 503 responses with three attempts, an invalid inventory shape, and the workflow sequencing/upload contract. No live credentials or external mutations are used.

The source-blind behavior contract is in [`behavior-contract.md`](behavior-contract.md). All five clauses passed through the operator CLI/workflow artifact surfaces. Anti-cheat probes varied both status and body, distinguished authorization from throttling, retained a completed mutation before the mid-run skip, and verified the persistent failure path.

The container repeat used Crabbox `provider=local-container`, image `node:24-bookworm`, and `--fresh-pr openclaw/clawsweeper#1144` on lease `cbx_efa770db5e6d` (`quick-crab-b89a`). RED reproduced the merge-base child exit 1. GREEN passed all six focused scenarios, including the throttled child exit 0 and structured `skip_reasons.github_throttled` event, persistent 5xx child exit 1, and workflow-shape assertions. [`container-provenance.json`](container-provenance.json) freezes the run metadata; [`container-secret-scan.json`](container-secret-scan.json) records the transcript scan. [`run-container-proof.sh`](run-container-proof.sh) is the executed launcher.

OpenClaw Bay is unaffected: this changes only an internal housekeeping CLI and workflow sequencing, with no dashboard data contract or observer surface change. No dashboard files were touched, so no Bay update or real-Worker receipt is needed.

Limits: the transport is loopback HTTP rather than live GitHub, and workflow behavior is validated structurally rather than by dispatching the production schedule. The evidence commit adds only this proof material after tested source head `98fae30ad6336f525b654e90f961e6909b5f61e7`; no runtime or workflow change follows the receipt.
