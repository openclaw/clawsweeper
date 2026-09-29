# Completion-webhook FTP fixture qualification

Status: historical proof for this exact fixture qualification. The policy owner
is `src/agent-input-scan-fixtures.ts`; the native entry point is
`src/agent-input-scan.ts`. The candidate is based on ClawSweeper
`32cd4db41a50b57f301a955bd0e291cbfeb714e1`.

## Claim and exercised surface

The host input gate may classify the existing synthetic warning-redaction fixture
in [OpenClaw PR #161161](https://github.com/openclaw/openclaw/pull/161161) only when
FTP detector 899, the observed PLAIN/HTML decoder, both native value digests, the
complete source-file SHA256, complete line for every occurrence, original path,
regular-file mode and committed base/head reference match. Native metadata must retain empty `RawV2`, exactly `key=Raw`
secret parts, null extra/structured data and an unverified result with a
verification error. The OpenClaw fixture and scanner flags are unchanged.

## Native before/after proof

On macOS arm64 with Node 26.10.0, pnpm 12.4.1 and checksum-qualified TruffleHog
3.97.4, the existing proof entry point scanned the complete committed range with
verification enabled:

```sh
node docs/proof/agent-input-scan-context/run-proof.mjs \
  <clean-openclaw-checkout> \
  28885d3f8745f51e39ecb54389283dc391c15381 \
  226302c6ef7b496ced68f69f917669cd8a18f7ed \
  <receipt.json>
```

The original policy [refused](before.json) the range with an unclassified FTP
finding. An HTML-only qualification also refused an observed PLAIN finding; both
native variants therefore need the same exact qualification. The first candidate
[admitted](after.json) the unchanged range in 4.044 seconds, reporting HTML for
both committed blobs. PLAIN was also observed during the native qualification,
including the original refusal. The [native identity receipt](identity.json)
records the independently inspected finding shape without matched values.

## HTML source binding

The committed-branch review found that a second, HTML-encoded occurrence could
retain the same native authority and evade the plain literal search. The canonical
scanner [reproduced that admission](html-before.json): an HTML-marked synthetic
source retained the approved plain line and an entity-encoded occurrence on a
different line. Its HTML finding was incorrectly attributed to the plain line.

The policy now pins the complete bytes of the two inspected source blobs. It
hashes the actual staged bytes and filters the same attribution rows used for
line, path and mode checks. Any byte change, even unrelated to the fixture, needs
explicit requalification. This deliberately conservative boundary avoids a second
HTML decoder or a new replay policy.

The [source identity receipt](source-pins.json) shows that both original source
blobs remain byte-identical in the refreshed OpenClaw range
`2fc693e33eff44730a0113d33f8f68b1642db0a3..340c1ff4441b3c5e8b573c41c7c319df46ddec81`.
The same native command with these new base/head arguments
[admits that range](source-pins-after.json) in 2.841 seconds. It reports HTML for
both blobs under the production policy. Both observed decoders are covered
deterministically by the classifier tests.

Reconstructed synthetic Git sources have the same complete blob IDs as the
retained failing reproduction. The fixed native gate
[refuses the extra HTML occurrence](html-after.json) in 2.516 seconds and
[refuses the encoded-only control](html-only-after.json) in 2.230 seconds with
`source_not_reviewed`. No scanner or verification flag changed.

The focused regression passes 30 reported cases in 0.57 seconds wall time. It accepts both
observed variants and rejects changed host, credential, query, complete line,
path, file mode, source role/kind, decoder, detector, verification and native
metadata. Additional occurrences on an unapproved line, incomplete scans,
duplicate findings and FTP patch material also fail. It additionally refuses
HTML-encoded extra occurrences, unrelated source-byte changes, missing/malformed
source pins and a line-only replica under the production policy. Its small
algorithm fixtures use the existing custom-attribution argument with frozen
source hashes; the native proof above exercises the actual production pins.
The original policy failed
the positive regression; the additional-occurrence case failed before the
qualification reused the existing whole-blob literal witness check.

## Limits

This is source-admission proof with a controlled prompt. It does not run a model,
complete a hosted review, release its hold or authorize a merge. Hosted review
must rescan its own source, prompt, schema and other inputs. PLAIN/HTML selection
can differ between native scans; neither label permits different fixture bytes.

No queue, status, or publication contract changes are involved.
Requalify if any source-file bytes, fixture location, scanner version or the host source-binding
contract changes. No test file or input range is excluded from scanning.
