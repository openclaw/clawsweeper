# Red/green record

The red phase added loopback assertions before production code changed. On fresh `origin/main` at `c8a9737486d5c09511e26aa09db6e73459801cde`, the complete operator test file reported 77 passed and five failed. The failures showed the production symptom directly: incomplete inventory, stale pull-request head, changed closed state, blocked alias, and mixed-scenario summaries all returned empty `skip_reasons`.

```text
tests 82
pass 77
fail 5
```

The green implementation accounts deterministic decisions at the same branches that already increment `skipped_targets`, preserves error-derived classifications through later discovery aborts, adds bounded sanitized samples, and checks every emitted reconcile summary for internal count consistency without throwing.

The complete focused operator file then passed locally on Node 24:

```text
tests 82
pass 82
fail 0
```

The pre-commit Codex autoreview reported no accepted/actionable findings. The final Docker-backed Crabbox receipt and full-gate result are recorded alongside this file.

The first ClawSweeper PR verdict found one mixed-path defect: a failed inspection was already classified, but the later non-actionable-identity skip-all path counted every original group again. The fix restricts that bulk accounting to targets present in the successful identity map. Its regression combines one missing App installation with one successfully inspected non-actionable identity and requires two skipped targets with exactly `installation_missing: 1` and `identity_not_actionable: 1`.
