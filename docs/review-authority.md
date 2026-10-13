# Review authority contract

- Status: proposed integration; the classifier is inert
- Owner: ClawSweeper permission and review-policy maintainers
- Source: [`src/review-authority.ts`](../src/review-authority.ts) and
  [`test/review-authority.test.ts`](../test/review-authority.test.ts)
- Baseline reviewed: `bd129c3395197feb345b67e7f6ec8d43c2e1063a`
- Update when: GitHub role semantics, authority acquisition, freshness, or
  review-policy integration changes

`resolveReviewAuthority` classifies trusted API observations as `maintainer`,
`ordinary`, or `unknown`. It does not fetch GitHub data, cache results, change
admission, or authorize a command. Existing review and mutation gates remain
unchanged. Integration and activation require a separate policy change.

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

Only effective repository `maintain` or `admin` qualifies. Ordinary write,
triage, and read access do not. Labels and author association are not inputs.

An [organization membership response](https://docs.github.com/en/rest/orgs/members#get-organization-membership-for-a-user)
must match the actor and repository owner, with `state: active` and `role: admin`,
to establish organization ownership. Pending invitations and ordinary members
do not establish it. Reading membership with an installation token requires
organization Members read permission; unavailable evidence grants nothing.
An active owner observation conflicting with repository access needs a new
read, not selection of whichever observation grants more authority.

## Rollout limits

Malformed, stale, future, and mismatched evidence produces an explicit unknown
reason. A caller must not translate unknown into maintainer authority. The
ordinary admission policy for unavailable evidence remains an owner decision.

The first change adds only this classifier and focused fixtures. No production
caller consumes it. Future integration must prove author/requester separation,
permission loss, all admission paths, and visible unknown handling before
changing current behavior. No new GitHub App permission is requested here.

The live contract check covered admin, `permission: write` with
`role_name: maintain`, and an active organization-owner response. Custom-role,
revoked, and unavailable cases use fixtures based on the documented API
contract; they are not live account or revocation tests.
