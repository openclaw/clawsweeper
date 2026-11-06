# Released Workerd adoption — November 6, 2026

- Status: historical qualification record; no deployment performed.
- Owner: ClawSweeper maintainers.
- Source: base `066e625998e61b8045704618e21d3ab9d73d7329`, compared with this branch's package, lock, configured entry and workflow inputs; exact tested file hashes and native identities are in [results](results.json).
- Update trigger: changed dependency selection, Worker entry or TLS/proof claims requires new applicable evidence.

## Observed behavior

The real `pnpm run dashboard:dev --local` fails on both the original Wrangler 4.131.1 and candidate 4.157.0 before the entry repair:

```text
Incorrect type for map entry 'STATUS_REFRESH_TIMEOUT_MS':
the provided value is not of type 'function or ExportedHandler'.
```

The configured production entry now exposes only the existing handler and its three bound Durable Objects. The new configured-entry contract test fails before this repair and passes afterward. Existing implementation/test exports remain in their owning module.

With that identical entry repair applied to both dependency variants, the actual dashboard static-site proxy accepts all 14 incident endpoints with the old engine and rejects all 14 with the candidate engine. This isolates dependency selection from the independently reproduced entry defect. The existing `DASHBOARD_SITE_ORIGIN` binding selects the fixture; there is no production test seam.

[Chain controls](chain-controls.json) record fresh, successful OpenSSL chain and hostname verification against historical public roots, certificate hashes and six verified incident TLS issuer SPKIs. Every candidate product error has an underlying native `CertDistrusted` diagnostic. Unavailable endpoints, unknown issuers and generic HTTP 500 responses alone are not counted as incident rejection.

| Actual dashboard scenario | Old dependencies + entry repair | Candidate |
| --- | --- | --- |
| Public HTTPS through the page proxy | 200 | 200 |
| Private-CA HTTPS through the page proxy | 200; exact fixture body | 200; exact fixture body |
| 14 valid incident endpoints, historical/private extra CA | 14 HTTP 200 | 14 HTTP 500, each with native `CertDistrusted` |
| Health and local SQLite queue | 200 / 200 | 200 / 200 |
| Unsigned reconcile, synthetic webhook secret configured | 401 | 401 |

The first public control used nodejs.org: its redirect was rewritten to the visitor host, where the non-dashboard path returned 404. A separate example.com public control passes. An initial unsigned probe without any webhook secret correctly returned 503 `webhook_not_configured`; the configured negative control above uses a task-only synthetic secret. These were harness setup outcomes, not attributed regressions.

## Exact environment and commands

Task-owned AWS Crabbox, native Linux x64, c7a.xlarge, four CPUs and approximately 7.5 GiB RAM; no instance role (IMDSv2 credentials endpoint 404), Tailscale, Cloudflare/GitHub credentials, Docker, host trust changes or production services. Node 24.22.1 and the repository's pnpm 12.15.0 selection; task-owned mutable caches, state, fixture keys and loopback ports. Both sides use the same guest and HTTPS fixtures.

The actual package manager is the existing Corepack shim honoring `packageManager: pnpm@12.15.0`; both isolated caches contain the same `pnpm.mjs` SHA256 `34449bb50fd01f9d93855ee2ab00843bd62fc8b6efae1309c5c9e5a1fb0f3f58`. An unused bootstrap symlink targeted the obsolete `pnpm.cjs` filename and was skipped by command lookup; the downloaded standalone archive is not claimed as the executed launcher.

Candidate Wrangler 4.157.0 naturally selects Miniflare 5.20261103.0-beta and workerd 1.20261103.1. The direct Miniflare owner selects the same engine. Existing dependency-script denial and 48-hour admission policy remain unchanged; no new age exception, override or supplier patch. The generated lock updates the selected Miniflare closure, including its declared Sharp and Undici dependencies.

Representative actual command (fixture origin varies by scenario):

```sh
pnpm run dashboard:dev --local --ip 127.0.0.1 --port 19410 \
  --inspector-port 19411 --persist-to /tmp/clawsweeper-workerd-20261106/dashboard-state-candidate \
  --show-interactive-dev-session=false \
  --var DASHBOARD_SITE_ORIGIN:https://dv-g3b-emudhra.we-have-a-problem.com \
  --var CLAWSWEEPER_WEBHOOK_SECRET:synthetic-task-webhook-secret
```

Incident/private scenarios set `NODE_EXTRA_CA_CERTS` to the isolated combined historical/public and task-private root bundle. Public default-trust scenarios unset it. No OS trust store is modified. Chain controls use:

```sh
openssl s_client -connect HOST:443 -servername HOST -verify_hostname HOST \
  -verify_return_error -CAfile historical-explicit-ca.pem -showcerts
```

Additional completed qualification: frozen installation, installed direct Miniflare using `convertV4MiniflareOptions` against the actual bundled entry and SQLite Durable Objects, Wrangler `deploy --dry-run`, credential-free Pages command help, and the dashboard-site workflow's committed-fixture build with all nine expected output pages. No Pages project creation, publish or deployment command ran.

Native executable SHA256, independently selected by both direct Miniflare and npx Wrangler:

- Old workerd 1.20260911.1: `caf8ce67240e4349e50c839cd06b29b6eea6ff3867ade44ce1b287649f282242`.
- Candidate workerd 1.20261103.1: `315a009480729fa1f365e649cb34bf898e39df6c7d1a133f74c736ef201221b9`.
- Wrangler rebuilt entry: `632852b8dab9b9471f4e0ffec30bc65ecc4cb07917f96ca7c5ca9bc1b1a6d3dc`.
- Independently bundled direct-Miniflare entry: `46a5cd5f57af16b0e122cf2353857ee7df245bc5a6db5faba764eccb82cb7b56`.

## Limits

This establishes the demonstrated local Linux x64 product and native verification boundaries. It does not establish Cloudflare-managed runtime rollout, remote production state, other platforms, every proxy/transport or alternate chain, or product TLS controls for the two code-signing-only incident keys. The dashboard's existing HTTP 500 presentation on upstream certificate failure is unchanged; native diagnostics identify distrust.

Future merging retains the repository's existing Worker deployment and Pages publish effects. This qualification neither triggers nor verifies them. The campaign report owns final required-check, independent-review, PR and resource-disposal status; this historical fixture record does not waive those gates.
