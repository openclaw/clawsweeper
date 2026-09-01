# Report front-matter repro

- Status: proposed proof methodology; no execution receipt for the integrated PR
- Owner: ClawSweeper report and repair maintainers
- Source of truth: [shared structure reader](../../../src/report-front-matter.ts),
  [decision packets](../../../src/decision-packets.ts),
  [repair intake](../../../src/repair/create-job.ts), and
  [workflow selectors](../../../src/repair/workflow-utils.ts)
- Prepared against main: `aba9826ab8c010a8f5a2b4411484dc4cb7e94f51`
- Update when: report structure, adapter decoding, promotion eligibility,
  CLI arguments, build closure, or toolchain changes

The claim is that a valid leading header remains usable by repair intake and
decision consumers when the body quotes its keys, while genuine competing
records and missing-field body lookalikes remain ambiguous. Scalar ambiguity is
field-specific. Packet ambiguity requires duplicate header-owned keys or
matching competing keys; unrelated body-only examples are not blockers.

This replaces the primary-reader-only proof from
[the original contributor branch](https://github.com/openclaw/clawsweeper/tree/d2a8a5b0d4f0f487c58a5a50946de42a194e3011/docs/proof/record-front-matter-body-scope).
That superseded harness deliberately excluded repair readers, compiled one old
module alongside candidate siblings, and included historical result claims.
Its bytes remain in contributor history. This folder instead builds two complete
Node source closures and exercises the real consumers. It contains source and
methodology only; normalized fresh observations belong in the main PR body
after execution. An authenticated artifact portal is not sufficient public
evidence by itself.

## Inputs and commands

The caller provides an existing Linux environment with Node **24.20.0**, pnpm
**11.10.0**, Bash, tar, and repository dependencies installed from the supplied
lockfile. The maintained proof uses the operator's configured AWS Crabbox
environment; the operator records its actual provider, image, lease, and run.
The runner allocates nothing, installs nothing, and does not need Git or a
`.git` directory. A local run is only a preparation check, not AWS evidence.

Create the baseline archive on a trusted checkout with this exact closure:

```bash
git archive --format=tar aba9826ab8c010a8f5a2b4411484dc4cb7e94f51 \
  src config schema package.json pnpm-lock.yaml pnpm-workspace.yaml \
  tsconfig.json tsconfig.repair.json > /tmp/report-metadata-baseline.tar
```

Expected baseline SHA-256:
`b4e0968d35f70c2470196522feaff64b7f48ed36406053c0a3459062d7a13567`.
The baseline is current pre-fix main, independently of the candidate's eventual
commit identity. Produce the candidate archive from the exact committed head
approved for execution, using the same closure:

```bash
git archive --format=tar "$CANDIDATE_HEAD" \
  src config schema package.json pnpm-lock.yaml pnpm-workspace.yaml \
  tsconfig.json tsconfig.repair.json > /tmp/report-metadata-candidate.tar
sha256sum /tmp/report-metadata-candidate.tar
```

Supply the full candidate commit SHA and the resulting archive digest. These
identities are caller-verified provenance, not inferred from source symbols.
For an uncommitted local preview, archive a fully staged Git tree and identify
it as `tree:<full-tree-sha>`; never label that preview as committed-head proof.
The runner checks both archive digests before extraction and records the actual
source and built-output hashes. It rejects paths outside the closure, traversal,
links, and special files. It does not copy existing `dist` output.

Sync this **entire folder**, both archives, and the dependency checkout. From a
directory containing the installed dependencies and matching `pnpm-lock.yaml`:

```bash
bash docs/proof/report-front-matter/run-proof.sh \
  --baseline-archive /tmp/report-metadata-baseline.tar \
  --baseline-id commit:aba9826ab8c010a8f5a2b4411484dc4cb7e94f51 \
  --baseline-sha256 b4e0968d35f70c2470196522feaff64b7f48ed36406053c0a3459062d7a13567 \
  --candidate-archive /tmp/report-metadata-candidate.tar \
  --candidate-id "commit:$CANDIDATE_HEAD" \
  --candidate-sha256 "$CANDIDATE_ARCHIVE_SHA256" \
  --deps-root "$PWD" --out /tmp/report-metadata-proof-results
```

Output must be a new absolute directory. [run-proof.mjs](run-proof.mjs) validates
the pinned package scripts, then invokes their installed TypeScript compiler
with `-p tsconfig.json` and `-p tsconfig.repair.json` separately in two new
temporary directories. These are the two compiler commands behind `build:node`.
It shares only already-installed dependencies and verifies source hashes and
dependency links/files after execution. It does not run pnpm scripts inside the
temporary trees: pnpm's automatic dependency maintenance could otherwise
relink shared `node_modules` to a temporary source directory.
No branch-owned install, fallback compiler, model command, or remote fetch is
part of this procedure.

## Scenario contract

[runtime-proof.mjs](runtime-proof.mjs) executes **13 scenarios per mode**. The
expectation mode is explicit, with no source-symbol detection.

| Scenarios                                                                                                                       | Baseline expectation                                                    | Candidate expectation                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Ordinary and fenced quoted header keys (2)                                                                                      | Intake exits 2; `none` invents a blocker; required packet is suppressed | Intake succeeds; `none` yields false/null; required decision survives exactly |
| Body heading, header comments, header list, body list, single/repeated delimited body-only keys (6)                             | All remain readable                                                     | All remain readable                                                           |
| Genuine competing owned-key record containing comments/list entries (1)                                                         | Intake rejects ambiguous ref; decision blocks with no packet            | Same guarded rejection                                                        |
| Eligible F/missing legacy-rating selector (1)                                                                                   | Selects `322`                                                           | Selects `322`                                                                 |
| Missing ratings with body lookalikes: no legacy sections, F/missing legacy sections, fenced lookalikes plus legacy sections (3) | Selects nothing                                                         | Selects nothing                                                               |

The six benign structural cases are positive controls on both versions, not
failures attributed to the original bug. F/missing legacy ratings are valid
promotion criteria; missing-versus-ambiguous metadata prevents body lookalikes
from falling back to those criteria.

The actual intake invocation uses `create-job --from-report` with synthetic
`321.md`, `--prompt`, `--cluster-id`, an isolated `--out-dir`, `--dry-run`, and
`--no-check-existing`. Child probes invoke the real
`maintainerDecisionBlocksClose` and `buildDecisionPacketFromReport` exports and
check the original subject, question, rationale, options, and owner. Selector
cases invoke actual `workflow-utils proposed-item-numbers` against a flat
synthetic `records/.../items` directory. Each mode expects 22 application
invocations, two tripwire self-checks (GitHub command and network denial), and 138 baseline / 152
candidate assertions. These counts are expectations, not an execution receipt.

## Boundaries and output

Children receive a credential-free allowlist. Static `gh`, `codex`, and `claude`
tripwires and the static network-denial preload read their log pathname from the
child-only `CLAWSWEEPER_PROOF_DENIED_LOG` environment value. The command names
remain an explicit allowlist. Decision probes receive module and report paths
as arguments; runtime paths are never inserted into generated JavaScript.

The central spawn helper passes the preload through explicit Node `--require`
arguments. It denies fetch, HTTP(S), and socket connections. Independent self-checks
require the GitHub command's rejection and a fetch to `https://example.invalid`
to fail with the known network-denial error and log entry. Both self-check logs
are cleared before measuring application behavior. Assertions require zero
subsequent command or network attempts, no jobs written, and unchanged selector
records.

Generated manifests bind source IDs, archive hashes, source/dist hashes, driver
and fixture hashes, complete argv (including the preload) and argv hashes,
the non-secret child environment, observations, and toolchain.
Build/runtime logs and manifests stay in the caller's output directory, outside
committed source. Publish only inspected normalized observations in the PR body
after fresh execution and record provider/image/lease separately.

This does not exercise live GitHub, real job creation, model inference, a
deployed Worker, production close/apply, or a complete hosted workflow. The
advisory audit, scanner/provenance/statistics, queue, close policy, record schema,
and broader Markdown-section parsing are unchanged. OpenClaw Bay needs no
change: it reads the same record shape and observer-only projection.
