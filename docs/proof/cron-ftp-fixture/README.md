# Completion-webhook FTP fixture qualification

Status: historical proof for this exact fixture qualification. The policy owner
is `src/agent-input-scan-fixtures.ts`; the native entry point is
`src/agent-input-scan.ts`. The candidate is based on ClawSweeper
`32cd4db41a50b57f301a955bd0e291cbfeb714e1`.

## Claim and exercised surface

The host input gate may classify the existing synthetic warning-redaction fixture
in [OpenClaw PR #161161](https://github.com/openclaw/openclaw/pull/161161) only when
FTP detector 899, the observed PLAIN/HTML decoder, both native value digests, the
complete line for every occurrence, original path, regular-file mode and committed base/head
reference match. Native metadata must retain empty `RawV2`, exactly `key=Raw`
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
native variants therefore need the same exact qualification. The final candidate
[admitted](after.json) the unchanged range in 4.044 seconds, reporting HTML for
both committed blobs. PLAIN was also observed during the native qualification,
including the original refusal. The [native identity receipt](identity.json)
records the independently inspected finding shape without matched values.

The focused regression passes 24 cases in 1.06 seconds wall time. It accepts both
observed variants and rejects changed host, credential, query, complete line,
path, file mode, source role/kind, decoder, detector, verification and native
metadata. Additional occurrences on an unapproved line, incomplete scans,
duplicate findings and FTP patch material also fail. The original policy failed
the positive regression; the additional-occurrence case failed before the
qualification reused the existing whole-blob literal witness check.

## Limits

This is source-admission proof with a controlled prompt. It does not run a model,
complete a hosted review, release its hold or authorize a merge. Hosted review
must rescan its own source, prompt, schema and other inputs. PLAIN/HTML selection
can differ between native scans; neither label permits different fixture bytes.

No queue, status, or publication contract changes are involved.
Requalify if fixture bytes/location, scanner version or the host source-binding
contract changes. No test file or input range is excluded from scanning.
