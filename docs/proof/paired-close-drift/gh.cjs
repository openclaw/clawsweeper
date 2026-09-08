const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = process.env.PAIR_PROOF_ROOT;
if (!root) throw new Error("PAIR_PROOF_ROOT is required; no real gh fallback exists");
const stateFile = path.join(root, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const rawArgs = process.argv.slice(2);
if (rawArgs[0] === "--repo") assert.equal(rawArgs[1], "openclaw/openclaw");
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
const methodAt = args.findIndex((x) => x === "--method" || x === "-X");
const method = methodAt < 0 ? "GET" : args[methodAt + 1].toUpperCase();
const rawPath = args[1] === "-i" ? args[2] : args[1];
const endpoint = (rawPath || "").split("?")[0];
const slurp = args.includes("--slurp");
const trace = (entry) =>
  fs.appendFileSync(path.join(root, "trace.jsonl"), JSON.stringify(entry) + "\n");
trace({ command: args[0], method, path: endpoint, afterNote: state.triggered });
function save() {
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
function emit(value) {
  console.log(JSON.stringify(value));
  process.exit(0);
}
function list(value) {
  emit(slurp ? [value] : value);
}
function payload() {
  const i = args.indexOf("--input");
  assert(i >= 0);
  return JSON.parse(fs.readFileSync(args[i + 1], "utf8"));
}
function comment(id, number, body) {
  const now = new Date().toISOString();
  return {
    id,
    html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${id}`,
    created_at: now,
    updated_at: now,
    user: { login: "clawsweeper[bot]", type: "Bot" },
    body,
  };
}
function writeComment(number, id) {
  const { body } = payload();
  assert.equal(typeof body, "string");
  const comments = state.comments[number];
  const existing = comments.find((c) => c.id === id);
  const value = comment(id, number, body);
  if (existing) {
    value.created_at = existing.created_at;
    Object.assign(existing, value);
  } else comments.push(value);
  state.items[number].updated_at = value.updated_at;
  if (body.includes("<!-- clawsweeper-close-applied item=321 -->")) {
    trace({ event: "parent-closeout-note", scenario: state.scenario });
    state.triggered = true;
    if (state.scenario === "locked") {
      state.items[322].locked = true;
      state.items[322].updated_at = value.updated_at;
    }
    if (state.scenario === "reopened") {
      state.items[322].state = "open";
      state.items[322].closed_at = null;
      state.items[322].updated_at = value.updated_at;
    }
  }
  save();
  emit(value);
}
if (args[0] === "api" && endpoint === "graphql") {
  const query = args.join(" ");
  if (query.includes("reviewThreads"))
    emit({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    });
  throw new Error("Unsupported synthetic GraphQL query");
}
if (args[0] === "issue" && args[1] === "view" && args[2] === "322")
  emit({ closedByPullRequestsReferences: [] });
if (args[0] === "pr" && args[1] === "close" && args[2] === "321") {
  trace({ event: "close", number: 321 });
  state.items[321].state = "closed";
  state.items[321].closed_at = new Date().toISOString();
  save();
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "edit") {
  const number = Number(args[2]);
  assert([321, 322].includes(number));
  const operation = args[3],
    name = args[4];
  assert(["--add-label", "--remove-label"].includes(operation));
  assert.equal(args.length, 5);
  const names = new Set(state.items[number].labels.map((label) => label.name));
  if (operation === "--add-label") names.add(name);
  else names.delete(name);
  state.items[number].labels = [...names].map((name) => ({ name }));
  state.items[number].updated_at = new Date().toISOString();
  save();
  process.exit(0);
}
if (args[0] === "label" && ["create", "edit"].includes(args[1])) {
  const name = args[2];
  assert.equal(typeof name, "string");
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index < 0 ? "" : args[index + 1];
  };
  state.labels[name] = { name, color: value("--color"), description: value("--description") };
  save();
  process.exit(0);
}
if (args[0] !== "api") throw new Error("Unsupported synthetic command: " + args.join(" "));
if (endpoint === "repos/openclaw/openclaw") emit({ default_branch: "main" });
if (endpoint.startsWith("search/issues"))
  emit({ total_count: 0, incomplete_results: false, items: [] });
const issueMatch = endpoint.match(/^repos\/openclaw\/openclaw\/issues\/(321|322)$/);
if (issueMatch) {
  const number = Number(issueMatch[1]);
  if (method === "PATCH") {
    assert.equal(number, 322);
    assert.deepEqual(payload(), { state: "closed", state_reason: "not_planned" });
    trace({ event: "close", number });
    state.items[number].state = "closed";
    state.items[number].closed_at = new Date().toISOString();
    save();
    emit(state.items[number]);
  }
  assert.equal(method, "GET");
  if (number === 322 && state.triggered && state.scenario === "read-failure") {
    console.error("HTTP 422: synthetic counterpart refresh failure");
    process.exit(1);
  }
  emit({ ...state.items[number], comments: state.comments[number].length });
}
const commentList = endpoint.match(/^repos\/openclaw\/openclaw\/issues\/(321|322)\/comments$/);
if (commentList) {
  const number = Number(commentList[1]);
  if (method === "POST") writeComment(number, state.nextComment++);
  assert.equal(method, "GET");
  list(state.comments[number]);
}
const commentById = endpoint.match(/^repos\/openclaw\/openclaw\/issues\/comments\/(\d+)$/);
if (commentById) {
  const id = Number(commentById[1]);
  const number = [321, 322].find((n) => state.comments[n].some((c) => c.id === id));
  assert(number);
  if (method === "PATCH") writeComment(number, id);
  if (method === "DELETE") {
    state.comments[number] = state.comments[number].filter((c) => c.id !== id);
    save();
    process.exit(0);
  }
  assert.equal(method, "GET");
  emit(state.comments[number].find((c) => c.id === id));
}
if (/^repos\/openclaw\/openclaw\/issues\/(321|322)\/timeline$/.test(endpoint)) {
  if (args.includes("-i")) {
    console.log("HTTP/2 200\n\n[]");
    process.exit(0);
  }
  list([]);
}
if (endpoint === "repos/openclaw/openclaw/pulls/321") {
  assert.equal(method, "GET");
  const pull = {
    ...state.items[321],
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    changed_files: 1,
    commits: 1,
    review_comments: 0,
    head: {
      sha: state.head,
      ref: "fixture",
      repo: { id: 2, full_name: "fixture-author/openclaw" },
    },
    base: { sha: state.base, ref: "main", repo: { id: 1, full_name: "openclaw/openclaw" } },
  };
  if (args.includes("--jq") && args[args.indexOf("--jq") + 1] === "{body}")
    emit({ body: pull.body });
  emit(pull);
}
if (endpoint === "repos/openclaw/openclaw/pulls/321/files")
  list([
    {
      filename: "src/fixture.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-before\n+after",
    },
  ]);
if (endpoint === "repos/openclaw/openclaw/pulls/321/commits")
  list([
    {
      sha: state.head,
      commit: {
        message: "Synthetic change",
        author: { date: "2026-05-01T00:00:00Z" },
        committer: { date: "2026-05-01T00:00:00Z" },
      },
      author: { login: "fixture-author" },
    },
  ]);
if (/^repos\/openclaw\/openclaw\/pulls\/321\/(comments|reviews)$/.test(endpoint)) list([]);
if (endpoint === `repos/openclaw/openclaw/commits/${state.head}/check-runs`)
  emit({ total_count: 0, check_runs: [] });
if (endpoint === `repos/openclaw/openclaw/commits/${state.head}/status`)
  emit({ total_count: 0, statuses: [], state: "success" });
const labelList = endpoint.match(/^repos\/openclaw\/openclaw\/issues\/(321|322)\/labels$/);
if (labelList && (method === "POST" || method === "PUT")) {
  const number = Number(labelList[1]);
  const data = payload();
  assert(Array.isArray(data.labels));
  const names =
    method === "PUT"
      ? data.labels
      : [...state.items[number].labels.map((x) => x.name), ...data.labels];
  state.items[number].labels = [...new Set(names)].map((name) => ({ name }));
  state.items[number].updated_at = new Date().toISOString();
  save();
  emit(state.items[number].labels);
}
const labelDelete = endpoint.match(/^repos\/openclaw\/openclaw\/issues\/(321|322)\/labels\/(.+)$/);
if (labelDelete && method === "DELETE") {
  const number = Number(labelDelete[1]);
  const name = decodeURIComponent(labelDelete[2]);
  state.items[number].labels = state.items[number].labels.filter((x) => x.name !== name);
  state.items[number].updated_at = new Date().toISOString();
  save();
  emit(state.items[number].labels);
}
if (endpoint === "repos/openclaw/openclaw/labels" && method === "POST") {
  const data = payload();
  assert.equal(typeof data.name, "string");
  state.labels[data.name] = data;
  save();
  emit(data);
}
if (endpoint.startsWith("repos/openclaw/openclaw/labels/") && method === "PATCH") {
  const data = payload();
  const name = decodeURIComponent(endpoint.split("/").at(-1));
  state.labels[name] = data;
  save();
  emit({ name, ...data });
}
throw new Error("Unsupported synthetic API request: " + method + " " + args.join(" "));
