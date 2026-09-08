# Review Publisher Ledger Isolation

Status: historical controlled proof. Owner: ClawSweeper maintainers.

## Claim

Optional aggregate ledger import/upload must not precede primary publication,
hold its target concurrency lock, or block recovery. The separate artifact and
selected-comment receipt phases remain required producer paths.

## Reproduce

Build the checkout with its pinned dependencies, then run:

```sh
pnpm run build:all
node docs/proof/review-publisher-ledger-isolation/run-proof.mjs --baseline --output .artifacts/ledger-baseline.json
node docs/proof/review-publisher-ledger-isolation/run-proof.mjs --output .artifacts/ledger-candidate.json
node --test test/sweep-workflow.test.ts test/clawsweeper-action-ledger.test.ts
```

The baseline uses the workflow at
`c6ead2181a5c958c37fb717c7186d48613caeeb0`. This repair does not change its
production TypeScript CLIs. Each receipt records the executing checkout SHA,
workflow digest, fixture digest, monotonic completion events, and wire counts.

## Exercised Boundary

The harness copies the built production runtime into isolated temporary roots.
It executes the workflow's actual import/upload and required receipt shell
blocks, plus the production `apply-artifacts`, `publish-main`, and comment-only
`apply-decisions` CLIs. The existing GitHub command adapter forwards synthetic
requests to a loopback HTTP server; blob and canonical record writes use their
real signed HTTP clients. The server verifies signatures, content digests, and
immutable replay. Outbound fetches and sockets are restricted to that server.
All credentials are synthetic. Child process groups and temporary roots are
removed before exit.

The original ordered commands block before artifact application while optional
blob I/O is withheld. After release, artifact, record, comment, and their
required receipt boundaries complete. With the new dependency graph, those
same boundaries complete before optional blob I/O is released.

Additional cases cover ordinary success, optional HTTP failure, empty artifacts,
primary failure, cancellation, exact manifest replay, a wrong producer job,
and conflicting canonical bytes. Publisher artifact retention fails open with
an explicit warning and summary; the proof executes that reporting command.
The canonical importer tests additionally
cover incomplete numbered sets, bounded prior attempts, provenance, and causal
bindings.

## Limits

This proves controlled executable command boundaries and the parsed workflow
dependency graph, not hosted runner scheduling, Actions artifact service
availability, production GitHub mutations, or deployment health. Transport
responses and issue data are synthetic. The read-model fixture is deliberately
unavailable, so its existing fallback reads the synthetic GitHub transport.
Absolute timings are ordering evidence, not a throughput benchmark.

Bay's existing public projection is exercised for every named optional job
step. None is classified as model review or review publication. No Bay runtime,
controls, model capacity, scheduler cadence, credential, or schema changes are
part of this repair.
