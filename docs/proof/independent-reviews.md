# Independent review runtime proof

Status: historical controlled-runtime evidence, not provider qualification.

## Native Claude–Astra binding

The November 14 correction exercises the compiled ordinary review CLI through
the installed OpenClaw 2026.11.3 (e741fd0) config reader, native agent loop,
OpenRouter-compatible client and actual read-receipt plugin. The loopback model
server supplies controlled responses; no real model provider is called.

```sh
CLAWSWEEPER_NATIVE_OPENCLAW_BIN="$(command -v openclaw)" \
CLAWSWEEPER_NATIVE_PROOF_ARTIFACT_DIR="$PWD/.artifacts/claude-astra-native-boundary" \
CLAWSWEEPER_REAL_SCANNER=1 node --test test/independent-openclaw-review.test.ts
```

Observed distinct native requests for `anthropic/claude-opus-5.5` and
`openai/gpt-6-astra` under the explicit OpenRouter route. Both full reviews
requested high thinking. Four fresh native CLI processes ran: each model's
ordinary read-only inspection and full review. Actual read-tool receipts passed;
neither full-review prompt received the other's answer. Both parsed Decisions,
original recommendations, separate comment sections and proof holds survived.
The regular controlled-process regression also checks failed-second/no-extra-
review behavior and unchanged ambient-model selection for a single review.

The public OpenRouter catalog on November 14 advertised both identifiers,
reasoning and tool support. That metadata is not an execution receipt or
long-context qualification. This proof uses a declared 128k fixture context,
not the models' advertised larger windows. Artifacts are `calls.json`,
`report.md` and `comment.md` in the requested ignored proof directory.

**Real pair qualification remains incomplete** until the selected native
credential handoff is admitted and both real provider results are retained.
Controlled responses do not establish actual Claude/Astra reasoning or model
identity. No credential/admin expansion, account fallback or paid inference retry
is part of this proof. Existing Codex-path evidence follows as historical proof.

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
- Budget control at the existing output owner: all 40 MiB of media plus both
  complete shared model-output allowances fit without widening the 96 MiB cap;
  debug pools and additional live files are accounted for too. This addresses
  the first committed-branch Codex review's P2 output-admission finding.
- Report regressions preserve one history ledger across paired re-reviews and
  route required typed reconciliation as contributor work. These address the
  second committed-branch Codex review's two P2 integration findings.
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
