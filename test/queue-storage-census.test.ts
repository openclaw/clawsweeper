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

for (const scenario of [
  "complete",
  "capped",
  "wrong-time",
  "bad-total",
  "missing",
  "bad-cursor",
] as const) {
  test(`storage retention census runner: ${scenario}`, async (t) => {
    const categories = [
      "retired",
      "tombstone",
      "placeholder_comment",
      "placeholder_parent",
      "stale_protection",
      "active_family",
      "idle_future_deadline",
      "due_eligible",
    ];
    const asOf = 1_800_000_000_000;
    let requests = 0;
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw).census;
      assert.equal(
        request.headers["x-clawsweeper-exact-review-signature"],
        `sha256=${createHmac("sha256", "synthetic-secret").update(raw).digest("hex")}`,
      );
      assert.equal(input.retention, true);
      const first = ++requests === 1;
      if (!first) assert.equal(input.asOf, asOf);
      const rows = first ? 64 : 1;
      const retention = {
        asOf: !first && scenario === "wrong-time" ? asOf + 1 : asOf,
        categories: Object.fromEntries(
          categories.map((category) => [
            category,
            {
              rows: category === "due_eligible" ? rows : 0,
              bytes: category === "due_eligible" ? rows * 2 : 0,
            },
          ]),
        ),
      };
      if (!first && scenario === "bad-total") retention.categories.due_eligible.rows++;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          databaseBytes: 4096,
          census: {
            table: "github_webhook_read_model_comments_v1",
            afterRowid: input.afterRowid ?? 0,
            upperRowid: 65,
            scannedRows: rows,
            columns: { snapshot_json: rows * 2 },
            complete: !first,
            nextCursor: first
              ? {
                  afterRowid: 64,
                  upperRowid: 65,
                  retention: scenario === "bad-cursor" ? false : true,
                  asOf,
                }
              : null,
            ...(!first && scenario === "missing" ? {} : { retention }),
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address() as import("node:net").AddressInfo;
    let stdout = "",
      failed = false;
    try {
      ({ stdout } = await promisify(execFile)(
        process.execPath,
        ["scripts/queue-storage-census.mjs"],
        {
          timeout: 5000,
          env: {
            PATH: process.env.PATH,
            STORAGE_CENSUS_TABLE: "github_webhook_read_model_comments_v1",
            STORAGE_CENSUS_CURSOR: '{"retention":true}',
            STORAGE_CENSUS_MAX_PAGES: scenario === "capped" ? "1" : "3",
            CLAWSWEEPER_WEBHOOK_SECRET: "synthetic-secret",
            EXACT_REVIEW_QUEUE_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      ));
    } catch (error) {
      failed = true;
      stdout = (error as { stdout: string }).stdout;
    }
    assert.equal(failed, !["complete", "capped"].includes(scenario));
    if (scenario === "bad-cursor") {
      assert.equal(stdout, "");
      return;
    }
    const result = JSON.parse(stdout);
    const rows = scenario === "complete" ? 65 : 64;
    assert.equal(result.scannedRows, rows);
    assert.equal(result.columns.snapshot_json, rows * 2);
    assert.equal(result.retention.asOf, asOf);
    assert.deepEqual(result.retention.categories.due_eligible, { rows, bytes: rows * 2 });
    if (scenario !== "complete")
      assert.deepEqual(result.nextCursor, {
        afterRowid: 64,
        upperRowid: 65,
        retention: true,
        asOf,
      });
  });
}
