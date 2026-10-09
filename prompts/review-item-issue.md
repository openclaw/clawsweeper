## Issue review

For each issue, aim for one useful outcome: close it when current `main` or an already-merged PR demonstrably fixes the reported behavior; automatically route a bounded, high-confidence existing-behavior bug to a focused repair PR when no open PR already owns the fix; otherwise identify the concrete safety, evidence, or product-decision blocker. A read-only review need not execute the bug when current source already proves a small defect: describe that evidence accurately and let the implementation worker establish the failing regression.

Use target `AGENTS.md` policy as review input, not as a standalone source of findings. Route an AGENTS-policy concern about the issue, product direction, or maintainability through the existing `risks`, `bestSolution`, `solutionAssessment`, or `workReason` fields instead of inventing new schema fields.

When `bulkFiler.detected` is present, give the issue extra duplicate scrutiny and keep public prose terse. Never route it to proof-nudge or automated fix-dispatch work. For a likely duplicate, propose `duplicate_or_superseded`; do not invent a bulk-filing close reason.

For issues, automatic implementation requires a concrete, high-confidence existing-behavior bug. A report qualifies for automatic bug-fix PR creation when `itemCategory` is exactly `bug`, `reproductionConfidence` and `workConfidence` are both `high`, and all three `requires*` flags are `false`. `reproductionStatus` may be `reproduced`, or `source_reproducible` when `implementationComplexity` is `small` and current source establishes the defect and its narrow repair. Do not invent a live reproduction for source-proven work: the implementation worker must reproduce or establish a failing regression before opening a PR. Keep the `workPrompt` boundary narrow: fix the broken behavior, add regression coverage, and stop before any feature, config, or policy change. Set `autoImplementationCandidate` to `strict_bug` for either shape.

`autoImplementationCandidate: "vision_fit"` also requires `workConfidence: "high"`, a complete `workPrompt` with likely files and validation commands, and no open linked PR.

`impactLabels` are issue-only searchable labels for a concretely supported problem class:
`impact:data-loss`: This issue is about lost, corrupted, or silently dropped user/session/config data.
`impact:security`: This issue is about security boundaries, credentials, authz, sandboxing, or sensitive data.
`impact:crash-loop`: This issue is about crashes, hangs, restart loops, or process-level availability.
`impact:message-loss`: This issue is about lost, duplicated, misrouted, or suppressed channel messages.
`impact:session-state`: This issue is about session, memory, transcript, context, or agent state drift.
`impact:auth-provider`: This issue is about auth, provider routing, model choice, or SecretRef resolution.
`impact:ux-release-blocker`: A non-technical user is blocked without terminal, logs, config, or support.
`impact:ux-friction`: User-facing flow adds avoidable confusion or support burden without fully blocking progress.
`impact:other`: This issue has meaningful maintainer-visible impact outside the owned taxonomy.
Prefer a specific label over `impact:other` or `merge-risk: 🚨 other`, and `impact:ux-release-blocker` over `impact:ux-friction` when both fit. Each `other` label needs a `labelJustifications` entry that names the actual impact or risk.

Fill the pull-request-only fields with their issue values: `reviewFindings: []` with `overallCorrectness: "not a patch"` and an honest low `overallConfidenceScore`; `realBehaviorProof.status` and `evidenceKind` both `"not_applicable"`, with `needsContributorAction: false`; `securityReview.status: "not_applicable"` unless the report is security-sensitive, then `needs_attention` with typed concerns or `cleared`; `nextStep` kind none with empty text, keeping next-action guidance in `workReason`; `NA` for every `prRating` tier with empty `nextSteps`; `reviewMetrics: []`; `featureShowcase.status: "none"`; `telegramVisibleProof.status: "not_needed"`; empty `changeExample` strings; `mergeRiskLabels: []`; and the non-PR values that the schema gives for `productReview`, `testingReview`, and `provenance`.
