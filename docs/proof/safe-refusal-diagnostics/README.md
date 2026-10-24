# Safe refusal discovery proof

- Status: historical change proof
- Owner: ClawSweeper maintainers
- Baseline: `385ed215fa2cfd04e53ab11d6cf814b8a3226b85`
- Scope: [upstream issue](https://github.com/openclaw/clawsweeper/issues/2057)

## Supported gap

The baseline already serializes `AgentInputScanError.scanDiagnostic` and uploads
`failure-diagnostics/` as a bounded Actions artifact. The exact-review command
and pre-hydration preparation both call that writer. Workflow completion reads
its stage/reason and preserves terminal refusal. However, no workflow summary
points operators to the diagnostic, no documented safe extraction recipe exists,
and the manifest has no producing run/attempt identity. This change reuses the
writer and artifact, adds optional Actions provenance, and links a pointer-only
summary to an authenticated, identity-checked read of the manifest.

## Executed behavior contract

Claim: a terminal scan refusal can be inspected safely for its exact source and
producing run, without reading scanner logs or calling a model.

Surface: production `runAgentProcess` -> scanner subprocess -> existing serializer
-> operator CLI -> actual workflow summary shell body. Scenario: temporary clean
Git repository with two commits; controlled scanner process speaks the pinned
native protocol, emits an unclassified finding with synthetic canary values,
and exits 183 after a complete scan. A provider executable records any invocation.

Command from a built checkout, Node 24+ and Bash:

```sh
node docs/proof/safe-refusal-diagnostics/run-proof.mjs docs/proof/safe-refusal-diagnostics
```

Observed: [result.json](result.json) and [operator transcript](operator-transcript.txt).
The review refuses with exit mapping 79, `retryable=false`, and zero provider
invocations. The actual baseline writer produces no run provenance and is rejected
by the exact-run reader; the changed writer passes. The inspector emits safe
metadata and the workflow shell emits only its pointer. Missing upload output
produces an explicit unavailable summary. Synthetic run IDs/links in this fixture
are not live GitHub artifacts.

Focused regression coverage includes wrong target/item/head/run/attempt; absent
provenance or attribution; malformed/oversized/symlink input; unsafe URLs and
control characters; invalid scanner metadata; and ignored raw-value canaries.
`test/exact-review-failure-diagnostics.test.ts` also tests provenance production.
The new inspector import and provenance assertions fail against the baseline;
all pass after the implementation. Existing terminal/hold tests remain required.

Limits: the scanner is a controlled native-protocol fixture, so this proves the
changed runtime/artifact/discovery path, not native detector accuracy. No live
queue, authenticated GitHub artifact download, hosted workflow, model service,
account configuration, deployment or public comment mutation is exercised.
The queue/hold implementation is unchanged; focused existing tests cover it.

## Review disposition

Pre-commit Codex review found that hydrated issue diagnostics record a non-null
SHA-256 source revision. Accepted and fixed: the inspector now requires that
exact digest, the workflow selects `expectedSourceRevision` for issues and
`sourceHeadSha` for PRs, and the runbook no longer suggests a null issue identity.
Regression coverage exercises the production writer-to-inspector issue path,
wrong revisions, missing revisions and PR-shaped SHA-1 values. No findings rejected.
