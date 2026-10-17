#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(
  process.argv.length,
  5,
  "usage: review-publication-bytes.mjs <baseline-dist> <candidate-dist> <output-dir>",
);
const [baseline, candidate, output] = process.argv.slice(2).map((value) => resolve(value));
mkdirSync(output, { recursive: true });
assert.equal(readdirSync(output).length, 0, "proof output must be empty");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const number = 123;
const gh = process.env.PROOF_GH_BIN || "gh";
const ghVersion = execFileSync(gh, ["--version"], { encoding: "utf8" }).split("\n")[0];
const results = [];
for (const mode of [
  "plain",
  "configured-host",
  "api-host",
  "redirect",
  "literal",
  "control",
  "empty",
  "wrong-body",
  "wrong-author",
  "wrong-id",
  "post-literal",
  "post-empty",
]) {
  for (const [variant, dist] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ]) {
    const root = join(output, mode + "-" + variant);
    mkdirSync(root);
    const body =
      mode.includes("literal") ||
      mode === "empty" ||
      mode === "post-empty" ||
      mode === "redirect" ||
      mode === "configured-host" ||
      mode === "api-host"
        ? String.raw`Codex review: preserve the examples \u001b and \u0007.`
        : mode === "control"
          ? "Codex review: control \u001b and bell \u0007."
          : "Codex review: ordinary content.";
    const expectedBody = body + `\n\n<!-- clawsweeper-review item=${number} -->`;
    const existing = { id: 20, user: { login: "clawsweeper[bot]" }, body: "previous" };
    let stored = existing;
    const requests = [];
    const handle = (req, res) => {
      let input = "";
      req.on("data", (chunk) => (input += chunk));
      req.on("end", () => {
        const url = new URL(req.url, "http://fixture.invalid");
        requests.push({ method: req.method, path: url.pathname, requestSha256: hash(input) });
        if (url.pathname.startsWith("/api/v3/")) url.pathname = url.pathname.slice(7);
        res.setHeader("Content-Type", "application/json");
        if (req.method === "PATCH" || req.method === "POST") {
          assert.match(
            url.pathname,
            /^\/repos\/openclaw\/openclaw\/issues\/(?:comments\/20|123\/comments)$/,
          );
          stored = { ...existing, body: JSON.parse(input).body };
          assert.equal(stored.body, expectedBody);
          if (mode === "wrong-body") stored.body += "\n";
          if (mode === "wrong-author") stored.user = { login: "contributor" };
          if (mode === "wrong-id") stored.id = 21;
          return res.end(mode.includes("empty") ? "" : JSON.stringify(stored));
        }
        if (req.method !== "GET") throw new Error("unexpected mutation");
        if (mode === "redirect" && url.pathname === "/repos/openclaw/openclaw/issues/comments/20") {
          res.statusCode = 301;
          res.setHeader("Location", "/repositories/1/issues/comments/20");
          return res.end("{}");
        }
        if (url.pathname.endsWith("/issues/comments/20")) {
          if (stored.id !== 20) {
            res.statusCode = 404;
            return res.end('{"message":"Not Found"}');
          }
          return res.end(JSON.stringify(stored));
        }
        assert.equal(url.pathname, "/repos/openclaw/openclaw/issues/123/comments");
        if (mode === "post-empty" && url.searchParams.get("page") !== "2") {
          res.setHeader(
            "Link",
            "<https://api.github.com" + url.pathname + '?per_page=100&page=2>; rel="next"',
          );
          return res.end(
            JSON.stringify(
              Array.from({ length: 100 }, (_, index) => ({
                id: 1000 + index,
                user: { login: "contributor" },
                body: "unrelated",
              })),
            ),
          );
        }
        return res.end(JSON.stringify([stored]));
      });
    };
    const socketServer = createServer(handle);
    const socket = join(root, "gh.sock");
    await new Promise((done) => socketServer.listen(socket, done));
    writeFileSync(join(root, "config.yml"), "http_unix_socket: " + socket + "\n");
    if (mode === "configured-host")
      writeFileSync(join(root, "hosts.yml"), "enterprise.example: {}\n");
    if (mode === "api-host")
      writeFileSync(join(root, "hosts.yml"), "github.com:\n  api_host: proxy.example\n");
    const childCode = `
import { createHash } from "node:crypto";
import { upsertReviewComment } from ${JSON.stringify(pathToFileURL(join(dist, "clawsweeper-review-comment-publication.js")).href)};
import { withGitHubRun } from ${JSON.stringify(pathToFileURL(join(dist, "clawsweeper-github-runtime.js")).href)};
import { withTargetProfile, repositoryProfileFor } from ${JSON.stringify(pathToFileURL(join(dist, "repository-profiles.js")).href)};
try {
  const result = withTargetProfile(repositoryProfileFor("openclaw/openclaw"), () => withGitHubRun(() => upsertReviewComment(${number}, ${JSON.stringify(body)}, ${JSON.stringify(mode.startsWith("post-") ? {} : existing)})));
  console.log(JSON.stringify({ ok: true, id: result.id, bodySha256: createHash("sha256").update(result.body).digest("hex") }));
} catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); }
`;
    try {
      const result = await new Promise((done, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
          env: {
            ...process.env,
            GH_TOKEN: "fixture-only",
            GITHUB_TOKEN: "fixture-only",
            GH_HOST: mode === "configured-host" ? "" : "github.com",
            GH_ENTERPRISE_TOKEN: "fixture-only",
            GH_CONFIG_DIR: root,
            GH_BIN: gh,
            GH_BIN_ARGS: "[]",
            CURL_BIN: "curl",
            CURL_BIN_ARGS: "[]",
            EXACT_EVENT_PUBLICATION: "false",
            EXACT_REVIEW_QUEUE_URL: "",
            CLAWSWEEPER_PUBLIC_GH_TOKEN: "",
            CLAWSWEEPER_GH_RETRY_ATTEMPTS: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? done(JSON.parse(stdout.trim())) : reject(new Error(stderr)),
        );
      });
      const shouldPass =
        !mode.startsWith("wrong-") && (variant === "candidate" || mode === "plain");
      assert.equal(result.ok, shouldPass, mode + " " + variant + ": " + JSON.stringify(result));
      assert.equal(requests.filter(({ method }) => method !== "GET").length, 1);
      if (result.ok) assert.equal(result.bodySha256, hash(expectedBody));
      results.push({
        mode,
        variant,
        ...result,
        expectedBodySha256: hash(expectedBody),
        storedBodySha256: hash(stored.body),
        requests,
      });
    } finally {
      await new Promise((done) => socketServer.close(done));
    }
  }
}
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .sort();
const summary = {
  ghVersion,
  sourceSha256: hash(JSON.stringify(files.map((file) => [file, hash(readFileSync(file))]))),
  provider: process.env.PROOF_PROVIDER,
  lease: process.env.PROOF_LEASE,
  results,
};
writeFileSync(join(output, "proof.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  JSON.stringify({
    ghVersion,
    sourceSha256: summary.sourceSha256,
    scenarios: results.length,
    passed: true,
  }),
);
