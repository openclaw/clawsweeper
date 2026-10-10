# Changelog fragments proof

[openclaw/clawsweeper#1719](https://github.com/openclaw/clawsweeper/pull/1719)
hit four `CHANGELOG.md`-only conflicts in one day because every ClawSweeper PR
inserted its entry at the top of `## 0.3.1 - Unreleased`. Each resolution moved
the PR head and forced a fresh full review.

## Contract

- **Claim:** with one-bullet `changelog.d/` fragments, two concurrent PRs that
  both add a changelog entry merge without conflict; `pnpm run changelog:stitch`
  folds pending fragments into the real Unreleased section deterministically
  and idempotently; `pnpm run check:changelog`, part of `check:static`, rejects
  a malformed fragment and a fragment that re-adds a released entry.
- **Surface:** `scripts/changelog-stitch.mjs` (stitch and `--check` modes), the
  `changelog:stitch` and `check:changelog` package scripts, and the
  `check:static` gate.
- **Scenario:** [`run-proof.mjs`](run-proof.mjs) exports one revision with
  `git archive` and uses that revision's own mechanism and real `CHANGELOG.md`:
  (A) synthetic PR A and PR B each add an entry, PR B lands, PR A merges `main`;
  (B) three synthetic fragments plus any pending repository fragment are
  stitched, the stitch is rerun, and a second copy with reversed fragment
  creation order is stitched and compared byte for byte; (C)
  `pnpm run check:changelog` runs on the clean tree, then with a two-line
  fragment and a fragment holding the newest released entry.
- **Command and environment:**
  `node docs/proof/changelog-fragments/run-proof.mjs --rev <sha> --out <file>`
  on macOS arm64, Node v24.21.0, Git 2.54.0, pnpm 12.4.1. Synthetic Git
  repositories run with `GIT_CONFIG_GLOBAL=/dev/null`, a fixed identity, and
  fixed dates, so reruns produce byte-identical receipts.
- **Limits:** local temporary trees only; no GitHub, workflow, queue, or review
  path runs. The release-time heading rename stays manual. The stitch orders a
  batch by file name, not merge time.

## Result

| Check                                       | Before `65f9c3a305` (origin/main)  | After `c2b98a820d`                   |
| ------------------------------------------- | ---------------------------------- | ------------------------------------ |
| A. PR A merges `main` after PR B lands      | conflict in `CHANGELOG.md`         | clean merge; merged tree check passes |
| B. Stitch three fragments into CHANGELOG.md | script missing (exit 1)            | exit 0; only the Unreleased top grows |
| B. Second stitch run                        | n/a                                | "No changelog fragments" and same bytes |
| B. Reversed fragment creation order         | n/a                                | byte-identical `CHANGELOG.md`         |
| C. `check:static` runs `check:changelog`    | no                                 | yes                                  |
| C. Malformed and stale fragments            | no validator (`ERR_PNPM_NO_SCRIPT`) | exit 1 naming both fragments          |

Receipts:

- [`receipt-before.json`](receipt-before.json), revision
  `65f9c3a3057621385b6c4f52640a2ce190c18c57`, SHA-256
  `c47ba9b0ffbf5bb1e4b375c59621d08ddfee656ba126f9c1c03b17ead8a12d7a`
- [`receipt-after.json`](receipt-after.json), revision
  `c2b98a820d51fe2e557755ef6b05c18e9378f4d7`, SHA-256
  `1286e7dffd4f885d98f8f144c71b66c6729de3d3e276c3eb12393820abe6cd37`

The after revision is the implementation commit; the commit that adds this
directory changes only `docs/proof/changelog-fragments/`. Temporary roots are
normalized to `<tmp>`; the receipts hold no local absolute paths or secrets.

## Merge-only review carry-forward diagnostic

Each receipt also records `diagnostic_merge_only_carry_forward`, which does not
depend on the revision. It tests the proposed carry-forward preconditions (PR
diff `git patch-id --stable` unchanged and no PR file changed between the old
and new merge bases) on two synthetic merge-only heads. After a `CHANGELOG.md`
conflict resolved by keeping both entries, the patch ID changes and
`CHANGELOG.md` changed on both sides, so the preconditions fail. A merge of an
unrelated base change satisfies them. Carry-forward therefore would not have
saved the #1719 reviews; removing the shared insertion point does. It was not
implemented because it conflicts with the exact-head review policy; see the
pull request body for the policy analysis.

OpenClaw Bay is unaffected: no observer data, routes, or controls change.
