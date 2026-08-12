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

The green implementation moved the existing `createGithubAppTokenFor` helper to the canonical `dashboard/github-api.ts` plumbing module, then reused that exact credential, signing, installation lookup, and mint path from the operator. The focused owner/authorization/throttle selection passed 11/11, and the complete operator file passed 67/67. The installed/missing-owner scenario reports one recovery plus `installation_missing: 1`; the valid-installation authorization regression proves one mint for three same-owner targets and retains `http_403: 1, not_inspected_abort: 2` with zero recovery.
