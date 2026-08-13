# Tuple-protocol dead-letter root cause and proof

The 30-row `tuple_protocol_invalid` inventory from reconcile run `31661967301` contains two very different generations of failure. Neither major fingerprint is a `RecordTupleError`: that error embeds `records/<repo>/<number>` in its message, so it cannot produce one digest across different item numbers. The queue reason is broader than the exception class because the batch publisher also maps permanent Worker HTTP 400/413 responses to `tuple_protocol_invalid`.

## Fingerprint `18100482292fa5b48fd215110a0be3a7d261257e337fdd57b748bee5482efac9` (21 rows)

This digest is exactly `sha256("Error:invalid_direct_publication_plan")`. Before [#1091](https://github.com/openclaw/clawsweeper/pull/1091), the Worker returned only that generic text and sent the actual validator detail to inaccessible Worker logs, so the fingerprint is an opacity bucket rather than one causal class.

Nineteen of the 21 rows target `steipete/CodexBar`. Their neighboring first post-#1091 row, `steipete/CodexBar#2817`, retained the now-visible detail:

```text
invalid_direct_publication_plan: direct publication path is outside steipete-CodexBar#2817: records/steipete-codexbar/items/2817.md
```

Its digest is `7f30d065f22d54d58fefc368096e202b862c2a303e8b90303864a49842b1825c`. This is the mixed-case containment bug fixed by [#1100](https://github.com/openclaw/clawsweeper/pull/1100): the expected repository slug preserved GitHub display case while the tuple path was normalized to lowercase, then the Worker compared them with `===`. The 19 opaque CodexBar rows predate that fix and share the same producer shape. The two opaque `openclaw/openclaw` rows cannot be assigned a more specific validator detail from retained Actions evidence because #1091 had not preserved it; they must be handled by current canonical evidence rather than guessed into the CodexBar cause.

## Fingerprint `02bf7196a153893877e10306cc15656861a515b38c70dbc4fa16b6e9faea6e7a` (four rows)

This digest is exactly:

```text
Error:invalid_direct_publication_plan: conflicting direct publication retry
```

The same digest covers pre-#1143 producer runs `31559984058` (`openclaw/openclaw#114173`) and `31560290251` (`openclaw/openclaw#121562`), plus post-#1143 command-originated protocol-v2 runs `31626595070` (`openclaw/openclaw#80396`) and `31626607925` (`openclaw/openclaw#82540`). It is therefore one cause across both sides of #1143, not a command-intake or protocol-version regression.

The retained manifests prove valid protocol-v2 queue claims and lease revisions. The three publication attempts for the two command rows ran in batches `31630188713`, `31631144136`, and `31632050911`. During guarded apply, `openclaw/openclaw#80396` first observed live head `50c3ee264a46a7542c992e716b77d97a0721a64b`, then `65f1b2bc562050d7f96221ddb2b2c23dbc0a114f` on attempts two and three. Source-drift handling rewrites `current_item_updated_at`, `current_item_snapshot_hash`, and a fresh `apply_checked_at`. Once the first attempt had accepted the canonical tuple, later attempts regenerated different tuple bytes under the same exact batch fence and revision. The Worker's immutable direct-plan guard correctly rejected those bytes, but the batch needed the already-accepted receipt only so it could resume lifecycle post-effects.

## Fix

The publication endpoint now treats a terminal canonical receipt as first-write-wins only when the request is the batch-completion route and the current batch still owns the exact target, fence, revision, and claim generation. It returns the stored `deduped` or `superseded` receipt without rewriting canonical content, allowing lifecycle post-effects to resume. Non-batch direct producers keep the strict byte-for-byte conflict guard, and unowned or target-mismatched fences remain rejected.

The dead-letter operator now lets `tuple_protocol_invalid` rows enter the existing newer-head supersede path. All six evidence checks remain: signed canonical envelope and digest, same repository, same item number, pull-request type, `review_status: complete`, and the exact live head. The operator retains the ten-target and 20-row caps and rechecks the live open node/head immediately before mutation. `workflow_cancelled` remains excluded. A tuple row whose source head is still current never reaches supersession and remains eligible for ordinary fresh recovery.

For the 30-row inventory, the expected drain is evidence-dependent and intentionally conservative. Proven older-head rows can retire as `superseded`; current-head eligible rows can re-review and publish through the repaired batch path (or the already-deployed mixed-case fix); unproven stale rows, ineligible rows, and `workflow_cancelled` rows remain open. No reason-only bulk resolution is introduced.

The executable contract is in [`behavior-contract.md`](behavior-contract.md), RED/GREEN results are in [`red-green.md`](red-green.md), and [`run-proof.sh`](run-proof.sh) drives the final Docker-backed Crabbox proof. OpenClaw Bay is unaffected because this changes queue-owned publication replay and operator policy while exposing no queue, workflow, GitHub, recovery, deploy, or rollback control on the observer-only Bay surface.
