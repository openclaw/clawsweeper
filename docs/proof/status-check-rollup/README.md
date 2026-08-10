# Status-check rollup real-GitHub proof

## Claim

The finalizer now classifies only the newest run of each case-normalized
workflow/check identity. An older failed run therefore cannot leave a stale
`needs_checks` blocker after a newer run of the same check succeeds.

## Exercised surface

Run [`run-proof.sh`](run-proof.sh) from a checkout of this branch. It fetches the
real `statusCheckRollup` for
[`openclaw/clawsweeper#1099`](https://github.com/openclaw/clawsweeper/pull/1099)
through the read-only `gh pr view` surface, reconstructs the historical
finalizer classifier from pre-change commit
`e13791786799f6a51a39806938847bbc48948e5e`, compiles the current
`src/repair/status-check-rollup.ts` from the working tree, and classifies the
same payload with both implementations.

The script also builds the repair code and runs the production report-only
finalizer entry point with `--write-report` and the exact subject branch prefix.
It never enables dispatch or execution.

## Controlled scenario

The subject is PR #1099 at head
`1aa53a6a09e543e4a6e4906f7e3cc0bf34a4bd65`. Its real 26-entry GitHub payload
contains repeated `ClawSweeper Dispatch / dispatch` runs: older `CANCELLED`
runs, a newer `SUCCESS`, and later acceptable `SKIPPED` reruns. Run and job IDs
are retained for provenance; GitHub URLs are redacted from committed payloads.

The proof asserts that the historical classifier reports non-empty blockers,
including the two stale cancelled dispatch runs, while the current classifier
reports no blockers. It also asserts that the production report-only finalizer
reports no `needs_checks` blocker for PR #1099.

## Observations

[`artifacts/classification-pair.json`](artifacts/classification-pair.json)
records the decisive before/after result from the same real payload: the old
classifier reports 26 entries and two stale `CANCELLED` blockers; the new
rollup reports 14 current identities and zero blockers.

[`artifacts/check-runs.redacted.json`](artifacts/check-runs.redacted.json) is the
raw `gh` check-run listing with URLs redacted, while preserving check identity,
timestamps, conclusions, and Actions run/job IDs.
[`artifacts/report-only-finalizer.txt`](artifacts/report-only-finalizer.txt)
records the production finalizer result. Machine-readable source, subject,
timestamp, and redaction details live in
[`artifacts/provenance.json`](artifacts/provenance.json).

## Limits

This is a point-in-time classification proof against one real public GitHub PR.
It does not dispatch repair work, mutate GitHub state, exercise merge execution,
or establish behavior for payload shapes absent from the captured 26 entries.
The historical source is pinned to the recorded pre-change commit, and the
current source is whatever branch checkout runs the script.

## OpenClaw Bay

No Bay change is needed. The proof exercises a repair-only interpretation fix;
the Worker contract, report schema, queue/lifecycle contract, dashboard code,
and observer/action boundary are unchanged.

## Crabbox provenance

The same script passed unchanged at pushed head
`283be4dbd4ff0f9bb0b0d5a4d64ebbdcfc8cf983` inside a Docker-backed Crabbox
`local-container`, using Crabbox CLI `0.38.3-5-g2a79805d`, image
`node:24-bookworm`, Docker 29.4.0, and lease `cbx_7fcaae473719`
(`jade-prawn-fb36`). The run used a clean
`--fresh-pr openclaw/clawsweeper#1109 --no-hydrate` checkout, installed Corepack
plus checksum-verified static GitHub CLI 2.97.0 and jq 1.8.1 into
`$HOME/.local/bin`, completed with `PROOF_RC=0`, and stopped the lease
automatically.

See the
[machine-readable container provenance](artifacts/crabbox-local-container-provenance.json)
and [captured container stdout](artifacts/crabbox-local-container-stdout.log).
