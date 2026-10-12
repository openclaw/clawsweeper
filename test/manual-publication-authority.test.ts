import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const authorityModule = pathToFileURL(path.resolve("dist/manual-publication-authority.js")).href;
const decision = {
  targetRepo: "openclaw/openclaw",
  targetBranch: "main",
  itemNumber: 7,
  itemKind: "issue",
  sourceAction: "manual_explicit_review",
  publicationPolicy: "record_comment_only",
};
const report =
  "---\nnumber: 7\nrepository: openclaw/openclaw\ntype: issue\nreviewed_at: 2026-09-07T00:00:00Z\npublication_policy: record_comment_only\ndecision: keep_open\n---\nReport\n";

function fixture(httpStatus: number, exitCode: number, after = 0, response?: string) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "manual-authority-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/usr/bin/env node
const fs = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  const count = fs.existsSync(process.env.CURL_CALLS) ? fs.readFileSync(process.env.CURL_CALLS, "utf8").length : 0;
  fs.appendFileSync(process.env.CURL_CALLS, "x");
  const fail = count >= Number(process.env.CURL_FAILURE_AFTER);
  const status = fail ? Number(process.env.CURL_HTTP_STATUS) : 200;
  const code = fail ? Number(process.env.CURL_EXIT_CODE) : 0;
  const body = fail ? process.env.CURL_RESPONSE : process.env.CURL_SUCCESS;
  if (!(process.argv.includes("--fail") && status >= 400)) process.stdout.write(body);
  if (process.argv.includes("--write-out")) process.stdout.write(String(status).padStart(3, "0"));
  if (code) process.stderr.write("PRIVATE_TRANSPORT_SENTINEL");
  process.exitCode = code;
});
`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    EXACT_REVIEW_QUEUE_URL: "https://authority.invalid",
    CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-authority-secret",
    EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#7",
    EXACT_REVIEW_LEASE_ID: "fixture-lease",
    EXACT_REVIEW_LEASE_REVISION: "1",
    EXACT_REVIEW_CLAIM_GENERATION: "1",
    GITHUB_RUN_ID: "107",
    GITHUB_RUN_ATTEMPT: "1",
    CURL_HTTP_STATUS: String(httpStatus),
    CURL_EXIT_CODE: String(exitCode),
    CURL_FAILURE_AFTER: String(after),
    CURL_CALLS: path.join(root, "curl-calls"),
    CURL_SUCCESS: JSON.stringify({ ok: true, decision }),
    CURL_RESPONSE: response ?? JSON.stringify({ ok: true, decision }),
    AUTHORITY_MODULE: authorityModule,
    AUTHORITY_REPORT: report,
  };
  return { root, env };
}

for (const scenario of [
  { name: "HTTP 503", http: 503, exit: 22, reason: "HTTP_503" },
  { name: "HTTP 429", http: 429, exit: 22, reason: "HTTP_429" },
  { name: "HTTP 500", http: 500, exit: 22, reason: "HTTP_500" },
  { name: "curl timeout", http: 0, exit: 28, reason: "timeout" },
  { name: "connection failure", http: 0, exit: 7, reason: "network_error" },
  { name: "HTTP/2 connection failure", http: 0, exit: 16, reason: "network_error" },
  { name: "expired owner", http: 409, exit: 22 },
  { name: "unauthorized caller", http: 401, exit: 22 },
  { name: "forbidden caller", http: 403, exit: 22 },
  { name: "redirect response", http: 302, exit: 0 },
  { name: "local curl failure", http: 503, exit: 23 },
  { name: "invalid JSON", http: 200, exit: 0, response: "PRIVATE_RESPONSE_SENTINEL" },
  {
    name: "wrong owner decision",
    http: 200,
    exit: 0,
    response: JSON.stringify({ ok: true, decision: { ...decision, itemNumber: 8 } }),
  },
  { name: "current owner", http: 200, exit: 0, success: true },
]) {
  test(
    `manual authority classifies ${scenario.name} without transport details`,
    { skip: process.platform === "win32" },
    () => {
      const { root, env } = fixture(scenario.http, scenario.exit, 0, scenario.response);
      try {
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
const { assertManualPublicationAuthority } = await import(process.env.AUTHORITY_MODULE);
try {
  assertManualPublicationAuthority(process.env.AUTHORITY_REPORT, "openclaw/openclaw", 7);
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error.name, reason: error.reason, message: error.message }));
  process.exitCode = 1;
}
`,
          ],
          { env, encoding: "utf8", timeout: 15_000 },
        );
        assert.equal(result.status, scenario.success ? 0 : 1, result.stderr);
        const outcome = JSON.parse(result.stdout);
        assert.equal(outcome.ok, Boolean(scenario.success));
        if (scenario.reason) {
          assert.equal(outcome.name, "ManualPublicationAuthorityTransportError");
          assert.equal(outcome.reason, scenario.reason);
        } else if (!scenario.success) {
          assert.notEqual(outcome.name, "ManualPublicationAuthorityTransportError");
        }
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /PRIVATE_(?:TRANSPORT|RESPONSE)_SENTINEL/,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

for (const after of [0, 1]) {
  for (const scenario of [
    { name: "HTTP 503", http: 503, exit: 22, retryable: true },
    { name: "timeout", http: 0, exit: 28, retryable: true },
    { name: "HTTP/2 connection failure", http: 0, exit: 16, retryable: true },
    { name: "expired ownership", http: 409, exit: 22, retryable: false },
  ]) {
    test(
      `publication preserves ${scenario.name} from ${after ? "apply child" : "initial authority"}`,
      { skip: process.platform === "win32" },
      () => {
        const { root, env } = fixture(scenario.http, scenario.exit, after);
        try {
          const work = path.join(root, "work");
          const code = path.join(root, "code");
          const artifacts = path.join(work, "artifacts/event");
          fs.mkdirSync(artifacts, { recursive: true });
          fs.mkdirSync(path.join(code, "dist"), { recursive: true });
          fs.writeFileSync(path.join(artifacts, "7.md"), report);
          fs.writeFileSync(
            path.join(code, "dist/clawsweeper.js"),
            `
const fs = require("node:fs");
const path = require("node:path");
const [command, ...args] = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (command === "apply-artifacts") {
  fs.mkdirSync(value("--items-dir"), { recursive: true });
  fs.copyFileSync(path.join(value("--artifact-dir"), "7.md"), path.join(value("--items-dir"), "7.md"));
} else {
  import(process.env.AUTHORITY_MODULE).then(({ assertManualPublicationAuthority }) => {
    assertManualPublicationAuthority(process.env.AUTHORITY_REPORT, "openclaw/openclaw", 7);
    fs.writeFileSync(process.env.EFFECT_MARKER, "unexpected effect");
  }).catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
`,
          );
          const output = path.join(root, "github-output");
          const result = spawnSync(
            process.execPath,
            [path.resolve("dist/repair/publish-event-result.js")],
            {
              cwd: root,
              env: {
                ...env,
                TARGET_REPO: "openclaw/openclaw",
                ITEM_NUMBER: "7",
                EXACT_REVIEW_WORK_ROOT: work,
                CLAWSWEEPER_CODE_ROOT: code,
                EXACT_REVIEW_DECISION: JSON.stringify(decision),
                EXACT_REVIEW_BATCH_MUTATION_OUTPUT: ".artifacts/outcome.json",
                GITHUB_OUTPUT: output,
                EFFECT_MARKER: path.join(root, "effect"),
              },
              encoding: "utf8",
              timeout: 15_000,
            },
          );
          assert.equal(result.status, 1, result.stdout + result.stderr);
          const outcome = JSON.parse(
            fs.readFileSync(path.join(work, ".artifacts/outcome.json"), "utf8"),
          );
          assert.equal(
            outcome.kind,
            scenario.retryable ? "retryable_failure" : "permanent_failure",
          );
          assert.equal(
            outcome.reasonCode,
            scenario.retryable ? "state_contention" : "unknown_failure",
          );
          assert.equal(fs.existsSync(path.join(root, "effect")), false);
          assert.equal(fs.readFileSync(env.CURL_CALLS, "utf8").length, after + 1);
          assert.equal(Object.hasOwn(outcome, "rateLimitScope"), false);
          assert.equal(Object.hasOwn(outcome, "retryAt"), false);
          const directOutput = fs.readFileSync(output, "utf8");
          assert.match(directOutput, new RegExp(`^completion_kind=${outcome.kind}$`, "m"));
          assert.match(directOutput, new RegExp(`^reason_code=${outcome.reasonCode}$`, "m"));
          assert.doesNotMatch(
            result.stdout + result.stderr + JSON.stringify(outcome),
            /PRIVATE_(?:TRANSPORT|RESPONSE)_SENTINEL/,
          );
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
}

test("coordinator transport errors do not enter GitHub inline retry handling", async () => {
  const { ManualPublicationAuthorityTransportError } = await import(authorityModule);
  const { ExactReviewBatchQueueTransportError } =
    await import("../dist/repair/exact-review-queue-transport-error.js");
  const { ghRetryKind } = await import("../dist/github-retry.js");
  for (const reason of ["timeout", "network_error", "HTTP_503"] as const) {
    assert.equal(ghRetryKind(new ManualPublicationAuthorityTransportError(reason)), "none");
    assert.equal(
      ghRetryKind(new ExactReviewBatchQueueTransportError(reason, `Queue ${reason}`)),
      "none",
    );
  }
  assert.equal(ghRetryKind(new Error("GitHub HTTP 503")), "transient");
  assert.equal(ghRetryKind(new Error("GitHub HTTP 429")), "throttle");
});

test("authority stderr reconstruction accepts only its retryable coordinator marker", async () => {
  const { manualPublicationAuthorityTransportErrorFromStderr: parse } = await import(
    authorityModule
  );
  assert.equal(
    parse(
      "ManualPublicationAuthorityTransportError: manual publication authority unavailable (HTTP_503)\n    at fixture",
    ).reason,
    "HTTP_503",
  );
  assert.equal(
    parse(
      "ManualPublicationAuthorityTransportError: manual publication authority unavailable (timeout)",
    ).reason,
    "timeout",
  );
  assert.equal(
    parse(
      "ManualPublicationAuthorityTransportError: manual publication authority unavailable (HTTP_409)",
    ),
    null,
  );
  assert.equal(parse("Error: HTTP 503 from GitHub"), null);
  assert.equal(parse("manual publication fence is unavailable or expired"), null);
});
