# Bounded primary-body producer proof

- Status: historical proof recipe/artifact, not an operator runbook
- Scope: raw primary issue/PR body and PR files through production hydration,
  compaction, and final review-prompt JSON; media discovery and complete-source
  freshness
- Source: [producer script](../../../scripts/e2e/proof-context.ts),
  [shared fixture](../../../test/primary-body-fixture.ts), and
  [primary compactor](../../../src/clawsweeper-primary-body.ts)

From a checkout with Node 24 or newer and the pinned pnpm 11.10.0 installed:

```sh
pnpm run build
node scripts/e2e/proof-context.ts > proof-context-receipt.json
```

The default synthetic case contains 60,641 UTF-16 units: early supplemental
mock text, a later inert native-proof heading at offset 14,235, and an inert
HTTP/native-row trace at 19,562. The script executes the real
`collectItemContext` and final `reviewPrompt` path with locally supplied GitHub
transport; neither the compactor nor renderer is replaced. It shares fixture
wiring with the regression tests but runs as an ordinary executable, without
the test runner. Unexpected hydration capabilities fail closed.

The stdout JSON receipt records the current checkout HEAD, environment, source
and prompt hashes, exact retained ranges and excerpt hashes, omissions, and
serialized allocation. Both issue and PR representations must retain verbatim
excerpts within 12,000 serialized units per long body, including coverage and
indentation. An equal-length edit in omitted text must leave displayed evidence
unchanged while changing source revision, snapshot, content, and structural
identities. The default case edits the final source unit. Separate synthetic
media cases must produce zero supplemental runner calls, with one recording-only
prefix control call. PR patch-only cases cover a loopback fixture and harmless
prefix controls through the real collection and media-preparation owners. Each
must produce zero runner calls and no manifest or artifacts, while preserving
the compact patches in final prompt JSON. The same URL in the primary issue
body, PR body, or comment must still produce one recording-only call even when
also present in a patch. No runner call performs remote or loopback I/O.

Media fixture URLs are constructed from obvious parts at runtime, preserving
their assertion values without placing downloadable literals in this PR's
aggregate diff. This keeps existing reviewers safe before the patch-discovery
exclusion is deployed; it does not replace that production boundary.

An optional `--body-file path/to/body.md` reads authorized local text instead of
the synthetic body. It reports no file path or full body/trace bytes. Replay
requires a long body with an editable omitted range; recognized native-proof
and HTTP/native trace anchors must survive. Media checks always use synthetic
input. Do not commit private source bodies or prompts. The receipt identifies
HEAD but does not certify a clean working tree; rebuild and rerun after the
final commit before citing it as committed proof.

This is **input delivery and omission proof only**. The provider is a local
Node process, with no container image or lease. It does not invoke a model,
GitHub, cloud services, embedded scripts, or the original runtime described by
any saved body. Local GitHub transport is a fixture boundary, not live GitHub
integration proof. Verbatim excerpts do not establish source authenticity,
proof sufficiency, or a guaranteed reviewer verdict. Unrecognized or crowded
layouts can still omit material; coverage remains explicitly incomplete.
PR patches remain reviewer-only media inputs. No body-budget increase, extra
media fetch, proof-status/schema enum change, or weakened proof requirement is
part of this fix. OpenClaw Bay is unaffected: no observer fields, routes,
lifecycle states, or controls change.
