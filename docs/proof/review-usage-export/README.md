# Bounded review usage export proof

Status: controlled runtime proof driver. Owner: ClawSweeper review maintainers.
Update this driver when native blob reads, export budgets, canonical import
closure, destination handling, or the offline report changes.

Build the selected source with `pnpm run build:node`, then run:

```sh
node docs/proof/review-usage-export/run-proof.mjs \
  .artifacts/review-usage-export/proof.json
```

The driver launches the compiled export CLI against an isolated HTTP R2 fixture.
A Node transport preload redirects the fixed service origin to that fixture;
product argument, signing, response streaming, closure, filesystem and report
logic runs unchanged. The fixture uses native writer output and native import
bindings. No production credential or service is used.

Cases cover a complete private export, selection alongside native projection
failures, a missing completion marker, a corrupted
payload, a refused redirect, preservation of an existing destination, and the
real 120-second deadline aborting a stalled response body. Unit tests separately
cover markerless legacy shards, event/reservation bindings, producer mismatch,
request/byte budgets and cursor cycles. Passing this driver establishes these
controlled runtime paths only; record its actual source and execution outcome
in the PR body. It supplies no live credential binding, production receipt,
loaded configuration, billing or quota evidence.
