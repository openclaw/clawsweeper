const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = process.env.PAIR_PROOF_ROOT;
if (!root) throw new Error("PAIR_PROOF_ROOT is required; no real gh fallback exists");
const stateFile = path.join(root, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const { createServer } = require("node:http");
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const data = body ? JSON.parse(body) : {};
  const endpoint = new URL(request.url, "https://localhost").pathname
    .replace(/^\/api\/v3\//, "")
    .replace(/^\/api\/graphql$/, "graphql")
    .replace(/^\/+/, "");
  const method = request.method;
  const trace = (entry) =>
    fs.appendFileSync(path.join(root, "trace.jsonl"), JSON.stringify(entry) + "\n");
  trace({ method, path: endpoint, afterNote: state.triggered });
  function save() {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  function emit(value, status = 200) {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
    throw done;
  }
  function read(value) {
    assert.equal(method, "GET", "read-only route requires GET");
    emit(value);
  }
  function list(value) {
    read(value);
  }
  function payload() {
    return data;
  }
  const done = Symbol("response sent");
  try {
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
    if (endpoint === "graphql") {
      assert.equal(method, "POST");
      const query = data.query || "";
      const variables = data.variables || {};
      for (const key of ["owner", "repo", "name"])
        if (variables[key] !== undefined) assert.equal(variables[key], "openclaw");
      for (const key of ["number", "issueNumber", "pullRequestNumber", "pr_number"])
        if (variables[key] !== undefined)
          assert.ok([321, 322].includes(Number(variables[key])), "unknown item selector");
      if (query.includes("PullRequestByNumber"))
        assert.equal(Number(variables.pr_number ?? variables.number), 321);
      trace({ event: "graphql", query, variables });
      const number = Number(
        variables.number || variables.issueNumber || variables.pullRequestNumber || 321,
      );
      const graphItem = (n) => ({
        number: n,
        body: state.items[n].body,
        __typename: n === 321 ? "PullRequest" : "Issue",
        id: n === 321 ? "PR_321" : "I_322",
        title: state.items[n].title,
        state: state.items[n].state.toUpperCase(),
        closed: state.items[n].state === "closed",
        url: state.items[n].html_url,
        headRefName: "fixture",
        isCrossRepository: true,
        repository: { id: "R_1", name: "openclaw", owner: { login: "openclaw" } },
        labels: { nodes: state.items[n].labels.map((x) => ({ id: "L_" + x.name, name: x.name })) },
        closedByPullRequestsReferences: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      });
      if (query.includes("ReviewedPrActivityCursorV2"))
        emit({
          data: {
            repository: {
              pr_321: {
                reviews: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
                reviewThreads: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
              },
            },
          },
        });
      if (query.includes("RepositoryLabelList"))
        emit({
          data: {
            repository: {
              labels: {
                nodes: Object.values(state.labels).map((x) => ({
                  id: "L_" + x.name,
                  name: x.name,
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      if (query.includes("closePullRequest")) {
        assert.equal(variables.input.pullRequestId, "PR_321");
        state.items[321].state = "closed";
        state.items[321].closed_at = new Date().toISOString();
        trace({ event: "close", number: 321 });
        save();
        emit({ data: { closePullRequest: { pullRequest: { id: "PR_321" } } } });
      }
      if (query.includes("addLabelsToLabelable") || query.includes("removeLabelsFromLabelable")) {
        const input = variables.input;
        assert.ok(["PR_321", "I_322"].includes(input.labelableId), "unknown label target");
        assert.ok(Array.isArray(input.labelIds), "label IDs must be an array");
        const n = input.labelableId === "PR_321" ? 321 : 322;
        const labels = new Set(state.items[n].labels.map((x) => x.name));
        for (const id of input.labelIds) {
          assert.equal(typeof id, "string");
          assert.ok(
            id.startsWith("L_") && Object.hasOwn(state.labels, id.slice(2)),
            "unknown label ID",
          );
          const name = id.slice(2);
          if (query.includes("addLabelsToLabelable")) labels.add(name);
          else labels.delete(name);
        }
        state.items[n].labels = [...labels].map((name) => ({ name }));
        state.items[n].updated_at = new Date().toISOString();
        save();
        const field = query.includes("addLabelsToLabelable")
          ? "addLabelsToLabelable"
          : "removeLabelsFromLabelable";
        emit({ data: { [field]: { __typename: "LabelPayload" } } });
      }
      if (query.includes("mutation")) throw new Error("Unhandled GraphQL mutation: " + query);
      assert.ok(
        [
          "IssueByNumber",
          "PullRequestByNumber",
          "reviewThreads",
          "closedByPullRequestsReferences",
        ].some((name) => query.includes(name)),
        "unexpected GraphQL read",
      );
      emit({
        data: {
          repository: {
            id: "R_1",
            name: "openclaw",
            owner: { login: "openclaw" },
            hasIssuesEnabled: true,
            pullRequest: graphItem(321),
            issue: graphItem(number === 321 ? 321 : 322),
            labels: {
              nodes: Object.values(state.labels).map((x) => ({ ...x, id: "L_" + x.name })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    if (endpoint === "repos/openclaw/openclaw")
      read({
        id: 1,
        name: "openclaw",
        full_name: "openclaw/openclaw",
        owner: { login: "openclaw" },
        default_branch: "main",
      });
    if (endpoint.startsWith("search/issues"))
      read({ total_count: 0, incomplete_results: false, items: [] });
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
        emit({ message: "synthetic counterpart refresh failure" }, 422);
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
        emit({});
      }
      assert.equal(method, "GET");
      emit(state.comments[number].find((c) => c.id === id));
    }
    if (/^repos\/openclaw\/openclaw\/issues\/(321|322)\/timeline$/.test(endpoint)) {
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
      read({ total_count: 0, check_runs: [] });
    if (endpoint === `repos/openclaw/openclaw/commits/${state.head}/status`)
      read({ total_count: 0, statuses: [], state: "success" });
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
    const labelDelete = endpoint.match(
      /^repos\/openclaw\/openclaw\/issues\/(321|322)\/labels\/(.+)$/,
    );
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
    throw new Error("Unsupported local API request: " + method + " " + endpoint);
  } catch (error) {
    if (error === done) return;
    fs.appendFileSync(path.join(root, "server-errors.log"), String(error.stack || error) + "\n");
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: String(error.message || error) }));
  }
});
server.listen(process.env.PAIR_SOCKET, () => fs.writeFileSync(process.env.PAIR_PORT_FILE, "ready"));
