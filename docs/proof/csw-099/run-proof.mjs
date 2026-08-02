import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const outputDir = path.resolve(process.env.CSW_099_PROOF_OUTPUT || "docs/proof/csw-099/artifacts");
const port = Number(process.env.CSW_099_PROOF_PORT || 8799);
const origin = `http://127.0.0.1:${port}`;
await mkdir(outputDir, { recursive: true });

const inventory = JSON.parse(await readFile(path.join(outputDir, "worker-inventory.json"), "utf8"));
const publicProbeStatus = Number(
  await readFile(path.join(outputDir, "public-probe-status.txt"), "utf8"),
);
const rejectedStatus = Number(
  await readFile(path.join(outputDir, "shared-secret-status.txt"), "utf8"),
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
const requests = [];
context.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));

try {
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await page.goto(`${origin}/bay-demo`, { waitUntil: "networkidle" });
  await page.screenshot({
    path: path.join(outputDir, "public-bay-separation.jpg"),
    type: "jpeg",
    quality: 88,
  });
} finally {
  await context.tracing.stop({ path: path.join(outputDir, "trace.zip") });
  await context.close();
  await browser.close();
}

const snapshot = inventory.exact_review_lifecycle_audit_inventory;
const assertions = [
  {
    name: "signed local Worker operator request returns a complete empty bounded snapshot",
    passed:
      snapshot?.collection?.state === "complete" &&
      snapshot?.snapshot?.total_records === 0 &&
      snapshot?.page?.returned === 0 &&
      snapshot?.page?.next_cursor === null,
  },
  {
    name: "shared webhook secret cannot access the operator route",
    passed: rejectedStatus === 401,
  },
  {
    name: "there is no public audit inventory route",
    passed: publicProbeStatus === 404,
  },
  {
    name: "public Bay browser traffic does not invoke the admin inventory route",
    passed: requests.every((request) => !request.url.includes("lifecycle-audit/inventory")),
  },
  {
    name: "public Bay browser traffic is read-only",
    passed: requests.every((request) => ["GET", "HEAD"].includes(request.method)),
  },
];
if (!assertions.every((assertion) => assertion.passed)) {
  throw new Error(
    `proof failed: ${assertions
      .filter((assertion) => !assertion.passed)
      .map((a) => a.name)
      .join(", ")}`,
  );
}

const summary = {
  schema_version: 1,
  source_sha: process.env.SOURCE_SHA || "unknown",
  source_tree_sha256: process.env.SOURCE_TREE_SHA || "unknown",
  worker: {
    endpoint: "POST /internal/exact-review/lifecycle-audit/inventory",
    collection: snapshot.collection,
    snapshot: snapshot.snapshot,
    page: snapshot.page,
    shared_secret_status: rejectedStatus,
    public_probe_status: publicProbeStatus,
  },
  browser: {
    request_count: requests.length,
    mutating_requests: requests.filter((request) => !["GET", "HEAD"].includes(request.method)),
    admin_route_requests: requests.filter((request) =>
      request.url.includes("lifecycle-audit/inventory"),
    ),
  },
  assertions,
};
await writeFile(
  path.join(outputDir, "proof-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  path.join(outputDir, "runtime-transcript.md"),
  `# CSW-099 controlled runtime transcript\n\n- Real local Wrangler Worker: signed operator request returned \`${snapshot.collection.state}\` with ${snapshot.snapshot.total_records} disposable lifecycle records.\n- Shared webhook signature: HTTP ${rejectedStatus}.\n- Guessed public endpoint: HTTP ${publicProbeStatus}.\n- Browser: ${requests.length} Bay requests, ${summary.browser.mutating_requests.length} mutating, ${summary.browser.admin_route_requests.length} admin-route requests.\n\nThe test fixture separately proves pagination, frozen snapshots, redaction, source failure, and expiry. This runtime trace uses no production data or secrets.\n`,
);
