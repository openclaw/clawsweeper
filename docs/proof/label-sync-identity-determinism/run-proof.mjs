import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), "../../..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const goldenIdentity =
  "issue_labels_sync:321:add=Alpha|apple|zulu|äpple:remove=Beta|omega|zeta|örebro";
const goldenArgs = [
  "issue",
  "edit",
  "321",
  "--add-label",
  "Alpha,apple,zulu,äpple",
  "--remove-label",
  "Beta,omega,zeta,örebro",
];

async function record(modulePath, root) {
  // Only fixed synthetic producer metadata is created inside the isolated child.
  Object.assign(process.env, {
    CLAWSWEEPER_ACTION_LEDGER_FORCE: "1",
    CLAWSWEEPER_ACTION_LEDGER_INVOCATION: "fixture",
    CLAWSWEEPER_ACTION_LEDGER_PARTITION_DATE: "2026-09-01",
    GITHUB_REPOSITORY: "example/fixture",
    GITHUB_RUN_ID: "1139",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "1".repeat(40),
    GITHUB_JOB: "fixture",
    GITHUB_WORKFLOW: "fixture-proof",
    GITHUB_ACTION: "fixture",
  });
  const dist = dirname(modulePath);
  const load = (name) => import(pathToFileURL(join(dist, name)).href);
  const { createLabelMutationOperations } = await import(pathToFileURL(modulePath).href);
  const { normalizeLabelName } = await load("clawsweeper-item-policy.js");
  const { createApplyActionLedger } = await load("clawsweeper-apply-ledger.js");
  const { createReviewActionLedger } = await load("clawsweeper-review-ledger.js");
  const { readAllSpooledActionEvents, actionIdempotencyKey } = await load("action-ledger.js");
  const dependencies = {
    root,
    targetRepo: () => "example/fixture",
    repoRelativePath: (path) => relative(root, path),
    sha256: hash,
    isRuntimeBudgetError: () => false,
  };
  const recorder = createApplyActionLedger({
    ...dependencies,
    reviewLedger: createReviewActionLedger(dependencies),
    frontMatterValue: (_, key) =>
      ({ review_content_digest: "b".repeat(64), decision_packet_sha256: "c".repeat(64) })[key],
    reviewLeaseRevisionFromReport: () => "a".repeat(40),
    reportItemKind: () => "issue",
  });
  const entry = {
    repo: "example/fixture",
    number: 321,
    path: join(root, "records/example-fixture/items/321.md"),
    markdown: "synthetic issue",
  };
  const ledger = recorder.startApplyActionLedger({
    applyKind: "all",
    closeReasons: null,
    dryRun: false,
    syncCommentsOnly: false,
    requestedItemNumbers: [321],
    reportPath: join(root, "report.json"),
    candidates: [entry],
  });
  const observations = [];
  let scenario;
  let syntheticInvocations = 0;
  const operations = createLabelMutationOperations({
    ghJson: () => [],
    normalizeLabelName,
    prStatusLabelForKind: () => ({ name: "status:ready", color: "1F883D", description: "fixture" }),
    ghObservedMutationCommand: (mutation) => {
      const attempt = recorder.startApplyMutationAttempt(
        ledger,
        entry,
        `${mutation.identity}:request_attempt:1`,
        mutation.identity,
      );
      assert.ok(attempt?.eventId, "recorder must persist an attempt");
      syntheticInvocations += 1; // Adapter invocation, not real apply or GitHub execution.
      const outcomeId = recorder.finishApplyMutationAttempt({
        ledger,
        entry,
        attempt,
        outcome: "accepted",
      });
      observations.push({
        scenario,
        identity: mutation.identity,
        args: mutation.args,
        businessKey: actionIdempotencyKey(attempt.idempotencyIdentity),
        attemptId: attempt.eventId,
        outcomeId,
      });
      mutation.onMutation?.();
    },
  });
  const additions = ["zulu", "Alpha", "äpple", "apple"];
  const removals = ["zeta", "Beta", "örebro", "omega"];
  const tiedAdditions = ["status: 👀‍ ready", "status: 👀 ready"];
  const tiedRemovals = ["remove: 👀‍ ready", "remove: 👀 ready"];
  for (const tied of [tiedAdditions, tiedRemovals]) {
    assert.notEqual(tied[0], tied[1]);
    assert.equal(tied[0].localeCompare(tied[1]), 0, "fixture must exercise a collator tie");
  }
  for (const [name, add, remove] of [
    ["normal", additions, removals],
    ["reversed", [...additions].reverse(), [...removals].reverse()],
    ["sorted", [...additions].sort(), [...removals].sort()],
    [
      "rotated",
      [...additions.slice(2), ...additions.slice(0, 2)],
      [...removals.slice(1), removals[0]],
    ],
    ["duplicates", [...additions, ...additions], [...removals, ...removals]],
    ["changed-addition", [...additions, "extra"], removals],
    ["changed-removal", additions, [...removals, "extra"]],
    ["ties", tiedAdditions, tiedRemovals],
    ["ties-reversed", [...tiedAdditions].reverse(), [...tiedRemovals].reverse()],
  ]) {
    scenario = name;
    operations.beginIssueLabelMutationBatch(321);
    for (const label of add) operations.addIssueLabel(321, label);
    for (const label of remove) operations.removeIssueLabel(321, label);
    assert.equal(operations.flushIssueLabelMutationBatch(321).itemMutationPublished, true);
    const args = observations.at(-1).args;
    assert.deepEqual(args.slice(0, 4), ["issue", "edit", "321", "--add-label"]);
    assert.equal(args[5], "--remove-label");
    assert.equal(args.length, 7);
    assert.deepEqual(args[4].split(",").sort(), [...new Set(add)].sort());
    assert.deepEqual(args[6].split(",").sort(), [...new Set(remove)].sort());
  }
  const events = readAllSpooledActionEvents(root);
  for (const row of observations) {
    const attempt = events.find((event) => event.event_id === row.attemptId);
    const outcome = events.find((event) => event.event_id === row.outcomeId);
    assert.equal(attempt?.idempotency_key_sha256, row.businessKey);
    assert.equal(attempt?.attributes.completion_reason, "mutation_attempted");
    assert.equal(outcome?.idempotency_key_sha256, row.businessKey);
    assert.equal(outcome?.attributes.completion_reason, "mutation_accepted");
    assert.equal(outcome?.parent_event_id, row.attemptId);
  }
  assert.equal(syntheticInvocations, 9);
  assert.equal(observations.length, 9);
  assert.equal(events.length, 20);
  assert.equal(new Set(observations.flatMap((row) => [row.attemptId, row.outcomeId])).size, 18);
  for (const row of observations.slice(1, 5)) {
    assert.equal(row.identity, observations[0].identity);
    assert.equal(row.businessKey, observations[0].businessKey);
  }
  for (const row of observations.slice(5, 7)) {
    assert.notEqual(row.businessKey, observations[0].businessKey);
  }
  assert.notEqual(observations[5].businessKey, observations[6].businessKey);
  const moduleHashes = Object.fromEntries(
    [
      "clawsweeper-item-policy.js",
      "clawsweeper-apply-ledger.js",
      "clawsweeper-review-ledger.js",
      "action-ledger.js",
      "action-ledger-runtime.js",
      "stable-json.js",
    ].map((name) => [name, hash(readFileSync(join(dist, name)))]),
  );
  return {
    locale: new Intl.Collator().resolvedOptions().locale,
    node: process.versions.node,
    icu: process.versions.icu,
    ownerSha256: hash(readFileSync(modulePath)),
    moduleHashes,
    syntheticInvocations,
    eventCount: events.length,
    observations,
  };
}

function probe(modulePath, expectation) {
  const runs = [];
  for (const [locale, expectedLocale] of [
    ["en_US.UTF-8", "en-US"],
    ["sv_SE.UTF-8", "sv-SE"],
  ]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clawsweeper-label-proof-")));
    try {
      const env = { LANG: locale, LC_ALL: locale };
      for (const name of [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
      ]) {
        env[name] = join(root, name);
        mkdirSync(env[name]);
      }
      const child = spawnSync(process.execPath, [script, "--child", modulePath, root], {
        encoding: "utf8",
        env,
        timeout: 60_000,
      });
      const diagnostic = (child.stderr ?? "")
        .replaceAll(repository, "<repository>")
        .replaceAll(dirname(modulePath), "<build>")
        .replaceAll(root, "<scratch>");
      assert.equal(
        child.status,
        0,
        `${expectation} ${expectedLocale}: ${child.error?.code ?? child.signal ?? "child failed"}\n${diagnostic}`,
      );
      const run = JSON.parse(child.stdout);
      assert.equal(run.locale, expectedLocale);
      const [normal, , , , , , , ties, reversedTies] = run.observations;
      if (expectation === "candidate") {
        assert.equal(normal.identity, goldenIdentity);
        assert.deepEqual(normal.args, goldenArgs);
        assert.equal(ties.identity, reversedTies.identity);
        assert.equal(ties.businessKey, reversedTies.businessKey);
      } else {
        assert.notEqual(ties.identity, reversedTies.identity);
        assert.notEqual(ties.businessKey, reversedTies.businessKey);
      }
      runs.push(run);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.equal(runs[0].ownerSha256, runs[1].ownerSha256);
  assert.deepEqual(runs[0].moduleHashes, runs[1].moduleHashes);
  if (expectation === "candidate") {
    assert.deepEqual(runs[0].observations, runs[1].observations);
  } else {
    assert.notEqual(runs[0].observations[0].identity, runs[1].observations[0].identity);
    assert.notEqual(runs[0].observations[0].businessKey, runs[1].observations[0].businessKey);
  }
  return { verified: true, expectation, runs };
}

const args = process.argv.slice(2);
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or newer required");
if (args[0] === "--child") {
  assert.equal(args.length, 3);
  console.log(JSON.stringify(await record(realpathSync(args[1]), realpathSync(args[2]))));
} else {
  const modules = { candidate: join(repository, "dist/clawsweeper-label-mutations.js") };
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(
      ["--baseline", "--candidate"].includes(args[index]) && args[index + 1],
      "Use --baseline <compiled-module> and/or --candidate <compiled-module>",
    );
    modules[args[index].slice(2)] = resolve(args[index + 1]);
  }
  const result = {
    schema: 1,
    manifests: Object.fromEntries(
      ["package.json", "pnpm-lock.yaml", "tsconfig.json"].map((name) => [
        name,
        hash(readFileSync(join(repository, name))),
      ]),
    ),
    limits:
      "Real producer and persisted recorder; synthetic adapter invocations, no real apply/GitHub execution, execution deduplication or legacy-key migration.",
  };
  for (const [expectation, modulePath] of Object.entries(modules)) {
    result[expectation] = probe(realpathSync(modulePath), expectation);
  }
  console.log(JSON.stringify(result, null, 2));
}
