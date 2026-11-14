# Independent ordinary reviews

- Status: active opt-in CLI contract; not enabled in hosted deployment
- Owner: ClawSweeper review maintainers
- Source of truth: `src/independent-reviews.ts`, `src/clawsweeper-review-item.ts`,
  `src/review-record.ts`, and the ordinary readiness/comment policies
- Verified scope: alternative implementation based on `e7fd6690127d9c46412546045a97f8de2f748d39`;
  see the [controlled runtime proof](proof/independent-reviews.md)
- Update when: model selection, typed projection, record schema, readiness,
  output limits, or ordinary execution guards change

`review --review-models MODEL_A,MODEL_B` requests exactly two independent full
ordinary reviews. Identifiers may be equal. The default runner is Codex;
BACKTICKCLAWSWEEPER_RUNNER=openclawBACKTICK selects the existing native OpenClaw harness.
Both retain repository AGENTS discovery, scanner,
read-only checkout inspection, credentials, source validation and output budgets.
There is no new provider SDK, skill selector, coordinator setting, third
reviewer, consolidation model or generated consensus. The ordinary single-review
path and its policy hash are unchanged when the flag is absent. The selected
pair changes the opt-in policy hash; OpenClaw pairs also bind runner/high-thinking
identity, preventing reuse of a Codex-pair result for a native pair.
Legacy `--multi-review-config`/`CLAWSWEEPER_MULTI_REVIEW_CONFIG` and
coordinator JSON are rejected, not silently accepted or migrated.

Each review starts fresh, receives an independently cloned original context,
and has separate diagnostic/proof output. Neither receives the other's current answer.
The item deadline is shared, not reset for the second review. Both reviews share
the existing retained model-output pools, reserved before media admission; media
and report allowances and aggregate byte/file caps are not widened. Invalid output
fails that review without a repair-model turn in this mode. A completed pair
has exactly two ordinary review invocations; scanner/deadline failure can stop
earlier. No retry, rollout, apply or close is requested by this option.
Requested identifiers are recorded as requests only: the executed model remains
`unverified`. This is not evidence that two distinct actual models ran.

## Claude and Astra through native OpenClaw

```sh
CLAWSWEEPER_RUNNER=openclaw pnpm run review -- --local-range --base origin/main \
  --review-models openrouter/anthropic/claude-opus-5.5,openrouter/openai/gpt-6-astra
```

Each member selects its own provider-qualified model in its fresh native config
and CLI invocation, including its existing checkout inspection. An ambient
`CLAWSWEEPER_OPENCLAW_MODEL` cannot replace either member. Both full OpenClaw
reviews request `--thinking high`. Codex pairs retain their existing author
profile; single-review commands retain their existing model/effort selection.
OpenRouter refs contain a provider plus a slash-bearing model id, as documented
by the [native provider contract](https://docs.openclaw.ai/providers/openrouter).
The equivalent direct Anthropic/OpenAI refs require those routes' own already
admitted credentials; the command does not select a new account or fallback.

The two ordinary OpenClaw reviews keep their two existing model-backed read-only
checkout-inspection turns. These are capability checks, not a third review or a
consolidator. Their read receipts, credential allowlist, source guards, shared
deadline and aggregate output caps remain enforced. No shared Gateway state,
reviewer admin access, key copying, provider fallback or credential setup is added.

**Before enabling a real pair:** the isolated native processes must already have
an operator-authorized credential binding for the chosen provider. A protected
Gateway process-local sentinel is not proof of such a binding. Missing handoff
is an external prerequisite, not permission to expose a key or switch accounts.
The [native boundary proof](proof/independent-reviews.md#native-claudeastra-binding)
uses real OpenClaw config/client code with controlled loopback responses; it is
not live Claude/Astra reasoning qualification. No long-context variant is enabled
or qualified here. Preserve explicit native provider context settings and qualify
any separately requested context mode before enabling it; never relabel a default
context run as long-context proof.

## Pure typed policies

- Both required reviews must be complete, source-matching and checkout-verified.
  Missing, failed, duplicate, invalid or stale input cannot yield completion.
  The existing stored-record reader rejects malformed/nested independent records.
- Keep every original parsed Decision, including prose, findings, evidence,
  recommendations and maintainer packets, in the existing typed review record.
  Rendering reuses ordinary presentation in attributed Reviewer 1/Reviewer 2
  sections. Existing safety escaping/presentation remains; the reducer never
  rewrites or semantically deduplicates a review. Parsed strings round-trip
  byte-for-byte; this is not preservation of unsanitized raw transport bytes.
- Readiness runs each ordinary policy independently and appends all attributed
  blockers/holds without cross-review deduplication. Either required next step,
  product objection, security concern, proof block, or maintainer packet holds
  readiness. Typed categorical disagreements show each value and add a hold;
  agreement in these fields is not semantic agreement in prose.
- Priority is the most urgent typed priority; confidence is the least confident.
  Impact and merge-risk labels are sorted unions; maturity labels require both
  reviews. If a union exceeds the existing three-label schema budget, omit that
  aggregate label family and hold for reconciliation; retain both full originals.
  Existing schema and output limits are not widened or truncated to force success.
- Proof uses the conservative order `missing, mock_only, insufficient,
  not_applicable, sufficient, override`, ORs contributor-action flags and retains
  any insufficient data-compatibility assessment. Evidence kind is projected
  only when both agree. Existing host proof/override policy still applies.
- Each rating dimension uses `NA, F, D, C, B, A, S` (unknown stays unknown).
  Incorrect correctness survives either reviewer; correctness is positive only
  when both say correct. Security attention/concerns survive either reviewer.
- The aggregate never proposes closing or queues repair/work automation,
  regardless of agreement. Other narrative/complex assessments remain individual,
  not invented facts or a selected winner. This conservative mode can require
  more human reconciliation and approximately twice ordinary review work.

No queue, dashboard, canonical storage migration or hosted workflow switch is
included. This is an independent alternative to
https://github.com/openclaw/clawsweeper/pull/2079, not a replacement or closure.
