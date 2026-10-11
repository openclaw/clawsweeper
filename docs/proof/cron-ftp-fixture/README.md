# Completion-webhook FTP fixture qualification

Status: historical proof for this exact fixture qualification. The policy owner
is `src/agent-input-scan-fixtures.ts`; the native entry point is
`src/agent-input-scan.ts`. The candidate is based on ClawSweeper
`32cd4db41a50b57f301a955bd0e291cbfeb714e1`.

## Claim and exercised surface

The host input gate may classify the existing synthetic warning-redaction fixture
in [OpenClaw PR #161161](https://github.com/openclaw/openclaw/pull/161161) only when
FTP detector 899, the observed PLAIN/HTML decoder, both native value digests, the
complete source-file SHA256, complete line for every occurrence, original path,
regular-file mode and committed base/head reference match. Native metadata must retain empty `RawV2`, exactly `key=Raw`
secret parts, null extra/structured data and an unverified result with a
verification error. The OpenClaw fixture and scanner flags are unchanged.

## Native before/after proof

On macOS arm64 with Node 26.10.0, pnpm 12.4.1 and checksum-qualified TruffleHog
3.97.4, the existing proof entry point scanned the complete committed range with
verification enabled:

```sh
node docs/proof/agent-input-scan-context/run-proof.mjs \
  <clean-openclaw-checkout> \
  28885d3f8745f51e39ecb54389283dc391c15381 \
  226302c6ef7b496ced68f69f917669cd8a18f7ed \
  <receipt.json>
```

The original policy [refused](before.json) the range with an unclassified FTP
finding. An HTML-only qualification also refused an observed PLAIN finding; both
native variants therefore need the same exact qualification. The first candidate
[admitted](after.json) the unchanged range in 4.044 seconds, reporting HTML for
both committed blobs. PLAIN was also observed during the native qualification,
including the original refusal. The [native identity receipt](identity.json)
records the independently inspected finding shape without matched values.

## HTML source binding

The committed-branch review found that a second, HTML-encoded occurrence could
retain the same native authority and evade the plain literal search. The canonical
scanner [reproduced that admission](html-before.json): an HTML-marked synthetic
source retained the approved plain line and an entity-encoded occurrence on a
different line. Its HTML finding was incorrectly attributed to the plain line.

The policy now pins the complete bytes of the two inspected source blobs. It
hashes the actual staged bytes and filters the same attribution rows used for
line, path and mode checks. Any byte change, even unrelated to the fixture, needs
explicit requalification. This deliberately conservative boundary avoids a second
HTML decoder or a new replay policy.

The [source identity receipt](source-pins.json) shows that both original source
blobs remain byte-identical in the refreshed OpenClaw range
`2fc693e33eff44730a0113d33f8f68b1642db0a3..340c1ff4441b3c5e8b573c41c7c319df46ddec81`.
The same native command with these new base/head arguments
[admits that range](source-pins-after.json) in 2.841 seconds. It reports HTML for
both blobs under the production policy. Both observed decoders are covered
deterministically by the classifier tests.

Reconstructed synthetic Git sources have the same complete blob IDs as the
retained failing reproduction. The fixed native gate
[refuses the extra HTML occurrence](html-after.json) in 2.516 seconds and
[refuses the encoded-only control](html-only-after.json) in 2.230 seconds with
`source_not_reviewed`. No scanner or verification flag changed.

The focused regression passes 30 reported cases in 0.57 seconds wall time. It accepts both
observed variants and rejects changed host, credential, query, complete line,
path, file mode, source role/kind, decoder, detector, verification and native
metadata. Additional occurrences on an unapproved line, incomplete scans,
duplicate findings and FTP patch material also fail. It additionally refuses
HTML-encoded extra occurrences, unrelated source-byte changes, missing/malformed
source pins and a line-only replica under the production policy. Its small
algorithm fixtures use the existing custom-attribution argument with frozen
source hashes; the native proof above exercises the actual production pins.
The original policy failed
the positive regression; the additional-occurrence case failed before the
qualification reused the existing whole-blob literal witness check.

## Scheduler-routing coverage requalification

[OpenClaw PR #161703](https://github.com/openclaw/openclaw/pull/161703) adds routing
coverage without changing the synthetic fixture. The exact line witness remains
`47389a842fa9b1a3cb74c54ab2455b02b9cb0bd41c4b832eaf83aa52fbccbdc8`, moving from line
769 to 844. The reviewed head file has SHA256
`9e9ec747fe268991cde3f65280c0b4480e9d7748b9e9ce4d539a28f6f8fc23a1`.

On ClawSweeper `ce985956ca4f3dd962f87ef2e841fee83a7816cc`, the existing native proof
runner [refused the complete committed range](161703-before.json)
`b9a2236578c39079b067a642f0956638567fe7ba..c07112b4c58763176de2021f1c310641b2a8ab81`.
Adding only the new complete-source hash [admits that same range](161703-after.json),
with canonical verification enabled. Both base and head produce the existing HTML
FTP attribution. The exact same qualified source pair at a different path
[remains refused](161703-foreign-path.json), as does an otherwise identical head
with an [unqualified source-byte change](161703-changed-source.json). These controls
use complete, clean synthetic Git sources and the production policy.

Proof ran on macOS arm64, Node 24.21.0 and pinned TruffleHog 3.97.4. All 30 existing
FTP classifier cases also passed, covering both native decoder shapes and changed
literal, metadata, path, mode, and occurrence controls. No detector, matcher,
verification flag, queue, status, or Bay contract changes are involved. This source
qualification does not complete a hosted review or release its hold.

## Webhook outcome integration requalification

The same PR receives the canonical webhook-outcome coverage and moves its existing
payload/presentation case to the presentation test owner. The synthetic FTP line
is unchanged, with the same complete-line witness above, now at line 854. Its new
complete source SHA256 is
`64919155ae619bb0159a37d7ea97b6aba473671c50120cf78be7c27f8a15dae4`.
Only that hash is added; the existing base hash remains qualified.

Using ClawSweeper `74dc4c6a2fc204e456fb92677ca9271af104e9cc`, the maintained native
runner [refused the complete committed range](161703-webhook-native-before.json)
`b9a2236578c39079b067a642f0956638567fe7ba..028a1c3970f0353be974db89844da73215d967ca`
with `source_not_reviewed` for head blob
`6995635c757edddf9f538b3734fce12b71a1e806`. The single-hash addition
[admits that same range](161703-webhook-native-after.json) with verification enabled:
HTML for the base at line 769 and PLAIN for the head at line 854, one occurrence each.
No protected-main source hash is added speculatively.

The same complete source pair at a foreign path
[remains refused](161703-webhook-foreign-path.json). An otherwise byte-identical
qualified head with one extra newline
[also remains refused](161703-webhook-changed-source.json). Both controls use the
existing runner and clean synthetic Git sources. All 30 existing FTP classifier
cases pass, including the native metadata and whole-source negative controls.
Proof ran on macOS arm64, Node 24.21.0, and pinned TruffleHog 3.97.4. The detector,
raw-value digests, line/path/mode/ref/occurrence checks, native verification, and
scanner flags are unchanged. Bay and hosted queue/publication contracts are
unaffected. This proof does not complete a hosted review or release a hold.

## Receiving merge-base qualification

The verified receiving merge changes the actual review base to
`e1b701b44da537b740c10ae01f7652ee1712e913` and the head to
`3b9da2643fd25f22cf6c4af0f25f1cb27e0a7a8c`. The head still contains qualified blob
`6995635c757edddf9f538b3734fce12b71a1e806`. The actual base now contains blob
`c9ad3bf550d7f4cdf9c8b9062312fc70767865d3`, with the unchanged fixture witness once
at line 807 and complete-source SHA256
`e181c69bd874b3e50d70631a6f1a94eed2308d765f05046ec66a84089a62c7cb`.

The maintained native runner on ClawSweeper
`d7fd40ed0f8e8283c0c91c3b7c94f3c485bb608a`
[refused this exact committed range](161703-receiving-native-before.json) with
`source_not_reviewed`, explicitly identifying that base blob and revision.
Adding only its complete-source hash
[admits the same tuple](161703-receiving-native-after.json), with one PLAIN finding
for each role: base at line 807 and head at line 854. Verification stays enabled.
The earlier `b9a2236..028a1c3` result remains evidence only for its original tuple.

The identical newly qualified pair at a foreign path
[still refuses](161703-receiving-foreign-path.json). Appending one newline to the
newly qualified base source, while retaining the qualified head,
[also refuses in the base role](161703-receiving-changed-source.json). Both controls
use clean synthetic Git sources and the same production scan entry point.
All 30 existing FTP classifier cases pass. Proof uses macOS arm64, Node 24.21.0,
and pinned TruffleHog 3.97.4. Detector, decoder, literal, line, path, mode, ref,
occurrence, native verification, and complete-source checks remain unchanged.
No Bay, queue, or publication contract changes are involved.

## Destination-owner final-source qualification

[OpenClaw PR #168996](https://github.com/openclaw/openclaw/pull/168996) retains the
same synthetic FTP warning-redaction fixture. Its frozen receiving tuple is
`b5a9b9b41c343f4a11c44dd511a49c348f63d704..c407dec21ac280710a2bec2c0ff524139e00b94c`.
The [source identity receipt](168996-source-identities.json) records the complete
base and head files, both at `src/gateway/server-cron-notifications.test.ts` with
mode `100644`:

| Role | Blob | Complete-source SHA256 | Fixture line |
| --- | --- | --- | --- |
| Base | `4bdb2e246f6859f49ae0312d79900e175050cbc6` | `dae36fe07e5b25c4c2f306a9a7e5ceaa0a8967d0789c9677b4e7a9eb6b7668c7` | 684 |
| Head | `d5b62b493f2bd24a8e65e8604062bb5b43b785d3` | `f42428917e28d417c8a6d7867d7abdb3d1ee76e2d9fce6f93965f319e0fcd061` | 732 |

On ClawSweeper `27fbecbbe4a92831a667e76fff1b73412ef89b14`, the maintained native
runner [refused that exact range](168996-native-before.json) with
`source_not_reviewed`, identifying the base blob. Adding only these two source
hashes [admits the unchanged range](168996-native-after.json) in 3.784 seconds.
The final native scan reports one PLAIN FTP finding per role at the lines above.
The complete-line digest remains
`47389a842fa9b1a3cb74c54ab2455b02b9cb0bd41c4b832eaf83aa52fbccbdc8`.

The same complete source blobs [remain refused at a foreign path](168996-foreign-path.json).
Appending one newline to the head file [remains refused in the head role](168996-changed-source.json).
These controls use clean, complete synthetic Git sources and the same native
production entry point. All 30 existing FTP classifier cases pass, covering
PLAIN and HTML, native metadata, source identity, and occurrence controls.

Proof ran on macOS arm64 with Node 24.21.0, pnpm 12.4.1, and pinned TruffleHog
3.97.4. Detector 899, both decoder rows, native Raw/RawV2 digests, full-line,
path, mode, committed-ref, occurrence, and verification checks are unchanged.
No scanner flag, policy bypass, test exclusion, Bay, queue, or publication
contract changes are involved. This admission proof does not itself complete
a hosted review or release a review hold.

## Limits

This is source-admission proof with a controlled prompt. It does not run a model,
complete a hosted review, release its hold or authorize a merge. Hosted review
must rescan its own source, prompt, schema and other inputs. PLAIN/HTML selection
can differ between native scans; neither label permits different fixture bytes.

No queue, status, or publication contract changes are involved.
Requalify if any source-file bytes, fixture location, scanner version or the host source-binding
contract changes. No test file or input range is excluded from scanning.
