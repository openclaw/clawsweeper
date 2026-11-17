import {
  resolveReviewAuthority,
  type ReviewAuthority,
  type ReviewAuthorityObservation,
  type ReviewAuthoritySubject,
} from "./review-authority.ts";

type JsonGet = (path: string) => unknown;

/** Inert binding: callers retain transport, credential, retry, and admission ownership. */
export async function acquireReviewAuthority(
  options: ReviewAuthoritySubject & {
    now: () => number;
    maxAgeMs: number;
    readRepositoryPermission: JsonGet;
    readOrganizationMembership?: JsonGet;
    outsideCollaboratorId?: number;
    readOrganizationOutsideCollaborators?: JsonGet;
    observeOrganizationOutsideCollaborator?: (value: ReviewAuthorityObservation) => void;
  },
): Promise<ReviewAuthority> {
  const initial = resolveReviewAuthority({ ...options, now: options.now() });
  if (initial.reason === "invalid_evidence") return initial;
  if ((options.outsideCollaboratorId !== undefined) !== (options.readOrganizationOutsideCollaborators !== undefined) ||
    (options.readOrganizationOutsideCollaborators && options.readOrganizationMembership)) {
    throw new Error("Select exactly one organization evidence mode");
  }
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
  let organizationOutsideCollaborator: ReviewAuthorityObservation | undefined;
  if (options.readOrganizationOutsideCollaborators) {
    const observation = await observe(options.readOrganizationOutsideCollaborators,
      `orgs/${encodeURIComponent(owner!)}/outside_collaborators?filter=all&per_page=100`);
    const page = observation.value;
    let selected: { id: number; login: string } | null = null;
    const ids = new Set<number>(), logins = new Set<string>();
    // Validate the entire bounded page, including entries after a match. A full
    // valid page proves presence; absence never proves non-membership.
    const valid = Array.isArray(page) && page.length <= 100 && page.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        !Number.isSafeInteger(entry.id) || entry.id <= 0 || typeof entry.login !== "string" ||
        !entry.login.length || entry.login.length > 256 || entry.login !== entry.login.trim()) return false;
      const login = entry.login.toLowerCase();
      if (ids.has(entry.id) || logins.has(login)) return false;
      ids.add(entry.id); logins.add(login);
      if (entry.id === options.outsideCollaboratorId || login === subject.actor) {
        if (entry.id !== options.outsideCollaboratorId || login !== subject.actor) return false;
        selected = { id: entry.id, login: entry.login };
      }
      return true;
    });
    organizationOutsideCollaborator = { ...observation, value: valid ? selected : null };
    options.observeOrganizationOutsideCollaborator?.(organizationOutsideCollaborator);
  }

  // Later reads can let earlier evidence expire before classification.
  // Supplying cached responses violates the fresh GET contract.
  return resolveReviewAuthority({
    ...subject,
    now: options.now(),
    maxAgeMs: options.maxAgeMs,
    ...(options.outsideCollaboratorId !== undefined ? { outsideCollaboratorId: options.outsideCollaboratorId } : {}),
    repositoryPermission,
    ...(organizationMembership ? { organizationMembership } : {}),
    ...(organizationOutsideCollaborator ? { organizationOutsideCollaborator } : {}),
  });
}
