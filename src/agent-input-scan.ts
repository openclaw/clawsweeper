import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  openSync,
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewToolCacheRoot } from "./review-tool-bootstrap.js";
import { readReviewGit, reviewMergeBase, type ReviewGitReadOptions } from "./pr-review-evidence.js";
import {
  classifyReviewedFixtureScan,
  type ReviewedFixtureNotice,
  type ScanInputOrigin,
  type ScanRefusalDiagnostic,
  type ScanSourceReference,
  type ScanSourceRole,
  type StagedScanInput,
} from "./agent-input-scan-fixtures.js";

export type AgentScanSource =
  | { kind: "prompt" }
  | { kind: "committed"; baseSha: string; headSha: string }
  | {
      kind: "snapshot";
      baseSha: string;
      headSha: string;
      treeSha: string;
      indexTreeSha: string;
      objectEnv: NodeJS.ProcessEnv;
      assertCurrent: () => void;
    };

export class AgentInputScanError extends Error {
  readonly retryable = false;
  reviewedHeadSha?: string;
  constructor(
    readonly reason:
      | "scanner_unavailable"
      | "scanner_failed"
      | "findings"
      | "deadline"
      | "staging_limit"
      | "incomplete_source"
      | "source_drift"
      | "unsafe_path"
      | "unsupported_content",
    readonly scanDiagnostic?: ScanRefusalDiagnostic,
  ) {
    super(
      `Agent input scan refused: ${reason}. Restore trusted scan prerequisites or remove sensitive input before retrying.`,
    );
    this.name = "AgentInputScanError";
  }
}

export const INCOMPLETE_AGENT_INPUT_SOURCE_EXIT_CODE = 78;
export const AGENT_INPUT_FINDINGS_EXIT_CODE = 79;

export function agentInputScanFailureExitCode(error: unknown): number | null {
  if (!(error instanceof AgentInputScanError)) return null;
  if (error.reason === "incomplete_source") return INCOMPLETE_AGENT_INPUT_SOURCE_EXIT_CODE;
  return error.reason === "findings" ? AGENT_INPUT_FINDINGS_EXIT_CODE : null;
}

export const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_TOOL_BOOTSTRAP_ENV = [
  "SystemRoot",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const;

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function trustedExecutable(name: string, cwd: string, lexicalCwd: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, process.platform === "win32" ? `${name}.exe` : name);
    if (
      [cwd, resolve(lexicalCwd), hostRoot, realpathSync(hostRoot)].some((root) =>
        within(root, candidate),
      )
    )
      continue;
    let actual: string;
    try {
      // Resolve parent aliases (for example /tmp -> /private/tmp) without
      // losing the location of a target-owned executable symlink itself.
      const location = join(realpathSync(dir), name);
      if (within(cwd, location) || within(realpathSync(hostRoot), location)) continue;
      actual = realpathSync(candidate);
    } catch {
      continue;
    }
    if (within(cwd, actual) || within(realpathSync(hostRoot), actual)) continue;
    try {
      accessSync(actual, constants.X_OK);
      if (!statSync(actual).isFile()) continue;
    } catch {
      continue;
    }
    return actual;
  }
  throw new AgentInputScanError("scanner_unavailable");
}

function realpathWithMissingTail(path: string): string {
  const tail: string[] = [];
  const seenLinks = new Set<string>();
  let current = path;
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        if (seenLinks.has(current)) throw new Error("Scanner cache symlink cycle.");
        seenLinks.add(current);
        // A cache below an external alias such as macOS /tmp is safe when its
        // canonical location is outside the checkouts. Resolve the link and
        // let the caller apply that canonical boundary check.
        current = resolve(dirname(current), readlinkSync(current));
        continue;
      }
      return resolve(realpathSync(current), ...tail);
    } catch (error) {
      if (error instanceof AgentInputScanError) throw error;
      const parent = dirname(current);
      if (parent === current)
        throw new Error("Could not resolve scanner cache location.", { cause: error });
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

export function managedScannerCacheRoot(
  env: NodeJS.ProcessEnv,
  cwd: string,
  lexicalCwd: string,
): string {
  let root: string;
  try {
    root = reviewToolCacheRoot(env);
  } catch (error) {
    if (error instanceof AgentInputScanError) throw error;
    throw new AgentInputScanError("scanner_unavailable");
  }
  const protectedRoots = [cwd, resolve(lexicalCwd), hostRoot, realpathSync(hostRoot)];
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathWithMissingTail(root);
  } catch (error) {
    if (error instanceof AgentInputScanError) throw error;
    throw new AgentInputScanError("scanner_unavailable");
  }
  if (
    protectedRoots.some(
      (protectedRoot) => within(protectedRoot, root) || within(protectedRoot, resolvedRoot),
    )
  )
    throw new AgentInputScanError("unsafe_path");
  return root;
}

export function reviewToolBootstrapEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of REVIEW_TOOL_BOOTSTRAP_ENV) {
    const value = env[name];
    if (value !== undefined) child[name] = value;
  }
  return child;
}

function trustedScanner(cwd: string, lexicalCwd: string, timeoutMs: number): string {
  try {
    return trustedExecutable("trufflehog", cwd, lexicalCwd);
  } catch (error) {
    if (!(error instanceof AgentInputScanError) || error.reason !== "scanner_unavailable")
      throw error;
  }
  const cacheRoot = managedScannerCacheRoot(process.env, cwd, lexicalCwd);
  const installer = join(hostRoot, "scripts", "setup-review-tools.mjs");
  const result = spawnSync(process.execPath, [installer, "--timeout-ms", String(timeoutMs)], {
    encoding: "utf8",
    env: {
      ...reviewToolBootstrapEnvironment(process.env),
      // The child receives only the parent-validated absolute location, so it
      // cannot create a managed cache inside either checkout before refusal.
      CLAWSWEEPER_REVIEW_TOOLS_DIR: cacheRoot,
    },
    timeout: timeoutMs,
    maxBuffer: 4096,
    windowsHide: true,
  });
  const path = result.status === 0 ? result.stdout.trim() : "";
  if (!path || !isAbsolute(path) || path.includes("\0"))
    throw new AgentInputScanError("scanner_unavailable");
  let actual: string;
  try {
    actual = realpathSync(path);
    const stat = lstatSync(actual);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe scanner cache entry");
  } catch {
    throw new AgentInputScanError("scanner_unavailable");
  }
  if (
    [cwd, resolve(lexicalCwd), hostRoot, realpathSync(hostRoot)].some((root) =>
      within(root, actual),
    )
  )
    throw new AgentInputScanError("unsafe_path");
  return actual;
}

export function scanAgentInput(options: {
  cwd: string;
  prompt: string;
  source: AgentScanSource;
  timeoutMs: number;
  schemaPath?: string;
  additionalBytes?: readonly Buffer[];
}): void {
  const deadlineAt = Date.now() + options.timeoutMs;
  const remaining = () => {
    const ms = deadlineAt - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) throw new AgentInputScanError("deadline");
    return ms;
  };
  let root: string | undefined;
  let failure: AgentInputScanError | undefined;
  let classified: ReviewedFixtureNotice[] | undefined;
  try {
    const cwd = realpathSync(options.cwd);
    const scanner = trustedScanner(cwd, options.cwd, remaining());
    root = mkdtempSync(join(realpathSync(tmpdir()), "clawsweeper-input-scan-"));
    if (within(cwd, root) || within(realpathSync(hostRoot), root))
      throw new AgentInputScanError("unsafe_path");
    const inputDir = join(root, "input");
    mkdirSync(inputDir, { mode: 0o700 });
    const inputs = new Map<string, StagedScanInput>();
    let staged = 0;
    let ordinal = 0;
    const stage = (bytes: Buffer, origin: ScanInputOrigin, name = String(ordinal++)) => {
      remaining();
      staged += bytes.length;
      if (staged > MAX_SCAN_BYTES) throw new AgentInputScanError("staging_limit");
      writeFileSync(join(inputDir, name), bytes, { mode: 0o600, flag: "wx" });
      inputs.set(join(inputDir, name), {
        ...origin,
        id: name,
        ...(origin.kind === "blob" ? { bytes } : {}),
      });
    };
    stage(Buffer.from(options.prompt), { kind: "prompt" }, "prompt");
    if (options.schemaPath) {
      if (statSync(options.schemaPath).size > MAX_SCAN_BYTES - staged)
        throw new AgentInputScanError("staging_limit");
      stage(readFileSync(options.schemaPath), { kind: "schema" }, "schema");
    }
    for (const bytes of options.additionalBytes ?? []) stage(bytes, { kind: "additional" });
    const source = options.source;
    let assertCurrent = () => {};
    if (source.kind !== "prompt") {
      const readOptions: ReviewGitReadOptions = {
        executable: trustedExecutable("git", cwd, options.cwd),
        deadlineAt,
        maxBytes: MAX_SCAN_BYTES,
        ...(source.kind === "snapshot" ? { objectEnv: source.objectEnv } : {}),
      };
      const git = (
        args: string[],
        maxBytes = MAX_SCAN_BYTES - staged,
        configuration?: ReviewGitReadOptions["configuration"],
      ) => {
        remaining();
        const bytes = readReviewGit(cwd, args, {
          ...readOptions,
          maxBytes: Math.max(1, maxBytes),
          ...(configuration ? { configuration } : {}),
        });
        if (bytes === null) throw new AgentInputScanError("incomplete_source");
        return bytes;
      };
      if (!OBJECT_ID.test(source.baseSha) || !OBJECT_ID.test(source.headSha))
        throw new AgentInputScanError("incomplete_source");
      const mergeBase = reviewMergeBase(cwd, source.baseSha, source.headSha, readOptions);
      if (mergeBase.status !== "verified") throw new AgentInputScanError("incomplete_source");
      const currentFiles: Array<{ path: string; mode: string; oid: string }> = [];
      const rawIdentities = new Map<string, string>();
      const hash = (bytes: Buffer, length: number) =>
        createHash(length === 64 ? "sha256" : "sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
      // Git's built-in text conversion runs only in a private repository with no
      // target config or filter commands. The raw bytes are still scanned below.
      const canonicalOid = (entry: (typeof currentFiles)[number], bytes: Buffer) => {
        const configuration = (args: string[]) =>
          git(args, MAX_SCAN_BYTES - staged, "normalization");
        const attributes = configuration([
          "check-attr",
          "-z",
          "text",
          "eol",
          "ident",
          "filter",
          "working-tree-encoding",
          "--",
          entry.path,
        ])
          .toString()
          .split("\0");
        const rules: string[] = [];
        for (let i = 0; i + 2 < attributes.length; i += 3) {
          const key = attributes[i + 1]!;
          const value = attributes[i + 2]!;
          if (["filter", "working-tree-encoding"].includes(key)) {
            if (!["unspecified", "unset"].includes(value))
              throw new AgentInputScanError("unsupported_content");
          } else if (value !== "unspecified") {
            if (!["set", "unset", "auto", "lf", "crlf"].includes(value))
              throw new AgentInputScanError("unsupported_content");
            rules.push(value === "set" ? key : value === "unset" ? `-${key}` : `${key}=${value}`);
          }
        }
        const canonicalRoot = join(root!, "canonical");
        mkdirSync(canonicalRoot, { recursive: true, mode: 0o700 });
        const safeGit = (args: string[], input?: Buffer) => {
          const result = readReviewGit(canonicalRoot, args, {
            ...readOptions,
            objectEnv: {},
            ...(input ? { input } : {}),
          });
          if (result === null) throw new AgentInputScanError("incomplete_source");
          return result.toString().trim();
        };
        safeGit([
          "init",
          "-q",
          `--object-format=${entry.oid.length === 64 ? "sha256" : "sha1"}`,
          ".",
        ]);
        writeFileSync(join(canonicalRoot, ".gitattributes"), `content ${rules.join(" ")}\n`, {
          mode: 0o600,
        });
        const autocrlf = configuration(["config", "--default=false", "--get", "core.autocrlf"])
          .toString()
          .trim();
        const eol = configuration(["config", "--default=native", "--get", "core.eol"])
          .toString()
          .trim();
        return safeGit(
          [
            "-c",
            `core.autocrlf=${autocrlf}`,
            "-c",
            `core.eol=${eol}`,
            "hash-object",
            "--path=content",
            "--stdin",
          ],
          bytes,
        );
      };
      if (source.kind === "snapshot") {
        assertCurrent = source.assertCurrent;
      } else {
        assertCurrent = () => {
          if (
            git(["rev-parse", "HEAD"]).toString().trim() !== source.headSha ||
            git([
              "diff-index",
              "--cached",
              "--no-ext-diff",
              "--no-textconv",
              "--name-only",
              "-z",
              "HEAD",
              "--",
            ]).length !== 0
          )
            throw new AgentInputScanError("source_drift");
          file: for (const entry of currentFiles) {
            // Deleted descendants need no filesystem traversal: an introduced
            // file or symlink may now occupy their old directory.
            let parent = cwd;
            for (const part of entry.path.split("/").slice(0, -1)) {
              parent = join(parent, part);
              let stat;
              try {
                stat = lstatSync(parent);
              } catch (error) {
                if (
                  entry.mode === "000000" &&
                  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
                )
                  continue file;
                throw new AgentInputScanError("source_drift");
              }
              if (!stat.isDirectory() || stat.isSymbolicLink()) {
                if (entry.mode === "000000") continue file;
                throw new AgentInputScanError("unsafe_path");
              }
            }
            const file = join(cwd, entry.path);
            let stat;
            try {
              stat = lstatSync(file);
            } catch (error) {
              if (entry.mode === "000000" && (error as NodeJS.ErrnoException).code === "ENOENT")
                continue;
              throw new AgentInputScanError("source_drift");
            }
            if (entry.mode === "000000") {
              if (!stat.isDirectory()) throw new AgentInputScanError("source_drift");
              continue;
            }
            const symlinkFile =
              entry.mode === "120000" &&
              stat.isFile() &&
              git(
                ["config", "--type=bool", "--default=true", "--get", "core.symlinks"],
                1024,
                "normalization",
              )
                .toString()
                .trim() === "false";
            if (entry.mode === "120000" ? !stat.isSymbolicLink() && !symlinkFile : !stat.isFile())
              throw new AgentInputScanError("source_drift");
            if (stat.size > MAX_SCAN_BYTES) throw new AgentInputScanError("staging_limit");
            let bytes: Buffer;
            if (stat.isSymbolicLink()) bytes = readlinkSync(file, { encoding: "buffer" });
            else {
              const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
              try {
                bytes = readFileSync(fd);
              } finally {
                closeSync(fd);
              }
            }
            const oid = hash(bytes, entry.oid.length);
            const previous = rawIdentities.get(entry.path);
            if (previous !== undefined) {
              if (previous !== oid) throw new AgentInputScanError("source_drift");
              continue;
            }
            if (
              oid !== entry.oid &&
              (entry.mode === "120000" || canonicalOid(entry, bytes) !== entry.oid)
            )
              throw new AgentInputScanError("source_drift");
            rawIdentities.set(entry.path, oid);
            if (oid !== entry.oid)
              stage(bytes, {
                kind: "worktree",
                references: [
                  {
                    source: entry.path,
                    mode: entry.mode,
                    revision: source.headSha,
                    role: "worktree",
                  },
                ],
              });
          }
        };
      }
      assertCurrent();
      const blobs = new Map<string, ScanSourceReference[]>();
      const endpoints =
        source.kind === "snapshot"
          ? [mergeBase.sha, source.headSha, source.indexTreeSha, source.treeSha]
          : [mergeBase.sha, source.headSha];
      const endpointRoles =
        source.kind === "snapshot"
          ? (["base", "head", "index", "tree"] as const)
          : (["base", "head"] as const);
      for (let endpoint = 1; endpoint < endpoints.length; endpoint++) {
        const from = endpoints[endpoint - 1]!;
        const to = endpoints[endpoint]!;
        const fromRole = endpointRoles[endpoint - 1];
        const toRole = endpointRoles[endpoint];
        if (!fromRole || !toRole) throw new AgentInputScanError("incomplete_source");
        if (!OBJECT_ID.test(to)) throw new AgentInputScanError("incomplete_source");
        const args = [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--ignore-submodules=none",
          from,
          to,
        ];
        const raw = git([...args, "--raw", "--no-abbrev", "-z", "--"]);
        stage(raw, { kind: "raw_diff", from, to });
        const fields = new TextDecoder("utf-8", { fatal: true }).decode(raw).split("\0");
        if (fields.pop() !== "" || fields.length % 2 !== 0)
          throw new AgentInputScanError("incomplete_source");
        for (let i = 0; i < fields.length; i += 2) {
          const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [AMDT]$/.exec(fields[i]!);
          const path = fields[i + 1]!;
          if (
            !path ||
            Buffer.from(path).some((byte) => byte < 32 || byte === 92) ||
            isAbsolute(path) ||
            /^[A-Za-z]:/.test(path) ||
            path.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
          )
            throw new AgentInputScanError("unsafe_path");
          if (!match) throw new AgentInputScanError("incomplete_source");
          if (source.kind === "committed")
            currentFiles.push({ path, mode: match[2]!, oid: match[4]! });
          const changedReferences: readonly [string, string, string, ScanSourceRole][] = [
            [match[1]!, match[3]!, from, fromRole],
            [match[2]!, match[4]!, to, toRole],
          ];
          for (const [mode, oid, revision, role] of changedReferences) {
            if (mode === "000000") continue;
            if (!["100644", "100755", "120000"].includes(mode!))
              throw new AgentInputScanError("unsupported_content");
            if (!OBJECT_ID.test(oid!)) throw new AgentInputScanError("incomplete_source");
            // An OID identifies bytes, not each scanned endpoint's path/mode eligibility.
            const references = blobs.get(oid!) ?? [];
            if (
              !references.some(
                (reference) =>
                  reference.source === path &&
                  reference.mode === mode &&
                  reference.revision === revision &&
                  reference.role === role,
              )
            )
              references.push({ source: path, mode: mode!, revision: revision!, role });
            blobs.set(oid!, references);
          }
        }
        stage(git([...args, "--patch", "--binary", "--full-index", "--"]), {
          kind: "patch",
          from,
          to,
        });
      }
      // Only live committed checkouts need normalized raw files staged here;
      // snapshot objects were already captured and fenced before preparation.
      if (source.kind === "committed") assertCurrent();
      for (const [oid, references] of blobs) {
        const size = Number(git(["cat-file", "-s", oid], 100).toString().trim());
        if (!Number.isSafeInteger(size) || size < 0)
          throw new AgentInputScanError("incomplete_source");
        if (size > MAX_SCAN_BYTES - staged) throw new AgentInputScanError("staging_limit");
        const bytes = git(["cat-file", "blob", oid], Math.max(1, size));
        if (bytes.length !== size) throw new AgentInputScanError("incomplete_source");
        if (
          bytes.subarray(0, 128).toString().startsWith("version https://git-lfs.github.com/spec/v1")
        )
          throw new AgentInputScanError("unsupported_content");
        // OID names preserve multiline bytes and make symlinks ordinary scan files.
        stage(bytes, { kind: "blob", references }, oid);
      }
    }
    const result = spawnSync(
      scanner,
      [
        "filesystem",
        inputDir,
        "--results=verified,unknown",
        "--fail",
        "--fail-on-scan-errors",
        "--no-update",
        "--json",
        "--no-color",
      ],
      {
        cwd: root,
        env: {
          HOME: root,
          TMPDIR: root,
          TMP: root,
          TEMP: root,
          SystemRoot: process.env.SystemRoot,
        },
        timeout: remaining(),
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT")
      throw new AgentInputScanError("deadline");
    if (result.error || result.signal || (result.status !== 0 && result.status !== 183))
      throw new AgentInputScanError("scanner_failed");
    if (result.status === 183 || result.stdout?.length) {
      const classification = classifyReviewedFixtureScan(
        result.status!,
        result.stdout,
        result.stderr,
        inputs,
      );
      if (classification.kind === "refused")
        throw new AgentInputScanError(classification.reason, classification.diagnostic);
      classified = classification.notices;
    }
    remaining();
    assertCurrent();
    remaining();
  } catch (error) {
    // Neither Git diagnostics nor scanner output may expose the input being refused.
    failure =
      error instanceof AgentInputScanError ? error : new AgentInputScanError("incomplete_source");
  } finally {
    if (root) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        failure ??= new AgentInputScanError("scanner_failed");
      }
    }
  }
  if (failure) throw failure;
  // Emit from the host after cleanup: successful callers can discard provider
  // stderr, but this classification must remain visible without exposing values.
  for (const classification of classified ?? [])
    console.error(
      JSON.stringify({
        event: "agent_input_scan_classified",
        notice: "Reviewed synthetic fixture findings classified as non-sensitive.",
        ...classification,
      }),
    );
}
