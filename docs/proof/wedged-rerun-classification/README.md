# Wedged rerun classification proof

- Status: current proof
- Owner: ClawSweeper maintainers
- Source of truth: `dashboard/operational-health.ts` and `scripts/stuck-queued-run-remediation.mjs`
- Base revision: `openclaw/clawsweeper@43799a11fc2612df7d80918e0012d6f03b339747`
- Tested source head: `0b677cbcca1651b7ea73f83f4f12a0fbf56589c9`
- Update when: the operational queue taxonomy, workflow-run read model, public status projection, or stuck-run cancellation response handling changes

The production evidence is run 31910632853 ("repair publish cluster results", created 2026-08-15T21:52Z): status=pending, run_attempt=2, stuck >4.5h in PRE-QUEUE state. GitHub refuses every remediation: cancel and force-cancel both 409 "Cannot cancel a workflow re-run that has not yet queued"; rerun conflicts with "This workflow is already running". The old `operational_health` counted it in `queued_over_threshold`, degrading live health despite there being no available remediation.

The Actions list API passes complete run objects directly to the health summarizer. The webhook read model also stores and returns the bounded full workflow-run snapshot, and its stale-run revalidation replaces that snapshot with the complete exact-run API response. `run_attempt` was therefore already preserved end to end; the change records that contract in the local run types rather than adding a storage migration.

The threshold is 60 minutes and is strict: normal pre-queue pending reruns last seconds, while an hour leaves ample margin for transient GitHub scheduling delay. A run at exactly 60 minutes remains ordinary queue pressure. Only `pending` runs with `run_attempt > 1` and age greater than 60 minutes are separated; fresh reruns and genuine queued runs keep the existing health behavior. The remediation CLI retains its stricter existing 90-minute stuck-run threshold, reads both queued and pending inventories, and turns an exact aged pending attempt-2 recheck into the same structured skip before sending any cancellation POST.

[`red-green-transcript.txt`](red-green-transcript.txt) records the local fixture result and accepted-finding repair. [`container-transcript.txt`](container-transcript.txt) is the exact-source Docker-backed Crabbox run: the merge-base implementation fails all three new behavior fixtures, while the source head passes six focused API/render/CLI/public-containment scenarios, `check:dashboard-strict`, and the complete `pnpm run check` gate (3,535 tests, 3,527 passed, zero failed, eight skipped). The CLI proof discovers an aged pending rerun, rechecks it as pending, emits `skip_reasons.wedged_rerun`, and sends no POST. [`container-provenance.json`](container-provenance.json) freezes the provider, lease, run, image, hashes, timing, and bounded discarded attempts. [`container-secret-scan.json`](container-secret-scan.json) records a clean proof-directory scan.

The public `/api/status` projection retains only `wedged_rerun_runs` and `oldest_wedged_rerun_minutes`; a containment fixture proves run IDs and diagnostic URLs do not survive projection. The dashboard mentions wedged reruns only inside details when another real execution problem opens the alert. A wedged rerun by itself remains healthy and does not open a live-health alert.

OpenClaw Bay is unaffected. Bay does not consume `operational_health`; no Bay lifecycle, queue, observer action, or projection contract changed. The live dashboard remains observer-only.

Limits: GitHub API behavior is exercised through loopback fixtures rather than mutating production run 31910632853. The receipt-containing evidence commit changes proof files only after tested source head `0b677cbcca1651b7ea73f83f4f12a0fbf56589c9`; no runtime source follows the receipt. The repaired source and evidence commits are pushed together.
