# Maintained proof-tooling qualification — November 6, 2026

- Status: historical qualification record; no deployment performed.
- Owner: ClawSweeper maintainers.
- Source: base `51e006973ca9bb79dea2b0d874fa57db6bcdc4fa` plus the exact tested candidate file hashes in [results](results.json).
- Update trigger: changed tool selection, active proof drivers, Worker entry or TLS claims requires new applicable evidence.

The four explicitly active controlled Worker proof drivers now use the frozen
repository Wrangler dependency instead of acquiring Wrangler 4.131.1 independently.
Dashboard development and deployment commands select that same installed dependency.
The manual-publication driver's supplied-binary admission reads this version owner.
No application security policy or production state changed.

## Executed behavior

The actual PR read-model driver passed before editing with its old acquisition
path. That fixture denies outbound Worker requests, so its success does not
establish the old engine's TLS behavior. The earlier dependency-adoption
[paired dashboard evidence](../released-workerd-20261106/README.md) owns that
separate old-versus-patched TLS comparison.

On the candidate, frozen installation and all four active entry points passed:

| Entry point | Observed result |
| --- | --- |
| `node docs/proof/pr-read-model-kind/run-proof.mjs` | Exact PR-head reservation; drift refused; unsigned request rejected; metadata preserved |
| `node docs/proof/snapshot-bootstrap/run-proof.mjs` | 2,001 records; cold hydration refused; actual snapshot CLI registered; restored bytes exact |
| `node docs/proof/snapshot-resume/run-proof.mjs` | 6,000 changes and 50 concurrent writes per run; six budgeted runs; final 5,967 records and reader delta zero |
| `node docs/proof/status-publication-outcomes/run-proof.mjs c9248c60fcfb060e332193bf6fed926758c5f5f7 --cache-paths` | 28 paired scenarios / 56 runs; real Worker/SQLite cache owners; no browser claim |

The actual installed `pnpm run dashboard:dev --local` static-site proxy accepted
public HTTPS with default roots and the exact private-CA fixture body with an
isolated extra bundle. With historical public roots and the private root supplied
through `NODE_EXTRA_CA_CERTS`, all 14 incident HTTPS endpoints returned HTTP 500
with underlying native `CertDistrusted`. Fresh OpenSSL chain and hostname controls
passed for every endpoint; [chain controls](chain-controls.json) bind them to six
verified incident TLS issuer SPKIs. Generic handshake errors are not counted.
Local health and SQLite queue requests returned 200; unsigned reconcile returned
401 with a synthetic secret configured.

## Environment and identities

Task-owned AWS Crabbox `cbx_1228a8e2a11f`, native Linux x64, AMI
`ami-04beed173f1785931`, requested c7a.xlarge; observed four CPUs and 7,730 MiB RAM.
Node 24.22.1, Corepack-selected pnpm 12.15.0, Wrangler 4.157.0, Miniflare
5.20261103.0-beta and workerd 1.20261103.1. The executed workerd SHA256 is
`315a009480729fa1f365e649cb34bf898e39df6c7d1a133f74c736ef201221b9`.

Native runs used task-owned HOME, stores, state and loopback ports; no instance
role (IMDSv2 credential endpoint 404), forwarded GitHub/Cloudflare credentials,
Docker, OS trust administration or production services. Run records:

- [Before-edit active fixture](https://crabbox.openclaw.ai/portal/runs/run_fa480d0fb21205cd99412b04d1f97a0d)
- [Dashboard TLS and paired status fixtures](https://crabbox.openclaw.ai/portal/runs/run_8bde85dea60ceec7ff43d243e7393756)
- [Required repository checks](https://crabbox.openclaw.ai/portal/runs/run_59b9d6c50f382d43db2b3a6084a3fca7)

The campaign report records final required-check, independent-review, committed
source binding and resource-disposal outcomes. A linked run is not by itself a
passing result.

## Applicability and limits

The old-pin inventory contained 33 executable docs/proof drivers: four explicitly
active drivers migrated here and 29 retained change-specific records without an
explicit active marker. No direct root-script/workflow invocation of those 29
was found; indirect/external invocation remains unverified. Historical versions,
assertions and observations remain intact. The docs index excludes old launchers
from current qualification and requires separately recorded current-toolchain
proof before reuse.

The manual-publication change qualifies its binary version admission only, not
its full independent historical publication matrix. Scheduled-budget accepts
caller-owned tooling, uses historical Miniflare v4 options and remains unqualified
with the current pair. This record does not establish other operating systems,
browser presentation, Cloudflare-managed runtime rollout, deployed fleet delivery,
every transport/alternate chain, or product TLS behavior for the two incident
code-signing-only keys. Existing certificate-failure HTTP 500 presentation is
unchanged.
