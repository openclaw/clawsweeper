Apply these rules to every pull request review, in this order. Each rule names
the decision field that records its result. The review prompt loads this file
as its `Review Rules` section.

### Product review

Do the product review first. Decide if the change must exist before you judge
the code. Models write good code. Product judgement is the weak point, so give
it the most care.

1. Write the user problem in user terms in `productReview.userProblem`. Write
   what the user sees, not what the code does. Leave it empty when there is no
   user-facing problem.
2. Set `productReview.kind`:
   - `bug_fix`: the behavior differs from the designed or documented behavior.
   - `preference`: a user wants different behavior, and the current behavior
     works as designed. A stated preference is not a bug.
   - `feature`, `refactor`, `performance`, `test_only`, `docs`, or
     `maintenance`: the change is of that type.
   - `not_applicable`: the item is not a pull request.
3. Set `productReview.worthIt`:
   - `yes`: there is a clear user problem, and the value of the change is
     larger than its cost.
   - `no`: there is no clear user problem, the change serves a niche
     preference, or the churn costs more than it gives.
   - `needs_maintainer`: the change needs a decision from the owner. Examples:
     a `preference` change, a feature without owner direction, or a change to
     an existing product contract.
   - `not_applicable`: the item is not a pull request.
   An owner decision already exists when a repository maintainer wrote the
   pull request, or a maintainer approved the direction in writing on the
   pull request or its linked issue. Then judge `yes` or `no` from that
   decision and the evidence; do not ask for it again.
4. Say `no` or `needs_maintainer` when the case for the change is weak. A
   correct patch alone does not make a change worth merging. A `preference`
   change is never `yes` without an owner decision, even when the preference
   is reasonable: changing designed behavior for one user's taste is a product
   call.
5. A bug fix fixes the stated bug only. A new config option, default, schema,
   permission, or public API inside a bug fix needs the owner's decision. Set
   `worthIt: needs_maintainer`.
6. When the expected behavior in the linked issue conflicts with an existing
   product contract, the change is a product call, not a fix. Set
   `worthIt: needs_maintainer`.
7. Set `productReview.fixScope`:
   - `complete`: the change delivers the expected behavior that the linked
     issue states. `Fixes` or `Closes` is correct.
   - `partial`: the change delivers part of that behavior. The PR must use
     `Related:`, not `Fixes` or `Closes`.
   - `not_applicable`: no stated expected behavior applies, or the item is not
     a pull request.
8. Write one or two sentences in `productReview.reason` that explain the kind
   and the worth.

### Provenance

Code that looks wrong often has a reason. Find that reason before you accept a
change to it.

1. List each touched area where the diff changes or removes existing behavior.
   Pure additions do not need an entry.
2. For each area, find the commit that introduced the behavior:
   - Start with `git log --format='%H %s' -- <path>`. It reads commit and
     tree data only, so it also works in a partial clone that has no old file
     contents.
   - When old file contents are readable, narrow with `git log -L` for a line
     range, `git log -S` for a string, or `git blame`.
   - When local history is not enough, use the read-only GitHub CLI:
     `gh api repos/<owner>/<repo>/commits?path=<path>` for the history and
     `gh api repos/<owner>/<repo>/commits/<sha>/pulls` for the pull request.
   - Then read the pull request of that commit and its stated reason.
   - When every method fails, write the failed method in `originalReason`.
3. Record each area in `provenance`, with a maximum of 8 entries:
   - `area`: the path or symbol.
   - `introducedBy`: the commit SHA or pull request URL. Use `unknown` when a
     real search finds no commit.
   - `originalReason`: the reason that the commit or pull request states.
   - `verdict`: one of the values below.
4. Set `verdict`:
   - `respects`: the diff keeps the original intent.
   - `overrides_with_reason`: the diff changes the intent, and the pull request
     explains why.
   - `overrides_without_reason`: the diff changes the intent, and the pull
     request does not address it. The author must explain the change or
     restore the original behavior.
   - `unknown`: a real search with every method above found no reason. Record
     `unknown`; do not guess.
5. Use an empty list when the diff changes no existing behavior, or when the
   item is not a pull request.

### Testing

End-to-end proof through the shipped entry point is the proof that counts.
Examples: the real CLI, a real server or gateway, the real UI in a browser, or
a real messaging channel. In-process harnesses and unit tests support this
proof. They never replace it.

1. Set `testingReview.proofPath` to the strongest proof of the changed
   behavior:
   - `shipped_entry_point`: the shipped entry point ran the changed behavior.
   - `in_process_harness`: a harness drove the real code inside one process
     with synthetic input.
   - `unit_only`: only unit tests exercise the change.
   - `none`: nothing exercises the change.
   - `not_applicable`: the item is not a pull request.
2. Set `testingReview.addedTestFiles` to the number of test files that the
   pull request adds or changes.
3. A unit test that the pull request adds has negative value when it does one
   of these:
   - it mirrors the implementation;
   - it asserts mocks or call counts;
   - it duplicates existing coverage;
   - it pins incidental wording or defaults;
   - it tests a helper instead of a behavior.
4. List each negative-value test in `testingReview.lowValueTests`, with the
   `file` and the `reason`, with a maximum of 10 entries. Ask the author to
   remove these tests.
5. A regression test must fail on the base and pass on the head. When the
   review cannot show this, state why in `testingReview.missingE2e`.
6. Name the missing end-to-end scenario in `testingReview.missingE2e`. Leave it
   empty when the end-to-end proof is complete.

### Change rules

1. Owner intent: when the diff changes behavior that an area owner built, the
   diff keeps that output and those defaults. Find the owner from CODEOWNERS,
   maintainer notes, or recent owner commits. A change to owner-built behavior
   is a product call: set `worthIt: needs_maintainer`.
2. Clean cutover: each decision has one owner. The change removes the path
   that it replaces.
3. The claims in the pull request body match the diff that the pull request
   introduces. Report each claim that the diff does not support.

### CI and base

1. Attribute each failing required check to one cause:
   - The diff causes it. Report a blocking finding.
   - It comes from outside the diff, and you have evidence. Evidence is the
     same failure on the target branch or on another pull request (give the
     URL), or a comparison of the head with a revert.
   - The check never ran.
2. Ask the author to fix only the failures that the diff causes. Rerunning
   jobs and repairing unrelated CI are not author work in this pull request.
3. Stale base: when a touched file changed on the target branch after the
   merge base, require one of these:
   - a sync with the target branch;
   - a clean merge, plus no overlapping hunks, plus the behavior checked on the
     current target branch.

### Findings discipline

1. Every `reviewFindings` entry is required work before merge, at every
   priority. Add an entry only for a concrete defect with a failing scenario:
   the input and the wrong result. P0 to P2 rank defects by impact; P3 is a
   real defect with low impact.
2. Keep process, style, naming, and taste concerns out of `reviewFindings`.
   Leave them out, or name the one that matters in the summary. Low-value
   tests go in `testingReview.lowValueTests`, not in `reviewFindings`.
3. Report every blocking finding in the first review. On a re-review, a new
   blocking finding needs new evidence or new code. A second look at unchanged
   code is not new evidence.

### Rating rubric

Rate `prRating` with the internal tiers S, A, B, C, D, F, and NA. Rate the
evidence and the patch, not the contributor. Most pull requests are B or C.
Report the tiers honestly.

Tier meanings:

- S: rare. Exceptional proof, a clean implementation, convincing validation,
  and no meaningful blockers. S also needs everything that A needs.
- A: clearly better than B. A requires `proofPath: shipped_entry_point`,
  `worthIt: yes`, no open review finding, and no low-value tests.
- B: worth merging, correct, and proven end to end.
- C: useful, with limited confidence.
- D: the proof, validation, or implementation signal is thin.
- F: not ready. The proof is missing or unusable, or the patch has a serious
  correctness or safety problem.
- NA: the item is not a pull request.

Tier fields:

- `proofTier` rates the quality of the real behavior proof only.
- `patchTier` rates implementation correctness, findings, the security review,
  scope, and validation.
- `overallTier` is the weaker of `proofTier` and `patchTier`, after the caps.

Caps (the code also applies them):

- `proofTier`: `in_process_harness` is at most C. `unit_only` is at most D.
  `none` is F when proof is required.
- `patchTier`: one or more `lowValueTests` is at most B. Low-value tests do
  not block the merge. List them, and ask the author to remove them.
- `overallTier`: `worthIt: no` is at most D. `worthIt: needs_maintainer`,
  `fixScope: partial`, or any `overrides_without_reason` provenance entry is
  at most C.
- `overallTier` A or S needs `proofPath: shipped_entry_point` and
  `worthIt: yes`. Otherwise it is at most B.

Proof quality:

- Real screenshots, recordings, or linked media that show the changed behavior
  are strong proof.
- A screenshot alone does not prove browser runtime, network, CSP, or security
  behavior. It counts only when the diagnostics are visible.
- Missing, mock-only, or insufficient proof lowers the overall tier, because
  real behavior proof is a merge gate.

Workflow state:

- Rate quality only. A draft state, protected labels, automerge eligibility,
  or a pending maintainer action is workflow state. These never lower a
  tier. Your own `worthIt: needs_maintainer` assessment is a product
  judgement, not workflow state, and its cap applies.
- Mention a workflow blocker in the summary or in `nextSteps` only when the
  contributor can act on it.

Rank-up moves:

- Give 0 to 3 `nextSteps`. Each step is concrete, relevant to the merge, and
  likely to increase reviewer confidence.
- Use an empty list for S, A, and NA. Use an empty list for B too, unless one
  specific action reduces a material risk.
- Do not invent optional polish work or churn for a good pull request.
