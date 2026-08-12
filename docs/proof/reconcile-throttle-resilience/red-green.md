# Red/green record

The red phase changed only the loopback and workflow assertions, then ran the focused Node test selection against the `origin/main` implementation at `3d09c5f72ab26d55c1fe57a624dfc52d6d82ee8d`.

```text
tests 8
pass 0
fail 8
```

The relevant old behavior was explicit:

- One serial canonical 403 produced `http_403: 1, not_inspected_abort: 2`, made one REST request, and recovered nothing.
- Three eligible serial targets still stopped after the first 403 instead of reaching the intended three-call fuse.
- One recovery-revalidation 403 aborted all three candidates and recovered nothing.
- One throttled GraphQL batch attributed all 100 targets to the 403 and inspected no later batch.
- Target-read authorization was `Bearer test-github-token`, the synthetic repository Actions credential, instead of the synthetic target-App credential.

After round 1 implementation, the complete operator test file passed locally:

```text
tests 62
pass 62
fail 0
```

The first ClawSweeper review correctly found that status-only 403 handling also accepted authorization and policy failures. The fix round preserved the GitHub response message and rate-limit headers, reused the shared throttle classifier, and added fail-closed REST, GraphQL, and revalidation regressions.

The refreshed Docker-backed Crabbox receipt independently reran the twelve focused loopback/workflow scenarios with 12 passed, 0 failed. Its sanitized output is in `container-transcript.txt`; package-manager notices are isolated in `container-stderr.txt`.

## Round 2: per-target-owner installation tokens

The round-2 red phase added the two-owner loopback scenario before changing production code. With `GH_TOKEN` empty and synthetic App credentials present, the old implementation silently fell back to the repository Actions token and recovered both targets instead of isolating the absent installation:

```text
tests 1
pass 0
fail 1
AssertionError: 2 !== 1
```

The green implementation moved the existing `createGithubAppTokenFor` helper to the canonical `dashboard/github-api.ts` plumbing module, then reused that exact credential, signing, installation lookup, and mint path from the operator. The focused owner/authorization/throttle selection passed 11/11, and the complete operator file passed 67/67. The installed/missing-owner scenario reports one recovery plus `installation_missing: 1`; the valid-installation authorization regression proves one mint for three same-owner targets and retains `http_403: 1, not_inspected_abort: 2` with zero recovery. The final Docker-backed Crabbox receipt passed all 14 selected workflow, owner, authorization, and throttle scenarios.

## Round 3: throttled App setup calls

The round-3 red phase added setup-call fixtures before changing production code. The old implementation already treated token-mint 429 as a throttle, but its skip sample lacked the structured App-setup scope; confirmed rate-limit 403s from token mint and installation lookup aborted reconciliation before owner B:

```text
tests 6
pass 3
fail 3
```

The first pre-commit review found that repeatedly awaiting one cached rejected owner promise could manufacture three fuse events. The widened red case used three same-owner serial targets and an 81-target owner spanning three GraphQL batches; both starved the later healthy owner. The focused red selection failed 3/3. The second review found that splitting lookup from mint had dropped the existing mint-time 404 translation; its regression failed 1/1 because owner B did not recover.

The final implementation honors the shared `GitHubRequestError.rateLimited` marker, wraps setup throttles as `github_throttled scope=app_setup` with stage/owner/status, and keeps the rejected promise as the owner-level negative cache. Error-identity tracking counts that cached rejection once toward the existing fuse while three distinct throttled owners still stop before a fourth call. The token-mint 404 race again reports `installation_missing`; 401 and non-throttle 403 setup failures remain fail-closed.

The final setup-focused selection passed 11/11, the complete operator file passed 78/78, and `pnpm run check` passed. The fresh pre-commit Codex autoreview reported no accepted/actionable findings. The Docker-backed Crabbox receipt passed all 25 selected workflow, owner, setup, authorization, and throttle scenarios.

## Round 4: no silent Actions-token fallback

The round-4 red phase added the App credential matrix and workflow-mode assertions before changing production code. The old operator ignored the requested mode, accepted the first private-key-only case, reached the queue with the repository token, and exited successfully; both workflows also lacked an explicit target-token mode:

```text
tests 3
pass 0
fail 3

private key only: expected exit 1, actual exit 0
workflow target-token mode: expected github-app, actual undefined
```

The green path makes `github-app` the default target-token mode, validates the App ID/private-key pair synchronously at startup, and returns the repository token only when `EXACT_REVIEW_TARGET_TOKEN_MODE=actions` is explicit. Key-only fails naming the missing App ID, ID-only fails naming the missing private key, neither fails naming both, and both proceeds. The scheduled and manual workflows now select `github-app`; repository settings expose the referenced private-key secret, so the inspected scheduled lane was fully configured, while any future missing secret will fail the cycle visibly instead of recreating the throttle.

The focused workflow/matrix selection passed 3/3 and the complete operator file passed 79/79 on Node 24. The final Docker receipt and full gate results are recorded in `receipt.json` and the PR body.

## Round 5: repository-scoped installation-missing cache

The round-5 red phase taught the loopback fixture to resolve installations by full `owner/repo` when supplied, then added one cycle containing a missing repository followed by an accessible repository under the same owner. Against the owner-level rejected-promise cache, the new regression failed while both existing owner-throttle cases remained green:

```text
tests 3
pass 2
fail 1

AssertionError: expected recovered_targets 1, actual 0
```

The green implementation keeps in-flight and rejected installation-missing mints under a normalized repository key. Only a successful installation token or a confirmed setup throttle is promoted to the owner cache. The same selection passed 3/3, including both 429 and confirmed-403 owner-throttle cases, and the complete operator file passed 80/80 on Node 24.
