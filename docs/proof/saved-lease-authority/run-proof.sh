#!/usr/bin/env bash
# Synthetic proof for a caller-owned Linux environment. No allocation or install.
set -euo pipefail
baseline=659dee73d0706fee9776f7986d9861e82b897d24
root=$(cd "${SAVED_LEASE_SOURCE_DIR:-$PWD}" && pwd)
proof="$root/docs/proof/saved-lease-authority"
output=${SAVED_LEASE_OUTPUT:?Set SAVED_LEASE_OUTPUT to a new absolute artifact directory}
wrangler=${SAVED_LEASE_WRANGLER:?Set SAVED_LEASE_WRANGLER to the installed Wrangler 4.107.0 executable}
[[ "$output" = /* && ! -e "$output" ]] || { echo 'Output must be an unused absolute path' >&2; exit 1; }
[[ "$wrangler" = /* && -x "$wrangler" ]] || { echo 'Wrangler must be an absolute executable path' >&2; exit 1; }
[[ $(node -p 'process.versions.node.split(".")[0]') = 24 ]]
[[ $(pnpm --version) = 11.10.0 ]]
command -v setsid >/dev/null
command -v curl >/dev/null
mkdir -p "$output"
runtime=$(mktemp -d /tmp/clawsweeper-saved-lease-proof.XXXXXX)
mkdir -p "$runtime/home" "$runtime/baseline" "$runtime/candidate"
wrangler_pid=
cleanup() {
  if [[ -n "$wrangler_pid" ]]; then
    kill -- "-$wrangler_pid" 2>/dev/null || true
    wait "$wrangler_pid" 2>/dev/null || true
  fi
  rm -rf "$runtime"
}
trap cleanup EXIT
# A clean HOME and allowlisted environment prevent Wrangler/GitHub credential discovery.
clean_env=(env -i "PATH=$PATH" "HOME=$runtime/home" CI=1 WRANGLER_SEND_METRICS=false)
"${clean_env[@]}" "$wrangler" --version > "$output/wrangler-version.txt"
[[ $(cat "$output/wrangler-version.txt") = 4.107.0 ]]
node --input-type=module - "$wrangler" "$output/toolchain.json" <<'JS'
import { createRequire } from "node:module";
import { realpathSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
const requireWrangler = createRequire(realpathSync(process.argv[2]));
const miniflarePackage = requireWrangler.resolve("miniflare/package.json");
const requireMiniflare = createRequire(miniflarePackage);
const workerdPackage = requireMiniflare.resolve("workerd/package.json");
const workerdBinary = path.join(path.dirname(workerdPackage), "bin", "workerd");
writeFileSync(
  process.argv[3],
  JSON.stringify(
    {
      miniflare: JSON.parse(readFileSync(miniflarePackage, "utf8")).version,
      workerd_package: JSON.parse(readFileSync(workerdPackage, "utf8")).version,
      workerd_binary_version: execFileSync(workerdBinary, ["--version"], {
        encoding: "utf8",
      }).trim(),
    },
    null,
    2,
  ) + "\n",
);
JS
cd "$root"
if [[ -n "${SAVED_LEASE_BASELINE_ARCHIVE:-}" ]]; then
  # Supply the exact baseline archive described in README.md.
  cp "$SAVED_LEASE_BASELINE_ARCHIVE" "$runtime/baseline.tar"
else
  git archive --format=tar "$baseline" dashboard src config .github/workflows/sweep.yml package.json > "$runtime/baseline.tar"
fi
# Reject unsafe archive paths/links before extraction; never unpack over synced source.
node --input-type=module - "$runtime/baseline.tar" <<'JS'
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
assert.equal(
  createHash("sha256").update(readFileSync(process.argv[2])).digest("hex"),
  "f1873d20690bbc76f53257949caf6f55301f47279a844c2e416a0ed637fafd07",
  "baseline archive does not match the recorded commit",
);
const names = execFileSync("tar", ["-tf", process.argv[2]], { encoding: "utf8" })
  .trim()
  .split("\n");
for (const name of names)
  assert(
    !name.startsWith("/") &&
      !name.split("/").includes("..") &&
      /^(dashboard\/|src\/|config\/|\.github\/|package\.json$)/.test(name),
    name,
  );
const entries = execFileSync("tar", ["-tvf", process.argv[2]], { encoding: "utf8" })
  .trim()
  .split("\n");
for (const entry of entries)
  assert(["-", "d"].includes(entry[0]), "Archive links/special files prohibited");
JS
tar -xf "$runtime/baseline.tar" -C "$runtime/baseline"
# Copy only tracked task source, never .dev.vars, .git, or unrelated artifacts.
while IFS= read -r -d '' file; do
  [[ -f "$root/$file" && ! -L "$root/$file" ]] || { echo "Non-regular source: $file" >&2; exit 1; }
  mkdir -p "$runtime/candidate/$(dirname "$file")"
  cp "$root/$file" "$runtime/candidate/$file"
done < <(git ls-files -z -- dashboard src config .github/workflows/sweep.yml package.json)
for mode in baseline candidate; do
  ln -s "$root/node_modules" "$runtime/$mode/node_modules"
done
ln -s "$root/node_modules" "$runtime/node_modules"
node --input-type=module - "$root" "$runtime" "$output" "$baseline" <<'JS'
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const [root, runtime, output, baseline] = process.argv.slice(2);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const changed = git(["diff", "--name-only", "HEAD"]).split("\n").filter(Boolean);
const proofFiles = [
  "run-proof.sh",
  "worker.ts",
  "drive-proof.mjs",
  "annotation-proof.mjs",
  "README.md",
];
const sourceHashes = (dir) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath, e.name))
      .sort()
      .map((f) => [path.relative(dir, f), hash(f)]),
  );
writeFileSync(
  path.join(output, "manifest.json"),
  JSON.stringify(
    {
      baseline,
      head: git(["rev-parse", "HEAD"]),
      tree: git(["rev-parse", "HEAD^{tree}"]),
      node: process.version,
      pnpm: "11.10.0",
      wrangler: "4.107.0",
      baseline_archive_sha256: hash(path.join(runtime, "baseline.tar")),
      lockfile_sha256: hash(path.join(root, "pnpm-lock.yaml")),
      proof_hashes: Object.fromEntries(
        proofFiles.map((f) => [f, hash(path.join(root, "docs/proof/saved-lease-authority", f))]),
      ),
      working_tree_changes: changed,
      changed_content: Object.fromEntries(changed.map((f) => [f, hash(path.join(root, f))])),
      source_hashes: {
        baseline: sourceHashes(path.join(runtime, "baseline")),
        candidate: sourceHashes(path.join(runtime, "candidate")),
      },
      limits: [
        "seeded admission",
        "signed supplied terminal_runs; no GitHub run lookup",
        "no Actions admission/deployed edge/whole hosted workflow",
        "outbound Worker fetch prohibited",
        "dispatch alarm suppressed only after pending inspection",
        "caller supplies provider/image/lease provenance",
      ],
    },
    null,
    2,
  ) + "\n",
);
JS
cp "$proof/worker.ts" "$runtime/entry.ts"
cat > "$runtime/wrangler.toml" <<'CONFIG'
name = "saved-lease-isolated-proof"
main = "entry.ts"
compatibility_date = "2026-05-11"
[[durable_objects.bindings]]
name = "EXACT_REVIEW_QUEUE"
class_name = "ExactReviewQueue"
[[durable_objects.bindings]]
name = "STATUS_STORE"
class_name = "StatusStore"
[[migrations]]
tag = "v1"
new_sqlite_classes = ["ExactReviewQueue", "StatusStore"]
[vars]
CLAWSWEEPER_WEBHOOK_SECRET = "saved-lease-isolated-synthetic-secret"
CLAWSWEEPER_REPO = "openclaw/clawsweeper"
PUBLIC_BAY_REPOS = "openclaw/openclaw"
GITHUB_API_URL = "http://127.0.0.1:9"
CACHE_TTL_SECONDS = "0"
STALE_CACHE_TTL_SECONDS = "0"
INCLUDE_CI_STATUS = "0"
EXACT_REVIEW_DISPATCH_DEBOUNCE_MS = "900000"
EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS = "900000"
CONFIG
cp "$proof/drive-proof.mjs" "$runtime/drive-proof.mjs"
cp "$proof/annotation-proof.mjs" "$runtime/annotation-proof.mjs"
# Retain exactly the generated synthetic harness, not any ephemeral credentials or state.
cp "$runtime/entry.ts" "$runtime/drive-proof.mjs" "$runtime/annotation-proof.mjs" "$runtime/wrangler.toml" "$output/"
node "$runtime/annotation-proof.mjs" "$runtime/baseline" "$runtime/candidate" "$output/annotations.json" > "$output/annotations.log" 2>&1
port=${SAVED_LEASE_PORT:-8795}
node --input-type=module - "$port" <<'JS'
import net from "node:net";
const server = net.createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(Number(process.argv[2]), "127.0.0.1", resolve);
});
await new Promise((resolve) => server.close(resolve));
JS
for mode in baseline candidate; do
  cp "$runtime/entry.ts" "$runtime/wrangler.toml" "$runtime/$mode/"
  printf '%s\n' "mode=$mode command=Wrangler 4.107.0 dev --local --ip 127.0.0.1 --port $port --persist-to <isolated temporary SQLite state>" >> "$output/commands.log"
  (
    cd "$runtime/$mode"
    exec "${clean_env[@]}" setsid "$wrangler" dev --config wrangler.toml --local --ip 127.0.0.1 --port "$port" --persist-to "$runtime/$mode-state"
  ) > "$output/$mode-wrangler.log" 2>&1 &
  wrangler_pid=$!
  ready=0
  for ((attempt=0;attempt<60;attempt++)); do
    if curl --fail --silent --max-time 1 "http://127.0.0.1:$port/api/health" > /dev/null; then ready=1; break; fi
    kill -0 "$wrangler_pid" || { cat "$output/$mode-wrangler.log" >&2; exit 1; }
    sleep 1
  done
  [[ "$ready" = 1 ]] || { echo 'Worker failed to become ready' >&2; exit 1; }
  printf '%s\n' "node drive-proof.mjs <loopback origin> $mode <result path>" >> "$output/commands.log"
  node "$runtime/drive-proof.mjs" "http://127.0.0.1:$port" "$mode" "$output/$mode-results.json" > "$output/$mode-driver.log" 2>&1
  kill -- "-$wrangler_pid"
  wait "$wrangler_pid" || true
  wrangler_pid=
done
printf '%s\n' 'Prepared scope executed: baseline/candidate workerd SQLite scenarios and workflow annotation block. No hosted workflow or deployed-edge claim.' > "$output/result.txt"
