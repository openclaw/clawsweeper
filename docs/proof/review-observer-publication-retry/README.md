# Terminal review telemetry transport proof

- Status: historical proof for this change
- Owner: ClawSweeper maintainers
- Surface: the actual `scripts/review-run-observer.mjs` CLI and the canonical `ExactReviewQueue` telemetry route

## Claim and boundary

A transient publication failure can recover without changing the signed terminal
record or creating another `(run_id, run_attempt)` row. Permanent failures and
retry exhaustion still fail. The observer keeps its 20-second request deadline.
This repairs telemetry delivery; it does not repair the upstream queue service
or alter review, publication, dispatch, or merge authority.

The controlled runtime command is:

```sh
node scripts/e2e/review-observer-publication.mjs --output /absolute/new-proof.json
```

Run with Node 24 or newer from this checkout. It starts local HTTP servers,
spawns the real CLI with isolated HOME/TMPDIR and synthetic credentials, and
executes the maintained Durable Object owner against the existing test adapter
backed by real `node:sqlite`. The JSON receipt records source/runtime hashes,
request attempts, body/signature equality, canonical stored rows, and cleanup.

Scenarios cover an ordinary success, transient HTTP 500, a committed first
request whose reply is lost, the real 20-second timeout, terminal HTTP 400, and
three exhausted transient attempts. Lost-reply recovery must leave exactly one
canonical row containing the unchanged terminal payload. Every child, server,
socket, and request handler is settled before the receipt is written.

The narrow test command uses Node's existing fake-clock and fetch boundaries
around the actual CLI, so deadline cases do not wait 20 seconds per unit test:

```sh
node --test test/review-run-observer-transport.test.ts test/review-run-telemetry.test.ts
```

## Baseline and limits

The unchanged observer at `ffdff711463380f2636e8e9f7fb152770f26b9c3` exits 1
after one synthetic HTTP 500 or one natural 20-second timeout, even when the
next request would succeed. Its successful control exits 0 after one POST.
The HTTP 500 regression also fails against that unchanged script and passes
with this change.

GitHub job responses and transport failures are synthetic; the CLI, sockets,
request deadline, canonical telemetry transaction, and SQLite duplicate key are
real. This does not exercise deployed Cloudflare ingress, live credentials,
alarm delivery, or production dispatch. OpenClaw Bay's existing observer data
becomes more complete; its schema and UI need no change, and no new action
surface is introduced.
