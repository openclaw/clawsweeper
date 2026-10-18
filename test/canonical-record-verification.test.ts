import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { promisify } from "node:util";
import { verifyCanonicalRecords } from "../scripts/canonical-record-verification.ts";

const deploymentSha = "a".repeat(40);
const operatorSha = "b".repeat(40);
const planSha256 = "c".repeat(64);
const secret = "synthetic-record-verification-secret";
const options = {
  baseUrl: "http://127.0.0.1:1",
  webhookSecret: secret,
  repoSlug: "example-project",
  deploymentSha,
  operatorSha,
  planSha256,
};
const sections = ["items", "closed", "plans", "decision-packets"] as const;
function record(content: string | null = "private body 🦊", revision = 1) {
  return {
    content,
    digest: content === null ? null : createHash("sha256").update(content).digest("hex"),
    revision,
    deleted: content === null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
function fixture(
  configuration: {
    point?: unknown;
    pointStatus?: number;
    exported?: unknown;
    exportStatus?: number;
    deployment?: string;
    duplicate?: boolean;
    backfill?: boolean;
    emptyExport?: boolean;
    exportId?: string;
    count?: number;
    complete?: boolean;
    repoSlug?: string;
  } = {},
) {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const endpoint = new URL(String(input)).pathname;
    calls.push(endpoint);
    assert.equal(init?.redirect, "error");
    if (endpoint !== "/api/health") {
      const body = typeof init?.body === "string" ? init.body : "";
      assert.equal(
        new Headers(init?.headers).get("x-clawsweeper-exact-review-signature"),
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      );
    }
    if (endpoint === "/api/health" || endpoint.endsWith("admission-capabilities")) {
      return Response.json({ ok: true, deployment_sha: configuration.deployment ?? deploymentSha });
    }
    if (endpoint.endsWith("/export")) {
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(request, {
        repoSlug: configuration.repoSlug ?? options.repoSlug,
        sections: [request.sections[0]],
        sinceRevision: 0,
        cursor: 0,
        limit: 32,
      });
      const row = {
        section: request.sections[0],
        id: configuration.exportId ?? "1",
        storeRevision: 1,
        ...((configuration.exported ?? record()) as object),
      };
      return Response.json(
        {
          repoSlug: configuration.repoSlug ?? options.repoSlug,
          sections: request.sections,
          revision: 1,
          records: configuration.emptyExport
            ? []
            : configuration.duplicate
              ? [row, row]
              : Array.from({ length: configuration.count ?? 1 }, (_entry, index) => ({
                  ...row,
                  id: configuration.exportId ?? String(index + 1),
                })),
          nextCursor: configuration.complete ? null : 1,
        },
        { status: configuration.exportStatus ?? 200 },
      );
    }
    if (configuration.backfill && endpoint.includes("/plans/")) {
      return Response.json({ error: "record_not_found" }, { status: 404 });
    }
    return Response.json(configuration.point ?? record(), {
      status: configuration.pointStatus ?? 200,
    });
  };
  return { fetch, calls };
}

test("bounded baseline and recheck verify HMAC, Unicode, empty bodies and explicit export-only coverage", async () => {
  const first = fixture({ backfill: true });
  const baseline = await verifyCanonicalRecords({ ...options, fetch: first.fetch });
  assert.equal(baseline.canonicalVerified, 3);
  assert.equal(baseline.exportOnly, 1);
  assert.equal(baseline.logicalRequests, 12);
  assert.equal(first.calls.filter((call) => call.endsWith("/export")).length, 4);
  assert.ok(!JSON.stringify(baseline).includes("private body"));
  const next = fixture({ backfill: true });
  const recheck = await verifyCanonicalRecords({
    ...options,
    fetch: next.fetch,
    baselineJson: JSON.stringify(baseline),
  });
  assert.equal(recheck.canonicalVerified, 3);
  assert.equal(recheck.changed, 0);
  assert.equal(next.calls.length, 11);
  const empty = fixture({ point: record(""), exported: record("") });
  const result = await verifyCanonicalRecords({ ...options, fetch: empty.fetch });
  assert.ok(result.baseline.records.every((entry) => entry.bytes === 0));
});

test("full sample stays within 136 logical reads and round-trips bounded metadata", async () => {
  const baseline = await verifyCanonicalRecords({
    ...options,
    fetch: fixture({ count: 32 }).fetch,
  });
  assert.equal(baseline.canonicalVerified, 128);
  assert.equal(baseline.logicalRequests, 136);
  assert.ok(Buffer.byteLength(JSON.stringify(baseline)) < 64 * 1024);
  const result = await verifyCanonicalRecords({
    ...options,
    fetch: fixture({ count: 32 }).fetch,
    baselineJson: JSON.stringify(baseline),
  });
  assert.equal(result.canonicalVerified, 128);
  assert.equal(result.logicalRequests, 136);
  await assert.rejects(
    verifyCanonicalRecords({ ...options, fetch: fixture({ count: 33 }).fetch }),
    /invalid export page/,
  );
});

test("canonical repository slugs preserve case, dots and underscores", async () => {
  for (const repoSlug of ["OpenClaw-example.repo", "openclaw-example_repo"]) {
    const baseline = await verifyCanonicalRecords({
      ...options,
      repoSlug,
      fetch: fixture({ repoSlug }).fetch,
    });
    const result = await verifyCanonicalRecords({
      ...options,
      repoSlug,
      fetch: fixture({ repoSlug }).fetch,
      baselineJson: JSON.stringify(baseline),
    });
    assert.equal(result.canonicalVerified, 4);
  }
});

test("same-revision corruption, regressed revisions and missing records fail", async () => {
  const baseline = await verifyCanonicalRecords({ ...options, fetch: fixture().fetch });
  for (const configuration of [
    { point: record("changed") },
    { point: record("old", 0) },
    { point: { error: "record_not_found" }, pointStatus: 404 },
    { point: { error: "record_not_found", deleted: true }, pointStatus: 404 },
  ]) {
    await assert.rejects(
      verifyCanonicalRecords({
        ...options,
        fetch: fixture(configuration).fetch,
        baselineJson: JSON.stringify(baseline),
      }),
    );
  }
  const newer = record("new version", 2);
  const changed = await verifyCanonicalRecords({
    ...options,
    fetch: fixture({ point: newer, exported: newer }).fetch,
    baselineJson: JSON.stringify(baseline),
  });
  assert.equal(changed.changed, 4);
});

test("explicit newer point tombstones survive export-page movement; resurrection requires a new revision", async () => {
  const baseline = await verifyCanonicalRecords({ ...options, fetch: fixture().fetch });
  const tombstone = record(null, 2);
  const deleted = await verifyCanonicalRecords({
    ...options,
    fetch: fixture({
      exported: tombstone,
      point: { ...tombstone, error: "record_not_found" },
      pointStatus: 404,
    }).fetch,
    baselineJson: JSON.stringify(baseline),
  });
  assert.equal(deleted.changed, 4);
  const moved = await verifyCanonicalRecords({
    ...options,
    fetch: fixture({
      exportId: "2",
      point: { ...tombstone, error: "record_not_found" },
      pointStatus: 404,
    }).fetch,
    baselineJson: JSON.stringify(baseline),
  });
  assert.equal(moved.changed, 4);
  const resurrected = record("restored", 3);
  const result = await verifyCanonicalRecords({
    ...options,
    fetch: fixture({ point: resurrected, exported: resurrected }).fetch,
    baselineJson: JSON.stringify(deleted),
  });
  assert.equal(result.changed, 4);
});

test("regressed exports and missing baseline identities on complete pages fail independently of point reads", async () => {
  const current = record("current", 2);
  const baseline = await verifyCanonicalRecords({
    ...options,
    fetch: fixture({ count: 2, point: current, exported: current }).fetch,
  });
  await assert.rejects(
    verifyCanonicalRecords({
      ...options,
      fetch: fixture({ count: 2, point: current, exported: record("prior", 1) }).fetch,
      baselineJson: JSON.stringify(baseline),
    }),
    /record revision regressed/,
  );
  await assert.rejects(
    verifyCanonicalRecords({
      ...options,
      fetch: fixture({ exportId: "2", complete: true, point: current, exported: current }).fetch,
      baselineJson: JSON.stringify(baseline),
    }),
    /record missing from complete export/,
  );
});

test("invalid identities, baselines, page rows and deployment drift stop before proof", async () => {
  await assert.rejects(
    verifyCanonicalRecords({ ...options, repoSlug: "../escape", fetch: fixture().fetch }),
  );
  await assert.rejects(
    verifyCanonicalRecords({ ...options, fetch: fixture({ duplicate: true }).fetch }),
    /duplicate/,
  );
  await assert.rejects(
    verifyCanonicalRecords({ ...options, fetch: fixture({ deployment: "d".repeat(40) }).fetch }),
    /deployment/,
  );
  const baseline = await verifyCanonicalRecords({ ...options, fetch: fixture().fetch });
  await assert.rejects(
    verifyCanonicalRecords({
      ...options,
      fetch: fixture({ emptyExport: true }).fetch,
      baselineJson: JSON.stringify(baseline),
    }),
    /previously populated export section is empty/,
  );
  baseline.baseline.records[0]!.bytes++;
  const transport = fixture();
  await assert.rejects(
    verifyCanonicalRecords({
      ...options,
      fetch: transport.fetch,
      baselineJson: JSON.stringify(baseline),
    }),
    /checksum/,
  );
  assert.equal(transport.calls.length, 0);
});

test("redirects, failed retries, stalled bodies and oversized streams are bounded", async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: "https://example.invalid/" } }),
    () => new Response("failure", { status: 503 }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
          },
        }),
      ),
  ]) {
    let calls = 0;
    await assert.rejects(
      verifyCanonicalRecords({
        ...options,
        fetch: async () => {
          calls++;
          return response();
        },
      }),
    );
    assert.equal(calls, 1); // The unsigned identity read fails before signed retries.
  }
  const healthy = fixture();
  let signedAttempts = 0;
  await assert.rejects(
    verifyCanonicalRecords({
      ...options,
      fetch: async (input, init) => {
        if (String(input).endsWith("admission-capabilities")) {
          signedAttempts++;
          return new Response(null, { status: 503 });
        }
        return healthy.fetch(input, init);
      },
    }),
  );
  assert.equal(signedAttempts, 3);
  await assert.rejects(
    verifyCanonicalRecords({
      ...options,
      attemptMs: 10,
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              );
            },
          }),
        ),
    }),
  );
});

test("CLI exercises real loopback HTTP with metadata output and safe failure recovery", async (t) => {
  let requests = 0;
  let generation = 1;
  let failedAttempts = 0;
  const privateId = "987654321";
  let failure:
    | "deployment"
    | "missing"
    | "auth"
    | "point"
    | "http"
    | "json"
    | "invalid"
    | "transport"
    | "timeout"
    | "oversized"
    | undefined;
  const server = createServer(async (request, response) => {
    requests++;
    let body = "";
    for await (const chunk of request) body += chunk;
    const endpoint = request.url!;
    if (endpoint !== "/api/health") {
      assert.equal(
        request.headers["x-clawsweeper-exact-review-signature"],
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      );
    }
    if (failure === "transport" && endpoint.endsWith("admission-capabilities")) {
      // A prior HTTP response must not survive the final transport failure.
      if (++failedAttempts === 1) response.writeHead(503).end(secret);
      else request.socket.destroy();
      return;
    }
    if (failure === "timeout") {
      response.writeHead(200).flushHeaders();
      return;
    }
    if (
      (failure === "auth" && endpoint.endsWith("/export")) ||
      (failure === "point" && endpoint.endsWith(`/${privateId}`))
    ) {
      response.writeHead(401, { "x-private-detail": secret });
      response.end(`private body ${secret}`);
      return;
    }
    if ((failure === "http" && endpoint !== "/api/health") || failure === "json") {
      response.writeHead(failure === "http" ? 503 : 200);
      response.end(`private body ${secret}`);
      return;
    }
    if (failure === "oversized") {
      response.end(Buffer.alloc(16 * 1024 * 1024 + 1));
      return;
    }
    if (failure === "invalid") {
      response.end(JSON.stringify(secret));
      return;
    }
    let value: unknown;
    if (endpoint === "/api/health" || endpoint.endsWith("admission-capabilities")) {
      value = {
        ok: true,
        deployment_sha: failure === "deployment" ? "d".repeat(40) : deploymentSha,
      };
    } else if (endpoint.endsWith("/export")) {
      const section = JSON.parse(body).sections[0];
      assert.ok(sections.includes(section));
      value = {
        repoSlug: options.repoSlug,
        sections: [section],
        nextCursor: null,
        records: [
          {
            section,
            id: privateId,
            storeRevision: generation,
            ...record("private body 🦊", generation),
          },
        ],
      };
    } else
      value =
        failure === "missing"
          ? { error: "record_not_found", detail: secret }
          : record("private body 🦊", generation);
    response.writeHead(failure === "missing" && endpoint.includes("/items/") ? 404 : 200, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const run = async (baseline?: string, env: Record<string, string> = {}) =>
    promisify(execFile)(process.execPath, ["scripts/canonical-record-verification.ts"], {
      timeout: failure === "timeout" ? 35_000 : 10_000,
      env: {
        PATH: process.env.PATH,
        EXACT_REVIEW_QUEUE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        CLAWSWEEPER_WEBHOOK_SECRET: secret,
        EXPECTED_DEPLOYMENT_SHA: deploymentSha,
        GITHUB_SHA: operatorSha,
        REVIEWED_PLAN_SHA256: planSha256,
        VERIFICATION_EXECUTE: "true",
        VERIFICATION_PHASE: baseline ? "recheck" : "baseline",
        VERIFICATION_REPO_SLUG: options.repoSlug,
        ...(baseline ? { VERIFICATION_BASELINE: baseline } : {}),
        ...env,
      },
    });
  const before = await run();
  assert.equal(before.stderr, "");
  assert.equal(JSON.parse(before.stdout).canonicalVerified, 4);
  generation++;
  const after = await run(before.stdout);
  assert.equal(after.stderr, "");
  assert.equal(JSON.parse(after.stdout).changed, 4);
  assert.equal(requests, 24);
  assert.ok(!`${before.stdout}${after.stdout}`.includes("private body"));
  assert.ok(!`${before.stdout}${after.stdout}`.includes(secret));

  const expectFailure = async (
    baseline: string,
    category: string,
    action: RegExp,
    env = {},
    diagnostics?: Record<string, unknown>,
  ) => {
    await assert.rejects(run(baseline, env), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, new RegExp(`\\] ${category}:`));
      assert.match(result.stderr, action);
      assert.match(result.stderr, /FAILED \(exit 1\)\n$/);
      assert.ok(!result.stderr.includes("private body"));
      assert.ok(!result.stderr.includes(secret));
      assert.ok(!result.stderr.includes(privateId));
      assert.ok(!result.stderr.includes("127.0.0.1"));
      assert.ok(!result.stderr.includes("sha256="));
      const diagnostic = result.stderr
        .split("\n")
        .filter((line) => line.startsWith("[canonical-record-verification] request "));
      assert.equal(diagnostic.length, diagnostics ? 1 : 0);
      if (diagnostics) {
        assert.deepEqual(JSON.parse(diagnostic[0]!.split(" request ")[1]!), diagnostics);
      }
      return true;
    });
  };
  const tampered = JSON.parse(after.stdout);
  tampered.sha256 = "0".repeat(64);
  await expectFailure(JSON.stringify(tampered), "invalid_input", /exact saved baseline/);
  await expectFailure(after.stdout, "plan_mismatch", /newly reviewed execution plan/, {
    GITHUB_SHA: "e".repeat(40),
  });
  assert.equal(requests, 24); // Invalid inputs must fail before any authenticated read.
  failure = "deployment";
  await expectFailure(after.stdout, "plan_mismatch", /newly reviewed execution plan/);
  failure = "missing";
  await expectFailure(after.stdout, "record_mismatch", /investigate record preservation/);
  for (const [mode, diagnostics] of [
    ["http", { stage: "admission", status: 503, attempts: 3, failureKind: "http_status" }],
    ["auth", { stage: "export", status: 401, attempts: 1, failureKind: "http_status" }],
    ["point", { stage: "point", status: 401, attempts: 1, failureKind: "http_status" }],
    ["json", { stage: "health", status: 200, attempts: 1, failureKind: "invalid_json" }],
    ["transport", { stage: "admission", status: null, attempts: 3, failureKind: "transport" }],
    ["timeout", { stage: "health", status: 200, attempts: 1, failureKind: "timeout" }],
  ] as const) {
    failure = mode;
    await expectFailure(
      after.stdout,
      "request_failed",
      /check service access, availability and response validity/,
      {},
      diagnostics,
    );
  }
  assert.equal(failedAttempts, 3);
  failure = "invalid";
  await expectFailure(
    after.stdout,
    "record_mismatch",
    /investigate record preservation/,
    {},
    {
      stage: "health",
      status: 200,
      attempts: 1,
      failureKind: "invalid_response",
    },
  );
  failure = "oversized";
  await expectFailure(
    after.stdout,
    "read_limit",
    /review the bounded read plan/,
    {},
    {
      stage: "health",
      status: 200,
      attempts: 1,
      failureKind: "read_limit",
    },
  );
});
