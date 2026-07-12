# Action Ledger

ClawSweeper's durable action history is an immutable, privacy-bounded event
store. Mutable comments, dashboard rows, CrabFleet sessions, router ledgers,
and latest-report files are projections of that history, not the source of
truth.

Writers first spool individual events locally:

```text
.clawsweeper-repair/action-events/<repo-slug>-<repo-digest>/<event-id>.json
```

The repository digest prevents collisions between repositories whose readable
slugs are identical. Readers also verify that every event's repository and
event ID reproduce its exact spool path.

At job finalization, each producer's exact spool set is sealed, sorted,
deduplicated, and published as one or more immutable JSONL shards:

```text
ledger/v1/events/YYYY/MM/DD/<producer-repo>/<producer>/<run-id>-<attempt>-<job>-<digest>-part-<index>-of-<count>.jsonl
```

Per-job shards avoid a shared append hotspot while preventing one Git commit per
event. The state ledger receives canonical shards before optional CrabFleet
delivery is drained. A producer-specific exclusive lock serializes partition
marker creation, the seal check plus spool write, and finalization. Finalization
rereads the spool while holding all selected producer locks, then publishes the
create-only seal and exact shard set. An exact replay remains valid, while a new
event for a sealed producer is rejected with an instruction to use a new
invocation identity. Lock files are linked into place only after their canonical
content is fully written and synced. Ownership binds both PID and process
incarnation; dead or reused owners are reclaimed immediately, while elapsed age
alone never evicts a live owner.

Failed live projections record retryable `projection.failed` events under
derived `<component>.crabfleet_projection` producers. The first finalization
pass deliberately skips producers containing only those failures, the
root-specific projection queue is drained, and a second pass seals the resulting
failure shards. Delivery outages therefore cannot erase, delay, append behind,
or permanently conflict with the authoritative producer history.

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
and hash their inputs. Identity inputs must be plain canonical JSON trees:
non-finite, negative-zero, or unsafe-integer numbers, dates, class instances,
sparse or decorated arrays, accessors, `undefined`, functions, symbols,
bigints, cycles, and credential-bearing field aliases are rejected before
hashing. Canonical JSON validation is iterative and rejects inputs deeper than
64 levels, larger than 10000 nodes, or larger than a 1 MiB UTF-8 input budget
before recursive normalization or hashing. Ledger object keys and evidence use locale-independent UTF-8 byte
ordering without changing the older shared `stableJson` contract. Integer-like
keys retain byte ordering rather than JavaScript property enumeration order,
and unpaired-surrogate keys are rejected. Large identifiers must be strings.
`event_id` is the SHA-256 of normalized repository plus `event_key`. Callers
cannot supply a raw event key, and event-key scope prefixes pass the same
confidential-identifier checks as every other durable machine-text field.

- Replaying the same key and semantic payload is idempotent.
- Reusing a key for different semantic content is a hard conflict.
- Retrying an operation creates a new `attempt_id` and new event records while
  preserving `operation_id` and mutation idempotency keys.
- Mutation events require an explicit business `idempotencyIdentity`; outcome
  status and failure reason never define side-effect identity.
- Repository, producer SHA, workflow, job, run, attempt, and component all bind
  shard identity. They do not define the logical operation.
- Workflow, step, invocation, and component identifiers keep a readable prefix
  plus a digest of the original value whenever sanitization or truncation loses
  information, so distinct producer identities cannot collapse. Workflow refs
  split at the rightmost exact `@refs/` delimiter, preserving `@` characters in
  workflow filenames.
- `recorded_at` is first-writer metadata and is excluded from event and shard
  replay equality. When equivalent fresh-root reconstructions reach an existing
  shard or import destination, the existing first-writer bytes win.
- `occurred_at_source` distinguishes caller-supplied source timestamps from
  writer-generated clock metadata. The semantic digest binds source timestamps
  and the source/generated marker, so chronology cannot be downgraded without
  invalidating the event. Generated occurrence and recording clocks remain
  first-writer metadata, so equivalent fresh-root reconstruction cannot conflict
  solely because another writer observed a different wall clock. An explicitly
  supplied empty timestamp is invalid source evidence; only an omitted value
  selects the generated clock.
- Shard line order is a deterministic topological order: causal children follow
  their in-shard parents. Independent source-timestamp events use occurrence
  time and event ID as stable tie-breakers; generated-clock events use stable
  provenance and event ID so wall-clock drift cannot reverse replay order.
- Shard partition dates come from
  `CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE` or immutable
  `GITHUB_RUN_STARTED_AT` metadata. The producer-specific marker is persisted
  before its first event, and finalization only reads that marker. Wall clock,
  the current flush environment, and event ordering are never used, so delayed
  or fresh-root reconstruction cannot move a run to another path. Timestamp
  metadata must round-trip through a real calendar date; impossible dates are
  rejected rather than normalized into another partition. Four-digit years
  `0001` through `0099` remain valid and are not remapped by JavaScript's
  legacy `Date.UTC` year handling. Timezone conversion must also remain within
  UTC partition years `0001` through `9999`.
- Shards are deterministically packed in canonical event order. Every output
  stays at or below 1024 events and 2 MiB, matching importer limits. Reusing a
  numbered run/job shard part for different content is a hard conflict.
- Shard path components remain below portable 255-byte filename limits.
  Overlong readable repository, producer, run, or job components are truncated
  with a hash suffix; Windows device names such as `CON`, `AUX`, and `NUL`, plus
  trailing-dot components, are encoded with a hash suffix. The full normalized
  identity still binds the shard digest.
- Spool, shard, partition-marker, and import writes require a pre-existing
  trusted root. The supplied root pathname must already be absolute and
  canonical, and its native real path must be identical, so roots reached
  through symlinks or junctions are rejected. Callers create and permission this
  root before invoking the ledger. Finalization validates caller and environment
  output-root strings in that original form before any path normalization.
- Under that trusted-root model, writers create descendant directories one
  component at a time and reject links or special entries. Final files are
  hard-linked create-only from a fully written and fsynced sibling staging file,
  then the destination directory is fsynced where supported. A crash can leave
  a regular `.tmp` staging file but never publishes a partial final shard;
  replay safely publishes the canonical file. Staging names are ignored by
  readers, while symlinks, directories, and special entries fail closed.
- Parent-chain, inode, real-path, descriptor, and final-path checks are
  defense-in-depth corruption and replacement detection. Portable Node v1 does
  not claim containment against a process that can concurrently rename or swap
  the trusted root or its ancestors: Node does not expose the handle-relative
  `openat`, `linkat`, and `unlinkat` operations needed to enforce that boundary.
  Such hostile concurrent filesystem mutation is outside the v1 threat model
  and must be prevented with workspace ownership and process isolation.
- Multi-step readers retain one validated root identity from enumeration through
  file parsing. Root, parent-chain, descriptor, and final-path identities are
  rechecked around reads. File opens are nonblocking before descriptor type
  validation, so replacing a validated regular file with a FIFO cannot hang the
  process.
- Producer lock creation is exclusive and rolls back the exact created inode if
  later write or fsync validation fails. Release and stale cleanup atomically
  rename the observed lock to a private same-directory claim, revalidate its
  open inode and content, and restore a successor that won the race. A lock
  disappearing during cleanup is benign. Contenders reclaim a lock as soon as
  its recorded process is dead or a Linux zombie, bypass PID-only identity
  caches before stale decisions, and use sub-second macOS process start identity.
  A live holder is never evicted solely because of lock age.
- Partition-marker reads are capped at 64 bytes. Existing and raced shard reads
  are capped at the same 2 MiB limit as new shard writes. Direct shard readers
  also require a non-empty collection of at most 1024 unique, acyclic events in
  exact canonical causal order.
- Spool reads retain at most 256 repository directories, 4096 entries per
  repository, 256 producers, 65536 events, and 64 MiB of canonical event bytes.
  Fanout, event count, producer count, and aggregate bytes are rejected before
  the complete collection is retained and sorted.
- Shard imports begin at `ledger/v1/events`; unrelated source-tree entries are
  never traversed. Links and special entries inside that subtree fail closed.
  Imports cap relative depth at 6, directory entries at 512, directories at 512,
  files at 256, each shard at 2 MiB, 2048 lines, and 1024 events, and each batch
  at 16 MiB and at most 262144 events from the bounded file-by-event product.
  Every source shard is read once, then the complete bounded batch is parsed and
  canonicalized before any final destination shard is published. Event IDs and
  causal topology are validated across the complete batch, so duplicates and
  cycles cannot hide across files. Numbered parts are grouped by their full
  producer/run identity, flattened in part order, and required to reproduce the
  exact deterministic packing, paths, and bytes that the canonical writer would
  emit.
- Import reservations bind each producer run to one partition and each event ID
  to one semantic digest and parent edge. Parent traversal follows at most
  262144 durable bindings per import and rejects instead of accepting an
  unchecked deeper graph. These bindings preserve global event identity and
  causal acyclicity across sequential producer imports. One destination lock
  serializes validation through reservation, payload publication, verification,
  and completion, so concurrent opposing parent edges cannot both commit.
- Producer, event, and exact shard-set reservations are published before shard
  payloads so a replay can safely finish an interrupted import without reserving
  a second immutable set. A separate completion marker is published only after
  every destination payload has been written and reread as replay-equivalent.
  Canonical shard readers treat every reserved payload as invisible until that
  marker validates the exact reservation, so a crash after publishing only the
  first numbered part cannot expose a partial run. Sequential imports therefore
  cannot move a run, replace a reserved numbered set with a different part
  count, or advertise completion before payload publication finishes.

## Privacy Boundary

The ledger stores machine-readable reason codes, counts, booleans, hashes,
bounded subject IDs, relative report paths, public run URLs, and snapshot IDs.
It does not store prompts, bodies, comments, diffs, patches, raw logs, raw
payloads, arbitrary model text, local absolute paths, credentials, private
hosts, or email addresses, including single-label internal domains. Credential
detection covers GitHub, Slack `xox*`, AWS access-key ID, and standard
`npm_<36 chars>` token families, JWT-shaped values, Basic credentials,
whitespace or separator-delimited bearer/API/Cloudflare credential forms,
credential field aliases, POSIX and Windows absolute paths, one-quartet Basic
credentials, private paths, private IPv4 and IPv6 addresses, and internal
hostname suffixes. Portable relative paths additionally reject Windows device
names and trailing-dot segments. Public run URLs reject query or fragment
delimiters even when empty.
Form-style `+` credential separators are rejected when followed by a
credential-shaped value. Percent-encoded octets are rejected from durable
identifiers and paths rather than decoded into potentially confidential forms.
URL checks normalize scheme-specific paths, userinfo, file URLs, decimal,
octal, hexadecimal, and mixed-radix numeric host aliases, shorthand private
IPv4 URLs such as `127.1`, and dot-segment paths. Host checks normalize case,
repeated trailing root dots, and compressed IPv6 loopback and private
IPv4-embedded forms, including partially compressed forms embedded in
unbracketed machine text, while all durable text remains restricted to
field-specific machine vocabularies.

Durable relative data paths must use portable ASCII segments beneath one of
`.artifacts/`, `artifacts/`, `jobs/`, `ledger/`, `logs/`, `notifications/`,
`records/`, or `results/`. Arbitrary prose, bare namespaces, hidden child
segments, traversal, encoded octets, and absolute paths are rejected by both
runtime validation and the checked-in schema.

Durable JSON files must already be the exact canonical encoding with unique
object keys that the writer emits, including the trailing newline. Readers
reject duplicate object keys with a bounded raw-byte scan before full parsing,
and reject other noncanonical bytes before accepting the value. Direct event
and shard reads cap allocation at 1 MiB and 2 MiB respectively.

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
every phase. Lanes can migrate independently without changing the v1 shard
format.

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

`CLAWSWEEPER_CRABFLEET_TIMEOUT_MS` sets each live request deadline in
milliseconds. It defaults to 10000 and must be between 1 and 60000. Finalization
first publishes authoritative local shards, then gives the entire optional
projection drain for that spool root one 10000 ms deadline, bounded to at most
60000 ms through the runtime flush option. Independent ledger roots do not wait
for or fail one another's projection queues. Timeout, HTTP, and
response-cleanup failures remain projection failures. Live delivery, including
exported direct posts, runs at most four fetches concurrently. Each spool root
may queue 64 projections, with 64 queued roots and 256 queued projections
process-wide. Admission selects the queued root with the fewest active requests,
so one saturated root cannot deny the next recovered slot to an independent
root. A timed-out fetch keeps its concurrency slot until the underlying request
and response-body cleanup settle; only that request set's queued projections
fail closed if all of its slots remain unresolved. Direct events are validated
before admission, and queued requests have their own bounded deadline so
invalid events, dead slots, or ignored cancellation cannot leave caller
promises pending forever. Queued projections snapshot their endpoint, session,
token, and timeout before admission, so later environment mutation cannot
reroute them. Further live projections also fail closed instead of growing
process memory without bound.

Projection configuration is also optional and non-authoritative. Once the local
event is durable, malformed URL or timeout settings, incomplete session
credentials, and registration-provenance mismatches are converted into a
redacted retryable `projection.failed` event instead of escaping into the review
or repair workflow.

`CLAWSWEEPER_CRABFLEET_URL` remains a configurable credential-free HTTPS base
and defaults to `https://crabfleet.openclaw.ai`. Projection derives the trusted
base from the session-scoped `CLAWSWEEPER_CRABFLEET_WORK_STATE_URL` returned by
registration, requires the configured base and registered session route to
match, and only then attaches the bearer token. This preserves staging and
self-hosted CrabFleet deployments while rejecting later environment-origin or
base-path drift. Queued projections retain that validated base even if the
process environment changes after admission.

Projection rebuilds must be deterministic. Truncating a projection never
deletes source events. State-side compactors may replace hot shards with
digest-verified monthly segments after the configured retention window.

## Migration

Each lane migrates by dual-writing its legacy projection and immutable events.
Readers continue accepting legacy state until the corresponding event backfill
and projection parity checks are complete. Close and merge eligibility remains
bound to current live guards; an event is historical evidence, not permission
to mutate GitHub.
