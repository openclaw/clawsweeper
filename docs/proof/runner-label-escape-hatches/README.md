# Blacksmith runner-label escape-hatch proof

## Claim

Every GitHub Actions job that defaults to a Blacksmith runner can be redirected with a repository
variable while preserving its existing Blacksmith label when the variable is unset. The report
lane's override is live: `CLAWSWEEPER_REPORT_RUNNER=ubuntu-latest` remains set while Blacksmith
us-west is unavailable. The E2E and spam overrides remain unset, so their fallbacks are unchanged.

## Label inventory and variable ownership

The pre-change workflow sweep found six bare `runs-on` assignments:

| Workflow job | Variable | Unchanged fallback |
| --- | --- | --- |
| `automerge-e2e.yml:automerge-e2e` | `CLAWSWEEPER_E2E_RUNNER` | `blacksmith-16vcpu-ubuntu-2404` |
| `maintainer-report-discord.yml:notify` | `CLAWSWEEPER_REPORT_RUNNER` | `blacksmith-4vcpu-ubuntu-2404` |
| `repair-containment-smoke.yml:containment-smoke` | `CLAWSWEEPER_E2E_RUNNER` | `blacksmith-16vcpu-ubuntu-2404` |
| `repair-publish-results.yml:publish` | `CLAWSWEEPER_WORKER_RUNNER` | `blacksmith-4vcpu-ubuntu-2404` |
| `spam-comment-intake.yml:intake` | `CLAWSWEEPER_SPAM_RUNNER` | `blacksmith-4vcpu-ubuntu-2404` |
| `spam-scanner.yml:scan` | `CLAWSWEEPER_SPAM_RUNNER` | `blacksmith-4vcpu-ubuntu-2404` |

The containment smoke reuses the E2E control because both jobs exercise the production
container/containment surface on the same runner class. Repair result publication reuses the
existing lightweight worker control. Spam intake and scanning share one spam-lane control rather
than introducing two equivalent variables.

Other Blacksmith strings in the workflow tree were already protected by repository-variable
fallbacks or were `workflow_dispatch` input defaults, so they required no change.

## Test and proof shape

`test/workflow-runner-labels.test.ts` parses every workflow and rejects any Blacksmith `runs-on`
assignment without a `vars.CLAWSWEEPER_*_RUNNER || 'blacksmith-*'` fallback. It also pins the six
current job-to-variable mappings and fallback labels. Existing automerge and containment workflow
shape tests assert their exact expressions.

The committed `run-proof.sh` is the static `jq` recipe for the Docker-backed Crabbox run. It obtains
the head commit, head tree, and base commit through `git rev-parse`, verifies all three objects with
`git cat-file`, runs the focused workflow tests and `pnpm run check`, and validates its generated
JSON receipt. Raw Crabbox sync omits Git metadata, so the run transports the already-committed head
and base in a temporary Git bundle, reconstructs the refs inside the lease, and removes the bundle
before validation. The bundle is proof transport only and is not committed. See `red-green.md` for
the local RED/GREEN transcript.

The final run used Crabbox `provider=local-container`, lease `cbx_d1a06e39d867`
(`golden-prawn-16e4`), image `node:24-bookworm`, and tested head
`f84b7d60daa24d979eef6299be0d9c2a55fdab62`. The focused suite passed 9/9 and the full
`pnpm run check` gate passed 3,420 tests with zero failures and eight platform skips. The one-shot
lease stopped automatically and is absent from the local-container inventory. The receipt commit
contains proof artifacts only after the tested workflow tree; no workflow, test, or proof script
change follows the tested head in this push. Full machine provenance is frozen in
`container-receipt.json`.

## Live GitHub Actions proof

GitHub accepted a `workflow_dispatch` for `maintainer-report-discord.yml` directly from branch
`steipete/runner-label-escape-hatches` at tested head
`32334740ba22b0e7fe69d1c71bfc013441f3dbf6`. Run
[`31759075251`](https://github.com/openclaw/clawsweeper/actions/runs/31759075251) resolved the report
job label to `ubuntu-latest`, assigned GitHub-hosted runner `GitHub Actions 1011717149`, and
completed successfully. This demonstrates that branch dispatch used the PR branch workflow
definition and respected the configured repository variable.

For contrast, scheduled run
[`31688886472`](https://github.com/openclaw/clawsweeper/actions/runs/31688886472) at pre-change
`main` head `4d41d3df4baf191dca9c385c82689425a135a5c4` resolved the same job to
`blacksmith-4vcpu-ubuntu-2404` and ran on a Blacksmith runner. The full redacted API transcript,
object cross-checks, behavior contract, and variable end-state are in `live-actions.md`.

OpenClaw Bay is unaffected: runner selection does not change workflow lifecycle publication,
status telemetry, dashboard data contracts, or the observer-only action boundary.

## Limits

The live run exercises the report-lane override only. The E2E, containment, repair-publication,
and spam mappings remain covered by the workflow-shape tests and repository gate rather than live
dispatches. The historical report run proves the report lane's Blacksmith default; the unchanged
fallback expressions and tests cover the other unset defaults.
