# Webhook read-model behavior proof

This historical proof exercises the signed webhook ingress and queue Durable Object read model with realistic item, ordinary-comment, review, inline-review-comment, workflow-run, workflow-job, and check deliveries. The fixtures include a duplicate delivery GUID, a late item update, a deleted comment followed by a late edit, a collection-count gap, and a complete repair census.

The focused tests also compare the snapshot-first planning, placeholder, and repair-loop router decisions against their live-poll results while counting GitHub reads. Apply `LiveReadGeneration` and explicit bypass reads remain live even when an identical snapshot is warm. Dashboard run scans use the unchanged raw workflow-run/job shapes; the request formula records the seven former run scans plus one job page for the one-active-run fixture. Cold or partially observed workflow rows remain unusable until a bounded run census and per-run job coverage are persisted. Exact-review planning proves its scoped lease-capability read without receiving the shared webhook secret.

Run locally after building:

```bash
node docs/proof/webhook-read-model/run-proof.mjs \
  --output .artifacts/webhook-read-model/behavior-report.json
```

The Docker-backed Crabbox command and exact provider, image, lease, head, and gate result are recorded in `receipt.json` after the final proof run. `run-proof.sh` validates the head and merge base with both `git rev-parse` and `git cat-file`, runs focused tests, checks the report with static `jq`, enrolls dashboard strict, and runs the full repository gate.

Limits: all GitHub and Worker traffic is deterministic loopback fixture traffic. No production GitHub, App settings, Worker deployment, queue, comment, label, close, merge, or workflow state is mutated. OpenClaw Bay is unaffected because the public observer payload and no-action boundary do not change.
