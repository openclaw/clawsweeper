# Automerge quota publication proof

The automerge quota fixture already observed the intended one-request fail-fast behavior, but exact-event publication misclassified the clean apply yield introduced by #1166. A GitHub 403 or 429 became two `skipped_runtime_budget` apply records (the interrupted item and continuation sentinel); `publish-event-result` did not recognize that proof and converted it into `permanent_failure/unknown_failure`.

The fix preserves the structured rate-limit metadata in the apply-yield reason and reconstructs the quota error at the exact-publication boundary. Both HTTP cases must make one authenticated GET, make no DELETE request, exit the publisher honestly, and record `retryable_failure/github_rate_limit` in the workflow outputs and durable batch result.

`run-proof.sh` obtains the commit, tree, and merge-base objects programmatically, cross-checks all three with `git cat-file`, runs the real GitHub CLI over the fixture's owned Unix-socket HTTP server, validates the generated summary with static `jq`, and runs the full repository gate.

OpenClaw Bay is unaffected because this restores an internal exact-publication failure classification; no queue, workflow, status, telemetry, dashboard, or public observer contract changes.

Limits: GitHub traffic is deterministic loopback traffic using synthetic credentials. The proof does not mutate production GitHub, Worker, queue, comment, label, close, merge, deployment, or workflow state. The receipt commit adds proof metadata only after the tested runtime commit.
