# Review authority contract

- Status: accepted role projections; proposed integration with no active caller
- Owner: ClawSweeper permission and review-policy maintainers
- Source: [`src/review-authority.ts`](../src/review-authority.ts),
  [`src/review-authority-acquisition.ts`](../src/review-authority-acquisition.ts),
  [`src/maintainer-review-policy.ts`](../src/maintainer-review-policy.ts),
  and their authority and maintainer-policy fixtures
- Baseline reviewed: `511462151487bd544a2778ef4868451b07f08683`
- Update when: GitHub role semantics, authority acquisition, freshness, or
  review-policy integration changes

`resolveReviewAuthority` classifies trusted API observations as `maintainer`,
`ordinary`, or `unknown`. It does not fetch GitHub data, cache results, change
admission, or authorize a command. Existing review and mutation gates remain
unchanged. Integration and activation require a separate policy change.

`acquireReviewAuthority` supplies the missing observation binding. Its required
repository-permission reader and optional organization-membership reader are
fresh JSON GET callbacks from the existing transport and credential owner. It
does not select a token, implement HTTP, retry, cache, or call an admission gate.
The caller supplies an explicit clock and freshness window. It validates the
subject before requesting the fixed, encoded endpoint paths, samples the clock
after each selected read completes, then classifies against a final clock sample.
Do not pass cached responses and stamp them as newly observed.

An omitted membership reader means no organization observation was selected;
it is not proof of non-membership. A selected reader returning malformed or null
data remains evidence for the classifier to reject. Every selected reader's
exception propagates unchanged: a denied or private membership lookup, malformed
JSON, exhausted rate limit, budget, or deadline yields no authority result. A
successful first read cannot produce a partial grant after the second fails.
The existing transport owns retry and error handling; this binding defines no
ordinary-user fallback. The envelope records the requested subject and time,
not authentication or credential-scope attestation.

## Evidence

The acquisition owner must bind each response to its requested repository,
actor, and observation time. Resolve the PR author and command requester
separately. A request from a maintainer does not change the author's role.
The result retains both observation times. Callers select an explicit freshness
window and must obtain current evidence before a privileged effect; the
classifier has no cache or revocation subscription.

Bound actor and repository-owner logins are opaque, case-insensitive identities.
Preserve the underscore
in [managed-user logins](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/iam-configuration-reference/username-considerations-for-external-authentication)
and the `[bot]` suffix. The 256-character cap bounds evidence size; it does not
reimplement GitHub's signup rules. Repositories retain the `owner/name` structure
and repository-name grammar. Padding is rejected, never stripped from a login.

Use GitHub's [repository permission endpoint](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user).
Its legacy `permission` maps `maintain` to `write` and `triage` to `read`.
Use the built-in `role_name`, checked against that legacy field, to distinguish
maintain from write. A custom role name alone grants nothing. Complete
`user.permissions` base-role flags can resolve its effective role; unknown
custom roles with only legacy `write` remain unknown. Contradictory role,
legacy permission, or flag observations remain unknown.
GitHub's types permit missing base-role flags and a null user; preserve these
values rather than filling missing flags with `false`.

Only effective repository `maintain` or `admin` qualifies. Ordinary write,
triage, and read access do not. Labels and author association are not inputs.

An [organization membership response](https://docs.github.com/en/rest/orgs/members#get-organization-membership-for-a-user)
must match the actor and repository owner, with `state: active` and `role: admin`,
to establish organization ownership. Pending invitations and ordinary members
do not establish it. Reading membership with an installation token requires
organization Members read permission; unavailable evidence grants nothing.
An active owner observation conflicting with repository access needs a new
read, not selection of whichever observation grants more authority.
The API also permits `billing_manager`; the existing classifier conservatively
returns unknown when that membership response is selected, even if repository
access separately says maintain or admin. Selecting membership is therefore not
monotonic enrichment. This acquisition change does not expand the role schema.
A public-membership lookup or a 404 cannot establish that a private membership
is absent.

## Author availability and requester authority

The accepted policy keeps the two subjects separate. `authorReviewCohort`
projects a canonical unknown author into the ordinary review cohort, under normal
eligibility and limits. It does not treat that author as a maintainer, change the
canonical unknown role or reason, or remove independent item, close, proof, or
security protections. It grants no bypass, sponsorship, or allowance reset.

`requesterHasMaintainerReviewAuthority` returns false for an unknown or ordinary
requester. A verified maintainer requester does not promote the PR author.
Independent self-author and verified-write read-only review rights remain with
their existing command owner; they are not maintainer authority.

These are unused, role-only projections of caller-bound canonical evidence.
They do not validate freshness, admit a review, authorize a mutation, catch
transport errors, or change current production behavior. Selected acquisition
errors still propagate without a partial result; the transport owner must keep
failure handling separate from a canonical unknown result.

## Caller migration map

These paths retain their current behavior. None imports the acquisition adapter.

| Owner | Current observation and cache | Separate integration work |
| --- | --- | --- |
| `src/clawsweeper-context-hydration.ts`, `bulkFilerRepositoryPermission` | Author role string, preferring `role_name`, with a command-scoped author map | Preserve full response and acquisition time; bind target repository and resolve author independently |
| `src/repair/comment-router.ts` permission readers | Requester's legacy permission, cached by login within routing; rate-limit errors propagate | Preserve native retry/control behavior and requester identity; review the command-specific write-access policy separately |
| `src/repair/exact-review-admission.ts` author promotion | Contributor lookup before the later older-item hold; legacy permission and existing author-association fallback | Prove author cohort behavior without treating a maintainer request as author evidence |
| `dashboard/maintainer-author.ts` | Older contributor items only; legacy permission cached for one hour by repository/login; lookup failures keep existing behavior | Preserve the current cache owner until cache provenance, freshness and revocation are explicitly integrated |

Requester migration must cover both `src/repair/comment-router/admission.ts` and
the direct hosted re-review path in `dashboard/worker.ts`. The router currently
retains its configured OWNER-association fallback when permission is unavailable.
Direct hosted intake derives `maintainerAuthorized` from comment association and
can reach `/command-intake` without CLI router revalidation. Neither path consumes
the new requester projection. Changing only the CLI path cannot activate this
policy consistently.

The Worker author reader also restricts permission lookup to older CONTRIBUTOR
items and a narrower login grammar. Current MEMBER-author paths can skip the
permission GET. Its one-hour cache and the CLI's projected role strings are not
fresh canonical observations and must not be restamped as such.

Main and repair JSON transports already own retries, credential selection,
budgets and errors. Permission and organization-membership routes are outside
the existing ETag and public-read fallback allowlists. This change adds neither
another cache nor a default TTL. Target a fork's actual repository explicitly;
upstream permission evidence is not transferable to it. The adapter performs
only selected reads and does not grant labels or other repository mutations.

## Rollout limits

Malformed, stale, future, and mismatched evidence produces an explicit unknown
reason. A caller must not translate unknown into maintainer authority. The
accepted ordinary author cohort is an availability decision, not a privileged
grant. Existing October 15 first-review cadence and independent protections stay
unchanged until their owning callers are deliberately migrated.

The classifier and acquisition binding remain unconsumed by production callers.
Integration fixtures cover full-role payload parity, target and actor binding,
completion-time freshness, selected errors and repeated fresh reads after a
simulated revocation. These do not activate an admission rule. Future caller
integration must prove author/requester separation,
permission loss, all admission paths, and visible unknown handling before
changing current behavior. No new GitHub App permission is requested here.

Active caller migration remains held for actual per-route permission and live
revocation proof, observe-only old/new decision comparisons, and resolved pilot
admission and transport evidence. Installation permission metadata alone does
not establish runtime capability. This source preparation does not deploy an
observe-only consumer, activate organization policy, or expand review producers.

The live contract check covered admin, `permission: write` with
`role_name: maintain`, and an active organization-owner response. Custom-role,
revoked, and unavailable cases use fixtures based on the documented API
contract; they are not live account or revocation tests. The acquisition work's
read-only API contract check additionally observed an admin repository response,
an active organization-owner response, and ordinary read access through the
existing configured login. It did not test App installation permissions or
change membership, access, credentials, or private-repository policy.
