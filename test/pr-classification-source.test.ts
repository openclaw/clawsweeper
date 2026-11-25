import assert from "node:assert/strict";
import test from "node:test";
import { readPrClassificationSource } from "../dist/pr-classification-source.js";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);

function fixture() {
  const metadata = {
    head: { sha: headSha, repo: { full_name: "contributor/fork" } },
    base: { sha: baseSha, repo: { full_name: "openclaw/clawsweeper" } },
    changed_files: 1,
  };
  const file = {
    filename: "src/a #?.ts",
    status: "renamed",
    previous_filename: "old.ts",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
  };
  const pages: unknown[] = [[file], []];
  const content: Record<string, unknown> = {
    type: "file",
    encoding: "base64",
    content: Buffer.from("first\nneedle [literal]\nlast").toString("base64"),
    size: Buffer.byteLength("first\nneedle [literal]\nlast"),
    download_url: "https://untrusted.invalid/download",
  };
  const calls: string[][] = [];
  const treeEntry = { mode: "100644", type: "blob", sha: "d".repeat(40) };
  let metadataReads = 0;
  let onMetadata = (_read: number) => {};
  const readJson = (args: string[]) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 3), ["api", "--method", "GET"]);
    const path = args[3]!;
    if (path.includes("/git/trees/")) {
      return {
        truncated: false,
        tree: [
          { path: "src", type: "tree", mode: "040000", sha: "c".repeat(40) },
          { ...treeEntry, path: "a #?.ts" },
          { ...treeEntry, path: "old.ts" },
        ],
      };
    }
    if (path.includes("/contents/")) return structuredClone(content);
    if (path.includes("/files?")) {
      assert.match(path, /per_page=100&page=\d+$/);
      const page = Number(path.match(/page=(\d+)$/)![1]);
      return structuredClone(pages[page - 1]);
    }
    assert.equal(path, "repos/openclaw/clawsweeper/pulls/42");
    onMetadata(++metadataReads);
    return structuredClone(metadata);
  };
  return {
    metadata,
    file,
    pages,
    content,
    calls,
    treeEntry,
    set onMetadata(value: typeof onMetadata) {
      onMetadata = value;
    },
    source: () => readPrClassificationSource("openclaw/clawsweeper", 42, headSha, readJson),
    setText(value: string) {
      content.content = Buffer.from(value).toString("base64");
      content.size = Buffer.byteLength(value);
    },
  };
}

test("source includes complete changed-file diff and pinned read-only tools", () => {
  const f = fixture();
  const source = f.source();
  assert.equal(source.headSha, headSha);
  assert.equal(source.baseSha, baseSha);
  assert.deepEqual(JSON.parse(source.diff), {
    changed_files: 1,
    included_files: 1,
    truncated: false,
    files: [f.file],
  });
  assert.equal(f.calls.length, 3);
  const head = JSON.parse(
    source.readTool("read_file", { path: f.file.filename, revision: "head", start_line: 2 }),
  );
  assert.equal(head.text, "2: needle [literal]\n3: last");
  assert.equal(head.sha, headSha);
  assert.equal(
    f.calls.at(-1)![3],
    `repos/contributor/fork/contents/src/a%20%23%3F.ts?ref=${headSha}`,
  );
  const base = JSON.parse(
    source.readTool("search_file", { path: "old.ts", revision: "base", query: "[literal]" }),
  );
  assert.equal(base.text, "2: needle [literal]");
  assert.equal(f.calls.at(-1)![3], `repos/openclaw/clawsweeper/contents/old.ts?ref=${baseSha}`);
  assert.equal(
    f.calls.some((call) => call.some((arg) => arg.includes("untrusted.invalid"))),
    false,
  );
});

test("renamed old path is allowed only on base; tools reject unknown paths and arguments before GET", () => {
  const f = fixture();
  const source = f.source();
  const initialCalls = f.calls.length;
  for (const [name, args] of [
    ["write_file", {}],
    ["read_file", { path: "old.ts", revision: "head" }],
    ["read_file", { path: "other.ts", revision: "base" }],
    ["read_file", { path: "../old.ts", revision: "base" }],
    ["read_file", { path: "/old.ts", revision: "base" }],
    ["read_file", { path: "src//x", revision: "head" }],
    ["read_file", { path: f.file.filename, revision: "main" }],
    ["read_file", { path: f.file.filename, revision: "head", start_line: 0 }],
    ["read_file", { path: f.file.filename, revision: "head", start_line: 1.5 }],
    ["read_file", { path: f.file.filename, revision: "head", end_line: 121 }],
    ["read_file", { path: f.file.filename, revision: "head", start_line: 2, end_line: 1 }],
    ["read_file", { path: f.file.filename, revision: "head", url: "https://example.com" }],
    ["search_file", { path: f.file.filename, revision: "head", query: "" }],
    ["search_file", { path: f.file.filename, revision: "head", query: "x".repeat(201) }],
    ["read_file", Object.create({ path: f.file.filename, revision: "head" })],
  ] as const) {
    assert.throws(() => source.readTool(name, args));
  }
  assert.equal(f.calls.length, initialCalls);
});

test("read and literal search enforce line and JSON byte limits with explicit notes", () => {
  const f = fixture();
  const source = f.source();
  f.setText(Array.from({ length: 130 }, (_, i) => `match${i}`).join("\n"));
  const read = JSON.parse(
    source.readTool("read_file", { path: f.file.filename, revision: "head" }),
  );
  assert.equal(read.text.split("\n").length, 120);
  assert.equal(read.truncated, true);
  assert.match(read.note, /Truncated/);
  const search = JSON.parse(
    source.readTool("search_file", { path: f.file.filename, revision: "head", query: "match" }),
  );
  assert.equal(search.text.split("\n").length, 40);
  assert.equal(search.truncated, true);
  const noRegex = JSON.parse(
    source.readTool("search_file", { path: f.file.filename, revision: "head", query: "match.*" }),
  );
  assert.equal(noRegex.text, "");
  f.setText("😀".repeat(20_000));
  const bounded = source.readTool("read_file", { path: f.file.filename, revision: "head" });
  assert.ok(Buffer.byteLength(bounded) <= 16_000);
  assert.equal(JSON.parse(bounded).truncated, true);
  assert.match(JSON.parse(bounded).note, /16000/);
});

test("missing patches are explicit, never silently dropped", () => {
  const f = fixture();
  Reflect.deleteProperty(f.file, "patch");
  const diff = JSON.parse(f.source().diff).files;
  assert.equal(diff[0].patch, null);
  assert.match(diff[0].patch_note, /binary or omitted/);
});

const fileNamed = (f: ReturnType<typeof fixture>, i: number, patch = f.file.patch) => ({
  ...f.file,
  filename: `file${i}`,
  patch,
});

test("files beyond 100 are paginated without a file-count cap", () => {
  const f = fixture();
  f.metadata.changed_files = 123;
  f.pages[0] = Array.from({ length: 100 }, (_, i) => fileNamed(f, i));
  f.pages[1] = Array.from({ length: 23 }, (_, i) => fileNamed(f, 100 + i));
  const diff = JSON.parse(f.source().diff);
  assert.equal(diff.files.length, 123);
  assert.equal(diff.truncated, false);
  f.pages[1] = [...(f.pages[1] as unknown[]), fileNamed(f, 999)];
  assert.throws(f.source, /files page/);
});

test("oversized diff is truncated to the byte budget instead of failing", () => {
  const f = fixture();
  f.metadata.changed_files = 123;
  // Quotes and newlines expand when embedded in the packet; budget counts encoded bytes.
  const patch = '@@ -1 +1 @@\n-"old"\n+"new"\n'.repeat(120);
  f.pages[0] = Array.from({ length: 100 }, (_, i) => fileNamed(f, i, patch));
  f.pages[1] = Array.from({ length: 23 }, (_, i) => fileNamed(f, 100 + i, patch));
  const source = f.source();
  const encoded = Buffer.byteLength(JSON.stringify(source.diff)) - 2;
  assert.ok(encoded <= 160_000 && encoded > 159_000, String(encoded));
  const diff = JSON.parse(source.diff);
  assert.equal(diff.truncated, true);
  assert.equal(diff.changed_files, 123);
  assert.equal(diff.included_files, diff.files.length);
  assert.ok(diff.files.length > 10 && diff.files.length < 100);
  assert.match(diff.note, /truncated/);
  const last = diff.files.at(-1);
  assert.equal(last.patch_truncated, true);
  assert.ok(patch.startsWith(last.patch) && last.patch.length < patch.length);
  assert.ok(diff.files.slice(0, -1).every((file: { patch: string }) => file.patch === patch));
  // Stops listing once the budget is spent, and source tools stay limited to listed files.
  assert.equal(
    f.calls.some((call) => call[3]?.endsWith("page=2")),
    false,
  );
  assert.throws(
    () => source.readTool("read_file", { path: "file99", revision: "head" }),
    (error: Error) =>
      error.name === "PrClassificationToolInputError" && /not a changed file/.test(error.message),
  );
  assert.throws(
    () => source.readTool("read_file", { path: last.filename, revision: "head" }),
    /absent from pinned tree/,
  );
});

test("smaller packet budgets shrink the diff; an unusable budget is a source limit", () => {
  const f = fixture();
  f.file.patch = "é".repeat(80_000);
  const read = (budget: number) =>
    readPrClassificationSource(
      "openclaw/clawsweeper",
      42,
      headSha,
      (args) => {
        const path = args[3]!;
        if (path.includes("/files?")) return structuredClone(f.pages[0]);
        return structuredClone(f.metadata);
      },
      budget,
    );
  const source = read(20_000);
  assert.ok(Buffer.byteLength(JSON.stringify(source.diff)) - 2 <= 20_000);
  const [file] = JSON.parse(source.diff).files;
  assert.equal(file.patch_truncated, true);
  assert.ok(/^é+$/.test(file.patch));
  assert.throws(() => read(500), /source-limit/);
});

test("rejects count mismatches, duplicate files and invalid paths", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => (f.metadata.changed_files = 2),
    (f: ReturnType<typeof fixture>) => (f.pages[0] = [f.file, f.file]),
    (f: ReturnType<typeof fixture>) => (f.file.filename = "../escape"),
    (f: ReturnType<typeof fixture>) => (f.file.filename = "a\\b"),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(f.source);
  }
});

test("metadata fences expected head, base, scope and changed file count", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => (f.metadata.head.sha = "c".repeat(40)),
    (f: ReturnType<typeof fixture>) => (f.metadata.base.sha = "c".repeat(40)),
    (f: ReturnType<typeof fixture>) => (f.metadata.base.repo.full_name = "other/repo"),
    (f: ReturnType<typeof fixture>) => (f.metadata.head.repo.full_name = "other/repo"),
    (f: ReturnType<typeof fixture>) => (f.metadata.changed_files = 2),
  ]) {
    const f = fixture();
    f.onMetadata = (read) => {
      if (read === 2) change(f);
    };
    assert.throws(f.source, /drift|scope/);
  }
  const f = fixture();
  const source = f.source();
  source.assertCurrent();
  f.metadata.base.sha = "c".repeat(40);
  assert.throws(source.assertCurrent, /drift/);
});

test("source file validation rejects nonfiles, symlinks, submodules, malformed base64 and binary", () => {
  for (const update of [
    { type: "symlink" },
    { type: "dir" },
    { target: "elsewhere" },
    { submodule_git_url: "https://other.invalid/repo" },
    { encoding: "none" },
    { size: 262_145 },
    { size: -1 },
    { content: "!!!" },
    { content: "Zg=", size: 1 },
    { content: "Zh==", size: 1 },
    { content: "Zg==", size: 2 },
    { content: "AA==", size: 1 },
    { content: "/w==", size: 1 },
  ]) {
    const f = fixture();
    const source = f.source();
    Object.assign(f.content, update);
    assert.throws(() => source.readTool("read_file", { path: f.file.filename, revision: "head" }));
  }
  const f = fixture();
  const source = f.source();
  f.setText("x".repeat(262_144));
  assert.ok(
    Buffer.byteLength(source.readTool("read_file", { path: f.file.filename, revision: "head" })) <=
      16_000,
  );
  f.content.content = "Zg==\n";
  f.content.size = 1;
  assert.equal(
    JSON.parse(source.readTool("read_file", { path: f.file.filename, revision: "head" })).text,
    "1: f",
  );
});

test("pinned Git tree mode rejects dereferenced symlinks before reading contents", () => {
  for (const [mode, type] of [
    ["120000", "blob"],
    ["160000", "commit"],
    ["040000", "tree"],
  ]) {
    const f = fixture();
    const source = f.source();
    Object.assign(f.treeEntry, { mode, type });
    assert.throws(
      () => source.readTool("read_file", { path: f.file.filename, revision: "head" }),
      /tree mode/,
    );
    assert.equal(
      f.calls.some((call) => call[3]?.includes("/contents/")),
      false,
    );
    assert.ok(f.calls.some((call) => call[3] === `repos/contributor/fork/git/trees/${headSha}`));
  }
});
