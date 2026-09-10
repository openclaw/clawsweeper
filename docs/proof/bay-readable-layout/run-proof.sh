#!/usr/bin/env bash
set -euo pipefail
# Run inside the admitted Crabbox lease. No live workflow, producer or deploy.
: "${BAY_PROOF_PROVIDER:?record actual provider}"
: "${BAY_PROOF_LEASE:?record actual lease}"
: "${BAY_PROOF_IMAGE:?record actual image}"
: "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:?record sandbox-capable browser path}"
export BAY_PROOF_BASE="${BAY_PROOF_BASE:-97c9a7b45caf20f6d580fe0ae5cc48db31da15f4}"
: "${BAY_PROOF_CANDIDATE:?record candidate commit and dirty patch digest explicitly}"
export BAY_PROOF_CANDIDATE
export BAY_PROOF_OUTPUT="${BAY_PROOF_OUTPUT:-.artifacts/bay-readable-layout}"
export BAY_PROOF_ORIGIN=http://127.0.0.1:8794
export BAY_PROOF_BASE_ORIGIN=http://127.0.0.1:8795
export WRANGLER_SEND_METRICS=false
root=$PWD
# Crabbox copies working files, not the caller index. Refuse incomplete provenance.
git ls-files --error-unmatch -- dashboard/bay-layout.ts test/bay-readable-layout.test.ts docs/proof/bay-readable-layout/{README.md,fixture-worker.mjs,fixtures.mjs,run-proof.mjs,run-proof.sh,settled-master.mjs,wrangler.toml} >/dev/null
# Give each attempt a fresh scratch/output pair; retain earlier proof evidence.
scratch="${BAY_PROOF_SCRATCH:-$root/.openclaw/tmp/bay-readable-runtime}"
if [ -e "$scratch" ] || [ -e "$BAY_PROOF_OUTPUT" ]; then
  echo "Refusing to overwrite an existing proof run." >&2
  exit 1
fi
mkdir -p "$scratch/base" "$BAY_PROOF_OUTPUT"
node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
git rev-parse HEAD > "$BAY_PROOF_OUTPUT/source-head.txt"
git diff --binary HEAD --full-index -- . ":(exclude).crabbox/**" ":(exclude).openclaw/**" ":(exclude).artifacts/**" ":(exclude)artifacts/**" > "$BAY_PROOF_OUTPUT/candidate.patch"
actual_candidate="$(cat "$BAY_PROOF_OUTPUT/source-head.txt")+patch-sha256:$(sha256sum "$BAY_PROOF_OUTPUT/candidate.patch" | cut -d' ' -f1)"
if [ "$BAY_PROOF_CANDIDATE" != "$actual_candidate" ]; then
  echo "Candidate provenance does not match the current HEAD and full-index source patch." >&2
  exit 1
fi
node --input-type=module -e 'import fs from "node:fs";import {createHash} from "node:crypto";import {execFileSync} from "node:child_process";const paths=execFileSync("git",["ls-files","--cached","-z"],{encoding:"utf8"}).split("\0").filter(Boolean);const rows=paths.filter(p=>![".crabbox/",".openclaw/",".artifacts/","artifacts/"].some(prefix=>p.startsWith(prefix))&&fs.existsSync(p)&&fs.lstatSync(p).isFile()).map(p=>({path:p,sha256:createHash("sha256").update(fs.readFileSync(p)).digest("hex")}));fs.writeFileSync(process.env.BAY_PROOF_OUTPUT+"/source-manifest.json",JSON.stringify(rows,null,2));'
git archive "$BAY_PROOF_BASE" | tar -x -C "$scratch/base"
# Baseline receives only the harness; its production source remains exact.
mkdir -p "$scratch/base/docs/proof/bay-readable-layout"
cp docs/proof/bay-readable-layout/{fixture-worker.mjs,fixtures.mjs,wrangler.toml} "$scratch/base/docs/proof/bay-readable-layout/"
pnpm install --frozen-lockfile
(cd "$scratch/base" && pnpm install --frozen-lockfile)
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT
pnpm dlx wrangler@4.107.0 dev --config docs/proof/bay-readable-layout/wrangler.toml --local --ip 127.0.0.1 --port 8794 --inspector-ip 127.0.0.1 --inspector-port 8796 --persist-to "$scratch/after-state" > "$BAY_PROOF_OUTPUT/after-worker.log" 2>&1 &
pids+=("$!")
(cd "$scratch/base" && exec pnpm dlx wrangler@4.107.0 dev --config docs/proof/bay-readable-layout/wrangler.toml --local --ip 127.0.0.1 --port 8795 --inspector-ip 127.0.0.1 --inspector-port 8797 --persist-to "$scratch/before-state") > "$BAY_PROOF_OUTPUT/before-worker.log" 2>&1 &
pids+=("$!")
for port in 8794 8795; do
  ready=false
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null; then ready=true; break; fi
    sleep 1
  done
  if [ "$ready" != true ]; then echo "Local Worker failed readiness on $port" >&2; exit 1; fi
done
node docs/proof/bay-readable-layout/run-proof.mjs
node --input-type=module -e 'import fs from "node:fs";const s=JSON.parse(fs.readFileSync(process.env.BAY_PROOF_OUTPUT+"/summary.json"));if(s.status!=="PASS")process.exit(1);'
