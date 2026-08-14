# Runner-label escape-hatch RED/GREEN transcript

## RED

The ratchet test was added before any workflow changed and run against fresh `origin/main` at
`dc738b3845655ad36f91ea9584d90abdd4df3ca3`:

```text
$ node --test test/workflow-runner-labels.test.ts
✖ Blacksmith runner assignments keep a repository-variable escape hatch
AssertionError [ERR_ASSERTION]: .github/workflows/automerge-e2e.yml:automerge-e2e must keep its Blacksmith label behind a vars fallback
actual: 'blacksmith-16vcpu-ubuntu-2404'
expected pattern: vars.CLAWSWEEPER_*_RUNNER || 'blacksmith-*'
tests 1
pass 0
fail 1
```

The first failing site is sufficient to establish the old tree violated the new invariant; the
inventory in `README.md` records all six bare assignments found by the repository-wide sweep.

## GREEN

The same ratchet plus the existing automerge and containment workflow-shape tests passed after the
mechanical replacements:

```text
$ node --test test/workflow-runner-labels.test.ts test/repair/automerge-e2e-workflow.test.ts test/repair/repair-containment-smoke-workflow.test.ts
✔ automerge E2E uses the production containment runner and container entrypoint
✔ automerge E2E builds its cached base from repository-controlled source
✔ automerge E2E is read-only and excludes untrusted fork pull requests
✔ automerge E2E uploads the container proof even when a scenario fails
✔ containment smoke uses two production-class runner samples
✔ containment smoke is read-only and excludes untrusted fork pull requests
✔ containment changes trigger the smoke workflow
✔ Blacksmith lanes keep their expected variable names and default labels
✔ Blacksmith runner assignments keep a repository-variable escape hatch
tests 9
pass 9
fail 0
```

Docker-backed Crabbox `provider=local-container` repeated the GREEN contract at committed head
`f84b7d60daa24d979eef6299be0d9c2a55fdab62` on lease `cbx_d1a06e39d867`, then completed the full
repository gate with 3,420 passed, zero failed, and eight skipped tests.
