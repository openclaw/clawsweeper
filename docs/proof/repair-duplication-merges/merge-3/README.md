# Error-fingerprint wire-format equivalence proof

This proof extracts `failureFingerprint` and `errorFingerprint` from their two
`origin/main` callers, evaluates representative `Error` and string inputs, and
compares them with the new shared digest primitive and its two named wrappers.

Run after `pnpm run build:repair`:

```sh
node docs/proof/repair-duplication-merges/merge-3/run-proof.mjs
```

The checked-in result is in `artifacts/equivalence.json`. It pins the bare
64-character hex batch format separately from the `sha256:`-prefixed event
format. The proof is deterministic and performs no network or production I/O.
