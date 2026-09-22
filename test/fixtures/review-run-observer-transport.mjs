import { writeSync } from "node:fs";
import { mock } from "node:test";

// Exercise the CLI's existing fetch/timer boundaries without changing its request deadline.
const mode = process.env.OBSERVER_FIXTURE_MODE;
const calls = [];
const timers = [];
let cancelledBodies = 0;
let finished = false;
const started = performance.now();
mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.UTC(2026, 8, 21) });
const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  timers.push(milliseconds);
  return schedule(callback, milliseconds, ...args);
};
for (const [stream, prefix] of [
  [process.stdout, "observed review run "],
  [process.stderr, "review-run-observer:"],
]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...args) => {
    if (String(chunk).startsWith(prefix)) finished = true;
    return write(chunk, ...args);
  };
}

function response(status, headers = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("synthetic upstream response"));
        controller.close();
      },
      cancel() {
        cancelledBodies++;
        if (mode === "ack-cleanup-failure") {
          throw Object.assign(new Error("synthetic cleanup failure"), { code: "ECONNRESET" });
        }
      },
    }),
    { status, headers },
  );
}

globalThis.fetch = async (url, init) => {
  if (init?.method !== "POST") {
    return Response.json({
      total_count: 1,
      jobs: [{ name: "Review exact event item", conclusion: "success" }],
    });
  }
  calls.push({
    url,
    body: init.body,
    signature: init.headers["x-clawsweeper-exact-review-signature"],
    at: Date.now(),
  });
  const attempt = calls.length;
  if (mode === "timeout" && attempt === 1) {
    return await new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
    );
  }
  if (mode === "reset" && attempt === 1) {
    throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
  }
  if (mode === "certificate") {
    throw new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
  }
  if (mode === "invalid") throw new TypeError("Invalid URL");
  if (mode === "exhausted") return response(503);
  if (mode === "terminal") return response(403);
  if (mode === "ack-cleanup-failure") return response(200);
  if (attempt === 1) {
    if (mode === "408") return response(408);
    if (mode === "500") return response(500);
    if (mode === "retry-seconds") return response(429, { "retry-after": "7" });
    if (mode === "retry-date")
      return response(503, { "retry-after": new Date(Date.now() + 8_000).toUTCString() });
    if (mode === "retry-cap") return response(429, { "retry-after": "120" });
    if (mode === "retry-invalid") return response(500, { "retry-after": "not-a-date" });
  }
  return response(200);
};

process.on("exit", () => {
  writeSync(
    1,
    `OBSERVER_FIXTURE ${JSON.stringify({ calls, timers, cancelledBodies, finished })}\n`,
  );
});
function advance() {
  if (finished) return;
  if (performance.now() - started > 3_000) {
    writeSync(2, "Observer fixture did not settle\n");
    process.exit(2);
  }
  mock.timers.tick(1_000);
  setImmediate(advance);
}
setImmediate(advance);
