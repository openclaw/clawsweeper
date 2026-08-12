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

After implementation, the complete operator test file passed locally:

```text
tests 62
pass 62
fail 0
```

The first ClawSweeper review correctly found that status-only 403 handling also accepted authorization and policy failures. The fix round preserved the GitHub response message and rate-limit headers, reused the shared throttle classifier, and added fail-closed REST, GraphQL, and revalidation regressions.

The refreshed Docker-backed Crabbox receipt independently reran the twelve focused loopback/workflow scenarios with 12 passed, 0 failed. Its sanitized output is in `container-transcript.txt`; package-manager notices are isolated in `container-stderr.txt`.
