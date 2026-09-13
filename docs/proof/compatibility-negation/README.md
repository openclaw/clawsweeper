# Compatibility-negation rendering proof

Status: historical proof for the compatibility-negation fix. Owner: ClawSweeper review maintainers. Source of truth: `src/clawsweeper-change-detection.ts` and its report-rendering callers. Baseline: `8e008cbc0b4c9153f46a1b90167b215dea9ccdad`, verified September 13, 2026. Rerun when the parser, report sections, readiness, or checklist rendering changes; do not silently update the pinned baseline.

## Claim and scenario

A complete, unqualified standalone statement that no schema/migration change was introduced must not cancel separately recorded compatibility evidence. Remove the full recognized statement from both negative and positive matching so its structural nouns cannot supply proof. Recognition begins only at input start or after a period not immediately preceded by an ASCII digit, with optional whitespace and a recognized Markdown marker, and ends only at a period or actual end of input after whitespace. Excluding digit-preceded periods conservatively prevents an ordered-list marker’s own dot from creating a statement boundary. This follows the original evidence regexes’ period-delimited scope rather than treating coordination or layout as independent clauses. All original positive and negative evidence regexes remain unchanged, including the no-migration-required pattern and its negative-view normalization. Doctor detection is held fixed.

The fixture contains selected public prose from https://github.com/openclaw/openclaw/pull/145577#issuecomment-5643277264 (revision 5, September 13, 2026 02:00 UTC). It is **not** the original stored report: metadata and the explicit affirmative assessment are synthetic. The captured previous-candidate proof limitation remains verbatim. This isolates the contradiction rather than claiming a new Doctor or upgrade run.

## Commands

From the repository root with Node >=24 and pinned pnpm dependencies:

```sh
pnpm run build
node docs/proof/compatibility-negation/replay.mjs --baseline
node docs/proof/compatibility-negation/replay.mjs
node --test test/compatibility-proof.test.ts test/pr-surface-policy.test.ts test/review-state-contract.test.ts
```

The replay copies the built production module graph and config into its own ignored artifact directory. Baseline mode substitutes only the pinned historical change-detection module using Node TypeScript stripping. The production assessment, report renderer, checklist and automation-marker code execute without mocked functions. Input, output and JSON trace are retained under `.artifacts/compatibility-proof/{base,candidate}-*/`. Never run apply or publish as part of this proof.

## Observed before/after

The focused regression suite covers the captured standalone no-change statement, structural noun lists, punctuated Markdown statements, actual end-of-input boundaries, neutral wording without independent proof, original proof blockers, and preservation of the no-migration-required special case. Coordinated no-proof/not-run/not-executed statements and unpunctuated semicolon, newline, paragraph, and list continuations deliberately retain baseline conservative decisions, even when independent positive evidence is present. Run it and the adjacent policy/readiness suites with the commands above; the current PR evidence records the results and source hashes. The baseline/candidate production replay asserts the observations below.

| Observation                                       | Baseline | Candidate |
| ------------------------------------------------- | -------- | --------- |
| Explicit compatibility assessment accepted        | false    | true      |
| Add data-model compatibility proof checklist item | present  | absent    |
| Compatibility proof recorded                      | false    | true      |
| Blocked review-state marker                       | present  | absent    |
| Prior-candidate evidence limitation               | retained | retained  |
| Doctor conservative classification                | retained | retained  |
| Explicit untested-upgrade control                 | blocked  | blocked   |

## Limits and Bay

This is controlled production rendering proof, not a live GitHub/Worker publication or a replay of an authenticated canonical record. Synthetic readiness metadata does not establish the triggering PR is mergeable. No upgrade, migration, or Doctor process was executed. A heuristic parser recognizes recorded evidence; it cannot authenticate it or prove every natural-language paraphrase.

The change deliberately does not reinterpret progressive verification, failed-test mentions, damaged fixtures, causal agents, pronouns, modal language, or other general-English constructs. Their preexisting detector limitations are out of scope. Prose with no recognized complete standalone statement has exactly its original behavior. Only the listed structural nouns followed by `change(s)` and an optional `introduced`/`made`/`included` predicate are eligible. Markdown markers `-`, `*`, `+`, and numbered `.`/`)` forms may prefix a statement at input start or after a period; they do not independently delimit statements. Coordination (`and`/`but`), semicolons, single or multiple newlines, paragraph breaks, and list boundaries do not permit partial normalization of a period-scoped unit containing other text. Whitespace alone may surround a complete statement. Qualified or ambiguous units remain untouched rather than extending the negative vocabulary or adding a general language detector. This is a conservative complete-statement fix, not universal neutral-clause support.

The producer’s review prose, checklist, and existing readiness decisions change without changing Bay’s observer contract. No observer API, data schema, UI, browser GitHub access, or action controls change, so no Bay implementation change is required. Full remote check/provider results and fresh review outcomes belong in the PR body.
