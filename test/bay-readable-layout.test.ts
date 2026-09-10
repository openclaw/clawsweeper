import assert from "node:assert/strict";
import test from "node:test";
import { bayLayoutCss, bayLayoutScript } from "../dashboard/bay-layout.ts";
import { bayHtml } from "../dashboard/bay-page.ts";
import { publicStatusProjection, publicStatusFreshness } from "../dashboard/worker.ts";

const stages = ["arriving", "setting-up", "reviewing", "publishing", "applying", "repairing"];
const labels = Object.fromEntries(stages.concat(["completed"]).map((stage) => [stage, stage]));
function harness(items: Array<{ key: string; stage: string; repository?: string }> = []) {
  const state = { items, filter: "all", pendingItems: null, data: null };
  const nodes = new Map<string, Record<string, unknown>>();
  const document = {
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, {});
      return nodes.get(id);
    },
    querySelectorAll() {
      return [];
    },
  };
  const helpers = new Function(
    "state",
    "document",
    "STAGES",
    "LABELS",
    "visible",
    "queueStageSummary",
    "esc",
    "clearLaneChat",
    "applyPendingItems",
    bayLayoutScript +
      ";return {areaRows,drawnLimit,areaCounts,areaCountCopy,sampleControl,selectArea,renderAreaNavigation,updateSnapshotLine};",
  )(
    state,
    document,
    stages,
    labels,
    (rows: typeof items) =>
      rows.filter((item) => state.filter === "all" || item.repository === state.filter),
    () => ({ label: "500" }),
    String,
    () => {},
    () => {},
  );
  return { state, nodes, helpers };
}

test("drawn slots are bounded independently of aggregate counts, without losing sample rows", () => {
  const items = Array.from({ length: 24 }, (_, index) => ({
    key: String(index).padStart(2, "0"),
    stage: "reviewing",
  }));
  const { helpers } = harness(items);
  assert.deepEqual(helpers.areaCounts("reviewing"), { sampled: 24, drawn: 3, aggregate: "500" });
  assert.equal(helpers.areaRows("reviewing").length, 24);
  assert.match(helpers.sampleControl("reviewing"), /\+21 sampled items/);
  assert.doesNotMatch(helpers.sampleControl("reviewing"), /497/);
  assert.equal(helpers.drawnLimit("completed"), 4);
  assert.equal(helpers.drawnLimit("attention"), 2);
});

test("same bounded sample has stable ordering across input reordering", () => {
  const items = [
    { key: "z", stage: "reviewing" },
    { key: "a", stage: "reviewing" },
    { key: "m", stage: "reviewing" },
  ];
  const { state, helpers } = harness(items);
  const first = helpers.areaRows("reviewing").map((item: { key: string }) => item.key);
  state.items = [...items].reverse();
  assert.deepEqual(
    helpers.areaRows("reviewing").map((item: { key: string }) => item.key),
    first,
  );
  assert.deepEqual(first, ["a", "m", "z"]);
});

test("failed and cancelled remain separately identifiable in a shared reachable area", () => {
  const { helpers } = harness([
    { key: "f", stage: "failed" },
    { key: "c", stage: "cancelled" },
    { key: "s", stage: "completed" },
  ]);
  assert.deepEqual(
    helpers.areaRows("attention").map((item: { stage: string }) => item.stage),
    ["cancelled", "failed"],
  );
  assert.equal(helpers.areaRows("completed").length, 1);
  assert.match(helpers.sampleControl("attention"), /View sampled items/);
});

test("attention sample rows display each exact terminal outcome", () => {
  const rows = [
    { key: "f", stage: "failed", repository: "openclaw/openclaw", number: 1 },
    { key: "c", stage: "cancelled", repository: "openclaw/openclaw", number: 2 },
  ];
  const body = { innerHTML: "", scrollTop: 0, contains: () => false };
  const drawer = { open: true, dataset: {} };
  const document = {
    getElementById: (id: string) =>
      id === "queue-sample-body" ? body : id === "queue-sample-drawer" ? drawer : {},
  };
  const source = bayHtml()
    .split("<script>")[1]!
    .split("</script>")[0]!
    .split("\n")
    .find((line) => line.startsWith("  function openQueueSampleDrawer("))!;
  new Function(
    "document",
    "BAY_AREAS",
    "areaRows",
    "drawnLimit",
    "areaLabel",
    "areaCountCopy",
    "areaForItem",
    "LABELS",
    "esc",
    source + ';openQueueSampleDrawer("attention");',
  )(
    document,
    ["attention"],
    () => rows,
    () => 2,
    () => "Failed / cancelled",
    () => "2 sampled",
    () => "attention",
    { failed: "Failed", cancelled: "Cancelled" },
    String,
  );
  assert.ok(body.innerHTML.includes("#1</button><span>Failed · drawn"));
  assert.ok(body.innerHTML.includes("#2</button><span>Cancelled · drawn"));
});

test("proof source manifest excludes private generated and untracked files", async () => {
  const fs = await import("node:fs/promises");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const script = await fs.readFile(
    new URL("../docs/proof/bay-readable-layout/run-proof.sh", import.meta.url),
    "utf8",
  );
  const prefix = "node --input-type=module -e '";
  const line = script.split("\n").find((value) => value.startsWith(prefix))!;
  assert.ok(line, "manifest command must exist");
  assert.ok(!script.includes("git ls-files --others"), "do not publish private untracked paths");
  const root = await fs.mkdtemp(join(tmpdir(), "bay-source-manifest-"));
  try {
    await fs.mkdir(join(root, ".crabbox/captures"), { recursive: true });
    await fs.mkdir(join(root, "proof-output"));
    await fs.writeFile(join(root, "candidate.ts"), "export const candidate = true;");
    await fs.writeFile(join(root, "deleted.ts"), "deleted");
    await fs.writeFile(join(root, "private-untracked.txt"), "private sentinel");
    await fs.writeFile(join(root, ".crabbox/captures/private.tar"), "private archive sentinel");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const guarded = spawnSync(
      "bash",
      [new URL("../docs/proof/bay-readable-layout/run-proof.sh", import.meta.url).pathname],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BAY_PROOF_PROVIDER: "test",
          BAY_PROOF_LEASE: "test",
          BAY_PROOF_IMAGE: "test",
          BAY_PROOF_CANDIDATE: "test",
          PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/unused",
          BAY_PROOF_OUTPUT: join(root, "untracked-proof-output"),
        },
      },
    );
    assert.notEqual(
      guarded.status,
      0,
      "missing synced source index entries must fail before setup",
    );
    assert.match(guarded.stderr, /did not match any file/);
    assert.equal(
      await fs.access(join(root, "untracked-proof-output")).then(
        () => true,
        () => false,
      ),
      false,
    );
    execFileSync("git", ["add", "candidate.ts", "deleted.ts", ".crabbox/captures/private.tar"], {
      cwd: root,
    });
    await fs.unlink(join(root, "deleted.ts"));
    const emptyTree = execFileSync("git", ["hash-object", "-w", "-t", "tree", "--stdin"], {
      cwd: root,
      input: "",
      encoding: "utf8",
    }).trim();
    const patchLine = script
      .split("\n")
      .find((value) => value.startsWith("git diff --binary HEAD"))!;
    execFileSync("bash", ["-c", patchLine.replace(" HEAD ", " " + emptyTree + " ")], {
      cwd: root,
      env: { ...process.env, BAY_PROOF_OUTPUT: join(root, "proof-output") },
    });
    const patch = await fs.readFile(join(root, "proof-output/candidate.patch"), "utf8");
    assert.ok(patch.includes("candidate.ts"));
    assert.match(
      patch,
      /index [a-f0-9]{40}\.\.[a-f0-9]{40}/,
      "patch identity must not depend on Git abbreviation settings",
    );
    assert.ok(!patch.includes(".crabbox"));
    assert.ok(!patch.includes("private archive sentinel"));
    assert.ok(!patch.includes("private-untracked"));
    execFileSync(process.execPath, ["--input-type=module", "-e", line.slice(prefix.length, -1)], {
      cwd: root,
      env: { ...process.env, BAY_PROOF_OUTPUT: join(root, "proof-output") },
    });
    const manifest = JSON.parse(
      await fs.readFile(join(root, "proof-output/source-manifest.json"), "utf8"),
    );
    assert.deepEqual(
      manifest.map((row: { path: string }) => row.path),
      ["candidate.ts"],
    );
    assert.match(manifest[0].sha256, /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("proof rejects mismatched candidate provenance before starting Workers", async () => {
  const fs = await import("node:fs/promises");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const root = await fs.mkdtemp(join(tmpdir(), "bay-candidate-provenance-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Proof test",
        "-c",
        "user.email=proof@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    const paths = [
      "dashboard/bay-layout.ts",
      "test/bay-readable-layout.test.ts",
      ...[
        "README.md",
        "fixture-worker.mjs",
        "fixtures.mjs",
        "run-proof.mjs",
        "run-proof.sh",
        "settled-master.mjs",
        "wrangler.toml",
      ].map((name) => "docs/proof/bay-readable-layout/" + name),
    ];
    for (const path of paths) {
      await fs.mkdir(dirname(join(root, path)), { recursive: true });
      await fs.writeFile(join(root, path), "controlled source fixture");
    }
    execFileSync("git", ["add", "-N", "--", ...paths], { cwd: root });
    const result = spawnSync(
      "bash",
      [new URL("../docs/proof/bay-readable-layout/run-proof.sh", import.meta.url).pathname],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BAY_PROOF_PROVIDER: "test",
          BAY_PROOF_LEASE: "test",
          BAY_PROOF_IMAGE: "test",
          BAY_PROOF_CANDIDATE: "mistyped-candidate",
          PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/unused",
          BAY_PROOF_SCRATCH: join(root, "scratch"),
          BAY_PROOF_OUTPUT: join(root, "output"),
        },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Candidate provenance does not match/);
    assert.equal(
      await fs.access(join(root, "output/after-worker.log")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("first populated area is chosen once; explicit selection survives empty refresh and resize", () => {
  const { state, helpers, nodes } = harness([{ key: "r", stage: "reviewing" }]);
  helpers.renderAreaNavigation();
  assert.equal(nodes.get("focused-stage")!.value, "reviewing");
  helpers.selectArea("attention");
  state.items = [];
  helpers.renderAreaNavigation();
  assert.equal(nodes.get("focused-stage")!.value, "attention");
  assert.equal(nodes.get("next-stage")!.disabled, true);
  helpers.selectArea("not-a-stage");
  assert.equal(nodes.get("focused-stage")!.value, "attention");
  helpers.selectArea("arriving");
  assert.equal(nodes.get("previous-stage")!.disabled, true);
  const options = String(nodes.get("focused-stage")!.innerHTML);
  assert.ok(options.indexOf('value="applying"') < options.indexOf('value="repairing"'));
  assert.equal((options.match(/<option/g) || []).length, 8);
});

test("repository filtering limits samples without presenting global totals as per-repo totals", () => {
  const { state, helpers } = harness([
    { key: "a", stage: "reviewing", repository: "o/a" },
    { key: "b", stage: "reviewing", repository: "o/b" },
  ]);
  state.filter = "o/a";
  assert.equal(helpers.areaRows("reviewing").length, 1);
  // The real queueStageSummary supplies filtered counts; this stub only tests
  // the presentation prefix, not the aggregate calculation.
  assert.match(helpers.areaCountCopy("reviewing"), /^Filtered sample /);
});

test("page keeps one real inline-proof control, no retired/demo control, and valid executable script", () => {
  const html = bayHtml();
  assert.equal((html.match(/id="inline-proof-filter"/g) || []).length, 1);
  assert.ok(html.includes("includeLegacyBatch:true"));
  assert.ok(!html.includes('id="legacy-proof-toggle"'));
  assert.ok(!html.includes("Design study"));
  assert.ok(!html.includes("Typical/Crowded"));
  const script = html.split("<script>")[1]!.split("</script>")[0]!;
  new Function(script);
});

test("proof fixtures conform to the current browser's closed status contract", async () => {
  const { statusFixture, scenarios, repositories } =
    await import("../docs/proof/bay-readable-layout/fixtures.mjs");
  const script = bayHtml().split("<script>")[1]!.split("</script>")[0]!;
  const validator = script.slice(
    script.indexOf("  var MAX_BAY_COUNT="),
    script.indexOf("  function hash("),
  );
  const parse = new Function("STAGES", validator + ";return publicBayStatus;")(stages);
  const epoch = Date.parse("2026-09-09T18:00:01Z");
  for (const scenario of scenarios) {
    const fixture = statusFixture(scenario, epoch);
    const projected = publicStatusProjection(fixture, new Set(repositories));
    assert.deepEqual(projected.exact_review_queue.collection, { state: "complete" }, scenario);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_UI_FIXTURE_SENTINEL|invalid\.example/);
    projected.freshness = publicStatusFreshness(fixture, "fresh", 60000, epoch);
    const result = parse(projected);
    assert.equal(result.privacy.state, "complete", scenario);
    assert.equal(
      result.bay.timings.including_legacy_batch.overall.samples,
      scenario === "empty" ? 0 : 5,
      scenario,
    );
    if (scenario === "unknown") assert.equal(result.bay.timings.inline_proof, null);
    else assert.ok(result.bay.timings.inline_proof);
    const expected =
      scenario === "partial-activity"
        ? fixture.exact_review_queue.bay_projection.items.length
        : fixture.exact_review_queue.bay_projection.activity.items.length;
    assert.equal(
      result.exact_review_queue.bay_projection.activity.items.length,
      expected,
      scenario,
    );
  }
});

// Use the actual production reconstruction chain. Only DOM rendering and visual
// animation adapters are inert here; buildItems/confirmation are never stubbed.
async function reviewPathReconstructionHarness(scenario = "normal") {
  const { statusFixture, repositories } =
    await import("../docs/proof/bay-readable-layout/fixtures.mjs");
  let now = Date.parse("2026-09-09T18:00:01Z");
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const snapshot = statusFixture(scenario, now);
  const script = bayHtml().split("<script>")[1]!.split("</script>")[0]!;
  const validator = script.slice(
    script.indexOf("  var MAX_BAY_COUNT="),
    script.indexOf("  function hash("),
  );
  const sourceOf = (name: string) => {
    const source = script.split("\n").find((line) => line.startsWith("  function " + name + "("));
    assert.ok(source, "Missing production helper: " + name);
    return source;
  };
  const source = [
    "expandQueue",
    "terminalRows",
    "retainedWashedRows",
    "retainedWashAvailable",
    "runChanged",
    "transitionKind",
    "buildItems",
    "reconcileConfirmingOutcomes",
    "applyPendingItems",
    "selectReviewPaths",
    "flushPendingForNavigation",
  ]
    .map(sourceOf)
    .join("\n");
  const state = {
    data: null as any,
    items: [] as any[],
    includeLegacyBatch: true,
    previousRuns: {} as Record<string, any>,
    confirmingOutcomes: {} as Record<string, any>,
    pendingItems: null as any[] | null,
    pendingTransitionKey: null,
    pendingTransitionKind: null,
    consumedDirectTideGeneration: null,
    consumedLegacyTideGeneration: null,
    masterSequence: 0,
    masterPending: false,
    found: null,
  };
  const control = { value: "all" };
  const document = { activeElement: control, getElementById: () => control };
  const adapters = {
    renderRepos() {},
    render() {},
    updateTide() {},
    updateSampleNote() {},
    openDrawerFromHash() {},
    showToast() {},
    parkMaster() {
      state.masterSequence++;
    },
    masterReduced() {
      return true;
    },
    afterMasterRests() {},
    fetch() {
      throw new Error("View selection must not fetch or mutate remote work");
    },
  };
  const runtime = new Function(
    "STAGES",
    "MAIN_STAGES",
    "OUTCOME_CONFIRM_MS",
    "state",
    "document",
    "Date",
    ...Object.keys(adapters),
    validator +
      source +
      ";return {publicBayStatus,buildItems,selectReviewPaths,setCohort(value){inlineProofFilter=value},cohort(){return inlineProofFilter}};",
  )(
    stages,
    stages.filter((stage) => stage !== "repairing"),
    150000,
    state,
    document,
    Clock,
    ...Object.values(adapters),
  );
  const refresh = (raw: any) => {
    const projected = publicStatusProjection(raw, new Set(repositories));
    assert.equal(projected.exact_review_queue.collection.state, "complete");
    projected.freshness = publicStatusFreshness(raw, "fresh", 60000, now);
    const data = runtime.publicBayStatus(projected);
    assert.equal(data.privacy.state, "complete");
    state.data = data;
    state.items = runtime.buildItems(data, false);
  };
  const select = (value: string) => {
    control.value = value;
    runtime.selectReviewPaths();
  };
  refresh(snapshot);
  return {
    snapshot,
    state,
    control,
    document,
    runtime,
    refresh,
    select,
    advance(ms: number) {
      now += ms;
    },
  };
}

function withoutLiveReference(snapshot: any, reference: any) {
  const next = structuredClone(snapshot);
  const activity = next.exact_review_queue.bay_projection.activity;
  activity.items = activity.items.filter(
    (row: any) =>
      !(
        row.source === "live" &&
        row.repository === reference.repository &&
        row.item_number === reference.number
      ),
  );
  activity.live_stages[reference.stage]--;
  if (reference.legacy_batch_path) activity.live_legacy_batch_stages[reference.stage]--;
  activity.total--;
  next.bay.active_stages = { ...activity.live_stages };
  return next;
}

for (const pending of [false, true]) {
  test(
    "review-path reconstruction does not resurrect filtered work" +
      (pending ? " after flushing pending visuals" : ""),
    async () => {
      const h = await reviewPathReconstructionHarness();
      const identities = (rows: any[]) =>
        rows.map((row) => [row.source, row.repository, row.number, row.stage].join(":")).sort();
      const all = [...h.state.items];
      assert.equal(
        all.filter((row) => row.legacy_batch_path && !row.outcome).length,
        1,
        "same one-row active fallback as the failed runtime case",
      );
      h.runtime.setCohort("requested");
      if (pending) h.state.pendingItems = [...h.state.items];
      h.select("direct");
      assert.deepEqual(
        h.state.items
          .filter((row) => row.legacy_batch_path)
          .map((row) => ({ key: row.key, confirming: row.confirming })),
        [],
        "view filtering is not evidence that work disappeared",
      );
      assert.deepEqual(
        identities(h.state.items),
        identities(all.filter((row) => !row.legacy_batch_path)),
      );
      assert.deepEqual(Object.keys(h.state.confirmingOutcomes), []);
      assert.equal(h.runtime.cohort(), "requested");
      assert.equal(h.document.activeElement, h.control);
      assert.equal(h.state.pendingItems, null);
      h.select("all");
      assert.deepEqual(identities(h.state.items), identities(all));
      assert.ok(h.state.items.every((row) => !row.confirming && !row.retriggered));
      assert.equal(h.runtime.cohort(), "requested");
    },
  );
}

for (const view of ["all", "direct"]) {
  test("real refresh still confirms and resolves disappearing " + view + "-path work", async () => {
    const h = await reviewPathReconstructionHarness("batch");
    h.select(view);
    const missing = h.state.items.find(
      (row) => row.source === "live" && row.legacy_batch_path === (view === "all"),
    );
    assert.ok(missing);
    const next = withoutLiveReference(h.snapshot, missing);
    h.refresh(next);
    assert.equal(h.state.items.find((row) => row.key === missing.key)?.confirming, true);
    assert.equal(h.state.items.find((row) => row.key === missing.key)?.outcome, null);
    const since = h.state.confirmingOutcomes[missing.key].since;
    h.advance(149999);
    h.refresh(next);
    assert.equal(
      h.state.confirmingOutcomes[missing.key].since,
      since,
      "polling must not renew the confirmation deadline",
    );
    const final = structuredClone(next);
    final.bay.terminal_buffer.push({
      repository: missing.repository,
      item_number: missing.number,
      legacy_batch_path: missing.legacy_batch_path,
      outcome: "success",
      journey_duration_ms: 60000,
    });
    final.bay.terminal_count = final.bay.terminal_buffer.length;
    h.refresh(final);
    const resolved = h.state.items.filter(
      (row) => row.repository === missing.repository && row.number === missing.number,
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].outcome, "success");
    assert.ok(!resolved[0].confirming);
    assert.equal(h.state.confirmingOutcomes[missing.key], undefined);
  });

  test(
    "real refresh confirmation expires without inventing an outcome in " + view + " paths",
    async () => {
      const h = await reviewPathReconstructionHarness("batch");
      h.select(view);
      const missing = h.state.items.find(
        (row) => row.source === "live" && row.legacy_batch_path === (view === "all"),
      );
      assert.ok(missing);
      const next = withoutLiveReference(h.snapshot, missing);
      h.refresh(next);
      assert.equal(h.state.items.find((row) => row.key === missing.key)?.confirming, true);
      h.advance(150001);
      h.refresh(next);
      assert.ok(
        !h.state.items.some(
          (row) => row.repository === missing.repository && row.number === missing.number,
        ),
      );
      assert.equal(h.state.confirmingOutcomes[missing.key], undefined);
    },
  );
}

async function terminalSampleHarness(currentCount = 19, washedCount = 20, threshold = 20) {
  const { statusFixture, repositories } =
    await import("../docs/proof/bay-readable-layout/fixtures.mjs");
  const snapshot = statusFixture("normal", Date.parse("2026-09-09T18:00:01Z"));
  const row = (number: number, index: number) => ({
    repository: "openclaw/openclaw",
    item_number: number,
    outcome: ["success", "failure", "cancelled"][index % 3],
    journey_duration_ms: 1000,
    legacy_batch_path: index % 3 === 0,
  });
  const current = Array.from({ length: currentCount }, (_, index) => row(1000 + index, index));
  const washed = Array.from({ length: washedCount }, (_, index) => row(2000 + index, index));
  Object.assign(snapshot.bay, {
    tide_threshold: threshold,
    terminal_count: currentCount,
    tide_generation: 7,
    terminal_buffer: current,
    recently_washed: washed,
    last_tide_at: "2026-09-09T18:00:00Z",
    washed_at: "2026-09-09T18:00:00Z",
  });
  const script = bayHtml().split("<script>")[1]!.split("</script>")[0]!;
  const validator = script.slice(
    script.indexOf("  var MAX_BAY_COUNT="),
    script.indexOf("  function hash("),
  );
  const helpers = script.slice(
    script.indexOf("  function terminalRows("),
    script.indexOf("  function runChanged("),
  );
  const state = {
    includeLegacyBatch: true,
    consumedDirectTideGeneration: null as number | null,
    consumedLegacyTideGeneration: null as number | null,
  };
  const runtime = new Function(
    "STAGES",
    "state",
    validator + helpers + ";return {publicBayStatus,terminalRows};",
  )(stages, state);
  const project = () => publicStatusProjection(snapshot, new Set(repositories));
  const parse = () => {
    const projected = project();
    projected.freshness = publicStatusFreshness(
      snapshot,
      "fresh",
      60000,
      Date.parse(snapshot.generated_at),
    );
    return runtime.publicBayStatus(projected);
  };
  return { snapshot, current, washed, state, runtime, project, parse };
}

test("canonical remainder plus retained tide keeps all 39 identities, independently of drawn slots", async () => {
  const { EXACT_REVIEW_LIFECYCLE_BAY_TIDE_THRESHOLD: threshold } =
    await import("../dashboard/exact-review-lifecycle-telemetry.ts");
  const h = await terminalSampleHarness(threshold - 1, threshold, threshold);
  const model = h.parse();
  assert.equal(model.privacy.state, "complete");
  const numbers = (rows: Array<{ number: number }>) => rows.map((row) => row.number);
  const expected = h.washed.concat(h.current);
  assert.deepEqual(
    numbers(h.runtime.terminalRows(model, true)),
    expected.map((row) => row.item_number),
  );
  assert.equal(expected.length, threshold * 2 - 1);
  assert.deepEqual(
    numbers(h.runtime.terminalRows(model, false)),
    h.current.map((row) => row.item_number),
  );
  h.state.includeLegacyBatch = false;
  assert.deepEqual(
    numbers(h.runtime.terminalRows(model, true)),
    expected.filter((row) => !row.legacy_batch_path).map((row) => row.item_number),
  );
  h.state.includeLegacyBatch = true;
  h.state.consumedDirectTideGeneration = 7;
  assert.deepEqual(
    numbers(h.runtime.terminalRows(model, true)),
    h.washed
      .filter((row) => row.legacy_batch_path)
      .concat(h.current)
      .map((row) => row.item_number),
  );
  h.state.consumedLegacyTideGeneration = 7;
  assert.deepEqual(
    numbers(h.runtime.terminalRows(model, true)),
    h.current.map((row) => row.item_number),
  );
});

test("existing client buffer envelope is retained without widening the canonical producer limit", async () => {
  // Canonical telemetry produces at most 19+20. The unchanged closed client
  // additionally accepts each array through its validated threshold (ceiling
  // 100). Exercise those existing compatibility edges, not new API limits.
  for (const [current, washed, threshold] of [
    [0, 0, 20],
    [1, 20, 20],
    [20, 20, 20],
    [100, 100, 100],
  ]) {
    const h = await terminalSampleHarness(current, washed, threshold);
    const model = h.parse();
    assert.equal(model.privacy.state, "complete");
    assert.equal(h.runtime.terminalRows(model, true).length, current + washed);
    assert.equal(h.runtime.terminalRows(model, false).length, current);
  }
});

test("over-threshold buffers, count drift and malformed outcomes remain fail-closed", async () => {
  const cases: Array<[string, (snapshot: any) => void]> = [
    [
      "current buffer above threshold",
      (snapshot) => {
        snapshot.bay.terminal_buffer.push(
          ...Array.from({ length: 2 }, (_, index) => ({
            ...snapshot.bay.terminal_buffer[0],
            item_number: 5000 + index,
          })),
        );
        snapshot.bay.terminal_count = 21;
      },
    ],
    [
      "washed buffer above threshold",
      (snapshot) => {
        snapshot.bay.recently_washed.push({
          ...snapshot.bay.recently_washed[0],
          item_number: 5000,
        });
      },
    ],
    [
      "threshold above existing ceiling",
      (snapshot) => {
        snapshot.bay.tide_threshold = 101;
      },
    ],
    [
      "count differs from buffer",
      (snapshot) => {
        snapshot.bay.terminal_count--;
      },
    ],
    [
      "unknown outcome",
      (snapshot) => {
        snapshot.bay.terminal_buffer[0].outcome = "unknown";
      },
    ],
    [
      "missing duration",
      (snapshot) => {
        delete snapshot.bay.terminal_buffer[0].journey_duration_ms;
      },
    ],
    [
      "negative duration",
      (snapshot) => {
        snapshot.bay.terminal_buffer[0].journey_duration_ms = -1;
      },
    ],
    [
      "invalid reference",
      (snapshot) => {
        snapshot.bay.terminal_buffer[0].item_number = 0;
      },
    ],
    [
      "private reference",
      (snapshot) => {
        snapshot.bay.terminal_buffer[0].repository = "private/SECRET_SENTINEL";
      },
    ],
  ];
  for (const [name, corrupt] of cases) {
    const h = await terminalSampleHarness();
    corrupt(h.snapshot);
    const model = h.parse();
    assert.equal(model.privacy.state, "unknown", name);
    assert.equal(h.runtime.terminalRows(model, true).length, 0, name);
    assert.doesNotMatch(JSON.stringify(model), /SECRET_SENTINEL/i);
  }
  const h = await terminalSampleHarness(0, 100, 100);
  h.snapshot.bay.recently_washed.push({ ...h.washed[0], item_number: 5000 });
  assert.deepEqual(
    h.project().bay.recently_washed,
    [],
    "the unchanged Worker rejects an over-100 array instead of returning its first 100 rows",
  );
});

test("inline timing qualifications are accessible without a pointer tooltip", () => {
  const html = bayHtml();
  assert.ok(html.includes('aria-describedby="inline-proof-note inline-proof-scope"'));
  const scope = html.match(/<span id="inline-proof-scope"[^>]*>([^<]+)<\/span>/)?.[1];
  assert.ok(scope?.includes("Request does not mean execution"));
  assert.ok(scope?.includes("Repository filters affect only the beach"));
  assert.ok(scope?.includes("this inline-proof control selects timing only"));
});

test("finder flushes pending transitions and focuses a freshly queried result", () => {
  const script = bayHtml().split("<script>")[1]!.split("</script>")[0]!;
  const source = script.split("\n").find((line) => line.startsWith("  function findBayItem("))!;
  const row = {
    id: "live:direct:openclaw/openclaw#77",
    key: "direct:openclaw/openclaw#77",
    repository: "openclaw/openclaw",
    number: 77,
    stage: "reviewing",
  };
  const state = {
    items: [row],
    pendingItems: [{ ...row, stage: "publishing" }] as (typeof row)[] | null,
    masterPhase: "sweeping",
    masterPending: true,
    masterSequence: 4,
    found: null as string | null,
    filter: "all",
  };
  const order: string[] = [];
  let generation = 0,
    focusedGeneration = -1,
    selectedArea = "",
    opened = "",
    drawn = true;
  const nodes = {
    finder: { classList: { remove() {}, add() {} }, offsetWidth: 1 },
    "finder-input": { value: "#77" },
    "finder-status": { textContent: "" },
  };
  const document = {
    getElementById(id: keyof typeof nodes) {
      return nodes[id];
    },
    querySelectorAll() {
      const createdAt = generation;
      return drawn
        ? [
            {
              getAttribute() {
                return row.key;
              },
              focus() {
                focusedGeneration = createdAt;
              },
            },
          ]
        : [];
    },
  };
  const helpers = {
    state,
    document,
    fmt: String,
    render() {
      generation++;
    },
    selectArea(area: string) {
      selectedArea = area;
      generation++;
    },
    areaForItem(item: typeof row) {
      return item.stage;
    },
    parkMaster(immediate: boolean) {
      assert.equal(immediate, true);
      order.push("park");
      state.masterPhase = "resting";
      state.masterSequence++;
    },
    masterReduced() {
      return false;
    },
    afterMasterRests(token: number) {
      assert.equal(token, state.masterSequence);
      order.push("resume");
    },
    applyPendingItems() {
      order.push("apply");
      state.items = state.pendingItems!;
      state.pendingItems = null;
      generation++;
    },
    openDrawer(id: string) {
      opened = id;
    },
    showToast() {},
  };
  const flush = bayLayoutScript
    .split("\n")
    .find((line) => line.startsWith("  function flushPendingForNavigation("))!;
  const find = new Function(...Object.keys(helpers), flush + source + ";return findBayItem;")(
    ...Object.values(helpers),
  );
  find({ preventDefault() {} });
  assert.equal(state.pendingItems, null);
  assert.equal(selectedArea, "publishing");
  assert.deepEqual(order, ["park", "apply", "resume"]);
  assert.equal(state.masterPhase, "resting");
  assert.equal(state.masterPending, false);
  assert.equal(state.masterSequence, 5);
  assert.equal(focusedGeneration, generation, "must not focus the detached pre-selection node");
  drawn = false;
  find({ preventDefault() {} });
  assert.equal(opened, row.id, "an undrawn sample result remains reachable in the inspector");
});

test("fixture collection validity is derived from raw telemetry, not a claimed complete flag", async () => {
  const { statusFixture, repositories } =
    await import("../docs/proof/bay-readable-layout/fixtures.mjs");
  const mutations: Array<[string, (queue: Record<string, any>) => void]> = [
    [
      "missing queue observation time",
      (queue) => {
        delete queue.generated_at;
      },
    ],
    [
      "mismatched handoff observation",
      (queue) => {
        queue.handoff_health.observed_at = "2026-09-09T17:59:00Z";
      },
    ],
    [
      "unbalanced lane depth",
      (queue) => {
        queue.lanes.review.pending_depth++;
      },
    ],
    [
      "unbalanced pressure",
      (queue) => {
        queue.pressure.pending++;
      },
    ],
    [
      "unbalanced retry reasons",
      (queue) => {
        queue.lanes.review.backoff_reasons.review_retry = 1;
      },
    ],
    [
      "unbalanced failure health",
      (queue) => {
        queue.review_failure_health.by_stage.workflow = 1;
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const fixture = statusFixture("normal", Date.parse("2026-09-09T18:00:01Z"));
    mutate(fixture.exact_review_queue);
    assert.equal(fixture.exact_review_queue.collection.state, "complete");
    const projected = publicStatusProjection(fixture, new Set(repositories));
    assert.deepEqual(
      projected.exact_review_queue.collection,
      { state: "unknown", reason: "malformed" },
      name,
    );
  }
});

// Small semantic DOM double for focus policy only. The Worker/browser matrix
// remains the required evidence for actual native dialog and keyboard behavior.
function modalFocusHarness() {
  const nodes: any[] = [];
  let phone = false;
  const document: any = {
    activeElement: null,
    querySelectorAll: () => nodes.filter((node) => node.isConnected),
    getElementById: (id: string) => nodes.find((node) => node.isConnected && node.id === id),
  };
  function node(id: string, options: Record<string, any> = {}) {
    const value: any = {
      id,
      tabIndex: 0,
      dataset: {},
      parentElement: null,
      isConnected: true,
      open: false,
      isDialog: false,
      disabled: false,
      fieldsetDisabled: false,
      hidden: false,
      inert: false,
      ariaHidden: false,
      ariaDisabled: false,
      rects: true,
      type: "",
      name: "",
      form: null,
      checked: false,
      style: {
        display: "block",
        visibility: "visible",
        opacity: "1",
        contentVisibility: "visible",
      },
      ...options,
      focus() {
        document.activeElement = value;
      },
      getClientRects() {
        return value.rects ? [{}] : [];
      },
      matches(selector: string) {
        if (selector === 'input[type="radio"]') return value.type === "radio";
        if (selector === ':disabled,input[type="hidden"]')
          return value.disabled || value.fieldsetDisabled || value.type === "hidden";
        throw new Error("Unexpected test selector: " + selector);
      },
      closest(selector: string) {
        for (let current: any = value; current; current = current.parentElement) {
          if (
            selector === "dialog"
              ? current.isDialog
              : current.hidden || current.inert || current.ariaHidden || current.ariaDisabled
          )
            return current;
        }
        return null;
      },
      contains(other: any) {
        for (let current = other; current; current = current.parentElement)
          if (current === value) return true;
        return false;
      },
      querySelectorAll() {
        return nodes.filter(
          (candidate) => candidate !== value && candidate.isConnected && value.contains(candidate),
        );
      },
    };
    nodes.push(value);
    return value;
  }
  const api = new Function(
    "document",
    "window",
    "STAGES",
    "portraitLayout",
    bayLayoutScript +
      ";return {topBayDialog,bayDialogTabbables,containBayDialogTab,rememberDialogFocus,restoreDialogFocus,rememberBayNavigationFocus,restoreBayNavigationFocus,restoreBayItemFocus};",
  )(document, { getComputedStyle: (element: any) => element.style }, stages, () => phone);
  const open = (dialog: any, opener: any) => {
    document.activeElement = opener;
    api.rememberDialogFocus(dialog);
    dialog.open = true;
  };
  const key = (overrides: Record<string, unknown> = {}) => {
    const event: any = {
      key: "Tab",
      shiftKey: false,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      ...overrides,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    api.containBayDialogTab(event);
    return event;
  };
  return {
    api,
    document,
    node,
    open,
    key,
    phone(value: boolean) {
      phone = value;
    },
  };
}

test("Tab wraps within the most recently opened modal, not the last dialog in DOM order", () => {
  const h = modalFocusHarness();
  const beach = h.node("beach-opener");
  const item = h.node("drawer", { isDialog: true }); // Earlier in document order.
  const itemFirst = h.node("drawer-close", { parentElement: item });
  const itemLast = h.node("public-link", { parentElement: item });
  const sample = h.node("queue-sample-drawer", { isDialog: true });
  h.node("queue-sample-close", { parentElement: sample });
  const entry = h.node("", {
    parentElement: sample,
    dataset: { overflowReference: "direct:repo#1" },
  });
  h.open(sample, beach);
  h.open(item, entry);
  assert.equal(h.api.topBayDialog(), item);
  itemLast.focus();
  assert.equal(h.key().defaultPrevented, true);
  assert.equal(h.document.activeElement, itemFirst);
  assert.equal(h.key({ shiftKey: true }).defaultPrevented, true);
  assert.equal(h.document.activeElement, itemLast);
  itemFirst.focus();
  assert.equal(h.key().defaultPrevented, false, "interior navigation stays native");
  beach.focus();
  assert.equal(h.key().defaultPrevented, true);
  assert.equal(
    h.document.activeElement,
    itemFirst,
    "escaped programmatic focus re-enters the top modal",
  );
});

test("only visible enabled local tabbables participate, in browser tabindex order", () => {
  const h = modalFocusHarness(),
    modal = h.node("drawer", { isDialog: true });
  const close = h.node("close", { parentElement: modal });
  h.node("two", { parentElement: modal, tabIndex: 2 });
  h.node("one", { parentElement: modal, tabIndex: 1 });
  h.node("disabled", { parentElement: modal, disabled: true });
  h.node("disabled-fieldset", { parentElement: modal, fieldsetDisabled: true });
  h.node("hidden-input", { parentElement: modal, type: "hidden" });
  h.node("negative", { parentElement: modal, tabIndex: -1 });
  h.node("no-layout-box", { parentElement: modal, rects: false });
  h.node("visibility-hidden", { parentElement: modal, style: { visibility: "hidden" } });
  h.node("inert", { parentElement: modal, inert: true });
  h.node("aria-disabled", { parentElement: modal, ariaDisabled: true });
  const transparent = h.node("transparent-parent", {
    parentElement: modal,
    tabIndex: -1,
    style: { opacity: "0" },
  });
  h.node("transparent-child", { parentElement: transparent });
  const inner = h.node("inner-dialog", { parentElement: modal, isDialog: true, tabIndex: -1 });
  h.node("inner-control", { parentElement: inner });
  const last = h.node("last", { parentElement: modal });
  assert.deepEqual(
    h.api.bayDialogTabbables(modal).map((element: any) => element.id),
    ["one", "two", close.id, last.id],
  );
});

test("radio groups expose their checked eligible member or first eligible fallback", () => {
  const h = modalFocusHarness(),
    modal = h.node("drawer", { isDialog: true });
  h.node("radio-first", { parentElement: modal, type: "radio", name: "choice" });
  const checked = h.node("radio-checked", {
    parentElement: modal,
    type: "radio",
    name: "choice",
    checked: true,
  });
  assert.deepEqual(
    h.api.bayDialogTabbables(modal).map((element: any) => element.id),
    ["radio-checked"],
  );
  checked.disabled = true;
  assert.deepEqual(
    h.api.bayDialogTabbables(modal).map((element: any) => element.id),
    ["radio-first"],
  );
});

test("no eligible tab stops falls back to the top dialog itself", () => {
  const h = modalFocusHarness(),
    beach = h.node("opener"),
    modal = h.node("drawer", { isDialog: true });
  h.node("disabled-close", { parentElement: modal, disabled: true });
  h.open(modal, beach);
  assert.equal(h.key().defaultPrevented, true);
  assert.equal(h.document.activeElement, modal);
  assert.equal(h.key({ shiftKey: true }).defaultPrevented, true);
  assert.equal(h.document.activeElement, modal);
});

test("browser shortcuts, consumed events, composition and Escape retain native behavior", () => {
  const h = modalFocusHarness(),
    beach = h.node("opener"),
    modal = h.node("drawer", { isDialog: true });
  const close = h.node("close", { parentElement: modal });
  h.open(modal, beach);
  close.focus();
  for (const modifiers of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
    { key: "Escape" },
    { key: "ArrowRight" },
  ]) {
    assert.equal(h.key(modifiers).defaultPrevented, false);
    assert.equal(h.document.activeElement, close);
  }
  beach.focus();
  h.key({ defaultPrevented: true });
  assert.equal(h.document.activeElement, beach, "respect a widget that already consumed Tab");
  modal.open = false;
  assert.equal(h.key().defaultPrevented, false, "no trap after the modal closes");
});

test("removed or hidden rendered references use a visible fallback on desktop and phone", () => {
  for (const phone of [false, true]) {
    const h = modalFocusHarness();
    h.phone(phone);
    const finder = h.node("finder-input"),
      picker = h.node("focused-stage");
    const replacement = h.node("card", { dataset: { key: "item" } });
    h.api.restoreBayItemFocus("item", null);
    assert.equal(h.document.activeElement, replacement);
    replacement.rects = false;
    h.api.restoreBayItemFocus("item", null);
    assert.equal(h.document.activeElement, phone ? picker : finder);
    replacement.isConnected = false;
    h.api.restoreBayItemFocus("item", null);
    assert.equal(h.document.activeElement, phone ? picker : finder);
  }
});

test("motion control follows system changes while retaining an explicit manual choice", () => {
  const states: boolean[] = [];
  const start = bayLayoutScript.indexOf("  function bindBayMotionControl(");
  const end = bayLayoutScript.indexOf("  function bindBayLayout(", start);
  const bind = new Function(
    "applyBayMotion",
    bayLayoutScript.slice(start, end) + ";return bindBayMotionControl;",
  )((value: boolean) => states.push(value));
  let change = () => {},
    preferenceChange = () => {};
  const motion = {
    checked: false,
    disabled: false,
    title: "",
    addEventListener: (_: string, callback: () => void) => {
      change = callback;
    },
  };
  const preference = {
    matches: true,
    addEventListener: (_: string, callback: () => void) => {
      preferenceChange = callback;
    },
  };
  bind(motion, preference);
  assert.equal(motion.checked, true);
  assert.equal(motion.disabled, true);
  preference.matches = false;
  preferenceChange();
  assert.equal(motion.checked, false);
  assert.equal(motion.disabled, false);
  motion.checked = true;
  change();
  preference.matches = true;
  preferenceChange();
  preference.matches = false;
  preferenceChange();
  assert.equal(motion.checked, true, "manual choice survives system preference cycles");
  assert.equal(motion.disabled, false);
  motion.checked = false;
  change();
  preference.matches = true;
  preferenceChange();
  assert.equal(motion.checked, true);
  assert.equal(motion.disabled, true);
  assert.deepEqual(states, [true, false, true, true, true, false, true]);
});

test("manual reduced motion covers elements and animated pseudo-elements", () => {
  assert.ok(
    bayLayoutCss.includes(
      "body.reduce-motion *,body.reduce-motion *::before,body.reduce-motion *::after{animation:none!important;transition:none!important}",
    ),
  );
});

test("reduced motion cancels native animations after flushing pending visuals", () => {
  const calls: string[] = [];
  let reduced = false;
  const document = {
    body: {
      classList: {
        toggle: (_: string, value: boolean) => {
          reduced = value;
        },
      },
    },
    getAnimations: () => [1, 2].map((id) => ({ cancel: () => calls.push("cancel-" + id) })),
  };
  const apply = new Function(
    "document",
    "STAGES",
    "state",
    "masterReduced",
    "clearLaneChat",
    "parkMaster",
    "applyPendingItems",
    "scheduleLaneChat",
    "beginMasterSweep",
    bayLayoutScript + ";return applyBayMotion;",
  )(
    document,
    stages,
    { brush: "change" },
    () => reduced,
    () => calls.push("clear"),
    () => calls.push("park"),
    () => calls.push("flush"),
    () => calls.push("chat"),
    () => calls.push("patrol"),
  );
  apply(true);
  assert.deepEqual(calls, ["clear", "park", "flush", "cancel-1", "cancel-2"]);
});

test("disabling reduced motion resumes patrol only after an actual reduced-motion transition", () => {
  let reduced = false;
  const calls: string[] = [];
  const state = { brush: "patrol" };
  const document = {
    body: {
      classList: {
        toggle: (_: string, value: boolean) => {
          reduced = value;
        },
      },
    },
  };
  const apply = new Function(
    "document",
    "STAGES",
    "state",
    "masterReduced",
    "clearLaneChat",
    "parkMaster",
    "applyPendingItems",
    "scheduleLaneChat",
    "beginMasterSweep",
    bayLayoutScript + ";return applyBayMotion;",
  )(
    document,
    stages,
    state,
    () => reduced,
    () => calls.push("clear"),
    () => calls.push("park"),
    () => calls.push("flush"),
    () => calls.push("chat"),
    (reason: string) => calls.push(reason),
  );
  apply(false);
  assert.deepEqual(calls, ["chat"], "initial binding does not start an extra sweep");
  calls.length = 0;
  apply(true);
  apply(false);
  assert.deepEqual(calls, ["clear", "park", "flush", "chat", "patrol"]);
  calls.length = 0;
  state.brush = "change";
  apply(true);
  apply(false);
  assert.deepEqual(calls, ["clear", "park", "flush", "chat"], "change mode does not become patrol");
});

test("responsive navigation returns hidden focus to the finder without stealing newer focus", () => {
  for (const id of ["focused-stage", "previous-stage", "next-stage"]) {
    for (const droppedToBody of [false, true]) {
      const h = modalFocusHarness();
      const nav = h.node(id),
        finder = h.node("finder-input"),
        plot = h.node("plot");
      h.document.body = h.node("body");
      nav.focus();
      h.api.rememberBayNavigationFocus({ type: "focusin", target: nav });
      h.api.restoreBayNavigationFocus();
      assert.equal(h.document.activeElement, nav, "visible navigation keeps focus");
      nav.rects = false;
      h.api.rememberBayNavigationFocus({ type: "focusout", target: nav });
      if (droppedToBody) h.document.body.focus();
      h.api.restoreBayNavigationFocus();
      assert.equal(h.document.activeElement, finder);
      nav.rects = true;
      nav.focus();
      h.api.rememberBayNavigationFocus({ type: "focusin", target: nav });
      h.api.rememberBayNavigationFocus({ type: "focusout", target: nav });
      h.document.body.focus();
      nav.rects = false;
      h.api.restoreBayNavigationFocus();
      assert.equal(h.document.activeElement, h.document.body, "intentional blur is not restored");
      h.api.rememberBayNavigationFocus({ type: "focusin", target: nav });
      plot.focus();
      h.api.rememberBayNavigationFocus({ type: "focusin", target: plot });
      h.api.restoreBayNavigationFocus();
      assert.equal(h.document.activeElement, plot);
    }
  }
});

test("queued sample close preserves newer valid chart focus", () => {
  const h = modalFocusHarness();
  const beach = h.node("beach");
  const sample = h.node("sample", { isDialog: true });
  const plot = h.node("plot");
  h.open(sample, beach);
  sample.open = false;
  plot.focus();
  h.api.restoreDialogFocus(sample);
  assert.equal(h.document.activeElement, plot);
  assert.equal(h.api.topBayDialog(), null);
});

test("queued child close preserves newer focus inside the remaining modal", () => {
  const h = modalFocusHarness();
  const beach = h.node("beach");
  const sample = h.node("sample", { isDialog: true });
  const entry = h.node("entry", { parentElement: sample });
  const another = h.node("another", { parentElement: sample });
  const item = h.node("item", { isDialog: true });
  h.open(sample, beach);
  h.open(item, entry);
  item.open = false;
  another.focus();
  h.api.restoreDialogFocus(item);
  assert.equal(h.document.activeElement, another);
  assert.equal(h.api.topBayDialog(), sample);
});

test("queued close rejects newer focus outside the remaining modal", () => {
  const h = modalFocusHarness();
  const beach = h.node("beach");
  const sample = h.node("sample", { isDialog: true });
  const entry = h.node("entry", { parentElement: sample });
  const item = h.node("item", { isDialog: true });
  const plot = h.node("plot");
  h.open(sample, beach);
  h.open(item, entry);
  item.open = false;
  plot.focus();
  h.api.restoreDialogFocus(item);
  assert.equal(h.document.activeElement, entry);
  assert.equal(h.api.topBayDialog(), sample);
});

test("queued close rejects unavailable newer focus", () => {
  for (const unavailable of [
    { disabled: true },
    { rects: false },
    { inert: true },
    { isConnected: false },
  ]) {
    const h = modalFocusHarness();
    const beach = h.node("beach");
    const sample = h.node("sample", { isDialog: true });
    const plot = h.node("plot", unavailable);
    h.open(sample, beach);
    sample.open = false;
    plot.focus();
    h.api.restoreDialogFocus(sample);
    assert.equal(h.document.activeElement, beach);
  }
});

test("queued close restores its opener when focus has fallen to the document body", () => {
  const h = modalFocusHarness();
  h.document.body = h.node("body", { tabIndex: -1 });
  const beach = h.node("beach");
  const sample = h.node("sample", { isDialog: true });
  h.open(sample, beach);
  sample.open = false;
  h.document.body.focus();
  h.api.restoreDialogFocus(sample);
  assert.equal(h.document.activeElement, beach);
});

test("nested close restores the current sample entry and resize uses an available fallback", () => {
  const h = modalFocusHarness(),
    beach = h.node("beach-opener");
  const picker = h.node("focused-stage"),
    finder = h.node("finder-input");
  const sample = h.node("queue-sample-drawer", { isDialog: true });
  h.node("queue-sample-close", { parentElement: sample });
  const entry = h.node("", {
    parentElement: sample,
    dataset: { overflowReference: "direct:repo#1" },
  });
  const item = h.node("drawer", { isDialog: true });
  const close = h.node("drawer-close", { parentElement: item });
  h.open(sample, beach);
  h.open(item, entry);
  close.focus();
  entry.isConnected = false;
  const replacement = h.node("", {
    parentElement: sample,
    dataset: { overflowReference: "direct:repo#1" },
  });
  item.open = false;
  h.api.restoreDialogFocus(item);
  assert.equal(h.api.topBayDialog(), sample);
  assert.equal(h.document.activeElement, replacement);
  beach.rects = false;
  h.phone(true);
  sample.open = false;
  h.api.restoreDialogFocus(sample);
  assert.equal(h.document.activeElement, picker);
  h.phone(false);
  picker.rects = false;
  h.api.restoreDialogFocus(sample);
  assert.equal(h.document.activeElement, finder);
});

test("closing an underlying modal never returns focus behind a still-open item dialog", () => {
  const h = modalFocusHarness(),
    beach = h.node("beach-opener");
  const sample = h.node("queue-sample-drawer", { isDialog: true });
  const entry = h.node("sample-entry", { parentElement: sample });
  const item = h.node("drawer", { isDialog: true });
  const close = h.node("drawer-close", { parentElement: item });
  h.open(sample, beach);
  h.open(item, entry);
  sample.open = false;
  h.api.restoreDialogFocus(sample);
  assert.equal(h.document.activeElement, close);
  assert.equal(h.api.topBayDialog(), item);
});

test("settled-master geometry detects overlap with the reported Arriving bounds", async () => {
  const { settledMasterViolations } =
    await import("../docs/proof/bay-readable-layout/settled-master.mjs");
  const rect = (x: number, y: number, width: number, height: number) => ({
    x,
    y,
    width,
    height,
    right: x + width,
    bottom: y + height,
  });
  // The item rectangle comes from parent runtime evidence. Master rectangles
  // below are synthetic checker inputs, not a substitute for browser proof.
  const snapshot = {
    phase: "resting",
    resting: true,
    moving: false,
    settling: false,
    transitioning: false,
    visible: true,
    imagesLoaded: true,
    beach: rect(0, 277.38, 1440, 815),
    master: rect(100, 450, 110, 70),
    obstacles: [{ target: "Arriving record", bounds: rect(78.02, 432.38, 126, 110) }],
  };
  const overlap = settledMasterViolations(snapshot);
  assert.equal(overlap.checked, true);
  assert.equal(overlap.violations[0]?.kind, "overlap");
  assert.deepEqual(settledMasterViolations({ ...snapshot, master: rect(58, 290, 144, 96) }), {
    checked: true,
    violations: [],
  });
});

test("settled-master checks never prohibit intentional active or settling overlap", async () => {
  const { settledMasterViolations } =
    await import("../docs/proof/bay-readable-layout/settled-master.mjs");
  for (const state of [
    { phase: "sweeping", resting: false, moving: true },
    { phase: "climbing-high", resting: false, moving: true },
    { phase: "settling", resting: true, settling: true },
    { phase: "resting", resting: true, transitioning: true },
  ]) {
    const result = settledMasterViolations(state);
    assert.equal(result.checked, false);
    assert.equal(result.reason, "not_settled");
    assert.deepEqual(result.violations, []);
  }
});

test("parked clearance rejects hidden, clipped, and invalid geometry instead of silently passing", async () => {
  const { settledMasterViolations } =
    await import("../docs/proof/bay-readable-layout/settled-master.mjs");
  const rect = (x: number, y: number, width: number, height: number) => ({
    x,
    y,
    width,
    height,
    right: x + width,
    bottom: y + height,
  });
  const snapshot = {
    phase: "resting",
    resting: true,
    visible: true,
    imagesLoaded: true,
    beach: rect(0, 0, 360, 654),
    master: rect(16, 520, 110, 70),
    obstacles: [{ target: "count note", bounds: rect(16, 604, 328, 40) }],
  };
  assert.deepEqual(settledMasterViolations(snapshot).violations, []);
  assert.equal(
    settledMasterViolations({ ...snapshot, visible: false }).violations[0]?.kind,
    "not_visible",
  );
  assert.equal(
    settledMasterViolations({ ...snapshot, imagesLoaded: false }).violations[0]?.kind,
    "not_visible",
  );
  assert.equal(
    settledMasterViolations({ ...snapshot, master: rect(-1, 520, 110, 70) }).violations[0]?.kind,
    "clipped_by_beach",
  );
  assert.equal(
    settledMasterViolations({ ...snapshot, master: rect(16, Number.NaN, 110, 70) }).violations[0]
      ?.kind,
    "invalid_bounds",
  );
});

test("rest anchors come from responsive CSS while active sweep waypoints remain separate", () => {
  const script = bayHtml().split("<script>")[1]!.split("</script>")[0]!;
  const source = script
    .split("\n")
    .find((line) => line.startsWith("  function masterStationPositions("))!;
  const positions = new Function("portraitLayout", source + ";return masterStationPositions();");
  for (const phone of [false, true]) {
    const station = positions(() => phone);
    assert.deepEqual(station.rest, ["var(--master-rest-left)", "var(--master-rest-top)"]);
    for (const waypoint of ["high", "low", "approach", "lineup"])
      assert.notDeepEqual(station[waypoint], station.rest);
  }
});

test("active mobile master anchor is independent of the footer reservation", async () => {
  const { activeMobileMasterTop } =
    await import("../docs/proof/bay-readable-layout/settled-master.mjs");
  const sceneHeight = 580,
    masterHeight = 70;
  assert.equal(activeMobileMasterTop(sceneHeight, masterHeight), 494);
  for (const footerHeight of [40, 80, 120]) {
    const expandedBeachHeight = sceneHeight + 24 + footerHeight + 10;
    assert.notEqual(
      activeMobileMasterTop(sceneHeight, masterHeight),
      expandedBeachHeight - masterHeight - 16,
    );
  }
});
