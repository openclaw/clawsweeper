// Stateful synthetic GitHub API for scripts/e2e/apply-source-drift-final-effect.mjs.
// Native gh reaches it through its documented `http_unix_socket` option. Every request is
// traced; unknown routes and mutations fail loudly instead of guessing.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:http");

const root = process.env.DRIFT_PROOF_ROOT;
const socketPath = process.env.DRIFT_PROOF_SOCKET;
if (!root || !socketPath) throw new Error("DRIFT_PROOF_ROOT and DRIFT_PROOF_SOCKET are required");
const stateFile = path.join(root, "state.json");
const traceFile = path.join(root, "trace.jsonl");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const repo = state.repo;
const number = state.number;
let sequence = 0;

const users = state.tokens;
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const clone = (value) => JSON.parse(JSON.stringify(value));
const done = Symbol("response sent");

function bump(at = nowIso()) {
  state.issue.updated_at = at;
  state.pull.updated_at = at;
  return at;
}
function userObject(login) {
  return { login, id: 1, type: login.endsWith("[bot]") ? "Bot" : "User" };
}
function timelineEvent(event, actor, extra = {}) {
  return {
    id: state.nextEventId++,
    event,
    actor: userObject(actor),
    created_at: nowIso(),
    ...extra,
  };
}
function labelObjects() {
  return state.labels.map((name) => ({
    id: state.labelCatalog[name]?.id ?? 0,
    node_id: "L_" + Buffer.from(name).toString("hex"),
    name,
    color: state.labelCatalog[name]?.color ?? "ededed",
    description: state.labelCatalog[name]?.description ?? "",
  }));
}
function issueView() {
  return {
    ...state.issue,
    title: state.title,
    body: state.body,
    state: state.state,
    closed_at: state.closedAt,
    labels: labelObjects(),
    comments: state.comments.length,
  };
}
function pullView() {
  return {
    ...state.pull,
    title: state.title,
    body: state.body,
    state: state.state,
    closed_at: state.closedAt,
    labels: labelObjects(),
    head: { ...state.pull.head, sha: state.headSha },
    comments: state.comments.length,
  };
}
function page(list, url) {
  const perPage = Math.max(1, Number(url.searchParams.get("per_page") || 30));
  const index = Math.max(1, Number(url.searchParams.get("page") || 1));
  return {
    items: list.slice((index - 1) * perPage, index * perPage),
    perPage,
    index,
    total: list.length,
  };
}
function linkHeader(url, current, perPage, total) {
  const last = Math.max(1, Math.ceil(total / perPage));
  if (last <= 1) return undefined;
  const at = (n) => {
    const next = new URL(url.toString());
    next.searchParams.set("page", String(n));
    return `<https://api.github.com${next.pathname}${next.search}>`;
  };
  const parts = [];
  if (current < last) parts.push(`${at(current + 1)}; rel="next"`, `${at(last)}; rel="last"`);
  if (current > 1) parts.push(`${at(1)}; rel="first"`, `${at(current - 1)}; rel="prev"`);
  return parts.join(", ");
}

const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const url = new URL(request.url, "https://api.github.com");
  const endpoint = url.pathname
    .replace(/^\/api\/v3\//, "/")
    .replace(/^\/api\/graphql$/, "/graphql");
  const method = request.method;
  const token = String(request.headers.authorization || "").replace(/^(token|bearer)\s+/i, "");
  const actor = users[token] ?? null;
  const entry = {
    seq: ++sequence,
    phase: state.phase,
    method,
    path: endpoint + url.search,
    actor,
  };
  let statusCode = 200;
  const send = (value, status = 200, headers = {}) => {
    statusCode = status;
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(status === 204 ? "" : JSON.stringify(value));
    throw done;
  };
  const effect = (kind, detail = {}) => {
    entry.effect = { kind, ...detail };
  };
  try {
    if (!actor) send({ message: "Bad credentials" }, 401);
    const body = raw ? JSON.parse(raw) : {};
    const prefix = `/repos/${repo}`;
    const requireRead = () => {
      if (method !== "GET") throw new Error(`read-only route received ${method} ${endpoint}`);
    };
    const list = (items) => {
      requireRead();
      const slice = page(items, url);
      const link = linkHeader(url, slice.index, slice.perPage, slice.total);
      send(slice.items, 200, link ? { link } : {});
    };

    if (endpoint === "/__proof/phase") {
      if (actor !== "proof-harness") throw new Error("phase control requires the harness token");
      state.phase = body.phase;
      save();
      send({ phase: state.phase });
    }
    if (endpoint === "/__proof/push-head") {
      if (actor !== "proof-harness") throw new Error("push control requires the harness token");
      // A push is not an API call; model its observable GitHub state.
      state.headSha = body.sha;
      state.timeline.push(
        timelineEvent("head_ref_force_pushed", state.issue.user.login, { commit_id: body.sha }),
      );
      bump();
      effect("synthetic_push", { sha: body.sha });
      save();
      send({ head: state.headSha });
    }

    if (endpoint === "/graphql") {
      if (method !== "POST") throw new Error("GraphQL requires POST");
      const query = String(body.query || "");
      const variables = body.variables || {};
      const operation = (query.match(/\b(query|mutation)\s+(\w+)/) || [])[2] || "anonymous";
      entry.graphql = operation;
      entry.query = query.replace(/\s+/g, " ").slice(0, 400);
      const pullNode = () => ({
        __typename: "PullRequest",
        id: `PR_${number}`,
        number,
        title: state.title,
        body: state.body,
        url: `https://github.com/${repo}/pull/${number}`,
        state: state.state.toUpperCase(),
        closed: state.state === "closed",
        isDraft: Boolean(state.pull.draft),
        headRefName: state.pull.head.ref,
        headRefOid: state.headSha,
        baseRefName: state.pull.base.ref,
        isCrossRepository: true,
        author: { login: state.issue.user.login },
        repository: { id: "R_1", name: repo.split("/")[1], owner: { login: repo.split("/")[0] } },
        labels: {
          totalCount: state.labels.length,
          nodes: labelObjects().map((label) => ({
            id: label.node_id,
            name: label.name,
            description: label.description,
            color: label.color,
          })),
        },
        closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        closedByPullRequestsReferences: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
      if (query.includes("ReviewedPrActivityCursorV2")) send(clone(state.activityCursorGraphql));
      if (query.includes("closePullRequest")) {
        if (variables.input?.pullRequestId !== `PR_${number}`)
          throw new Error("unknown close target");
        if (actor !== state.botLogin) throw new Error("close requires the ClawSweeper token");
        state.state = "closed";
        state.closedAt = nowIso();
        state.timeline.push(timelineEvent("closed", actor));
        bump();
        effect("close", { via: "graphql closePullRequest" });
        save();
        send({ data: { closePullRequest: { pullRequest: { id: `PR_${number}` } } } });
      }
      if (query.includes("addLabelsToLabelable") || query.includes("removeLabelsFromLabelable")) {
        const input = variables.input || {};
        if (input.labelableId !== `PR_${number}`) throw new Error("unknown label target");
        const add = query.includes("addLabelsToLabelable");
        const names = (input.labelIds || []).map((id) => {
          const name = Buffer.from(String(id).replace(/^L_/, ""), "hex").toString();
          if (!state.labelCatalog[name]) throw new Error("unknown label ID " + id);
          return name;
        });
        const next = new Set(state.labels);
        for (const name of names) {
          if (add ? next.has(name) : !next.has(name)) continue;
          if (add) next.add(name);
          else next.delete(name);
          state.timeline.push(
            timelineEvent(add ? "labeled" : "unlabeled", actor, { label: { name } }),
          );
        }
        state.labels = [...next];
        bump();
        effect(add ? "labels_add" : "labels_remove", { labels: names });
        save();
        send({
          data: {
            [add ? "addLabelsToLabelable" : "removeLabelsFromLabelable"]: {
              __typename: "LabelPayload",
            },
          },
        });
      }
      if (/\bmutation\b/.test(query)) throw new Error("unhandled GraphQL mutation " + operation);
      if (query.includes("labels(") && query.includes("repository") && !query.includes("issue")) {
        send({
          data: {
            repository: {
              labels: {
                // Native gh decodes this query strictly: return only the selected fields.
                nodes: Object.keys(state.labelCatalog).map((name) => ({
                  id: "L_" + Buffer.from(name).toString("hex"),
                  name,
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      if (
        ["IssueByNumber", "PullRequestByNumber", "IssueInfo", "PullRequestForBranch"].includes(
          operation,
        ) ||
        query.includes("issueOrPullRequest") ||
        query.includes("pullRequest(number")
      ) {
        send({
          data: {
            repository: {
              id: "R_1",
              name: repo.split("/")[1],
              owner: { login: repo.split("/")[0] },
              hasIssuesEnabled: true,
              issue: pullNode(),
              pullRequest: pullNode(),
            },
          },
        });
      }
      throw new Error("unhandled GraphQL read " + operation);
    }

    if (endpoint === `/repos/${repo}`) {
      requireRead();
      send({
        id: 1,
        name: repo.split("/")[1],
        full_name: repo,
        owner: { login: repo.split("/")[0] },
        default_branch: "main",
        private: false,
      });
    }
    if (endpoint === "/user") {
      requireRead();
      send(userObject(actor));
    }
    if (endpoint === "/search/issues") {
      requireRead();
      send({ total_count: 0, incomplete_results: false, items: [] });
    }
    if (endpoint === `${prefix}/issues/${number}`) {
      if (method === "PATCH") {
        const changed = [];
        if (typeof body.title === "string" && body.title !== state.title) {
          state.timeline.push(
            timelineEvent("renamed", actor, { rename: { from: state.title, to: body.title } }),
          );
          state.title = body.title;
          changed.push("title");
        }
        if (typeof body.body === "string" && body.body !== state.body) {
          state.body = body.body;
          changed.push("body");
        }
        if (body.state === "closed" && state.state !== "closed") {
          if (actor !== state.botLogin) throw new Error("close requires the ClawSweeper token");
          state.state = "closed";
          state.closedAt = nowIso();
          state.timeline.push(timelineEvent("closed", actor));
          changed.push("state");
        }
        if (changed.length === 0) throw new Error("issue PATCH changed nothing");
        bump();
        effect(changed.includes("state") ? "close" : "issue_edit", {
          fields: changed,
          via: "REST issue PATCH",
        });
        save();
        send(issueView());
      }
      requireRead();
      send(issueView());
    }
    if (endpoint === `${prefix}/pulls/${number}`) {
      requireRead();
      send(pullView());
    }
    if (endpoint === `${prefix}/issues/${number}/comments`) {
      if (method === "POST") {
        if (typeof body.body !== "string" || !body.body) throw new Error("comment body required");
        const at = nowIso();
        const comment = {
          id: state.nextCommentId++,
          node_id: "IC_synthetic",
          html_url: `https://github.com/${repo}/pull/${number}#issuecomment-${state.nextCommentId - 1}`,
          issue_url: `https://api.github.com/repos/${repo}/issues/${number}`,
          user: userObject(actor),
          author_association: actor === state.botLogin ? "NONE" : state.issue.author_association,
          created_at: at,
          updated_at: at,
          body: body.body,
        };
        state.comments.push(comment);
        state.timeline.push({
          ...timelineEvent("commented", actor),
          id: comment.id,
          created_at: at,
        });
        bump(at);
        effect("comment_create", { comment: comment.id, role: roleOf(comment) });
        save();
        send(comment, 201);
      }
      list(state.comments);
    }
    const commentById = endpoint.match(new RegExp(`^${prefix}/issues/comments/(\\d+)$`));
    if (commentById) {
      const id = Number(commentById[1]);
      const index = state.comments.findIndex((comment) => comment.id === id);
      if (index < 0) send({ message: "Not Found" }, 404);
      const comment = state.comments[index];
      if (method === "GET") send(comment);
      if (comment.user.login !== actor)
        throw new Error(`${actor} cannot modify ${comment.user.login}'s comment`);
      const role = roleOf(comment);
      if (method === "PATCH") {
        if (typeof body.body !== "string") throw new Error("comment body required");
        comment.body = body.body;
        comment.updated_at = bump();
        effect("comment_update", { comment: id, role });
        save();
        send(comment);
      }
      if (method === "DELETE") {
        state.comments.splice(index, 1);
        state.timeline = state.timeline.filter(
          (event) => !(event.event === "commented" && event.id === id),
        );
        bump();
        effect("comment_delete", { comment: id, role });
        save();
        send(null, 204);
      }
      throw new Error(`unsupported ${method} on comment`);
    }
    if (endpoint === `${prefix}/issues/${number}/timeline`) list(state.timeline);
    if (endpoint === `${prefix}/pulls/${number}/files`) list(state.files);
    if (endpoint === `${prefix}/pulls/${number}/commits`) list(state.commits);
    if (endpoint === `${prefix}/pulls/${number}/comments`) list(state.pullComments);
    if (endpoint === `${prefix}/pulls/${number}/reviews`) list(state.reviews);
    const commitRead = endpoint.match(
      new RegExp(`^${prefix}/commits/([0-9a-f]{40})/(check-runs|status)$`),
    );
    if (commitRead) {
      requireRead();
      const current = commitRead[1] === state.capturedHeadSha;
      if (commitRead[2] === "check-runs")
        send(current ? state.checkRuns : { total_count: 0, check_runs: [] });
      send(current ? state.status : { state: "pending", total_count: 0, statuses: [] });
    }
    if (endpoint === `${prefix}/actions/runs`) {
      requireRead();
      const sha = url.searchParams.get("head_sha");
      send(
        sha === state.capturedHeadSha ? state.actionsRuns : { total_count: 0, workflow_runs: [] },
      );
    }
    const relatedIssue = endpoint.match(new RegExp(`^${prefix}/(issues|pulls)/(\\d+)$`));
    if (relatedIssue && state.related[relatedIssue[1]]?.[relatedIssue[2]]) {
      requireRead();
      send(state.related[relatedIssue[1]][relatedIssue[2]]);
    }
    const relatedList = endpoint.match(
      new RegExp(`^${prefix}/(issues|pulls)/(\\d+)/(comments|timeline|files|commits|reviews)$`),
    );
    if (relatedList && Number(relatedList[2]) !== number) list([]);
    const labelsRoute = endpoint.match(new RegExp(`^${prefix}/labels(?:/(.+))?$`));
    if (labelsRoute) {
      const name = labelsRoute[1] ? decodeURIComponent(labelsRoute[1]) : null;
      if (method === "GET" && !name)
        list(
          Object.keys(state.labelCatalog).map((label) => ({
            name: label,
            ...state.labelCatalog[label],
          })),
        );
      if (method === "GET" && name) {
        if (!state.labelCatalog[name]) send({ message: "Not Found" }, 404);
        send({ name, ...state.labelCatalog[name] });
      }
      if (method === "POST" && !name) {
        if (typeof body.name !== "string") throw new Error("label name required");
        if (state.labelCatalog[body.name])
          send({ message: "Validation Failed", errors: [{ code: "already_exists" }] }, 422);
        state.labelCatalog[body.name] = {
          id: Object.keys(state.labelCatalog).length + 1,
          color: body.color ?? "ededed",
          description: body.description ?? "",
        };
        effect("label_definition_create", { label: body.name });
        save();
        send({ name: body.name, ...state.labelCatalog[body.name] }, 201);
      }
      if (method === "PATCH" && name) {
        if (!state.labelCatalog[name]) send({ message: "Not Found" }, 404);
        Object.assign(state.labelCatalog[name], {
          color: body.color ?? state.labelCatalog[name].color,
          description: body.description ?? state.labelCatalog[name].description,
        });
        effect("label_definition_update", { label: name });
        save();
        send({ name, ...state.labelCatalog[name] });
      }
    }
    const itemLabels = endpoint.match(new RegExp(`^${prefix}/issues/${number}/labels(?:/(.+))?$`));
    if (itemLabels) {
      if (method === "GET" && !itemLabels[1]) list(labelObjects());
      const names =
        method === "DELETE"
          ? [decodeURIComponent(itemLabels[1])]
          : Array.isArray(body.labels)
            ? body.labels.map((label) => (typeof label === "string" ? label : label.name))
            : [];
      const next = new Set(method === "PUT" ? [] : state.labels);
      for (const name of names) {
        if (method === "DELETE") next.delete(name);
        else {
          if (!state.labelCatalog[name]) throw new Error("unknown label " + name);
          next.add(name);
        }
      }
      for (const name of new Set([...state.labels, ...next]))
        if (state.labels.includes(name) !== next.has(name))
          state.timeline.push(
            timelineEvent(next.has(name) ? "labeled" : "unlabeled", actor, { label: { name } }),
          );
      state.labels = [...next];
      bump();
      effect(method === "DELETE" ? "labels_remove" : "labels_add", { labels: names, via: "REST" });
      save();
      send(labelObjects());
    }
    throw new Error(`unsupported synthetic GitHub request ${method} ${endpoint}${url.search}`);
  } catch (error) {
    if (error !== done) {
      statusCode = 500;
      entry.error = String(error && error.message ? error.message : error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: entry.error }));
    }
  } finally {
    entry.status = statusCode;
    fs.appendFileSync(traceFile, JSON.stringify(entry) + "\n");
  }
});

function roleOf(comment) {
  const body = String(comment.body || "");
  if (
    comment.id === state.roles.durable ||
    body.includes(`<!-- clawsweeper-review item=${number} -->`)
  )
    return "durable_review";
  if (comment.id === state.roles.acknowledgement || body.includes("clawsweeper-pr-ack:"))
    return "acknowledgement";
  if (body.includes("clawsweeper-review-status:started")) return "review_lease";
  if (body.includes("clawsweeper-close-applied")) return "closeout_note";
  return comment.user.login === state.botLogin ? "clawsweeper_other" : "human";
}

server.listen(socketPath, () => fs.writeFileSync(path.join(root, "server.ready"), "ready"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
