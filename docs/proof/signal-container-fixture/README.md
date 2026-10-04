# Signal container rejection fixture qualification

The native input scanner refused the synthetic credential-rejection fixture in
[OpenClaw PR 165129](https://github.com/openclaw/openclaw/pull/165129) before review.
[OpenClaw 162138](https://github.com/openclaw/openclaw/pull/162138) changed its
assertion into a table row without changing the synthetic localhost URI. The
existing host policy still required the old complete source-line hash.

## Contract and scope

Qualify only the exact replacement line at
`extensions/signal/src/client-container.test.ts`, retaining the older assertion
for historical bases. Keep the same URI/raw digests, URI detector, PLAIN/HTML
decoders, regular-file mode, complete-line witness and single-literal occurrence
checks. The new line SHA256 is
`2bb262c7e534fd60ddf4c06843f2246146b89cd0c94f42be9f46045be7132f84`.
No scan inputs are excluded and native verification remains enabled. No queue,
publication, telemetry, or OpenClaw Bay contract changes.

## Native behavior proof

Environment: macOS arm64, Node 24.21.0, pnpm 12.4.1, and the host-managed,
checksum-qualified TruffleHog 3.97.4. The production `scanAgentInput` entry point
scans clean synthetic Git repositories containing the complete Signal file from
OpenClaw base `1e49231d063bad36e4b6b187727d957fbfc7fdfb` and head
`59c1ae69e1c467ee094e11ea4a8f3797336b55e0`. The base blob is
`2a410dbef8f316266a5efe0c0fbd5b808a2a43b4`; the original source bytes and path are
preserved. Synthetic commit IDs differ from OpenClaw's history.

Command for each clean repository and its recorded base/head:

```sh
node docs/proof/agent-input-scan-context/run-proof.mjs \
  <synthetic-checkout> <base> <head> <receipt.json>
```

The baseline policy at ClawSweeper `f7c8c55f33a2a0bd28a09b5999a11f5b85196436`
[refuses](before.json) the exact source with `literal_mismatch`. Adding the single
line witness [admits](after.json) the same source pair. Native negative controls
[refuse an altered source line](changed-line.json) and
[refuse the exact blobs at a different path](foreign-path.json).

The existing Signal classifier regression now covers the historical assertion
and current table row. It failed against the original policy and passes with the
qualification, including PLAIN/HTML admission and changed-line, duplicate-literal,
foreign-path, unapproved-decoder and verified-finding refusals.

## Limits

This proves native source admission for this fixture. It does not run a model,
complete a hosted review, release a review hold, or prove other PR inputs. The
hosted review must rescan its own full source, prompt and schema. Existing legacy
URI policy does not pin unrelated source-file bytes; this change preserves that
contract and adds no general allowance for synthetic URLs. Native decoder
selection can vary without changing the approved source bytes.
