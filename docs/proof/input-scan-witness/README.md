# Prospective privacy-safe input-scan witness proof

- Status: historical local proof, not deployment or maintainer format approval
- Owner: ClawSweeper maintainers
- Sources: `src/agent-input-scan-witness.ts`, inventory producer and shipped inspector
- Base: `92db2079704f31fcb4475f82a1e5f7049e5881e1`
- Explicit pending dependency: https://github.com/openclaw/clawsweeper/pull/2179 at
  `b93006dbfe13564dacd17c65ce95858283837d8d`; integrated locally at
  `bd933e7f18673a82c7aec3bd2905b87be7d81fb4`. Not merged upstream.
- Update trigger: witness producer/schema, inspector, fixture/driver, scanner or source pin changes.

## Claim and boundary

Add an optional witness to the existing bounded finding inventory, not a second
inventory implementation. A unique PLAIN literal in a validated staged Git blob
can receive its one-based line and UTF-8 byte **start** column. No semantic field
name, end position, match length, source excerpt, raw/decoded value, exception,
or match fingerprint is persisted. Two fields on one line have different starts.
A source owner can locate them without including arbitrary keys in a diagnostic.

PLAIN native detector/Raw/RawV2 identity tuples present in validated staged material
are compared only in memory and assigned bounded scan-local group ordinals among
retained entries. Equality is not proof of a shared source occurrence, a shared
credential, harmlessness or qualification. Distinct groups are not a credential
count. Reordered scans can assign different ordinals. Unknown/decoded/unbound
identities remain unavailable. Repeated literals have no unique start; **all patch
source locations remain unavailable**, even when blob/patch identities share a group.

This is prospective observability only. It does not recover historical evidence,
resolve https://github.com/openclaw/clawsweeper/issues/2180, or establish a detector
or classification bug. The pending dependency already has real native inventory
proof; its inventory limitation is not claimed as a new discovery here. Existing
policy, first-refusal authority, fixture eligibility, scanner flags, refusal exit,
provider boundary, artifact visibility and retention are unchanged. Witnesses use
the existing 6 KiB inventory budget and can reduce retained counts.

## Executable behavior contract

Surface: real TruffleHog -> shipped `dist/clawsweeper.js review --local-only` ->
production refusal manifest -> shipped identity-validating inspector CLI twice.
The existing native inventory driver is extended only with nested/repeated/neighbor
fixtures and witness assertions. The driver can run the exact same fixture against
a built export of the dependency-only integration baseline. Scanner output is not
injected and the scanner is not wrapped. Only GitHub's read transport and run/item
selectors are synthetic. Unknown reads and every mutation request fail closed.

Node >=24 (observed v26.11.1), pnpm 12.15.0, macOS arm64. Scanner: TruffleHog
3.99.4, binary SHA-256
`e05963636bce6c5a48e0c780b26c98eb851ec8f87ab6efce8167753a9141b893`;
official release archive digest pinned by the repository:
`dc942daecb4a7795fd0a7421c66281bd4cc2ba29a265f3f6c63ecb684a6db291`.
The task-owned scanner was acquired through the repository checksum-verifying
bootstrap, not a production scanner. Binary digest and `--version` checked by driver.

Disposable `.invalid` URI canaries are constructed inside a fresh local fixture,
never taken from a real input. Fresh HOME/TMPDIR, minimal credential-free env,
local-only Git remote, no-provider sentinel. macOS `sandbox-exec` denies **all**
network for the CLI and descendants; an active bind probe must return `EPERM`.
No scanner verification-disable flag is used and no network credential probe can
escape. Private working outputs/fixtures are not public evidence; publishable
receipts contain only bounded metadata and synthetic/public source identities.

```sh
pnpm run build
# SOURCE: this built candidate. BASELINE: built git archive of integration pin above.
# SCANNER: checksum-verified real 3.99.4 darwin-arm64 executable.
# OUT: fresh task-owned private scratch; never reuse directories.
node scripts/proof-input-scan-inventory-native.mjs "$BASELINE" "$SCANNER" "$OUT/before" 2 inventory nested
node scripts/proof-input-scan-inventory-native.mjs "$SOURCE" "$SCANNER" "$OUT/after" 2 witness nested
node scripts/proof-input-scan-inventory-native.mjs "$SOURCE" "$SCANNER" "$OUT/repeated" 2 witness repeated
node scripts/proof-input-scan-inventory-native.mjs "$SOURCE" "$SCANNER" "$OUT/neighbor" 2 witness neighbor
node scripts/proof-input-scan-inventory-native.mjs "$SOURCE" "$SCANNER" "$OUT/many" 12 witness separate
```

Expected: exit79 / `unclassified_finding`, zero provider launches and unchanged
fixture checkout. First-refusal material/reason/order can vary across native runs;
assert policy invariance, not byte-identical fresh scans. Two identical inspector
reads leave each manifest unchanged. A wrong expected head is rejected. Nested
native case has four detections (blob/patch pairs), two blob starts, two native
identity groups; patch locations stay unavailable. Repeated native literals have
no unique location. Changed-neighbor canaries still refuse and are not qualified.
Many findings remain bounded with correct omission accounting and first refusal.

## Regression coverage and limits

`test/input-scan-witness.test.ts` uses **injected classifier records**, explicitly
not native detections, for SHA-1/SHA-256 material pins, same-line starts, UTF-8 byte
columns, unique/repeated matches, raw-tuple inequality, reorder, unknown/decoded/
ambiguous/unsupported/unbound inputs, mismatched staged bytes/IDs, metadata bounds,
writer/inspector round trips, malformed witnesses and legacy compatibility.
Inventory and inspection suites cover truncation/accounting, unchanged first
refusal and redaction. Native CLI proof above is independent of those injected
records; tests and static checks do not substitute for it.

No claim of semantic field parsing, end/span extent, decoded attribution, patch
provenance reconstruction, stable match IDs, historical recovery, hosted queue
behavior, real provider execution, qualification, production replay, deployment,
publication, maintainer approval or merge readiness.

## Executed local receipts (2026-11-07)

Sanitized full assertions: [native-results.json](native-results.json). Candidate is
bound by the enclosing source commit (`git rev-parse HEAD`), not a floating release.

| Source / synthetic case | CLI exit | Findings | Retained / omitted | Inventory bytes | Provider calls |
| --- | --- | --- | --- | --- | --- |
| Dependency-only baseline / nested | 79 | 4 | 4 / 0 | 2777 | 0 |
| Candidate / identical nested | 79 | 4 | 4 / 0 | 4118 | 0 |
| Candidate / repeated literal | 79 | 2 | 2 / 0 | 2155 | 0 |
| Candidate / changed neighbor | 79 | 4 | 4 / 0 | 4118 | 0 |
| Candidate / twelve canaries | 79 | 24 | 5 / 19 | 5797 | 0 |

All five executions use real scanner-emitted detections, preserve first refusal,
pass the active `EPERM` isolation probe, make zero provider calls, reject a wrong
expected source head, and produce two identical inspector reads without changing
the manifest. Baseline and candidate nested fixture commit/bytes are identical.
An old dependency-only inspector also reads the new manifest successfully while
ignoring its optional witness. Native concurrency can reorder results; no fresh
scan byte-repeatability or universal retained-count claim is made.

Focused inventory/witness/inspection validation: **17/17 pass**, zero skipped or
cancelled. An initial full check stopped at documentation validation because the
new linked proof was not staged yet; staging it resolved that check. A subsequent
full run passed static/build/lint but was **not green**: 6,697 pass, 4 fail, 9
cancelled, 31 skipped (6,741 reported). Several entire test files timed out; this
is not a complete-suite result or baseline equivalence. A broad focused run that
included the long scanner suite exceeded its 120-second command budget; it is not
reported as passing. The bounded 17-test suites and all five native proof cases
were then completed independently. A first many-finding proof assertion incorrectly
required both blob and patch to fit a truncated sample; the driver was corrected
to require that only for the complete two-canary case, not to alter retention.

Required final whole-branch Codex source/security/privacy review and final
repository-check receipts are separate closeout evidence; no clean-review or
full-check-green claim is implied by these focused results. Parent independent
privacy screening remains mandatory. No public publication is authorized here.
