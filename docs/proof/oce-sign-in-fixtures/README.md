# OCE sign-in fixture qualification proof

- Status: active host-policy proof
- Owner: ClawSweeper review-input maintainers
- Source: `src/agent-input-scan-fixtures.ts`
- Current baseline: `b6018c7392495e601038e3f08fcf70019156dc86`
- Reverify when fixture bytes, scanner pin, attribution policy, input staging,
  or classifier changes

## Claim and boundary

The policy recognizes two synthetic URL-rejection fixtures in
`tests/integration/sign-in-chart-parity.test.mjs` from
[OCE PR 4876](https://github.com/openclaw/openclaw-enterprise/pull/4876).
Qualification binds URI detector 17, both native raw digests, the complete source
line, source path, regular-file mode, decoder, and complete source hash. Verified
credentials and unknown findings still refuse admission.

The tested base is `288ced18523c897c1752b4338a59f2b9aad7d8ad`; the head is
`3e29a60b00d2a4c6eb15d4ea2f1f283113592f74`. Their fixture blobs are
`d51f4eae74f8a56cb0851482c6175f75c26c067b` and
`708e8b9af0e78f0c4d6a41a7883155f9e08fbe4e`. The unchanged fixture lines shift
from lines 1430–1431 to 1477–1478 after a test insertion.

The original three captures established six fixture/blob/decoder combinations.
A subsequent [hosted scan](https://github.com/openclaw/clawsweeper/actions/runs/42233918446)
refused the previously unobserved PLAIN attribution at head line 1478. A new
local native capture independently reproduced that exact finding. This change
adds only that seventh combination. The other fixture's head/PLAIN combination
remains unobserved and refused. The classifier and patch-witness algorithms are
unchanged.

## Current native capture

The environment was Linux amd64, Node 24.22.1, and the existing TruffleHog 3.99.4
pin. The release archive SHA-256 is
`5ae9b313342d1bfa96404064c0f59e77a2cbd1824d797ca7b11e6655aa8fd9d1`;
the verified executable SHA-256 is
`70b9108715250b19518b03acea56b2f4907a36dcfaaf77693444bdc007a761b1`.
No dependency installation or reconciliation was performed.

The production `scanAgentInput` entry point staged all 47 inputs for the exact
committed range: one controlled prompt, raw diff, binary/full-index patch, and
44 complete source blobs. A transparent subprocess observer preserved these
inputs and returned the native subprocess result unchanged. Both sandboxed and
host runs failed locally: Node's scanner subprocess received SIGKILL immediately,
with no output or spawn error. The same happened with a single ordinary-text
input. A process/signal trace showed successful execution followed by SIGKILL,
without a parent kill syscall. The cause is unresolved; this is **not a passing
`scanAgentInput` execution**.

Two direct Python launches of the same native executable scanned byte-identical
copies of all 47 staged inputs with the production arguments:

```text
<verified scanner> filesystem <private-input-directory> --results=verified,unknown --fail --fail-on-scan-errors --no-update --json --no-color
```

The native environment contained only private `HOME`, `TMPDIR`, `TMP`, and `TEMP`
paths. Verification remained enabled; no DNS, detector, concurrency, or network
policy override was used. Each scan completed in approximately 2.6 seconds with
exit 183 and four unknown URI findings. Capture one reported head line 1478 as
PLAIN; capture two reported it as ESCAPED_UNICODE. Both reported head line 1477
as ESCAPED_UNICODE. The variation is observed; these captures do not establish
its cause.

Keep native stdout, stderr, source bytes, and verification diagnostics private.
The value-free [range results](range-results.json) record native stream hashes,
input identities, all findings, classification results, and refusal controls.

## Replay and result

Build the baseline and candidate with their matching, already installed
workspace dependencies. Each capture directory contains `input/`, `stdout`,
`stderr`, and `receipt.json`. The receipt records the actual `exitCode`,
`binarySha256`, `argv`, `stdoutSha256`, and `stderrSha256`.

```sh
node docs/proof/oce-sign-in-fixtures/replay-range.mjs baseline /baseline/dist/agent-input-scan-fixtures.js /oce-checkout /private/capture-1 /private/capture-2
node docs/proof/oce-sign-in-fixtures/replay-range.mjs candidate dist/agent-input-scan-fixtures.js /oce-checkout /private/capture-1 /private/capture-2
node --experimental-strip-types --test test/agent-input-scan-fixtures.test.ts
```

The replay verifies every staged byte against the exact Git range, including
all blob references, then passes the complete unchanged native streams and all
47 inputs to the real classifier. It requires distinct native streams, exactly
one finding per fixture/blob pair, and head-line-1478 PLAIN and ESCAPED_UNICODE
witnesses in different captures. The baseline refuses capture one with
`source_not_reviewed` and admits capture two. The candidate admits all four
findings from each capture. This proves classification of the complete captured
range, without claiming successful native subprocess execution through the
production caller or a hosted model review.

Eleven negative controls per admitted capture mutate copies only: changed
complete source, invalid scanner line, unknown decoder, verified credential,
changed raw identity, missing verification error, foreign source path,
executable mode, duplicate finding, additional unknown finding, and the other
fixture's unobserved head/PLAIN combination. All remain refused. The complete
source hash check protects changed fixture lines; this does not claim isolated
line-check coverage. Scanner line coordinates are not themselves the literal
witness used for decoded findings.

Malformed decoder and scanner-line fields are rejected before producing public
observations. Harmless-marker controls reproduced their prior disclosure in
baseline mode; the fixed runner exits 1 with no stdout and a fixed diagnostic.
Duplicate captures and captures missing either required decoder are also refused.
The same-report-only variant control remains refused. These controls mutate
copies; neither positive native stream is edited.

The historical [results](results.json) preserve the original six-combination
qualification against `e625d2ea5f08db0291bf5ccf3cb00fc640d7990c`. The original
`replay.mjs` still replays those three captures and their remaining refusal
controls. Its report distinguishes historical observations from the separately
captured seventh combination. CLI failures retain the fixed diagnostic
`Fixture proof failed; private input values withheld.`; the range replay uses
`Range proof failed; private input values withheld.`

Full repository checks and fresh committed-branch review remain publication
gates. Hosted admission still needs a new exact-head/body review after this
policy reaches the hosted runner. No queue hold, reviewed source, or live
deployment was changed by the local proof.
