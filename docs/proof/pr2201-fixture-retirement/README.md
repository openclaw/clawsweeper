# Scanner fixture retirement qualification

Historical proof for the prerequisite to
https://github.com/openclaw/clawsweeper/pull/2201. ClawSweeper maintainers own this
evidence. The owning policy is `src/agent-input-scan-fixtures.ts`; the PR body
records the executed revision and receipts. Rerun when the qualified source
bytes, native scanner pin, or source/patch qualification changes.

The existing deployed scanner refuses removals of its own synthetic fixtures
because they only had legacy context qualification. The added attribution rows
bind native value pairs, observed decoders, complete ordered source lines, paths,
regular modes, and complete source hashes. No scanner switch or global hostname
approval changes.

After building, run with the pinned TruffleHog on PATH and a local checkout of
the PR containing its pinned base and candidate:

```sh
node docs/proof/pr2201-fixture-retirement/run-proof.mjs \
  /path/to/pr-checkout 8ba1ab445ed086863bbd9749237cfcb7096bae7a \
  1ccf77313d8b0736a8ea8340b93dc16be218fe65 /tmp/fixture-retirement-proof.json
```

The proof uses production `scanAgentInput` and real native scans. It admits the
complete PR range and the exact original fixture, then refuses an unrelated
source edit, a changed credential, and a different path. No model is called and
all credential-shaped input comes from the already reviewed synthetic fixture.
