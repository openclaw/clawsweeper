# Workspace-picker fixture qualification proof

Historical controlled evidence for the proposed exact host-policy qualification.

- Owner: `src/agent-input-scan-fixtures.ts` and its existing patch-witness owner.
- Last verified: 2026-11-02, ClawSweeper base `aa20b22bbd865be8a12a97b9e302e4bf61e80760` plus this uncommitted qualification.
- Recheck when the policy, scanner pin, target source bytes, native identities, decoders, or witness contract changes.

## Claim and boundary

Keep native input scanning enabled while classifying only the reviewed synthetic
Enterprise URI rejection fixture at `src/gateway/server-methods/projects-identity.test.ts`,
mode `100644`, with its exact native PLAIN identities, full source line, and
complete source-file digest. The published OpenClaw fixture is unchanged.

The maintained `scanAgentInput` entry point scanned the complete committed range
`afbe0a8e8f2cc7f9e5cc751a5bcc92a1c74abd30..d96b69052ac265fc2a1a980a81a68eab30ecf1ce`
using pinned TruffleHog **3.99.4** with canonical verification enabled. The same
controlled prompt and source were refused before the qualification and admitted
afterward. Both controlled source findings were attributed to the same exact
fixture: its complete blob and its added patch line.

[proof.json](./proof.json) retains sanitized native identities, source bindings, before/after
results, and limits. It contains no raw credential-shaped values or detected lines.

## Reproduction

Prepare the maintained pinned review tools outside the host and target checkouts,
then use the existing proof entry point with a clean, materialized target:

```sh
node docs/proof/agent-input-scan-context/run-proof.mjs   "$TARGET" afbe0a8e8f2cc7f9e5cc751a5bcc92a1c74abd30   d96b69052ac265fc2a1a980a81a68eab30ecf1ce "$OUTPUT"
node --test test/agent-input-scan-workspace-picker.test.ts   test/agent-input-scan-fixtures.test.ts
```

The new regression reconstructs the exact committed file using the existing
policy-test fixture-builder pattern and verifies its digest before admission.
Its sixteen negative controls keep altered inputs refused, including bytes
beyond the native URI prefix. No caller-provided exception, general path/domain
ignore, scanner disablement, or alternate decoder is introduced.

## Limits

This is real native scanning and host classification, not a hosted model review.
The hosted workflow must rescan its actual prompt, schema, and complete source
after the qualification is reviewed and landed. This proposal is not committed,
published, deployed, or authorization to retry a failed review.
