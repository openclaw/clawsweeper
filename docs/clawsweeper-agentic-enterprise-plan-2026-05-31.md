# Spec: ClawSweeper Agentic Enterprise Architecture Plan

Status: **spec only — no implementation yet**
Date: 2026-05-31

## Why this exists

ClawSweeper is already an agentic system: it reviews issues and PRs, routes maintainer commands, runs repair workers, reviews commits, applies decisions, and can move work toward merge. The next step is to make it easier to scale safely.

Salesforce's Agentic Enterprise principles translate well here, but ClawSweeper's version should be smaller and sharper:

- modular agents instead of bespoke workflow logic
- policy-as-data instead of scattered gates
- one run ledger instead of disconnected artifacts
- risk-tiered human oversight instead of ad hoc approval rules
- provider-neutral model adapters instead of provider-specific assumptions leaking into business logic

The goal is not enterprise ceremony. The goal is a governed agent platform that can add new capabilities without becoming untraceable or dangerous.

## Goals

- Make every ClawSweeper lane declare what it can do, what it needs, what it may touch, and how it reports outcomes.
- Centralize permission, risk, label, actor, and repo-policy decisions.
- Give every agent run one durable identity that links GitHub workflow runs, logs, prompts, policy decisions, model usage, artifacts, records, comments, and final outcomes.
- Support multiple model providers behind stable internal interfaces.
- Make human handoffs consistent, contextual, and low-friction.
- Preserve current safety posture while improving extensibility.

## Non-goals / Constraints

- Do not replace GitHub Actions immediately. Treat Actions as an execution backend until there is a stronger reason to introduce a dedicated queue/worker service.
- Do not weaken existing gates like `CLAWSWEEPER_ALLOW_EXECUTE`, `CLAWSWEEPER_ALLOW_FIX_PR`, `CLAWSWEEPER_ALLOW_AUTOMERGE`, `CLAWSWEEPER_ALLOW_MERGE`, trusted actor checks, or security labels.
- Do not make provider-specific features part of the core domain model.
- Do not require a database for the first version. Existing markdown, JSON, JSONL, state-repo, and artifact flows are acceptable if modeled consistently.
- Do not optimize for massive scale before the governance and ledger foundations exist.

## Current shape

ClawSweeper currently has several semi-independent lanes:

- review/apply lane in `src/clawsweeper.ts`
- repair/automerge lane under `src/repair/`
- commit review lane in `src/commit-sweeper.ts`
- maintainer command routing in `src/repair/comment-router-core.ts`
- GitHub Actions workflows under `.github/workflows/`
- durable records under `records/`, `jobs/`, `results/`, dashboard state, and workflow artifacts
- usage telemetry in `src/usage-telemetry.ts`
- repository policy/config in `src/repository-profiles.ts`, `config/target-repositories.json`, and `config/automation-limits.json`

Strengths already present:

- multiple provider paths: Codex, Claude Bridge, Claude Code, Pi
- explicit environment gates for repair/automerge/merge behavior
- maintainer permission checks
- opt-in security-sensitive repair labels
- concurrency groups and automation limits
- usage telemetry and debug artifact collection
- command-driven human control through GitHub comments

Main gaps:

- policy is spread across env vars, labels, repository profiles, workflow YAML, and repair code
- run identity is not the universal join key across all records/artifacts/events
- lanes are not registered as first-class agent capabilities
- observability exists but does not yet consistently answer: what happened, why, under which policy, with what context, at what cost, and with what outcome
- human handoff comments are useful but not yet standardized by risk tier and next action

## Principle 1: Design for modularity

### Target

Define each ClawSweeper lane as an agent capability rather than bespoke workflow code.

Possible capability IDs:

- `review.issue`
- `review.pr`
- `review.commit`
- `apply.decisions`
- `repair.plan`
- `repair.execute`
- `repair.automerge`
- `comment.route`
- `audit.records`
- `reconcile.state`

### Proposed contract

```ts
type AgentCapability = {
  id: string;
  description: string;
  triggers: TriggerSpec[];
  input: InputSchema;
  permissions: PermissionSpec;
  policy: PolicyReference;
  outputs: OutputSchema;
  telemetry: TelemetrySpec;
  humanHandoff: HandoffSpec;
};
```

### Implementation notes

- Add a registry such as `src/agents/registry.ts`.
- Start by registering existing lanes without changing behavior.
- Use the registry for docs/dashboard first, then execution dispatch later.
- Avoid abstracting provider execution here; this layer is about ClawSweeper capabilities, not LLM clients.

### First implementation slice

1. Create `src/agents/types.ts`.
2. Create `src/agents/registry.ts` with static descriptors for existing lanes.
3. Add a CLI/report command to print the registry for docs/dashboard use.
4. Add tests that every registered capability has a policy reference, telemetry spec, and output spec.

## Principle 2: Harmonize data with metadata-driven understanding

### Target

Every decision should carry enough metadata to understand risk, permission, context, and expected outcome.

### Proposed metadata model

```ts
type RepositoryAgentProfile = {
  owner: string;
  repo: string;
  riskTier: "low" | "normal" | "high" | "critical";
  trustedActors: string[];
  allowedCapabilities: string[];
  allowedActions: string[];
  mergePolicy: MergePolicy;
  securityPolicy: SecurityPolicy;
  budgetPolicy: BudgetPolicy;
};
```

Every item/run should also carry:

- repository profile version
- item type: issue, PR, commit, discussion, workflow failure
- actor and actor trust classification
- labels and commands used as authorization inputs
- risk tier
- policy decision
- model/provider selected
- budget class
- expected human review requirement

### Implementation notes

- Extend repository profiles rather than creating an unrelated config file.
- Include the profile snapshot or profile hash in run ledgers so old decisions remain explainable after config changes.
- Keep metadata small and boring. Prefer stable IDs and enums over free-text blobs.

### First implementation slice

1. Add a normalized `RunContext` type.
2. Add a function that builds `RunContext` from repo profile, GitHub item, actor, labels, command, and workflow env.
3. Thread `RunContext` through review and repair paths.
4. Record it in the run ledger before any model call.

## Principle 3: Enable unified observability

### Target

Every run should answer five questions:

1. What did the agent do?
2. Why did it choose that path?
3. What context and policy did it use?
4. Who or what allowed it?
5. What changed, and did it work?

### Proposed run event shape

```json
{
  "runId": "csrun_...",
  "capability": "repair.execute",
  "repo": "owner/name",
  "item": 123,
  "trigger": "maintainer-comment",
  "actor": "luke",
  "riskTier": "normal",
  "policyDecision": "allowed-with-autofix-label",
  "provider": "codex",
  "model": "gpt-5.5",
  "tokens": 12345,
  "costUsd": 0.42,
  "artifacts": ["..."],
  "outcome": "pr-updated",
  "verification": "tests-passed",
  "humanReview": "required-before-merge"
}
```

### Implementation notes

- Keep `src/usage-telemetry.ts`, but broaden the concept from usage-only telemetry to run-level telemetry.
- Continue writing JSONL for append-only auditability.
- Emit OTLP spans from the same event model where possible.
- Dashboard should consume the run ledger rather than inferring state from many partial sources.

### First implementation slice

1. Add `src/run-ledger.ts` or equivalent.
2. Generate `runId` at entrypoint boundaries: workflow dispatch, comment command, review sweep, commit review, repair worker.
3. Write `run.started`, `policy.evaluated`, `model.called`, `artifact.created`, `run.completed`, and `run.failed` events.
4. Add a dashboard/debug view grouped by `runId`.

## Principle 4: Build with trust

### Target

Move from scattered gate checks to policy-as-data plus one policy evaluator.

### Proposed policy shape

```yaml
capabilities:
  repair.execute:
    requires:
      - trustedActor
      - label: clawsweeper:autofix
      - repoAllows: repair.execute
    forbids:
      - touchesSecrets
      - escalatesWorkflowPermissions
    expiresAfterMinutes: 60

  repair.automerge:
    requires:
      - trustedActor
      - label: clawsweeper:automerge
      - ciGreen
      - noSecurityBoundaryViolation
      - repoAllows: repair.automerge
```

### Implementation notes

- Preserve existing env vars as emergency outer gates.
- Add the policy evaluator underneath them.
- Emit every policy decision to the run ledger.
- Include denial reasons in maintainer-facing comments.
- Keep policy deterministic and testable; no model calls inside policy evaluation.

### First implementation slice

1. Create `src/policy/types.ts`.
2. Create `src/policy/evaluate.ts`.
3. Model existing behavior first: trusted actor, label, repo allowlist, env gate, security boundary.
4. Add fixtures for allowed/denied repair and automerge cases.
5. Replace one lane's scattered checks with evaluator calls, starting with `repair.execute`.

## Principle 5: Design for strategic human intervention and oversight

### Target

Use risk tier to decide whether agents act automatically, plan only, ask approval, or refuse.

### Proposed oversight matrix

| Risk tier | Default behavior | Human role |
| --- | --- | --- |
| low | act automatically when repo allows it | audit after the fact |
| normal | prepare fix, comment with evidence, wait before merge | approve/revise/stop |
| high | plan only by default | explicit approval before code changes |
| critical | summarize and refuse execution by default | explicit exception path required |

### Handoff comment contract

Every handoff should include:

- capability and run ID
- policy decision
- risk tier
- what changed or would change
- tests/checks run
- links to artifacts
- risks or uncertainty
- exact next commands

Example:

```md
ClawSweeper prepared a fix.

Run: `csrun_...`
Capability: `repair.execute`
Risk: normal
Policy: allowed by trusted actor + `clawsweeper:autofix`
Changed: `src/foo.ts`, `tests/foo.test.ts`
Verified: `npm test` passed

Next:
- `@clawsweeper approve`
- `@clawsweeper revise <instructions>`
- `@clawsweeper stop`
```

### First implementation slice

1. Add a shared handoff renderer.
2. Convert repair/autofix comments to use it.
3. Include `runId`, risk tier, policy decision, and next commands.
4. Add snapshot tests for low/normal/high/critical handoffs.

## Principle 6: Enable event-driven processing

### Target

Normalize all incoming triggers into typed ClawSweeper events.

Current triggers include:

- scheduled sweeps
- manual workflow dispatch
- `repository_dispatch` events such as `clawsweeper_item`, `clawsweeper_comment`, `clawsweeper_commit_review`
- maintainer comments
- commit pushes/review requests

### Proposed event model

```ts
type ClawSweeperEvent =
  | { type: "item.opened"; repo: RepoRef; number: number }
  | { type: "item.review_requested"; repo: RepoRef; number: number }
  | { type: "comment.command"; repo: RepoRef; number: number; actor: string; command: string }
  | { type: "commit.pushed"; repo: RepoRef; sha: string }
  | { type: "ci.failed"; repo: RepoRef; runId: string }
  | { type: "repair.requested"; repo: RepoRef; number: number; mode: string };
```

### Implementation notes

- First version can still be executed by GitHub Actions.
- The important change is an internal normalized envelope before dispatching capability logic.
- Later, this can back a queue/state-repo worker if Actions becomes too limiting.

### First implementation slice

1. Add `src/events/types.ts`.
2. Add parsers for workflow dispatch inputs and repository dispatch payloads.
3. Make command router emit/consume `comment.command` events.
4. Record normalized events in the run ledger.

## Principle 7: Ensure infrastructure can scale growing AI workloads

### Target

Keep existing automation limits, but express capacity and cost by lane/capability.

### Proposed budget model

```yaml
budgets:
  review.pr:
    maxConcurrent: 20
    maxTokensPerItem: 50000
    maxRuntimeMinutes: 20

  repair.execute:
    maxConcurrent: 4
    maxRuntimeMinutes: 45
    requiresReservedCapacity: true

  repair.automerge:
    maxConcurrent: 2
    requiresGreenCi: true
    requiresNoOpenPolicyDenials: true
```

### Circuit breakers

Add circuit breakers for:

- repeated provider failures
- repeated repo failures
- budget exhaustion
- too many denied policy decisions
- suspicious security-boundary hits
- workflow/action runner instability

Fallback modes:

- execute -> plan-only
- automerge -> comment-only
- full review -> summary-only
- provider A -> provider B
- live action -> queued/backoff

### First implementation slice

1. Extend `config/automation-limits.json` or introduce a compatible capability budget section.
2. Add budget checks to policy evaluation or a sibling capacity evaluator.
3. Emit capacity decisions to the run ledger.
4. Add a dashboard panel for capacity, circuit breakers, and degraded mode.

## Principle 8: Prioritize open ecosystems and standards

### Target

Provider-specific code should live in adapters. Core ClawSweeper logic should operate on provider-neutral requests and results.

### Proposed model interface

```ts
interface AgentModelProvider {
  id: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

type AgentRunInput = {
  runId: string;
  capability: string;
  prompt: string;
  context: unknown;
  tools?: ToolSpec[];
  budget: BudgetSpec;
};

type AgentRunResult = {
  status: "succeeded" | "failed" | "timed_out";
  output: string;
  usage?: UsageTelemetry;
  artifacts?: ArtifactRef[];
  providerMetadata?: Record<string, unknown>;
};
```

### Implementation notes

- Keep Codex/Claude/Pi quirks inside provider adapters.
- Normalize usage telemetry at adapter boundaries.
- Store provider-specific metadata under an explicit `providerMetadata` field.
- Avoid making a model's special feature required for core workflows unless there is a fallback.

### First implementation slice

1. Extract provider interfaces from current review provider paths.
2. Normalize provider result shapes.
3. Update telemetry to consume normalized usage.
4. Add contract tests for each provider adapter.

## Recommended implementation order

### Phase 0: Baseline map

- Document existing lanes, gates, workflows, providers, and records.
- Add a small architecture diagram or generated capability inventory.
- No behavior change.

### Phase 1: Run ledger

- Introduce `runId` everywhere.
- Write append-only run events.
- Link existing artifacts and usage telemetry to the run ID.
- Dashboard/debug tooling groups by run ID.

Why first: it makes every later change easier to inspect and roll back.

### Phase 2: Policy-as-data

- Model current policy behavior without changing outcomes.
- Add one evaluator.
- Emit allow/deny reasons.
- Convert `repair.execute` first.

Why second: this is the main safety unlock.

### Phase 3: Capability registry

- Register existing lanes.
- Attach policy, budget, telemetry, and output specs.
- Use it for docs/dashboard first.

Why third: it reduces abstraction risk. By this point, run and policy concepts are real.

### Phase 4: Human handoff standardization

- Shared renderer.
- Risk-tiered next actions.
- Snapshot tests.

Why fourth: it improves day-to-day usability without changing core execution.

### Phase 5: Event normalization

- Add typed events.
- Normalize dispatch/comment/manual inputs.
- Keep GitHub Actions as backend.

Why fifth: useful once capabilities and policy are stable.

### Phase 6: Capacity budgets and circuit breakers

- Capability-level budgets.
- Provider/repo failure circuit breakers.
- Degraded-mode behavior.

Why sixth: avoids scaling unsafe behavior.

### Phase 7: Provider adapter hardening

- Contract tests for Codex, Claude Bridge, Claude Code, Pi.
- Normalize usage/result metadata.
- Keep model-specific behavior isolated.

Why seventh: valuable, but safer after core run/policy semantics exist.

## Suggested issue breakdown

1. **Add ClawSweeper run ledger and run IDs**
   - create run event types
   - generate run IDs at entrypoints
   - write JSONL events
   - link model usage and artifacts

2. **Introduce policy-as-data evaluator**
   - model existing env/profile/label/trusted-actor/security gates
   - add fixtures
   - emit allow/deny decisions

3. **Convert repair.execute to policy evaluator**
   - preserve current behavior
   - add denial comments where useful
   - test trusted/untrusted actor and label cases

4. **Add agent capability registry**
   - describe current lanes
   - expose inventory command/report
   - ensure every capability declares policy, telemetry, and outputs

5. **Standardize human handoff comments**
   - shared renderer
   - include run ID, risk, policy, evidence, next commands
   - snapshot tests

6. **Normalize ClawSweeper events**
   - add typed event envelope
   - parse repository dispatch, workflow dispatch, comment commands
   - ledger normalized input events

7. **Add capability budgets and circuit breakers**
   - extend automation limits
   - degraded modes
   - dashboard visibility

8. **Harden provider adapter contract**
   - normalize provider inputs/results
   - contract tests
   - usage telemetry at adapter boundary

## Rollout and safety gates

- Start in observe-only mode for run ledger and policy evaluator.
- For policy migration, compare old decision and new decision side-by-side before enforcing.
- Fail closed for dangerous actions: execute, automerge, merge, workflow permission changes, secrets-touching changes.
- Keep current env gates as emergency kill switches.
- Add per-repo opt-in for any behavior-changing rollout.
- Publish dashboard views before enabling new automation.

## Open questions

- Should the run ledger live only in the state repo/artifacts, or should a later version use SQLite/Postgres for dashboard queries?
- Should policy config live in `target-repositories.json`, a new `policy.yml`, or both with generated normalization?
- Which repo risk tiers should exist initially: `low`, `normal`, `high`, `critical`, or fewer?
- Should budget checks be part of policy evaluation or a separate capacity evaluator?
- Should `@clawsweeper approve` approve a specific run ID only, to avoid approving stale work?
- Should provider fallback be automatic, or should fallback require policy approval for high-risk lanes?

## Success criteria

This architecture is working when:

- every material action has a `runId`
- a maintainer can inspect one run and see trigger, actor, policy, context, model usage, artifacts, and outcome
- adding a new capability does not require inventing a new permission model
- denied actions explain exactly why they were denied
- high-risk actions require explicit human approval by design
- model providers can be swapped without rewriting lane logic
- dashboard/debug views show capacity, failure modes, and degraded modes clearly
