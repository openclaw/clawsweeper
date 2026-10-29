import {
  resolveReviewAuthority,
  type ReviewAuthority,
  type ReviewAuthorityObservation,
  type ReviewAuthoritySubject,
} from "./review-authority.js";

type JsonGet = (path: string) => unknown;

/** Inert binding: callers retain transport, credential, retry, and admission ownership. */
export async function acquireReviewAuthority(
  options: ReviewAuthoritySubject & {
    now: () => number;
    maxAgeMs: number;
    readRepositoryPermission: JsonGet;
    readOrganizationMembership?: JsonGet;
  },
): Promise<ReviewAuthority> {
  const initial = resolveReviewAuthority({ ...options, now: options.now() });
  if (initial.reason === "invalid_evidence") return initial;
  const subject = { repository: initial.repository, actor: initial.actor };
  const [owner, name] = subject.repository.split("/");
  const actor = encodeURIComponent(subject.actor);

  // A selected GET must complete under its existing owner. Never turn an error
  // into missing evidence or return a partial grant after a later read fails.
  const observe = async (read: JsonGet, path: string): Promise<ReviewAuthorityObservation> => {
    const value = await read(path);
    return { ...subject, value, observedAt: new Date(options.now()).toJSON() ?? "" };
  };
  const repositoryPermission = await observe(
    options.readRepositoryPermission,
    `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/collaborators/${actor}/permission`,
  );
  const organizationMembership = options.readOrganizationMembership
    ? await observe(
        options.readOrganizationMembership,
        `orgs/${encodeURIComponent(owner!)}/memberships/${actor}`,
      )
    : undefined;

  // Later reads can let earlier evidence expire before classification.
  // Supplying cached responses violates the fresh GET contract.
  return resolveReviewAuthority({
    ...subject,
    now: options.now(),
    maxAgeMs: options.maxAgeMs,
    repositoryPermission,
    ...(organizationMembership ? { organizationMembership } : {}),
  });
}
