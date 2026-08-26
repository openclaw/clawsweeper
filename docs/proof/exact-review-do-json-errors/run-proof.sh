#!/usr/bin/env bash
set -euo pipefail

export CI=1
export WRANGLER_SEND_METRICS=false

root_dir=$PWD
output_dir="${EXACT_REVIEW_DO_PROOF_OUTPUT:-.artifacts/exact-review-do-json-errors}"
port="${EXACT_REVIEW_DO_PROOF_PORT:-8794}"
runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/clawsweeper-do-json-errors.XXXXXX")
vars_file="$runtime_dir/.dev.vars"
wrangler_log="$runtime_dir/wrangler.log"
proof_entry="dashboard/proof-entry-do-error.ts"
proof_config="dashboard/wrangler.proof.toml"

if [ -e "$proof_entry" ] || [ -e "$proof_config" ]; then
  echo "Refusing to overwrite existing proof injection files" >&2
  exit 1
fi

cleanup() {
  if [ -n "${wrangler_pid:-}" ]; then
    kill "$wrangler_pid" >/dev/null 2>&1 || true
    wait "$wrangler_pid" >/dev/null 2>&1 || true
  fi
  rm -f "$proof_entry" "$proof_config"
  rm -rf "$runtime_dir"
}
trap cleanup EXIT

if [ -e "$output_dir" ]; then
  echo "Refusing to overwrite existing proof output: $output_dir" >&2
  exit 1
fi
mkdir -p "$output_dir"

if grep -q 'sanitizedServerError(responseBody)' dashboard/worker.ts; then
  proof_mode=after
else
  proof_mode=before
fi
head_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)

secret=$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"));')
umask 077
printf '%s\n' \
  "CLAWSWEEPER_WEBHOOK_SECRET=$secret" \
  "INGEST_TOKEN=$secret" \
  "GITHUB_API_URL=http://127.0.0.1:9" \
  "CACHE_TTL_SECONDS=0" \
  "STALE_CACHE_TTL_SECONDS=0" \
  "INCLUDE_CI_STATUS=0" \
  "EXACT_REVIEW_DISPATCH_DEBOUNCE_MS=900000" \
  "EXACT_REVIEW_DISPATCH_DEBOUNCE_MAX_MS=900000" \
  >"$vars_file"

cat >"$proof_entry" <<'PROOF_ENTRY'
import baseWorker, {
  StatusStore as WorkerStatusStore,
  ExactReviewQueue as BaseExactReviewQueue,
} from "./worker.ts";

const PROOF_FAILURE_MESSAGE =
  "injected sqlite read failure exposing GH_TOKEN=ghp_examplesecrettoken0123456789abcd";

function bindingProxy(target: any, overrides: Record<PropertyKey, unknown>) {
  return new Proxy(target, {
    get(source, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = source[property];
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

export class ExactReviewQueue extends BaseExactReviewQueue {
  constructor(state: any, env: any) {
    let armedPattern: RegExp | null = null;
    const realStorage = state.storage;
    const sqlProxy = bindingProxy(realStorage.sql, {
      exec: (query: string, ...args: unknown[]) => {
        if (armedPattern && armedPattern.test(String(query))) {
          armedPattern = null;
          throw new Error(PROOF_FAILURE_MESSAGE);
        }
        return realStorage.sql.exec(query, ...args);
      },
    });
    const storageProxy = bindingProxy(realStorage, { sql: sqlProxy });
    const stateProxy = bindingProxy(state, { storage: storageProxy });
    super(stateProxy, env);
    Object.defineProperty(this, "armProofSqlFailure", {
      value: (pattern: RegExp) => {
        armedPattern = pattern;
      },
    });
  }

  async fetch(request: Request) {
    if (request.method !== "POST") return super.fetch(request);
    const bodyText = await request.text();
    let marker: unknown = null;
    try {
      marker = (JSON.parse(bodyText) as { proof_fail_sql?: unknown }).proof_fail_sql;
    } catch {
      marker = null;
    }
    if (typeof marker === "string" && marker) {
      (this as { armProofSqlFailure?: (pattern: RegExp) => void }).armProofSqlFailure?.(
        new RegExp(marker),
      );
    }
    return super.fetch(
      new Request(request.url, { method: "POST", headers: request.headers, body: bodyText }),
    );
  }
}

export { WorkerStatusStore as StatusStore };
export default baseWorker;
PROOF_ENTRY

sed 's|^main = "worker.ts"$|main = "proof-entry-do-error.ts"|' dashboard/wrangler.toml >"$proof_config"
grep -q 'proof-entry-do-error.ts' "$proof_config"

driver="$runtime_dir/drive-proof.mjs"
cat >"$driver" <<'PROOF_DRIVER'
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.EXACT_REVIEW_DO_PROOF_ORIGIN || "").replace(/\/+$/, "");
const secret = String(process.env.EXACT_REVIEW_DO_PROOF_SECRET || "");
const outputDir = path.resolve(
  process.env.EXACT_REVIEW_DO_PROOF_OUTPUT || ".artifacts/exact-review-do-json-errors",
);
const mode = process.env.EXACT_REVIEW_DO_PROOF_MODE === "before" ? "before" : "after";
const headSha = String(process.env.EXACT_REVIEW_DO_PROOF_HEAD || "unknown");
if (!origin || !secret) throw new Error("proof origin and secret are required");

const plantedToken = "ghp_examplesecrettoken0123456789abcd";
const routePath = "/internal/exact-review/publications/list";
const assertions = [];
const transcript = [];

function assertProof(name, condition, details = {}) {
  if (!condition) throw new Error(`Proof assertion failed: ${name} ${JSON.stringify(details)}`);
  assertions.push({ name, status: "PASS", ...details });
}

function redact(value) {
  return String(value).split(plantedToken).join("ghp_[PLANTED_TOKEN_REDACTED]");
}

async function signedPost(label, value) {
  const body = JSON.stringify(value);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`${origin}${routePath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawsweeper-exact-review-signature": signature,
    },
    body,
  });
  const text = await response.text();
  transcript.push({
    label,
    request_body: body,
    status: response.status,
    content_type: response.headers.get("content-type") || "",
    response_body: redact(text),
  });
  return { status: response.status, contentType: response.headers.get("content-type") || "", text };
}

await mkdir(outputDir, { recursive: true });

const baseline = await signedPost("baseline-list", { limit: 100 });
assertProof("baseline_list_ok", baseline.status === 200, { http_status: baseline.status });

const failing = await signedPost("injected-storage-failure", {
  limit: 100,
  proof_fail_sql: "SELECT item_key, item_json",
});

const recovery = await signedPost("recovery-list", { limit: 100 });
assertProof("recovery_list_ok", recovery.status === 200, { http_status: recovery.status });

let parsedFailing = null;
try {
  parsedFailing = JSON.parse(failing.text);
} catch {
  parsedFailing = null;
}
const jsonContract =
  failing.contentType.includes("application/json") &&
  parsedFailing !== null &&
  typeof parsedFailing.error === "string";
const tokenLeaked = failing.text.includes(plantedToken);

assertProof("failure_status_500", failing.status === 500, { http_status: failing.status });
if (mode === "before") {
  assertProof("broken_failure_contract_on_base", !jsonContract || tokenLeaked, {
    json_contract: jsonContract,
    token_leaked: tokenLeaked,
  });
} else {
  assertProof("worker_sanitized_json_contract", jsonContract, {
    content_type: failing.contentType,
  });
  assertProof("planted_token_redacted", !tokenLeaked && failing.text.includes("[REDACTED"), {
    response_body: redact(failing.text).slice(0, 300),
  });
}

const summary = {
  mode,
  head_sha: headSha,
  route: routePath,
  planted_token: "ghp_[PLANTED_TOKEN_REDACTED]",
  failure_response: {
    status: failing.status,
    content_type: failing.contentType,
    body: redact(failing.text).slice(0, 2000),
    json_contract: jsonContract,
    token_leaked: tokenLeaked,
  },
  assertions,
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  path.join(outputDir, "transcript.md"),
  [
    "# exact-review Worker JSON error proof",
    `mode: ${mode}`,
    `head: ${headSha}`,
    "",
    ...transcript.map((entry) =>
      [
        `## ${entry.label}`,
        "```",
        `POST ${routePath}`,
        entry.request_body,
        `-> ${entry.status} ${entry.content_type}`,
        entry.response_body,
        "```",
        "",
      ].join("\n"),
    ),
  ].join("\n"),
);
console.log(JSON.stringify({ mode, head: headSha, assertions }, null, 2));
PROOF_DRIVER

if [ "${EXACT_REVIEW_DO_PROOF_SKIP_INSTALL:-0}" != "1" ]; then
  corepack pnpm install --frozen-lockfile
fi
npx --yes wrangler@4.107.0 dev --config "$proof_config" --local --ip 127.0.0.1 --port "$port" --env-file "$vars_file" --persist-to "$runtime_dir/state" >"$wrangler_log" 2>&1 &
wrangler_pid=$!

for _ in $(seq 1 120); do
  if curl --fail --silent "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$wrangler_pid" >/dev/null 2>&1; then
    tail -n 100 "$wrangler_log" >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error "http://127.0.0.1:${port}/api/health" >/dev/null
EXACT_REVIEW_DO_PROOF_ORIGIN="http://127.0.0.1:${port}" \
  EXACT_REVIEW_DO_PROOF_SECRET="$secret" \
  EXACT_REVIEW_DO_PROOF_OUTPUT="$output_dir" \
  EXACT_REVIEW_DO_PROOF_MODE="$proof_mode" \
  EXACT_REVIEW_DO_PROOF_HEAD="$head_sha" \
  node "$driver"

test -s "$output_dir/proof-summary.json"
