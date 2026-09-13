<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line
below this comment.

Required PR title:
type: user-facing description
Use a parenthesized scope only when it adds clarity:
fix(auth): login redirect loops when session cookie is expired

Types: feat, fix, improve, refactor, docs, chore.
For fixes, describe the user-visible symptom and trigger:
fix: task list fails to load when user has no environments
Avoid implementation details such as:
fix: add null check to task query

**MUST:** Keep **Allow edits from maintainers** enabled for this PR so maintainers
can help update the branch when needed.
-->

## What Problem This Solves

<!--
Describe the concrete user, product, or operational problem.
Use one short, plain-language sentence. For fixes, prefer:
"Fixes: <what goes wrong> when <trigger or condition>."
For other changes, describe the need without inventing a bug.
Name the affected workflow, not the code-level cause.
-->

## User Impact

<!--
"User impact: <what users, operators, or developers can now do or expect>."
Lead with the concrete outcome in plain language, usually one sentence.
For internal-only changes, say there is no user-visible change; do not invent a benefit.
Keep important risks, breaking changes, migrations, and required user actions visible here.
-->

## Why This Change Was Made

<!--
Briefly explain how the change addresses the problem without repeating the impact.
Keep the body short. Leave file lists, internal acronyms, and root-cause walkthroughs
in the diff or optional <details>; include technical detail only when it explains
behavior or a material tradeoff. Do not hide risks or required actions in <details>.
-->

## OpenClaw Bay Impact

<!--
For lifecycle/review-publication, queue/workflow, status/telemetry, or dashboard
data-contract changes, name the affected Bay surface and its proof. Otherwise,
state why Bay is unaffected. See AGENTS.md.
-->

## Documentation Impact

<!--
For every code, configuration, workflow, API, UI, package, policy, or integration
change, name the canonical documentation reviewed and summarize any required
updates. If no documentation changes are needed, explain why the existing
contract remains accurate.

For new or changed documentation, also classify it as active, proposed,
compatibility-only, or historical. Active runbooks and volatile references must
name their role owner, source of truth, verified scope/revision, and update
triggers. See CONTRIBUTING.md.
-->

## Evidence

<!--
Show the most useful proof that this change works. Screenshots, screencasts,
terminal output, focused tests, CI results, live observations, redacted logs,
and artifact links are all useful. Include before/after evidence for visual
changes when it clarifies the result.

Reviewers will inspect the code, tests, and CI. Use this section to make the
validation easy to understand, not to restate the diff.

For code-bearing changes, include the current `## Real Behavior Proof` package
described in [CONTRIBUTING.md](../CONTRIBUTING.md). After review feedback, update
this main PR body and request a re-review only after the branch, proof, and body
are current.
Summarize what was checked and the result; note meaningful gaps. Link long output
or put it in optional <details>, keeping the useful evidence summary visible.
-->
