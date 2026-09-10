import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OversizedActivityStore } from "../dashboard/oversized-activity-store.ts";
import { convergeCommandAcknowledgement } from "../dashboard/exact-review-queue.ts";
import {
  ownedCommentWriteIntent,
  ownedCommentWriteResult,
} from "../src/oversized-activity-write.ts";

const root = resolve(process.argv[2] || ".artifacts/oversized-effects-proof");
mkdirSync(root, { recursive: true });
const adapter = join(root, "github-http-adapter.mjs");
writeFileSync(
  adapter,
  `import {readFileSync} from 'node:fs';
let args=process.argv.slice(2); if(args[0]==='--repo')args=args.slice(2);
let method='GET',path,body;
if(args[0]==='api') {
 path='/'+args[1]; const m=args.findIndex(x=>x==='--method'||x==='-X'); if(m>=0)method=args[m+1];
 const i=args.indexOf('--input'); if(i>=0)body=readFileSync(args[i+1],'utf8');
 const f=args.indexOf('-f'); if(f>=0&&args[f+1].startsWith('body='))body=JSON.stringify({body:args[f+1].slice(5)});
} else if(args[0]==='pr'&&args[1]==='close'){method='PATCH';path='/repos/openclaw/openclaw/pulls/'+args[2];body=JSON.stringify({state:'closed'});}else throw new Error('unexpected GitHub command');
if(!path.startsWith('/repos/openclaw/openclaw/'))throw new Error('unexpected target');
const base=new URL(process.env.PROOF_HTTP_URL); if(base.hostname!=='127.0.0.1'||base.protocol!=='http:')throw new Error('loopback required');
const r=await fetch(new URL(path,base),{method,body,headers:{'content-type':'application/json'}});const t=await r.text();if(!r.ok){console.error(t);process.exit(1);}process.stdout.write(args.includes('--slurp')?JSON.stringify([JSON.parse(t)]):t);
`,
);
const number = 141913,
  repo = "openclaw/openclaw",
  head = "b".repeat(40);
const marker = "<!-- clawsweeper-command-status:synthetic-proof -->";
const oldTime = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const scenarios = [
  "first-direct",
  "existing-direct",
  "first-queued",
  "existing-queued",
  "review-unchanged",
  "same-second-review-edit",
  "late-human-comment",
  "late-review-edit",
  "late-label",
  "late-head",
  "propagation-race",
  "evidence-absent",
  "evidence-malformed",
  "evidence-stale",
  "journal-begin-unavailable",
  "journal-complete-unavailable",
  "journal-malformed-response",
];
const selected = process.env.PROOF_SCENARIOS?.split(",") || scenarios;
const summaries = [];
for (const scenario of selected) {
  const directory = join(root, scenario);
  mkdirSync(directory, { recursive: true });
  const pull = {
    number,
    title: "Synthetic oversized PR",
    body: "Synthetic body",
    html_url: `https://github.com/${repo}/pull/${number}`,
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
    created_at: oldTime,
    updated_at: oldTime,
    head: { sha: head, repo: { full_name: "synthetic-owner/openclaw" } },
    base: { ref: "main", sha: "a".repeat(40) },
  };
  const comments = [],
    timeline = [],
    reviews = [],
    requests = [],
    projections = [];
  let nextId = 1000,
    ref,
    owner,
    context,
    mutationCount = 0,
    interventionDone = false,
    applying = false;
  const memory = new Map();
  const store = new OversizedActivityStore({
    get: (key) => structuredClone(memory.get(key)),
    put: (key, value) => memory.set(key, structuredClone(value)),
  });
  const comment = (id, body, author = "clawsweeper[bot]") => ({
    id,
    body,
    user: { login: author, type: author.includes("bot") ? "Bot" : "User" },
    author_association: "NONE",
    html_url: `${pull.html_url}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${repo}/issues/${number}`,
    created_at: oldTime,
    updated_at: oldTime,
  });
  if (scenario.startsWith("existing")) {
    const c = comment(
      999,
      `Previous review\n<!-- clawsweeper-review-version item=${number} reviewed_at=${oldTime} sha=${head} source_revision=${"a".repeat(64)} lease_owner=old lease_comment_id=999 v=1 -->\n<!-- clawsweeper-review item=${number} -->`,
    );
    comments.push(c);
    timeline.push({ ...c, event: "commented" });
  }
  comments.push(comment(800, "@clawsweeper re-review", "synthetic-human"));
  timeline.push({ ...comments.at(-1), event: "commented" });
  pull.comments = comments.length;
  const review = {
    id: 700,
    body: "Original review body",
    submitted_at: oldTime,
    state: "COMMENTED",
    user: { login: "synthetic-reviewer" },
  };
  reviews.push(review);
  timeline.push({ ...review, event: "reviewed" });
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const c of request) chunks.push(c);
      const raw = Buffer.concat(chunks).toString();
      const input = raw ? JSON.parse(raw) : {};
      const url = new URL(request.url, "http://127.0.0.1");
      const path = url.pathname;
      requests.push({ method: request.method, path });
      const send = (value, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (path === "/internal/exact-review/heartbeat") return send({ ok: true });
      if (path === "/internal/exact-review/oversized-activity") {
        if (
          applying &&
          ((scenario === "journal-begin-unavailable" && input.operation === "begin") ||
            (scenario === "journal-complete-unavailable" && input.operation === "complete"))
        )
          return send({ error: "synthetic evidence outage" }, 503);
        if (applying && scenario === "journal-malformed-response" && input.operation === "begin") {
          response.writeHead(200);
          response.end("not-json");
          return;
        }

        if (!ref || input.reference?.epoch !== ref.epoch || !store.owns(ref, input.owner))
          return send({ ok: true, evidence: null });
        if (input.operation === "read") return send({ ok: true, evidence: store.evidence(ref) });
        if (input.operation === "begin") store.begin(ref, input.receipt);
        else if (input.operation === "complete") store.complete(ref, input.receipt);
        else return send({ error: "invalid operation" }, 400);
        return send({ ok: true, recorded: true });
      }
      if (request.method === "GET") {
        if (/\/issues\/comments\/\d+$/.test(path)) {
          const c = comments.find((c) => c.id === Number(path.split("/").at(-1)));
          return c ? send(c) : send({ error: "missing comment" }, 404);
        }
        if (path.endsWith(`/pulls/${number}`)) return send(pull);
        if (path.endsWith(`/issues/${number}`))
          return send({
            ...pull,
            pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${number}` },
          });
        const page = Number(url.searchParams.get("page") || 1),
          start = (page - 1) * 100;
        if (path.endsWith(`/issues/${number}/comments`))
          return send(comments.slice(start, start + 100));
        if (path.endsWith("/timeline")) return send(timeline.slice(start, start + 100));
        if (path.endsWith("/reviews")) return send(reviews.slice(start, start + 100));
        if (path.endsWith(`/pulls/${number}/comments`)) return send([]);
        return send({ error: "unimplemented read" }, 404);
      }
      mutationCount++;
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      let result;
      if (request.method === "POST" && path.endsWith(`/issues/${number}/comments`)) {
        result = { ...comment(nextId++, input.body), created_at: timestamp, updated_at: timestamp };
        comments.push(result);
        timeline.push({ ...result, event: "commented" });
      } else if (request.method === "PATCH" && /\/issues\/comments\/\d+$/.test(path)) {
        result = comments.find((c) => c.id === Number(path.split("/").at(-1)));
        assert.ok(result);
        result.body = input.body;
        result.updated_at = timestamp;
        Object.assign(
          timeline.find((e) => e.id === result.id),
          result,
        );
      } else if (request.method === "DELETE" && /\/issues\/comments\/\d+$/.test(path)) {
        const id = Number(path.split("/").at(-1));
        const index = comments.findIndex((c) => c.id === id);
        if (index < 0) return send({ error: "missing comment" }, 404);
        comments.splice(index, 1);
        const ti = timeline.findIndex((c) => c.id === id);
        if (ti >= 0) timeline.splice(ti, 1);
        result = {};
      } else if (
        request.method === "PATCH" &&
        path.endsWith(`/pulls/${number}`) &&
        input.state === "closed"
      ) {
        pull.state = "closed";
        result = pull;
      } else return send({ error: "unexpected mutation" }, 400);
      // Intervene after the owned status PATCH, in exactly its GitHub timestamp second.
      if (
        !interventionDone &&
        request.method === "PATCH" &&
        String(input.body || "").includes(marker)
      ) {
        interventionDone = true;
        if (scenario === "same-second-review-edit" || scenario === "late-review-edit") {
          review.body = "Human edited after baseline";
          timeline.find((e) => e.id === 700).body = review.body;
        }
        if (scenario === "late-human-comment") {
          const h = {
            ...comment(nextId++, "Human follow-up", "synthetic-human"),
            created_at: timestamp,
            updated_at: timestamp,
          };
          comments.push(h);
          timeline.push({ ...h, event: "commented" });
        }
        if (scenario === "late-label") pull.labels.push("size: accepted-large");
        if (scenario === "late-head") pull.head.sha = "c".repeat(40);
      }
      const projectedCount = comments.length;
      projections.push({
        method: request.method,
        path,
        updatedAt: timestamp,
        comments: projectedCount,
        propagationMs: 1000,
      });
      setTimeout(() => {
        pull.updated_at = timestamp;
        pull.comments = projectedCount;
      }, 1000);
      return send(result, request.method === "POST" ? 201 : 200);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: directory,
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([adapter]),
    GH_TOKEN: "synthetic-loopback",
    GITHUB_TOKEN: "",
    PROOF_HTTP_URL: origin,
    CLAWSWEEPER_OVERSIZED_PR_CLOSE_ENABLED: "true",
    CLAWSWEEPER_MAX_PR_CHANGED_LINES: "50000",
    CLAWSWEEPER_ACTION_LEDGER_DISABLED: "1",
  };
  const read = async (path) => {
    const r = await fetch(`${origin}/${path.replace(/^\//, "")}`);
    assert.equal(r.status, 200);
    return r.json();
  };
  const run = async (name, args, cli = "dist/clawsweeper.js") => {
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      output = "";
    child.stdout.on("data", (c) => {
      stdout += c;
      output += c;
    });
    child.stderr.on("data", (c) => (output += c));
    const exit = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    writeFileSync(
      join(directory, `${name}.log`),
      output
        .replaceAll(root, "<proof>")
        .replaceAll(process.cwd(), "<checkout>")
        .replaceAll(process.execPath, "<node>"),
    );
    assert.equal(exit, 0, output);
    return stdout;
  };
  try {
    ref = await store.prepare(repo, number, { head, command: marker }, read);
    assert.equal(store.evidence(ref)?.invalid, null);
    const baselineReadCount = requests.length;
    const journal = async (request, write) => {
      const before = request.method === "POST" ? null : await read(request.path);
      const intent = ownedCommentWriteIntent(request, before);
      store.begin(ref, intent);
      const result = await write();
      await new Promise((r) => setTimeout(r, 1100));
      store.complete(
        ref,
        ownedCommentWriteResult(intent, result, await read(`repos/${repo}/pulls/${number}`)),
      );
      return result;
    };
    const acknowledgementToken = store.lockAcknowledgement(ref);
    const ackId = await convergeCommandAcknowledgement({
      env: { GITHUB_API_URL: origin },
      token: Promise.resolve("synthetic"),
      decision: { targetRepo: repo, itemNumber: number, commandStatusMarker: marker },
      sourceCommentId: 800,
      journal,
    });
    store.unlockAcknowledgement(ref, acknowledgementToken);
    owner = {
      itemKey: `${repo}#${number}`,
      leaseId: "synthetic-review",
      claimGeneration: 1,
      runId: "123456789",
      runAttempt: 1,
    };
    assert.equal(store.fence(ref, owner, Date.now() + 600_000), true);
    context = {
      reference: ref,
      owner,
      queueUrl: origin,
      failurePath: join(directory, `evidence-failure-${ref.epoch}.json`),
    };
    env.CLAWSWEEPER_OVERSIZED_ACTIVITY_CONTEXT = JSON.stringify(context);
    // A late duplicate-convergence attempt must defer without touching GitHub.
    assert.equal(store.blocked(repo, number), true);
    const reservation = JSON.parse(
      await run("reserve", [
        "reserve-review-lease",
        "--target-repo",
        repo,
        "--item-number",
        String(number),
        "--review-timeout-ms",
        "60000",
      ]),
    );
    assert.equal(reservation.status, "posted");
    const admission = join(directory, "admission.json"),
      items = join(directory, "items"),
      closed = join(directory, "closed");
    writeFileSync(admission, JSON.stringify({ repo, pull, observedAt: new Date().toISOString() }));
    const beforeReview = requests.length;
    await run("review", [
      "review",
      "--target-repo",
      repo,
      "--item-number",
      String(number),
      "--pr-admission-file",
      admission,
      "--artifact-dir",
      items,
      "--skip-start-comment",
      "--review-lease-owner",
      reservation.owner,
      "--review-lease-comment-id",
      String(reservation.commentId),
    ]);
    const reviewRequests = requests.length - beforeReview;
    assert.equal(reviewRequests, 0);
    await run(
      "status",
      [
        "--repo",
        repo,
        "--item-number",
        String(number),
        "--marker",
        marker,
        "--status-comment-id",
        String(ackId),
        "--state",
        "Complete",
        "--detail",
        "Synthetic review finished",
        "--run-url",
        "https://github.com/openclaw/clawsweeper/actions/runs/123456789",
      ],
      "dist/repair/update-command-status.js",
    );
    if (scenario.endsWith("queued")) {
      await run("expire", [
        "expire-review-lease",
        "--repo",
        repo,
        "--item-number",
        String(number),
        "--comment-id",
        String(reservation.commentId),
      ]);
      store.seal(ref, owner, existsSync(context.failurePath));
      store.release(ref, owner);
      owner = {
        ...owner,
        itemKey: `${repo}#${number}@publish:123456789:1`,
        leaseId: "synthetic-publisher",
        claimGeneration: 2,
      };
      assert.equal(store.fence(ref, owner, Date.now() + 600_000), true);
      context = {
        ...context,
        owner,
        failurePath: join(directory, `publisher-evidence-failure-${ref.epoch}.json`),
      };
      env.CLAWSWEEPER_OVERSIZED_ACTIVITY_CONTEXT = JSON.stringify(context);
    }
    if (scenario.startsWith("evidence-")) {
      const file = join(items, `${number}.md`);
      let markdown = readFileSync(file, "utf8");
      if (scenario === "evidence-absent")
        markdown = markdown.replace(/^oversized_activity_reference:.*\n/m, "");
      if (scenario === "evidence-malformed")
        markdown = markdown.replace(
          /^oversized_activity_reference:.*$/m,
          "oversized_activity_reference: {broken",
        );
      if (scenario === "evidence-stale")
        markdown = markdown.replace(ref.epoch, "00000000-0000-0000-0000-000000000000");
      writeFileSync(file, markdown);
    }
    applying = true;
    await run("apply", [
      "apply-decisions",
      "--target-repo",
      repo,
      "--items-dir",
      items,
      "--closed-dir",
      closed,
      "--plans-dir",
      join(directory, "plans"),
      "--report-path",
      join(directory, "apply.json"),
      "--item-number",
      String(number),
      "--apply-kind",
      "all",
      "--min-age-minutes",
      "0",
      "--close-delay-ms",
      "0",
      "--exact-event-publication",
      "--event-apply-proof",
      "--skip-dashboard",
    ]);
    const apply = JSON.parse(readFileSync(join(directory, "apply.json"), "utf8"));
    const shouldClose = [
      "first-direct",
      "existing-direct",
      "first-queued",
      "existing-queued",
      "review-unchanged",
      "propagation-race",
    ].includes(scenario);
    assert.equal(pull.state, shouldClose ? "closed" : "open", JSON.stringify(apply));
    assert.equal(existsSync(join(closed, `${number}.md`)), shouldClose);
    if (
      shouldClose ||
      scenario.startsWith("evidence-") ||
      scenario.startsWith("journal-") ||
      ["same-second-review-edit", "late-human-comment", "late-review-edit"].includes(scenario)
    )
      assert.ok(
        apply.some((r) => r.action === "review_comment_synced"),
        JSON.stringify(apply),
      );
    const closeWrites = requests.filter(
      (r) => r.method === "PATCH" && r.path.endsWith(`/pulls/${number}`),
    ).length;
    assert.equal(closeWrites, shouldClose ? 1 : 0);
    assert.ok(requests.every((r) => !/\/(files|commits|blobs)(\/|$)/.test(r.path)));
    store.seal(ref, owner, existsSync(context.failurePath));
    store.release(ref, owner);
    assert.equal(store.blocked(repo, number), false);
    const summary = {
      scenario,
      state: pull.state,
      closeWrites,
      reviewRequests,
      baselineMetadataReads: baselineReadCount,
      metadataReads: requests.filter((r) => r.method === "GET").length,
      receiptCount: [...memory.keys()].filter((key) => key.includes(":receipt:")).length,
      githubMutations: mutationCount,
      fencedLateAcknowledgement: true,
      completed: true,
      apply,
    };
    summaries.push(summary);
    writeFileSync(
      join(directory, "trace.json"),
      JSON.stringify(
        { summary, requests, projections, evidence: store.evidence(ref), pull, comments, reviews },
        null,
        2,
      ),
    );
    console.log(JSON.stringify(summary));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
writeFileSync(join(root, "results.json"), JSON.stringify(summaries, null, 2));
console.log(
  "PASS: built CLI, queue receipt store, acknowledgement writer, delayed GitHub projection; synthetic loopback only; hydration=0 scanner=0 model=0",
);
