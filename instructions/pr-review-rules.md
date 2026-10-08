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
   An owner decision already exists when an owner of the touched product area
   wrote the pull request, or approved the direction in writing on the pull
   request or its linked issue. An owner is named by CODEOWNERS, maintainer
   notes, or the area's maintainers in history. An `OWNER`, `MEMBER`, or
   `COLLABORATOR` author association alone does not make the author an owner
   of the area. When an owner decision exists, judge `yes` or `no` from it and
   the evidence; do not ask for it again. This exception applies to every rule
   in this file that asks for `needs_maintainer`.
4. Say `no` or `needs_maintainer` when the case for the change is weak. A
   correct patch alone does not make a change worth merging. A `preference`
   change is never `yes` without an owner decision, even when the preference
   is reasonable: changing designed behavior for one user's taste is a product
   call.
5. A bug fix fixes the stated bug only. Each changed hunk serves the user
   problem in `productReview.userProblem`; unrelated cleanup, refactors or
   features belong in a separate pull request. A new config option, default,
   schema, permission, or public API inside a bug fix needs the owner's
   decision. Set `worthIt: needs_maintainer`.
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
   - Start with `## Provenance Evidence`. The host already ran `git blame` on
     the base lines that the diff changes or removes, and found the pull
     request of each commit. An area with `change: insertion_context` gives
     the unchanged lines next to an insertion. Use it when the inserted code
     changes the behavior of those lines.
   - When the evidence names a pull request, read its stated reason in the
     `title` and `bodyExcerpt` of that pull request.
   - Use local git commands only to extend the evidence: for an area that it
     does not cover, or when its `status` is `partial` or `unavailable`.
     `git log --format='%H %s' -- <path>` reads commit and tree data only, so
     it also works in a partial clone. `git log -L`, `git log -S` and
     `git blame` need old file contents.
   - When network access is available, `gh api
     repos/<owner>/<repo>/commits/<sha>/pulls` finds the pull request of a
     commit.
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
   - `none`: nothing exercises the change. A test in the pull request that
     runs the changed code is `in_process_harness` or `unit_only`, not
     `none`, also when it is not end to end.
   - `not_applicable`: the item is not a pull request.
2. A unit test that the pull request adds has negative value when it does one
   of these:
   - it mirrors the implementation;
   - it asserts mocks or call counts;
   - it duplicates existing coverage;
   - it pins incidental wording or defaults;
   - it tests a helper instead of a behavior.
3. List each negative-value test in `testingReview.lowValueTests`, with the
   `file` and the `reason`, with a maximum of 10 entries. Ask the author to
   remove these tests.
4. A regression test must fail on the base and pass on the head. When the
   review cannot show this, state why in `testingReview.missingE2e`.
5. Name the missing end-to-end scenario in `testingReview.missingE2e`. Leave it
   empty when the end-to-end proof is complete.
6. When the diff changes config loading, defaults, stored data, migrations,
   Doctor, or a protocol, the proof includes an upgrade from the latest stable
   release to the head with existing settings and data intact. Name a missing
   upgrade run in `testingReview.missingE2e`.

### Change rules

1. Owner intent: when the diff changes behavior that an area owner built, the
   diff keeps that output and those defaults. Find the owner from CODEOWNERS,
   maintainer notes, or recent owner commits. A change to owner-built behavior
   is a product call: set `worthIt: needs_maintainer`, unless an owner
   decision already exists (Product review rule 3).
2. Clean cutover: each decision has one owner. The change removes the path
   that it replaces. Production growth fits the problem: a new owner, manager,
   wrapper, layer, or parallel path needs a stated reason why the existing
   owner cannot hold the change. Prefer a change that removes more code than
   it adds.
3. Root cause: the change removes the cause of the failure. A retry, guard,
   catch, filter, timeout, or message that hides the failure while the cause
   stays is a symptom patch: report it in `reviewFindings` with the input that
   still reaches the cause, and name the owner of the cause in
   `bestSolution`.
4. Shared owner: when the defect is in shared behavior, the fix goes in the
   shared owner (core, the plugin SDK, a shared channel layer, a provider
   registry). A fix in one channel, provider, or consumer says why the other
   consumers of the same path do not have the defect.
5. Model judgement: a semantic decision (intent, similarity, quality,
   relevance, a score) that the diff makes with regex, keyword lists, or
   string matching is a finding; recommend that the model decide. Exact
   parsing of a fixed format (IDs, flags, protocol fields) is not semantic.
6. Agent capability: a change that removes or limits what the agent or the
   operator can do (a tool, command, skill, config edit, or model action)
   names the trust boundary that it protects. Without a real boundary, the
   restriction is friction, not security: report it as a regression.
7. User messages: each user-visible message that the diff adds or changes
   says what happened and the next action, in user terms. A generic failure
   text, a status message after a successful operation, or a fix that needs a
   normal user to edit config or read logs is a finding.
8. The claims in the pull request body match the diff that the pull request
   introduces. Report each claim that the diff does not support. Public text
   (body, commits, comments) names no private deployment, private bot or host,
   personal data, or outside project used as a design source, and has no
   AI-disclosure or workflow boilerplate.

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
2. Process, style, naming, and taste concerns are not merge work. Keep them
   out of `reviewFindings`, `risks`, and a required `nextStep`. Name the one
   that matters in the summary, or leave them out. PR-body paperwork is a
   process concern: timings, CI seconds, section headings, or a new record of
   a command that already passed. This applies also when the target
   `AGENTS.md` asks for it or a PR-body check fails on it. Missing proof of
   the changed behavior is not paperwork. Low-value tests go in
   `testingReview.lowValueTests`, not in `reviewFindings`.
3. Report every blocking finding in the first review. Never hold a visible
   concern back for a later cycle. When a re-review finds a real defect in
   code that an earlier review could already see, report it and set
   `lateFinding: true`; a late defect is still a defect.
4. One gap, one place. Each piece of remaining work appears once in the
   comment, in the field that owns it:
   - missing or weak proof: `realBehaviorProof.summary` judges the proof, and
     `testingReview.missingE2e` names the missing scenario in one sentence.
     `summary` does not repeat them;
   - a patch defect: `reviewFindings`; a security defect that is also a
     finding keeps its `securityReview` concern only for what the finding
     does not already say;
   - an owner or product call: `productReview` or `maintainerDecision`;
   - a stored-data or config upgrade question: its compatibility field.
   `risks` holds only an unresolved merge concern that none of these fields
   already states, and `nextStep` names only the next action, not a list of
   the items above. A proof gap is never also a `risks` entry.
   `prRating.nextSteps` become required work when the patch tier is D or F;
   when `reviewFindings` already list the remaining work, leave
   `prRating.nextSteps` empty instead of restating those findings.
5. Ask only for work that a real input needs. `nextStep`, `risks`,
   `bestSolution`, `mergeRiskOptions`, and `prRating.nextSteps` do not ask for
   extra guards, allowlists, deny rules, fallbacks, config options, or
   edge-case handling unless you name the real input and the wrong result. A
   simpler change that handles every shown case beats a larger change that
   also handles hypothetical ones.
6. Each Before-merge item (a `risks` entry, a required `nextStep`, a finding
   title) is one concrete author action in plain words: what to change or
   add, and where. Do not use internal process names, such as "validation
   handoff", "close-coverage proof", or "missing-method".

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
- `overallTier` is the weaker of `proofTier` and `patchTier`, and it also
  carries your product judgement.

The tiers are your judgement. Calibrate them with these anchors:

- A harness or unit tests that never run the shipped entry point are weak
  proof; such proof is rarely better than C. `none` is F when proof is
  required.
- Low-value tests make a patch worse, not better. List them and ask the
  author to remove them; they do not block the merge.
- A change that is not worth merging does not rate as a good pull request,
  however clean the code. A change that waits on an owner decision, a partial
  fix, or an unexplained override of original intent is not B or better.
- A or S needs end-to-end proof through the shipped entry point and a change
  that is clearly worth merging.

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
