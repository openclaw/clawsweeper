# Controlled finding-inventory proof

- Status: historical controlled proof, not deployment evidence
- Owner: ClawSweeper contributors/maintainers
- Source: `scripts/proof-input-scan-inventory-native.mjs`, `scripts/proof-input-scan-inventory.ts`, `src/agent-input-scan-fixtures.ts`, `src/clawsweeper-review-failure-diagnostics.ts`, `scripts/inspect-input-scan-diagnostic.mjs`
- Baseline: `51e006973ca9bb79dea2b0d874fa57db6bcdc4fa`
- Observed: synthetic protocol 2026-11-06; real native/shipped entry 2026-11-07;
  Node 26.11.1, pnpm 12.15.0, macOS arm64 local process
- Update trigger: changes to inventory fields/bounds, refusal emission, or inspector projection

## Real native scanner through the shipped entry

The [native driver](../../../scripts/proof-input-scan-inventory-native.mjs)
executes `dist/clawsweeper.js review --local-only` as a child process, not a runner
or manifest-writer test hook. It stages a disposable committed Git fixture with
two invalid URI-detector canaries, then uses the **real unmodified TruffleHog
3.99.4 executable**. It also runs twelve canaries to exercise truncation. There
is no fake scanner, scanner wrapper, injected scanner output, detector override,
qualification or verification-disable flag. Only GitHub's read transport is
synthetic; a fail-closed `gh` executable supplies controlled item metadata, all
Git fetches use a local remote, and no GitHub event is dispatched. The configured
repository/item and Actions-style run selectors are synthetic protocol identities,
not observations of a live item or run.

A per-process macOS `sandbox-exec` profile denies **all network operations** to
the CLI and descendants, including native verification. A bind probe must fail
with `EPERM` before the proof starts. The environment has a fresh HOME/TMPDIR and
no inherited credentials. The production scanner arguments remain unchanged
(`--results=verified,unknown --fail --fail-on-scan-errors --no-update --json --no-color`).
The canaries are deliberately invalid, confined to `.invalid` domains. Their
raw values, private logs and generated Git objects are not public evidence.

### Verified scanner prerequisite

The task-local executable came from the
[official 3.99.4 release](https://github.com/trufflesecurity/trufflehog/releases/tag/v3.99.4).
The archive digest agrees with both the repository's bootstrap pin and the
official checksum file/GitHub release asset digest. The executable's digest is
measured after extraction (it is not the archive digest). No separate signature
verification is claimed, and no global installation or service change is needed.

| Artifact | SHA-256 |
| --- | --- |
| `trufflehog_3.99.4_darwin_arm64.tar.gz` | `dc942daecb4a7795fd0a7421c66281bd4cc2ba29a265f3f6c63ecb684a6db291` |
| Official checksums file | `67b85d137801f397a9b0a1c85d0c9768ff43ee9f7c0f17f465542601decc5cd0` |
| Executed `trufflehog` (`--version`: `trufflehog 3.99.4`) | `e05963636bce6c5a48e0c780b26c98eb851ec8f87ab6efce8167753a9141b893` |

### Reproduce and inspect

On macOS arm64 with Node 24+, first independently verify/extract the pinned
release into a private task directory. Build this source and a private archive
export of baseline `51e006973ca9bb79dea2b0d874fa57db6bcdc4fa` using the repository's
normal locked dependencies. Pass their absolute paths and a fresh nonexistent
private output directory per invocation; the driver retains private evidence
rather than deleting it. The default requires an inventory; the explicit `legacy`
selector requires its absence on the pinned baseline. `PROOF_ROOT` is a caller-owned private directory,
not a new installed runtime. The driver has no dependency on test-only helpers.

```sh
pnpm run build
node scripts/proof-input-scan-inventory-native.mjs "$PWD" "$SCANNER" "$PROOF_ROOT/after-two" 2
node scripts/proof-input-scan-inventory-native.mjs "$BASELINE_SOURCE" "$SCANNER" "$PROOF_ROOT/before-two" 2 legacy
node scripts/proof-input-scan-inventory-native.mjs "$PWD" "$SCANNER" "$PROOF_ROOT/after-many" 12
```

Internally the real shipped entry executes this form under the network-denied
profile, with all paths pointing into the disposable proof environment:

```sh
node dist/clawsweeper.js review --local-only --verbose \
  --target-repo openclaw/clawsweeper --target-dir "$TARGET" --item-number 1 \
  --artifact-dir "$ARTIFACTS" --output-retention debug --codex-timeout-ms 60000
```

Its actual failure path emits `failure-diagnostics/manifest.json`. The driver
then invokes the **shipped CLI inspector**, twice, with independent known fixture
head/item and synthetic run selectors. Both reads must succeed with identical
output, unchanged manifest bytes and no provider-sentinel calls:

```sh
node scripts/inspect-input-scan-diagnostic.mjs --inspect \
  "$ARTIFACTS/failure-diagnostics/manifest.json" openclaw/clawsweeper pull_request 1 \
  "$FIXTURE_HEAD" example/diagnostic-proof 1 1
```

### Observed native results

The before/after two-canary Git fixture is byte-identical, with base
`c6b5339c52e53a4cd8f692aac5a9a896b60f62ef` and head
`3e3d424301302a70c6cd6ae1116869de4bb9ef54`. Both source versions exit **79**, report
`unclassified_finding` (URI detector 17, PLAIN, verified=false), and invoke the
provider sentinel **zero times**. Native detection finds the two blobs and two
patch occurrences: four findings, not four distinct credentials.

| Shipped runtime | Findings | Inventory retained / omitted / unattributed | Inspection | Provider calls |
| --- | --- | --- | --- | --- |
| Pinned baseline | 4 | no inventory; first finding only | two inert successful CLI reads | 0 |
| Candidate | 4 | 4 / 0 / 0 | two inert successful CLI reads | 0 |
| Candidate, twelve canaries | 24 | bounded sample, positive omission, 0 unattributed | two inert successful CLI reads | 0 |

The candidate preserves its authoritative first refusal index 0, validates
`retained + omitted = total`, retains at most 16 entries and at most 6144 formatted
bytes, and marks every retained source attribution `unavailable`. A measured
24-finding run retained 8, omitted 16, and used 6130 formatted bytes; a repeat
retained 8 and used 6129 bytes. Native concurrency may change finding order,
first-refusal material/reason and the exact sample/byte size across fresh scans.
Deterministic inventory bounds/count accounting for a given scanner result and
inert replay of a fixed manifest are asserted; native scan byte-for-byte
repeatability is **not** claimed. Safe per-run aggregate hashes are emitted in
`summary.json`; raw scanner matches are never printed by the driver.

This is local shipped-entry/native behavior proof, not hosted queue, publication,
access-control, real-provider, source-coordinate, fixture-qualification or
deployment proof. It does not resolve the separate upstream maintainer decision
on the additive diagnostic format. Supporting unit tests remain necessary for
malformed/decoded/ambiguous metadata and a nonzero first-refusal index.

## Earlier synthetic claim and exercised surface

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
GIT_DEFAULT_HASH=sha256 node scripts/proof-input-scan-inventory.ts
```

The after proof was repeated with SHA-1 and SHA-256 disposable Git repositories;
the synthetic scanner accepts both supported object-name lengths.

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

The earlier synthetic proof in this section is **not a real TruffleHog reproduction**,
detector false-positive finding,
fixture qualification, security adjudication, hosted queue/publication test,
access-control rollout or deployment proof. The controlled scanner intentionally
does not detect the canaries: they are protocol data, not credentials. Scanner
completion and trust policy, provider behavior, artifact access/visibility,
publication and refusal/retry rules are unchanged. No raw scanner output, matches,
source excerpts, credentials or environment content are diagnostic fields.

Related discovery work: https://github.com/openclaw/clawsweeper/issues/2057 and
https://github.com/openclaw/clawsweeper/pull/2058. Decoded source binding remains
separate: https://github.com/openclaw/clawsweeper/issues/1724.
