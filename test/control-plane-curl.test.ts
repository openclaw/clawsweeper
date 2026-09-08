import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const helper = resolve("scripts/control-plane-curl.sh");

test("control-plane curl preserves final output and bounded retry semantics over HTTP", async (t) => {
  for (const scenario of [
    { name: "503 then 200", statuses: [503, 503, 200], retryAfter: "1", waits: [1, 1], final: 200 },
    { name: "400 is terminal", statuses: [400], waits: [], final: 400 },
    { name: "429 is terminal", statuses: [429], retryAfter: "1", waits: [], final: 429 },
    { name: "exhausted 5xx", statuses: [500, 502, 503, 504], waits: [2, 4, 8], final: 504 },
    {
      name: "retry-after seconds capped",
      statuses: [503, 200],
      retryAfter: "120",
      waits: [60],
      final: 200,
    },
    {
      name: "retry-after date capped",
      statuses: [503, 200],
      retryAfter: new Date(Date.now() + 120_000).toUTCString(),
      waits: [60],
      final: 200,
    },
    {
      name: "invalid retry-after",
      statuses: [503, 200],
      retryAfter: "invalid",
      waits: [2],
      final: 200,
    },
    { name: "connection reset", statuses: [0, 200], waits: [2], final: 200 },
    { name: "HTTP/2 transport error", statuses: [200], waits: [2], final: 200, transportExit: 16 },
    { name: "HTTP/2 stream reset", statuses: [200], waits: [2], final: 200, transportExit: 92 },
    {
      name: "fail exit preserved",
      statuses: [503, 503, 503, 503],
      waits: [2, 4, 8],
      final: 503,
      fail: true,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "control-plane-curl-"));
      const requests: string[] = [];
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requests.push(body);
        const code = scenario.statuses[requests.length - 1] ?? 500;
        if (!code) {
          req.socket.destroy();
          return;
        }
        res.writeHead(code, {
          "content-type": "application/json",
          ...(scenario.retryAfter ? { "retry-after": scenario.retryAfter } : {}),
        });
        res.end(JSON.stringify({ attempt: requests.length }));
      });
      await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      try {
        const result = await execute(
          "bash",
          [
            "-c",
            `
source "$HELPER"
${
  scenario.transportExit
    ? `calls=0
curl() { calls=$((calls + 1)); if [ "$calls" = 1 ]; then return ${scenario.transportExit}; fi; command curl "$@"; }`
    : ""
}
sleep() { printf '%s\\n' "$1" >> "$WAITS"; }
rc=0
control_plane_curl --silent --show-error ${scenario.fail ? "--fail" : ""} --max-time 2 --request POST --data-binary 'same signed bytes' --output "$BODY" --write-out '%{http_code}' "$URL" || rc=$?
printf '\\nexit=%s\\n' "$rc"
`,
          ],
          {
            env: {
              ...process.env,
              PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
              HELPER: helper,
              WAITS: join(root, "waits"),
              BODY: join(root, "body"),
              URL: `http://127.0.0.1:${address.port}/enqueue`,
            },
          },
        );
        assert.equal(result.stdout, `${scenario.final}\nexit=${scenario.fail ? 22 : 0}\n`);
        assert.equal(requests.length, scenario.statuses.length);
        assert.ok(requests.every((body) => body === "same signed bytes"));
        assert.equal(
          (result.stderr.match(/::notice::Control-plane request attempt/g) ?? []).length,
          requests.length + (scenario.transportExit ? 1 : 0),
        );
        const waits = await readFile(join(root, "waits"), "utf8").catch(() => "");
        assert.deepEqual(waits.trim() ? waits.trim().split("\n").map(Number) : [], scenario.waits);
        if (!scenario.fail)
          assert.deepEqual(JSON.parse(await readFile(join(root, "body"), "utf8")), {
            attempt: requests.length,
          });
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
