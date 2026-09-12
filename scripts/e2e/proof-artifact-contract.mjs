import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { proofFixture, replaceProofEvidence } from "../../test/helpers/command-proof-fixtures.ts";
import { readReviewProofZip } from "../../dashboard/review-proof-zip.ts";

const require = createRequire(resolve(process.argv[2], "package.json"));
const { build } = require("esbuild");
const { Miniflare } = require("miniflare");
const base = process.argv[3];
assert.match(base ?? "", /^[a-f0-9]{40}$/);
const root = process.cwd();
const output = resolve(".artifacts/proof-artifact-contract");
mkdirSync(output, { recursive: true });
let fixture = proofFixture("d".repeat(64), "telegram-bot-e2e-proof");
const planSha256 = "f".repeat(64);
const files = await readReviewProofZip(fixture.evidenceArchive);
fixture = replaceProofEvidence(
  fixture,
  new Map(
    [...files].map(([name, bytes]) => [
      name,
      Buffer.from(
        JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes)), plan_sha256: planSha256 }),
      ),
    ]),
  ),
);
fixture.live.pull.base.repo = fixture.live.repository;
const payload = {
  record: {
    requestId: fixture.claim.requestId,
    scenario: fixture.claim.scenario,
    proofPlan: {},
    planSha256,
    createdAt: Date.now(),
    expiresAt: Date.now() + 120_000,
    state: "pending",
    runId: "300",
    producer: { ...fixture.claim, workflowRef: "main" },
  },
  target: {
    repository: fixture.claim.repository,
    pullRequest: 42,
    headSha: fixture.claim.headSha,
    targetBranch: "main",
  },
  fixture: {
    ...fixture,
    evidenceArchive: [...fixture.evidenceArchive],
    receiptArchive: [...fixture.receiptArchive],
  },
};
const workerEntry = `
import { trustedRun, trustedArtifact } from './dashboard/review-proof-artifacts.ts';
import { executeReviewProof } from './dashboard/review-proof-execution.ts';
export class ProofStore {
  constructor(ctx) { this.storage = ctx.storage; }
  async fetch(request) {
    const { record, target, fixture } = await request.json();
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS proof (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    const rows = [...this.storage.sql.exec('SELECT body FROM proof WHERE id = 1')];
    const current = rows.length ? JSON.parse(rows[0].body) : record;
    const operations = [];
    const result = await executeReviewProof({
      record: current, target, dispatch: false,
      github: async path => {
        if(path.endsWith('/pulls/42')) return fixture.live.pull;
        if(path.endsWith('/actions/runs/300')) return fixture.run;
        if(path.endsWith('/jobs?per_page=100')) return fixture.jobs;
        if(path.endsWith('/artifacts?per_page=100')) return { total_count: 2, artifacts: [fixture.receiptArtifact, fixture.evidenceArtifact] };
        throw Error('Unexpected fixture path');
      },
      artifact: async id => new Uint8Array(id === '400' ? fixture.evidenceArchive : fixture.receiptArchive),
      update: async patch => {
        operations.push(patch.operation || patch.state);
        const saved = patch.operation === 'confirm_completed' ? current : {...current, ...patch};
        this.storage.sql.exec('INSERT OR REPLACE INTO proof VALUES (1, ?)', JSON.stringify(saved));
        return { ok: true, record: saved };
      },
    });
    return Response.json({ result, operations });
  }
}
export default { async fetch(request, env) {
  if(new URL(request.url).pathname === '/execute') return env.PROOF.get(env.PROOF.idFromName('fixture')).fetch(request);
  const {claim, run, artifact, bytes, name} = await request.json();
  return Response.json({ run: trustedRun(claim, run), artifact: await trustedArtifact(artifact, new Uint8Array(bytes), claim, run, name) });
} };`;
const cases = [
  {
    label: "valid",
    run: fixture.run,
    artifact: fixture.receiptArtifact,
    bytes: fixture.receiptArchive,
    expected: { run: true, artifact: true },
  },
  {
    label: "rerun",
    run: { ...fixture.run, run_attempt: 2 },
    artifact: fixture.receiptArtifact,
    bytes: fixture.receiptArchive,
    expected: { run: false, artifact: true },
  },
  {
    label: "wrong-producer",
    run: fixture.run,
    artifact: {
      ...fixture.receiptArtifact,
      workflow_run: { ...fixture.receiptArtifact.workflow_run, head_repository_id: 124 },
    },
    bytes: fixture.receiptArchive,
    expected: { run: true, artifact: false },
  },
  {
    label: "expired",
    run: fixture.run,
    artifact: { ...fixture.receiptArtifact, expired: true },
    bytes: fixture.receiptArchive,
    expected: { run: true, artifact: false },
  },
  {
    label: "corrupt-bytes",
    run: fixture.run,
    artifact: fixture.receiptArtifact,
    bytes: Buffer.alloc(fixture.receiptArchive.length),
    expected: { run: true, artifact: false },
  },
];
const observations = [];
try {
  for (const variant of ["base", "candidate"]) {
    const plugins =
      variant === "base"
        ? [
            {
              name: "baseline",
              setup(builder) {
                builder.onLoad({ filter: /\/(src|dashboard)\/.*\.ts$/ }, (args) => ({
                  contents: execFileSync("git", ["show", `${base}:${relative(root, args.path)}`], {
                    encoding: "utf8",
                    maxBuffer: 16 * 1024 * 1024,
                  }),
                  loader: "ts",
                }));
              },
            },
          ]
        : [];
    const nodeBundle = await build({
      entryPoints: ["src/repair/proof-receipt-verification.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      packages: "external",
      plugins,
    });
    const nodePath = resolve(output, `${variant}.mjs`);
    writeFileSync(nodePath, nodeBundle.outputFiles[0].text);
    const node = await import(pathToFileURL(nodePath));
    const workerBundle = await build({
      stdin: {
        contents: workerEntry,
        sourcefile: "proof-worker.ts",
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2024",
      plugins,
    });
    const runtime = new Miniflare({
      modules: true,
      script: workerBundle.outputFiles[0].text,
      compatibilityDate: "2026-05-11",
      durableObjects: { PROOF: { className: "ProofStore", useSQLite: true } },
      outboundService: () => {
        throw Error("External network forbidden");
      },
    });
    try {
      const matrix = [];
      for (const sample of cases) {
        const name = fixture.receiptArtifact.name;
        const nodeResult = {
          run: node.trustedRun(fixture.claim, sample.run),
          artifact: node.trustedArtifact(
            sample.artifact,
            sample.bytes,
            fixture.claim,
            sample.run,
            name,
          ),
        };
        const response = await runtime.dispatchFetch("https://proof/metadata", {
          method: "POST",
          body: JSON.stringify({
            claim: fixture.claim,
            run: sample.run,
            artifact: sample.artifact,
            bytes: [...sample.bytes],
            name,
          }),
        });
        assert.equal(response.status, 200);
        const workerResult = await response.json();
        assert.deepEqual(nodeResult, sample.expected, `${variant}/${sample.label}/node`);
        assert.deepEqual(workerResult, nodeResult, `${variant}/${sample.label}/worker`);
        matrix.push({ label: sample.label, ...nodeResult });
      }
      const execute = async () => {
        const response = await runtime.dispatchFetch("https://proof/execute", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      const fresh = await execute(),
        cached = await execute();
      assert.equal(fresh.result.state, "completed", JSON.stringify(fresh));
      assert.deepEqual(fresh.operations, ["completed"]);
      assert.deepEqual(cached.operations, ["confirm_completed"]);
      assert.deepEqual(cached.result, fresh.result);
      observations.push({ matrix, fresh, cached });
    } finally {
      await runtime.dispose();
    }
  }
  assert.deepEqual(observations[0], observations[1]);
  console.log(
    JSON.stringify(
      {
        base,
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        runtime: "bundled Node verifier and workerd Worker with SQLite",
        metadata_cases: cases.length,
        completion_cases: ["fresh", "cached"],
        equivalent: true,
        source_sha256: createHash("sha256")
          .update(
            [
              "src/proof-artifact-contract.ts",
              "src/repair/proof-receipt-verification.ts",
              "dashboard/review-proof-artifacts.ts",
              "dashboard/review-proof-execution.ts",
            ]
              .map((file) => readFileSync(file))
              .join("\n"),
          )
          .digest("hex"),
        limits:
          "Real ZIP bytes, cryptographic digests, Worker execution and SQLite acknowledgements; GitHub metadata/artifact reads are synthetic fixtures. No external calls or deployment.",
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(output, { recursive: true, force: true });
}
