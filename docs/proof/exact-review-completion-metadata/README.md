# Lost completion callback proof

The production Worker and ExactReviewQueue were exercised on AWS Crabbox with
Node 24 and local Wrangler/workerd SQLite. Only initial lease setup and state
inspection use proof seams; publication, completion, reconciliation, signatures,
and lifecycle transitions use the production paths.

The same three scenarios run before and after the fix:

| Scenario | Main at `0d07398d4fab` | Fixed branch |
| --- | --- | --- |
| Completion delivered | One fresh source-drift revision | Same |
| Completion lost, accepted receipt | Owed review deleted | One fresh source-drift revision |
| Completion lost, superseded receipt | Completes without another review | Same |

Requeue disposition leaves Bay outcome tables and its public snapshot unchanged.
A separate workflow replay executes the real failure-annotation shell: a lost
queue callback is reported as `queue_completion_failure`; a failed review remains
`codex_or_content_failure`.

## Reproduce

The immutable drivers remain in the contributor's original commit, keeping
one-off proof scaffolding out of the maintained runtime and test tree. From a
checkout with dependencies installed:

```sh
mkdir -p .artifacts/completion-proof
proof_ref=138eacf9b30ced7465be928d9d6022f5647fa7d9
proof_path=docs/proof/exact-review-completion-metadata
git fetch origin "$proof_ref"
git show "$proof_ref:$proof_path/run-proof.sh" > .artifacts/completion-proof/run.sh
git show "$proof_ref:$proof_path/annotation-proof.mjs" > .artifacts/completion-proof/annotation.mjs
COMPLETION_METADATA_PROOF_SKIP_INSTALL=1 bash .artifacts/completion-proof/run.sh
node .artifacts/completion-proof/annotation.mjs
```

The runtime driver writes `proof-summary.json` and `transcript.md` under
`.artifacts/exact-review-completion-metadata`. Run it from the baseline and
candidate checkouts separately. It uses disposable SQLite and synthetic items,
with no production credentials or state mutations.

## Limits and evidence

The proof supplies the same terminal-run payload as the GitHub reconciler;
it does not exercise GitHub's run lookup or induce a production queue outage.
Local workerd proves the storage and HTTP behavior, not Cloudflare edge
availability. The annotation replay evaluates the workflow expressions locally.

Provider, lease, image, exact revision, commands, results, and subsequent
production deployment are recorded in the [PR proof](https://github.com/openclaw/clawsweeper/pull/1251).
The regression matrix additionally covers deduplicated receipts and repeat
reconciliation, asserting that the latter does not create another revision.
