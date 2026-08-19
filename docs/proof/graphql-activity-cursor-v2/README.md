# GraphQL PR activity cursor v2 proof

- Status: historical proof artifact
- Owner: ClawSweeper publication maintainers
- Tested source: `openclaw/clawsweeper@221ba1c2cd159dfbc7c2e5a5fb12dbad73467bd7`
- Update when: the v2 query, decoder, fallback, stability wrapper, or batch bound changes

## Claim and exercised surface

The controlled loopback scenario exercises the production cursor/query decoder
through `createGitHubContext`: one stable v1 check performs reviews REST, inline
review-comments REST, and GraphQL review-thread reads twice; v2 replaces those
six requests with two complete GraphQL snapshots. The batch scenario aliases
eight PRs and preserves the same two-read invariant while reducing 48 requests
to two.

Fixtures cover inline-comment edits, review dismissal, thread resolution,
force-push handling through the unchanged head guard, and activity arriving
between the two reads. A partial nested comment connection activates the full
v1 reader, preserves the v1 decision, and emits one structured
`reviewed_pr_activity_cursor_v2_fallback` line.

The migration deliberately re-baselines persisted v1 reports. GitHub GraphQL
does not expose REST's immutable `side` and `start_side` fields, so a v1/v2
comparison returns `rebaseline`; apply reports “cursor version requires a fresh
review” and never claims that target activity changed. Fresh reports persist
v2 cursors.

OpenClaw Bay is unaffected. This changes internal GitHub read transport and
cursor comparison only; it does not change Bay's observer-only status contract,
public fields, lanes, or action boundary.

## Environment and command

The proof ran through Crabbox's explicitly selected Docker-backed
`local-container` provider on Ubuntu 26.04/arm64 with Node 24.19.0 and pnpm
11.10.0. The successful one-shot lease was `cbx_d96385e7eb89` and was stopped
automatically.

```bash
proof_source_head="$(git rev-parse HEAD)"
proof_source_tree="$(git rev-parse 'HEAD^{tree}')"
git cat-file -e "${proof_source_head}^{commit}"
git cat-file -e "${proof_source_tree}^{tree}"
PROOF_SOURCE_HEAD="$proof_source_head" PROOF_SOURCE_TREE="$proof_source_tree" \
  /Users/steipete/Projects/crabbox/bin/crabbox run \
  --provider local-container --no-hydrate \
  --allow-env PROOF_SOURCE_HEAD,PROOF_SOURCE_TREE \
  --preflight --timing-json --shell -- \
  "bash scripts/e2e/run-graphql-activity-cursor-v2-container.sh"
```

Local-container Actions hydration could not execute the repository's
`pnpm/action-setup` step, so the checked-in wrapper follows Crabbox's documented
`--no-hydrate` recovery: it installs a checksummed Node 24.19.0 tarball in the
ephemeral container, enables the repository-pinned Corepack/pnpm version,
builds all TypeScript targets, and runs the loopback scenario.

## Static verification recipe

Run from the repository root. The final command proves the tested source is
followed only by this proof directory, avoiding a self-referential commit hash
inside its own receipt.

```bash
receipt="docs/proof/graphql-activity-cursor-v2/receipt.json"
jq -e '
  .schema_version == 1 and
  .crabbox.provider == "local-container" and
  .crabbox.runtime == "docker" and
  .crabbox.exit_code == 0 and
  .crabbox.run_status == "succeeded" and
  .crabbox.lease_stopped == true and
  .requests.single == {"v1": 6, "v2": 2} and
  .requests.batch == {"size": 8, "v1": 48, "v2": 2} and
  .assertions.single_request_reduction == true and
  .assertions.batch_request_reduction == true and
  .assertions.fallback_decision_unchanged == true and
  .assertions.fallback_telemetry_lines == 1 and
  .assertions.concurrent_change_unstable == true and
  .assertions.double_read_preserved == true
' "$receipt"
tested_head="$(jq -r '.source.head' "$receipt")"
tested_tree="$(jq -r '.source.tree' "$receipt")"
git cat-file -e "${tested_head}^{commit}"
git cat-file -e "${tested_tree}^{tree}"
test "$(git rev-parse "${tested_head}^{tree}")" = "$tested_tree"
test -z "$(git diff --name-only "$tested_head"..HEAD -- . \
  ':(exclude)docs/proof/graphql-activity-cursor-v2/**')"
```

The receipt does not claim live GitHub mutation coverage. It proves request
shape, bounded decoding, fallback, migration behavior, and race detection; the
repository's full check supplies static, unit, integration, and coverage gates.
