import http from "node:http";

const port = Number(process.env.PROOF_GITHUB_MOCK_PORT || 8790);
let latestDispatch = null;
const requests = [];

async function requestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  requests.push(`${request.method} ${url.pathname}`);
  if (requests.length > 40) requests.shift();

  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, { ok: true });
  }
  if (request.method === "GET" && url.pathname === "/proof/latest-dispatch") {
    return latestDispatch
      ? json(response, 200, latestDispatch)
      : json(response, 404, { error: "dispatch_pending" });
  }
  if (request.method === "GET" && url.pathname === "/proof/requests") {
    return json(response, 200, { requests });
  }
  if (request.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(url.pathname)) {
    return json(response, 200, { id: 1 });
  }
  if (request.method === "POST" && url.pathname === "/app/installations/1/access_tokens") {
    return json(response, 201, { token: "phase0-5-loopback-token" });
  }
  if (
    request.method === "GET" &&
    url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml"
  ) {
    return json(response, 200, { state: "active" });
  }
  if (request.method === "GET" && url.pathname === "/repos/openclaw/openclaw/issues/990002") {
    return json(response, 200, { state: "open" });
  }
  if (request.method === "POST" && url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
    const payload = await requestJson(request);
    latestDispatch = payload.client_payload || null;
    response.writeHead(204);
    return response.end();
  }

  return json(response, 404, { error: "unexpected_proof_route", path: url.pathname });
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ ok: true, port }));
});
