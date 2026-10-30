# Worker cache and recovery proof

Historical proof recipe for PR [2063](https://github.com/openclaw/clawsweeper/pull/2063).

The claim is that the production dashboard reader separates repository and permission
scopes, refreshes a revoked cached token once without widening its grant, and that
canonical-target authorization gates the recovery effect. Run from the repository
root with Node 24+ and installed dependencies (including existing build output for
the shared test storage adapter):

```sh
pnpm run build:node
TMPDIR="$(cd "$(getconf DARWIN_USER_TEMP_DIR)" && pwd -P)" node docs/proof/app-token-scoping/run-proof.mjs
```

On other operating systems omit the macOS `TMPDIR` assignment. An optional first
argument chooses the JSON output file; the default is
`.artifacts/app-token-scoping/worker-proof.json`. Standard output is the same JSON.
The receipt includes HEAD, dirty state, runtime, each assertion, bearer aliases mapped
to grants, request status codes, and recovery mutations. Private keys and actual
opaque bearer values never appear in the receipt.

The script imports the actual `dashboard/worker.ts` reader and starts a real loopback
HTTP server. Generated RSA credentials sign App JWTs, which the server verifies.
Each token mint creates a distinct opaque token with the requested repositories and
permissions. Repository mismatches return 404, ungranted permissions return 403,
and revoked tokens return 401. Explicit negative controls test the stub itself.

The canonical credential switch lives in the production dead-letter operator's
`inspectRecoveryTarget`, not in the Worker's read-token cache. The proof runs that
unmodified CLI with an isolated environment: an issue lookup for
`openclaw/openclaw#321` resolves to a PR in `openclaw/canonical-target#321`.
The canonical PR read must use a separately minted, canonical-only token. Denying
that read leaves the dead letter open and produces no recovery request. Allowing it
passes through the real signed Worker recovery route into the real queue, resolves
the dead letter, and creates exactly one pending source review. This direct
`recover-fresh` route deliberately preserves the original source identity; it does
not claim to migrate the queued review to the canonical repository.

The initial run on `b1f3ee65c9ffdd50862aa180066f9469c611e2a4` failed at the revoked
cached token with `GitHub 401 for /repos/openclaw/alpha/issues/3`. After the fix,
that read observes 401, then 200 with a newly minted alpha/issues-read token; the
next read reuses that replacement. Regression tests also cover a rejected
replacement, a permission denial, a supplied token, and delayed concurrent 401s.

Limits: local Node (`provider=local-node`, image/lease not applicable), synthetic
GitHub authorization, and the existing SQLite-backed test storage/namespace
adapter. The production Worker, signer, token/cache code, CLI, and queue recovery
logic execute; Cloudflare deployment, alarms, and live GitHub authorization do not.
No real credentials, live GitHub calls, production writes, or new configuration are
used. The earlier live composite proof remains separate evidence.
