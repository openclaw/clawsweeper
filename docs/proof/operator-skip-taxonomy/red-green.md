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
