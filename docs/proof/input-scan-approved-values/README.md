# Input scanner value approvals

Historical proof harness for https://github.com/openclaw/clawsweeper/pull/2201.
The owning implementation is `src/agent-input-scan-classifier.ts`; the host-owned
value identities are in `src/agent-input-scan-approved-values.ts`. Maintainers own
this evidence. Re-run when the classifier, approval data, scanner pin, or Git
staging changes. The PR body records the verified revision and runtime receipt.

The claim is that editing surrounding source does not invalidate an approved
synthetic value, while arbitrary credentials never qualify from their hostname.
The controlled proof exercises the production `scanAgentInput` function and real
checksum-pinned TruffleHog over both prompts and complete committed Git ranges.
It covers an approved value, an unrelated edit, an approved password-only URI,
a changed password, arbitrary
reserved/test/loopback credentials, SQL Server passwords ending in `@example.test`,
Postgres `hostaddr`, Cloud SQL JDBC target selection, and a nonreserved control.

Run in a task-owned development guest with Node 24+, the repository dependencies,
and the repository-pinned native TruffleHog binary on `PATH`:

```sh
pnpm run build
node docs/proof/input-scan-approved-values/run-proof.mjs --out /tmp/input-scan-proof.json
```

The receipt records the observed guest head, dirty state, binary digest, runtime, and
per-scenario admission result. Inputs use synthetic passwords and no working
remote database. The proof stops at admission and makes no model call; focused
tests additionally cover verified findings, scanner completion failures, native
metadata drift, and Git metadata replay. The 92 distinct value pairs and their
observed decoder bindings were migrated from the prior host-owned fixture and
attribution arrays at `8ba1ab445ed086863bbd9749237cfcb7096bae7a`; their source
filenames in the new data are provenance comments, not admission restrictions.
The six prior Postgres pairs are deliberately excluded: the pinned detector can
discard an overriding query password while keeping the approved native identity.
The proof also refuses a normalized Postgres fixture, its query-password override,
and its target override. These findings require source-bound qualification; a
normalized native pair alone is insufficient.

For a native file-only guest, the receipt reports `gitMetadata: "absent"` and null
head/dirty fields only when the source Git marker is missing and Git specifically
reports that the source is not a repository. Other Git failures stop the proof.
Do not substitute the host commit for these guest observations. Bind such a run
to a clean, signed host commit and tree separately: enumerate all tracked paths,
record each path's Git mode, file type, SHA-256 content digest (or exact symlink
target), and verify those entries against the committed blobs. Pass this manifest
privately to the guest and compare every entry before installation and after the
proof and checks. Reject missing, modified, or unexpected source files. Account
explicitly for the guest's generated dependency/build directories; they are not
source-manifest entries. Record the host commit/tree, manifest digest, comparison
results, actual guest Git observations, runtime, scanner digest, and commands in
the sanitized run receipt. A matching file manifest proves current-source
execution, not guest availability of the host's Git history.

With Crabbox's native file-sync route, scope `CRABBOX_SYNC_GIT_SEED=false` and
`CRABBOX_SYNC_GIT_OVERLAY=false` to the single `crabbox run --provider aws
--git-seed-source origin --no-hydrate --timing-json --script-stdin` command. Keep
the ordinary transfer and deletion guards. Check source equality before the
frozen dependency install and rebuild, then again after native proof and checks.
The dependency/build directories (`node_modules`, `dist`, `bin`, and `coverage`)
must be absent before installation; account for their generated contents after
the commands. Exempt only actual Git metadata and the native sync metadata/current
private script from the remaining file inventory. Remove the private script and
fixture and stop the task-owned guest when the consumer exits.

For the OpenClaw trajectory metadata fixture, pass the exact public source blob
as a private input. The harness verifies its Git identity before exercising the
complete source, an unrelated surrounding edit, changed captured userinfo, path
and host, and a mixed approved/unknown value on both admission surfaces. It does
not embed the source literal in this repository or its receipt.

```sh
(
  set -e
  fixture_dir="$(mktemp -d)"
  trap 'rm -rf "$fixture_dir"' EXIT
  chmod 700 "$fixture_dir"
  git -C "$OPENCLAW_CHECKOUT" cat-file blob \
    121ac30b9bfae120aac724ec972a25f42c0a45c8 > "$fixture_dir/fixture.ts"
  chmod 600 "$fixture_dir/fixture.ts"
  node docs/proof/input-scan-approved-values/run-proof.mjs \
    --trajectory-source "$fixture_dir/fixture.ts" --out /tmp/input-scan-proof.json
)
```

The reviewed source literal belongs to a five-string secret fixture collection
used only through `sourceInfo.source` and `sourceInfo.path` in metadata/snapshot
cases. Its fixture-marked username and conventional placeholder password match
the native HTTP(S) userinfo and authority. Preliminary TruffleHog 3.99.4 qualification
reported the exact pair with `BASE64` and `HTML` decoders. A production prompt
scan of the exact fixture subsequently admitted and emitted a post-cleanup
`agent_input_scan_classified` / `approved_value` notice with `PLAIN`. That retained
witness is bound to the fixture blob, approval-table and classifier digests, and
scanner version/binary digest; it carries forward only while those inputs match.
The harness requires successful admission and an approval notice for both the
original prompt and exact committed fixture blob, and records each observed
decoder. The portable value policy does not require a particular qualified
decoder on both surfaces. The committed original preserves the input bytes so
its notice identifies blob `121ac30b9bfae120aac724ec972a25f42c0a45c8`. Only known
producer metadata is projected into the receipt; console forwarding is preserved.
A refusal or missing expected notice stops the proof. This approval covers the captured
synthetic BasicAuth identity; it does not classify omitted query bytes or approve
the other fixture strings as a group. Independent unknown findings still refuse.
