# Autoreview literal fixture under BASE64 labeling

Lifecycle: historical baseline observation and completed bounded candidate proof,
September 25, 2026. Hosted review must still scan its own current complete inputs.

## Input identity and observed result

The instrumented Linux x64 packet `pr294-linux-capture-ijk3mbd7` used Node
24.21.0, TruffleHog 3.97.4 with normal verification, and the existing source
admission runner. The host tree at `7651efc8d018516b8df2759c435f1ad6ce4a8153`
matches merged ClawSweeper `726760a4e31bd88b10982908e042f59f01c7a18b`, the
baseline for this qualification. Its fixture-policy source SHA-256 is
`eee064940f4678b21505a68de3e7b326cd182060c777b039f4cf2698bd0d8b3d`.

The complete agent-skills range for
[PR 294](https://github.com/openclaw/agent-skills/pull/294) was base
`3030d66592c1288452cba8ff80206a4cb512f9ba` to head
`267a6a0e21fe2667bb973c7eb697722e0f278ffb`. Independent byte/source assessment
checked all 13 staged materials and all eight literal occurrences across the
seven emitted findings. The first native finding was an unverified URI detector
17 record labeled `BASE64`, in head blob
`e043a5e53abf3479da96ac101800e6879423d7cd` at line 5602 of
`skills/autoreview/tests/test_autoreview_hardening.py`, mode `100644`.
The same literal source line occurs in base blob
`c1de717504d47d854f5abd189bf61be98242d0f6` at line 5752; that base occurrence
was not separately emitted under BASE64. The other six native findings were
already-qualified PLAIN records. All seven findings came from blobs, not patches.

The native scan exited 183 with one matching completion record and both output
streams at EOF. The baseline classifier refused the first finding. The packet
retains hashes and safe metadata, not raw scanner values. It reproduces the
retained hosted finding shape without proving the hosted finding's undisclosed
Raw/RawV2 identity. Instrumentation forwarded scanner output unchanged, but
Python startup added `LC_CTYPE` to the minimized environment. The controlled
prompt omitted the hosted schema and discussion, so this is not a byte-identical
hosted replay.

## Exact qualification

All three rows require URI detector 17, decoder `BASE64`, mode `100644`, and
both Raw and RawV2 SHA-256 equal to
`662a886a0fd7447dad0acda3aeccc9eb539fc90438b453de7e2f523ca7ee6c83`.
The complete source-line witnesses, excluding LF but retaining every other byte,
are:

- A: `1a0920c31a227ead081fd2e6582572dfee060995e266a5520f66021acaa918c9`.
- B: `eb4b4694b1c0d3a50371cc30fad8c967ca2bd82920ffb5f1077f29a18a394219`.

| Exact source                                                   | Ordered witnesses | BASE64 evidence                                          |
| -------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| `skills/autoreview/tests/test_autoreview_hardening.py`         | A                 | Native head finding; base literal statically checked     |
| `.agents/skills/autoreview/tests/test_autoreview_hardening.py` | A                 | Static source qualification and classifier controls only |
| `.agents/skills/autoreview/tests/test_autoreview_hardening.py` | A, B              | Static source qualification and classifier controls only |

The vendored forms were byte/source-qualified during the
[historical acpx qualification](../acpx-autoreview-fixtures/README.md) and
independently rechecked for this change. Those inputs are acpx base
`a7410abdf67dda4aa06db6b92bf57e007e67459e`, blob
`8ed5acee1791b128c7d7a69132afd83fa0533ed4` at lines 3064 and 3075, and head
`6151f4f4d0fd9d4d63590b6ceb95d309e5752266`, blob
`c1de717504d47d854f5abd189bf61be98242d0f6`. They are not natively observed
BASE64 findings. These pins identify qualification inputs, not new runtime rules.

The finding's full value is present literally in pinned source. BASE64 labeling
does not permit encoded-only content without that literal. Every occurrence must
match one complete ordered witness set, and every retained source reference must
qualify. Removing B can select the separately approved A row; removing A or
reordering A/B cannot. The shorter native prefix has no BASE64 row.

The only production changes are the decoder type, three static rows, and a
separate validator clause for BASE64/URI17 at the two exact paths. All other
source/decoder guards, literal matching, legacy fallbacks, staging, provenance,
scanner arguments, verification, completion checks, and public diagnostic shapes
remain unchanged. Patch BASE64 findings still refuse before witness resolution;
refusal diagnostics still describe BASE64 as `OTHER`.

## Proof contract and limits

Focused local classifier checks use Git-generated materials and constructed
scanner records with Node 24.21.0 and pinned pnpm 12.4.1:

```sh
pnpm run build:node
node --test --test-name-pattern='autoreview BASE64' test/agent-input-scan-fixtures.test.ts
node --test test/agent-input-scan-fixtures.test.ts
```

The baseline must refuse each new admission case; the candidate must admit the
three exact blob forms for base/head roles. Controls cover changed native values,
lines, order and occurrence counts, unqualified paths/modes/references, verified
findings, other decoders, unlisted prefixes, encoded-only content, duplicate
records, incomplete scans, and unchanged non-blob refusal. Existing PLAIN/HTML
fixtures and legacy BASE64 behavior must retain their prior results. These are
classifier checks, not native scanner proof.

Observed classifier comparison: the unchanged baseline refused all eight new
admission cases; three duplicate-record controls stopped earlier at
`finding_not_reviewed`, and the other 15 cases passed. The candidate passed all
26 focused cases, all 321 cases in the fixture file, and all four existing named
BASE64 controls. These classifier results are separate from the native observations below.

## Executed native qualification

The [complete sanitized native record](autoreview-base64-native.json) retains
one fresh baseline scan and one candidate scan on a single configured AWS lease,
using frozen external source snapshots and runtimes, Linux x86_64, Node 24.21.0,
and checksum-qualified TruffleHog 3.97.4. The candidate policy source SHA-256 is
`c698a8490be6f285095678cd0b52e2f847c84ee063f48fdb11eef05976d59701`;
its compiled owner module SHA-256 is
`dd7acc464d394a0d1e4b1f03454ab3d8d1cccf02b65cf2a415ff0dda277400c0`.
Only that runtime module differs between variants. The existing runner used the
same complete source range and normal verification in both invocations:

```sh
node docs/proof/agent-input-scan-context/run-proof.mjs \
  /path/to/clean-agent-skills-at-head \
  3030d66592c1288452cba8ff80206a4cb512f9ba \
  267a6a0e21fe2667bb973c7eb697722e0f278ffb \
  /path/to/native-admission.json
```

| Observation             | Findings and decoders        | Admission | Canonical BASE64 row exercised      |
| ----------------------- | ---------------------------- | --------- | ----------------------------------- |
| Earlier native baseline | Seven: one BASE64, six PLAIN | Refused   | Actual fixture observed and refused |
| Fresh native baseline   | Seven, all PLAIN             | Admitted  | No                                  |
| Native candidate        | Seven: one BASE64, six PLAIN | Admitted  | Yes                                 |

The candidate emitted and qualified the actual full-value BASE64 identity at
canonical head line 5602. The fresh baseline instead emitted an additional
PLAIN identity `05ac498c28c2d5ac33d1623fa344fa9dfc5e74ac56fef091df3ab4886ad44de1`;
it did not emit the BASE64 identity. Equal counts therefore do not establish
equal finding sets. This pair is not a fresh refusal-to-admission reproduction;
the [earlier native refusal](autoreview-base64-historical-refusal.json) remains
separate, and its normalized source-material identities match the candidate's.
The capture's aggregate qualification flag remains false because the fresh
baseline did not exercise BASE64; its candidate-specific exercise and admission
fields are true. No missing finding is treated as cleared.

All 13 staged materials match independent Git reconstruction and retain the same
bytes, modes, and references across variants. Every emitted RawV2 occurrence was
located independently in source bytes. Both scanners exited 183 after complete
scans: 182 chunks, 2,304,195 scanner-processed bytes, zero verified and seven
unverified findings. That byte counter differs from the 1,789,726 staged bytes.
Native waits, both EOFs, completion records, exact stream forwarding, and frozen
source/runtime/tool hashes were checked. The official Linux archive matched the
trusted and upstream checksum; binary SHA-256 is
`95c2a42bce979fce6dd73cc629b37ae4d72731b0dc16e047fba41a77bc765620`.
Temporary raw source, staging, and runtime inputs were removed; provider
inspection confirmed the lease released with cleanup complete and no remaining
provisioning resource.

The external capture wrapper forwarded original streams and exit unchanged,
retaining only safe metadata and hashes. Its instrumentation, including added
`LC_CTYPE`, the controlled 71-byte prompt, and absent schema remain explicit
limits. Vendor BASE64 rows retain static/classifier evidence only; patch BASE64
remains refused. No model call, hosted retry or clearance, deployment, historical
hosted raw-identity match, or exhaustive descendant containment is claimed.
OpenClaw Bay is unaffected: no queue, status, API, dashboard, publication, or
observer contract changes.
