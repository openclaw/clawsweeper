# Git object metadata admission

Claim: generated Git object IDs can be classified without clearing credentials
that native decoding reconstructs from source content. The host keeps its complete
primary scan unchanged. Exact raw-diff, endpoint, path, mode, and rehashed full-blob
witnesses only request another native scan; they never admit a review by themselves.

The supplemental complete patch or raw diff masks only proven object-ID fields at their
original lengths. Filename context and all content bytes remain unchanged. It uses
the same pinned native scanner, verification flags, completion checks, and shared
deadline. Any unclassified finding, further metadata request, or incomplete scan
refuses admission. Success notices follow both scans, cleanup, and source fences.

Raw-diff findings use the same witness owner, including canonical added and deleted
regular files. Both materials must agree on full object IDs, file modes, paths,
change status, and endpoint presence; every present blob is independently rehashed.
Matching bytes in content or paths, malformed or duplicate records, unexpected
references at an absent endpoint, and missing patch witnesses still refuse.
The complete original raw diff remains in the primary scan and retained provenance.
Its supplemental copy is marked as proof material and cannot qualify another finding.

The regression from OpenClaw PR 156363 was reported by hosted TruffleHog 3.97.4 as
detector 58, PLAIN decoding, unverified, raw-diff line 1. The safe hosted artifact
does not retain matched digests, so exact hosted Raw/RawV2 identity cannot be recovered.
A verification-enabled local scan of that original hosted range with the normal
results filter emitted no findings; a diagnostic scan that also reported unverified
results matched complete Git blob IDs with versioned patch filenames. That diagnostic
does not prove hosted admission or recover the hosted finding identities.

The controlled native added/deleted-file fixture does reproduce the raw-diff
rejection. On macOS arm64 with Node 26.9.0 and checksum-qualified TruffleHog 3.97.4,
the pristine `60a77566c685fbe18600595a28964e5bd8135878` owner refused the same
committed fixture as detector 58 / PLAIN / raw-diff line 1 in 2.06 seconds; the
candidate admitted after replay in 3.34 seconds with a native raw-diff finding.
A literal additional-input collision still refused in 1.82 seconds. Tag-split
and hexadecimal-entity additional inputs also refused as separate HTML findings
in 2.16 and 1.81 seconds. Verification flags were unchanged.

Build the candidate and a trusted checkout of the pinned baseline, then run:

```bash
node docs/proof/agent-input-scan-git-metadata/run-raw-diff-proof.mjs \
  /path/to/raw-diff-proof.json /path/to/built-baseline
```

The driver requires an actual native raw-diff finding; a finding-free scan cannot
stand in for the admission proof. Owner tests separately inject the native report
shape to cover residual/verified findings, scan errors, and incomplete completion.

A review concern about a raw-diff finding hiding a decoded finding in another input
was rejected against the pinned native implementation and the cross-input proof.
[The v3.97.4 deduplication key](https://github.com/trufflesecurity/trufflehog/blob/v3.97.4/pkg/engine/engine.go#L1339)
includes detector, Raw, RawV2, and source metadata;
[the filesystem source](https://github.com/trufflesecurity/trufflehog/blob/v3.97.4/pkg/sources/filesystem/filesystem.go#L396)
stores each staged filename in that metadata. Separate raw-diff, patch, blob,
prompt, and additional-input files therefore cannot erase one another's findings.
The existing replay still protects same-input decoded content and metadata ambiguity.
OpenClaw Bay and public action surfaces are unchanged.

When the same patch contains an approved URI, its source witness uses the retained
primary patch only after the host binds the supplemental path, input identity,
revisions, and exact derived masked bytes. The native input remains masked. Changed
hunks, stale associations, and unreviewed or verified URI findings still refuse.

```bash
pnpm install --frozen-lockfile
pnpm run build:node
csw_scanner="$(node scripts/setup-review-tools.mjs --timeout-ms 120000)"
node --test --test-name-pattern='^(Git object metadata|metadata admission|metadata replay|metadata owner|approved URI findings in unchanged patch context|patch admission keeps)' test/agent-input-scan.test.ts test/agent-input-scan-git-metadata.test.ts
PATH="$(dirname "$csw_scanner"):$PATH" node docs/proof/agent-input-scan-git-metadata/run-proof.mjs /path/to/proof.json
```

To include the original dependency update, append its isolated checkout and exact
source range to the proof command:

```text
/path/to/openclaw 47d9a40df0afa279da03cc08e14031d05738d456 b87e5b75ffcf4386e01789b512e53d73b94437da
```

The native matrix requires the metadata-only case to pass, and tag-split, hexadecimal
entity, decimal entity, URL-encoded attribute, zero-width, and additional-input copies
to refuse. No decoded fixture blob contains the literal object ID. The Git filename
supplies the detector keyword, so full-blob scanning alone cannot protect against a
decoded patch finding being attributed to an unrelated metadata occurrence.
Owner tests also require the supplemental invocation, unchanged primary bytes,
preserved content, and refusal of verified results, missing completion, and scan errors.
The shared-object proof uses two modified files with the same URI-free old blob.
One path supplies Cloudflare detector context; the other adds the existing approved
URI lines in its unique new blob. Metadata masking therefore reaches both patch
sections without adding an unapproved URI alias or changing fixture policy.

[The shared-object driver](run-shared-oid-proof.mjs) requires both native detector
classes and a primary metadata-proof classification before it invokes the unchanged
baseline and candidate owners against the complete committed source:

```bash
PATH="$(dirname "$csw_scanner"):$PATH" node docs/proof/agent-input-scan-git-metadata/run-shared-oid-proof.mjs /path/to/shared-oid-proof.json /path/to/baseline-runtime "$csw_scanner"
```

The driver verifies the scanner against the existing checksum-pinned bootstrap
for the current platform and records the actual executable digest. Keep its cache
outside the candidate and separately built baseline checkouts. It requires both
native detector classes, no verified findings, baseline refusal as
`material_not_reviewed`, and candidate admission after complete primary and replay
scans. Verification flags stay unchanged. The receipt records counts, notices,
source identities and results; a single-path probe without both detectors is not
a reproduction of this composition bug.

The existing failure is tracked upstream in
[TruffleHog issue 3266](https://github.com/trufflesecurity/trufflehog/issues/3266).
Pinned native source confirms that
[HTML extraction](https://github.com/trufflesecurity/trufflehog/blob/v3.97.4/pkg/decoders/html.go)
changes text and line positions; its
[result deduplication](https://github.com/trufflesecurity/trufflehog/blob/v3.97.4/pkg/engine/engine.go)
includes source metadata but supplies no original-byte mapping for decoded matches.
The proof uses that native implementation instead of duplicating its decoder.

This runs the real scanner against controlled Git fixtures and optionally the full
original source range. It neither executes a model nor replaces the hosted review's
own prompt, schema, or source scan. Output contains classifications, safe diagnostics,
and digests, never matched values. OpenClaw Bay and public action surfaces are unchanged.
