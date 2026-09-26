# acpx autoreview old-base fixture qualification

Lifecycle: focused classifier proof and native source-admission comparison complete; owner review and landing pending.

## Behavior contract

Qualify three exact URI detector 17 / PLAIN attribution variants from
[acpx PR 806](https://github.com/openclaw/acpx/pull/806), solely at
`.agents/skills/autoreview/tests/test_autoreview_hardening.py`, mode `100644`.
The host policy retains both native value digests and every complete line
witness in occurrence order. Existing rows stay intact; the classifier,
staging, native verification, completion checks, and source-provenance gates
are unchanged.

The committed consumer range is base
`a7410abdf67dda4aa06db6b92bf57e007e67459e` to head
`6151f4f4d0fd9d4d63590b6ceb95d309e5752266`. The implicated base blob is
`8ed5acee1791b128c7d7a69132afd83fa0533ed4`; the head blob is
`c1de717504d47d854f5abd189bf61be98242d0f6`. These pins identify the proof
inputs, not extra runtime approval rules. ClawSweeper baseline is
`9fb3a5d5887891c08e0310cafc54b09ab3023c2a`, which lacks all three variants.

Two variants add the ordered base-line witnesses at 3064 and 3075 for the
existing full-port proxy URI and its shorter native prefix. The second line
uses a fixed `HTTPS_PROXY` string under a reserved invalid TLD in a rejection
test. Its environment patch uses `clear=False`, so only that matched string
is classified as static fixture data; no whole-test hermeticity is claimed.
The third variant binds base line 2898: a fixed reserved-host `SERVICE_URL`
string that `safe_test_env` is expected to exclude. That URI is independent of
the test's separate temporary credential fixtures and saved ambient state.

Focused classifier regressions exercise real Git-generated removed patch lines
and committed base blobs, including both overlapping proxy identities. They
must refuse unapproved literal, line, path, mode, role, decoder, occurrence,
reference, verification, duplicate-record, and incomplete-scan variants.
Existing approved witness sets remain valid: in particular, the full-port
proxy's original one-line set is still approved, so reducing the new two-line
set to that existing set is not a negative control.

Classifier-only support on macOS with Node 24.21.0: all nine new positive
attribution cases refuse on the baseline. After adding only the three policy
rows, `node --test test/agent-input-scan-fixtures.test.ts` passes all 295 cases,
including 68 new cases. This uses synthetic scanner records and is not native
source-admission proof.

## Native source-admission proof

The task owner executed the existing real staging/scan runner locally on macOS
with Node 26.9.0, native TruffleHog 3.97.4, normal verification, and no model call:

```sh
pnpm run build:node
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/clean-disposable-acpx-at-head \
  a7410abdf67dda4aa06db6b92bf57e007e67459e \
  6151f4f4d0fd9d4d63590b6ceb95d309e5752266 \
  /path/to/native-admission.json
```

Run the same complete range against the baseline and candidate host policy.
The baseline should retain its refusal. Candidate admission requires a complete
native scan with every emitted finding and source reference qualified; a new
unqualified finding must remain a refusal. Retain sanitized result receipts,
policy and consumer identities, runtime/provider/image/lease identity, scanner
version and binary checksum/provenance, command, prompt/schema hashes, resolved
merge base, canonical generated patch hash, source-manifest identities, and
stated limits. The runner does not retain the complete native manifest or all
Raw/RawV2 digests; record any needed sanitized identity evidence separately.
Its trusted-PATH scanner path is checked by version, while managed bootstrap
checks archive checksums; retain the actual binary provenance. The output
directory must already exist. The native scanner ran with normal verification. No model execution or
hosted retry was part of this proof.

The prior network-denied, no-verification inventory informed the exact tuple
review. It is not a replay of the ten findings from hosted run
[36192271913](https://github.com/openclaw/clawsweeper/actions/runs/36192271913).
The first retained hosted coordinate maps to base line 3075, where both proxy
identities overlap; its unique Raw/RawV2 identity and the other nine hosted
identities remain unknown. Native findings may vary, so a missing finding is
not negative proof.

The controlled prompt used by this runner proves only source admission. Hosted
review must scan its own current complete prompt, schema, and source inputs;
this draft does not authorize a hosted retry or establish hosted admission.
OpenClaw Bay is unaffected: no queue, status, API, publication, dashboard, or
observer contract changes.

## Observed comparison and limits

[native-results.json](native-results.json) records baseline refusal on an
unclassified URI-17/PLAIN finding at patch line 23455, with 11 findings reported.
The candidate admitted its complete committed range after classifying six
emitted notices covering four source tuples. The new base SERVICE_URL tuple
appears at source line 2898 and through its removed patch line. Neither new
old-base proxy witness variant was emitted in the candidate run; focused
classifier cases supply separate exact-record coverage within the 295-test
file, including 68 new cases for this qualification. No absence
is treated as a cleared finding.

Both runs completed with native waits and output EOFs, without an outer timeout
or forced cleanup; their known target groups were absent and staging temporary
directories were empty. The operator asserted unchanged recorded source,
runtime, target and tool hashes and a clean unchanged consumer checkout.
Per-file post-run hash arrays and the full native staging manifest were not
retained, so independent assessments preserve that reconstruction limit.
The scanner was the existing trusted-PATH binary, selected by version and
recorded by SHA-256; the managed archive-checksum bootstrap was not used.

The offline 17, original hosted 10, native baseline 11 and native candidate 6 counts
remain distinct. These are successful narrow native observations, not a
byte-identical hosted replay, approval of absent findings, or a hosted review.
