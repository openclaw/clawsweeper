# Exact MCP sandbox-origin fixture qualification

Status: canonical native behavior proof and scoped controls complete. The
interrupted full-suite result and all observed baseline/environment failures
are qualified below; final committed-branch review is recorded in the PR body.

Owner: ClawSweeper review-lane maintainers.
Owning policy: `src/agent-input-scan-fixtures.ts`.
Observed baseline: `940ad52249d67d3f7ec57deaf2fc397f771ed9d2` (2026-11-04).
Update triggers: literal/full-line/path changes, scanner version or decoder
changes, attribution-policy changes, or completion of the remaining gates.

## Behavior-proof contract

**Claim:** qualify only the proven synthetic MCP Apps sandbox-origin negative-URL
fixture at its exact full line in `src/config/config-misc.test.ts`.

**Surface:** the canonical `scanAgentInput` committed-range path, including all
before/after source blobs and complete added/context/removed patches, with
pinned native TruffleHog 3.99.4 and verification enabled.

**Scenario:** reproduce the complete range
`fb2c420c4e75ea43884869786f5b0e9b7af36c06` through
`3679341be3efbae7b466a4eb6bb12ee945186f97`, covering 39 changed paths.
The first revision is verified as the head merge-base.

**Command/environment:** Linux x64, Node 26.12.1, own frozen dependencies and
canonical build, original scanner flags, managed tool cache and private staging:

```text
pnpm run build:node
node docs/proof/agent-input-scan-context/run-proof.mjs <own source checkout>
  fb2c420c4e75ea43884869786f5b0e9b7af36c06
  3679341be3efbae7b466a4eb6bb12ee945186f97 <output.json>
```

**Observable/artifact:** the pinned baseline refuses two findings; the tuple-only
candidate admits them. The [sanitized receipt](native-reproduction.json) records
source/build hashes, references, native notices, control outcomes, and limits.

**Limits:** controlled prompt only, not full hosted prompt admission. Negative
controls use derived private commits that preserve all 39 changed paths and all
unrelated original tree content; the fixture file alone is deliberately varied.
No raw credential-shaped value is printed in this evidence.

## Narrow policy change

The production change adds three exact attribution tuples and enrolls their
source in the existing URI PLAIN/HTML validation schema: the retained six-space
legacy PLAIN witness, plus PLAIN and HTML for the observed four-space full line. Detector, Raw, RawV2, full-line digest, source path, regular-file
mode, committed-reference checks, and all existing native completion and
verification requirements still apply.

The proposed ESCAPED_UNICODE tuple and special predicate were removed. An earlier
standalone compare-patch scan emitted that label, but did not prove it necessary
on the complete canonical input. The narrowed candidate passed that full input
and real added/context patch controls using the existing matcher unchanged.
Unapproved decoder variants remain refused, including explicit regression
coverage for ESCAPED_UNICODE. There is no domain, path, detector, PR-number, or
scanner-wide exception.

## Immutable failure and same-input diagnosis

- Context: <https://github.com/openclaw/openclaw/pull/191061>.
- Hosted failure:
  <https://github.com/openclaw/clawsweeper/actions/runs/41818159154/job/126534173101>.
- Artifact `13315832028`,
  `exact-review-failure-diagnostics-41818159154-1`, archive SHA-256
  `8542d7b236a6c6a1db55dbe22145fd4dbc9f144fd848514c91e8a208a2d2d3d7`.
- Its manifest reports two findings but retains only the first diagnostic.
  The retained base blob is `31c6eb5e1aef768f44b8fa778d24cc8b5bffe8c1`,
  at source line 153, independently bound to the stated source path.
- The complete-input reproduction identifies a base-blob finding at line 153
  and a removed-patch finding at line 133, attributed back to the same base
  blob and source line. This is not an inference from the standalone patch.
- The head blob `ec131bb68ef4d4c9c02a620728166a81fa142da8` has no occurrence.

Exact Raw and RawV2 SHA-256:
`354e44c28981412829c4cd79588c7c5385d55221eb1f5d0014e96421d35e76a4`.
Four-space full-line SHA-256:
`6b3e1580cf762cafe2a8483dbfecf2aee6bd929725febab70331cfbf8d13a8b5`.
Retained legacy full-line SHA-256:
`f7d672c72c5b3f9f67b09a5b0f15fdab1c565d36d534c62e3424c4cd1981bb06`.

## Validation and controls

After fixing the policy-schema enrollment and the existing MCP audit/patch
expectations, 61 selected MCP/policy regressions passed against actual built
modules. It covers exact committed references, added/context/removed patch
attribution, and refusal of changed values, lines, paths, modes, roles, decoder
variants, extra occurrences, verified/mixed metadata, and completion mismatches.
Earlier adapter-only checks are historical supporting evidence, not this proof.

Thirteen real native controls passed: added/context positive controls; changed
value, full line, path, mode, extra occurrence, mixed finding, unsupported
decoder, prompt material, additional material, index role, and tree role refusals.
Snapshot controls retained strict current-head/index/status/content checks.
They did not relabel native output or replace the production classifier.

The owned loopback Basic-auth attempt remained unverified: the pinned URI
verifier deliberately uses `DetectorHttpClientWithNoLocalAddresses`. No local
address override, scanner flag change, or public endpoint was used. This is a
limit of that attempt, not a native `Verified=true` result.

The explicit constructed classifier regression keeps the same exact approved
fixture and consistent completion counters, sets `Verified=true`, and asserts
`finding_not_reviewed` with the verified flag retained in the diagnostic. It is
classifier-level evidence, not native verification. This follows the existing
[proof boundary](../agent-input-scan-context/README.md): real canonical native
full-range admission is proved separately from public-classifier rejection
controls. The production classifier, verified guard, decoder predicate, scanner
entrypoint, and bootstrap are byte-identical to the pinned baseline; the
production matcher and native verification settings were not changed.

## Full-suite qualification

The required `pnpm run check` command was run unchanged at low priority. An
initial 180-second attempt exposed fixture-policy regressions that were fixed
and validated with 61 selected tests. The single authorized 600-second attempt
was stopped after 414.125 seconds by its pressure-and-quiet-output watchdog; the
owned process group was terminated and joined. **There is no overall full-suite
pass claim.**

The saved log contains 11 distinct failing tests, not duplicate summary lines.
Each was selected by its exact name and executed on the candidate and complete
pinned-baseline source, using the same host, Node, pnpm, and own-worktree
dependencies. Every case executed; all 11 have matching diagnostic/code/expected/
actual signatures after normalizing ephemeral paths. Their test files are
unchanged from the pinned base. See the public
[per-failure attribution](check-failure-attribution.json) for commands, errors,
source linkage, statuses, and receipt hashes. No observed candidate-only or
unclassified failure remains in this set.

The actual apply-drift case fails on baseline and candidate with
`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`. Its Node-launched shell places
`/usr/bin` before the intended test pnpm shim. Bare Node reproduces the prefix
without repository imports. The other failures have their own baseline
reproductions; their causes are not inferred solely from this example. No
workflow, unrelated harness, environment policy, or scanner guard was changed
to force a pass. Earlier filtered apply-label-sync probes matched no test and
are invalid evidence; their isolated-pass inference is retracted.

The repository requires running the check and completing focused behavior proof
and a clean committed whole-branch Codex review before publication. Hosted
current-head CI and landing gates remain separate. The PR body must retain these
check limitations and the final review receipt; no review acceptance or hosted
CI result is implied by this document.

No OpenClaw PR branch write, hosted re-review request, live policy deployment, or
merge is part of this change. Private execution logs and controlled source
fixtures are retained under `.openclaw/tmp/mcp-fixture/`; the sanitized committed
receipts above are independently inspectable without Team chat access.
