# Custom-endpoint input-scan qualification proof

Owner: review input scanning, `src/agent-input-scan-fixtures.ts`.
Last verified: 2026-11-05 against main `350cd4e3723f59a8a02ff89e9b7bd37568af1d8b` plus the candidate exact attribution rows.
Reverify when the source line, scanner pin, attribution policy, patch witness resolver,
input staging, or target heads change.

## Claim and controlled surface

The existing classifier admits only the reviewed synthetic custom-endpoint URI,
bound to detector 17/URI, native Raw and full RawV2 hashes, complete source-line
hash, exact regular-file path, and the observed PLAIN/HTML native decoders.
Only exact attribution rows and their policy-schema source registration change;
the classifier and patch-witness algorithms are unchanged. No target regression
is modified or encoded.
The checked-in contract test contains hashes only; it is intentionally not a
second copy of a credential-shaped literal.

The original public input is blob `391a45d1d6ea176b2d9771346e39ab39a9ba4f2b`
at line 176 of [the first target head](https://github.com/openclaw/openclaw/blob/7775311d986006137b78be0e46021a348fe60678/src/gateway/server-methods/config-custom-endpoint.test.ts).
The stacked head has blob `29bbe924be29281295c8c52d114818341de75d22`,
with the identical complete line at line 218:
[stacked target head](https://github.com/openclaw/openclaw/blob/8dffd5433994f16ce94f114297080fb863e5f4c4/src/gateway/server-methods/config-custom-endpoint.test.ts).
Both blobs are verified by Git object identity before replay.

## Replay

Use Linux, Node 24+, Git, the built candidate, and TruffleHog 3.99.4. The Linux
amd64 release archive SHA-256 must be
`5ae9b313342d1bfa96404064c0f59e77a2cbd1824d797ca7b11e6655aa8fd9d1`
(the existing pin in `src/review-tool-bootstrap.ts`).
Place the verified executable at `.openclaw/tmp/fixture-proof/trufflehog`.
Fetch the two immutable public source blobs into the same directory as
`custom-endpoint.test.ts` and `stacked-custom-endpoint.test.ts` respectively.
Do not print the native scanner output or credential-shaped values.

```sh
pnpm run build:all
node docs/proof/custom-endpoint-fixture/replay.mjs
node --experimental-strip-types --test test/agent-input-scan-fixtures.test.ts test/agent-input-scan.test.ts test/dashboard-worker-scanner-hold.test.ts
```

`FIXTURE_PROOF_INPUT_DIR` may select a different private scratch directory.
The script constructs isolated Git histories, captures full-index patches and raw
creation/absence proof, scans the exact blobs and patch, and invokes the real
`classifyReviewedFixtureScan` guard. It preserves native output only in scratch;
`scenarios-result.json` is value-free. Scratch replay commits credit the requester;
their temporary revision IDs are replay identities, not target PR history.

## Observed result and negative controls

The base policy refuses both scenarios with `literal_not_reviewed`. The candidate
classifies both actual native findings in each scenario: first-PR head blob plus
added patch, and stacked-PR base/head blobs. Every native finding hashes to the
same independently inspected synthetic URI. Native deduplication can choose
PLAIN or HTML for those exact bytes; both were observed, not guessed.

Twelve controls per scenario remain refused: different full URI path, changed
dummy password, changed host, different pathless Raw identity, BASE64,
ESCAPED_UNICODE, verified material, different source path, edited complete source
line, nonfixture material, executable mode, and a differing second finding.
See `before.json` and `after.json` for sanitized observed evidence.

Limits: this is a controlled real native-scanner/guard replay, not a full target
repository scan, hosted queue admission, hold release, or deployment proof.
The exact first-PR creation and stacked base/head material are exercised in
synthetic Git histories; the original PRs and security regression stay unchanged.
The parent task owns fresh target review requests only after merged policy is
actually available to the hosted runner. No workflow, hold, label, or queue is
mutated by this proof.
