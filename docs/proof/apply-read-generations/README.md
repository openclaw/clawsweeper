# Apply read generations proof

- Status: historical proof artifact
- Owner: ClawSweeper publication maintainers
- Tested source: `openclaw/clawsweeper@82d9a3b14961793d13f3d0b113078eb84e4caf00`
- Update when: apply generation keys, mutation observation, lease/proof barriers, or PR hydration watermarks change

## Claim and exercised surface

The controlled loopback exercises the production `LiveReadGeneration`, apply
guard memoization, two-sided lease guard, and PR hydration coordinator through
real HTTP endpoints. Identical fetch/context/policy reads share one value only
inside a generation. An observed GitHub mutation advances the generation,
clears its entries, and makes a previously bound context fail a runtime
generation assertion.

The pre-comment and pre-close lease barriers deliberately bypass a warm
generation. Each barrier therefore performs two live pull-head reads around one
live complete comment-list read. Fixtures advance the generation after a
concurrent head change and after a new durable comment; both cases block apply.

Apply parses the persisted PR hydration snapshot from report front matter and
validates the live head SHA, `updated_at`, file/commit/inline-comment counts,
and the just-in-time activity revision before reuse. Existing v2 snapshots can
reuse commits and inline comments while reading their missing file window.
Current v3 snapshots also retain that bounded file window, so a validated v3
hit performs zero pull-file, commit, or inline-comment list reads. Any mismatch
uses the normal full list path.

OpenClaw Bay is unaffected. This changes internal publication reads and
cache-only report metadata, not Bay's observer contract or action boundary.

## Generation and invalidation inventory

| Event | Generation behavior | Covered mutation surfaces |
| --- | --- | --- |
| Apply starts one item | Create one generation and bind guard reads to it | item fetch, context hydration, policy guards |
| Mutation runner reports accepted | Advance generation and discard bound context | lease post/delete, label definition/item labels, durable comment post/patch, placeholder delete, recovery label removal, close comment, item close |
| Mutation runner reports ambiguous outcome | Advance generation before propagating the error | every observed GitHub write attempt whose non-mutation cannot be proven |
| Mutation runner reports rejected/no-op | Preserve generation | guard rejection and explicitly known no-mutation errors only |
| Final proof, comment, or close guard | Bypass generation cache | final `fetchItem`/context freshness and low-signal policy checks |
| Two-sided lease verification | Bypass generation cache | head/source, comments, head/source |

## Counted formula and safety result

For the representative apply slice, `F` is the first item fetch, `C` context
hydration, `P` policy reads, `L` the irreducible lease barrier, and `U` the six
unique generation reads:

```text
before = F(1) + C(4) + P(6) + L(3) = 14
after  = U(6) + L_live(3) = 9
```

The `L(3)` floor is unchanged. With the generation already warm, both the
pre-comment and pre-close barriers still recorded two `/pull` requests and one
`/comments` request. Concurrent head and comment changes were both rejected.
A validated v3 snapshot recorded files=0, commits=0, inline-comments=0.

## Environment and commands

The exact source passed the complete host gate on Node 24.19.0:

```bash
pnpm run check
```

Result: 3,444 tests, 3,435 passed, 9 platform skips, 0 failures. Coverage was
81.57% lines, 74.01% branches, and 87.39% functions. Static checks included
`check:dashboard-strict`, docs, limits, formatting, all TypeScript builds, and
all linters.

The deterministic transport proof ran through Crabbox's explicitly requested
Docker-backed `local-container` provider on Ubuntu 26.04/arm64 with Node
24.19.0 and pnpm 11.10.0. The successful fresh-PR lease was
`cbx_0241049e673e` (`golden-barnacle-01a8`) and stopped automatically.

```bash
proof_source_head="$(git rev-parse HEAD)"
proof_source_tree="$(git rev-parse 'HEAD^{tree}')"
git cat-file -e "${proof_source_head}^{commit}"
git cat-file -e "${proof_source_tree}^{tree}"
PROOF_SOURCE_HEAD="$proof_source_head" PROOF_SOURCE_TREE="$proof_source_tree" \
  /Users/steipete/Projects/crabbox/bin/crabbox run \
  --provider local-container \
  --fresh-pr openclaw/clawsweeper#1161 \
  --no-hydrate \
  --allow-env PROOF_SOURCE_HEAD,PROOF_SOURCE_TREE \
  --preflight --timing-json --ttl 30m --shell -- \
  "awk '/^echo CRABBOX_PHASE:check$/{exit} {print}' scripts/e2e/run-apply-read-generations-container.sh | bash"
```

The successful receipt covers the checked-in toolchain, all three builds,
source identity, and loopback behavior phases. A separate Linux full-gate
attempt reached the repository workflow fixtures but those macOS-authored
cursor-trace fixtures reject Linux filesystem metadata; the exact same complete
gate is green on the required Node 24 host. No product assertion relies on that
platform-specific shard.

## Static verification recipe

Run from the repository root. The final diff check permits only this proof
directory after the tested source commit.

```bash
receipt="docs/proof/apply-read-generations/receipt.json"
jq -e '
  .schema_version == 1 and
  .crabbox.provider == "local-container" and
  .crabbox.runtime == "docker" and
  .crabbox.exit_code == 0 and
  .crabbox.run_status == "succeeded" and
  .crabbox.lease_stopped == true and
  .requests.before == 14 and
  .requests.after == 9 and
  .requests.barrier == {"pull": 2, "comments": 1} and
  .requests.validated_snapshot == {"files": 0, "commits": 0, "inline_comments": 0} and
  .assertions.concurrent_head_blocked == true and
  .assertions.concurrent_comment_blocked == true and
  .assertions.generation_bound_value_rejected == true and
  .full_gate.dashboard_strict == true and
  .full_gate.fail == 0
' "$receipt"
tested_head="$(jq -r '.source.head' "$receipt")"
tested_tree="$(jq -r '.source.tree' "$receipt")"
git cat-file -e "${tested_head}^{commit}"
git cat-file -e "${tested_tree}^{tree}"
test "$(git rev-parse "${tested_head}^{tree}")" = "$tested_tree"
test -z "$(git diff --name-only "$tested_head"..HEAD -- . \
  ':(exclude)docs/proof/apply-read-generations/**')"
```

## Limits

The behavior fixture uses deterministic loopback endpoints, not live target
mutations. It proves request ownership, invalidation, barrier transport, and
race decisions; it does not claim production latency. v2 records cannot avoid
the one file-list read because that schema did not persist files. No Worker,
dashboard, queue, or target repository state was mutated by the proof.
