# Historical compatibility-negation rendering proof

Status: historical, superseded by the typed compatibility assessment. Owner:
ClawSweeper review maintainers. Verified historical scope: September 13, 2026.

The former proof addressed a false rejection when a standalone statement that
no schema or migration change was introduced appeared beside affirmative
compatibility evidence. It used selected public prose from
https://github.com/openclaw/openclaw/pull/145577#issuecomment-5643277264 with
synthetic report metadata; it did not replay the unavailable canonical report
or execute a database upgrade.

The English classifier and its grammar-specific fixtures have been retired.
Their [historical implementation and proof](https://github.com/openclaw/clawsweeper/tree/0ecd31af54ad8cc735ac7ed71b4b863db7bd78ab/docs/proof/compatibility-negation)
remain available in Git history. Do not run that driver against current main.

Current reviews use the [typed compatibility contract](../../pr-review-comments.md)
and [compiled decision/report proof](../../../scripts/e2e/data-model-proof.ts).
Only Codex's explicit sufficient assessment clears the stored-data hold. Old
reports without that assessment require a fresh review; there is no prose
fallback or automatic reinterpretation of historical evidence.
