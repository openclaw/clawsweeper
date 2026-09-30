import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read-only real-GitHub proof for the exact-publication durable ETag reads.
//
// node scripts/e2e/direct-publication-etag-real-github.mjs OUTPUT BEFORE_ROOT AFTER_ROOT \
//   --number N [--rounds 3] [--broker-latency-ms 100]
//
// BEFORE_ROOT and AFTER_ROOT are built checkouts (dist/). Each run replays the
// GET sequence that one exact-event PR publication's apply-decisions issues,
// through the real createGitHubRuntime/createGitHubExecution modules, against
// public openclaw/openclaw with the local gh login. A fence in front of gh
// refuses every request except GETs of that item's issue/pull/commit routes.
// The durable ETag broker is a loopback stub: the production Worker needs the
// publisher secret, which this proof must not use.

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = "openclaw/openclaw";
const SECRET = "synthetic-real-github-etag-proof";
const ROUTES = {
  issue: (n) => ["api", `repos/${REPO}/issues/${n}`],
  comments: (n) => ["api", `repos/${REPO}/issues/${n}/comments?per_page=100&page=1`],
  timeline: (n) => ["api", "-i", `repos/${REPO}/issues/${n}/timeline?per_page=100&page=1`],
  pull: (n) => ["api", `repos/${REPO}/pulls/${n}`],
  files: (n) => ["api", `repos/${REPO}/pulls/${n}/files?per_page=100&page=1`],
  commits: (n) => ["api", `repos/${REPO}/pulls/${n}/commits?per_page=100&page=1`],
  checks: (_n, head) => ["api", `repos/${REPO}/commits/${head}/check-runs?per_page=100`],
  status: (_n, head) => ["api", `repos/${REPO}/commits/${head}/status?per_page=100`],
};
const ETAG_ROUTES = new Set(["issue", "comments", "pull"]);
// Recorded order of the GET reads one exact-event PR comment sync makes in
// apply-decisions (live item, lease/activity guards, label and comment
// boundaries, post-mutation receipts). GraphQL and mutations are omitted.
const SEQUENCE = (
  "issue comments timeline pull files commits checks status pull comments pull pull comments " +
  "pull pull comments pull pull comments pull pull comments pull pull comments pull pull comments " +
  "pull pull comments pull issue comments timeline pull files commits checks status pull comments " +
  "pull checks status issue comments timeline pull files commits checks status comments"
).split(" ");
assert.equal(SEQUENCE.length, 54);
const FENCED_ENDPOINT = new RegExp(
  `^repos/${REPO}/(?:issues/\\d+(?:/comments|/timeline)?|pulls/\\d+(?:/files|/commits)?|` +
    "commits/[0-9a-f]{40}/(?:check-runs|status))(?:\\?[A-Za-z0-9_=&]*)?$",
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalDigest = (text) => sha256(JSON.stringify(JSON.parse(text)));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const jsonl = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

function includedParts(stdout) {
  const text = stdout.replace(/\r\n/g, "\n");
  const status = Number(/^HTTP\/\S+\s+(\d{3})/m.exec(text)?.[1] ?? 0);
  const separator = text.indexOf("\n\n");
  const headers = separator >= 0 ? text.slice(0, separator) : text;
  const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? "";
  return { status, etag, body: separator >= 0 ? text.slice(separator + 2).trim() : "" };
}

function fence(args) {
  const startedAt = Date.now();
  let allowed = args[0] === "api";
  let endpoint = "";
  let conditional = false;
  for (let index = 1; allowed && index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-i") continue;
    if (arg === "-H" && /^(?:If-None-Match|Accept):/i.test(args[index + 1] ?? "")) {
      conditional ||= /^If-None-Match:/i.test(args[index + 1]);
      index += 1;
      continue;
    }
    if (!arg.startsWith("-") && !endpoint && FENCED_ENDPOINT.test(arg)) endpoint = arg;
    else allowed = false;
  }
  const log = (row) =>
    appendFileSync(
      process.env.DP_FENCE_LOG,
      `${JSON.stringify({ phase: process.env.DP_PHASE, ...row, startedAt, finishedAt: Date.now() })}\n`,
    );
  if (!allowed || !endpoint) {
    log({ refused: true, command: args.slice(0, 2).join(" ") });
    process.stderr.write("direct-publication proof fence refused a non-GET or unlisted request\n");
    process.exitCode = 97;
    return;
  }
  const env = { ...process.env };
  delete env.GH_BIN;
  delete env.GH_BIN_ARGS;
  const result = spawnSync(process.env.DP_REAL_GH, args, {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = result.stdout ?? "";
  const include = args.includes("-i");
  const parts = include
    ? includedParts(stdout)
    : {
        status: result.status === 0 ? 200 : Number(/HTTP (\d{3})/.exec(result.stderr)?.[1] ?? 0),
        etag: "",
        body: stdout,
      };
  let bodyDigest = null;
  if (parts.status === 200) {
    try {
      bodyDigest = canonicalDigest(parts.body);
    } catch {
      bodyDigest = "unparseable";
    }
  }
  const error =
    parts.status === 200 || parts.status === 304
      ? undefined
      : String(result.stderr ?? "")
          .split("\n")
          .filter((line) => line && !line.startsWith("octopool: "))
          .join(" ")
          .slice(0, 160);
  log({
    ...(error === undefined ? {} : { error }),
    endpoint: endpoint.replace(/\?.*/, ""),
    include,
    conditional,
    status: parts.status,
    etagDigest: parts.etag ? sha256(parts.etag).slice(0, 12) : null,
    bodyDigest,
  });
  // Let piped stdout drain; process.exit() truncates large bodies on macOS.
  process.stdout.write(stdout);
  process.stderr.write(result.stderr ?? "");
  process.exitCode = result.status ?? 1;
}

async function child(codeRoot, stepsPath, resultPath) {
  const dist = (name) => pathToFileURL(join(codeRoot, "dist", name)).href;
  const { createGitHubRuntime } = await import(dist("clawsweeper-github-runtime.js"));
  const { createGitHubExecution } = await import(dist("clawsweeper-github-execution.js"));
  const { runText, SWEEPER_COMMAND_MAX_BUFFER_BYTES } = await import(dist("command.js"));
  // Same wiring as src/clawsweeper-runtime.ts.
  const run = (command, args, options = {}) =>
    runText(command, args, {
      cwd: options.cwd ?? codeRoot,
      env: options.env,
      maxBuffer: SWEEPER_COMMAND_MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: options.timeoutMs,
      trim: "both",
    });
  const gitHubRuntime = createGitHubRuntime({ ROOT: codeRoot, run, targetRepo: () => REPO });
  const execution = createGitHubExecution({
    ROOT: codeRoot,
    gitHubRuntime,
    labelAlreadyExistsError: () => false,
  });
  const steps = JSON.parse(readFileSync(stepsPath, "utf8"));
  const startedAt = Date.now();
  const results = [];
  for (const step of steps) {
    const stepStartedAt = Date.now();
    let value;
    if (step.args.includes("-i")) {
      // Mirrors ghPageWithHeaders: an included page read, never brokered.
      const output = execution.ghWithRetry(step.args).replace(/\r\n/g, "\n");
      value = JSON.parse(output.slice(output.lastIndexOf("\n\n") + 2));
    } else {
      value = execution.ghJson(step.args);
    }
    results.push({
      route: step.route,
      endpoint: step.args.at(-1).replace(/\?.*/, ""),
      digest: sha256(JSON.stringify(value)),
      startedAt: stepStartedAt,
      finishedAt: Date.now(),
    });
  }
  writeFileSync(resultPath, JSON.stringify({ startedAt, finishedAt: Date.now(), results }));
}

function startBroker(latencyMs) {
  const entries = new Map();
  const state = { phase: "setup", rows: [] };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
    if (request.headers["x-clawsweeper-exact-review-signature"] !== signature) {
      response.writeHead(401).end("{}");
      return;
    }
    const body = JSON.parse(raw);
    const operation = String(request.url).split("/").at(-1);
    await new Promise((done) => setTimeout(done, latencyMs));
    let payload;
    const entry = entries.get(body.cache_key);
    if (operation === "lookup") {
      payload = entry
        ? { hit: true, entry: { etag: entry.etag, bodyDigest: entry.bodyDigest } }
        : { hit: false };
    } else if (operation === "store" && typeof body.body === "string" && body.etag) {
      entries.set(body.cache_key, {
        etag: body.etag,
        body: body.body,
        bodyDigest: sha256(body.body),
      });
      payload = { stored: true };
    } else if (operation === "store") {
      payload = { stored: false };
    } else if (operation === "confirm") {
      payload =
        entry && entry.etag === body.etag && entry.bodyDigest === body.body_digest
          ? {
              confirmed: true,
              body: entry.body,
              entry: { etag: entry.etag, bodyDigest: entry.bodyDigest },
            }
          : { confirmed: false };
    } else {
      response.writeHead(404).end("{}");
      return;
    }
    state.rows.push({
      phase: state.phase,
      operation,
      route: String(body.route).replace(/\?.*/, ""),
    });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  return {
    state,
    reset: () => entries.clear(),
    listen: async () => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      return server.address().port;
    },
    close: () => server.close(),
  };
}

async function runChild(codeRoot, steps, dir, name, env) {
  const stepsPath = join(dir, `${name}-steps.json`);
  const resultPath = join(dir, `${name}.json`);
  writeFileSync(stepsPath, JSON.stringify(steps, null, 1));
  const startedAt = Date.now();
  const processHandle = spawn(
    process.execPath,
    [SCRIPT, "--child", codeRoot, stepsPath, resultPath],
    {
      cwd: dir,
      env: { ...env, DP_PHASE: name },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  processHandle.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const [code] = await once(processHandle, "exit");
  const wallMs = Date.now() - startedAt;
  // gh prints a benign Octopool notice on stderr; keep only diagnostics that matter.
  const errors = stderr
    .split("\n")
    .filter((line) => line && !/^octopool: |^gh: HTTP 304$/.test(line));
  assert.equal(code, 0, `${name} child failed: ${errors.join("\n")}`);
  return { wallMs, ...JSON.parse(readFileSync(resultPath, "utf8")) };
}

function findExecutable(name) {
  for (const directory of String(process.env.PATH).split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate) === realpathSync(process.execPath) ? null : candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const [, value] = args.splice(index, 2);
    return value;
  };
  const number = Number(option("--number", ""));
  const rounds = Number(option("--rounds", "3"));
  const brokerLatencyMs = Number(option("--broker-latency-ms", "100"));
  const [outputArg, beforeArg, afterArg] = args;
  assert.ok(outputArg && beforeArg && afterArg && args.length === 3, "usage: see file header");
  assert.ok(Number.isSafeInteger(number) && number > 0, "--number must name a public PR");
  assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 5, "--rounds must be 1..5");
  const output = resolve(outputArg);
  assert.ok(!existsSync(output), `refusing to overwrite ${output}`);
  mkdirSync(output, { recursive: true });
  const builds = { before: resolve(beforeArg), after: resolve(afterArg) };
  for (const root of Object.values(builds)) {
    assert.ok(existsSync(join(root, "dist/clawsweeper-github-runtime.js")), `${root} is not built`);
  }
  const realGh = findExecutable("gh");
  assert.ok(realGh, "gh is not on PATH");
  const fenceLog = join(output, "github-requests.jsonl");
  const fenceEnv = {
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([SCRIPT, "--fence"]),
    DP_REAL_GH: realGh,
    DP_FENCE_LOG: fenceLog,
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
  };
  const baseEnv = { ...process.env, ...fenceEnv };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "REPO_TOKEN", "CLAWSWEEPER_PUBLIC_GH_TOKEN"]) {
    delete baseEnv[key];
  }

  const setup = spawnSync(
    process.execPath,
    [SCRIPT, "--fence", ...ROUTES.pull(number).toSpliced(1, 0, "-i")],
    {
      encoding: "utf8",
      env: { ...baseEnv, DP_PHASE: "setup" },
    },
  );
  const pull = JSON.parse(includedParts(setup.stdout ?? "").body);
  assert.equal(pull.state, "open", `openclaw/openclaw#${number} must be an open PR`);
  const head = String(pull.head?.sha ?? "");
  assert.match(head, /^[0-9a-f]{40}$/);
  const sequence = SEQUENCE.map((route) => ({
    route,
    etag: ETAG_ROUTES.has(route),
    args: ROUTES[route](number, head),
  }));
  const primer = [...ETAG_ROUTES].map((route) => ({
    route,
    etag: true,
    args: ROUTES[route](number, head),
  }));

  const broker = startBroker(brokerLatencyMs);
  const port = await broker.listen();
  const runs = [];
  try {
    for (let round = 1; round <= rounds; round += 1) {
      const order = round % 2 === 1 ? ["before", "after"] : ["after", "before"];
      for (const build of order) {
        const label = `${build}-${round}`;
        const dir = join(output, label);
        mkdirSync(dir);
        const env = {
          ...baseEnv,
          EXACT_EVENT_PUBLICATION: "true",
          EXACT_REVIEW_QUEUE_URL: `http://127.0.0.1:${port}`,
          CLAWSWEEPER_WEBHOOK_SECRET: SECRET,
          CLAWSWEEPER_GITHUB_EGRESS_METRICS_PATH: join(dir, "github-egress-v2.jsonl"),
          CLAWSWEEPER_GITHUB_STAGE: "publication_apply",
          CLAWSWEEPER_GITHUB_SOURCE_ACTION: "synchronize",
          CLAWSWEEPER_GITHUB_CLAIM_GENERATION: "1",
        };
        // A fresh durable store per run, primed by an earlier process the way
        // a previous publication for this item leaves the Worker cache.
        broker.reset();
        broker.state.phase = `${label}-primer`;
        await runChild(builds[build], primer, dir, `${label}-primer`, env);
        broker.state.phase = `${label}-measured`;
        const measured = await runChild(builds[build], sequence, dir, `${label}-measured`, env);
        broker.state.phase = `${label}-verify`;
        const verify = {};
        for (const route of ETAG_ROUTES) {
          // --include keeps the verification a live native read.
          const result = spawnSync(
            process.execPath,
            [SCRIPT, "--fence", ...ROUTES[route](number, head).toSpliced(1, 0, "-i")],
            { encoding: "utf8", env: { ...baseEnv, DP_PHASE: `${label}-verify` } },
          );
          const parts = includedParts(result.stdout ?? "");
          assert.equal(parts.status, 200, `verify ${route} failed`);
          verify[route] = canonicalDigest(parts.body);
        }
        runs.push({ label, build, round, measured, verify });
      }
    }
  } finally {
    broker.close();
  }

  const requests = jsonl(fenceLog);
  assert.equal(requests.filter((row) => row.refused).length, 0, "the fence refused a request");
  const rows = [];
  for (const run of runs) {
    // Replay the timeline for this run: the most recent live 200 body per
    // route is the only body a 304 may legitimately stand for.
    const events = [
      ...requests
        .filter(
          (row) => row.phase === `${run.label}-primer` || row.phase === `${run.label}-measured`,
        )
        .map((row) => ({ at: row.finishedAt, kind: "github", row })),
      ...run.measured.results.map((step) => ({ at: step.finishedAt + 0.5, kind: "served", step })),
    ].sort((left, right) => left.at - right.at);
    const lastLive = new Map();
    let changedBody = 0;
    let sameBodyNewEtag = 0;
    let servedChecked = 0;
    let etagServed = 0;
    const servedMismatches = [];
    for (const event of events) {
      if (event.kind === "github" && event.row.status === 200) {
        if (event.row.conditional && event.row.phase.endsWith("-measured")) {
          if (lastLive.get(event.row.endpoint) === event.row.bodyDigest) sameBodyNewEtag += 1;
          else changedBody += 1;
        }
        lastLive.set(event.row.endpoint, event.row.bodyDigest);
      } else if (event.kind === "served" && event.step.route !== "timeline") {
        servedChecked += 1;
        if (ETAG_ROUTES.has(event.step.route)) etagServed += 1;
        if (lastLive.get(event.step.endpoint) !== event.step.digest)
          servedMismatches.push(event.step);
      }
    }
    const measuredRequests = requests.filter((row) => row.phase === `${run.label}-measured`);
    const brokerRows = broker.state.rows.filter((row) => row.phase === `${run.label}-measured`);
    const lastServed = {};
    for (const step of run.measured.results) lastServed[step.route] = step.digest;
    const egress = jsonl(join(output, run.label, "github-egress-v2.jsonl"));
    const countBy = (list, key) =>
      list.reduce((counts, row) => ({ ...counts, [row[key]]: (counts[row[key]] ?? 0) + 1 }), {});
    const readsMs = run.measured.finishedAt - run.measured.startedAt;
    const githubMs = measuredRequests.reduce((sum, row) => sum + row.finishedAt - row.startedAt, 0);
    const routeKey = (endpoint) =>
      endpoint
        .replace(`repos/${REPO}/`, "")
        .replace(/[0-9a-f]{40}/, "HEAD")
        .replace(/\d{3,}/, "N");
    const routes = {};
    for (const row of measuredRequests) {
      const entry = (routes[routeKey(row.endpoint)] ??= {
        requests: 0,
        conditional: 0,
        status: {},
      });
      entry.requests += 1;
      if (row.conditional) entry.conditional += 1;
      entry.status[row.status] = (entry.status[row.status] ?? 0) + 1;
    }
    rows.push({
      label: run.label,
      build: run.build,
      wallMs: run.measured.wallMs,
      readsMs,
      githubMs,
      nonGithubMs: readsMs - githubMs,
      githubRequests: measuredRequests.length,
      githubStatus: countBy(measuredRequests, "status"),
      conditionalRequests: measuredRequests.filter((row) => row.conditional).length,
      conditionalChangedBody: changedBody,
      conditionalSameBodyNewEtag: sameBodyNewEtag,
      transportErrors: measuredRequests
        .filter((row) => row.error !== undefined)
        .map((row) => ({ route: routeKey(row.endpoint), error: row.error })),
      routes,
      changedWhileConditional: measuredRequests
        .filter((row) => row.conditional && row.status === 200)
        .map((row) => row.endpoint.replace(/.*\/openclaw\/openclaw\//, "")),
      brokerRequests: brokerRows.length,
      brokerOperations: countBy(brokerRows, "operation"),
      egressUnits: countBy(
        egress.map((row) => ({ key: `${row.unit}:${row.outcome}` })),
        "key",
      ),
      servedBodiesChecked: servedChecked,
      etagBodiesChecked: etagServed,
      servedBodyMismatches: servedMismatches.length,
      finalLiveReadMatchesLastServed: Object.fromEntries(
        [...ETAG_ROUTES].map((route) => [route, run.verify[route] === lastServed[route]]),
      ),
    });
  }
  const summarize = (build) => {
    const selected = rows.filter((row) => row.build === build);
    return {
      runs: selected.length,
      medianWallMs: median(selected.map((row) => row.wallMs)),
      medianGithubMs: median(selected.map((row) => row.githubMs)),
      medianNonGithubMs: median(selected.map((row) => row.nonGithubMs)),
      github200: selected.map((row) => row.githubStatus[200] ?? 0),
      githubRequests: selected.map((row) => row.githubRequests),
      brokerRequests: selected.map((row) => row.brokerRequests),
    };
  };
  const summary = {
    target: `${REPO}#${number}`,
    head: head.slice(0, 12),
    sequenceReads: sequence.length,
    brokeredReads: sequence.filter((step) => step.etag).length,
    brokerLatencyMs,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    setupRequests: requests.filter((row) => row.phase === "setup").length,
    totalGithubRequests: requests.length,
    before: summarize("before"),
    after: summarize("after"),
    runs: rows,
  };
  writeFileSync(join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  for (const row of rows) {
    assert.equal(
      row.servedBodyMismatches,
      0,
      `${row.label} served a body GitHub did not last return`,
    );
  }
}

if (process.argv[2] === "--fence") fence(process.argv.slice(3));
else if (process.argv[2] === "--child") await child(...process.argv.slice(3, 6));
else await main();
