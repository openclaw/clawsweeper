// Secretless, fail-closed transport: all writes are local fixture state.
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.APPLY_MEMORY_CASE;
const raw = process.argv.slice(2);
const args = raw[0] === "--repo" ? raw.slice(2) : raw;
const endpoint = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
fs.appendFileSync(path.join(root, "requests.jsonl"), `${JSON.stringify({ args, method })}\n`);
const match = endpoint.match(/\/issues\/(\d+)(?:\/|$)/);
const number = Number(match?.[1]);
const commentPath = path.join(root, `comment-${number}.json`);
const output = (value) => {
  if (args.includes("-i")) process.stdout.write("HTTP/2 200\n\n");
  console.log(JSON.stringify(value));
};
if (number === 102 && process.env.APPLY_MEMORY_INTERRUPT) {
  if (process.env.APPLY_MEMORY_INTERRUPT === "budget") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  }
  console.error("fixture interrupted second item (HTTP 422)");
  process.exit(1);
}
if (args[0] === "api" && /\/issues\/\d+\/comments(?:\?|$)/.test(endpoint)) {
  if (method === "POST") {
    const payload = JSON.parse(fs.readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    const comment = {
      id: 9000 + number,
      html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9000 + number}`,
      created_at: "2026-08-02T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
      user: { login: "clawsweeper[bot]" },
      body: payload.body,
    };
    fs.writeFileSync(commentPath, JSON.stringify(comment));
    output(comment);
  } else if (method === "GET") {
    output([fs.existsSync(commentPath) ? [JSON.parse(fs.readFileSync(commentPath, "utf8"))] : []]);
  } else throw new Error(`unexpected comment mutation: ${method}`);
} else if (args[0] === "api" && /\/issues\/\d+\/timeline(?:\?|$)/.test(endpoint)) {
  output([[]]);
} else if (args[0] === "api" && /\/issues\/\d+$/.test(endpoint) && method === "GET") {
  const isPull = process.env.APPLY_MEMORY_KIND === "pull_request";
  output({
    number,
    title: "Memory proof",
    body: "",
    html_url: `https://github.com/openclaw/openclaw/${isPull ? "pull" : "issues"}/${number}`,
    created_at: "2026-05-01T00:00:00Z",
    updated_at:
      process.env.APPLY_MEMORY_DRIFT && number >= 121
        ? "2026-05-02T00:00:00Z"
        : "2026-05-01T00:00:00Z",
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: isPull
      ? ["security"]
      : ["security", "issue-rating: 🦀 challenger crab", "clawsweeper:current-main-repro"],
    comments: fs.existsSync(commentPath) ? 1 : 0,
    pull_request: isPull
      ? { url: `https://api.github.com/repos/openclaw/openclaw/pulls/${number}` }
      : null,
  });
} else if (args[0] === "api" && /\/pulls\/\d+$/.test(endpoint) && method === "GET") {
  output({ head: { sha: "a".repeat(40) }, base: { ref: "main" }, merged: false, state: "open" });
} else if (
  args[0] === "api" &&
  /\/pulls\/\d+\/(files|commits|comments|reviews)(?:\?|$)/.test(endpoint) &&
  method === "GET"
) {
  output([[]]);
} else if (
  args[0] === "api" &&
  endpoint === "graphql" &&
  args.some((arg) => arg.includes("reviewThreads"))
) {
  output({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
  });
} else if (args[0] === "issue" && args[1] === "view") {
  output({ closedByPullRequestsReferences: [] });
} else if (
  args[0] === "api" &&
  /\/commits\/[a-f0-9]+\/check-runs\?/.test(endpoint) &&
  method === "GET"
) {
  output({ total_count: 0, check_runs: [] });
} else if (
  args[0] === "api" &&
  /\/commits\/[a-f0-9]+\/status(?:\?|$)/.test(endpoint) &&
  method === "GET"
) {
  output({ total_count: 0, statuses: [] });
} else if (args[0] === "api" && endpoint.startsWith("search/issues?") && method === "GET") {
  output({ items: [] });
} else if (args[0] === "label" || (args[0] === "issue" && args[1] === "edit")) {
  output({});
} else {
  throw new Error(`unexpected fixture request: ${JSON.stringify(args)}`);
}
