#!/usr/bin/env node
import { fstatSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { githubAppJson, GitHubRequestError } from "../dashboard/github-api.ts";
import { acquireReviewAuthority } from "../src/review-authority-acquisition.ts";

const MAX_OUTPUT_BYTES = 65_536;
const permissionFlags = ["admin", "maintain", "push", "triage", "pull"];
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(record(value), key)).map((key) => [key,
  value[key] === null || ["string", "boolean", "number"].includes(typeof value[key]) ? value[key] : null]));

/** Operational observation only. Authentication and private sink custody belong to its launcher. */
export async function observeReviewAuthority(subject, token, read = (path) => githubAppJson(`/${path}`, token, {}, {})) {
  const values = {};
  const selected = (phase) => async (path) => {
    try { return values[phase] = await read(path); }
    catch (error) {
      throw Object.assign(new Error("Review authority observation failed"), {
        phase,
        ...(error instanceof GitHubRequestError && Number.isInteger(error.status) ? { httpStatus: error.status } : {}),
      });
    }
  };
  const authority = await acquireReviewAuthority({ ...subject, now: Date.now,
    readRepositoryPermission: selected("repository_permission"),
    readOrganizationMembership: selected("organization_membership"),
  });
  if (!Object.hasOwn(values, "organization_membership")) throw Object.assign(new Error("Invalid observation subject"), { phase: "configuration" });
  const repository = record(values.repository_permission), membership = record(values.organization_membership);
  const envelope = (observedAt, value) => ({ repository: authority.repository, actor: authority.actor, observedAt, value });
  return { authority,
    repositoryPermission: envelope(authority.repositoryPermissionObservedAt, {
      ...pick(repository, ["permission", "role_name"]),
      user: { ...pick(record(repository.user), ["login"]),
        ...(Object.hasOwn(record(repository.user), "permissions") ? { permissions: pick(record(repository.user).permissions, permissionFlags) } : {}) },
    }),
    organizationMembership: envelope(authority.organizationMembershipObservedAt, {
      ...pick(membership, ["state", "role"]), user: pick(record(membership.user), ["login"]),
      organization: pick(record(membership.organization), ["login"]),
    }),
  };
}

export function requirePrivateObservationOutput(fd = 1) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size !== 0) {
    throw new Error("Private observation output is required");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let phase = "configuration";
  try {
    requirePrivateObservationOutput();
    const { values } = parseArgs({ options: { repo: { type: "string" }, actor: { type: "string" }, "max-age-ms": { type: "string" } } });
    const maxAgeMs = Number(values["max-age-ms"]);
    if (!values.repo || !values.actor || values["max-age-ms"] === undefined || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || !process.env.GITHUB_TOKEN) throw new Error("Invalid observation configuration");
    phase = "observation";
    const result = await observeReviewAuthority({ repository: values.repo, actor: values.actor, maxAgeMs }, process.env.GITHUB_TOKEN);
    const bytes = Buffer.from(`${JSON.stringify(result)}\n`);
    if (bytes.length > MAX_OUTPUT_BYTES) throw new Error("Observation output exceeded limit");
    writeSync(1, bytes);
  } catch (error) {
    // Provider messages, subjects, tokens and local paths never reach operator logs.
    process.stderr.write(`${JSON.stringify({ phase: error.phase || phase,
      ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) })}\n`);
    process.exitCode = 1;
  }
}
