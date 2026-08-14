# Phantom queued-run health proof

Production `/api/status` probes on 2026-08-14 reported one queued run aging
monotonically from 54 to 61 minutes even though live Actions inventories across
the nine involved repositories contained no queued, waiting, or pending run
older than 30 minutes. The symptom began after
[openclaw/clawsweeper#1167](https://github.com/openclaw/clawsweeper/pull/1167)
moved dashboard workflow health onto the webhook read model.

The complete-census gate itself was present: a workflow snapshot is usable only
after a successful run census and an observed `workflow_run` delivery. The gap
was below that repository-wide envelope. A queued row preserved because it
arrived after a census began had no per-row confirmation age in the consumer
response. A later fresh census timestamp therefore made the whole snapshot
usable while `statusSnapshot()` counted that unconfirmed queued row directly.
Repair upserts also ignored an equal `updated_at`, so a live poll that confirmed
an unchanged genuinely queued run could not refresh its row age.

Workflow reads now expose each run's last delivery-or-poll confirmation. Before
an expired row can contribute to `queued_over_threshold`, the Worker performs
one exact GitHub run read with five-way bounded concurrency. Live active state
refreshes the row. Completed or missing state removes the run and its dependent
job snapshot behind a verification-start boundary, then emits
`github_read_model_workflow_run_evicted`. A failed exact read removes the
unconfirmed row from the calculation and makes telemetry `unknown`. Repair-only
snapshots without observed subscription coverage still use the pre-#1167 live
status polls. Rows older than the existing 24-hour zombie boundary stay in the
separate zombie metrics and do not spend exact verification requests.

The executable contract is in [behavior-contract.md](behavior-contract.md), the
captured RED/GREEN result is in [red-green.md](red-green.md), and
[run-proof.sh](run-proof.sh) runs the focused loopback fixture, dashboard-strict,
the complete repository gate, static JSON validation, and committed-object
cross-checks in Docker-backed Crabbox. [behavior-report.json](behavior-report.json)
records the source-blind result. The final container receipt and compact
transcripts are recorded beside these files after the isolated run.

[worker-loopback-report.json](worker-loopback-report.json) is the real-boundary
trace requested in the first ClawSweeper review. It starts `wrangler dev
--local`, uses the real SQLite Durable Object plus signed webhook/repair HTTP
routes, waits through the five-minute production TTL, and serves exact completed
and 404 responses from a separate loopback GitHub HTTP server. The resulting
`/api/status` response was healthy, both rows were absent afterward, and the
Worker emitted both eviction telemetry verdicts. The refreshed round-2 trace
also seeds a 25-hour zombie, proves that no exact request is spent on it, and
leaves only that separately observable zombie row in the read model.

OpenClaw Bay is unaffected. The change repairs the dashboard's internal
observer read path and adds no public field or queue, workflow, GitHub, DLQ,
recovery, deploy, or rollback action.
