# Terminal acknowledgement fixture proof

Base: `eae7a713e211392f2a57ab91880a761efa1ae359`. The existing 503 case waited 30 seconds, then accepted the `execFile` timeout's SIGTERM as a generic rejection after four requests. The retry helper itself intentionally allows six attempts with 2, 4, 8, 16 and 32 second backoffs. This change runs the unchanged YAML step from a private temporary directory containing an exact copy of the built request builder and a helper copy whose single verified `sleep "$delay"` is replaced with `sleep 0`. Production workflow and helper bytes and retry timing are unchanged; `test/control-plane-curl.test.ts` separately checks the real helper's planned retry sequence with a stubbed `sleep`; it does not measure actual waiting.

The test requires the complete POST path and lease/body tuple, six 503 responses, the matching final helper status, and normal code-1 failure with neither signal nor timeout. Three recognized 409 cases and a 200 response retain their authorization checks; unrecognized 409 and new 418 controls must fail normally after one request. The exact source helper line must occur once. The request builder is copied byte-for-byte into the scratch directory rather than linked, so scratch removal does not traverse the build directory. The existing subprocess timeout remains: an unexpected future hang can still leave its Bash descendants after the immediate child is killed. This change does not claim to repair that separate abnormal-timeout cleanup limitation.

## Behavior proof

On Node 24.22.1, Linux aarch64, in a fresh user/PID/network namespace with a task-owned loopback server, the complete candidate file passed **8/8** with no skips or failures. A read-only diagnostic overlay reported six real 503 requests and code 1, no signal, `killed=false`; each recognized 409 and 200 case made one request and returned the expected authorization result. The unrecognized 409 and 418 cases each made one request and returned normal code 1. No namespace processes remained after the candidate run. This proof uses a synthetic loopback server and a zero-wait private helper; it does not claim real-host retry timing or prove Windows behavior.

Focused real-helper and queue-request tests passed **36/36**, no skips or failures. The real helper and workflow were not edited. The isolated setup used pinned dependencies from the matching lockfile, a task-owned HOME/store, and no network beyond the namespace's loopback. The suite command was:

```sh
node --test --test-concurrency=1 test/terminal-finalization-cancellation-workflow.test.ts
node --test --test-concurrency=1 test/control-plane-curl.test.ts test/repair/exact-review-queue-request.test.ts
```

## Local comparison

Sequential A/B/B/A captures used the same seven original case identities in a fresh loopback-only PID namespace, with no V8 coverage and concurrency one. A used the exact base test; B retained all original assertions and added payload, status and normal-exit checks. The new eighth 418 case was excluded from the matched timing and separately passed above. Metrics are waited-child resource figures, not process-tree peaks.

| Order | Version | Wall s | User s | System s | Max RSS KiB | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | Base | 30.811 | 0.654 | 0.529 | 115608 | 7 pass, 0 skip |
| 2 | Candidate | 1.203 | 0.815 | 0.723 | 123216 | 7 pass, 0 skip |
| 3 | Candidate | 1.282 | 0.828 | 0.811 | 123088 | 7 pass, 0 skip |
| 4 | Base | 30.835 | 0.706 | 0.503 | 109232 | 7 pass, 0 skip |

The local median was 30.823s versus 1.243s, a 29.580s difference for this selected sequential workload. Both baseline runs left two bash processes and a sleep inside their PID namespaces at test return; namespace teardown contained them. Both candidate runs had no remaining namespace processes. The baseline's passing 503 status was caused by the timeout, while the candidate proves normal failure; these outcomes are intentionally stronger, not behavior-equivalent timeout paths. This is not a hosted CI or billing estimate.

## Repository check and remaining gaps

`pnpm run check` was run in the same loopback-only, fresh user/PID/network namespace with a read-only source mount, task-owned HOME, Node 24.22.1 and pinned pnpm 12.15.0. Static checks, builds and lint completed; the full check exited 1 after 644.7 seconds. The Node reporter recorded 7,158 tests: 7,126 passed, 10 failed and 22 skipped. The failures were outside this changed test file:

1. `signed webhook loopback covers lifecycle, comments, reviews, checks, runs, and jobs`: expected HTTP 202, got 503. A focused unchanged-source control in the same isolation reproduced it; a diagnostic overlay recorded `{"error":"target_visibility_unverified","retryable":true}`. Its cause has not been established.
2. `packed local reviewer installs and runs outside the source checkout`: npm's request to `https://registry.npmjs.org/markdown-it` failed with `getaddrinfo EAI_AGAIN`.
3. `test/repair/coverage-credential-probe.test.ts`: `ENOENT` creating `/repo/.openclaw/tmp/coverage-probe`.
4. `compiled live admission preserves decisions and scopes its single public-read fallback`: Corepack's request to `https://registry.npmjs.org/pnpm/-/pnpm-12.15.0.tgz` failed with `getaddrinfo EAI_AGAIN`.
5. `exact review queue fence allows the owner and rejects supersession`: `ENOENT` creating `/repo/.clawsweeper-repair/payloads`.
6. `legacy command updates verify their receipt without creating duplicate acknowledgements`: same payload-directory `ENOENT`.
7. `mixed-generation legacy command updates finalize through the CLI`: same payload-directory `ENOENT`.
8. `command status updates record the write attempt and its outcome`: same payload-directory `ENOENT`.
9. `queue-owned command progress leases the marker head when the decision has none`: same payload-directory `ENOENT`.
10. `apply-decisions removes archived work plans from the scoped plans directory`: `ENOENT` creating `/repo/records/openclaw-clawsweeper/plans`.

The sandbox allowed no registry access and mounted source read-only; it was therefore not a faithful environment for tests requiring those resources. Focused unchanged-source controls used the same namespace containment, separate task-owned writable mounts for the three directory roots, and read-only source entries: the five repair cases passed 5/5, the work-plan case 1/1, and the full credential-probe file 2/2, all with zero skips and no remaining namespace processes. These controls do not make the full repository check pass. The targeted terminal fixture runs above used synthetic fixtures and completed within their intended isolation.

A diagnostic-only overlay supplied the public-target probe to the queue constructor; the webhook case still returned 503. Source tracing shows the worker checks hosted-target eligibility before the visibility probe and, without an injected predicate, reads a public registry. A second overlay adding only a synthetic worker eligibility predicate passed the case in this sandbox. The overlays change the test setup and do not prove that the unchanged test passes; they support the missing network-dependent eligibility result as the reason for the sandbox failure. The pinned pnpm package is present in the task-owned Corepack cache, but the failing admission subprocess constructs a restricted environment and does not forward that cache location. An unchanged-source focused control with the package copied to the isolated HOME's default Corepack path and the original wrapper PATH failed after 120.5 seconds with a null child status at the fixture's 120-second timeout; three processes remained within its PID namespace and were contained by namespace teardown. It did not establish a passing admission case or the timeout's cause. The local-package install test deliberately creates a fresh cache and performs an online seed before its offline install check. No external registry access was permitted or succeeded. A compatible environment and a rerun of the full check are still needed; the full check is **not passing**.

The historical [upstream base CI run](https://github.com/openclaw/clawsweeper/actions/runs/42478042234) checked out this exact base and passed all four test shards, coverage aggregation and the `pnpm check` gate. Its public logs explicitly show the [webhook case passing](https://github.com/openclaw/clawsweeper/actions/runs/42478042234/job/128723680609) and the [package-install and admission cases passing](https://github.com/openclaw/clawsweeper/actions/runs/42478042234/job/128723680537). This is historical base evidence, not candidate CI validation.

A further task-local admission replay retained the original workflow command and environment, with an instrumented test harness timeout shortened to 10 seconds. The child timed out with `ETIMEDOUT` and `SIGTERM`; its redirected output and stderr contained zero bytes. Two pnpm-native processes and one Node process remained inside the PID namespace and were contained by teardown. The replay does not establish what they were waiting on.

For the unchanged-source webhook control, run `node --test --test-concurrency=1 '--test-name-pattern=^signed webhook loopback covers lifecycle, comments, reviews, checks, runs, and jobs$' test/github-webhook-read-model.test.ts`. It reproduced the same 503 in this sandbox. Raw task-local captures retain exact commands, output and resource metrics; they are not necessary to reproduce the commands above.
