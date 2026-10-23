import { readReviewGit } from "./pr-review-evidence.js";
import { admitAndFetchReviewBlobs } from "./clawsweeper-review-blobs.js";
import { sha256 } from "./content-hash.js";

const CONFIG_PATH = ".clawsweeper/review.json";
const MAX_CONFIG_BYTES = 16 * 1024;

export interface ReviewModelSelection {
  runner: "codex" | "openclaw";
  model: string;
  reasoningEffort?: string;
  contextTier?: "default" | "long_context";
}
export interface MultiModelReviewConfig {
  reviewers: ReviewModelSelection[];
  coordinator: ReviewModelSelection;
}

export function parseReviewModelSelection(input: unknown): ReviewModelSelection {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Review model selection must be an object.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["runner", "model", "reasoningEffort", "contextTier"].includes(key),
    ) ||
    (value.runner !== "codex" && value.runner !== "openclaw") ||
    typeof value.model !== "string" ||
    value.model.length > 160 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value.model) ||
    value.model.includes("://") ||
    (value.runner === "openclaw" && !/^[^/]+\/[^/]+(?:\/[^/]+)*$/.test(value.model)) ||
    (value.reasoningEffort !== undefined &&
      (typeof value.reasoningEffort !== "string" ||
        !["none", "minimal", "low", "medium", "high", "xhigh"].includes(value.reasoningEffort))) ||
    (value.contextTier !== undefined &&
      value.contextTier !== "default" &&
      value.contextTier !== "long_context")
  )
    throw new Error("Invalid review model selection.");
  return {
    runner: value.runner,
    model: value.model,
    ...(value.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: value.reasoningEffort as string }),
    ...(value.contextTier === undefined ? {} : { contextTier: value.contextTier }),
  };
}

function parseMultiModel(input: unknown): MultiModelReviewConfig | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid multiModel configuration.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["reviewers", "coordinator"].includes(key)) ||
    !Array.isArray(value.reviewers) ||
    value.reviewers.length < 2 ||
    value.reviewers.length > 4
  )
    throw new Error("multiModel requires two to four reviewers and one coordinator.");
  const config = {
    reviewers: value.reviewers.map(parseReviewModelSelection),
    coordinator: parseReviewModelSelection(value.coordinator),
  };
  if (
    [...config.reviewers, config.coordinator].some(
      (member) => member.contextTier === "long_context",
    )
  )
    throw new Error("Explicit long_context is not supported by either review adapter.");
  return config;
}
export interface RepositoryReviewConfig {
  revision: string;
  digest: string;
  multiModel?: MultiModelReviewConfig;
  additionalPrompt: string;
  configText: string;
}

// Scheduling and paid-fanout authority comes only from the caller's verified
// target revision. Native skills are ordinary checkout content, not this schema.
export function loadRepositoryReviewConfig(
  cwd: string,
  revision: string,
  options: {
    allowFetch?: boolean;
    resolveBlobSizes?: (
      objectIds: readonly string[],
      deadlineAt: number,
    ) => ReadonlyMap<string, number>;
  } = {},
): RepositoryReviewConfig | undefined {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Invalid target review configuration revision.");
  const deadlineAt = Date.now() + 10_000;
  const entry = readReviewGit(cwd, ["ls-tree", "-z", revision, "--", CONFIG_PATH], {
    deadlineAt,
    maxBytes: 4096,
  });
  if (!entry) throw new Error("Cannot inspect pinned repository review configuration.");
  if (!entry.length) return undefined;
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t\.clawsweeper\/review\.json\0$/.exec(
    entry.toString("utf8"),
  );
  if (!match) throw new Error("Repository review configuration must be a regular file.");
  const oid = match[2]!;
  // Raw Git reads disable lazy fetching. Admit the one configuration blob's
  // size before any host-owned missing-object fetch or text expansion.
  const metadata = readReviewGit(cwd, ["cat-file", "--batch-check"], {
    input: Buffer.from(oid + "\n"),
    deadlineAt,
    maxBytes: 256,
  })
    ?.toString("utf8")
    .trim();
  const present = metadata && new RegExp("^" + oid + " blob ([0-9]+)$").exec(metadata);
  let bytes = present ? Number(present[1]) : undefined;
  if (!present) {
    if (metadata !== oid + " missing" || !options.allowFetch || !options.resolveBlobSizes)
      throw new Error(
        "Cannot read pinned repository review configuration: size metadata unavailable.",
      );
    bytes = options.resolveBlobSizes([oid], deadlineAt).get(oid);
  }
  if (!Number.isSafeInteger(bytes) || bytes! < 0 || bytes! > MAX_CONFIG_BYTES)
    throw new Error(
      "Repository review configuration exceeds its byte budget or has invalid size metadata.",
    );
  if (!present)
    admitAndFetchReviewBlobs(cwd, revision, [{ objectId: oid, bytes: bytes! }], deadlineAt);
  const raw = readReviewGit(cwd, ["cat-file", "blob", oid], {
    deadlineAt,
    maxBytes: MAX_CONFIG_BYTES,
  });
  if (!raw || raw.length !== bytes)
    throw new Error("Cannot read pinned repository review configuration.");
  const configText = raw.toString("utf8");
  if (!Buffer.from(configText).equals(raw))
    throw new Error("Review configuration must be UTF-8 text.");
  const parsed: unknown = JSON.parse(configText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Repository review configuration must be an object.");
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    Object.keys(value).some((key) => !["version", "additionalPrompt", "multiModel"].includes(key))
  )
    throw new Error("Unsupported repository review configuration.");
  const additionalPrompt = value.additionalPrompt === undefined ? "" : value.additionalPrompt;
  if (typeof additionalPrompt !== "string" || additionalPrompt.length > 5000)
    throw new Error("Invalid repository review additionalPrompt.");
  const multiModel = parseMultiModel(value.multiModel);
  if (!additionalPrompt.trim() && !multiModel) return undefined;
  return {
    revision,
    digest: sha256(configText),
    configText,
    additionalPrompt,
    ...(multiModel ? { multiModel } : {}),
  };
}

export function repositoryReviewContentDigest(
  base: string,
  config?: RepositoryReviewConfig,
): string {
  return config ? sha256(base + ":" + config.digest) : base;
}

export function loadLocalRepositoryReviewConfig(
  cwd: string,
  baseRef: string,
): RepositoryReviewConfig | undefined {
  const revision = baseRef.trim()
    ? readReviewGit(cwd, ["rev-parse", "--verify", "--end-of-options", baseRef + "^{commit}"])
        ?.toString("utf8")
        .trim()
    : undefined;
  if (!revision)
    throw new Error(
      "Offline repository review configuration requires a valid trusted --base snapshot.",
    );
  return loadRepositoryReviewConfig(cwd, revision);
}
