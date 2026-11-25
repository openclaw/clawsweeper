import {
  PrClassificationError,
  PrClassificationToolInputError,
} from "./pr-classification-error.js";
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

// Bytes of the diff once embedded as a JSON string in the model packet.
const encodedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
const TRUNCATION_NOTE =
  "Diff truncated to fit the classification byte budget: files after included_files and any patch marked patch_truncated are not shown. Source tools can read only the listed files. Classify from the visible evidence; do not assume omitted changes are harmless.";

export function readPrClassificationSource(
  repository: string,
  number: number,
  headSha: string,
  readJson: (args: string[]) => unknown = (args) => ghJson(args, { timeoutMs: 10_000 }),
  maxDiffBytes = 160_000,
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
    if (sha(head.sha) !== headSha) throw new PrClassificationError("source-drift", true);
    const changedFiles = pull.changed_files;
    if (
      typeof changedFiles !== "number" ||
      !Number.isSafeInteger(changedFiles) ||
      changedFiles < 0
    ) {
      throw new Error("Invalid PR changed file count");
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
  const files: string[] = [];
  // Reserve the envelope at its largest so the final diff always fits the budget.
  const envelope = (included: number, truncated: boolean) =>
    JSON.stringify({
      changed_files: initial.changedFiles,
      included_files: included,
      truncated,
      ...(truncated ? { note: TRUNCATION_NOTE } : {}),
      files: [],
    });
  let remaining = maxDiffBytes - encodedBytes(envelope(initial.changedFiles, true));
  if (remaining < 1_000) throw new PrClassificationError("source-limit");
  let truncated = false;
  // GitHub lists at most 3,000 files (30 pages); the byte budget normally stops earlier.
  let page = 1;
  for (; page <= 30 && !truncated; page++) {
    const entries = get(githubLimitedPagePath(`${endpoint}/files`, 100, page));
    if (
      !Array.isArray(entries) ||
      entries.length > 100 ||
      files.length + entries.length > initial.changedFiles
    ) {
      throw new Error("Invalid PR files page");
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
      const previousFilename =
        file.previous_filename === undefined ? undefined : sourcePath(file.previous_filename);
      const summary = {
        filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        ...(previousFilename === undefined ? {} : { previous_filename: previousFilename }),
      };
      const serialize = (patch: string | undefined, partial = false) =>
        JSON.stringify({
          ...summary,
          patch: patch ?? null,
          ...(patch === undefined
            ? { patch_note: "Patch unavailable (binary or omitted by GitHub); use source tools." }
            : {}),
          ...(partial ? { patch_truncated: true } : {}),
        });
      const comma = files.length ? 1 : 0;
      let serialized = serialize(file.patch);
      if (encodedBytes(serialized) + comma > remaining) {
        truncated = true;
        // Keep the longest patch prefix that fits, so the boundary file stays useful.
        const patch = typeof file.patch === "string" ? file.patch : "";
        let low = -1;
        let high = patch.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (
            encodedBytes(serialize(patch.slice(0, Math.max(middle, 0)), true)) + comma <=
            remaining
          )
            low = middle;
          else high = middle - 1;
        }
        if (low < 0) break;
        let prefix = patch.slice(0, low);
        if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
        serialized = serialize(prefix, true);
      }
      headPaths.add(filename);
      basePaths.add(filename);
      if (previousFilename !== undefined) basePaths.add(previousFilename);
      files.push(serialized);
      remaining -= encodedBytes(serialized) + comma;
      if (truncated) break;
    }
    if (entries.length < 100) break;
  }
  if (!truncated && files.length !== initial.changedFiles) {
    // Only GitHub's 3,000-file listing ceiling may leave files unlisted.
    if (page <= 30 || files.length !== 3_000) throw new Error("PR files count mismatch");
    truncated = true;
  }
  const head = envelope(files.length, truncated);
  const diff = `${head.slice(0, -3)}[${files.join(",")}]}`;
  if (encodedBytes(diff) > maxDiffBytes) throw new Error("PR classification diff exceeds budget");
  const assertCurrent = () => {
    const final = metadata();
    if (
      final.baseSha !== initial.baseSha ||
      final.baseRepository !== initial.baseRepository ||
      final.headRepository !== initial.headRepository ||
      final.changedFiles !== initial.changedFiles
    ) {
      throw new PrClassificationError("source-drift", true);
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
      const refuse: (message: string) => never = (message) => {
        throw new PrClassificationToolInputError(message);
      };
      const input = record(args);
      if (
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        !Object.hasOwn(input, "path") ||
        !Object.hasOwn(input, "revision") ||
        (name === "search_file" && !Object.hasOwn(input, "query"))
      ) {
        refuse("Source tool requires own JSON arguments");
      }
      const allowed =
        name === "read_file"
          ? ["path", "revision", "start_line", "end_line"]
          : ["path", "revision", "query"];
      if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !allowed.includes(key))) {
        refuse("Unknown source tool argument");
      }
      let path = "";
      try {
        path = sourcePath(input.path);
      } catch {
        refuse("Invalid source path");
      }
      const revision = input.revision;
      if (revision !== "base" && revision !== "head") refuse("Invalid source revision");
      if (!(revision === "base" ? basePaths : headPaths).has(path)) {
        refuse(
          "Source path is not a changed file for this revision. Only files listed in the diff are readable; added files have no base and deleted files have no head.",
        );
      }
      let start = 1;
      let end = 1;
      if (name === "read_file") {
        try {
          start = positiveInteger(input.start_line ?? 1);
          end = positiveInteger(input.end_line ?? start + 119);
        } catch {
          refuse("Source line numbers must be positive integers");
        }
      }
      if (name === "read_file" && (end < start || end - start + 1 > 120)) {
        refuse("Source read must cover at most 120 lines");
      }
      const query = input.query;
      if (
        name === "search_file" &&
        (typeof query !== "string" || query.length === 0 || query.length > 200)
      ) {
        refuse("Search query must be a nonempty literal of at most 200 characters");
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
        if (!entry) refuse("Source path is absent from pinned tree");
        const isFile = index === segments.length - 1;
        if (
          isFile
            ? entry.type !== "blob" || !["100644", "100755"].includes(String(entry.mode))
            : entry.type !== "tree" || entry.mode !== "040000"
        ) {
          refuse("Unsupported source tree mode (symlink or non-file)");
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
        refuse("Unsupported source file (non-file, symlink, encoding, or size)");
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
      if (bytes.includes(0)) refuse("Binary source file contains NUL");
      let lines: string[] = [];
      try {
        lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n");
      } catch {
        refuse("Source file is not valid UTF-8");
      }
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
