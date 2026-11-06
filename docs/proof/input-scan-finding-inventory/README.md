# Controlled finding-inventory proof

- Status: historical controlled proof, not deployment evidence
- Owner: ClawSweeper contributors/maintainers
- Source: `scripts/proof-input-scan-inventory.ts`, `src/agent-input-scan-fixtures.ts`, `src/clawsweeper-review-failure-diagnostics.ts`, `scripts/inspect-input-scan-diagnostic.mjs`
- Baseline: `51e006973ca9bb79dea2b0d874fa57db6bcdc4fa`
- Observed: 2026-11-06, Node 26.11.1, pnpm 12.15.0, POSIX local process
- Update trigger: changes to inventory fields/bounds, refusal emission, or inspector projection

## Claim and exercised surface

A complete input scan with multiple findings still refuses before provider dispatch,
but its failure manifest retains bounded safe metadata for more than the first
refusal. Reading diagnostics does not retry the scan or invoke a provider.

The executable driver creates a disposable committed Git target with only
`DIAGNOSTIC_CANARY_A` and `DIAGNOSTIC_CANARY_B`. It uses the existing test-only
`writeFakeScanner` seam (a trusted external executable on a temporary PATH),
which supplies two **synthetic** finding records and completion metadata. It
calls the actual `runAgentProcess` scan path and actual
`writeExactReviewFailureDiagnostics` serialization, then reads the emitted
manifest through the authenticated-identity inspector protocol twice. A provider
sentinel would record any invocation; it remains absent. All temporary inputs
and outputs are removed. The driver emits only a safe diagnostic projection.
Synthetic run selectors exercise identity matching, not real Actions provenance.

```sh
pnpm run build
node scripts/proof-input-scan-inventory.ts
```

## Observed before / after

Before changing runtime source at the baseline above, the same controlled driver
through manifest emission returned `refusal: findings`, `findingCount: 2`,
`firstFindingIndex: 0`, **no inventory**, and `providerCalls: 0`.

After the change, emission and repeated inspection return:

```json
{
  "refusal": "findings",
  "firstFindingIndex": 0,
  "findingCount": 2,
  "inventoryCounts": { "total": 2, "retained": 2, "omitted": 0, "unattributed": 0 },
  "originalIndices": [0, 1],
  "sourceAttribution": "unavailable",
  "providerCalls": 0,
  "canaryOrPrivatePathInManifest": false
}
```

Both entries identify staged blobs with hashed references (one base, one head).
Neither claims a proved source line. The original refusal reason/index, terminal
scan behavior, and provider non-invocation remain unchanged. This summary omits
nondeterministic disposable commit IDs, not evidence required to reproduce the
claim. Run the driver to see its generated safe manifest inventory.

## Supporting checks and limits

Focused tests cover count/byte truncation including a nonzero first refusal after
an earlier qualified finding, malformed/oversized metadata, decoded/plain/unknown/
ambiguous/patch attribution, inspector validation, omission and inert rereads.
They supplement, not replace, the executable runtime proof above.

This is **not a real TruffleHog reproduction**, detector false-positive finding,
fixture qualification, security adjudication, hosted queue/publication test,
access-control rollout or deployment proof. The controlled scanner intentionally
does not detect the canaries: they are protocol data, not credentials. Scanner
completion and trust policy, provider behavior, artifact access/visibility,
publication and refusal/retry rules are unchanged. No raw scanner output, matches,
source excerpts, credentials or environment content are diagnostic fields.

Related discovery work: https://github.com/openclaw/clawsweeper/issues/2057 and
https://github.com/openclaw/clawsweeper/pull/2058. Decoded source binding remains
separate: https://github.com/openclaw/clawsweeper/issues/1724.
