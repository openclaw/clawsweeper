import http from "node:http";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const fixture = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
const scenario = fixture.scenario.replace(/^legacy_/, "");
const state = {
  closePatchCount: 0,
  lockReads: 0,
  durableWrites: 0,
  timeline: [],
  comments: [
    fixture.lease,
    {
      id: 9321,
      node_id: "IC_9321",
      html_url: "https://github.com/openclaw/openclaw/issues/321#issuecomment-9321",
      user: { login: "clawsweeper[bot]", type: "Bot" },
      body: fixture.initialComment ?? "Codex review: old.\n\n<!-- clawsweeper-review item=321 -->",
      created_at: fixture.reviewed,
      updated_at: fixture.reviewed,
    },
  ],
};
const issue = {
  number: 321,
  title: fixture.title,
  body: fixture.body,
  html_url: "https://github.com/openclaw/openclaw/issues/321",
  created_at: "2026-02-01T00:00:00Z",
  updated_at: fixture.reviewed,
  closed_at: null,
  state: "open",
  locked: false,
  active_lock_reason: null,
  author_association: "CONTRIBUTOR",
  user: { login: "reporter", type: "User" },
  labels: [],
  assignees: [],
  pull_request: null,
};
if (scenario.startsWith("missing_source"))
  state.comments = state.comments.filter((comment) => comment.id !== 77);
let postWriteTimelineReads = 0;
function lock(at) {
  issue.locked = true;
  issue.active_lock_reason = "resolved";
  issue.updated_at = at;
  state.timeline.push({
    id: 555,
    event: "locked",
    actor: { login: "human-maintainer", type: "User" },
    created_at: at,
  });
}
if (scenario === "initially_locked") issue.locked = true;
function gh({ args: raw, input }) {
  const args = raw[0] === "--repo" ? raw.slice(2) : raw;
  const path = args[args[1] === "-i" ? 2 : 1] ?? "";
  const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
  const paged = (value) => (args.includes("--slurp") ? [value] : value);
  const ok = (value) => ({ stdout: typeof value === "string" ? value : JSON.stringify(value) });
  appendFileSync(
    join(dir, "http-trace.jsonl"),
    JSON.stringify({
      args,
      input,
      issue: { state: issue.state, locked: issue.locked, updated_at: issue.updated_at },
    }) + "\n",
  );
  if (args[0] === "api" && /issues\/comments\/\d+$/.test(path)) {
    const id = Number(path.split("/").at(-1));
    if (method === "DELETE") {
      state.comments = state.comments.filter((comment) => comment.id !== id);
      return ok("");
    }
    if (method === "PATCH") {
      const comment = state.comments.find((entry) => entry.id === id);
      if (!comment) throw new Error("missing comment " + id);
      comment.body = input.body;
      comment.updated_at = fixture.written;
      state.durableWrites++;
      if (scenario === "bot_source_edit") {
        issue.body += " Changed by another automation actor.";
        state.timeline.push({
          id: 559,
          event: "edited",
          actor: { login: "another[bot]", type: "Bot" },
          created_at: fixture.written,
        });
      }
      issue.updated_at = scenario === "no_drift" ? fixture.reviewed : fixture.written;
      if (scenario === "late_lock") lock(fixture.changed);
      if (scenario === "same_second_lock") lock(fixture.written);
      if (scenario === "same_review_second_lock") lock(fixture.reviewed);
      if (scenario === "late_closed") {
        issue.state = "closed";
        issue.updated_at = fixture.changed;
        state.timeline.push({
          id: 556,
          event: "closed",
          actor: { login: "human-maintainer" },
          created_at: fixture.changed,
        });
      }
      if (scenario === "reopened") {
        for (const event of ["closed", "reopened"])
          state.timeline.push({
            id: state.timeline.length + 556,
            event,
            actor: { login: "human-maintainer" },
            created_at: fixture.written,
          });
      }
      if (scenario === "same_review_second_activity") issue.updated_at = fixture.reviewed;
      if (["human_activity", "same_review_second_activity"].includes(scenario))
        state.timeline.push({
          id: 558,
          event: "assigned",
          actor: { login: "human-maintainer" },
          created_at: fixture.written,
        });
      return ok(comment);
    }
    return ok(state.comments.find((comment) => comment.id === id));
  }
  if (args[0] === "api" && /issues\/321(?:\?|$)/.test(path)) {
    if (method === "PATCH" && input?.state === "closed") {
      state.closePatchCount++;
      issue.state = "closed";
      issue.closed_at = fixture.changed;
      return ok(issue);
    }
    if (issue.locked) state.lockReads++;
    return ok({ ...issue, comments: state.comments.length });
  }
  if (args[0] === "api" && /issues\/321\/comments/.test(path)) return ok(paged(state.comments));
  if (args[0] === "api" && /issues\/321\/timeline/.test(path)) {
    if (
      state.durableWrites > 0 &&
      ++postWriteTimelineReads === 2 &&
      scenario === "post_receipt_lock"
    )
      lock(fixture.written);
    const value = paged(state.timeline);
    return ok(args[1] === "-i" ? "HTTP/2 200\n\n" + JSON.stringify(value) : value);
  }
  if (args[0] === "api" && path.startsWith("search/issues"))
    return ok({ total_count: 0, incomplete_results: false, items: [] });
  if (args[0] === "issue" && args[1] === "view") return ok({ closedByPullRequestsReferences: [] });
  if (args[0] === "api" && path === "graphql")
    return ok({
      data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } },
    });
  if (args[0] === "api" && path === "repos/openclaw/openclaw")
    return ok({ default_branch: "main", full_name: "openclaw/openclaw" });
  throw new Error("Unhandled controlled gh request " + JSON.stringify({ args, input }));
}
const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/state") {
    response.end(JSON.stringify(state));
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  try {
    response.end(JSON.stringify(gh(JSON.parse(body))));
  } catch (error) {
    response.end(JSON.stringify({ status: 1, stderr: error.message }));
  }
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
process.on("SIGTERM", () => {
  writeFileSync(join(dir, "boundary-state.json"), JSON.stringify(state, null, 2));
  server.close();
});
