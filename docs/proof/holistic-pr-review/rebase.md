# October 9 base-integration proof

- Status: executed controlled proof, not a production trigger
- Owner: ClawSweeper review maintainers
- Selected main: `fe750d1779208b067c1f694dba70f494cb29c401`
- Tested rebased source: `7801e09baa5bc71c61538a4445cc37c511644f38`
- Original head: `1db94df2cac3715b595a0be05428bd129c74902a`
- Evidence: [source, model, command, input, and result receipts](rebase-receipt.json)

## Resolution and preserved ownership

A dedicated native Codex CLI resolver handled the actual rebase conflicts: an
explicit `gpt-6-astra`, high-effort, workspace-write session, resumed at the
second conflict checkpoint. The resolver did not run Git mutations. The owner
reviewed its changes, ran focused validation and fresh native Codex reviews,
then continued the normal rebase. Both original empty publication-marker commits
and all four commits’ human co-author trailers were retained.

Selected main already owns kind/profile prompt routing, schema field contracts,
typed readiness, judgment ownership, compact context, and prefetched history.
Those changes remain canonical. In particular, the upstream work in
https://github.com/openclaw/clawsweeper/pull/1784 and
https://github.com/openclaw/clawsweeper/pull/1785 subsumes the earlier branch
policy split. The three duplicate branch policy files were removed, not restored
as parallel owners. Upstream behavior tests and the current 61-field schema are
unchanged. The remaining prompt change is the short engineering outcome opening.

Main already delivered an inline OpenClaw schema. The retained transport change
adds bounded capture, validates the captured bytes, and admits the complete
message before delivery, with no second file read. It preserves main’s header and
trailing-prompt normalization. A focused upstream framing test caught that
normalization during resolution; it was fixed rather than weakening the test.

`git range-diff` compares the original four-commit series on
`34cc1aa014a16295779cdca4e336479bad5636ec` with the rebased series on selected
main. It records real semantic adaptations, not a byte-equivalent replay. The
[ownership inventory](policy-map.md) details retained responsibilities.

## Current input measurements

These are captured UTF-8 input components for the same local PR fixtures, not
tokens, wire measurements, latency, or cost measurements.

| Component | Selected main | Rebased candidate |
| --- | ---: | ---: |
| Static PR instructions | 62,136 | 63,356 |
| Output schema (61 required fields) | 62,787 | 62,787 |
| Static plus schema | 124,923 | 126,143 |
| Runtime envelope and context, cases 1/3 | 6,480 | 6,481 |
| Runtime envelope and context, case 2 | 6,598 | 6,599 |
| GitHub Context section (included above) | 2,881 | 2,881 |

The remaining opening adds **1,220 static bytes** over already-compacted main.
The historical reduction against the old additive branch is not a current-base
saving. Complete issue prompts are byte-identical to selected main for the
OpenClaw, ClawSweeper, and ClawHub profiles. Canonical kind/close templates,
repository profiles, and schema are also unchanged.

## Executed behavior

```bash
node docs/proof/holistic-pr-review/run-proof.mjs .artifacts/rebase-20261009/controlled
node docs/proof/holistic-pr-review/schema-delivery.mjs .artifacts/rebase-20261009/schema-delivery
```

The harness built both real production runtimes and ran the three existing
self-authored source fixtures through local-range review, normal admission,
native inference, parsing, and report generation. All six executions completed
on Linux with Node 26.8.2 and Codex CLI 0.147.0. Each effective model was verified
as `gpt-6-astra`, medium effort, read-only sandbox, with a 180-second review
budget. No container image/lease was used. Model configuration was not persisted
or changed for production. Expected observations stayed outside model context.

| Variant | Queued cancellation defect | Clean forwarding | Callback false-positive control |
| --- | --- | --- | --- |
| Selected main | One P2 finding | No findings | No findings |
| Rebased candidate | One P2 finding | No findings | No findings |

All target checkouts remained clean. These six observations establish integration
and a small scenario check, **not improved accuracy, speed, or cost**. Existing
historical receipts are not relabeled as current evidence.

The separate schema proof crossed `runAgentProcess` through the OpenClaw worker
to a controlled CLI message-file consumer under the native scanner. It received
**129,207 bytes**: 66,276 authored-prompt bytes after normalization, 62,787 schema
bytes, and 144 framing bytes. Diagnostic and delivered bytes matched. No-schema
passthrough, complete-message quota refusal, and malformed-schema refusal passed.
Do not count the inline schema twice. This proves delivery, not live OpenClaw
model compliance or quality; the native model experiment supplies the semantic
review observations. No live GitHub review, apply, or queue operation ran for proof.

## Validation and limits

- Focused affected coverage: **1,057 passed**, including the actual message-file
  boundary, scanner refusals, quotas, current upstream framing, prompt
  composition, canonical policy, and provenance.
- Fresh native Codex precommit reviews at both conflict checkpoints: no
  actionable regressions after fixes. Final committed-range review is recorded
  in the PR because it necessarily follows the evidence commit.
- `pnpm run check`: **6,954 passed, 7 failed, 20 skipped; 6,981 total**. Static
  checks, builds, lint, and focused changed coverage passed before the full suite.
  **The aggregate gate is not green.** All seven failures also reproduced on an
  isolated checkout of selected main with the same admitted dependencies. They
  concern apply-drift shell routing, queue-maintenance shell routing, focused
  hydration, non-blocking publisher reruns, corrupt scanner downloads, and two
  dispatcher shell/credential fixtures. No unrelated fixture fix is included.

The full-check and baseline-comparison logs, range-diff, resolver logs, and native
review logs are retained under `.artifacts/rebase-20261009/` in the work session;
log names and exact model results appear in the receipt. All source/prompt hashes
were checked against the tested candidate. Later evidence-only edits do not
change those runtime inputs. No Bay contract or deployment is changed.
