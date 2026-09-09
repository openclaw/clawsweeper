import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || ".artifacts/oversized-effects-proof");
mkdirSync(root, { recursive: true });
const adapter = join(root, "github-http-adapter.mjs");
writeFileSync(
  adapter,
  `import { readFileSync } from 'node:fs';
let args = process.argv.slice(2);
if (args[0] === '--repo') args = args.slice(2);
let method = 'GET', path, body;
if (args[0] === 'api') {
  path = '/' + args[1];
  const mi = args.indexOf('--method'); if (mi >= 0) method = args[mi + 1];
  const bi = args.indexOf('--input'); if (bi >= 0) body = readFileSync(args[bi + 1], 'utf8');
} else if (args[0] === 'pr' && args[1] === 'close') {
  method = 'PATCH'; path = '/repos/openclaw/openclaw/pulls/' + args[2]; body = JSON.stringify({state:'closed'});
} else throw new Error('Unexpected command at isolated GitHub transport');
if (!path.startsWith('/repos/openclaw/openclaw/')) throw new Error('Unexpected repository');
const base = new URL(process.env.PROOF_HTTP_URL);
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Loopback transport required');
const response = await fetch(new URL(path, base), {method, body, headers:{'content-type':'application/json'}});
const text = await response.text();
if (!response.ok) { console.error(text); process.exit(1); }
process.stdout.write(args.includes("--slurp") ? JSON.stringify([JSON.parse(text)]) : text);
`,
);
const initial = {
  number: 141913,
  title: "Synthetic final-effect proof",
  body: "Synthetic PR body",
  html_url: "https://github.com/openclaw/openclaw/pull/141913",
  state: "open",
  locked: false,
  draft: true,
  author_association: "OWNER",
  user: { login: "synthetic-owner" },
  additions: 45791,
  deletions: 120895,
  changed_files: 2747,
  comments: 0,
  review_comments: 0,
  labels: [],
  assignees: [],
  milestone: null,
  requested_reviewers: [],
  requested_teams: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-09-08T00:00:00Z",
  head: { sha: "b".repeat(40), repo: { full_name: "synthetic-owner/openclaw" } },
  base: { ref: "main", sha: "a".repeat(40) },
};
const summaries = [];
for (const scenario of [
  "eligible",
  "protected",
  "ambiguous-initial-comment",
  "stable-old-comment",
  "late-exemption",
  "late-body",
  "late-human-comment",
  "late-review-edit-retry",
]) {
  const quietObservation =
    scenario === "stable-old-comment" || scenario === "late-review-edit-retry";
  const directory = join(root, scenario);
  mkdirSync(directory, { recursive: true });
  const pull = structuredClone(initial);
  if (scenario === "protected") pull.labels = ["security"];
  const comments = [],
    timeline = [],
    requests = [];
  const reviews = [];
  if (scenario === "late-review-edit-retry") {
    const review = {
      id: 700,
      body: "Original submitted review",
      submitted_at: "2026-01-01T00:00:00Z",
      state: "COMMENTED",
      user: { login: "synthetic-human" },
    };
    reviews.push(review);
    timeline.push({ ...review, event: "reviewed" });
  }
  if (scenario === "ambiguous-initial-comment" || scenario === "stable-old-comment") {
    const human = {
      id: 1001,
      body: "Human comment edited in the observation second",
      user: { login: "synthetic-human", type: "User" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: initial.updated_at,
    };
    comments.push(human);
    timeline.push({ ...human, event: "commented" });
    pull.comments = 1;
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const input = text ? JSON.parse(text) : {};
      requests.push({ method: request.method, path: url.pathname });
      const send = (value, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const path = url.pathname;
      if (request.method === "GET") {
        if (path.endsWith("/pulls/141913")) return send(pull);
        if (path.endsWith("/issues/141913"))
          return send({
            ...pull,
            pull_request: { url: "https://api.github.com/repos/openclaw/openclaw/pulls/141913" },
          });
        const page = Number(url.searchParams.get("page") || 1),
          start = (page - 1) * 100;
        if (path.endsWith("/issues/141913/comments"))
          return send(comments.slice(start, start + 100));
        if (path.endsWith("/timeline")) return send(timeline.slice(start, start + 100));
        if (path.endsWith("/reviews")) return send(reviews.slice(start, start + 100));
        if (path.endsWith("/pulls/141913/comments")) return send([]);
        return send({ error: "unimplemented read" }, 404);
      }
      if (request.method === "POST" && path.endsWith("/issues/141913/comments")) {
        const comment = {
          id: 1000,
          body: input.body,
          user: { login: "clawsweeper[bot]", type: "Bot" },
          html_url: pull.html_url + "#issuecomment-1000",
          created_at: quietObservation ? "2026-09-08T00:00:04Z" : "2026-09-08T00:00:01Z",
          updated_at: quietObservation ? "2026-09-08T00:00:04Z" : "2026-09-08T00:00:01Z",
        };
        comments.push(comment);
        timeline.push({ ...comment, event: "commented" });
        pull.comments++;
        pull.updated_at = comment.updated_at;
        if (scenario === "late-review-edit-retry") {
          reviews[0].body = "Review edited after proposal publication";
          timeline.find((event) => event.id === 700).body = reviews[0].body;
        }
        if (scenario === "late-exemption") pull.labels.push("size: accepted-large");
        if (scenario === "late-body")
          pull.body = "Human edited the body after proposal publication";
        if (scenario === "late-human-comment") {
          const human = {
            ...comment,
            id: 1001,
            body: "Same-second human follow-up",
            user: { login: "synthetic-human", type: "User" },
          };
          comments.push(human);
          timeline.push({ ...human, event: "commented" });
          pull.comments++;
        }
        return send(comment, 201);
      }
      if (request.method === "PATCH" && path.endsWith("/issues/comments/1000")) {
        const owned = comments.find((comment) => comment.id === 1000);
        owned.body = input.body;
        owned.updated_at = quietObservation ? "2026-09-08T00:00:06Z" : "2026-09-08T00:00:03Z";
        Object.assign(
          timeline.find((event) => event.id === 1000),
          owned,
        );
        pull.updated_at = owned.updated_at;
        return send(owned);
      }
      if (
        request.method === "PATCH" &&
        path.endsWith("/pulls/141913") &&
        input.state === "closed"
      ) {
        pull.state = "closed";
        pull.updated_at = quietObservation ? "2026-09-08T00:00:05Z" : "2026-09-08T00:00:02Z";
        return send(pull);
      }
      return send({ error: "unexpected mutation" }, 400);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([adapter]),
    GH_TOKEN: "synthetic-loopback-token",
    GITHUB_TOKEN: "",
    PROOF_HTTP_URL: `http://127.0.0.1:${server.address().port}`,
    CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED: "true",
    CLAWSWEEPER_MAX_PR_CHANGED_LINES: "50000",
  };
  const run = async (name, args) => {
    const child = spawn(process.execPath, ["dist/clawsweeper.js", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    writeFileSync(
      join(directory, name + ".log"),
      output
        .replaceAll(root, "<proof>")
        .replaceAll(process.cwd(), "<checkout>")
        .replaceAll(process.execPath, "<node>"),
    );
    assert.equal(code, 0, output);
  };
  try {
    const admission = join(directory, "admission.json"),
      items = join(directory, "items"),
      closed = join(directory, "closed");
    writeFileSync(
      admission,
      JSON.stringify(
        {
          repo: "openclaw/openclaw",
          pull,
          observedAt: quietObservation ? "2026-09-08T00:00:03Z" : initial.updated_at,
        },
        null,
        2,
      ),
    );
    await run("review", [
      "review",
      "--target-repo",
      "openclaw/openclaw",
      "--item-number",
      "141913",
      "--pr-admission-file",
      admission,
      "--artifact-dir",
      items,
      "--skip-start-comment",
    ]);
    assert.equal(requests.length, 0, "metadata admission must not fetch transport context");
    const applyArgs = [
      "apply-decisions",
      "--target-repo",
      "openclaw/openclaw",
      "--items-dir",
      items,
      "--closed-dir",
      closed,
      "--plans-dir",
      join(directory, "plans"),
      "--report-path",
      join(directory, "apply.json"),
      "--item-number",
      "141913",
      "--apply-kind",
      "all",
      "--min-age-minutes",
      "0",
      "--close-delay-ms",
      "0",
      "--skip-dashboard",
    ];
    await run("apply", applyArgs);
    let retry;
    if (scenario === "late-review-edit-retry") {
      const original = JSON.parse(readFileSync(join(directory, "apply.json"), "utf8"));
      assert.ok(original.some((entry) => /activity changed/.test(entry.reason)));
      assert.match(readFileSync(join(items, "141913.md"), "utf8"), /oversized_activity_receipt:/);
      await run("retry", applyArgs);
      retry = JSON.parse(readFileSync(join(directory, "apply.json"), "utf8"));
      assert.ok(
        retry.some((entry) => /persisted PR activity receipt/.test(entry.reason)),
        JSON.stringify(retry),
      );
    }
    const isClosed = scenario === "eligible" || scenario === "stable-old-comment";
    assert.equal(pull.state, isClosed ? "closed" : "open");
    assert.equal(existsSync(join(closed, "141913.md")), isClosed);
    assert.equal(existsSync(join(items, "141913.md")), !isClosed);
    const closeWrites = requests.filter(
      (entry) => entry.method === "PATCH" && entry.path.endsWith("/pulls/141913"),
    ).length;
    assert.equal(closeWrites, isClosed ? 1 : 0);
    const owned = comments.filter((entry) => entry.user.login === "clawsweeper[bot]");
    assert.equal(
      owned.length,
      scenario === "protected" || scenario === "ambiguous-initial-comment" ? 0 : 1,
    );
    if (owned.length)
      assert.match(
        owned[0].body,
        isClosed
          ? /ClawSweeper closed this pull request/
          : /ClawSweeper proposes closing this pull request/,
      );
    assert.ok(requests.every((entry) => !/\/(files|commits|blobs)(\/|$)/.test(entry.path)));
    const summary = {
      scenario,
      state: pull.state,
      closeWrites,
      ownedComments: owned.length,
      location: isClosed ? "closed" : "items",
      apply: JSON.parse(readFileSync(join(directory, "apply.json"), "utf8")),
      ...(retry ? { retry } : {}),
    };
    summaries.push(summary);
    writeFileSync(
      join(directory, "server-state.json"),
      JSON.stringify({ pull, comments, timeline, reviews, requests }, null, 2),
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
writeFileSync(join(root, "results.json"), JSON.stringify(summaries, null, 2));
console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        platform: process.platform,
        transport: "isolated loopback HTTP through the built CLI GitHub command adapter",
      },
      results: summaries,
      limits:
        "Synthetic GitHub service and data; no live GitHub close or production dispatch. Filesystem records and HTTP service state are observed final effects.",
    },
    null,
    2,
  ),
);
