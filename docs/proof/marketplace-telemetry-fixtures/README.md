# Marketplace telemetry fixture admission

## Behavior contract

OpenClaw's marketplace entries test repeats an existing synthetic feed URL in live and snapshot metadata. Qualify only those two ordered complete source lines for URI detector 17, observed PLAIN or HTML decoding, the reviewed raw digests, regular-file mode, and committed base/head roles. Preserve the refresh test's separate legacy approval, including repair roles, duplicate context records, and rejection of introduced fixture lines. Unknown aliases, changed queries/fragments, missing/reordered/extra occurrences, verified findings, and incomplete scans remain rejected.

The unchanged entries fixture was present in both the base and head of [OpenClaw #145975](https://github.com/openclaw/openclaw/pull/145975). Its input scan failed before review. Run the canonical native scanner over that complete source range:

```sh
pnpm run build:node
node docs/proof/marketplace-telemetry-fixtures/run-proof.mjs \
  /path/to/openclaw \
  928dba98c56ae193ecb32140330abd6376d467dd \
  826f30fc2f4582c25f67fdc4957ca84481f096fe \
  /path/to/proof.json
```

The runner records only bounded owner diagnostics and accepted attribution notices, without raw fixture values. The original host policy refuses this range with `source_not_reviewed`; the candidate must admit it through the same pinned native scanner. Boundary tests exercise both source policies, strict witness order, aliases, repair roles and patch handling.

This is source-admission proof with a controlled prompt and no model invocation. It does not certify a hosted review: the hosted workflow must scan its own complete inputs and publish a current review before landing. OpenClaw Bay is unaffected; no status, queue, publication or observer contract changes.
