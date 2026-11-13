# Input scanner value approvals

Historical proof harness for https://github.com/openclaw/clawsweeper/pull/2201.
The owning implementation is `src/agent-input-scan-classifier.ts`; the host-owned
value identities are in `src/agent-input-scan-approved-values.ts`. Maintainers own
this evidence. Re-run when the classifier, approval data, scanner pin, or Git
staging changes. The PR body records the verified revision and runtime receipt.

The claim is that editing surrounding source does not invalidate an approved
synthetic value, while arbitrary credentials never qualify from their hostname.
The controlled proof exercises the production `scanAgentInput` function and real
checksum-pinned TruffleHog over both prompts and complete committed Git ranges.
It covers an approved value, an unrelated edit, a changed password, arbitrary
reserved/test/loopback credentials, SQL Server passwords ending in `@example.test`,
Postgres `hostaddr`, Cloud SQL JDBC target selection, and a nonreserved control.

Run in a task-owned development guest with Node 24+, the repository dependencies,
and the repository-pinned native TruffleHog binary on `PATH`:

```sh
pnpm run build
node docs/proof/input-scan-approved-values/run-proof.mjs --out /tmp/input-scan-proof.json
```

The receipt records the checked head, dirty state, binary digest, runtime, and
per-scenario admission result. Inputs use synthetic passwords and no working
remote database. The proof stops at admission and makes no model call; focused
tests additionally cover verified findings, scanner completion failures, native
metadata drift, and Git metadata replay. The 98 distinct value pairs and their
observed decoder bindings were migrated from the prior host-owned fixture and
attribution arrays at `8ba1ab445ed086863bbd9749237cfcb7096bae7a`; their source
filenames in the new data are provenance comments, not admission restrictions.
