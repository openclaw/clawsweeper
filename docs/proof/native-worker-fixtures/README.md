# Native-worker rejection fixture qualification

Lifecycle: historical, task-specific proof. Owner: ClawSweeper review admission.
Source of truth: `src/agent-input-scan-fixtures.ts` and the pinned native scanner.
Verified scope: OpenClaw head `93dbee664f93ca80668f85ab346c8e7a4e07db7e`;
ClawSweeper baseline `f9d81c419e55740d5a48a546b6cd27e49b35250d`. Re-run when
these source witnesses, scanner version, staging, or classifier change.

## Claim and scenario

Permit only two exact synthetic URI rejection inputs from
[OpenClaw PR 158901](https://github.com/openclaw/openclaw/pull/158901):

- `src/worker/native-runtime-transport.test.ts`, blob
  `b4b313e03e7bcff43b7ba7426add5a76af436129`, line 341: a dummy-user/password
  URL on reserved `example.test`, asserted false by `isNativeRuntimeEndpoint`.
- `src/worker/native-runtime.test.ts`, blob
  `8ea970c7b3467718eb7b64ecee9ebe7bcf0256c4`, line 409: a dummy-user/password
  URL on reserved `example.com`, asserted invalid by `NativeRuntimeConfigSchema`.

These are different inputs, not duplicate findings. The existing host-owned
exact-attribution table binds URI detector 17, observed PLAIN/HTML decoding,
both native value digests, each entire source line, exact path, regular-file
mode, and every committed base/head reference. Changed/removed patch lines
reuse their proven source witnesses. No file, domain, detector, or checkout
allowlist is added; no original test is edited. Scanner arguments, verification
requirements, completion checks, source provenance, and fail-closed gates remain
unchanged.

## Command and environment

The native proof used Linux x64, Node 26.8.2, and the managed checksum-pinned
TruffleHog 3.97.4 binary. The managed bootstrap ran before isolation; its external
cache directory was then selected through trusted PATH. No cloud lease/container
image was used for this source scan. The full public consumer checkout was
hydrated beforehand with sufficient ancestry; no consumer code was executed.

From each built ClawSweeper policy checkout, with `TARGET` pointing to a clean
checkout at the recorded head, `SCANNER_DIR` the external pinned scanner cache,
and `OUT` an existing writable proof directory:

```sh
bwrap --unshare-net --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --bind "$OUT" "$OUT" --clearenv --setenv HOME "$HOME" \
  --setenv PATH "$SCANNER_DIR:/usr/bin:/bin" -- /usr/bin/node \
  docs/proof/native-worker-fixtures/run-proof.mjs "$TARGET" \
  be46e6966c2b52c6cde06abf965c44f9a175a47f \
  93dbee664f93ca80668f85ab346c8e7a4e07db7e "$OUT/result.json"
```

Use the candidate proof helper unchanged with the baseline build to compare.
The helper asserts loopback-only interfaces and a cleared environment. It
observes the real `scanAgentInput` staging and native subprocess without changing
arguments or returned bytes. Only hashes, bounded metadata and classification
notices are retained; raw matches and verification messages are never printed.
The initial single-blob inventory additionally used `--no-verification`. The
canonical source scan retains production flags but has no external interfaces,
so it cannot verify any finding against a live service.

## Observed result and artifact

[results.json](results.json) records the red/green comparison. All four runs
staged the same 135 inputs: complete before/after source blobs, raw diff, full
patch, and controlled prompt. Each completed native scan emitted four unverified
findings: two distinct literals, each in its source blob and added patch line.
Baseline refused; interim narrow policies exposed the independently observed
HTML variants; the final policy classified all four and admitted the input.
The exact native value and whole-line digests, staged-manifest digest, scanner
checksum, completion counters and candidate policy digest are retained.

Five additional real native scans of disposable, locally committed transport
fixtures refused changed bytes, a wrong source path, a changed whole line, and
approved material mixed with unknown or real-shaped synthetic URI inputs. All
five completed with detected findings; none relied on absence of detection.
These controlled negative repositories did not edit the public consumer branch.

Focused regressions cover both fixtures in added, removed and context lines,
PLAIN/HTML, plus changed bytes/lines, wrong paths/modes/references, repeated
literals, mixed unknown and real-shaped synthetic values, wrong detector/raw/
source type/secret parts, verified records, missing verification errors,
incomplete scans, duplicate records and unsupported decoders.

## Limits and Bay disposition

The original hosted failure recorded a count of two and only the first finding
identity. Its omitted second record cannot be recovered from that manifest.
This controlled complete-source run identifies every one of its four records;
it is not a byte-identical replay of the hosted prompt or a claim that the
historical second record was retained. Native PLAIN/HTML deduplication varies.

This proves source admission only: no model call, hosted verdict, GitHub review
publication, deployment, merge or live automation action occurred. A hosted
review must scan its own current prompt, schema and source. OpenClaw Bay is
unaffected: no queue, lifecycle, telemetry, API or dashboard contract changed.
