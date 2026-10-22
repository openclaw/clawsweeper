import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, posix } from "node:path";
import {
  ValidationRecoveryRequiredError,
  validationRecoveryRequired,
} from "./validation-recovery.js";
import MarkdownIt from "markdown-it/browser";
import { parse } from "yaml";
import { readReviewGit } from "./pr-review-evidence.js";
import { admitAndFetchReviewBlobs } from "./clawsweeper-review-blobs.js";
import { sha256 } from "./content-hash.js";
import { stableJson } from "./stable-json.js";

const CONFIG_PATH = ".clawsweeper/review.json";
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 64;
const markdown = new MarkdownIt();

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
  skills: Array<{ name: string; directory: string }>;
  files: Array<{ path: string; text: string }>;
  configText: string;
}

// The caller supplies its verified target-branch revision, never the PR head.
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
  const read = (args: string[], maxBytes = MAX_BYTES): string => {
    if (maxBytes <= 0) throw new Error("Native skill bundle exceeds text budget.");
    const bytes = readReviewGit(cwd, args, {
      maxBytes,
      deadlineAt,
    });
    if (!bytes) throw new Error("Cannot read pinned repository review configuration.");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes))
      throw new Error("Review configuration must be UTF-8 text.");
    return text;
  };
  const entries = (path: string) =>
    read(["ls-tree", "-r", "-z", revision, "--", path])
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
        if (!match) throw new Error("Review configuration cannot contain symlinks or submodules.");
        return { oid: match[2]!, path: match[3]! };
      });
  const configEntries = entries(CONFIG_PATH);
  if (!configEntries.length) return undefined;
  if (configEntries.length !== 1 || configEntries[0]!.path !== CONFIG_PATH)
    throw new Error("Repository review configuration must be a regular file.");
  const prefetch = (objects: Array<{ oid: string; path: string }>, maxBytes: number) => {
    const objectIds = [...new Set(objects.map((object) => object.oid))];
    if (!objectIds.length) return;
    // Enumerate availability before cat-file: older Git may otherwise try a lazy fetch.
    const availability = readReviewGit(
      cwd,
      [
        "--literal-pathspecs",
        "rev-list",
        "--objects",
        "--missing=print",
        revision + "^{tree}",
        "--",
        ...objects.map((object) => object.path),
      ],
      { deadlineAt, maxBytes: MAX_BYTES },
    );
    if (!availability) throw new Error("Cannot read pinned repository blob availability.");
    const missing: string[] = [],
      present: string[] = [],
      seen = new Set<string>();
    for (const line of availability.toString("utf8").split("\n")) {
      const match = /^(\??)([a-f0-9]{40})(?: |$)/.exec(line);
      if (!match || !objectIds.includes(match[2]!)) continue;
      if (seen.has(match[2]!)) throw new Error("Ambiguous pinned repository blob availability.");
      seen.add(match[2]!);
      (match[1] ? missing : present).push(match[2]!);
    }
    if (seen.size !== objectIds.length)
      throw new Error("Incomplete pinned repository blob availability.");
    const sizes = new Map<string, number>();
    if (present.length) {
      const metadata = readReviewGit(cwd, ["cat-file", "--batch-check"], {
        input: Buffer.from(present.join("\n") + "\n"),
        deadlineAt,
        maxBytes: 16 * 1024,
      });
      if (!metadata)
        throw new Error("Cannot read pinned repository review configuration metadata.");
      for (const line of metadata.toString("utf8").trim().split("\n")) {
        const match = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(line);
        if (!match || !present.includes(match[1]!) || sizes.has(match[1]!))
          throw new Error("Invalid pinned repository blob metadata.");
        sizes.set(match[1]!, Number(match[2]));
      }
    }
    if (missing.length) {
      if (!options.allowFetch || !options.resolveBlobSizes)
        throw new Error(
          "Cannot read pinned repository review configuration: size metadata unavailable.",
        );
      const remote = options.resolveBlobSizes(missing, deadlineAt);
      for (const id of missing) sizes.set(id, remote.get(id)!);
    }
    if (objectIds.some((id) => !Number.isSafeInteger(sizes.get(id)) || sizes.get(id)! < 0))
      throw new Error("Incomplete pinned repository blob sizes.");
    if (objects.reduce((sum, object) => sum + sizes.get(object.oid)!, 0) > maxBytes)
      throw new Error("Native skill bundle exceeds text budget.");
    admitAndFetchReviewBlobs(
      cwd,
      revision,
      missing.map((objectId) => ({ objectId, bytes: sizes.get(objectId)! })),
      deadlineAt,
    );
  };
  prefetch(configEntries, 16 * 1024);
  const configText = read(["cat-file", "blob", configEntries[0]!.oid], 16 * 1024);
  const config: unknown = JSON.parse(configText);
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Repository review configuration must be an object.");
  const value = config as Record<string, unknown>;
  if (
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !["version", "skills", "additionalPrompt", "multiModel"].includes(key),
    )
  )
    throw new Error("Unsupported repository review configuration.");
  const selected = value.skills === undefined ? [] : value.skills;
  const additionalPrompt = value.additionalPrompt === undefined ? "" : value.additionalPrompt;
  if (
    !Array.isArray(selected) ||
    selected.length > 8 ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) ||
    typeof additionalPrompt !== "string" ||
    additionalPrompt.length > 5_000
  )
    throw new Error("Invalid repository review skills or additionalPrompt.");
  const multiModel = parseMultiModel(value.multiModel);
  if (!selected.length && !additionalPrompt.trim() && !multiModel) return undefined;
  const files: RepositoryReviewConfig["files"] = [];
  const skills: RepositoryReviewConfig["skills"] = [];
  let size = Buffer.byteLength(configText);
  const bundles = (selected as string[]).map((directory) => ({
    directory,
    bundle: entries(".agents/skills/" + directory),
  }));
  if (bundles.reduce((count, entry) => count + entry.bundle.length, 0) > MAX_FILES)
    throw new Error("Native skill bundle exceeds file limit.");
  // One host-owned fetch for all selected blobs, not one network request per
  // cat-file on blob:none checkouts. Reads remain local and share the deadline.
  prefetch(
    bundles.flatMap(({ bundle }) => bundle),
    MAX_BYTES - size,
  );
  const nativePaths = new Set<string>();
  for (const { directory, bundle } of bundles) {
    const prefix = ".agents/skills/" + directory + "/";
    for (const file of bundle) {
      const nativePath = file.path.toLowerCase();
      if (nativePaths.has(nativePath))
        throw new Error("Case-colliding native skill bundle paths are unsupported.");
      nativePaths.add(nativePath);
      if (
        !file.path.startsWith(prefix) ||
        file.path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part.includes("\\") ||
              /[<>:"|?*]|[. ]$/.test(part) ||
              /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part) ||
              part.split("").some((character) => character.charCodeAt(0) < 32),
          )
      )
        throw new Error("Unsafe native skill bundle path.");
      if (nativePath.endsWith("/skill.md") && file.path !== prefix + "SKILL.md")
        throw new Error("Nested native skills are not selected by this configuration.");
      const text = read(["cat-file", "blob", file.oid], MAX_BYTES - size);
      size += Buffer.byteLength(text);
      if (text.includes("\0") || size > MAX_BYTES)
        throw new Error("Native skill bundle exceeds text budget.");
      // Native integration sidecars can provision tools; this lane grants no such authority.
      if (nativePath === prefix + "agents/openai.yaml") {
        const sidecar = parse(text) as Record<string, unknown> | null;
        if (sidecar?.dependencies)
          throw new Error("Native skill tool dependencies are unsupported in review.");
      }
      files.push({ path: file.path, text });
    }
    const skill = files.find((file) => file.path === prefix + "SKILL.md");
    const frontmatter = skill?.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const metadata = frontmatter ? (parse(frontmatter) as Record<string, unknown>) : null;
    if (
      metadata?.name !== directory ||
      typeof metadata.description !== "string" ||
      !metadata.description.trim()
    )
      throw new Error("Selected native skill needs matching name and description frontmatter.");
    skills.push({ name: directory, directory });
    for (const file of files.filter(
      (entry) => entry.path.startsWith(prefix) && entry.path.endsWith(".md"),
    )) {
      for (const token of markdown.parse(file.text, {}).flatMap((token) => token.children ?? [])) {
        const href = token.attrGet("href") ?? token.attrGet("src");
        if (typeof href !== "string" || !href || href.startsWith("#") || /^https?:/i.test(href))
          continue;
        const reference = decodeURIComponent(href.split(/[?#]/)[0]!);
        const path = posix.normalize(posix.join(posix.dirname(file.path), reference));
        if (
          /^[a-z][a-z0-9+.-]*:/i.test(reference) ||
          reference.startsWith("/") ||
          reference.includes("\\") ||
          !path.startsWith(prefix) ||
          !files.some((entry) => entry.path === path || entry.path.startsWith(path + "/"))
        )
          throw new Error("Native skill reference is unavailable or escapes its selected bundle.");
      }
    }
  }
  const digest = sha256(stableJson({ configText, files }));
  return {
    revision,
    digest,
    additionalPrompt,
    skills,
    files,
    configText,
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
  // The offline operator owns --base (default origin/main). Resolve that ref
  // itself: the diff merge-base and PR HEAD are not configuration authority.
  const revision = baseRef.trim()
    ? readReviewGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])
        ?.toString("utf8")
        .trim()
    : undefined;
  if (!revision)
    throw new Error(
      "Offline repository review configuration requires a valid trusted --base snapshot.",
    );
  return loadRepositoryReviewConfig(cwd, revision);
}

export function materializeNativeReviewSkills(
  config: RepositoryReviewConfig,
  sourceDir: string,
  ownedWorkspace?: string,
  preparedCodexSource?: string,
) {
  // OpenClaw keeps workspaceOnly enabled: reuse the already-owned review-tree
  // parent with the reviewed checkout and a verified host-prepared source sibling.
  // Never move a user checkout or expose another item through a broader workspace.
  if (ownedWorkspace) {
    const root = realpathSync(ownedWorkspace);
    const source = realpathSync(sourceDir);
    const entries = readdirSync(root).filter((entry) => {
      const path = join(root, entry);
      return !(
        entry === "codex" &&
        preparedCodexSource &&
        lstatSync(path).isSymbolicLink() &&
        realpathSync(path) === realpathSync(preparedCodexSource)
      );
    });
    if (dirname(source) !== root || entries.length !== 1 || join(root, entries[0]!) !== source)
      throw new Error("Native OpenClaw skills require an isolated owned review-tree parent.");
  }
  const cwd = ownedWorkspace
    ? realpathSync(ownedWorkspace)
    : mkdtempSync(join(tmpdir(), "clawsweeper-native-skills-"));
  const identity = (path: string) => {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) return undefined;
    return [
      stat.dev,
      stat.ino,
      stat.isDirectory(),
      stat.isSymbolicLink() ? readlinkSync(path) : "",
    ].join(":");
  };
  const rootIdentity = identity(cwd);
  const preserved = ownedWorkspace
    ? new Map(readdirSync(cwd).map((entry) => [entry, identity(join(cwd, entry))]))
    : undefined;
  const cleanup = (cause?: unknown) => {
    if (!preserved) {
      rmSync(cwd, { recursive: true, force: true });
      return false;
    }
    // A renamed source or replaced sibling is recovery evidence, not disposable
    // agent scratch. Preserve everything if an original identity changed.
    if (
      identity(cwd) !== rootIdentity ||
      [...preserved].some(([entry, expected]) => identity(join(cwd, entry)) !== expected)
    )
      throw (
        validationRecoveryRequired(cause) ??
        new ValidationRecoveryRequiredError("Native review workspace identity changed", cause)
      ).retain([cwd]);
    const added = readdirSync(cwd).filter((entry) => entry !== ".agents" && !preserved.has(entry));
    rmSync(join(cwd, ".agents"), { recursive: true, force: true });
    for (const entry of added) rmSync(join(cwd, entry), { recursive: true, force: true });
    return added.length > 0;
  };
  try {
    for (const file of config.files) {
      const path = join(cwd, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.text, { flag: "wx", mode: 0o400 });
    }
    const invocation = config.skills.map(
      (skill) =>
        "[$" + skill.name + "](" + join(cwd, ".agents/skills", skill.directory, "SKILL.md") + ")",
    );
    const prompt = [
      "## Explicit repository review configuration",
      "Trusted target revision: " + config.revision + "; bundle digest: " + config.digest + ".",
      "Review source checkout: " +
        JSON.stringify(resolve(sourceDir)) +
        ". Use absolute paths or git -C for source inspection; this native skill workspace is not the reviewed source.",
      "Use only the explicitly selected native skills below. Their guidance is subordinate to the host review contract: no bundled helpers, installation, writes, model changes or other reviewers. Do not activate source-checkout skill changes.",
      ...invocation,
    ]
      .filter(Boolean)
      .join("\n");
    return { cwd, prompt, cleanup };
  } catch (error) {
    cleanup(error);
    throw error;
  }
}
