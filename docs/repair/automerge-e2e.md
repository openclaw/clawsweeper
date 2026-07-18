# Automerge end-to-end validation

This harness runs the production automerge command chain before a change is
merged into `main`. It is intentionally not a second implementation of the
state machine.

The lightweight suite executes:

1. `validate-job`
2. autonomous `run-worker`
3. `review-results`
4. planning-artifact copy into a fresh execution workspace
5. `execute-fix-artifact --defer-publication`
6. report-only publication with a fresh token
7. `apply-result` and repair `post-flight`
8. an exact-head ClawSweeper pass verdict
9. `comment-router` merge and an idempotent replay

GitHub and Codex are stateful simulators. Everything on the local execution
side is real: the production compiled CLIs, token separation, Git
clone/fetch/commit/push, a bare target remote, Corepack, the target's pinned
pnpm, dependency installation, changed-surface validation, artifact handoff,
and the final squash merge.

The simulated `gh repo clone` always creates a complete, non-local clone and
asserts that Git does not mark it shallow. A shallow boundary or local-hardlink
shortcut is not representative of GitHub transport and can turn missing-object
recovery into repeated Git work. Repository realism belongs in the small
fixture's tracked files and history shape, not in a full OpenClaw checkout or
an artificial shallow clone.

Two target fixtures keep different failure signals independent:

- `tiny` proves the generic automerge state machine and precise failure
  injection with the smallest real Git repository possible.
- `openclaw-shaped` preserves the production repository contracts that affect
  repair: OpenClaw's pinned pnpm and Node range, workspace layout and links,
  tracked cross-workspace and package-bin links under `node_modules`, Git-mode
  executable normalization, changed-surface gate, tracked policy symlink,
  release-owned changelog, and a contributor branch that is behind current
  `main`.

Neither fixture clones the full OpenClaw repository. That keeps the required PR
lane deterministic and bounded while still exercising the `openclaw/openclaw`
repository profile and strict target validation.

Unrecognized GitHub calls fail closed. This is deliberate: a new production API
dependency must be represented explicitly instead of silently reducing test
coverage.

## Local container

The canonical laptop command uses the repository image:

```bash
pnpm e2e:automerge:container
```

Run one scenario while iterating:

```bash
pnpm e2e:automerge:container -- \
  --scenario planning-head-drift \
  --fixture openclaw-shaped
```

The container wrapper runs both fixtures by default. Pass `--fixture tiny` for
the fastest edit loop or `--fixture openclaw-shaped` for the OpenClaw contract.
Artifacts are retained under
`test-results/automerge-container/<fixture>/<scenario>/`. The container
does not reuse the host `node_modules`, Corepack home, pnpm store, repair runs,
or Git state. The wrapper enables nested user/mount namespaces so the real
target-validation containment can run; it does not grant the container
privileged mode or additional Linux capabilities. The wrapper also caps the
container at 8 GiB with no additional swap, so a regressed fixture cannot
exhaust the developer host.

The outer container keeps its default root user because a host-UID-mapped
container cannot remount Docker's filesystem from a nested user namespace. The
production validator still drops every capability before starting target code,
and the wrapper restores artifact ownership to the invoking host UID afterward.

By default, the wrapper builds `Dockerfile.base` from the checked-out repository
as `clawsweeper-automerge-e2e-base:local`, then passes that exact local tag to
the application build. The base pins Node 24.15.0, which satisfies OpenClaw's
current Node 24 floor, and preinstalls Git, Python, CA
certificates, and Corepack. Docker reuses the unchanged OS package layer, while
the project dependency layer is cached independently by `package.json` and
`pnpm-lock.yaml`; repeated runs do not reinstall either layer.

To rebuild the repository-controlled base explicitly, run:

```bash
docker build \
  --file test/e2e/automerge/Dockerfile.base \
  --tag clawsweeper-automerge-e2e-base:local \
  .
```

An explicitly trusted prebuilt base can be selected without editing the
application Dockerfile:

```bash
pnpm e2e:automerge:container -- \
  --base-image clawsweeper-automerge-e2e-base:local
```

## CI and Crabbox

`.github/workflows/automerge-e2e.yml` runs every scenario against both fixtures for repair,
harness, package-manager, and workflow changes. CI calls the repository-owned
container wrapper on the same production-class Blacksmith runner used by repair
execution. Pull requests from forks are excluded because untrusted code must not
receive that runner. CI builds the base from the checked-in `Dockerfile.base`
just like the local default. The resulting image is saved in a GitHub Actions
cache keyed by the complete base Dockerfile, so OS packages are installed only
on a cache miss. Pull-request caches cannot replace the default branch's cache.

The same entrypoint runs on a clean Crabbox checkout without installing project
dependencies on the host:

```bash
pnpm crabbox:run -- \
  --preflight \
  --timing-json \
  --capture-on-fail \
  --shell -- \
  "node scripts/e2e/automerge-container.mjs --scenario all --fixture all"
```

Across both target shapes, the scenarios cover the complete success path, a real tracked-file
dependency-install mutation, planning-to-execution head drift, pending checks
that later turn green, stale exact-head verdicts, replay idempotency, and the
reconstructed 2026-07-18 runtime-identity regression. The OpenClaw-shaped runs
also prove a real workspace install/link graph, `check:changed` root-source routing,
base ancestry synchronization, tracked workspace/bin links maintained by pnpm,
Git-equivalent `0775 -> 0755` executable normalization, the
`CLAUDE.md -> AGENTS.md` symlink, and `CHANGELOG.md` preservation.

## Exact 2026-07-18 CI regression

The regression scenario records the exact revisions from the failed run:

- ClawSweeper: `7be2e4915b4b1d9aa953ccfe359cea670a4616ec`
- OpenClaw PR head: `34a3001388bb99fb4a041a73aad98631c4557634`
- OpenClaw base: `977e0b64a12152a2e112634c1c32e8505db08234`

The failure is in ClawSweeper's target-runtime freezer and does not depend on
OpenClaw's full source graph. The `tiny` fixture reconstructs it with a real Git
repository pinned to the run's pnpm 11.2.2; the `openclaw-shaped` fixture reruns
the same failure injection with OpenClaw's workspace and package-manager
contract. This avoids downloading and installing the multi-GB OpenClaw graph
on developer machines. The historical revision also contains an earlier Yarn-shim
freezer defect. For this scenario only, a Corepack proxy adds the missing
`pnpm` selector to the old `corepack enable` call so execution reaches the
linked Git-index identity failure; Corepack and pnpm otherwise execute for
real. To prove the original failure, build the historical ClawSweeper revision
and run:

```bash
pnpm e2e:automerge:container -- \
  --scenario ci-regression-29623139111 \
  --fixture tiny \
  --candidate-root /path/to/clawsweeper-at-7be2e491 \
  --expect setup-identity-failure
```

The candidate checkout must contain `dist/` and `node_modules/`; it is mounted
read-only into the clean image. To validate the image's current candidate fix
against the same reconstructed setup, omit `--candidate-root` and `--expect`.
A successful candidate must continue beyond dependency setup and reach the
normal exact-head merge terminal state.

The OpenClaw-shaped fixture also provides a direct before/after proof for the
tracked workspace-link and executable-mode install contract. Point the same
harness at a built pre-fix candidate to assert the exact failure without
changing the fixture or treating a non-zero harness exit as success:

```bash
pnpm e2e:automerge:container -- \
  --scenario happy-path \
  --fixture openclaw-shaped \
  --candidate-root /path/to/clawsweeper-before-fix \
  --expect setup-identity-failure
```

## Scenario contract

List all scenario names with:

```bash
pnpm e2e:automerge -- --list-scenarios
```

List target fixture names with:

```bash
pnpm e2e:automerge -- --list-fixtures
```

Each fixture/scenario pair writes `summary.json` and per-step stdout/stderr logs. Exit zero
means the selected terminal-state assertions passed; it does not mean that an
expected safety rejection was bypassed. Failure workspaces are deleted by
default, while the artifact logs retain the command boundary and error. Use
`--keep` only for local diagnosis because retained workspaces may be large.
