# Action Ledger

ClawSweeper's durable action history is an immutable, privacy-bounded event
store. Mutable comments, dashboard rows, CrabFleet sessions, router ledgers,
and latest-report files are projections of that history, not the source of
truth.

Writers first spool individual events locally:

```text
.clawsweeper-repair/action-events/<repo-slug>/<event-id>.json
```

At job finalization, the spool is sorted, deduplicated, and published as one
immutable JSONL shard:

```text
ledger/v1/events/YYYY/MM/DD/<producer>/<run-id>-<attempt>-<job>-<digest>.jsonl
```

Per-job shards avoid a shared append hotspot while preventing one Git commit per
event. CrabFleet receives live structured events; the state ledger receives the
canonical finalized shard. A failed live CrabFleet projection records a
retryable `projection.failed` event in that shard, so delivery outages cannot
erase or block the authoritative action history.

## Identity And Replay

Each event carries five correlation fields in addition to `event_key`:

- `operation_id` is stable for one logical review, command, repair, apply,
  operation, or evidence-binding lifecycle across retries and workflow reruns.
- `attempt_id` identifies one execution attempt inside that operation.
- `parent_event_id` links causal transitions and is `null` for a root event.
- `phase_seq` is the caller-assigned phase ordinal inside an attempt. Parallel
  branches may share an ordinal and use parent links to preserve causality.
- `idempotency_key_sha256` identifies the external side effect independently of
  event and attempt identity, so retries can be observed without authorizing a
  duplicate mutation.

`event_key` identifies one recorded transition within an attempt. Runtime
writers derive it from attempt ID, phase sequence, and stable transition
identity. Only machine-readable scopes and SHA-256 digests are stored; raw
identity fields are not:

- item source revision plus review phase;
- comment ID, comment version, command, and dispatch phase;
- repair job, source head, action, and execution phase;
- decision packet digest, target revision, and apply phase;
- notification event key and delivery target;
- Gitcrawl snapshot ID, query, and evidence-binding phase.

`actionOperationId`, `actionAttemptId`, and `actionIdempotencyKey` canonicalize
and hash their inputs. `event_id` is the SHA-256 of normalized repository plus
`event_key`. Callers cannot supply a raw event key. Local event files and
published shards use create-only atomic semantics.

- Replaying the same key and semantic payload is idempotent.
- Reusing a key for different semantic content is a hard conflict.
- Retrying an operation creates a new `attempt_id` and new event records while
  preserving `operation_id` and mutation idempotency keys.
- Workflow run and job identity describe the producer; they do not define the
  logical operation.
- `recorded_at` is first-writer metadata and is excluded from replay equality.
- `occurred_at` records source ordering and must match across duplicate events.
- Shard partition dates come from stable workflow-run identity, never event
  ordering, so retries and late events cannot move a shard to another path.
- Reusing one run/job shard identity for a different event set is a hard
  conflict.

## Privacy Boundary

The ledger stores machine-readable reason codes, counts, booleans, hashes,
bounded subject IDs, relative report paths, public run URLs, and snapshot IDs.
It does not store prompts, bodies, comments, diffs, patches, raw logs, raw
payloads, arbitrary model text, local absolute paths, credentials, private
hosts, or email addresses.

Every event records a privacy classification, redaction version, and fields
dropped. The checked-in JSON schema is
[`schema/state-ledger-event.schema.json`](../schema/state-ledger-event.schema.json).

## Event Families

The shared taxonomy defines six families:

1. **Review**: batch, item, retry, log publication, and comment publication.
2. **Command**: receive, classify, claim refresh, progress, wait, requeue, and
   recovery.
3. **Repair**: intake, dispatch, plan, execute, validate, review, publish,
   post-flight, requeue, recovery, and queue phases. Blocked and failed summary
   types remain available for coarse emitters.
4. **Apply**: individual action, batch, and publication phases.
5. **Operations**: workflow attempts; dispatch, retry, and queue lifecycles;
   notification delivery; publication, status, dashboard, and session
   lifecycles; cancellation and projection failures.
6. **Evidence**: Gitcrawl snapshot, query, and binding phases plus proof stage
   and binding phases.

This taxonomy is a schema foundation, not a claim that every lane already emits
every phase. Current emitters cover the existing review, apply, session, and
projection events. Command, repair, notification, operational, and evidence
lanes can migrate independently without changing the v1 shard format.

New writers should prefer phase-oriented types from
`ACTION_EVENT_PHASE_TYPES`, statuses from `ACTION_EVENT_STATUSES`, and optional
reasons from `ACTION_EVENT_REASON_CODES`. The event type identifies what phase
ran; `action.status` identifies its transition or outcome. Free-form detail
belongs in neither field.

```ts
recordWorkflowPhaseEvent(root, {
  phase: ACTION_EVENT_PHASE_TYPES.repairValidate,
  status: ACTION_EVENT_STATUSES.completed,
  reasonCode: ACTION_EVENT_REASON_CODES.completed,
  operation: "repair",
  operationIdentity: { queueItemId },
  attemptIdentity: { queueItemId, attempt: 2 },
  parentEventId: executeEvent.event_id,
  phaseSeq: 4,
  idempotencyIdentity: { queueItemId, validationRevision },
  identity: { queueItemId, sourceRevision },
  component: "repair_validate",
  subject: {
    repository,
    kind: "queue_item",
    subjectId: queueItemId,
    sourceRevision,
  },
  retryable: false,
  mutation: false,
  attributes: {
    validation_count: 3,
    validation_kind: "focused",
  },
});
```

`recordWorkflowPhaseEvent` derives `scope`, `event_type`, `action.name`, and
the phase transition identity. It rejects unknown phase, status, and reason
strings at runtime. `recordWorkflowActionEvent` remains the compatibility API
for existing v1 emitters and previously published shards.

Subjects support issue, pull request, cluster, command, workflow, repository,
notification, commit, queue item, deployment, and publication identities.
Attributes remain allowlisted, scalar, collection-bounded, and
privacy-checked.

## Projections

Consumers fold immutable events into purpose-specific views:

- the marker-backed GitHub review comment shows a bounded review history;
- `results/comment-router.json` shows current command state;
- CrabFleet shows live sessions and structured events;
- the ClawSweeper dashboard shows current status and timing;
- notification ledgers track external delivery;
- evidence graphs bind review and apply claims to GitHub and Gitcrawl sources.

Projection rebuilds must be deterministic. Truncating a projection never
deletes source events. State-side compactors may replace hot shards with
digest-verified monthly segments after the configured retention window.

## Migration

Each lane migrates by dual-writing its legacy projection and immutable events.
Readers continue accepting legacy state until the corresponding event backfill
and projection parity checks are complete. Close and merge eligibility remains
bound to current live guards; an event is historical evidence, not permission
to mutate GitHub.
