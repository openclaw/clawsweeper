# Blacksmith runner-label escape-hatch proof

## Claim

Every GitHub Actions job that defaults to a Blacksmith runner can be redirected with a repository
variable while preserving its existing Blacksmith label when the variable is unset. No repository
variables are set by this change.

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

OpenClaw Bay is unaffected: runner selection does not change workflow lifecycle publication,
status telemetry, dashboard data contracts, or the observer-only action boundary.

## Limits

This proves static workflow selection and the repository gates. It does not dispatch the workflows
or set repository variables. With variables unset, GitHub Actions resolves the same Blacksmith
labels as before.
