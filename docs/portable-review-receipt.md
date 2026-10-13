# Portable review receipt v1

- Status: proposed producer contract; no exporter or enforcement is enabled
- Owner: ClawSweeper result-contract maintainers and agent-skills maintainers
- Source of truth: [receipt schema](../schema/portable-review-receipt.v1.schema.json)
- Baseline: ClawSweeper `bd129c3395197feb345b67e7f6ec8d43c2e1063a`; agent-skills `3f33c6d705fd3d57e36a21a42d7ccfca77643f51`
- Update when: either producer adopts the contract, input collection changes, or a schema version changes

This contract describes a prospective portable result from autoreview or local
ClawSweeper. Current commands do not emit it. It neither replaces native output
nor adds a reviewer, credential, service, or dependency. The object can serve as
a review-specific predicate in an [in-toto statement](https://in-toto.io/Statement/v1);
it is not itself a signed statement.

The schema identifier names the contract. It is not a promise of a hosted schema
endpoint. Consumers should ship the schema with the producer version they support.

## Facts and unknowns

Keep these facts separate: the producer reports a completed assessment; a
repository accepts its result; its input matches a submission; and separate
tests or real-behavior evidence prove runtime behavior. None implies another.

Every receipt is self-reported. Matching hashes bind bytes, not honest execution,
quality, author authority, or instruction compliance. A contributor receipt must
not independently suppress hosted review, increase allowance, or authorize merge.
Signing and trusted execution are outside v1.

Required nullable fields preserve an unobserved value as `null`. Missing telemetry
is not zero; an unknown model is not the requested model. Receipt creation must
not infer a policy, instruction, configuration, or tool revision from a current
file that was not the reviewed input. Preserve the actual source snapshots.

`producer.version` and `producer.revision` identify the wrapper. Record the
observed harness version separately in `execution.harness_version`; a wrapper
revision cannot identify the installed harness. An unobserved harness version
stays null and prevents a claim of full input equivalence.

`execution.completion` reports the producer's assessment completion. It does not
mean clean. Keep `result.namespace`, `native_status`, and `threshold` together:
autoreview's `filtered` result can exit zero; ClawSweeper's outer `completed` status
can contain findings. Do not translate either into a shared clean/pass value.
Finding counts describe the native result, not independent verification or
finding disposition. Runtime proof and finding disposition remain separate.

## Source and input identity

Repository identities use `hostname/owner/name`, without scheme, credentials,
query, fragment, or a local path. `repository` is the reviewed source repository;
`target_repository` is the intended target and policy owner. A fork cannot borrow
its upstream's authority. An unknown identity remains `null`.

Record the Git object format and resolved commit/tree identities, not moving ref
names. `merge-base-range` means resolved merge base to head; `parent-commit` means
one commit's parent tree to that commit. A root commit has a null base commit and
the appropriate empty-tree identity. Object IDs must match the declared hash
format; schema syntax alone does not check this relationship or object existence.

`local-stages` records a captured local assessment. Its head identifies ancestry,
not the dirty result. `stages` explicitly records included committed, index,
working-tree, and untracked states. Omitted stages are excluded. A dirty receipt
cannot certify a later commit by replacing its head ID. Initial submission
comparison supports only clean committed ranges; later dirty-to-commit reuse
needs separately reviewed equality and normalization rules.

`source_manifest_sha256` binds the selected source records below. It does not
claim that every repository file was supplied or read. `coverage_notes` records
known omissions and limits without including raw source. `context_sha256`,
`policy_sha256`, `instructions_sha256`, and `review_config_sha256` bind separately
captured inputs. A null identity prevents a claim of full input equivalence.

### Source manifest v1 bytes

The manifest is an object with exactly `schema_version: 1` and `entries`. Each
entry has exactly `path`, `stage`, `mode`, `content_sha256`, and `git_object_id`.
Paths are case-sensitive repository-relative Git paths, with no absolute prefix,
`.`/`..` components, NUL, or backslash separators. Do not normalize Unicode.
Reject invalid Unicode rather than replace it. Stages are `base`, `committed`,
`index`, `working-tree`, or `untracked`.

Sort entries by the UTF-8 bytes of `path`, then this stage order: base, committed,
index, working-tree, untracked. Reject duplicate path/stage pairs. Mode is the
six-digit Git mode, or null for an absent path. Hash the exact bytes supplied to
the review in `content_sha256`; record their Git blob/object ID only when known.
Absent paths have null mode and null content/object identities. Do not run Git
filters merely to obtain a receipt. Raw working bytes and normalized committed
bytes remain distinct records when their bytes differ.

Canonicalize using the [JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
restricted to null, booleans, strings, arrays, objects, and safe integers. No floats,
non-finite numbers, duplicate object keys, or unpaired surrogates are allowed.
Object keys sort by UTF-16 code units; array order is significant. Emit UTF-8,
compact JSON, no BOM, and no final newline. JSON escaping follows JCS. The hash is:

```text
SHA256(UTF8("openclaw-review-source-manifest-v1\n") || canonical_manifest_bytes)
```

The domain separator includes exactly one LF. A future manifest version uses a
new domain and schema; it must not reuse v1 with different collection semantics.
[Golden fixtures](../test/fixtures/review-receipt/source-manifest.json) freeze the
canonical bytes and digest for independent Python and JavaScript producers.

Other digest fields are SHA-256 over the exact retained input/report bytes. They
must refer to the bytes actually supplied or published, not a reserialized or
later redacted substitute. A hash of the receipt itself is external to the object
and covers its exact published bytes; never add a self-referential hash field.

## Usage namespaces

`usage.namespace` identifies the native accounting contract. `scope` identifies
process-attempt aggregation, a native record, or unknown scope. Nullable attempt
counts and completeness must stay unknown when a producer does not observe them.
Input totals include cached input; output totals include reasoning output where
the native provider says so. Do not add subset fields to totals again.

Autoreview already aggregates last observed cumulative snapshots once per process
attempt, including failed attempts. Its missing cache-write field maps to null,
not zero. ClawSweeper's usage record includes `cache_write_input_tokens`; retain
it. A ClawSweeper native record covers one `runAgentProcess` capture, summing the
last cumulative totals per session. It does not establish whole-assessment
accounting, aggregate attempt counts, or completeness. Preserve native scope,
partial results, and unknowns.

## Compatibility and future verification

v1 is additive and opt-in. Existing autoreview status v1 and ClawSweeper local
JSON/text outputs remain unchanged. Strict consumers reject unknown versions,
unsupported comparison modes, and unexpected fields. They must not restamp or
upgrade old receipts. `null` never becomes a defaulted observation.

Future transport parsing must cap input at 64 KiB, nesting at eight, strings at
2 KiB, and arrays at 128, and reject duplicate keys before conversion to an
object. JSON Schema describes structure; it does not enforce the total byte or
nesting budgets, Git-object relationships, telemetry arithmetic, or source truth.
There is no verifier in this change.

Future input comparison must consider source and target repository, comparison
mode, object format, base/head trees and commits, selected stages, worktree state,
manifest, context, policy, instructions, review configuration, wrapper revision,
and observed harness version.
Unknown required identities yield unverifiable, not matching. SHA-only equality
is insufficient. Role, eligibility, findings disposition, and runtime proof are
separate policy decisions, never consequences of parsing a receipt.

PR-body transport and its narrowly scoped machine-block normalization belong to
the later verifier rollout. This contract does not change current body hashes.

## Fixtures and validation limits

The autoreview and ClawSweeper fixtures are synthetic examples of current native
output shapes beside prospective receipts. They are not captured model runs,
proof of exporter support, or execution attestations. Both select the same source
manifest but declare different native outcomes and accounting scopes; neither
claims equal context or review quality.

The contract test checks frozen canonical bytes, independent Python/JavaScript
hashing, source identity, and preserved native outcome/usage distinctions. It is
not a JSON Schema validator. Full draft-2020-12 validation requires a standard
validator; none is added as a project dependency by this change.
