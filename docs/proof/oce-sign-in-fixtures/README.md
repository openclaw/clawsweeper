# OCE sign-in fixture qualification proof

- Status: proposed host-policy qualification with completed local proof
- Owner: ClawSweeper review-input maintainers
- Source: `src/agent-input-scan-fixtures.ts`
- Baseline: `e625d2ea5f08db0291bf5ccf3cb00fc640d7990c`
- Reverify when the fixture bytes, scanner pin, attribution policy, input staging,
  or classifier changes

## Claim and surface

The candidate classifies only two synthetic URL-rejection fixtures in the two
inspected versions of OpenClaw Enterprise's
`tests/integration/sign-in-chart-parity.test.mjs`. Four exact attribution records
bind URI detector 17, both native raw digests, each complete source line, the
source path, regular-file mode, and the observed decoder/blob combinations. PLAIN
is qualified only for the base blob; ESCAPED_UNICODE is qualified for both
complete-source hashes. The classifier and patch-witness algorithms are unchanged.
No reviewed source, workflow, queue hold, or hosted policy was modified for this proof.

The target is [OCE PR 4876](https://github.com/openclaw/openclaw-enterprise/pull/4876).
Its tested base is `288ced18523c897c1752b4338a59f2b9aad7d8ad` and head is
`3e29a60b00d2a4c6eb15d4ea2f1f283113592f74`. The source blobs are
`d51f4eae74f8a56cb0851482c6175f75c26c067b` and
`708e8b9af0e78f0c4d6a41a7883155f9e08fbe4e`. The same complete fixture lines appear
in each; the head's unrelated test insertion shifts their line numbers.

## Capture and replay

Use Linux amd64, Node 24+, the built classifier, and the existing TruffleHog
3.99.4 pin. Its release archive SHA-256 is
`5ae9b313342d1bfa96404064c0f59e77a2cbd1824d797ca7b11e6655aa8fd9d1`; the verified
executable SHA-256 is
`70b9108715250b19518b03acea56b2f4907a36dcfaaf77693444bdc007a761b1`.
Stage each exact Git blob in a private directory under its object ID and verify
both object identity and complete-source SHA-256. Run with a fresh private HOME
and temporary directory, without ambient credentials:

```text
<verified scanner> filesystem <exact-blob-directory> --results=verified,unknown --fail --fail-on-scan-errors --no-update --json --no-color
```

Preserve stdout and stderr verbatim as `native.stdout.jsonl` and
`native.stderr.jsonl`. Record the actual `exitCode`, `binarySha256`, and complete
`argv` in `receipt.json` beside them. Protect these files: native output contains
credential-shaped test values and verification diagnostics. Do not publish them.

This local capture used the existing resolver, which could not resolve the
fixture host. No DNS override, detector override, or network-policy change was
used. Verification remained enabled. Three bounded captures all returned 183
with four unknown URI findings and completed native logs. Both decoder variants
were observed for each fixture in the base blob. The head blob emitted only
ESCAPED_UNICODE. The policy admits exactly these six observed fixture/blob/decoder
combinations. It refuses both unobserved head/PLAIN combinations, even though the
complete fixture lines are identical. No HTML or BASE64 variant was observed.
The value-free qualification matrix in [results](results.json) records all eight
combinations, their actual counts and which six are qualified.

Replay against the unchanged baseline build, then the candidate build:

```sh
pnpm --dir /baseline-checkout run build:all
pnpm run build:all
node docs/proof/oce-sign-in-fixtures/replay.mjs baseline /baseline-checkout/dist/agent-input-scan-fixtures.js /private/capture-1 /private/capture-2 /private/capture-3
node docs/proof/oce-sign-in-fixtures/replay.mjs candidate dist/agent-input-scan-fixtures.js /private/capture-1 /private/capture-2 /private/capture-3
node --experimental-strip-types --test test/agent-input-scan-fixtures.test.ts
```

Check out the pinned baseline in `/baseline-checkout`; the current checkout
contains the candidate. Each replay records its compiled classifier hash. Keep
outputs outside the source tree until their hashes and metadata have been reviewed for publication. No new scan
or network request occurs during replay.

## Results and limits

The baseline refuses all three unmodified captures with `literal_not_reviewed`.
The candidate classifies all three, accounting for all four findings each time.
Replay rejects duplicate native stream identities, requires both observed
decoders per fixture and checks the complete observed count matrix. An
ESCAPED_UNICODE-only capture fails the coverage check; repeating it fails the
duplicate-capture check. Neither can substantiate PLAIN qualification. To reproduce
these refusal checks, run the candidate command above with only
`/private/capture-1`, then with `/private/capture-1` supplied three times. Each
must exit unsuccessfully without producing a positive proof summary.
For each capture, 23 negative controls mutate copies and remain refused: changed
URI or raw identity, complete blob or line, foreign path or additional reference,
executable mode, worktree role, absent source, unobserved decoder, either
head/PLAIN combination, verified credential, missing verification error, mismatched parts, structured data,
duplicate or extra findings, missing completion, detector failure, wrong counts,
and wrong exit status. The edited-line control first hits the complete-source
hash check; it proves refusal, not independent isolation of the line check.
Positive proof never rewrites native output.

The replay command withholds input values on failure, including receipt parsing,
argument validation, source reads and classifier loading. These input failures exit 1
with no stdout and only `Fixture proof failed; private input values withheld.` on
stderr. Nine synthetic CLI controls cover malformed receipts and native streams,
unexpected receipt fields and flags, and missing input or classifier paths.
Seven exposed the synthetic marker before the boundary was added; all nine now
return the fixed diagnostic without the marker. The successful baseline and
candidate outputs remain byte-for-byte unchanged.

The local replay uses the repository's pinned TypeScript 7.0.2 build on Node
24.22.1 with the existing matching dependency graph. The compact [results](results.json)
bind policy, script, native streams and source inputs without publishing raw
values. The focused classifier suite and fast checks are recorded there. Full
repository verification and the final committed-branch review remain required
before publication; earlier check results do not qualify this revision.

This covers the exact source blobs and classifier; it is not a complete hosted
target-input scan, patch-admission result, model review, policy deployment, or
queue-hold release. After maintainer approval and policy availability on the
hosted runner, the target still needs a fresh exact-head/body review through the
normal command route. An offline `--no-verification` observation is not a
substitute for the native captures used here.
