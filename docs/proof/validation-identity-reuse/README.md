# Validation setup identity reuse

- Status: historical proof recipe; not an operational runbook
- Owner: ClawSweeper repair maintainers
- Baseline: `5ada40c98ae6dcf31703cf7c3f01e35e8d23a13e`
- Source: `src/repair/target-validation.ts`
- Update when: the identity owner, fixture, toolchain, or recorded claim changes

**Execution status: passed.** [Normalized observations](observations.json) bind
the completed real-owner proof to this baseline plus the recorded production
diff and recipe hashes. Node 24.20.0, Corepack 0.35.0, and pnpm 11.10.0 executed
both allowed validations successfully, each with exit zero, a stdout marker,
and no background processes. Runtime tampering and tracked-source tampering
each rejected without another dispatch. The observer recorded no diagnostics
and was restored. Setup took 43.553 seconds; this is one observed run, not a
performance guarantee. Independent review, current-head CI, and landing gates
remain outstanding.

The claim is that successful pnpm setup retains its verified **post-install**
identity without an immediate third capture, and still rejects stale runtime or
source inputs before the next allowed validation command executes. Production
budgets, source guards, containment policy, and permissions are unchanged.

Build with the repository's pinned pnpm 11.10.0, then run from the repository
root with Node 24 or newer and actual Corepack available on PATH:

```sh
corepack pnpm run build:all
node docs/proof/validation-identity-reuse/run-proof.mjs /tmp/validation-identity-proof-new
```

Nested build scripts must also resolve pnpm 11.10.0. If needed, create Corepack
shims in a task-local directory and prepend it to PATH; do not change global
tools or bypass package-manager version checks.

[The recipe](run-proof.mjs) calls the compiled production `prepareTargetToolchain`
and `runAllowedValidationCommands` owners. It creates a tiny local package with
one tracked local dependency, a local-only Git origin, and an isolated HOME.
Actual Corepack/pnpm generate the lockfile, install the dependency, freeze the
prepared runtime, and execute a script that checks the installed dependency and
prints a unique stdout marker. That script writes no files. No target package
is fetched from a registry; Corepack may download the pinned pnpm distribution.
No account, credentials, real target repository, or GitHub action is involved.

The Node test harness installs a **transparent `spawnSync` observer** after
setup. Every call delegates the identical invocation to the original function
and returns the exact original result. It observes only the production command
runner's real `contained-command-worker.js` supervisor for the fixture's exact
`verify` script. Actual returned JSON supplies exit status, signal, background
process count, and stdout marker evidence; raw arguments, environment, stdout,
and host paths are not copied into the normalized record. Malformed observation
adds a diagnostic, returns the original result unchanged, and fails proof
outside the production call. The observer and builtin ESM exports are restored
in `finally`. No process, result, timeout, clock, or sandbox behavior is faked.

The first allowed validation must return successfully and produce exactly one
observed dispatch with exit zero, no background processes, and its stdout
marker. Changing ignored `.modules.yaml` must produce the exact stale-runtime
error with no additional dispatch or marker. Restoring its original bytes must
permit a second real validation with the same successful receipt facts. A
separate tracked-source mutation must reject with no third dispatch. These two
positive controls establish that the observer actually sees executed scripts;
the negative controls check that rejected scripts never reach the supervisor.

The recipe uses real Git, filesystem state, subprocesses, final stdout I/O, and
wall clock with default production budgets. Its outer watchdog remains 600
seconds. The outer recipe launches Node's test runner with an allowlisted
environment. On macOS this selects the existing process fallback in the
production command runner. This is controlled production-owner behavior proof,
**not** evidence of Linux namespace, network, or filesystem containment. No
production gate is changed or bypassed for real repair work. Provider is
`local-node-test-harness`; image and lease are not applicable. It is not a
Crabbox lease or proof of an OpenClaw/native-app workload.

`source.json` records the actual source HEAD, production diff digest, and
source/build/recipe hashes. `supervisor-receipts.json` retains the normalized
real transport observations even on failure. `observations.json` is written
only after all allowed/rejected controls pass. Raw `driver.log` stays local.
Rerun after source or recipe changes; an uncommitted run does not certify a
later commit or branch head.

## Retained earlier failures and separate regression

Earlier attempts remain historical failures: an outer-watchdog expiry after a
marker-file write, incomplete Corepack extraction during disk exhaustion, and
a recovered-space run that completed setup but correctly rejected that marker
write inside protected `node_modules`. The last was a proof-fixture defect,
not a failure of the identity-reuse optimization. No production guard or tamper
assertion was relaxed to repair the fixture.

The accompanying unit regression is separate evidence: real Git and fake
Corepack/pnpm processes use a virtual setup clock charging 250 ms per Git call.
The original 15-second shared fixture budget is unchanged. Baseline fails at
60 calls with `validation identity deadline exhausted during raw worktree head`;
the patch completes setup in 51 calls / 12,750 charged ms. These charged times
are not wall-clock performance measurements or actual pnpm install timings.

Fresh 11-case focused coverage runs pass on both Node 24.20.0 and Node 26.7.0
at the recorded baseline and patch. They cover the original real-clock refresh,
stale setup, dependency/source mutation, workspace links, error precedence, and
shared deadline/reserve behavior. Earlier failed runs remain local evidence;
full macOS coverage was not repeated and exact-head CI remains required.

Bay is unaffected: this change has no queue, publication, status, API, dashboard,
or observer contract. The repair entry point and internal feature map remain
accurate. Full exact-head CI and independent reviews remain landing gates.
