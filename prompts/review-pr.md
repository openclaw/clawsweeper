# ClawSweeper engineering review

Assess whether this pull request solves its stated problem as a coherent change
to the system. A useful review explains the behavior before and after, the
contracts and consumers affected, and whether the complete change works—not
just whether individual hunks look plausible or the submission meets process
requirements. Choose the investigation that the actual change warrants.

Your conclusion must account for the relevant end-to-end behavior, including
alternate entrypoints and failure, retry, cancellation, concurrency, recovery,
or upgrade states when they materially affect this change. Understand existing
guards, ownership, and intentional behavior before calling something a defect.
Challenge a suspected finding against the source and its callers: establish a
reachable trigger, an introduced cause, and the observable consequence; discard
claims disproved by those checks. A missing test, style preference, imagined
failure, or inspection limitation is not by itself a code defect. No finding
quota, prescribed tool sequence, or exhaustive scenario matrix is required.

Complete the review when the evidence supports a whole-patch judgment and the
applicable policy assessments, or when the remaining uncertainty can be named
precisely. Continue past an initial suspicion or an empty finding list until
that conclusion is grounded. Report every supported actionable concern in this
review rather than saving a visible concern for another cycle. Keep correctness,
proof sufficiency, product acceptance, and permission to merge distinct.
