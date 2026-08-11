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

## Limits

This proves both production entry points, the local Worker/DO boundary, cryptographic signing, and
real socket transport with synthetic credentials. The controlled loopback endpoint is not GitHub
production, and the proof performs no production GitHub write, workflow dispatch, deployment, or
queue mutation.

## OpenClaw Bay impact

None. This is an internal authentication ownership consolidation. It changes no Bay data contract,
status projection, lifecycle semantics, controls, or observer-only boundary.
