# Gitcrawl store resolver equivalence proof

This proof extracts both repair-side resolver copies from `origin/main`, runs
representative repository normalization, explicit override, environment
override, portable-store priority, and legacy-fallback scenarios through both
old copies and the new shared resolver, and requires identical path outputs.

Run after `pnpm run build:repair`:

```sh
node docs/proof/repair-duplication-merges/merge-2/run-proof.mjs
```

The checked-in result is in `artifacts/equivalence.json`. The harness also
records that the callers retain their intentionally different `sqliteJson`
buffer limits. It uses virtual file-existence probes and performs no database,
network, GitHub, or production mutation.
