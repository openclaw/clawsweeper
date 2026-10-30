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
  "retention-complete",
  "retention-capped",
  "retention-wrong-time",
  "retention-bad-rows",
  "retention-bad-bytes",
  "retention-missing",
  "retention-bad-cursor",
  "retention-missing-column",
  "retention-zero-rows",
] as const) {
  test(`storage census runner: ${scenario}`, async (t) => {
    const retention = scenario.startsWith("retention-");
    const outcome = scenario.replace(/^retention-/, "");
    const requests: Record<string, unknown>[] = [];
    const secret = "synthetic-secret";
    const asOf = 1_800_000_000_000;
    const firstRows = retention ? 64 : 128;
    const frontier = retention
      ? { afterRowid: 64, upperRowid: 65, retention: true, asOf }
      : { afterRowid: 256, upperRowid: 300 };
    const column = retention && outcome !== "missing-column" ? "snapshot_json" : "body";
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      assert.equal(
        request.headers["x-clawsweeper-exact-review-signature"],
        `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      );
      const input = JSON.parse(raw).census;
      requests.push(input);
      if (outcome === "http-failure" && requests.length === 2) {
        response.writeHead(503);
        response.end("failure");
        return;
      }
      if (outcome === "redirect" && requests.length === 2) {
        response.writeHead(307, { location: "/unexpected" });
        response.end();
        return;
      }
      const first = requests.length === 1;
      if (retention) {
        assert.equal(input.retention, true);
        if (!first) assert.equal(input.asOf, asOf);
      }
      const rows = first ? firstRows : 1;
      const bytes = retention || first ? rows * 2 : 3;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          databaseBytes: 4096,
          census: {
            table: retention ? "github_webhook_read_model_comments_v1" : "sample",
            afterRowid: input.afterRowid ?? 0,
            upperRowid: frontier.upperRowid,
            scannedRows: rows,
            columns: { [column]: bytes, n: 0 },
            complete: !first && outcome !== "stalled-cursor",
            nextCursor: first
              ? { ...frontier, ...(outcome === "bad-cursor" ? { retention: false } : {}) }
              : outcome === "stalled-cursor"
                ? frontier
                : null,
            ...(retention && !(!first && outcome === "missing")
              ? {
                  retention: {
                    asOf: !first && outcome === "wrong-time" ? asOf + 1 : asOf,
                    eligibleRows:
                      outcome === "zero-rows"
                        ? 0
                        : !first && outcome === "bad-rows"
                          ? rows + 1
                          : rows,
                    eligibleStoredBytes: !first && outcome === "bad-bytes" ? bytes + 1 : bytes,
                  },
                }
              : {}),
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
            STORAGE_CENSUS_TABLE: retention ? "github_webhook_read_model_comments_v1" : "sample",
            ...(retention ? { STORAGE_CENSUS_CURSOR: '{"retention":true}' } : {}),
            STORAGE_CENSUS_MAX_PAGES: outcome === "capped" ? "1" : "3",
            CLAWSWEEPER_WEBHOOK_SECRET: secret,
            EXACT_REVIEW_QUEUE_URL: `http://127.0.0.1:${address.port}`,
          },
        },
      ));
    } catch (error) {
      failed = true;
      stdout = (error as { stdout: string }).stdout;
    }
    assert.equal(failed, !["complete", "capped"].includes(outcome));
    if (["bad-cursor", "missing-column", "zero-rows"].includes(outcome)) {
      assert.equal(stdout, "");
      assert.equal(requests.length, 1);
      return;
    }
    const result = JSON.parse(stdout);
    const rows = firstRows + (outcome === "complete" ? 1 : 0);
    const bytes = outcome === "complete" ? firstRows * 2 + (retention ? 2 : 3) : firstRows * 2;
    assert.equal(result.scannedRows, rows);
    assert.equal(result.columns[column], bytes);
    assert.equal(result.complete, outcome === "complete");
    assert.equal(requests.length, outcome === "capped" ? 1 : 2);
    if (retention)
      assert.deepEqual(result.retention, { asOf, eligibleRows: rows, eligibleStoredBytes: bytes });
    if (outcome !== "complete") assert.deepEqual(result.nextCursor, frontier);
  });
}
