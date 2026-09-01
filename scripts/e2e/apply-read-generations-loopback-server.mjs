import http from "node:http";

const reviewedHead = "a".repeat(40);
const state = {
  head: reviewedHead,
  comments: [],
  counts: {},
};

function count(path) {
  state.counts[path] = (state.counts[path] ?? 0) + 1;
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (url.pathname === "/reset") {
        state.head = reviewedHead;
        state.comments = [];
        state.counts = {};
        return json(response, 200, { ok: true });
      }
      if (url.pathname === "/mutate") {
        const mutation = JSON.parse(body || "{}");
        if (typeof mutation.head === "string") state.head = mutation.head;
        if (Array.isArray(mutation.comments)) state.comments = mutation.comments;
        return json(response, 200, { ok: true });
      }
      return json(response, 404, { error: "not found" });
    });
    return;
  }

  if (url.pathname === "/counts") return json(response, 200, state.counts);
  count(url.pathname);
  if (url.pathname === "/issue") {
    return json(response, 200, {
      number: 42,
      title: "Generation proof",
      state: "open",
      comments: state.comments.length,
    });
  }
  if (url.pathname === "/pull") {
    return json(response, 200, {
      number: 42,
      updated_at: "2026-08-13T00:00:00Z",
      changed_files: 1,
      commits: 1,
      review_comments: 1,
      head: { sha: state.head },
    });
  }
  if (url.pathname === "/comments") return json(response, 200, state.comments);
  if (url.pathname === "/timeline") return json(response, 200, []);
  if (url.pathname === "/reviews") return json(response, 200, []);
  if (url.pathname === "/files") {
    return json(response, 200, [
      {
        filename: "src/example.ts",
        previous_filename: null,
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ]);
  }
  if (url.pathname === "/commits") {
    return json(response, 200, [
      {
        sha: "b".repeat(40),
        author: { login: "contributor" },
        commit: { message: "proof", author: { name: "Contributor" } },
      },
    ]);
  }
  if (url.pathname === "/inline-comments") {
    return json(response, 200, [
      {
        id: 901,
        user: { login: "reviewer" },
        author_association: "CONTRIBUTOR",
        html_url: "https://example.invalid/discussion/901",
        created_at: "2026-08-13T00:00:00Z",
        updated_at: "2026-08-13T00:00:00Z",
        body: "proof",
        pull_request_review_id: 801,
        path: "src/example.ts",
        line: 1,
        side: "RIGHT",
        commit_id: reviewedHead,
      },
    ]);
  }
  if (url.pathname === "/activity") {
    return json(response, 200, { revision: `sha256:${"1".repeat(64)}` });
  }
  return json(response, 404, { error: "not found" });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback address");
  process.stdout.write(`${address.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
