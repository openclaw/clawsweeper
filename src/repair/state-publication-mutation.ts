import { Buffer } from "node:buffer";
import {
  manualPublicationOwnerFrom,
  type ManualPublicationOwner,
} from "../manual-publication-policy.js";

import {
  EXACT_REVIEW_BUNDLE_MAX_FILES,
  EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES,
  EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES,
} from "./exact-review-bundle.js";

export type StateMutationIdentity = {
  itemKey: string;
  revision: number;
  claimGeneration: number;
};

/**
 * The canonical record target and the queue ownership key have different
 * responsibilities.  Keep them explicit when a prepared mutation is carried
 * through the batch-publication boundary: the former names the tuple, while
 * the latter is the exact fenced queue member allowed to publish it.
 */
export type BatchPublicationIdentity = {
  canonicalTargetKey: string;
  fenceKey: string;
};

export type StateMutationSourceOperation =
  | { path: string; content: string | Uint8Array; mode?: "100644" }
  | { path: string; delete: true };

export type PreparedStateMutationOperation = {
  path: string;
  deleted: boolean;
  contentBase64?: string;
  mode: "100644";
  bytes: number;
};

export type PreparedStateMutationPlan = {
  owner?: ManualPublicationOwner;
  identity: StateMutationIdentity;
  publication?: BatchPublicationIdentity;
  operations: readonly PreparedStateMutationOperation[];
  totalBytes: number;
};

export type ValidatedStateMutationPlans = {
  plans: PreparedStateMutationPlan[];
  totalBytes: number;
};

export const STATE_MUTATION_MAX_PATH_BYTES = 1024;

export function prepareStateMutationPlan(options: {
  identity: StateMutationIdentity;
  publication?: BatchPublicationIdentity;
  operations: readonly StateMutationSourceOperation[];
}): PreparedStateMutationPlan {
  validateIdentity(options.identity);
  if (options.publication) validateBatchPublicationIdentity(options.publication, options.identity);
  if (options.operations.length === 0) throw new Error("A state mutation plan must change a path");
  if (options.operations.length > EXACT_REVIEW_BUNDLE_MAX_FILES) {
    throw new Error("A state mutation plan exceeds the exact-review file limit");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const operations = options.operations.map((operation): PreparedStateMutationOperation => {
    const path = validateMutationPath(operation.path);
    if (paths.has(path)) throw new Error(`A state mutation plan repeats path ${path}`);
    paths.add(path);
    if ("delete" in operation) return { path, deleted: true, mode: "100644", bytes: 0 };
    const content = Buffer.from(operation.content);
    if (content.byteLength > EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES) {
      throw new Error(`State mutation content exceeds the per-file limit: ${path}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES) {
      throw new Error("A state mutation plan exceeds the exact-review total byte limit");
    }
    return {
      path,
      deleted: false,
      contentBase64: content.toString("base64"),
      mode: operation.mode ?? "100644",
      bytes: content.byteLength,
    };
  });
  return {
    identity: { ...options.identity },
    ...(options.publication ? { publication: { ...options.publication } } : {}),
    operations,
    totalBytes,
  };
}

export function validatePreparedStateMutationPlans(
  plans: readonly PreparedStateMutationPlan[],
): ValidatedStateMutationPlans {
  let batchBytes = 0;
  const validated = plans.map((plan): PreparedStateMutationPlan => {
    validateIdentity(plan.identity);
    if (plan.publication) validateBatchPublicationIdentity(plan.publication, plan.identity);
    if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
      throw new Error("A prepared state mutation plan must change a path");
    }
    if (plan.operations.length > EXACT_REVIEW_BUNDLE_MAX_FILES) {
      throw new Error("A prepared state mutation plan exceeds the exact-review file limit");
    }
    const paths = new Set<string>();
    let totalBytes = 0;
    const operations = plan.operations.map((operation): PreparedStateMutationOperation => {
      const path = validateMutationPath(operation.path);
      if (path !== operation.path) {
        throw new Error(`Prepared state mutation paths must be canonical: ${operation.path}`);
      }
      if (paths.has(path)) throw new Error(`A prepared state mutation plan repeats path ${path}`);
      paths.add(path);
      if (operation.mode !== "100644")
        throw new Error(`Invalid prepared state mutation mode for ${path}`);
      if (!Number.isSafeInteger(operation.bytes) || operation.bytes < 0) {
        throw new Error(`Invalid prepared state mutation byte count for ${path}`);
      }
      if (operation.deleted) {
        if (operation.bytes !== 0 || operation.contentBase64 !== undefined) {
          throw new Error(`Deleted state mutation paths must not carry content: ${path}`);
        }
        return { path, deleted: true, mode: "100644", bytes: 0 };
      }
      if (typeof operation.contentBase64 !== "string") {
        throw new Error(`Prepared state mutation content is missing: ${path}`);
      }
      const content = Buffer.from(operation.contentBase64, "base64");
      if (
        content.toString("base64") !== operation.contentBase64 ||
        content.byteLength !== operation.bytes
      ) {
        throw new Error(`Prepared state mutation content does not match its byte count: ${path}`);
      }
      if (content.byteLength > EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES) {
        throw new Error(`Prepared state mutation content exceeds the per-file limit: ${path}`);
      }
      totalBytes += content.byteLength;
      return { ...operation, path };
    });
    if (totalBytes !== plan.totalBytes || totalBytes > EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES) {
      throw new Error(`Prepared state mutation total is invalid for ${plan.identity.itemKey}`);
    }
    batchBytes += totalBytes;
    return {
      ...(plan.owner === undefined ? {} : { owner: manualPublicationOwnerFrom(plan.owner) }),
      identity: { ...plan.identity },
      ...(plan.publication ? { publication: { ...plan.publication } } : {}),
      operations,
      totalBytes,
    };
  });
  return { plans: validated, totalBytes: batchBytes };
}

function validateIdentity(identity: StateMutationIdentity): void {
  if (
    !identity.itemKey.trim() ||
    identity.itemKey.includes("\0") ||
    identity.itemKey.includes("\r") ||
    identity.itemKey.includes("\n")
  ) {
    throw new Error("State mutation item keys must be non-empty single-line values");
  }
  if (!Number.isSafeInteger(identity.revision) || identity.revision < 1) {
    throw new Error("State mutation revisions must be positive safe integers");
  }
  if (!Number.isSafeInteger(identity.claimGeneration) || identity.claimGeneration < 1) {
    throw new Error("State mutation claim generations must be positive safe integers");
  }
}

function validateBatchPublicationIdentity(
  publication: BatchPublicationIdentity,
  identity: StateMutationIdentity,
): void {
  if (
    !publication.canonicalTargetKey ||
    publication.canonicalTargetKey !== publication.canonicalTargetKey.trim() ||
    publication.canonicalTargetKey.includes("\0") ||
    /[\r\n]/.test(publication.canonicalTargetKey) ||
    !publication.fenceKey ||
    publication.fenceKey !== publication.fenceKey.trim() ||
    publication.fenceKey.includes("\0") ||
    /[\r\n]/.test(publication.fenceKey) ||
    publication.fenceKey !== identity.itemKey
  ) {
    throw new Error("Batch publication identities must retain the exact fenced mutation key");
  }
}

function validateMutationPath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\0") ||
    path.includes("\r") ||
    path.includes("\n") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Invalid bounded state mutation path: ${value}`);
  }
  if (Buffer.byteLength(path) > STATE_MUTATION_MAX_PATH_BYTES) {
    throw new Error(`State mutation path exceeds ${STATE_MUTATION_MAX_PATH_BYTES} bytes`);
  }
  return path;
}
