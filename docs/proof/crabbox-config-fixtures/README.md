# Crabbox configuration fixture admission

## Behavior contract

Qualify only six existing synthetic URI fixtures in Crabbox's `internal/providers/all/claim_scope_test.go`, `internal/providers/all/command_routing_test.go`, and `internal/cli/config_test.go`. These exercise legacy scope normalization, command-line credential redaction, and signed-image display redaction. The reviewed values use reserved example hosts and descriptive placeholder userinfo, not operational credentials. Their shape is explanatory context, never a runtime approval rule.

Each host-policy row binds URI detector 17, observed PLAIN decoding, exact Raw and RawV2 digests, all complete source lines in order, the original path, mode `100644`, and every committed base/head reference. The repeated routing fixture has two distinct ordered line witnesses. Keep the classifier, scanner verification, native completion checks, metadata consistency checks, and rejection of unknown findings unchanged.

The source range is [Crabbox PR 2488](https://github.com/openclaw/crabbox/pull/2488), base `4c57142affd408a57ee25260c97c95b83a42a84a` and head `9990dc65a0073522198e7c653f26e2e8f7357f4f`. The fixtures are unchanged across that range; the host policy binds bytes and provenance across revisions, not these commit IDs.

## Native proof

Use the existing source-admission runner with its controlled prompt and checksum-qualified native TruffleHog 3.97.4. It invokes the actual host staging and admission path with normal verification and no model call:

```sh
pnpm run build:node
node docs/proof/marketplace-telemetry-fixtures/run-proof.mjs \
  /path/to/crabbox \
  4c57142affd408a57ee25260c97c95b83a42a84a \
  9990dc65a0073522198e7c653f26e2e8f7357f4f \
  /path/to/proof.json
```

The original policy must refuse the complete range with `literal_not_reviewed`; the candidate must admit it only after a complete native scan. Retain bounded notices and refusal diagnostics without credential-shaped literals. Focused regressions must reject changed literal/line/path/mode/role/decoder, additional occurrences, mixed approved/unapproved references, duplicate exact findings, verified findings, and incomplete scans.

The [2026-09-22 native result](native-results.json) records the original policy refusing 12 emitted findings and the candidate admitting 11 emitted findings across all six qualified identities. Both used normal native verification over the same complete source range on Node 24.21.0/macOS. Emitted unknown-finding subsets can vary; policy approval still requires every emitted finding and every logical source reference to qualify. This is not evidence that the original hosted scan's 11 findings were recovered byte-for-byte.

This is source-admission proof, not a hosted review or clearance of other findings. The hosted workflow still scans its own complete inputs and must publish a current review before the Crabbox changes land. OpenClaw Bay is unaffected: no status, queue, publication, or observer contract changes.
