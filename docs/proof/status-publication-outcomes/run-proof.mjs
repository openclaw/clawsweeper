import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const sourcePaths = [
  "dashboard",
  "src",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.dashboard.json",
  "test/helpers/publication-status-fixture.ts",
  "docs/proof/bay-readable-layout/fixtures.mjs",
];
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const base = process.argv[2];
const lifetime = process.argv.includes("--lifetime");
const serveBrowser = process.argv.includes("--serve-browser");
const workerOnly = serveBrowser || process.argv.includes("--worker-only");
assert.ok(
  !lifetime || !workerOnly,
  "--lifetime cannot combine with --worker-only or --serve-browser",
);
const wranglerBin = process.env.PUBLICATION_PROOF_WRANGLER;
const wranglerVersion = wranglerBin
  ? execFileSync(wranglerBin, ["--version"], { encoding: "utf8" }).trim()
  : "4.131.1";
assert.match(base ?? "", /^[a-f0-9]{40}$/, "pass the full approved baseline SHA");
const proofPath = "docs/proof/status-publication-outcomes";
const artifacts = path.join(root, ".artifacts/status-publication-outcomes");
const prepareCapsule = option("--prepare-capsule");
if (prepareCapsule) {
  const archive = execFileSync("git", ["archive", "--format=tar.gz", base, ...sourcePaths], {
    maxBuffer: 16_000_000,
  });
  assert.ok(archive.length < 4_000_000, "proof capsule archive budget");
  const baseFiles = git(["ls-tree", "-r", base, "--", ...sourcePaths])
    .trim()
    .split("\n")
    .map((line) => {
      const [metadata, file] = line.split("\t");
      const [mode, kind, blob] = metadata.split(" ");
      assert.ok(
        ["100644", "100755"].includes(mode) && kind === "blob",
        "only regular source files",
      );
      return { file, blob, sha256: "" };
    });
  const blobs = execFileSync("git", ["cat-file", "--batch"], {
    input: baseFiles.map(({ blob }) => blob).join("\n") + "\n",
    maxBuffer: 16_000_000,
  });
  let offset = 0;
  for (const entry of baseFiles) {
    const end = blobs.indexOf(10, offset);
    const [blob, kind, size] = blobs.subarray(offset, end).toString().split(" ");
    assert.equal(blob, entry.blob);
    assert.equal(kind, "blob");
    offset = end + 1;
    entry.sha256 = sha256(blobs.subarray(offset, offset + Number(size)));
    offset += Number(size) + 1;
  }
  const candidateNames = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...sourcePaths,
    proofPath,
    "test/dashboard-worker-dashboard-status.test.ts",
    "test/dashboard-worker-status-privacy.test.ts",
    "test/dashboard-worker-observability.test.ts",
  ])
    .trim()
    .split("\n")
    .sort();
  const candidateFiles = await Promise.all(
    candidateNames.map(async (file) => ({
      file,
      sha256: sha256(await readFile(path.join(root, file))),
    })),
  );
  const capsule = {
    schema: "status-proof-capsule/v1",
    base,
    base_tree: git(["rev-parse", base + "^{tree}"]).trim(),
    candidate_head: git(["rev-parse", "HEAD"]).trim(),
    candidate_head_tree: git(["rev-parse", "HEAD^{tree}"]).trim(),
    candidate_dirty: git(["status", "--porcelain"]).trim() !== "",
    candidate_patch_sha256: sha256(git(["diff", "--binary", base])),
    dashboard_patch_sha256: sha256(git(["diff", "--binary", base, "--", "dashboard"])),
    source_tree_sha256: sha256(JSON.stringify(candidateFiles)),
    archive_sha256: sha256(archive),
    base_files: baseFiles,
    candidate_files: candidateFiles,
    archive_base64: archive.toString("base64"),
  };
  await writeFile(prepareCapsule, JSON.stringify(capsule));
  console.log(
    JSON.stringify({
      capsule_sha256: sha256(JSON.stringify(capsule)),
      archive_sha256: capsule.archive_sha256,
      source_tree_sha256: capsule.source_tree_sha256,
      archive_bytes: archive.length,
      base_files: baseFiles.length,
      candidate_files: candidateFiles.length,
    }),
  );
  process.exit(0);
}
const capsulePath = option("--capsule");
const capsule = capsulePath ? JSON.parse(await readFile(capsulePath, "utf8")) : null;
if (capsule) {
  assert.equal(capsule.schema, "status-proof-capsule/v1");
  assert.equal(capsule.base, base);
  assert.equal(sha256(JSON.stringify(capsule.candidate_files)), capsule.source_tree_sha256);
  await verifyFiles(root, capsule.candidate_files);
}
const scratch = await mkdtemp(path.join(tmpdir(), "publication-proof-"));
const beforeRoot = path.join(scratch, "base");
const children = [];
const now = Date.now() - 1_000;
const head = capsule?.candidate_head ?? git(["rev-parse", "HEAD"]).trim();
const dirty = capsule?.candidate_dirty ?? git(["status", "--porcelain"]).trim() !== "";
const patchSha256 =
  capsule?.dashboard_patch_sha256 ?? sha256(git(["diff", "--binary", base, "--", "dashboard"]));
await mkdir(artifacts, { recursive: true });

try {
  await mkdir(beforeRoot);
  if (capsule) {
    const archive = Buffer.from(capsule.archive_base64, "base64");
    assert.equal(sha256(archive), capsule.archive_sha256);
    const archivePath = path.join(scratch, "base.tar.gz");
    await writeFile(archivePath, archive);
    const members = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((file) => !file.endsWith("/"))
      .sort();
    assert.deepEqual(members, capsule.base_files.map(({ file }) => safeSourcePath(file)).sort());
    execFileSync("tar", ["-xzf", archivePath, "-C", beforeRoot]);
    await verifyFiles(beforeRoot, capsule.base_files);
  } else {
    execFileSync("git", ["archive", "-o", path.join(scratch, "base.tar"), base], { cwd: root });
    execFileSync("tar", ["-xf", path.join(scratch, "base.tar"), "-C", beforeRoot]);
  }
  await symlink(path.join(root, "node_modules"), path.join(beforeRoot, "node_modules"));
  await cp(path.join(root, proofPath), path.join(beforeRoot, proofPath), { recursive: true });
  await cp(
    path.join(root, "test/helpers/publication-status-fixture.ts"),
    path.join(beforeRoot, "test/helpers/publication-status-fixture.ts"),
  );
  const results = [];
  const browserResults = [];
  for (const [label, source] of [
    ["base", beforeRoot],
    ["candidate", root],
  ]) {
    const preview = await startWorker(label, source);
    if (lifetime) {
      const { proveLifetime } = await import("./lifetime-proof.mjs");
      results.push(await proveLifetime(preview.origin, label, artifacts));
      await stopWorker(preview);
      continue;
    }
    for (const mode of ["cold", "durable", "fresh", "stale"]) {
      for (const kind of ["observed", "idle", "mixed", "unknown", "lossy"]) {
        if (kind === "lossy" && (mode === "cold" || mode === "durable")) continue;
        await json(preview.origin, "/__proof/seed", {
          method: "POST",
          body: JSON.stringify({ mode, kind, now: Date.now() - 1_000 }),
        });
        const dedicated = await json(preview.origin, "/api/recent-durable-publication-events");
        const response = await fetch(`${preview.origin}/api/status`);
        assert.equal(response.status, 200);
        const status = await response.json();
        const nested = status.recent_durable_publication_events;
        const expected = kind === "lossy" ? null : dedicated.recent_durable_publication_events;
        const observations = await json(preview.origin, "/__proof/observations");
        assert.equal(
          response.headers.get("x-clawsweeper-cache"),
          mode === "fresh" || mode === "stale" ? mode : "miss",
        );
        assert.equal(JSON.stringify(status).includes("withheld-publication-identity"), false);
        if (mode === "durable") {
          assert.equal(status.fleet.active_codex_jobs, 17);
          assert.ok(observations.store_reads > 0);
          assert.equal(observations.blocked_requests, 0);
        }
        if (label === "candidate") {
          assert.deepEqual(nested, expected, `${mode}/${kind}: typed publication parity`);
        } else {
          assert.notDeepEqual(nested, expected, `${mode}/${kind}: baseline must reproduce loss`);
          if (kind !== "lossy") {
            assert.deepEqual(nested.direct.counts, {});
            assert.equal(nested.captured_at, undefined);
          }
        }
        results.push({
          revision: label,
          mode,
          kind,
          cache: response.headers.get("x-clawsweeper-cache"),
          nested_sha256: sha256(JSON.stringify(nested)),
          direct_accepted: nested?.direct?.counts?.accepted ?? null,
          batch_retryable: nested?.batch?.counts?.retryable ?? null,
          window: nested?.window?.id ?? null,
          captured_at: nested?.captured_at ?? null,
          projection_is_null: nested === null,
          collection_state: nested?.collection?.state ?? null,
          ...observations,
        });
      }
    }
    if (workerOnly) {
      browserResults.push({ revision: label, origin: preview.origin, automated_browser: false });
    } else {
      const { proveBrowser } = await import("./browser-proof.mjs");
      browserResults.push(await proveBrowser(preview.origin, label, artifacts, now));
    }
    if (!serveBrowser) await stopWorker(preview);
  }
  if (capsule) await verifyFiles(root, capsule.candidate_files);
  const summary = {
    schema: lifetime ? "status-refresh-lifetime-proof/v1" : "status-publication-outcomes-proof/v1",
    base,
    candidate_head: head,
    candidate_dirty: dirty,
    dashboard_patch_sha256: patchSha256,
    ...(capsule
      ? {
          source_capsule: {
            base_tree: capsule.base_tree,
            candidate_head_tree: capsule.candidate_head_tree,
            candidate_patch_sha256: capsule.candidate_patch_sha256,
            source_tree_sha256: capsule.source_tree_sha256,
            archive_sha256: capsule.archive_sha256,
            base_files_verified: capsule.base_files.length,
            candidate_files_verified: capsule.candidate_files.length,
          },
        }
      : {}),
    runtime: {
      node: process.version,
      wrangler: wranglerVersion,
      transport: "real loopback HTTP",
      storage: "local SQLite-backed StatusStore",
      synthetic_queue_binding: true,
    },
    generated_at: new Date().toISOString(),
    paired_scenarios: results.filter((result) => result.revision === "candidate").length,
    runs: results.length,
    results,
    production_mutations: 0,
    worker_outbound_network: "denied by fixture",
    browser_proof: browserResults,
    limits: lifetime
      ? [
          "Synthetic held binding and body; the production stalled dependency remains unknown.",
          "Both served clients use the real Worker route and their ordinary timers.",
        ]
      : [
          "Synthetic inputs; no production state or timing claim.",
          "Corrected-input browser cases isolate browser ingestion using a fixture status route.",
          "Worker-route browser cases fetch the real Worker status route; cached reload uses a controlled HTTP 503.",
        ],
  };
  await writeFile(
    path.join(artifacts, lifetime ? "lifetime-summary.json" : "worker-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      base,
      head,
      dirty,
      paired_scenarios: summary.paired_scenarios,
      runs: summary.runs,
      result: "passed",
    }),
  );
  if (serveBrowser) {
    console.log(JSON.stringify({ browser_previews: browserResults }));
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} catch (error) {
  for (const preview of children) {
    const output = (await readFile(preview.logPath, "utf8"))
      .replaceAll(root, "<checkout>")
      .replaceAll(scratch, "<proof>");
    console.error(output.slice(-8_000));
  }
  throw error;
} finally {
  for (const child of children) await stopWorker(child);
  await rm(scratch, { recursive: true, force: true });
}

function safeSourcePath(file) {
  assert.ok(typeof file === "string" && !path.isAbsolute(file) && !file.split("/").includes(".."));
  assert.ok(
    [
      ...sourcePaths,
      proofPath,
      "test/dashboard-worker-dashboard-status.test.ts",
      "test/dashboard-worker-status-privacy.test.ts",
      "test/dashboard-worker-observability.test.ts",
    ].some((owner) => file === owner || file.startsWith(owner + "/")),
  );
  return file;
}
async function verifyFiles(directory, files) {
  for (const { file, sha256: expected } of files) {
    assert.equal(
      sha256(await readFile(path.join(directory, safeSourcePath(file)))),
      expected,
      file,
    );
  }
}
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function json(origin, route, init) {
  const response = await fetch(origin + route, init);
  assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
  return response.json();
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function startWorker(label, source) {
  const port = await availablePort();
  const config = path.join(scratch, `${label}.json`);
  await writeFile(
    config,
    JSON.stringify({
      name: `publication-proof-${label}`,
      main: path.join(source, proofPath, "fixture-worker.ts"),
      compatibility_date: "2026-05-11",
      send_metrics: false,
      durable_objects: { bindings: [{ name: "LOCAL_STATUS_STORE", class_name: "StatusStore" }] },
      migrations: [{ tag: "proof-v1", new_sqlite_classes: ["StatusStore"] }],
    }),
  );
  const logPath = path.join(scratch, `${label}.log`);
  const log = createWriteStream(logPath);
  const child = spawn(
    wranglerBin || "npx",
    [
      ...(wranglerBin ? [] : ["--yes", "wrangler@4.131.1"]),
      "dev",
      "--local",
      "--config",
      config,
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      path.join(scratch, `${label}-state`),
    ],
    {
      cwd: scratch,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NO_COLOR: "1",
        XDG_CONFIG_HOME: path.join(scratch, "config"),
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: path.join(scratch, "logs"),
        CI: "1",
      },
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const preview = { child, log, logPath, origin: `http://127.0.0.1:${port}`, stopped: false };
  children.push(preview);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(`${preview.origin}/__proof/ready`)).ok) return preview;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const output = (await readFile(logPath, "utf8"))
    .replaceAll(root, "<checkout>")
    .replaceAll(scratch, "<proof>");
  throw new Error(`local ${label} Worker failed to start:\n${output}`);
}
async function stopWorker(preview) {
  if (preview.stopped) return;
  preview.stopped = true;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-preview.child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    if (signal === "SIGTERM" && preview.child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => preview.child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }
  await new Promise((resolve) => preview.log.end(resolve));
}
