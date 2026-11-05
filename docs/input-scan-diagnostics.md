# Inspect an input-scan refusal

- Status: active operator runbook
- Owner: ClawSweeper maintainers
- Source of truth: `src/clawsweeper-review-failure-diagnostics.ts`,
  `scripts/inspect-input-scan-diagnostic.mjs`, and `.github/workflows/sweep.yml`
- Last verified baseline: `openclaw/clawsweeper@385ed215fa2cfd04e53ab11d6cf814b8a3226b85`;
  change proof: [safe refusal diagnostics](proof/safe-refusal-diagnostics/README.md)
- Update when: artifact retention, manifest identity, scan metadata, or the exact-review
  failure summary changes

An input scan can refuse a review without confirming that it found a real secret.
The failed workflow's **Input-scan refusal diagnostics** summary links to its exact
attempt and existing `exact-review-failure-diagnostics-<run-id>-<attempt>` artifact.
The summary contains no scan details. Public PR comments retain their existing
visibility policy. Artifact access still requires GitHub's normal repository and
Actions permissions; do not copy private diagnostic contents into a public issue.

## Read only the manifest

Use a trusted ClawSweeper checkout containing this inspector, Node 24+, and its
normal build (`pnpm install --frozen-lockfile` then `pnpm run build`). Select the
run, attempt, target repository, item and expected source head from the failed
review's trusted request. The workflow repository can differ from the target.
Do not derive the expected identity from the downloaded manifest itself.

Example placeholders below must be replaced before execution. `gh run download`
is an authenticated read; it does not retry the review. Use a fresh empty private
directory so missing downloads cannot leave an older manifest in place.

```sh
run_repo='OWNER/WORKFLOW_REPO'
target_repo='OWNER/TARGET_REPO'
run_id='RUN_ID'
attempt='ATTEMPT'
item_number='PR_NUMBER'
expected_head='FULL_EXPECTED_HEAD_SHA'
diagnostic_dir="$(mktemp -d)"
gh run download "$run_id" --repo "$run_repo" \
  --name "exact-review-failure-diagnostics-$run_id-$attempt" --dir "$diagnostic_dir" &&
node scripts/inspect-input-scan-diagnostic.mjs --inspect \
  "$diagnostic_dir/manifest.json" "$target_repo" pull_request "$item_number" \
  "$expected_head" "$run_repo" "$run_id" "$attempt"
```

For an issue, use `issue` and its trusted expected source-revision SHA-256 digest
in place of `pull_request` and the expected head. The digest identifies the
hydrated issue and comments; it is not a Git commit. If that expected digest is
unavailable, fail closed rather than copying the digest from the manifest. Artifacts expire after 14 days. A missing/expired download, missing manifest,
wrong head/run/attempt, old manifest without run provenance, invalid metadata or
oversized file is a diagnostic failure, not evidence that the scan was clean.
Do not substitute the newest run, another attempt, raw logs or another item's
artifact. Local/non-Actions manifests have no run provenance and this hosted
inspection recipe intentionally rejects them.

The inspector opens only a regular, bounded `manifest.json`; it never reads
`error.txt`, `stdout.error.txt`, `stderr.tail.txt`, source files or scanner output.
It emits only allowlisted metadata. Unknown fields are ignored, while malformed
allowed fields fail closed. Source paths remain hashes (`pathSha256`); no path,
URL, excerpt, matched value, decoded value or environment content is projected.

`unclassified_finding` means **requires classification**, not “confirmed secret”
or “qualified fixture”. `findingCount` is the scan's total; `findingIndex` identifies
the first refused finding, not a complete findings list. `verified: true` records
the scanner's verification state, not an operator conclusion. `native_contract`
means the scanner did not satisfy its completion contract. A null `scan` means no
structured attribution was available; do not infer one.

`scannerLine` is a coordinate in the scanner input. It is **not a proved source
line**, especially for decoded findings and diffs. `sourceCoordinates` remains
`not_proven`. A blob/revision and up to four hashed source references may help
an authorized operator identify the input; the inspector does not convert them
into source paths or line numbers. `referenceCount` can exceed the displayed
reference list.

Inspection never releases `scanner_refused`, qualifies a fixture, disables
verification, invokes a model or requests a retry. Follow the existing
[scheduler hold contract](scheduler.md) after trusted classification and remediation.
