import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../scripts/release-local-package-envelope.mjs", import.meta.url),
);
const names = ["clawsweeper-local.tgz", "manifest.json", "package-lock.json", "package.json"];
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "release-envelope-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const input = join(root, "input");
  const output = join(root, "envelope.tar.gz");
  mkdirSync(source);
  mkdirSync(input);
  function git(...args: string[]) {
    const result = spawnSync("git", ["-C", source, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const name = "@openclaw/clawsweeper";
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name, version: "0.3.1", private: true }),
  );
  git("init", "-q");
  git("add", "package.json");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture source",
  );
  const metadata = {
    name: "clawsweeper-local-install",
    version: "0.0.0",
    private: true,
    dependencies: { [name]: "file:clawsweeper-local.tgz" },
  };
  const tgz = Buffer.from("unchanged qualified inner archive");
  const local = {
    version: "0.3.1",
    resolved: "file:clawsweeper-local.tgz",
    integrity: `sha512-${createHash("sha512").update(tgz).digest("base64")}`,
  };
  const lock = {
    name: metadata.name,
    lockfileVersion: 3,
    packages: { "": metadata, [`node_modules/${name}`]: local },
  };
  writeFileSync(join(input, "clawsweeper-local.tgz"), tgz);
  writeFileSync(join(input, "package.json"), JSON.stringify(metadata));
  writeFileSync(join(input, "package-lock.json"), JSON.stringify(lock));
  const manifest = {
    source: git("rev-parse", "HEAD"),
    sourceTree: git("rev-parse", "HEAD^{tree}"),
    sourceDiffSha256: sha256(""),
    platform: "linux",
    files: names
      .filter((path) => path !== "manifest.json")
      .map((path) => {
        const bytes = readFileSync(join(input, path));
        return { path, bytes: bytes.length, sha256: sha256(bytes) };
      }),
    resolution: [{ path: `node_modules/${name}`, ...local }],
  };
  function saveManifest() {
    writeFileSync(join(input, "manifest.json"), JSON.stringify(manifest));
  }
  function replace(name: string, bytes: Buffer) {
    writeFileSync(join(input, name), bytes);
    Object.assign(
      manifest.files.find((file) => file.path === name)!,
      {
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    );
    saveManifest();
  }
  saveManifest();
  const run = (id = "123") =>
    spawnSync(process.execPath, [script, id], {
      cwd: source,
      env: {
        ...process.env,
        RELEASE_ASSET_INPUT_DIR: input,
        RELEASE_ASSET_PATH: output,
        TAR_OPTIONS: "--invalid-inherited-option",
        GZIP: "--invalid-inherited-option",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
  return { root, input, output, source, manifest, saveManifest, replace, git, run };
}

test("release envelope refuses invalid IDs and unqualified input before archiving", async (t) => {
  for (const id of ["", "0", "01", "123,456", "9007199254740992", "1;echo x"]) {
    await t.test(`ID ${JSON.stringify(id)}`, (t) => {
      const f = fixture(t);
      const result = f.run(id);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /positive safe artifact ID/);
      assert.ok(!readdirSync(f.root).includes("envelope.tar.gz"));
    });
  }
  const cases = [
    [
      "source",
      (f: ReturnType<typeof fixture>) => {
        f.manifest.source = "a".repeat(40);
        f.saveManifest();
      },
      /source differs/,
    ],
    [
      "tree",
      (f: ReturnType<typeof fixture>) => {
        f.manifest.sourceTree = "a".repeat(40);
        f.saveManifest();
      },
      /sourceTree differs/,
    ],
    [
      "diff",
      (f: ReturnType<typeof fixture>) => {
        f.manifest.sourceDiffSha256 = "a".repeat(64);
        f.saveManifest();
      },
      /sourceDiffSha256 differs/,
    ],
    [
      "hash",
      (f: ReturnType<typeof fixture>) => {
        f.manifest.files[0]!.sha256 = "a".repeat(64);
        f.saveManifest();
      },
      /input hash mismatch/,
    ],
    [
      "extra",
      (f: ReturnType<typeof fixture>) => writeFileSync(join(f.input, ".hidden"), "extra"),
      /exactly four files/,
    ],
    [
      "missing",
      (f: ReturnType<typeof fixture>) => rmSync(join(f.input, "clawsweeper-local.tgz")),
      /exactly four files/,
    ],
    [
      "dirty source",
      (f: ReturnType<typeof fixture>) => writeFileSync(join(f.source, "untracked"), "dirty"),
      /checkout must be clean/,
    ],
  ] as const;
  for (const [label, mutate, message] of cases)
    await t.test(label, (t) => {
      const f = fixture(t);
      mutate(f);
      const result = f.run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.ok(!readdirSync(f.root).includes("envelope.tar.gz"));
    });
});

test("release envelope refuses symlink inputs", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const original = join(f.input, "clawsweeper-local.tgz");
  const other = join(f.root, "other.tgz");
  writeFileSync(other, readFileSync(original));
  rmSync(original);
  symlinkSync(other, original);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a regular input file/);
});

test("newer-main envelope cannot be wrapped for an older release checkout", (t) => {
  const f = fixture(t);
  const release = f.manifest.source;
  f.git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "newer main",
  );
  f.manifest.source = f.git("rev-parse", "HEAD");
  f.saveManifest();
  f.git("checkout", "--detach", release);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source differs/);
});

test("release envelope rejects unqualified lock entries even with matching file hashes", async (t) => {
  for (const kind of ["local integrity", "private registry", "escaping path", "graph drift"]) {
    await t.test(kind, (t) => {
      const f = fixture(t);
      const lock = JSON.parse(readFileSync(join(f.input, "package-lock.json"), "utf8"));
      if (kind === "local integrity")
        lock.packages["node_modules/@openclaw/clawsweeper"].integrity = "sha512-AAAA";
      else {
        const entry = {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/dependency/-/dependency-1.0.0.tgz",
          integrity: "sha512-AAAA",
        };
        if (kind === "private registry") entry.resolved = "https://example.invalid/package.tgz";
        lock.packages[
          kind === "escaping path" ? "node_modules/../escape" : "node_modules/dependency"
        ] = entry;
      }
      f.replace("package-lock.json", Buffer.from(JSON.stringify(lock)));
      const result = f.run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /qualified resolution|lock package path|strictly equal/);
      assert.ok(!readdirSync(f.root).includes("envelope.tar.gz"));
    });
  }
});

test(
  "GNU archive preserves exact four bytes independent of input metadata",
  { skip: process.platform !== "linux" },
  (t) => {
    const f = fixture(t);
    const before = names.map((name) => readFileSync(join(f.input, name)));
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    const packed = readFileSync(f.output);
    const receipt = JSON.parse(first.stdout);
    assert.equal(receipt.artifactId, "123");
    assert.equal(receipt.sha256, sha256(packed));
    assert.equal(receipt.bytes, packed.length);
    const extracted = join(f.root, "extracted");
    mkdirSync(extracted);
    const extraction = spawnSync("tar", ["-xzf", f.output, "-C", extracted], { encoding: "utf8" });
    assert.equal(extraction.status, 0, extraction.stderr);
    assert.deepEqual(readdirSync(extracted).sort(), names);
    for (const [i, name] of names.entries()) {
      assert.deepEqual(readFileSync(join(extracted, name)), before[i]);
      assert.equal(lstatSync(join(extracted, name)).mode & 0o777, 0o644);
      assert.equal(lstatSync(join(extracted, name)).mtimeMs, 0);
      utimesSync(join(f.input, name), new Date("2030-01-01"), new Date("2030-01-01"));
    }
    rmSync(f.output);
    const second = f.run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(f.output), packed);
    const duplicate = f.run();
    assert.equal(duplicate.status, 1);
    assert.deepEqual(readFileSync(f.output), packed, "existing output must never be overwritten");
  },
);
