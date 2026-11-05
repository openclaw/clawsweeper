# Manual Coverage credential probe

- Status: active diagnostic procedure; hosted evidence pending
- Owner: ClawSweeper maintainers
- Source of truth: `.github/workflows/coverage-credential-probe.yml`,
  `src/repair/coverage-credential-probe.ts`, and its focused test
- Baseline: `0318620fb1134a8a0f9aadccbc886be05310919e`
- Update when: credentials, query, transport bounds, guards, or output change

This diagnostic is **not a production fix** and does not diagnose a v2-only auth
regression: counts and legacy Coverage already use `publicInventoryEnv` too.
It compares two credentials against exactly the same shared census query. No
collector, Worker, checkpoint, cursor, queue, admission, budget, cadence, auth
selector, production permissions, or retired Bay consumer changes are involved.
Bay remains a retired observer; this experiment has no consumer/UI effect.

## Manual safety boundary

The new workflow has only `workflow_dispatch`, no inputs, and a job-level guard
requiring `openclaw/clawsweeper` on `refs/heads/main` **before credentials**.
Do not merge or dispatch without separate approval. No dispatch has been run.
The explicit Martin 17:37 evidence-in-progress exception permits preparing the
PR; **hosted A/B proof remains pending approved merge and separate dispatch**.
No write permission is needed or granted to the workflow token.

- A: default Actions `GITHUB_TOKEN` with contents/issues/pull-requests **read**.
  This is the same installation/repository and read-capability comparison, not
  literally the production token bytes, dispatch-token variant, or full writes.
  If those differences preclude a faithful experiment, stop for a maintainer
  decision; do not broaden permissions.
- B: the existing owner-scoped openclaw inventory App, existing client ID and
  private-key secret, existing pinned mint action, metadata-read only. Its private
  key is available only to the mint action, never the probe. The mint action's
  normal token creation/revocation is the only credential lifecycle operation;
  the diagnostic itself makes no mutation requests.
- A missing token or B mint failure is incomplete/inconclusive, fails the probe,
  and cannot fall back to anonymous, personal, local-host, or another token.

After the existing pinned Node 24.22.1 / pnpm 12.15.0 setup and `build:repair`,
the standalone CLI POSTs only to `https://api.github.com/graphql`. It imports only
the unchanged census query/adapter (not the collector entrypoint or mutation
code). The fixed query reads the first 100 open issues and first 100 open PRs in
public `openclaw/openclaw`, both null cursors, A then B. No redirects or retries;
at most two requests, each 15 seconds and 1,900,000 response bytes. One role can
still be observed when the other is missing, but the incomplete run fails.
There is no custom endpoint, query, ref, cursor, repository, or URL input.

Only the exact `coverage-credential-probe.json` is uploaded for three days.
Stdout and the GitHub summary contain that same closed aggregate: role enum,
source/query SHA, fixed public target, phase, HTTP status, error category, parsed
item count, bounded rate fields when returned, and elapsed milliseconds. The
shared census query does not request rateLimit, so those rate fields are normally
null (no extra query is added). No token/hash, headers, raw response, messages,
stacks, extensions, IDs, cursors, or environment dumps are emitted. Response
bodies are held only in bounded memory. No Worker/control/state calls exist.

## Interpretation (observations, not production health)

The closed category enum is `none`, `access`, `authentication`, `ambiguous`,
`rate`, `schema`, `graphql`, `http`, `transport`, `timeout`,
`body_oversize`, and `missing_role`. There is no automatic access-difference or
production-health verdict in the output.

- A reliable positive `access` signal / B parsed 200 supports an access difference
  only for this precise query and these roles. `access` requires a typed GraphQL
  denial or an exact known GitHub permission phrase, after rate/mixed/unknown
  guards. A bare HTTP 403 is `ambiguous`, **not** confirmed access denial.
- HTTP 429, exhausted-quota/valid Retry-After error signals, explicit GraphQL
  RATE_LIMITED, and fixed canonical GitHub rate-limit phrases identify `rate`.
  This includes secondary 403s without Retry-After; absent Retry-After never
  establishes access. Headers and bounded error text are inspected only inside
  memory, never emitted. A successful 200 with zero remaining quota stays success.
- HTTP 401 and typed UNAUTHORIZED are `authentication`, not scope evidence.
  NOT_FOUND is ambiguous. Unknown/mixed GraphQL failures stay conservative;
  unknown/schema/credential failures are not hidden by another typed denial.
- A `rate`, `ambiguous`, or `authentication` / B success must not be interpreted
  as an access difference. Both parsed means only that this paired query worked.
  HTTP 200 with GraphQL errors is never parsed success. Recognized access/rate
  observations can complete a negative experiment, never a health claim.
- Missing roles, authentication, ambiguity, network/deadline/body-limit failures,
  redirects/HTTP infrastructure, unknown GraphQL, invalid JSON/schema/parser
  results fail the job. No incomplete experiment is converted to a pass.

Even reliable A-denial/B-success does **not** establish the production failure's
cause without identifying its failing phase and observing natural producer
progress. The generic checkpoint 409 does not identify that phase. No retries,
backoff, credential fallback, permission broadening, or live A/B are added.

## Controlled behavior proof

Claim: fixed paired reads with closed redacted output and no automatic or
production mutation path. Exercise the compiled CLI over real loopback HTTP via
a **test-only** preload that reroutes the unchanged production URL, with only
fake role credentials and no inherited host secrets:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:repair
node --test test/repair/coverage-credential-probe.test.ts
```

The test records sanitized aggregate artifacts and a role-label-only HTTP trace
under `.openclaw/tmp/coverage-probe/http-proof-*/`. It asserts the identical query
hash in exactly two serial POSTs (zero when both roles are missing, one A-only
POST when App minting is missing), parsed 200
versus explicit permission/ambiguous/rate-limited 403 (quota, valid Retry-After,
and secondary limits without Retry-After), 401, 429, mixed/unknown GraphQL
access/rate/schema errors, invalid JSON/parser data, redirect
refusal, transport failure, actual 15-second timeout, measured oversized body,
and secret-string non-disclosure in stdout/stderr/artifact. Workflow assertions
cover trigger/guard/read grants, exact mint inputs, probe env, and exact artifact.

Local host proof uses Node >=24 and pnpm 12.15.0. It is not container isolation,
real Actions credentials, a hosted A/B result, or production causal evidence.
Before PR publication the separately approved Crabbox local-container rerun,
final committed-range review, and repository validation gates remain required.
Hosted proof is explicitly pending under the exception above.
