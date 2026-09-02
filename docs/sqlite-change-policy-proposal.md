# Material SQLite Change Discussion Proposal

- Status: proposed; grants no execution or merge authority
- Owner: OpenClaw maintainers for policy; ClawSweeper maintainers for any later advisory implementation
- Source of truth: maintainer decision linked from [CSW-138](https://github.com/openclaw/clawsweeper/issues/1234)
- Last verified: `openclaw/clawsweeper@ce250708c1ea10228f29fc5740cba95460dcdf74`
- Update when: a maintainer accepts, rejects, or materially changes the proposal; or an approved implementation changes detection behavior

This proposal defines a human discussion checkpoint for material SQLite and
other durable-store changes in `openclaw/openclaw`. It is not current OpenClaw
contributor policy, does not re-evaluate historical changes, and does not
authorize ClawSweeper to block, label, close, or merge a pull request.

## Proposed checkpoint

Before maintainers consider a pull request for merge, its author would open or
link a maintainer discussion when the pull request does any of the following:

- adds a table, durable store, or persistent projection/cache that changes a
  user-visible result;
- adds an index with material write, read, or disk-space impact;
- changes migration, downgrade or upgrade compatibility, backfill, repair,
  retention, import/export, corruption handling, or recovery;
- changes transactions, locking, writer ownership, reader consistency,
  publication fencing, or cross-process lifecycle; or
- changes what data is canonical or derived, retained or reconstructible, or
  visible after restart.

Several individually small changes also qualify when their combined data model
or operational contract cannot be reviewed as an ordinary implementation
detail.

The discussion should record the owner and purpose, canonical-versus-derived
classification, schema and compatibility plan, lifetime and retention, writer
and reader contract, recovery behavior, performance budget, rollback plan, and
the validation limits. It should also explain why an existing store is not the
right owner.

## Exclusions and exception route

The checkpoint would not normally apply to a read-only query with unchanged
semantics, a bounded query-plan improvement on an existing table, or generated
types, schema baselines, tests, and documentation that only follow an already
approved decision. A mechanical migration may cite the prior approval instead
of reopening the design decision.

For an urgent bug, security, or recovery fix, a maintainer could record a
narrow exception containing the immediate risk, temporary scope, and required
follow-up discussion. An exception is never inferred from urgency or from CI.

## Proposed ClawSweeper role after approval

If maintainers separately authorize implementation, ClawSweeper would only
report high-confidence candidates. Candidate evidence may include changed SQL
DDL, schema or migration files, Kysely/SQLite schema generation, and known
durable-store entry points. A report would be advisory, non-blocking, and would
state its evidence and confidence.

The detector would suppress generated or schema-baseline-only changes when the
functional change links an approval. It would permit a human `not material`
disposition and recognize a recorded exception. It would not add labels,
require a new label, alter merge authority, or treat a missing discussion as a
defect in already-merged work.

The existing `clawsweeper:needs-product-decision` and
`clawsweeper:needs-maintainer-review` labels are the proposed human decision
signals. This proposal does not create, apply, or automate either label.

## Approval needed

Before this page can become active policy or before any detector change starts:

1. OpenClaw maintainers must confirm that the policy belongs in OpenClaw's
   contributor/PR process.
2. They must approve the material-change threshold and exception route.
3. They must approve reuse of the existing decision labels rather than a broad
   SQLite taxonomy label.
4. They must separately authorize any ClawSweeper advisory implementation.

Until all four decisions are recorded, normal review remains unchanged.
