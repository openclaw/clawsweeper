# Dashboard metric semantics proof

- Status: executable proof; run results are not committed here
- Owner: ClawSweeper maintainers
- Surface: real Astro builds of Throughput, Coverage, Overview and Operations

On a qualified checkout with the dashboard-site dependency install ready:

```sh
node docs/proof/dashboard-metrics/run-proof.mjs 75c614ee432a8c6e9ef7dec0b98ba0a6a15fc32b /tmp/dashboard-metrics-proof
```

The output path must not exist. The proof builds the base and candidate with the
same installed dependencies and controlled snapshots. It verifies raw workflow
conclusions, count reconciliation, timeout failures, coverage uncertainty,
unknown inventory, removal of inferred freshness, and the unchanged Operations
value under its corrected queue-resolution label. Additional builds test
missing, legacy count-only and empty complete inventories, including Overview's
shared coverage display. `result.json` records source hashes and the assertions;
the checked pages are retained under `rendered/` in the output directory.

No dependencies are installed, and no service or production state is changed.
This proves the rendered static pages, not live inventory identity accuracy,
independent review quality or production deployment. The root maintainer runs
the proof on the selected remote environment and retains the receipt only while
the work is unfinished.
