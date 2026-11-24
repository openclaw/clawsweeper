import { ghJson, githubLimitedPagePath } from "./repair/github-cli.js";
import { requirePositiveInteger, requireRecord } from "./value-coerce.js";

export interface PrClassificationSource {
  headSha: string;
  baseSha: string;
  diff: string;
  assertCurrent: () => void;
  readTool: (name: string, args: unknown) => string;
}

const record = (value: unknown) => requireRecord(value, "PR source");

function repositoryName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.split("/").length !== 2 ||
    value.split("/").some((part) => !/^[A-Za-z0-9_.-]+$/.test(part)) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Invalid repository scope");
  }
  return value;
}

function sourcePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char.charCodeAt(0) === 92,
    ) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid source path");
  }
  return value;
}

function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error("Invalid source SHA");
  }
  return value;
}

const positiveInteger = (value: unknown) =>
  requirePositiveInteger(value, "Source line or PR number");

export function readPrClassificationSource(
  repository: string,
  number: number,
  headSha: string,
  readJson: (args: string[]) => unknown = (args) => ghJson(args, { timeoutMs: 10_000 }),
): PrClassificationSource {
  repositoryName(repository);
  positiveInteger(number);
  sha(headSha);
  const endpoint = `repos/${repository}/pulls/${number}`;
  const get = (path: string) => readJson(["api", "--method", "GET", path]);
  const metadata = () => {
    const pull = record(get(endpoint));
    const head = record(pull.head);
    const base = record(pull.base);
    const headRepository = repositoryName(record(head.repo).full_name);
    const baseRepository = repositoryName(record(base.repo).full_name);
    if (baseRepository.toLowerCase() !== repository.toLowerCase()) {
      throw new Error("PR base repository scope mismatch");
    }
    if (sha(head.sha) !== headSha) throw new Error("PR head drift");
    const changedFiles = pull.changed_files;
    if (
      typeof changedFiles !== "number" ||
      !Number.isSafeInteger(changedFiles) ||
      changedFiles < 0 ||
      changedFiles > 100
    ) {
      throw new Error("PR changed_files exceeds supported limit or is invalid");
    }
    return {
      headRepository,
      baseRepository,
      baseSha: sha(base.sha),
      changedFiles,
    };
  };
  const initial = metadata();
  const headPaths = new Set<string>();
  const basePaths = new Set<string>();
  const files: Record<string, unknown>[] = [];
  for (let page = 1; page <= 2; page++) {
    const entries = get(githubLimitedPagePath(`${endpoint}/files`, 100, page));
    if (!Array.isArray(entries) || entries.length > 100 || files.length + entries.length > 100) {
      throw new Error("PR files exceed supported limit or page is invalid");
    }
    for (const entry of entries) {
      const file = record(entry);
      const filename = sourcePath(file.filename);
      if (headPaths.has(filename)) throw new Error("Duplicate PR filename");
      if (typeof file.status !== "string" || !file.status) throw new Error("Invalid file status");
      for (const count of [file.additions, file.deletions]) {
        if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
          throw new Error("Invalid file change count");
        }
      }
      if (file.patch !== undefined && typeof file.patch !== "string") {
        throw new Error("Invalid file patch");
      }
      headPaths.add(filename);
      basePaths.add(filename);
      const previousFilename =
        file.previous_filename === undefined ? undefined : sourcePath(file.previous_filename);
      if (previousFilename !== undefined) basePaths.add(previousFilename);
      files.push({
        filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(previousFilename === undefined ? {} : { previous_filename: previousFilename }),
        patch: file.patch ?? null,
        ...(file.patch === undefined
          ? { patch_note: "Patch unavailable (binary or omitted by GitHub); use source tools." }
          : {}),
      });
    }
    if (entries.length < 100) break;
  }
  if (files.length !== initial.changedFiles) throw new Error("PR files count mismatch");
  const diff = JSON.stringify(files);
  if (Buffer.byteLength(diff, "utf8") > 160_000) throw new Error("PR diff exceeds 160000 bytes");
  const assertCurrent = () => {
    const final = metadata();
    if (
      final.baseSha !== initial.baseSha ||
      final.baseRepository !== initial.baseRepository ||
      final.headRepository !== initial.headRepository ||
      final.changedFiles !== initial.changedFiles
    ) {
      throw new Error("PR source drift while reading diff");
    }
  };
  assertCurrent();
  const trees = new Map<string, Record<string, unknown>[]>();

  return {
    headSha,
    baseSha: initial.baseSha,
    diff,
    assertCurrent,
    readTool(name, args) {
      if (name !== "read_file" && name !== "search_file") throw new Error("Unknown source tool");
      const input = record(args);
      if (
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        !Object.hasOwn(input, "path") ||
        !Object.hasOwn(input, "revision") ||
        (name === "search_file" && !Object.hasOwn(input, "query"))
      ) {
        throw new Error("Source tool requires own JSON arguments");
      }
      const allowed =
        name === "read_file"
          ? ["path", "revision", "start_line", "end_line"]
          : ["path", "revision", "query"];
      if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !allowed.includes(key))) {
        throw new Error("Unknown source tool argument");
      }
      const path = sourcePath(input.path);
      const revision = input.revision;
      if (revision !== "base" && revision !== "head") throw new Error("Invalid source revision");
      if (!(revision === "base" ? basePaths : headPaths).has(path)) {
        throw new Error("Source path is not a changed file for this revision");
      }
      const start = name === "read_file" ? positiveInteger(input.start_line ?? 1) : 1;
      const end = name === "read_file" ? positiveInteger(input.end_line ?? start + 119) : 1;
      if (name === "read_file" && (end < start || end - start + 1 > 120)) {
        throw new Error("Source read must cover at most 120 lines");
      }
      const query = input.query;
      if (
        name === "search_file" &&
        (typeof query !== "string" || query.length === 0 || query.length > 200)
      ) {
        throw new Error("Search query must be a nonempty literal of at most 200 characters");
      }
      const sourceRepository =
        revision === "head" ? initial.headRepository : initial.baseRepository;
      const sourceSha = revision === "head" ? headSha : initial.baseSha;
      // Contents can dereference repository-local symlinks; inspect pinned tree modes first.
      let treeSha = sourceSha;
      const segments = path.split("/");
      for (const [index, segment] of segments.entries()) {
        const treePath = `repos/${sourceRepository}/git/trees/${treeSha}`;
        let entries = trees.get(treePath);
        if (!entries) {
          const tree = record(get(treePath));
          if (tree.truncated !== false || !Array.isArray(tree.tree)) {
            throw new Error("Source tree is incomplete");
          }
          entries = tree.tree.map(record);
          trees.set(treePath, entries);
        }
        const entry = entries.find((candidate) => candidate.path === segment);
        if (!entry) throw new Error("Source path is absent from pinned tree");
        const isFile = index === segments.length - 1;
        if (
          isFile
            ? entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode))
            : entry.type !== "tree" || entry.mode !== "040000"
        ) {
          throw new Error("Unsupported source tree mode (symlink or non-file)");
        }
        treeSha = sha(entry.sha);
      }
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const file = record(
        get(
          `repos/${sourceRepository}/contents/${encodedPath}?ref=${encodeURIComponent(sourceSha)}`,
        ),
      );
      if (
        file.type !== "file" ||
        file.target !== undefined ||
        file.submodule_git_url != null ||
        file.encoding !== "base64" ||
        typeof file.content !== "string" ||
        typeof file.size !== "number" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > 256 * 1024
      ) {
        throw new Error("Unsupported source file (non-file, symlink, encoding, or size)");
      }
      const encoded = file.content.replace(/[\r\n]/g, "");
      if (
        encoded.length > 4 * Math.ceil((256 * 1024) / 3) ||
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
      ) {
        throw new Error("Invalid source base64");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || bytes.length !== file.size) {
        throw new Error("Invalid source base64 or size mismatch");
      }
      if (bytes.includes(0)) throw new Error("Binary source file contains NUL");
      const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n");
      const selected: string[] = [];
      let truncated = false;
      if (name === "read_file") {
        for (let index = start - 1; index < Math.min(end, lines.length); index++) {
          selected.push(`${index + 1}: ${lines[index]}`);
        }
        truncated = end < lines.length;
      } else {
        for (const [index, line] of lines.entries()) {
          if (!line.includes(query as string)) continue;
          if (selected.length === 40) {
            truncated = true;
            break;
          }
          selected.push(`${index + 1}: ${line}`);
        }
      }
      const text = selected.join("\n");
      const result = {
        path,
        revision,
        sha: sourceSha,
        total_lines: lines.length,
        text,
        truncated,
        note: truncated ? "Truncated: additional lines or matches are not shown." : "",
      };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 16_000)
        return JSON.stringify(result);
      result.truncated = true;
      result.note = "Truncated: tool result exceeds 16000 bytes; narrow the line range or query.";
      let low = 0;
      let high = text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        result.text = text.slice(0, middle);
        if (Buffer.byteLength(JSON.stringify(result), "utf8") <= 16_000) low = middle;
        else high = middle - 1;
      }
      result.text = text.slice(0, low);
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16_000) {
        throw new Error("Source tool result metadata exceeds 16000 bytes");
      }
      return JSON.stringify(result);
    },
  };
}
