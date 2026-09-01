# GitHub App authentication unification proof

## Claim

The dashboard Worker and exact-review queue Durable Object use one canonical GitHub App signer and
request implementation without changing either entry point's observable behavior. Their signed
routes emit byte-identical JWTs and canonical App-auth request headers for the same synthetic App
identity, while their route-specific methods, paths, and bodies remain distinct.

## Exercised surface

- Real `wrangler dev --local` Worker HTTP routing and GitHub webhook signature verification
- Real SQLite-backed `ExactReviewQueue` Durable Object routing, storage, and alarm processing
- The production GitHub App credential parser, RS256 signer, PKCS8 importer, and HTTP client
- The worker's plain-error adapter and the queue's classified-error implementation
- Loopback-only `GITHUB_API_URL` transport over a real HTTP socket

## Controlled scenario

The harness starts one local Worker/DO runtime and one loopback GitHub HTTP server. It concurrently
sends:

1. a signed maintainer `issue_comment` webhook through `/github/webhook`, which exercises the
   dashboard Worker App-auth path; and
2. a signed branchless review request through `/internal/exact-review/branch-authority`, which is
   forwarded to the real queue Durable Object and resolved by its alarm through App auth.

The loopback server holds the Worker's installation lookup and the queue's installation-token
request until both are present. The harness then requires their complete JWT strings and their
canonical `Accept`, `Content-Type`, `User-Agent`, and `Authorization` header bytes to be identical.
It also verifies the route-specific request methods, paths, and bodies, the Worker's successful
command acknowledgement, the queue's resolved target branch, and the absence of unexpected HTTP
requests. Committed traces contain hashes and redacted authorization values, never the private key,
JWT, or installation tokens.

## Command

Run on Node 24 or newer from the repository root:

```bash
docs/proof/unify-github-app-auth/run-proof.sh
```

Artifacts are written under `docs/proof/unify-github-app-auth/artifacts/` by default. Set
`UNIFY_GITHUB_APP_AUTH_PROOF_OUTPUT` to use another directory.

## Local observation

The committed local run exercised code commit `007544716b06d9b9189ac846c903bac2df7e155c` on
Node 24.19.0 and completed with `PROOF_RC=0`. The real Worker returned `202` with status comment
`777`; the real queue Durable Object returned `202`, resolved `openclaw/gogcli#598`, and made no
unexpected loopback requests. The two entry points' App JWTs and canonical App-auth header bytes
were identical. See [`artifacts/proof-summary.json`](artifacts/proof-summary.json) and the
[`redacted request trace`](artifacts/github-requests.redacted.json).

## Crabbox container observation

The same proof passed from a clean `--fresh-pr openclaw/clawsweeper#1115 --no-hydrate` checkout at
head `075bcf0494864fb1d8fd4475d211b5b9f741c173` inside Docker-backed Crabbox
`provider=local-container`, image `node:24-bookworm`, lease `cbx_585f04f5feea`
(`violet-prawn-a71c`). Corepack supplied pnpm 11.10.0, and jq 1.8.1 printed
`jq-linux-amd64: OK` before installation. The runtime proof completed with `PROOF_RC=0` and
`CONTAINER_PROOF_RC=0`; Crabbox exited 0 and stopped the lease automatically.

The same container first checked current `origin/main` at
`765644804756d5f6b1dc1e940d62c50711e398d8`. Its targeted baseline produced the three known
blob-hydration environmental failures. The PR full suite then ran 3,312 tests: 3,301 passed, 8
skipped, and exactly those same 3 failed. The harness recorded `CONTAINER_DELTA_FAILURES=0`.
[`artifacts/crabbox-local-container-provenance.json`](artifacts/crabbox-local-container-provenance.json)
and [`artifacts/crabbox-local-container-summary.log`](artifacts/crabbox-local-container-summary.log)
retain the provider, lease, timing, baseline, and verbatim result markers.

## Limits

This proves both production entry points, the local Worker/DO boundary, cryptographic signing, and
real socket transport with synthetic credentials. The controlled loopback endpoint is not GitHub
production, and the proof performs no production GitHub write, workflow dispatch, deployment, or
queue mutation.

## OpenClaw Bay impact

None. This is an internal authentication ownership consolidation. It changes no Bay data contract,
status projection, lifecycle semantics, controls, or observer-only boundary.
