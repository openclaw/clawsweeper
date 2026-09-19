# Gateway readiness privacy-fixture qualification

Status: historical proof for this exact fixture qualification. The policy owner is

`src/agent-input-scan-fixtures.ts`; the native entry point is
`src/agent-input-scan.ts`. Verified against ClawSweeper base
`4246312566ffd0832ed892857ccd10952e8034ca` with the candidate tuple addition.

## Claim and exercised surface

The existing host input gate may classify the explicitly approved synthetic URI
from [OpenClaw PR #152309](https://github.com/openclaw/openclaw/pull/152309) only when the native detector identity, decoder, both raw
value digests, complete source line, original path, regular-file mode, and committed
base/head references match. No scanner option, reviewed input, or other policy is
relaxed. The original OpenClaw fixture is unchanged.

## Native before/after proof

Target range:

- Base: `26c2f997d81b0745d0819ba803c185fde247b72d`
- Head: `876b4c34f16b46bb4cbff8569d6cb2ba39ee0e59`
- Source: [OpenClaw readiness test](https://github.com/openclaw/openclaw/blob/876b4c34f16b46bb4cbff8569d6cb2ba39ee0e59/test/helpers/openclaw-test-instance.test.ts#L2002)
- Source blob: `fb56a237c6d8f1f9a59cdb89072838e5ede881fe`

On Linux with Node 26.8.2, the repository's checksum-qualified native TruffleHog
3.97.4 and existing scanner owner ran with verification enabled:

```sh
node docs/proof/agent-input-scan-context/run-proof.mjs \
  <clean-openclaw-checkout> <base-sha> <head-sha> <receipt.json>
```

The unmodified policy refused the complete committed input set with two unknown
URI findings ([before](before.json)). The qualified policy admitted that same
range in all three repetitions ([first](after-1.json), [second](after-2.json),
[third](after-3.json)), retaining the exact source and introduced-patch witnesses.
Independent native scans of the unchanged source blob observed both PLAIN and
HTML variants with identical value and source-line identities; the retained
[source-only identity receipt](identities.json) records the PLAIN observation.

Thirty focused classifier tests pass, including twelve new regression cases for
this fixture. Positive controls cover Git-generated additions, removals and
unchanged context. Negative controls reject changed literals, complete lines,
paths, modes, uncommitted roles, verified findings, unsupported decoders, changes
to the surrounding synthetic-payload expression, and extra occurrences.

## Limits and update triggers

These scans use the complete canonical committed range and a controlled prompt;
they do not run a model or attest a hosted review. The historical hosted refusal
reported a PLAIN finding and a total of two findings, but did not preserve the
second finding's details; this proof does not reconstruct that old wire. A fresh
hosted review must scan its own complete source, prompt, schema, and other inputs.

No OpenClaw Bay, queue, status, or publication schema changes are involved. Re-run
this proof when the exact source line/value/path, scanner version, source-binding
contract, or host classification owner changes. Do not broaden the entry to make
a changed fixture pass.

## Generated-context follow-up

The original qualification fixed committed source and patch findings. Hosted run
[35420006300](https://github.com/openclaw/clawsweeper/actions/runs/35420006300)
then reported four findings, with the first remaining refusal in generated
`prompt` material. That manifest did not preserve raw matched values.

A controlled reproduction uses the production introduction-evidence builder
and context serializer, not a hand-written imitation of their output:
`buildPullRequestReviewEvidence` → `serializeReviewContext` → `scanAgentInput`.
It exercises OpenClaw base `233e1a2f102da0c9fa882b01dade8be89c915841` and
head `27913cfe9700b554a3d00dd72b877b7b299ce892`, retaining the unchanged source
and full patch in the canonical scan. The old serializer fails at prompt material
([before](context-before.json)); the source fixture includes a template expression,
so the old whole-URI reference matcher cannot safely treat it as a complete URI.

The repair derives one exact-line context reference from the already approved
attribution rows. It does not add or relax native classifications. Three runs
admit the serialized evidence while retaining two source/patch notices each
([first](context-after-1.json), [second](context-after-2.json),
[third](context-after-3.json)). The receipts bind the producer's source and compiled
SHA-256 values. Node 26.8.2 and checksum-qualified native TruffleHog 3.97.4 were used
with verification enabled.

Native negative controls still refuse prompt material when the serializer is
not used ([raw](context-raw.json)), when the quoted source expression changes
([drifted](context-drifted.json)), or when the raw line is appended as a maintainer
request after serialization ([maintainer](context-maintainer.json)). Ten additional
unit cases cover bare/added/removed/context-line prefixes, nested serialization,
input preservation, and changed or unbound text.

This controlled evidence is not a reconstruction of the entire hosted prompt or
its four finding records, and does not claim model execution or hosted publication.
A new hosted review remains the final integration check. Changes to the full
source-line witness, context producer, or scanner contract require fresh proof;
never admit prompt findings merely because they resemble a test fixture.
