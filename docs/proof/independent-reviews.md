# Independent review runtime proof

Status: historical controlled-runtime evidence, not provider qualification.

## Claim and surface

The compiled ordinary review CLI can perform two independent full reviews,
retain their parsed Decisions, render one attributed comment, and feed the
existing conservative label/readiness policy without a consolidation model.
Omitting the opt-in still performs one ordinary review. Malformed second-review
output fails the pair and cannot trigger a third repair/coordinator review.

Environment: Linux x64, Node 26.12.1 (declared requirement >=24), pinned pnpm
12.15.0 with a checkout-local frozen-lockfile installation. The production
scanner resolves checksum-pinned TruffleHog 3.99.4 through its existing managed
bootstrap; the older PATH scanner is not accepted as a substitute. Provider:
native host process; image/lease: not applicable. No container was provisioned.

## Reproduction

After `pnpm install --frozen-lockfile` and `pnpm run build`:

```sh
CLAWSWEEPER_REAL_SCANNER=1 \
CLAWSWEEPER_PROOF_ARTIFACT_DIR="$PWD/.artifacts/independent-reviews-proof" \
node --test --test-name-pattern 'compiled CLI independent' test/local-range-review.test.ts
```

The existing local-range fixture creates two real Git commits and runs the
compiled `dist/clawsweeper.js review --local-range` entrypoint. Only the Codex
response process is controlled: it runs the ordinary checkout-inspection commands
and returns two deliberately different schema-valid ordinary Decisions. It records
every review-process invocation. No fake scanner is installed in this proof mode.
Regular unit runs use the existing scanner fixture instead.

## Observed result and trace

The controlled run passed. Its assertions verify:

- Pair: exactly two ordinary process invocations, requested identifiers
  `fixture-one` and `fixture-two`, separate proof/output directories,
  read-only sandbox arguments, disabled web search and no GitHub token.
- Neither prompt contains the first answer; both start with the original context.
- Both complete parsed Decisions survive the report record. The first summary's
  double spaces and the second recommendation remain unchanged.
- One rendered comment contains `Reviewer 1` and `Reviewer 2` sections,
  both distinct findings, and explicit proof-status disagreement.
- The existing label plan is exactly `["P2", "status: 📣 needs proof"]`;
  `proof: sufficient` is not proposed. No label write occurs.
- Adverse control: schema-invalid second response exits unsuccessfully, keeps
  the first finding, records reviewer 2 as failed, lowers confidence and leaves
  `review_status: failed`. Total invocations remain two, not three.
- Default control: one invocation, no independent-review envelope, original
  summary retained. Each temporary target Git checkout remains clean.

Generated artifacts are `report.md`, `comment.md` and `trace.json` under
the requested ignored artifact directory. The trace includes the actual temporary
Git base/head, invocation arguments, executed-model status and label plan. The
public excerpt above omits machine-local paths; the committed test is the
inspectable scenario and assertion source.

## Limits

These are controlled responses, not real provider reasoning. Requested model
names are not attestations: both executed-model identities remain `unverified`.
The scenario proves native Git/scanner/executor/parser/record/comment/label-plan
wiring; it does not prove model diversity, review quality, live GitHub publication,
hosted queue integration or mutation safety beyond the unchanged existing gates.
No live reviews, rollout, apply, close, labels or provider/billing experiments were
performed. Focused tests and the full repository check are separate supporting
gates, not substitutes for this runtime proof.
