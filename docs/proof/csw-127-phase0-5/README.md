# CSW-127 Phase 0.5 executed proof

The controlled runtime proof succeeded on Docker-backed Crabbox
`local-container` lease `cbx_6580d0b07770` (`quick-lobster`) using
`mcr.microsoft.com/playwright:v1.60.0-noble`. The lease stopped automatically
after the run.

## Observed result

- All 323 focused queue, command-intake, publication, health, Bay, and egress
  telemetry tests passed.
- A real local Worker and Durable Object accepted signed v2 egress telemetry,
  deduplicated its receipt, and created exactly one attributable
  `repository_actions` circuit from a complete `public_read_fallback`
  observation.
- The pending publication could not be claimed before the raw reset or at the
  raw reset boundary. It became claimable only after its deterministic bounded
  recovery jitter.
- A `target_app` observation without an owner and an Actions observation with
  remaining quota did not create circuits.
- Reusing a receipt ID with conflicting attributable reset evidence was
  deduplicated and could not introduce or extend a circuit.
- The public queue response contained no `pool_identity`; the bounded recovery
  reason counters were present.
- Builds and scoped dashboard/script lint completed cleanly in the container.
- No GitHub workflow, queue, DLQ, gate, credential, deployment, or production
  state was touched.

The structured receipt is in `container-receipt.json`. The exact executable
fixtures are `run-proof.sh` and `run-proof.mjs`.

## Transport and formatting limits

Normal Crabbox rsync failed before execution on two local-container leases with
rsync protocol error 12. The successful run used Crabbox's supported read-only
host bind mount, copied the exact worktree (excluding `.git`, `node_modules`,
and `.crabbox`) into an isolated container directory, and ran there.

The first complete behavior run passed its build, 321 tests, and Worker/DO
scenario, then the repository-wide format check rejected the Windows checkout's
CRLF representation across 682 untouched files in Linux. The final green
container run therefore used scoped lint. On the Windows checkout, build, full
lint, and every non-format static gate passed; repository-wide formatting had
the same unrelated CRLF failure. This does not limit the runtime behavior
claim.

The broad Windows coverage command was also attempted. Its unrelated
shell-oriented fixtures failed because WSL has no `/bin/bash`, while other
fixtures hit Windows temporary-directory `EPERM` cleanup failures. The seven
directly affected test files remained green on both Windows and Linux.

## Limits

- The loopback proof validates ClawSweeper's response handling and durable
  transitions; it does not prove GitHub's external scheduler or quota refill.
- It does not assign a provider-side cause to the earlier cancelled workflow
  runs because no runner step or trustworthy provider diagnostic existed.
- Phase 1 remains inactive and is not exercised by this proof.
