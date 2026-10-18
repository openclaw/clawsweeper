import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";

for (const scenario of [
  "complete",
  "capped",
  "http-failure",
  "stalled-cursor",
  "redirect",
] as const) {
  test(`storage census runner: ${scenario}`, async (t) => {
    const requests: Record<string, unknown>[] = [];
    const secret = "synthetic-secret";
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      assert.equal(
        request.headers["x-clawsweeper-exact-review-signature"],
        `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      );
      const input = JSON.parse(raw).census;
      requests.push(input);
      if (scenario === "http-failure" && requests.length === 2) {
        response.writeHead(503);
        response.end("failure");
        return;
      }
      if (scenario === "redirect" && requests.length === 2) {
        response.writeHead(307, { location: "/unexpected" });
        response.end();
        return;
      }
      const first = requests.length === 1;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          databaseBytes: 4096,
          census: {
            table: "sample",
            afterRowid: input.afterRowid ?? 0,
            upperRowid: 300,
            scannedRows: first ? 128 : 1,
            columns: { body: first ? 256 : 3, n: 0 },
            complete: !first && scenario !== "stalled-cursor",
            nextCursor: first
              ? { afterRowid: 256, upperRowid: 300 }
              : scenario === "stalled-cursor"
                ? { afterRowid: 256, upperRowid: 300 }
                : null,
            semantics: "observed TEXT/BLOB bytes",
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address() as import("node:net").AddressInfo;
    let stdout = "";
    let failed = false;
    try {
      ({ stdout } = await promisify(execFile)(
        process.execPath,
        ["scripts/queue-storage-census.mjs"],
        {
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            STORAGE_CENSUS_TABLE: "sample",
            STORAGE_CENSUS_MAX_PAGES: scenario === "capped" ? "1" : "3",
            CLAWSWEEPER_WEBHOOK_SECRET: secret,
            EXACT_REVIEW_QUEUE_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      ));
    } catch (error) {
      failed = true;
      stdout = (error as { stdout: string }).stdout;
    }
    assert.equal(failed, ["http-failure", "stalled-cursor", "redirect"].includes(scenario));
    const result = JSON.parse(stdout);
    assert.equal(result.scannedRows, scenario === "complete" ? 129 : 128);
    assert.equal(result.columns.body, scenario === "complete" ? 259 : 256);
    assert.equal(result.complete, scenario === "complete");
    assert.equal(requests.length, scenario === "capped" ? 1 : 2);
    if (scenario !== "complete")
      assert.deepEqual(result.nextCursor, { afterRowid: 256, upperRowid: 300 });
  });
}
