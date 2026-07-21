import { Buffer } from "node:buffer";

import {
  EXACT_REVIEW_BUNDLE_MAX_FILES,
  EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES,
  EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES,
} from "./exact-review-bundle.js";
import { runGit } from "./git-publish.js";

export type StateMutationIdentity = {
  itemKey: string;
  revision: number;
  claimGeneration: number;
};

export type StateMutationSourceOperation =
  | { path: string; expectedOid: string | null; content: string | Uint8Array; mode?: "100644" }
  | { path: string; expectedOid: string | null; delete: true };

export type PreparedStateMutationOperation = {
  path: string;
  expectedOid: string | null;
  targetOid: string | null;
  mode: "100644";
  bytes: number;
};

export type PreparedStateMutationPlan = {
  identity: StateMutationIdentity;
  operations: readonly PreparedStateMutationOperation[];
  totalBytes: number;
};

export type ValidatedStateMutationPlans = {
  plans: PreparedStateMutationPlan[];
  totalBytes: number;
};

const GIT_OID_PATTERN = /^[a-f0-9]{40,64}$/;
export const STATE_MUTATION_MAX_PATH_BYTES = 1024;

export function prepareStateMutationPlan(options: {
  identity: StateMutationIdentity;
  operations: readonly StateMutationSourceOperation[];
}): PreparedStateMutationPlan {
  validateIdentity(options.identity);
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
    validateExpectedOid(operation.expectedOid, path);
    if ("delete" in operation) {
      return {
        path,
        expectedOid: operation.expectedOid,
        targetOid: null,
        mode: "100644",
        bytes: 0,
      };
    }

    const content = Buffer.from(operation.content);
    if (content.byteLength > EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES) {
      throw new Error(`State mutation content exceeds the per-file limit: ${path}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES) {
      throw new Error("A state mutation plan exceeds the exact-review total byte limit");
    }
    const targetOid = runGit(["hash-object", "-w", "--stdin"], {
      input: content,
      quiet: true,
    }).trim();
    if (!GIT_OID_PATTERN.test(targetOid)) {
      throw new Error(`Git did not return a valid object id for ${path}`);
    }
    return {
      path,
      expectedOid: operation.expectedOid,
      targetOid,
      mode: operation.mode ?? "100644",
      bytes: content.byteLength,
    };
  });

  return { identity: { ...options.identity }, operations, totalBytes };
}

export function validatePreparedStateMutationPlans(
  plans: readonly PreparedStateMutationPlan[],
): ValidatedStateMutationPlans {
  const normalized = plans.map((plan) => {
    validateIdentity(plan.identity);
    if (!Array.isArray(plan.operations) || plan.operations.length === 0) {
      throw new Error("A prepared state mutation plan must change a path");
    }
    if (plan.operations.length > EXACT_REVIEW_BUNDLE_MAX_FILES) {
      throw new Error("A prepared state mutation plan exceeds the exact-review file limit");
    }

    const paths = new Set<string>();
    const operations = plan.operations.map((operation): PreparedStateMutationOperation => {
      const path = validateMutationPath(operation.path);
      if (path !== operation.path) {
        throw new Error(`Prepared state mutation paths must be canonical: ${operation.path}`);
      }
      if (paths.has(path)) throw new Error(`A prepared state mutation plan repeats path ${path}`);
      paths.add(path);
      validateExpectedOid(operation.expectedOid, path);
      if (operation.targetOid !== null) validateExpectedOid(operation.targetOid, path);
      if (operation.mode !== "100644") {
        throw new Error(`Invalid prepared state mutation mode for ${path}`);
      }
      if (!Number.isSafeInteger(operation.bytes) || operation.bytes < 0) {
        throw new Error(`Invalid prepared state mutation byte count for ${path}`);
      }
      if (operation.targetOid === null && operation.bytes !== 0) {
        throw new Error(`Deleted state mutation paths must have zero bytes: ${path}`);
      }
      return { ...operation, path };
    });
    if (!Number.isSafeInteger(plan.totalBytes) || plan.totalBytes < 0) {
      throw new Error(`Invalid prepared state mutation total for ${plan.identity.itemKey}`);
    }
    return { identity: { ...plan.identity }, operations, totalBytes: plan.totalBytes };
  });

  const targetOids = [
    ...new Set(
      normalized.flatMap((plan) =>
        plan.operations.flatMap((operation) =>
          operation.targetOid === null ? [] : [operation.targetOid],
        ),
      ),
    ),
  ];
  const sizeByOid = inspectBlobSizes(targetOids);
  let batchBytes = 0;
  const validatedPlans = normalized.map((plan): PreparedStateMutationPlan => {
    let planBytes = 0;
    const operations = plan.operations.map((operation): PreparedStateMutationOperation => {
      if (operation.targetOid === null) return operation;
      const bytes = sizeByOid.get(operation.targetOid);
      if (bytes === undefined) {
        throw new Error(`Prepared state mutation target is not a Git blob: ${operation.path}`);
      }
      if (bytes > EXACT_REVIEW_BUNDLE_MAX_FILE_BYTES) {
        throw new Error(
          `Prepared state mutation content exceeds the per-file limit: ${operation.path}`,
        );
      }
      if (operation.bytes !== bytes) {
        throw new Error(
          `Prepared state mutation byte count does not match its Git blob: ${operation.path}`,
        );
      }
      planBytes += bytes;
      return { ...operation, bytes };
    });
    if (planBytes > EXACT_REVIEW_BUNDLE_MAX_TOTAL_BYTES) {
      throw new Error("A prepared state mutation plan exceeds the exact-review total byte limit");
    }
    if (plan.totalBytes !== planBytes) {
      throw new Error(
        `Prepared state mutation total does not match its Git blobs: ${plan.identity.itemKey}`,
      );
    }
    batchBytes += planBytes;
    return { identity: plan.identity, operations, totalBytes: planBytes };
  });

  return { plans: validatedPlans, totalBytes: batchBytes };
}

function inspectBlobSizes(oids: readonly string[]): Map<string, number> {
  if (oids.length === 0) return new Map();
  const output = runGit(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: `${oids.join("\n")}\n`,
    quiet: true,
  });
  const lines = output.trim().split("\n");
  if (lines.length !== oids.length) {
    throw new Error("Git returned incomplete prepared state mutation metadata");
  }
  const result = new Map<string, number>();
  for (let index = 0; index < oids.length; index += 1) {
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(lines[index]!);
    const bytes = match ? Number(match[2]) : Number.NaN;
    if (match?.[1] !== oids[index] || !Number.isSafeInteger(bytes)) {
      throw new Error(`Prepared state mutation target is not a Git blob: ${oids[index]}`);
    }
    result.set(oids[index]!, bytes);
  }
  return result;
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

function validateExpectedOid(oid: string | null, path: string): void {
  if (oid !== null && !GIT_OID_PATTERN.test(oid)) {
    throw new Error(`Invalid expected object id for ${path}`);
  }
}
