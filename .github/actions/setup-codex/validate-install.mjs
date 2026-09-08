import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

class UnsafePath extends Error {}

function inside(root, path) {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafePath("managed installation path escapes its owner");
  }
}

// Check even dangling links before deciding whether npm may repair a partial cache.
function contained(root, path, depth = 0) {
  if (path !== root && !path.startsWith(`${root}${sep}`))
    throw new UnsafePath("managed installation path escapes its owner");
  let current = root;
  let directory = true;
  let anchored = true;
  let unresolved;
  function walk(raw, level) {
    if (level > 32) throw new UnsafePath("managed installation has a symlink cycle");
    if (isAbsolute(raw)) {
      current = sep;
      directory = true;
      anchored = false;
      raw = raw.slice(1);
    }
    for (const part of raw.split(sep)) {
      // Missing or non-directory traversal stays failed, including across a link's caller suffix.
      if (unresolved !== undefined) unresolved += `${sep}${part}`;
      else if (!directory) unresolved = `${current}${sep}${part}`;
      const next =
        part === ".."
          ? dirname(current)
          : part === "." || part === ""
            ? current
            : join(current, part);
      const owned = next === root || next.startsWith(`${root}${sep}`);
      // Absolute targets may reanchor through owner ancestors, never unrelated outside branches.
      if (!owned && (anchored || (next !== sep && !root.startsWith(`${next}${sep}`))))
        throw new UnsafePath("managed installation path escapes its owner");
      anchored ||= owned;
      if (part === "." || part === "" || part === "..") {
        current = next;
        if (part === "..") directory = true;
        continue;
      }
      let info;
      if (unresolved === undefined) {
        try {
          info = lstatSync(next);
        } catch (error) {
          if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
          unresolved = next;
        }
      }
      if (info?.isSymbolicLink()) {
        // Expand relative targets from the resolved parent before consuming the caller suffix.
        walk(readlinkSync(next), level + 1);
        inside(root, current);
      } else {
        current = next;
        directory = info?.isDirectory() ?? false;
      }
    }
  }
  walk(path.slice(root.length + 1), depth);
  return unresolved ?? current;
}

// A dangling search-directory link is visited invalid state, not an absent alias.
function aliasPresent(root, path) {
  let current = path;
  for (;;) {
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      contained(root, current);
      throw error;
    }
    if (info.isSymbolicLink()) {
      if (current === root || current.startsWith(`${root}${sep}`)) {
        statSync(contained(root, current));
      } else {
        // An unused outside directory may establish absence, not authorize a dependency.
        try {
          info = statSync(current);
        } catch (error) {
          throw new UnsafePath("unusable outside alias search directory", { cause: error });
        }
        if (!info.isDirectory())
          throw new UnsafePath("outside alias search path is not a directory");
      }
    }
    return current === path;
  }
}

function metadata(path) {
  const info = statSync(path);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error("invalid package metadata file");
  return JSON.parse(readFileSync(path, "utf8"));
}

function executable(path) {
  if (!statSync(path).isFile()) throw new Error("missing executable");
  accessSync(path, constants.X_OK);
}

async function probe(command, args, home) {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(command, args, {
      cwd: home,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: home,
        CODEX_HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: "C",
      },
    });
    let output = "";
    let size = 0;
    let invalid = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    };
    const timeout = setTimeout(() => {
      invalid = true;
      stop();
    }, 5_000);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (data) => {
        size += data.length;
        if (size > 64 * 1024) {
          invalid = true;
          stop();
        } else if (stream === child.stdout) {
          output += data.toString("utf8");
        }
      });
    }
    child.on("error", () => {
      invalid = true;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      stop();
      if (invalid || code !== 0) reject(new Error("executable probe failed"));
      else resolveProbe(output.trim());
    });
  });
}

async function validate(name, version) {
  if (
    !["codex", "codex-responses-api-proxy"].includes(name) ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)
  ) {
    throw new UnsafePath("unsupported package or non-exact version");
  }
  const target = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
  }[`${process.platform}-${process.arch}`];
  if (!target) throw new UnsafePath("unsupported runner platform");
  const home = realpathSync(process.env.HOME);
  const prefix = join(home, ".clawsweeper-repair", "codex");
  contained(home, prefix);
  for (const path of [dirname(prefix), prefix]) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new UnsafePath("managed prefix is a symlink");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const pkg = join(prefix, "lib/node_modules/@openai", name);
  const launcher = join(pkg, "bin", `${name}.js`);
  const bin = join(prefix, "bin", name);
  const manifest = join(pkg, "package.json");
  const nativeSuffix = join("vendor", target, name === "codex" ? "bin" : name, name);
  let nativeRoot = pkg;
  const alias = `@openai/codex-${process.platform}-${process.arch}`;
  for (const path of [manifest, launcher, bin]) contained(prefix, path);
  const canonicalLauncher = contained(prefix, launcher);
  const resolver = createRequire(canonicalLauncher);
  let selectedManifest;
  if (name === "codex") {
    // Stop at the first present package, even if its final manifest is missing.
    // Lower aliases and local vendor are not part of this launcher's active lookup.
    for (const directory of resolver.resolve.paths(alias)) {
      if (directory.startsWith(`${prefix}${sep}`)) contained(prefix, directory);
      if (!aliasPresent(prefix, directory)) continue;
      const candidate = join(directory, alias);
      if (!aliasPresent(prefix, candidate)) continue;
      selectedManifest = contained(prefix, join(candidate, "package.json"));
      nativeRoot = dirname(selectedManifest);
      break;
    }
  }
  const native = join(nativeRoot, nativeSuffix);
  contained(prefix, native);

  const data = metadata(manifest);
  if (
    data.name !== `@openai/${name}` ||
    data.version !== version ||
    data.bin?.[name] !== `bin/${name}.js`
  ) {
    throw new Error("package identity, version, or launcher mismatch");
  }
  if (realpathSync(launcher) !== join(realpathSync(pkg), "bin", `${name}.js`))
    throw new Error("managed launcher mismatch");
  const platformVersion = `${version}-${process.platform}-${process.arch}`;
  if (name === "codex") {
    if (data.optionalDependencies?.[alias] !== `npm:@openai/codex@${platformVersion}`)
      throw new Error("platform alias identity or version mismatch");
    if (selectedManifest) {
      const platformData = metadata(selectedManifest);
      // The published platform package is @openai/codex under a local npm alias.
      if (platformData.name !== "@openai/codex" || platformData.version !== platformVersion)
        throw new Error("platform package identity or version mismatch");
    }
    let resolved;
    try {
      // Match rust-v0.153.3's launcher: resolve the optional alias, else local vendor.
      resolved = resolver.resolve(`${alias}/package.json`);
    } catch (error) {
      if (selectedManifest || error.code !== "MODULE_NOT_FOUND") throw error;
    }
    if (resolved) contained(prefix, resolved);
    if (resolved !== selectedManifest) throw new Error("platform alias resolution mismatch");
  }
  if (realpathSync(bin) !== realpathSync(launcher)) throw new Error("managed launcher mismatch");
  executable(bin);
  executable(native);
  const scratch = mkdtempSync(join(tmpdir(), "codex-install-probe-"));
  try {
    const args = [name === "codex" ? "--version" : "--help"];
    for (const [command, commandArgs] of [
      [native, args],
      [bin, args],
    ]) {
      const output = await probe(command, commandArgs, scratch);
      if (
        name === "codex"
          ? output !== `codex-cli ${version}`
          : !/^Usage: codex-responses-api-proxy\b/m.test(output)
      ) {
        throw new Error("executable output mismatch");
      }
    }
    console.log(name === "codex" ? `codex-cli ${version}` : `Validated ${name} ${version}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await validate(process.argv[2], process.argv[3]);
} catch (error) {
  const unsafe = error instanceof UnsafePath;
  console.error(
    unsafe
      ? "Unsafe managed Codex installation path; refusing automatic repair."
      : "Managed Codex installation is missing, mismatched, or unusable.",
  );
  process.exitCode = unsafe ? 2 : 1;
}
