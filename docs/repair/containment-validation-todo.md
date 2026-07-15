# Repair containment validation TODO

## Purpose

Move Linux repair-containment failures left from live repair jobs into
deterministic local tests and a non-mutating production-runner smoke check.
Live workers should confirm a fix after merge, not be the first place that an
unsupported syscall or runner capability is discovered.

This document is a handoff for a follow-up session. It does not authorize live
apply/close operations or changes to external pull-request branches.

## Current status

- PR [openclaw/clawsweeper#596](https://github.com/openclaw/clawsweeper/pull/596)
  fixed exact-review lease contention handling and added a legacy readonly
  remount fallback when `mount_setattr(2)` returns `ENOSYS`.
- Repair workers on the same merged SHA subsequently failed in the Landlock ABI
  capability probe, most likely syscall 444 (`landlock_create_ruleset`):
  - [run 29418723701](https://github.com/openclaw/clawsweeper/actions/runs/29418723701)
  - [run 29419775915](https://github.com/openclaw/clawsweeper/actions/runs/29419775915)
  - [run 29420021518](https://github.com/openclaw/clawsweeper/actions/runs/29420021518)
- PR [openclaw/clawsweeper#598](https://github.com/openclaw/clawsweeper/pull/598)
  merged on 2026-07-15 and makes Landlock an optional defense-in-depth layer
  only when its capability probe returns `ENOSYS` or `EOPNOTSUPP`. Other probe
  errors, ABI versions below 3, and later Landlock operations remain fail closed.
- Its green CI does not execute the unsupported-Landlock fallback path. The
  `ubuntu-latest` job skips the critical Linux containment integration tests
  because its availability helper requires both delegated namespaces and
  Landlock ABI 3+:
  [CI job 87373830736](https://github.com/openclaw/clawsweeper/actions/runs/29421789537/job/87373830736).
- Two naturally dispatched repair workflows on the merged SHA completed
  successfully, but their execute jobs were skipped, so they did not exercise
  the containment preflight:
  - [run 29423502149](https://github.com/openclaw/clawsweeper/actions/runs/29423502149)
  - [run 29423499463](https://github.com/openclaw/clawsweeper/actions/runs/29423499463)

## Two-PR execution plan

This file is the durable cross-session handoff. Keep completion boxes and live
evidence current as each PR progresses.

### PR 1: deterministic policy and one compiled preflight

Status: [PR openclaw/clawsweeper#599](https://github.com/openclaw/clawsweeper/pull/599)
is open from `agent/containment-preflight`. Implementation and Node 24
validation are complete, and autoreview completed with no actionable findings.

Combine the code-owned work behind one authoritative containment implementation:

- make the embedded Python definitions importable while preserving the
  production `python3 -c` entrypoint;
- execute the real Landlock fallback and fail-closed decision table in
  deterministic tests;
- gate Linux integration coverage on delegated namespaces rather than Landlock
  availability;
- report safe stage, syscall, and errno diagnostics plus a capability summary;
- expose one compiled `repair:containment-smoke` CLI for workflow callers.

This PR must not add a new runner job, change repair/apply authority, or perform
live repair mutations.

### PR 2: production-runner smoke workflow

Status: pending PR 1.

- run the compiled CLI on `blacksmith-16vcpu-ubuntu-2404` with two independent
  runner samples;
- replace the existing repair worker's inline Node preflight with the same
  compiled CLI;
- trigger only for containment runtime, tests, CLI, or relevant workflow changes;
- use no repository or organization secrets and grant only read permissions;
- fail when containment is skipped or unavailable;
- do not dispatch repair, push branches, apply results, or close items.

Before enabling pull-request execution from forks, prove that Blacksmith uses a
fresh ephemeral VM and exposes no repository or organization secrets. Otherwise
restrict the workflow to trusted branches or the existing trusted remote
validation path.

## Evidence-backed test gap

`test/repair/command-runner.test.ts` uses
`linuxValidationContainmentAvailable()` to gate the real Linux containment
tests. That helper calls syscall 444 and requires an ABI result of at least 3.
Consequently, the precise production condition that should exercise the new
fallback instead skips the entire integration test.

`test/repair/process-tree-containment.test.ts` currently protects the fallback
boundary with source-text assertions. These are useful drift guards, but they
do not execute the embedded Python decision path.

The runtime is also difficult to test and diagnose because the path spans:

1. `.github/workflows/repair-cluster-worker.yml`
2. `src/repair/contained-command-worker.ts`
3. the embedded Python in `src/repair/process-tree-containment.ts`
4. host kernel syscalls and provider seccomp policy

The containment protocol reports only an exception string, so both syscall 442
and syscall 444 surfaced as the same generic `[Errno 38] Function not
implemented` message.

## Required work

### P0: deterministic fallback tests

- [ ] Make the actual embedded Python definitions importable without executing
      `main()`, while preserving the production `python3 -c` entrypoint.
- [ ] Exercise the real `landlock_abi()` decision logic with an injected or
      monkey-patched syscall adapter; do not duplicate the decision in a
      TypeScript-only model.
- [ ] Cover this decision table:

| Probe/result                                       | Required behavior                     |
| -------------------------------------------------- | ------------------------------------- |
| syscall 444 returns `ENOSYS`                       | select mount-only fallback            |
| syscall 444 returns `EOPNOTSUPP`                   | select mount-only fallback            |
| probe returns `EPERM`, `EACCES`, or `EINVAL`       | fail closed                           |
| probe returns ABI below 3                          | fail closed                           |
| probe returns ABI 3 or newer                       | create and apply the Landlock ruleset |
| ruleset creation, add-rule, or restrict-self fails | fail closed                           |

- [ ] Split namespace availability from Landlock availability in
      `linuxValidationContainmentAvailable()`. When delegated namespaces are
      usable but Landlock is unavailable, run the mount-only containment tests
      instead of skipping them.
- [ ] Keep assertions that the sandbox exposes only configured writable roots,
      hides host paths and `/run`, drops all capabilities, isolates networking,
      and reaps descendant processes.

### P1: production-equivalent non-mutating smoke check

- [ ] Add a narrowly scoped `containment-smoke` CI job or workflow using the
      same `blacksmith-16vcpu-ubuntu-2404` runner class as repair execution.
- [ ] Run the compiled containment preflight only. Do not dispatch a repair,
      push target branches, apply results, close items, or use target write
      credentials.
- [ ] Trigger it only when the containment worker, its tests, or the relevant
      workflow surface changes.
- [ ] Consider two independent runner samples because the observed Blacksmith
      fleet exposed different capabilities for the same ClawSweeper SHA.
- [ ] In this production-compatible job, treat a skipped containment test as a
      failure rather than a green result.

Before enabling this job for fork pull requests, verify that it runs on a fresh
ephemeral VM with no repository or organization secrets. If that contract is
not proven, restrict the job to trusted branches or use the existing trusted
remote-validation path.

### P1: actionable containment diagnostics

- [ ] Report the failing containment stage, syscall number, and errno without
      including local paths, command contents, or secrets.
- [ ] Distinguish at least `mount_setattr`, legacy remount,
      `landlock_capability_probe`, ruleset creation, add-rule, restrict-self,
      namespace setup, and capability drop.
- [ ] Emit a safe capability summary such as `mount_readonly=native|legacy` and
      `landlock=abi-N|unavailable` from the smoke preflight.
- [ ] Preserve fail-closed behavior for every mandatory containment stage.

### P2: reduce workflow/runtime duplication

- [ ] Move the inline Node preflight in
      `.github/workflows/repair-cluster-worker.yml` behind one compiled,
      locally callable CLI so workflow and local tests execute the same probe.
- [ ] Keep workflow YAML responsible for orchestration and gates, not the
      containment implementation.
- [ ] Preserve one authoritative copy of the Python runtime. Do not create a
      separate test-only implementation that can drift from production.

## Capability policy to preserve

Mandatory containment remains:

- delegated user, mount, PID, and requested network namespaces;
- chroot and the minimal runtime bind mounts;
- recursive readonly mount policy with only explicit writable roots;
- host-path and write-escape preflight checks;
- capability bounding, effective, permitted, inheritable, and ambient sets all
  dropped;
- descendant process containment and reaping.

Landlock may be optional only as defense in depth after the mandatory mount
write allowlist is established and verified. An unsupported capability probe
may choose the fallback; an operational failure after Landlock is known to be
available must still fail closed.

## Acceptance criteria

- The unsupported-Landlock path is executed deterministically in local tests;
  it is not proven solely with regular-expression assertions.
- `ENOSYS` can be attributed to a named syscall and stage from one failure log.
- A non-mutating check runs the real compiled worker on the production runner
  class before merge, or the documented trusted equivalent is used.
- Critical containment coverage cannot silently turn green by skipping all
  environment-dependent tests.
- Node 24 validation passes:

  ```bash
  corepack enable
  pnpm install
  pnpm run check
  ```

- Run autoreview before publishing the follow-up PR.
- After merge, observe naturally scheduled repair workers. Do not manually run
  live apply/close and do not pause the sweep workflow.

## Out of scope

- Changes to `openclaw/clawsweeper-state`; its dashboard/schema work is
  independent of repair containment.
- Direct edits to external OpenClaw contributor branches.
- Weakening mandatory isolation merely to accommodate a runner.
- Requiring OpenClaw contributors to modify `CHANGELOG.md`.
