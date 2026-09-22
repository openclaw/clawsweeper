import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const repo = "fixture/repository";
const issuePath = `repos/${repo}/issues/123`;
const commentsPath = `${issuePath}/comments`;

if (process.argv.includes("--server")) {
  let comments = [];
  let declaredCount;
  let requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const send = (value) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/reset") {
      const count = Number(url.searchParams.get("count"));
      declaredCount = url.searchParams.has("unknown") ? undefined : count;
      comments = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        body: `Comment ${index + 1}`,
        user: { login: "contributor" },
        author_association: "NONE",
        created_at: "2026-09-21T00:00:00Z",
        updated_at: "2026-09-21T00:00:00Z",
      }));
      requests = [];
      return send({ ok: true });
    }
    if (url.pathname === "/counts") return send(requests);
    if (url.pathname === "/edit") {
      comments[Math.floor(comments.length / 2)].body = "Changed middle comment";
      return send({ ok: true });
    }
    requests.push(url.pathname + url.search);
    if (url.pathname === `/${issuePath}`) {
      return send({
        number: 123,
        title: "Comment hydration proof",
        body: "Synthetic issue",
        state: "open",
        locked: false,
        user: { login: "contributor" },
        author_association: "NONE",
        labels: [],
        comments: declaredCount,
      });
    }
    if (url.pathname === `/${commentsPath}`) {
      const page = Number(url.searchParams.get("page") || 1);
      return send(comments.slice((page - 1) * 100, page * 100));
    }
    response.statusCode = 404;
    send({ error: "unexpected proof route" });
  });
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
} else {
  const { createGitHubContext } = await import("../../dist/clawsweeper-github-context.js");
  const { createItemContext } = await import("../../dist/clawsweeper-item-context.js");
  const { LiveReadGeneration, generationReadKey } =
    await import("../../dist/live-read-generation.js");
  const { asRecord } = await import("../../dist/clawsweeper-item-policy.js");
  const { hydration, sourceTools, sha256 } = await import("../../test/primary-body-fixture.ts");
  const baseline = process.argv.includes("--baseline");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--server"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = Number(String((await once(child.stdout, "data"))[0]).trim());
  assert.ok(port > 0);
  const base = `http://127.0.0.1:${port}`;
  const get = (path) =>
    JSON.parse(
      execFileSync("curl", ["-fsS", "--max-time", "10", `${base}/${path}`], {
        encoding: "utf8",
      }),
    );
  // Use the CI publication pagination path with synthetic, loopback-only transport.
  process.env.EXACT_EVENT_PUBLICATION = "true";
  process.env.EXACT_REVIEW_QUEUE_URL = base;
  process.env.CLAWSWEEPER_WEBHOOK_SECRET = "synthetic-loopback-only";
  const github = createGitHubContext({
    ghJson: (args) => get(args[1]),
    ghWithRetry: () => {
      throw new Error("unexpected transport");
    },
    targetRepo: () => repo,
  });
  const empty = { items: [], total: 0, hydrated: 0, truncated: false };
  const { collectItemContext } = createItemContext({
    ...hydration,
    ...sourceTools,
    ...github,
    asRecord,
    sha256,
    stringOrUndefined: (value) => (typeof value === "string" ? value : undefined),
    targetRepo: () => repo,
    ghJson: (args) => get(args[1]),
    ghPagedLinkHeaderContextWindow: () => empty,
    closingPullRequestsForIssue: () => [],
    referencingMergedPullRequestsForIssue: () => [],
    relatedItemsContext: () => [],
  });
  const target = {
    repo,
    number: 123,
    kind: "issue",
    title: "Comment hydration proof",
    url: "https://github.com/fixture/repository/issues/123",
    createdAt: "2026-09-21T00:00:00Z",
    updatedAt: "2026-09-21T00:00:00Z",
    author: "contributor",
    authorAssociation: "NONE",
    labels: [],
  };
  const output = { mode: baseline ? "baseline" : "candidate", scenarios: [] };
  try {
    for (const [count, unknown] of [
      [0, false],
      [10, false],
      [40, false],
      [250, false],
      [40, true],
    ]) {
      get(`reset?count=${count}${unknown ? "&unknown=1" : ""}`);
      const generation = new LiveReadGeneration();
      const options = { liveReadGeneration: generation };
      const context = collectItemContext(target, options);
      const readComments = () =>
        generation.read(generationReadKey("paged", [commentsPath]), () =>
          github.ghPaged(commentsPath),
        );
      const complete = readComments();
      assert.equal(complete.length, count);
      assert.equal(
        context.sourceRevision,
        sourceTools.itemSourceRevisionSha256(get(issuePath), complete),
      );
      const retained = context.comments.filter((comment) => typeof comment.id === "number");
      const expected =
        !unknown && count > 24 ? [...complete.slice(0, 12), ...complete.slice(-12)] : complete;
      // Unknown counts retain all comments before the existing prompt compactor.
      const compacted = hydration.compactMappedWindow(
        expected,
        expected.length,
        24,
        hydration.compactComment,
      );
      assert.deepEqual(context.comments, compacted);
      assert.ok(retained.length <= 24);
      const requests = get("counts");
      const commentReads = requests.filter((path) => path.startsWith(`/${commentsPath}?`)).length;
      const expectedReads =
        count === 0
          ? 1
          : baseline && !unknown
            ? count > 100
              ? 5
              : 2
            : Math.floor(count / 100) + 1;
      assert.equal(commentReads, expectedReads);
      const row = {
        count,
        unknown,
        comment_reads: commentReads,
        source_revision: context.sourceRevision,
      };
      if (count > 24) {
        get("edit");
        assert.equal(collectItemContext(target, options).sourceRevision, context.sourceRevision);
        const fresh = collectItemContext(target, { ...options, bypassGenerationCache: true });
        assert.notEqual(fresh.sourceRevision, context.sourceRevision);
        assert.equal(collectItemContext(target, options).sourceRevision, context.sourceRevision);
        generation.invalidate();
        assert.equal(collectItemContext(target, options).sourceRevision, fresh.sourceRevision);
        row.middle_edit_detected_after_bypass_and_invalidation = true;
      }
      output.scenarios.push(row);
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    child.kill();
    await once(child, "exit");
  }
}
