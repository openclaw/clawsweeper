import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StateWriterCoordinator,
  type StateWriterTicketInput,
} from "../../dashboard/state-writer-coordinator.ts";

const COORDINATOR_HMAC_FIXTURE = "test-clawsweeper-state-coordinator-secret";
const BATCH_PATHS = [
  "records/openclaw-openclaw/items/91001.md",
  "records/openclaw-openclaw/items/91002.md",
] as const;
const ORDINARY_PATH = "results/ordinary-writer.json";

class SqlCursor<T extends Record<string, unknown>> implements Iterable<T> {
  private readonly rows: T[];

  constructor(rows: T[]) {
    this.rows = rows;
  }

  *[Symbol.iterator]() {
    yield* this.rows;
  }
}

class TestStorage {
  private readonly database = new DatabaseSync(":memory:");

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const statement = this.database.prepare(query);
      if (/^\s*(?:SELECT|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        return new SqlCursor(statement.all(...bindings) as Record<string, unknown>[]);
      }
      statement.run(...bindings);
      return new SqlCursor<Record<string, unknown>>([]);
    },
  };

  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

test(
  "durable coordinator keeps an ordinary writer behind an active size-2 batch",
  { timeout: 60_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-state-writer-fifo-git-"));
    const repository = createStateRepository(root);
    const batchSource = path.join(root, "batch-source");
    const ordinarySource = path.join(root, "ordinary-source");
    const batchReady = path.join(root, "batch-ready");
    const releaseBatch = path.join(root, "release-batch");
    fs.mkdirSync(batchSource);
    fs.mkdirSync(ordinarySource);
    publishLivePriorityIntent(repository.batchWork);
    const coordinatorServer = await startCoordinatorServer();
    const commonEnv = {
      CLAWSWEEPER_PUBLISH_BRANCH: "state",
      CLAWSWEEPER_STATE_COORDINATOR_ENABLED: "1",
      CLAWSWEEPER_STATE_COORDINATOR_URL: coordinatorServer.url,
      ["CLAWSWEEPER_STATE_COORDINATOR_SECRET"]: COORDINATOR_HMAC_FIXTURE,
      CLAWSWEEPER_STATE_LEASE_PRIORITY: "0",
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      GITHUB_RUN_ATTEMPT: "1",
    };
    let batchRun: AsyncProcess | undefined;
    let ordinaryRun: AsyncProcess | undefined;

    try {
      batchRun = startAsync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          logicalSizeTwoBatchWriter,
          batchSource,
          batchReady,
          releaseBatch,
        ],
        process.cwd(),
        {
          ...commonEnv,
          CLAWSWEEPER_STATE_DIR: repository.batchWork,
          GITHUB_WORKFLOW: "Exact review batch publish",
          GITHUB_JOB: "publish",
          GITHUB_RUN_ID: "91001",
          CLAWSWEEPER_STATE_COORDINATOR_CLASS: "publication_batch",
        },
      );
      await waitForFile(batchReady, 15_000, "logical size-2 writer did not acquire its ticket");
      assert.match(batchRun.output(), /Acquired durable state writer ticket/);
      assert.match(batchRun.output(), /Acquired state publish lease/);
      assert.doesNotMatch(batchRun.output(), /yielding to priority intent/);
      const fenceMessage = gitBare(
        repository.origin,
        "show",
        "-s",
        "--format=%B",
        "refs/heads/clawsweeper-publish-lease/state",
      );
      assert.match(fenceMessage, /^ticket_id: state-writer:[0-9a-f-]+$/m);
      assert.match(fenceMessage, /^ticket_generation: 1$/m);
      assert.match(fenceMessage, /^run_id: 91001$/m);
      assert.match(fenceMessage, /^workflow: Exact review batch publish$/m);
      assert.match(fenceMessage, /^job: publish$/m);

      ordinaryRun = startAsync(
        process.execPath,
        ["--input-type=module", "-e", ordinaryWriter, ordinarySource],
        process.cwd(),
        {
          ...commonEnv,
          CLAWSWEEPER_STATE_DIR: repository.ordinaryWork,
          GITHUB_WORKFLOW: "Sweep ordinary state writer",
          GITHUB_JOB: "status",
          GITHUB_RUN_ID: "91002",
        },
      );
      await waitFor(
        () =>
          ordinaryRun?.output().includes("Queued durable state writer ticket position=1") === true,
        15_000,
        "ordinary writer did not enter the durable FIFO",
      );

      const ordinaryWhileQueued = ordinaryRun.output();
      assert.doesNotMatch(ordinaryWhileQueued, /Acquired durable state writer ticket/);
      assert.doesNotMatch(ordinaryWhileQueued, /Acquired state publish lease/);
      assert.doesNotMatch(ordinaryWhileQueued, /State publish lease busy/);
      assert.doesNotMatch(ordinaryWhileQueued, /\$ git check-ref-format/);
      const queuedStats = coordinatorServer.coordinator.stats(Date.now(), 60_000);
      assert.equal(queuedStats.active?.workflow, "Exact review batch publish");
      assert.equal(queuedStats.queued, 1);

      fs.writeFileSync(releaseBatch, "release\n");
      const [batchOutput, ordinaryOutput] = await Promise.all([
        batchRun.result,
        ordinaryRun.result,
      ]);

      assert.match(batchOutput, /Released durable state writer ticket/);
      assert.match(ordinaryOutput, /Queued durable state writer ticket position=1/);
      assert.match(ordinaryOutput, /Acquired durable state writer ticket/);
      assert.ok(
        ordinaryOutput.indexOf("Queued durable state writer ticket") <
          ordinaryOutput.indexOf("Acquired durable state writer ticket"),
      );
      assert.doesNotMatch(ordinaryOutput, /State publish lease busy/);
      assert.doesNotMatch(ordinaryOutput, /yielding to priority intent/);
      assert.deepEqual(coordinatorServer.admittedWorkflows, [
        "Exact review batch publish",
        "Sweep ordinary state writer",
      ]);

      assert.equal(gitBare(repository.origin, "rev-list", "--count", "state").trim(), "3");
      assert.equal(
        gitBare(repository.origin, "show", `state:${BATCH_PATHS[0]}`),
        "logical batch item 1\n",
      );
      assert.equal(
        gitBare(repository.origin, "show", `state:${BATCH_PATHS[1]}`),
        "logical batch item 2\n",
      );
      assert.equal(
        gitBare(repository.origin, "show", `state:${ORDINARY_PATH}`),
        '{"writer":"ordinary"}\n',
      );
      assert.deepEqual(changedPaths(repository.origin, "state~1"), [...BATCH_PATHS]);
      assert.deepEqual(changedPaths(repository.origin, "state"), [ORDINARY_PATH]);
      assert.deepEqual(
        gitBare(repository.origin, "log", "-2", "--format=%s", "state").trim().split("\n"),
        ["chore: publish ordinary state sibling", "chore: publish logical size-2 exact batch"],
      );
      assert.equal(
        gitBare(
          repository.origin,
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/clawsweeper-publish-lease",
        ).trim(),
        "",
      );
      const finalStats = coordinatorServer.coordinator.stats(Date.now(), 60_000);
      assert.equal(finalStats.active, null);
      assert.equal(finalStats.queued, 0);
      assert.equal(finalStats.admitted, 2);
      assert.equal(finalStats.completed, 2);
      assert.equal(coordinatorServer.signatureFailures, 0);
      assert.ok(coordinatorServer.authenticatedRequests >= 8);
    } finally {
      if (batchRun && !batchRun.settled()) batchRun.child.kill("SIGKILL");
      if (ordinaryRun && !ordinaryRun.settled()) ordinaryRun.child.kill("SIGKILL");
      await coordinatorServer.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("fence commits do not require a preconfigured Git identity", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fence-identity-"));
  const repository = createStateRepositoryWithoutIdentity(root);
  const batchSource = path.join(root, "batch-source");
  const ordinarySource = path.join(root, "ordinary-source");
  const batchReady = path.join(root, "batch-ready");
  const releaseBatch = path.join(root, "release-batch");
  fs.mkdirSync(batchSource);
  fs.mkdirSync(ordinarySource);
  assertNoGitIdentity(repository.batchWork);
  assertNoGitIdentity(repository.ordinaryWork);
  const coordinatorServer = await startCoordinatorServer();
  const commonEnv: Record<string, string> = {
    CLAWSWEEPER_PUBLISH_BRANCH: "state",
    CLAWSWEEPER_STATE_COORDINATOR_ENABLED: "1",
    CLAWSWEEPER_STATE_COORDINATOR_URL: coordinatorServer.url,
    ["CLAWSWEEPER_STATE_COORDINATOR_SECRET"]: COORDINATOR_HMAC_FIXTURE,
    CLAWSWEEPER_STATE_LEASE_PRIORITY: "0",
    GITHUB_REPOSITORY: "openclaw/clawsweeper",
    GITHUB_RUN_ATTEMPT: "1",
    CLAWSWEEPER_GIT_USER_NAME: "",
    CLAWSWEEPER_GIT_USER_EMAIL: "",
  };
  let batchRun: AsyncProcess | undefined;
  let ordinaryRun: AsyncProcess | undefined;

  try {
    batchRun = startAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        logicalSizeTwoBatchWriter,
        batchSource,
        batchReady,
        releaseBatch,
      ],
      process.cwd(),
      {
        ...commonEnv,
        CLAWSWEEPER_STATE_DIR: repository.batchWork,
        GITHUB_WORKFLOW: "Exact review batch publish",
        GITHUB_JOB: "publish",
        GITHUB_RUN_ID: "92001",
      },
    );
    await waitForFile(batchReady, 15_000, "batch writer did not acquire its ticket");
    assert.match(batchRun.output(), /Acquired state publish lease/);
    const fenceAuthor = gitBare(
      repository.origin,
      "show",
      "-s",
      "--format=%an <%ae>",
      "refs/heads/clawsweeper-publish-lease/state",
    ).trim();
    assert.equal(fenceAuthor, "clawsweeper <274271284+clawsweeper[bot]@users.noreply.github.com>");
    const fenceMessage = gitBare(
      repository.origin,
      "show",
      "-s",
      "--format=%B",
      "refs/heads/clawsweeper-publish-lease/state",
    );
    assert.match(fenceMessage, /^ticket_id: state-writer:[0-9a-f-]+$/m);

    fs.writeFileSync(releaseBatch, "release\n");
    const batchOutput = await batchRun.result;
    assert.match(batchOutput, /Released durable state writer ticket/);
    assert.deepEqual(changedPaths(repository.origin, "state"), [...BATCH_PATHS]);

    ordinaryRun = startAsync(
      process.execPath,
      ["--input-type=module", "-e", ordinaryWriter, ordinarySource],
      process.cwd(),
      {
        ...commonEnv,
        CLAWSWEEPER_STATE_DIR: repository.ordinaryWork,
        GITHUB_WORKFLOW: "Sweep ordinary state writer",
        GITHUB_JOB: "status",
        GITHUB_RUN_ID: "92002",
      },
    );
    const ordinaryOutput = await ordinaryRun.result;
    assert.match(ordinaryOutput, /Acquired state publish lease/);
    assert.deepEqual(changedPaths(repository.origin, "state"), [ORDINARY_PATH]);

    assert.equal(gitBare(repository.origin, "rev-list", "--count", "state").trim(), "3");
    assert.equal(
      gitBare(repository.origin, "show", `state:${BATCH_PATHS[0]}`),
      "logical batch item 1\n",
    );
    assert.equal(
      gitBare(repository.origin, "show", `state:${BATCH_PATHS[1]}`),
      "logical batch item 2\n",
    );
    assert.equal(
      gitBare(repository.origin, "show", `state:${ORDINARY_PATH}`),
      '{"writer":"ordinary"}\n',
    );
    const stateAuthors = gitBare(repository.origin, "log", "-2", "--format=%an", "state").trim();
    assert.ok(
      stateAuthors.split("\n").every((author) => author === "clawsweeper"),
      "data commits retain the clawsweeper author identity",
    );
    assert.equal(
      gitBare(
        repository.origin,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/clawsweeper-publish-lease",
      ).trim(),
      "",
    );
  } finally {
    if (batchRun && !batchRun.settled()) batchRun.child.kill("SIGKILL");
    if (ordinaryRun && !ordinaryRun.settled()) ordinaryRun.child.kill("SIGKILL");
    await coordinatorServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const logicalSizeTwoBatchWriter = String.raw`
  import fs from "node:fs";
  import path from "node:path";
  const [sourceRoot, ready, release] = process.argv.slice(1);
  const paths = [
    "records/openclaw-openclaw/items/91001.md",
    "records/openclaw-openclaw/items/91002.md",
  ];
  fs.mkdirSync(path.dirname(path.join(sourceRoot, paths[0])), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, paths[0]), "logical batch item 1\n");
  fs.writeFileSync(path.join(sourceRoot, paths[1]), "logical batch item 2\n");
  const { publishMainCommit, withStatePublishLease } =
    await import("./dist/repair/git-publish.js");
  process.chdir(sourceRoot);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  withStatePublishLease(
    () => {
      fs.writeFileSync(ready, "ready\n");
      while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
      const result = publishMainCommit({
        message: "chore: publish logical size-2 exact batch",
        paths,
        branch: "state",
        maxAttempts: 2,
        pushAttempts: 1,
      });
      if (result !== "committed") throw new Error("logical size-2 batch did not commit");
    },
    { branch: "state", acquireTimeoutMs: 5_000, ttlMs: 30_000, waitMs: 10 },
  );
`;

const ordinaryWriter = String.raw`
  import fs from "node:fs";
  import path from "node:path";
  const [sourceRoot] = process.argv.slice(1);
  const publishPath = "results/ordinary-writer.json";
  fs.mkdirSync(path.dirname(path.join(sourceRoot, publishPath)), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, publishPath), '{"writer":"ordinary"}\n');
  const { publishMainCommit } = await import("./dist/repair/git-publish.js");
  process.chdir(sourceRoot);
  const result = publishMainCommit({
    message: "chore: publish ordinary state sibling",
    paths: [publishPath],
    branch: "state",
    maxAttempts: 2,
    pushAttempts: 1,
  });
  if (result !== "committed") throw new Error("ordinary state sibling did not commit");
`;

async function startCoordinatorServer() {
  const storage = new TestStorage();
  const coordinator = new StateWriterCoordinator(storage);
  coordinator.ensureSchemaSync();
  const admitted = new Set<string>();
  const admittedWorkflows: string[] = [];
  const counters = { authenticatedRequests: 0, signatureFailures: 0 };
  const server = createServer((request, response) => {
    void routeCoordinatorRequest(
      request,
      response,
      coordinator,
      admitted,
      admittedWorkflows,
      counters,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    coordinator,
    admittedWorkflows,
    get authenticatedRequests() {
      return counters.authenticatedRequests;
    },
    get signatureFailures() {
      return counters.signatureFailures;
    },
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function routeCoordinatorRequest(
  request: IncomingMessage,
  response: ServerResponse,
  coordinator: StateWriterCoordinator,
  admitted: Set<string>,
  admittedWorkflows: string[],
  counters: { authenticatedRequests: number; signatureFailures: number },
): Promise<void> {
  try {
    const body = await requestBody(request);
    const expected = `sha256=${createHmac("sha256", COORDINATOR_HMAC_FIXTURE)
      .update(body)
      .digest("hex")}`;
    if (request.headers["x-clawsweeper-exact-review-signature"] !== expected) {
      counters.signatureFailures += 1;
      writeJson(response, 401, { error: "invalid_signature" });
      return;
    }
    counters.authenticatedRequests += 1;
    const payload = JSON.parse(body) as Record<string, unknown>;
    const now = Date.now();
    if (request.url === "/internal/state-writer/acquire") {
      const input = ticketInput(payload);
      const ticket = coordinator.acquire(input, now, 60_000, 60_000, 120_000);
      if (ticket.state === "leased" && !admitted.has(ticket.ticketId)) {
        admitted.add(ticket.ticketId);
        admittedWorkflows.push(input.workflow);
      }
      writeJson(response, 200, { ok: true, ticket });
      return;
    }
    const ticketId = String(payload.ticket_id || "");
    const owner = String(payload.owner || "");
    const leaseToken = String(payload.lease_token || "");
    if (request.url === "/internal/state-writer/heartbeat") {
      const ticket = coordinator.heartbeat(ticketId, owner, leaseToken, now, 60_000, 60_000);
      writeJson(
        response,
        ticket ? 200 : 409,
        ticket ? { ok: true, ticket } : { error: "state_writer_ticket_not_active" },
      );
      return;
    }
    if (request.url === "/internal/state-writer/release") {
      const released = coordinator.release(ticketId, owner, leaseToken, now, 60_000);
      writeJson(
        response,
        released ? 200 : 409,
        released ? { ok: true, released: true } : { error: "state_writer_ticket_not_active" },
      );
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  } catch (error) {
    writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function ticketInput(payload: Record<string, unknown>): StateWriterTicketInput {
  return {
    ticketId: String(payload.ticket_id || ""),
    owner: String(payload.owner || ""),
    branch: String(payload.branch || ""),
    repository: String(payload.repository || ""),
    workflow: String(payload.workflow || ""),
    job: String(payload.job || ""),
    runId: String(payload.run_id || ""),
    runAttempt: Number(payload.run_attempt),
    writerClass: payload.writer_class === "publication_batch" ? "publication_batch" : "ordinary",
  };
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function createStateRepository(root: string) {
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const batchWork = path.join(root, "batch-work");
  const ordinaryWork = path.join(root, "ordinary-work");
  git(root, "init", "--bare", origin);
  git(root, "clone", origin, seed);
  configureUser(seed);
  fs.writeFileSync(path.join(seed, "README.md"), "initial state\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "initial state");
  git(seed, "push", "origin", "HEAD:state");
  gitBare(origin, "symbolic-ref", "HEAD", "refs/heads/state");
  git(root, "clone", "--branch", "state", origin, batchWork);
  git(root, "clone", "--branch", "state", origin, ordinaryWork);
  configureUser(batchWork);
  configureUser(ordinaryWork);
  return { origin, batchWork, ordinaryWork };
}

function createStateRepositoryWithoutIdentity(root: string) {
  const repository = createStateRepository(root);
  unsetGitIdentity(repository.batchWork);
  unsetGitIdentity(repository.ordinaryWork);
  return repository;
}

function unsetGitIdentity(work: string): void {
  git(work, "config", "--unset", "user.name");
  git(work, "config", "--unset", "user.email");
}

function localGitConfig(work: string, key: string): string {
  const result = spawnSync("git", ["config", "--local", "--get", key], {
    cwd: work,
    encoding: "utf8",
    stdio: "pipe",
  });
  // git config --get exits 1 when the key is unset; treat that as empty.
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return "";
  throw new Error(`git config --get ${key} failed: ${result.stderr.trim()}`);
}

function assertNoGitIdentity(work: string): void {
  assert.equal(localGitConfig(work, "user.name"), "", `${work} must not preconfigure user.name`);
  assert.equal(localGitConfig(work, "user.email"), "", `${work} must not preconfigure user.email`);
}

function configureUser(root: string): void {
  git(root, "config", "user.name", "ClawSweeper Test");
  git(root, "config", "user.email", "clawsweeper@example.com");
}

function publishLivePriorityIntent(work: string): void {
  const tree = git(work, "mktree").trim();
  const intent = git(
    work,
    "commit-tree",
    tree,
    "-m",
    "ClawSweeper state publish priority intent",
    "-m",
    [
      "owner: 11111111-1111-4111-8111-111111111111",
      "branch: state",
      "ttl_ms: 300000",
      `expires_at: ${new Date(Date.now() + 300_000).toISOString()}`,
      "generation: 22222222-2222-4222-8222-222222222222",
    ].join("\n"),
  ).trim();
  git(work, "push", "origin", `${intent}:refs/heads/clawsweeper-publish-priority/state`);
}

function changedPaths(origin: string, commit: string): string[] {
  return gitBare(origin, "diff-tree", "--no-commit-id", "--name-only", "-r", commit)
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

function gitBare(root: string, ...args: string[]): string {
  return execFileSync("git", [`--git-dir=${root}`, ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

type AsyncProcess = ReturnType<typeof startAsync>;

function startAsync(command: string, args: string[], cwd: string, env: Record<string, string>) {
  let output = "";
  let settled = false;
  const child = execFile(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 55_000,
  });
  const result = new Promise<string>((resolve, reject) => {
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      settled = true;
      reject(new Error(`${error.message}\n${output}`));
    });
    child.on("close", (code, signal) => {
      settled = true;
      if (code !== 0) {
        reject(new Error(`Process exited ${code ?? signal}\n${output}`));
        return;
      }
      resolve(output);
    });
  });
  return { child, result, output: () => output, settled: () => settled };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, message);
}

async function waitForFile(file: string, timeoutMs: number, message: string): Promise<void> {
  await waitFor(() => fs.existsSync(file), timeoutMs, message);
}
