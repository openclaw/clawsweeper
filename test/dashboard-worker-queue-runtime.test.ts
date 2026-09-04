import {
  assert,
  createHash,
  createHmac,
  generateKeyPairSync,
  fs,
  os,
  path,
  test,
  worker,
  ExactReviewQueue,
  exactReviewQueueNextWakeAt,
  ExactReviewLifecycleProjectionStore,
  lifecycleState,
  captureCanonicalRecordBaseline,
  publishMainWithStateAppend,
  seededRandom,
  MemoryDurableStorage,
  MemoryDurableNamespace,
  guardedDeadLetterFixture,
  deadLetterFingerprint,
  jsonResponse,
  stateAppendQueueRequest,
  signedStateAppendRequest,
  createExactReviewAdmissionHarness,
  buildExactReviewQueueRequest,
  exactReviewPublicationOverrides,
  legacyExactReviewPublicationOverrides,
  leasedExactReviewQueueItem,
  leasedExactReviewPublicationItem,
  unclaimedExactReviewQueueItem,
} from "./dashboard-worker-harness.ts";
import type { HostedPublicTargetProbe } from "../dashboard/exact-review-queue.ts";
import {
  HOSTED_TARGET_ELIGIBILITY_HEADER,
  isHostedTargetEligible,
} from "../src/hosted-target-admission.ts";
import { directReReviewIntake } from "../src/repair/direct-re-review-admission.ts";
import { EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT } from "../dashboard/exact-review-decision.ts";

function serializedConsoleCalls(calls: unknown[][]) {
  return calls
    .map((args) =>
      args
        .map((value) => {
          if (value instanceof Error) return `${value.name}: ${value.message}`;
          if (typeof value === "string") return value;
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })
        .join(" "),
    )
    .join("\n");
}

function assertConsoleCallsExclude(calls: unknown[][], sentinels: string[]) {
  const serialized = serializedConsoleCalls(calls);
  for (const sentinel of sentinels) {
    assert.equal(serialized.includes(sentinel), false, `console output included ${sentinel}`);
  }
}

function sqlCount(storage: MemoryDurableStorage, table: string) {
  return Number(
    Array.from(storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`))[0]?.count ?? 0,
  );
}

async function reserveDueSourceAuthority(
  harness: ReturnType<typeof createExactReviewAdmissionHarness>,
  {
    deliveryId,
    itemNumber,
    sourceAction = "opened",
    sourceHeadSha = "a".repeat(40),
  }: {
    deliveryId: string;
    itemNumber: number;
    sourceAction?: string;
    sourceHeadSha?: string;
  },
) {
  const response = await harness.queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/source-authority", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HOSTED_TARGET_ELIGIBILITY_HEADER]: "openclaw/fs-safe",
      },
      body: JSON.stringify({
        delivery_id: deliveryId,
        installation_id: 123,
        review_acknowledgement_pending: true,
        decision: {
          targetRepo: "openclaw/fs-safe",
          targetBranch: "main",
          itemNumber,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction,
          supersedesInProgress: sourceAction === "synchronize",
          sourceHeadSha,
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
  const key = `exact-review-source-authority-reservation:v1:${encodeURIComponent(deliveryId)}`;
  const reservation = harness.storage.rawGet(key) as Record<string, unknown>;
  harness.storage.rawPut(key, { ...reservation, nextAttemptAt: 0 });
  return key;
}

function consoleCallBlocks(source: string) {
  const lines = source.split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/console\.(?:warn|error|info|log|debug)\(/.test(lines[index] || "")) continue;
    let block = lines[index] || "";
    while (!/\);\s*$/.test(lines[index] || "") && index + 1 < lines.length) {
      index += 1;
      block += `\n${lines[index] || ""}`;
    }
    blocks.push(block);
  }
  return blocks;
}

test("ordinary queue and state-blob logs reject unbounded diagnostic arguments", () => {
  for (const relativePath of [
    "../dashboard/exact-review-queue.ts",
    "../dashboard/state-blobs.ts",
  ]) {
    const source = fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const calls = consoleCallBlocks(source);
    assert.ok(calls.length > 0, `${relativePath} must retain auditable event logging`);
    for (const call of calls) {
      assert.doesNotMatch(call, /sanitizedServerError|\$\{|\.message\b|String\s*\(/);
      assert.doesNotMatch(
        call,
        /\b(?:detail|reason|key|path|delivery|repo|item|title|url|query|author|assignee|label)\b/,
      );
      assert.doesNotMatch(call, /,\s*(?:_?error|detail|reason|key|path|delivery)\s*[,)]/);
    }
  }
});

test("alarm scheduling keeps a closed reason set and stable tie priority", async () => {
  const source = fs.readFileSync("dashboard/exact-review-queue.ts", "utf8");
  const candidatesStart = source.indexOf(
    "const candidates: Array<readonly [AlarmWakeReason, number | null]>",
  );
  const candidatesEnd = source.indexOf("const selected =", candidatesStart);
  const candidateBlock = source.slice(candidatesStart, candidatesEnd);
  assert.deepEqual(
    [...candidateBlock.matchAll(/\["([^"]+)",/g)].map((match) => match[1]),
    [
      "queue",
      "batch_lease",
      "batch_departure",
      "source_authority",
      "command_intake",
      "credential_circuit",
      "bay_recovery",
    ],
  );

  const now = Date.parse("2026-09-03T02:30:00.000Z");
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: async () => "public" },
  );
  await queue.alarm();
  const internals = queue as unknown as {
    batchStore: {
      activeLeaseSnapshot: (now: number) => {
        itemKeys: string[];
        activeBatches: number;
        nextLeaseExpiresAt: number | null;
      };
    };
    nextSourceAuthorityVerificationAt: () => Promise<number | null>;
    scheduleSourceAuthorityVerification: (
      nextAttemptAt: number,
      reason: "source_authority" | "command_intake",
    ) => Promise<void>;
    scheduleNext: (state: { deliveries: {}; items: {} }, now: number) => Promise<void>;
    scheduledAlarmDecision: readonly [string, number, number, boolean | null, boolean] | null;
  };
  internals.batchStore.activeLeaseSnapshot = () => ({
    itemKeys: [],
    activeBatches: 0,
    nextLeaseExpiresAt: now + 5_000,
  });
  internals.nextSourceAuthorityVerificationAt = async () => now + 5_000;

  await internals.scheduleNext({ deliveries: {}, items: {} }, now);
  assert.equal(internals.scheduledAlarmDecision?.[0], "batch_lease");
  await storage.deleteAlarm();
  await internals.scheduleSourceAuthorityVerification(now + 5_000, "source_authority");
  assert.equal(internals.scheduledAlarmDecision?.[0], "source_authority");
  assert.equal(internals.scheduledAlarmDecision?.[3], null);
  await storage.deleteAlarm();
  const intake = directReReviewIntake({
    targetRepo: "example/project",
    targetBranch: "main",
    itemNumber: 42,
    itemKind: "pull_request",
    installationId: 123,
    sourceCommentId: 9001,
    sourceCommentUpdatedAt: "2026-09-03T02:30:00.000Z",
    commandBodyDigest: createHash("sha256").update("test").digest("hex"),
    commandOrigin: "hosted_webhook",
    additionalPrompt: "",
  });
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/command-intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(intake),
    }),
  );
  assert.equal(response.status, 202);
  assert.equal(internals.scheduledAlarmDecision?.[0], "command_intake");
});

test("alarm scheduling samples only the tenth invocation in each minute", async () => {
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  let fetches = 0;
  let now = Date.parse("2026-09-03T02:30:00.000Z");
  Date.now = () => now;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("unexpected fetch");
  };
  console.warn = (...args) => warnings.push(args);
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const internals = queue as unknown as {
    alarmSampleWindowStartedAt: number;
    alarmSampleCount: number;
    alarmSampleLoggedAt: number;
    scheduledAlarmDecision: readonly [string, number, number, boolean | null, boolean] | null;
  };
  const samples = () =>
    warnings.filter(([message]) => message === "exact_review_queue_alarm_schedule_sample");
  const invoke = async (
    reason: string,
    bayPending: boolean | null,
    bayBackoff: boolean,
  ): Promise<void> => {
    internals.scheduledAlarmDecision = [reason, now - 250, now - 1_250, bayPending, bayBackoff];
    await queue.alarm();
  };

  try {
    for (let count = 0; count < 9; count += 1) await invoke("queue", false, false);
    assert.equal(samples().length, 0);
    await invoke("queue", false, false);
    assert.deepEqual(samples(), [
      [
        "exact_review_queue_alarm_schedule_sample",
        {
          alarm_count: 10,
          wake_reason: "queue",
          scheduled_delay_ms: 1_000,
          alarm_lag_ms: 250,
          decision_age_ms: 1_250,
          bay_pending: false,
          bay_backoff: false,
        },
      ],
    ]);
    await invoke("queue", false, false);
    assert.equal(samples().length, 1);

    now += 60_000;
    for (let count = 0; count < 9; count += 1) await invoke("bay_recovery", true, true);
    assert.equal(samples().length, 1);
    await invoke("bay_recovery", true, true);
    assert.equal(samples().length, 2);
    assert.deepEqual(samples()[1]?.[1], {
      alarm_count: 10,
      wake_reason: "bay_recovery",
      scheduled_delay_ms: 1_000,
      alarm_lag_ms: 250,
      decision_age_ms: 1_250,
      bay_pending: true,
      bay_backoff: true,
    });
    now += 60_000;
    for (let count = 0; count < 10; count += 1) {
      await invoke("source_authority", null, false);
    }
    assert.deepEqual(samples()[2]?.[1], {
      alarm_count: 10,
      wake_reason: "source_authority",
      scheduled_delay_ms: 1_000,
      alarm_lag_ms: 250,
      decision_age_ms: 1_250,
      bay_pending: null,
      bay_backoff: false,
    });
    assert.equal(fetches, 0);
    assert.equal(storage.rawHas("exact_review_queue_alarm_schedule_sample"), false);
    assertConsoleCallsExclude(samples(), [
      "openclaw/openclaw",
      "delivery-id",
      "item-key",
      "https://private.example",
    ]);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test("hosted admission gates Worker forwarding and queue authority persistence", () => {
  const workerSource = fs.readFileSync("dashboard/worker.ts", "utf8");
  for (const path of ["command-intake", "enqueue", "branch-authority", "source-authority"]) {
    assert.match(
      workerSource,
      new RegExp(
        `url\\.pathname === "/internal/exact-review/${path}"[\\s\\S]{0,180}authenticatedHostedTargetQueueRequest`,
      ),
    );
  }
  const forwarding = workerSource.slice(
    workerSource.indexOf("async function authenticatedHostedTargetQueueRequest"),
    workerSource.indexOf("async function authenticatedLifecycleCommandAcknowledgement"),
  );
  assert.ok(
    forwarding.indexOf("workerHostedTargetEligibility") <
      forwarding.indexOf("exactReviewQueueRequest"),
  );
  assert.match(forwarding, /HOSTED_TARGET_ELIGIBILITY_HEADER/);

  const queueSource = fs.readFileSync("dashboard/exact-review-queue.ts", "utf8");
  for (const [route, persistenceMarker] of [
    ["/branch-authority", "exactReviewBranchAuthorityReservationKey"],
    ["/source-authority", "exactReviewSourceAuthorityReservationKey"],
  ] as const) {
    const start = queueSource.indexOf(`url.pathname === "${route}"`);
    const end = queueSource.indexOf('request.method === "POST"', start + 30);
    const block = queueSource.slice(start, end);
    assert.ok(block.indexOf("hostedTargetAdmission") < block.indexOf(persistenceMarker), route);
    assert.ok(block.indexOf("hostedTargetMetadataToken") < block.indexOf(persistenceMarker), route);
    assert.ok(
      block.indexOf("hasPreparedHostedTargetEligibility") < block.indexOf(persistenceMarker),
      route,
    );
  }
});

test("enqueue visibility rejection happens before queue, receipt, or lifecycle persistence", async () => {
  for (const { admission, status, body } of [
    {
      admission: "terminal" as const,
      status: 422,
      body: { error: "private_target_unsupported" },
    },
    {
      admission: "retryable" as const,
      status: 503,
      body: { error: "target_visibility_unverified", retryable: true },
    },
  ]) {
    const storage = new MemoryDurableStorage();
    const queue = new ExactReviewQueue(
      { storage },
      { hostedPublicTargetProbe: async () => admission },
    );
    const response = await queue.fetch(
      buildExactReviewQueueRequest(`pre-persistence-${admission}`, 8080, "opened"),
    );

    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), body);
    assert.equal(sqlCount(storage, "exact_review_queue_deliveries"), 0);
    assert.equal(sqlCount(storage, "exact_review_queue_items"), 0);
    assert.equal(sqlCount(storage, "exact_review_lifecycle_projection_v1"), 0);
    assert.equal(
      new ExactReviewLifecycleProjectionStore(storage).readBaySnapshot().inventory
        ?.lifecycle_records,
      0,
    );
  }
});

test("owner-fallback public targets are probed and admitted without configured profiles", async () => {
  let probes = 0;
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    {
      hostedTargetPredicate: (targetRepo: string) =>
        isHostedTargetEligible(targetRepo, {
          configuredRepositories: [],
          genericFallbacks: [
            {
              owner: "openclaw",
              denyRepositories: ["openclaw/clawsweeper-state", "openclaw/.github"],
              allowRepoNamePattern: /^[a-z0-9_.-]+$/,
            },
          ],
        }),
      hostedPublicTargetProbe: async () => {
        probes += 1;
        return "public";
      },
    },
  );

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "generic-public-target",
      8_073,
      "opened",
      "pull_request",
      "openclaw/example-tool",
    ),
  );

  assert.equal(response.status, 202);
  assert.equal((await response.json()).queued, true);
  assert.equal(probes, 1);
  assert.equal(sqlCount(storage, "exact_review_queue_deliveries"), 1);
  assert.equal(sqlCount(storage, "exact_review_queue_items"), 1);
});

test("configured other-owner targets are eligible while unknown public targets stop pre-effect", async () => {
  const policy = {
    configuredRepositories: ["partner/configured-repo"],
    genericFallbacks: [],
  };
  let configuredProbes = 0;
  const configuredStorage = new MemoryDurableStorage();
  const configuredQueue = new ExactReviewQueue(
    { storage: configuredStorage },
    {
      hostedTargetPredicate: (targetRepo: string) => isHostedTargetEligible(targetRepo, policy),
      hostedPublicTargetProbe: async () => {
        configuredProbes += 1;
        return "public";
      },
    },
  );
  const configuredResponse = await configuredQueue.fetch(
    buildExactReviewQueueRequest(
      "configured-other-owner",
      8_074,
      "opened",
      "pull_request",
      "partner/configured-repo",
    ),
  );
  assert.equal(configuredResponse.status, 202);
  assert.equal((await configuredResponse.json()).queued, true);
  assert.equal(configuredProbes, 1);
  assert.equal(sqlCount(configuredStorage, "exact_review_queue_deliveries"), 1);
  assert.equal(sqlCount(configuredStorage, "exact_review_queue_items"), 1);

  let outsideProbes = 0;
  let metadataTokens = 0;
  const outsideStorage = new MemoryDurableStorage();
  const outsideQueue = new ExactReviewQueue(
    { storage: outsideStorage },
    {
      hostedTargetPredicate: (targetRepo: string) => isHostedTargetEligible(targetRepo, policy),
      hostedPublicTargetProbe: async () => {
        outsideProbes += 1;
        return "public";
      },
    },
  );
  const outsideResponse = await outsideQueue.fetch(
    buildExactReviewQueueRequest(
      "outside-owner",
      8_075,
      "opened",
      "pull_request",
      "outside/public-repo",
    ),
    async () => {
      metadataTokens += 1;
      return "metadata-token";
    },
  );
  assert.equal(outsideResponse.status, 422);
  assert.deepEqual(await outsideResponse.json(), { error: "private_target_unsupported" });
  assert.equal(outsideProbes, 0);
  assert.equal(metadataTokens, 0);
  assert.equal(sqlCount(outsideStorage, "exact_review_queue_deliveries"), 0);
  assert.equal(sqlCount(outsideStorage, "exact_review_queue_items"), 0);
  assert.equal(sqlCount(outsideStorage, "exact_review_lifecycle_projection_v1"), 0);
});

test("private metadata is probed with one central-only token and leaves no durable side effects", async () => {
  const metadataToken = "central-metadata-token-sentinel";
  const installationRepos: string[] = [];
  const metadataRequests: RequestInit[] = [];
  let metadataMints = 0;
  let targetMints = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    useRealHostedPublicTargetProbe: true,
    targetInstallation: (targetRepo) => {
      installationRepos.push(targetRepo);
      return jsonResponse({ id: 999 });
    },
    targetAccessToken: (_installationId, init) => {
      const body = JSON.parse(String(init?.body)) as {
        repositories?: string[];
        permissions?: Record<string, string>;
      };
      if (body.permissions?.metadata === "read") {
        metadataMints += 1;
        assert.deepEqual(body.repositories, ["clawsweeper"]);
        assert.deepEqual(body.permissions, { metadata: "read" });
        return jsonResponse({ token: metadataToken });
      }
      targetMints += 1;
      return jsonResponse({ token: "unexpected-target-token" });
    },
    targetRepository: (_targetRepo, init) => {
      metadataRequests.push(init ?? {});
      return Response.json({}, { status: 404 });
    },
  });
  try {
    const response = await harness.queue.fetch(
      buildExactReviewQueueRequest("central-private-metadata", 8_070, "opened"),
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "private_target_unsupported" });
    assert.deepEqual(installationRepos, ["openclaw/clawsweeper"]);
    assert.equal(metadataMints, 1);
    assert.equal(targetMints, 0);
    assert.equal(metadataRequests.length, 1);
    const request = metadataRequests[0]!;
    assert.equal(request.cache, "no-store");
    assert.equal(request.redirect, "manual");
    assert.equal(new Headers(request.headers).get("cache-control"), "no-store");
    assert.equal(new Headers(request.headers).get("authorization"), `Bearer ${metadataToken}`);
    assert.equal(sqlCount(harness.storage, "exact_review_queue_deliveries"), 0);
    assert.equal(sqlCount(harness.storage, "exact_review_queue_items"), 0);
    assert.equal(sqlCount(harness.storage, "exact_review_lifecycle_projection_v1"), 0);
    assertConsoleCallsExclude(warnings, [metadataToken]);
  } finally {
    console.warn = originalWarn;
    harness.restore();
  }
});

test("one alarm pass reuses its central metadata token across visibility rechecks", async () => {
  let metadataMints = 0;
  let metadataReads = 0;
  let targetReadMints = 0;
  const metadataToken = "central-pass-token";
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    useRealHostedPublicTargetProbe: true,
    targetAccessToken: (_installationId, init) => {
      const body = JSON.parse(String(init?.body)) as {
        repositories?: string[];
        permissions?: Record<string, string>;
      };
      if (body.permissions?.metadata === "read") {
        metadataMints += 1;
        assert.deepEqual(body.repositories, ["clawsweeper"]);
        assert.deepEqual(body.permissions, { metadata: "read" });
        return jsonResponse({ token: metadataToken });
      }
      if (body.permissions?.issues === "read") targetReadMints += 1;
      return jsonResponse({ token: "queue-token" });
    },
    targetRepository: (targetRepo, init) => {
      metadataReads += 1;
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${metadataToken}`);
      return jsonResponse({ full_name: targetRepo, private: false, visibility: "public" });
    },
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("central-pass-reuse", 8_071, "opened"),
        )
      ).status,
      202,
    );
    await harness.queue.alarm();
    assert.equal(metadataReads, 3);
    assert.equal(metadataMints, 2);
    assert.equal(targetReadMints, 1);
    assert.equal(harness.dispatched.length, 1);
  } finally {
    harness.restore();
  }
});

test("metadata quota reset durably defers admission before target credentials", async () => {
  const resetAt = Date.now() + 90_000;
  let metadataReads = 0;
  let targetReadMints = 0;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    useRealHostedPublicTargetProbe: true,
    targetAccessToken: (_installationId, init) => {
      const body = JSON.parse(String(init?.body)) as {
        permissions?: Record<string, string>;
      };
      if (body.permissions?.metadata === "read") {
        return jsonResponse({ token: "central-rate-token" });
      }
      if (body.permissions?.issues === "read") targetReadMints += 1;
      return jsonResponse({ token: "queue-token" });
    },
    targetRepository: (targetRepo) => {
      metadataReads += 1;
      return metadataReads === 1
        ? jsonResponse({ full_name: targetRepo, private: false, visibility: "public" })
        : Response.json(
            {},
            {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.ceil(resetAt / 1_000)),
              },
            },
          );
    },
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("central-rate-reset", 8_072, "opened"),
        )
      ).status,
      202,
    );
    await harness.queue.alarm();
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { attempts: number; nextAttemptAt: number; state: string }>;
    };
    assert.equal(metadataReads, 2);
    assert.equal(targetReadMints, 0);
    assert.equal(state.items["openclaw/gogcli#8072"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#8072"]?.attempts, 0);
    assert.ok((state.items["openclaw/gogcli#8072"]?.nextAttemptAt ?? 0) >= resetAt - 1_000);
    assert.equal(harness.dispatched.length, 0);
  } finally {
    harness.restore();
  }
});

test("branch and source authority admission precedes durable reservation", async () => {
  const sourceHeadSha = "a".repeat(40);
  for (const route of ["branch", "source"] as const) {
    for (const admission of ["terminal", "retryable", "public"] as const) {
      let probes = 0;
      let targetTokens = 0;
      let targetReads = 0;
      const itemNumber = route === "branch" ? 8081 : 8082;
      const deliveryId = `${route}-authority-${admission}`;
      const reservationKey =
        route === "branch"
          ? `exact-review-branch-authority-reservation:v1:${encodeURIComponent(deliveryId)}`
          : `exact-review-source-authority-reservation:v1:${encodeURIComponent(deliveryId)}`;
      const siblingReservationKey =
        route === "branch"
          ? `exact-review-source-authority-reservation:v1:${encodeURIComponent(deliveryId)}`
          : `exact-review-branch-authority-reservation:v1:${encodeURIComponent(deliveryId)}`;
      const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
        workflow: () => jsonResponse({ state: "disabled_manually" }),
        hostedPublicTargetProbe: async () => {
          probes += 1;
          return admission;
        },
        targetAccessToken: (installationId) => {
          if (installationId === 123) {
            targetTokens += 1;
            return jsonResponse({ token: "target-token" });
          }
          return jsonResponse({ token: "queue-token" });
        },
        targetRepository: () => {
          targetReads += 1;
          return jsonResponse({ default_branch: "trunk" });
        },
        targetPull: () => {
          targetReads += 1;
          return jsonResponse({ head: { sha: sourceHeadSha } });
        },
      });
      try {
        const sequenceBefore = 41;
        const alarmBefore = 123_456;
        harness.storage.rawPut("exact-review-source-authority-sequence:v1", sequenceBefore);
        if (admission !== "public") await harness.storage.setAlarm(alarmBefore);
        const decision =
          route === "branch"
            ? {
                targetRepo: "openclaw/fs-safe",
                itemNumber,
                itemKind: "issue",
                sourceEvent: "issues",
                sourceAction: "legacy_dispatch",
                supersedesInProgress: false,
              }
            : {
                targetRepo: "openclaw/fs-safe",
                targetBranch: "trunk",
                itemNumber,
                itemKind: "pull_request",
                sourceEvent: "pull_request",
                sourceAction: "synchronize",
                supersedesInProgress: true,
                sourceHeadSha,
              };
        const reserved = await harness.queue.fetch(
          new Request(`https://clawsweeper-exact-review-queue/${route}-authority`, {
            method: "POST",
            headers: {
              [HOSTED_TARGET_ELIGIBILITY_HEADER]: decision.targetRepo,
            },
            body: JSON.stringify({
              delivery_id: deliveryId,
              installation_id: 123,
              decision,
            }),
          }),
        );
        assert.equal(
          reserved.status,
          admission === "terminal"
            ? 422
            : admission === "retryable"
              ? 503
              : route === "branch"
                ? 202
                : 200,
        );

        if (admission !== "public") {
          assert.equal(probes, 1);
          assert.equal(targetTokens, 0);
          assert.equal(targetReads, 0);
          assert.equal(harness.storage.rawHas(reservationKey), false);
          assert.equal(harness.storage.rawHas(siblingReservationKey), false);
          assert.equal(
            harness.storage.rawGet("exact-review-source-authority-sequence:v1"),
            sequenceBefore,
          );
          assert.equal(await harness.storage.getAlarm(), alarmBefore);
          assert.equal(sqlCount(harness.storage, "exact_review_queue_deliveries"), 0);
          assert.equal(sqlCount(harness.storage, "exact_review_queue_items"), 0);
          continue;
        }

        assert.equal(probes, 1);
        assert.equal(harness.storage.rawHas(reservationKey), true);
        assert.ok((await harness.storage.getAlarm()) !== null);
        await harness.queue.alarm();
        assert.ok(targetTokens > 0);
        assert.equal(targetReads, 1);
        assert.ok(probes > 1);
        assert.equal(sqlCount(harness.storage, "exact_review_queue_deliveries"), 1);
        const state = (await harness.storage.get("exact-review-queue")) as {
          items: Record<string, unknown>;
        };
        assert.ok(state.items[`openclaw/fs-safe#${itemNumber}`]);
      } finally {
        harness.restore();
      }
    }
  }
});

test("source authority fallback recovers a trusted receipt before admission", async () => {
  const sourceHeadSha = "a".repeat(40);
  const commentId = 98_081;
  let commentPosts = 0;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    hostedPublicTargetProbe: async () => "public",
    targetAccessToken: () => jsonResponse({ token: "target-token" }),
    targetPull: () => jsonResponse({ head: { sha: sourceHeadSha } }),
    targetComments: (_repo, itemNumber, init) => {
      assert.equal(itemNumber, 8_081);
      if (init?.method === "POST") commentPosts += 1;
      return jsonResponse([
        {
          id: commentId,
          body: "<!-- clawsweeper-pr-ack:opened item=8081 -->\nClawSweeper picked this up.",
          created_at: "2026-09-04T00:00:00Z",
          user: { login: "openclaw-clawsweeper[bot]" },
        },
      ]);
    },
  });
  try {
    const reservationKey = await reserveDueSourceAuthority(harness, {
      deliveryId: "source-ack-recovery",
      itemNumber: 8_081,
      sourceHeadSha,
    });
    await harness.queue.alarm();

    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
    };
    assert.equal(
      state.items["openclaw/fs-safe#8081"]?.decision.reviewAcknowledgementCommentId,
      commentId,
    );
    assert.equal(harness.storage.rawHas(reservationKey), false);
    assert.equal(commentPosts, 0);
  } finally {
    harness.restore();
  }
});

test("source authority synchronize recovery never creates a missing receipt", async () => {
  const sourceHeadSha = "f".repeat(40);
  let commentPosts = 0;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    hostedPublicTargetProbe: async () => "public",
    targetAccessToken: () => jsonResponse({ token: "target-token" }),
    targetPull: () => jsonResponse({ head: { sha: sourceHeadSha } }),
    targetComments: (_repo, _itemNumber, init) => {
      if (init?.method === "POST") commentPosts += 1;
      return jsonResponse([]);
    },
  });
  try {
    const reservationKey = await reserveDueSourceAuthority(harness, {
      deliveryId: "source-sync-ack-recovery",
      itemNumber: 8_086,
      sourceAction: "synchronize",
      sourceHeadSha,
    });
    await harness.queue.alarm();

    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
    };
    assert.ok(state.items["openclaw/fs-safe#8086"]);
    assert.equal(
      state.items["openclaw/fs-safe#8086"].decision.reviewAcknowledgementCommentId,
      undefined,
    );
    assert.equal(commentPosts, 0);
    assert.equal(harness.storage.rawHas(reservationKey), false);
  } finally {
    harness.restore();
  }
});

test("source authority acknowledgement errors remain deferred without enqueue", async () => {
  const sourceHeadSha = "b".repeat(40);
  let pullReads = 0;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    hostedPublicTargetProbe: async () => "public",
    targetAccessToken: () => jsonResponse({ token: "target-token" }),
    targetPull: () => {
      pullReads += 1;
      return jsonResponse({ head: { sha: sourceHeadSha } });
    },
    targetComments: () =>
      new Response(JSON.stringify({ message: "temporary failure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const reservationKey = await reserveDueSourceAuthority(harness, {
      deliveryId: "source-ack-error",
      itemNumber: 8_082,
      sourceHeadSha,
    });
    const due = harness.storage.rawGet(reservationKey) as Record<string, unknown>;
    harness.storage.rawPut(reservationKey, {
      ...due,
      attempts: EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT,
    });
    await harness.queue.alarm();

    const reservation = harness.storage.rawGet(reservationKey) as {
      attempts: number;
      nextAttemptAt: number;
      reviewAcknowledgementPending?: boolean;
    };
    assert.equal(reservation.attempts, EXACT_REVIEW_SOURCE_AUTHORITY_RETRY_LIMIT);
    assert.ok(reservation.nextAttemptAt > 0);
    assert.equal(reservation.reviewAcknowledgementPending, true);
    assert.equal(pullReads, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items["openclaw/fs-safe#8082"], undefined);
    assert.equal(sqlCount(harness.storage, "exact_review_queue_deliveries"), 0);
  } finally {
    harness.restore();
  }
});

test("source authority acknowledgement recovery defers when credentials are missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("credential deferral must stop before GitHub I/O");
  };
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: async () => "public" },
  );
  const deliveryId = "source-ack-missing-credentials";
  const reservationKey = `exact-review-source-authority-reservation:v1:${encodeURIComponent(deliveryId)}`;
  try {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/source-authority", {
        method: "POST",
        headers: { [HOSTED_TARGET_ELIGIBILITY_HEADER]: "openclaw/fs-safe" },
        body: JSON.stringify({
          delivery_id: deliveryId,
          installation_id: 123,
          review_acknowledgement_pending: true,
          decision: {
            targetRepo: "openclaw/fs-safe",
            targetBranch: "main",
            itemNumber: 8_087,
            itemKind: "pull_request",
            sourceEvent: "pull_request",
            sourceAction: "opened",
            supersedesInProgress: false,
            sourceHeadSha: "a".repeat(40),
          },
        }),
      }),
    );
    assert.equal(response.status, 200);
    const reserved = storage.rawGet(reservationKey) as Record<string, unknown>;
    storage.rawPut(reservationKey, { ...reserved, nextAttemptAt: 0 });

    await queue.alarm();

    const deferred = storage.rawGet(reservationKey) as {
      attempts: number;
      reviewAcknowledgementPending?: boolean;
    };
    assert.equal(deferred.attempts, 1);
    assert.equal(deferred.reviewAcknowledgementPending, true);
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items["openclaw/fs-safe#8087"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("source authority recovery reuses a receipt after create response loss", async () => {
  const sourceHeadSha = "c".repeat(40);
  const comments: Record<string, unknown>[] = [];
  let commentPosts = 0;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    hostedPublicTargetProbe: async () => "public",
    targetAccessToken: () => jsonResponse({ token: "target-token" }),
    targetPull: () => jsonResponse({ head: { sha: sourceHeadSha } }),
    targetComments: (_repo, itemNumber, init) => {
      if (init?.method === "GET") return jsonResponse(comments);
      assert.equal(init?.method, "POST");
      commentPosts += 1;
      comments.push({
        id: 98_083,
        body: `<!-- clawsweeper-pr-ack:opened item=${itemNumber} -->\nClawSweeper picked this up.`,
        created_at: "2026-09-04T00:00:00Z",
        user: { login: "clawsweeper[bot]" },
      });
      throw new Error("simulated response loss");
    },
  });
  try {
    const reservationKey = await reserveDueSourceAuthority(harness, {
      deliveryId: "source-ack-response-loss",
      itemNumber: 8_083,
      sourceHeadSha,
    });
    await harness.queue.alarm();
    assert.equal(commentPosts, 1);
    assert.equal(harness.storage.rawHas(reservationKey), true);
    assert.equal(comments.length, 1);

    const deferred = harness.storage.rawGet(reservationKey) as Record<string, unknown>;
    harness.storage.rawPut(reservationKey, { ...deferred, nextAttemptAt: 0 });
    await harness.queue.alarm();

    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
    };
    assert.equal(
      state.items["openclaw/fs-safe#8083"]?.decision.reviewAcknowledgementCommentId,
      98_083,
    );
    assert.equal(commentPosts, 1);
    assert.equal(comments.length, 1);
    assert.equal(harness.storage.rawHas(reservationKey), false);
  } finally {
    harness.restore();
  }
});

test("source authority acknowledgement recovery preserves concurrent receipt and source guards", async () => {
  for (const concurrentChange of ["receipt", "source"] as const) {
    const itemNumber = concurrentChange === "receipt" ? 8_084 : 8_085;
    const sourceHeadSha = "d".repeat(40);
    let reservationKey = "";
    let changed = false;
    let pullReads = 0;
    const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
      hostedPublicTargetProbe: async () => "public",
      targetAccessToken: () => jsonResponse({ token: "target-token" }),
      targetPull: () => {
        pullReads += 1;
        return jsonResponse({ head: { sha: sourceHeadSha } });
      },
      targetComments: () => {
        if (!changed) {
          changed = true;
          const current = harness.storage.rawGet(reservationKey) as {
            decision: Record<string, unknown>;
          } & Record<string, unknown>;
          harness.storage.rawPut(
            reservationKey,
            concurrentChange === "receipt"
              ? {
                  ...current,
                  decision: { ...current.decision, reviewAcknowledgementCommentId: 98_084 },
                  reviewAcknowledgementPending: false,
                  nextAttemptAt: 0,
                }
              : {
                  ...current,
                  decision: { ...current.decision, sourceHeadSha: "e".repeat(40) },
                },
          );
        }
        return jsonResponse([
          {
            id: 88_000 + itemNumber,
            body: `<!-- clawsweeper-pr-ack:opened item=${itemNumber} -->`,
            created_at: "2026-09-04T00:00:00Z",
            user: { login: "clawsweeper[bot]" },
          },
        ]);
      },
    });
    try {
      reservationKey = await reserveDueSourceAuthority(harness, {
        deliveryId: `source-ack-concurrent-${concurrentChange}`,
        itemNumber,
        sourceHeadSha,
      });
      await harness.queue.alarm();
      const state = (await harness.storage.get("exact-review-queue")) as {
        items: Record<string, { decision: { reviewAcknowledgementCommentId?: number } }>;
      };
      if (concurrentChange === "receipt") {
        assert.equal(
          state.items[`openclaw/fs-safe#${itemNumber}`]?.decision.reviewAcknowledgementCommentId,
          98_084,
        );
        assert.equal(harness.storage.rawHas(reservationKey), false);
        assert.equal(pullReads, 1);
      } else {
        assert.equal(state.items[`openclaw/fs-safe#${itemNumber}`], undefined);
        const reservation = harness.storage.rawGet(reservationKey) as {
          decision: { sourceHeadSha: string };
          reviewAcknowledgementPending?: boolean;
        };
        assert.equal(reservation.decision.sourceHeadSha, "e".repeat(40));
        assert.equal(reservation.reviewAcknowledgementPending, true);
        assert.equal(pullReads, 0);
        harness.storage.rawPut(reservationKey, { ...reservation, nextAttemptAt: 0 });
        await harness.queue.alarm();
        const afterStaleHead = (await harness.storage.get("exact-review-queue")) as {
          items: Record<string, unknown>;
        };
        assert.equal(afterStaleHead.items[`openclaw/fs-safe#${itemNumber}`], undefined);
        assert.equal(harness.storage.rawHas(reservationKey), false);
        assert.equal(pullReads, 1);
        assert.equal(sqlCount(harness.storage, "exact_review_queue_deliveries"), 1);
      }
    } finally {
      harness.restore();
    }
  }
});

test("authority reservations remain absent while visibility I/O is pending", async () => {
  for (const route of ["branch", "source"] as const) {
    let releaseProbe!: () => void;
    let signalProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      signalProbe = resolve;
    });
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let targetTokens = 0;
    const itemNumber = route === "branch" ? 8083 : 8084;
    const deliveryId = `${route}-authority-fence`;
    const reservationKey =
      route === "branch"
        ? `exact-review-branch-authority-reservation:v1:${encodeURIComponent(deliveryId)}`
        : `exact-review-source-authority-reservation:v1:${encodeURIComponent(deliveryId)}`;
    const sourceHeadSha = "b".repeat(40);
    const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
      hostedPublicTargetProbe: async () => {
        signalProbe();
        await probeRelease;
        return "public";
      },
      targetAccessToken: () => {
        targetTokens += 1;
        return jsonResponse({ token: "target-token" });
      },
    });
    try {
      const decision =
        route === "branch"
          ? {
              targetRepo: "openclaw/fs-safe",
              itemNumber,
              itemKind: "issue",
              sourceEvent: "issues",
              sourceAction: "legacy_dispatch",
              supersedesInProgress: false,
            }
          : {
              targetRepo: "openclaw/fs-safe",
              targetBranch: "main",
              itemNumber,
              itemKind: "pull_request",
              sourceEvent: "pull_request",
              sourceAction: "synchronize",
              supersedesInProgress: true,
              sourceHeadSha,
            };
      const reservation = harness.queue.fetch(
        new Request(`https://clawsweeper-exact-review-queue/${route}-authority`, {
          method: "POST",
          headers: {
            [HOSTED_TARGET_ELIGIBILITY_HEADER]: decision.targetRepo,
          },
          body: JSON.stringify({
            delivery_id: deliveryId,
            installation_id: 123,
            decision,
          }),
        }),
      );

      await probeStarted;
      assert.equal(harness.storage.rawHas(reservationKey), false);
      assert.equal(harness.storage.rawHas("exact-review-source-authority-sequence:v1"), false);
      assert.equal(await harness.storage.getAlarm(), null);
      assert.equal(targetTokens, 0);
      releaseProbe();
      const response = await reservation;

      assert.equal(response.status, route === "branch" ? 202 : 200);
      assert.equal(harness.storage.rawHas(reservationKey), true);
      assert.ok((await harness.storage.getAlarm()) !== null);
      assert.equal(targetTokens, 0);
      assert.equal(sqlCount(harness.storage, "exact_review_queue_deliveries"), 0);
      assert.equal(sqlCount(harness.storage, "exact_review_queue_items"), 0);
    } finally {
      harness.restore();
    }
  }
});

test("ordinary alarm admission rechecks public targets after item reads", async () => {
  for (const finalAdmission of ["public", "terminal", "retryable"] as const) {
    let probes = 0;
    let itemReads = 0;
    let targetTokens = 0;
    const itemNumber =
      finalAdmission === "public" ? 8085 : finalAdmission === "terminal" ? 8086 : 8087;
    const itemKey = `openclaw/gogcli#${itemNumber}`;
    const harness = createExactReviewAdmissionHarness(
      () => {
        itemReads += 1;
        return jsonResponse({ state: "open" });
      },
      {
        hostedPublicTargetProbe: async () => {
          probes += 1;
          return probes < 3 ? "public" : finalAdmission;
        },
        targetAccessToken: (_installationId, init) => {
          const body = JSON.parse(String(init?.body)) as {
            permissions?: Record<string, string>;
          };
          if (body.permissions?.issues === "read") targetTokens += 1;
          return jsonResponse({ token: "queue-token" });
        },
      },
    );
    try {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              `ordinary-transition-${finalAdmission}`,
              itemNumber,
              "opened",
            ),
          )
        ).status,
        202,
      );
      await harness.queue.alarm();

      assert.equal(probes, 3);
      assert.equal(itemReads, 1);
      assert.equal(targetTokens, 1);
      assert.equal(harness.dispatched.length, finalAdmission === "public" ? 1 : 0);
      const state = (await harness.storage.get("exact-review-queue")) as {
        items: Record<string, { attempts: number; nextAttemptAt: number; state: string }>;
      };
      if (finalAdmission === "public") {
        assert.equal(state.items[itemKey]?.state, "dispatching");
      } else if (finalAdmission === "terminal") {
        assert.equal(state.items[itemKey], undefined);
        const lifecycle = new ExactReviewLifecycleProjectionStore(harness.storage).read(
          itemKey,
          itemKey,
          1,
        );
        assert.equal(lifecycle?.terminalDisposition?.kind, "superseded");
      } else {
        assert.equal(state.items[itemKey]?.state, "pending");
        assert.equal(state.items[itemKey]?.attempts, 0);
        assert.ok(state.items[itemKey]!.nextAttemptAt > Date.now());
      }
    } finally {
      harness.restore();
    }
  }
});

test("ordinary command admission terminalizes locally or defers before target credentials", async () => {
  for (const lane of ["review", "publication"] as const) {
    for (const finalAdmission of ["terminal", "retryable"] as const) {
      const itemNumber =
        8_090 + (lane === "publication" ? 10 : 0) + (finalAdmission === "terminal" ? 1 : 2);
      const producerRunId = `${itemNumber}0`;
      const commandStatusMarker = `<!-- clawsweeper-command-status:${itemNumber}:re_review:${"c".repeat(40)} -->`;
      const statusCommentId = itemNumber * 10;
      let admission: HostedPublicTargetProbe = "public";
      let probes = 0;
      let itemReads = 0;
      let targetTokens = 0;
      const harness = createExactReviewAdmissionHarness(
        () => {
          itemReads += 1;
          return jsonResponse({ state: "open" });
        },
        {
          hostedPublicTargetProbe: async () => {
            probes += 1;
            return admission;
          },
          targetAccessToken: (_installationId, init) => {
            const body = JSON.parse(String(init?.body)) as {
              permissions?: Record<string, string>;
            };
            if (body.permissions?.issues === "read") targetTokens += 1;
            return jsonResponse({ token: "queue-token" });
          },
        },
      );
      try {
        const decisionOverrides =
          lane === "review"
            ? { commandStatusMarker, statusCommentId }
            : exactReviewPublicationOverrides(itemNumber, producerRunId);
        if (lane === "publication") {
          Object.assign(decisionOverrides.publication.producerDecision, {
            commandStatusMarker,
            statusCommentId,
          });
        }
        const sourceAction = lane === "publication" ? "exact_review_artifact_publish" : "opened";
        assert.equal(
          (
            await harness.queue.fetch(
              buildExactReviewQueueRequest(
                `command-${lane}-${finalAdmission}`,
                itemNumber,
                sourceAction,
                "issue",
                "openclaw/gogcli",
                decisionOverrides,
              ),
            )
          ).status,
          202,
        );
        const itemKey =
          lane === "publication"
            ? `openclaw/gogcli#${itemNumber}@publish:${producerRunId}:1`
            : `openclaw/gogcli#${itemNumber}`;
        admission = finalAdmission;

        await harness.queue.alarm();

        assert.equal(probes, 2);
        assert.equal(itemReads, 0);
        assert.equal(targetTokens, 0);
        assert.equal(harness.dispatched.length, 0);
        const state = (await harness.storage.get("exact-review-queue")) as {
          items: Record<
            string,
            {
              state: string;
              attempts: number;
              nextAttemptAt: number;
              decision: { commandStatusMarker?: string; statusCommentId?: number };
              terminalFinalization?: {
                disposition: string;
                projection: { fenceKey: string; revision: number };
              };
            }
          >;
        };
        if (finalAdmission === "retryable") {
          assert.equal(state.items[itemKey]?.state, "pending");
          assert.equal(state.items[itemKey]?.attempts, 0);
          assert.ok(state.items[itemKey]!.nextAttemptAt > Date.now());
          assert.equal(
            Object.keys(state.items).some((key) => key.startsWith("terminal-finalization:")),
            false,
          );
          continue;
        }

        assert.equal(state.items[itemKey], undefined);
        assert.equal(
          Object.keys(state.items).some((key) => key.startsWith("terminal-finalization:")),
          false,
        );
        assert.equal(
          new ExactReviewLifecycleProjectionStore(harness.storage).read(
            `openclaw/gogcli#${itemNumber}`,
            itemKey,
            1,
          )?.terminalDisposition?.kind,
          "superseded",
        );

        await harness.queue.alarm();

        assert.equal(probes, 2);
        assert.equal(itemReads, 0);
        assert.equal(targetTokens, 0);
        assert.equal(harness.dispatched.length, 0);
      } finally {
        harness.restore();
      }
    }
  }
});

test("ordinary command admission does not finalize a newer status revision", async () => {
  const itemNumber = 8_103;
  const oldMarker = `<!-- clawsweeper-command-status:${itemNumber}:re_review:${"a".repeat(40)} -->`;
  const newMarker = `<!-- clawsweeper-command-status:${itemNumber}:re_review:${"b".repeat(40)} -->`;
  let admission: HostedPublicTargetProbe = "public";
  let probes = 0;
  let targetTokens = 0;
  let releaseProbe!: () => void;
  let signalProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    signalProbe = resolve;
  });
  const probeRelease = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    hostedPublicTargetProbe: async () => {
      probes += 1;
      if (probes === 2) {
        signalProbe();
        await probeRelease;
      }
      return admission;
    },
    targetAccessToken: (_installationId, init) => {
      const body = JSON.parse(String(init?.body)) as {
        permissions?: Record<string, string>;
      };
      if (body.permissions?.issues === "read") targetTokens += 1;
      return jsonResponse({ token: "queue-token" });
    },
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "command-race-old",
            itemNumber,
            "legacy_dispatch",
            "issue",
            undefined,
            {
              commandStatusMarker: oldMarker,
              statusCommentId: 81_030,
            },
          ),
        )
      ).status,
      202,
    );
    const alarm = harness.queue.alarm();
    await probeStarted;
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "command-race-new",
            itemNumber,
            "legacy_dispatch",
            "issue",
            undefined,
            {
              commandStatusMarker: newMarker,
              statusCommentId: 81_031,
            },
          ),
        )
      ).status,
      202,
    );
    const itemKey = `openclaw/gogcli#${itemNumber}`;
    const beforeRelease = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { revision: number; decision: { commandStatusMarker?: string; statusCommentId?: number } }
      >;
    };
    const driverKey = `terminal-finalization:${itemKey}:1`;
    assert.equal(beforeRelease.items[driverKey]?.decision.commandStatusMarker, oldMarker);
    admission = "terminal";
    releaseProbe();
    await alarm;

    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { revision: number; decision: { commandStatusMarker?: string; statusCommentId?: number } }
      >;
    };
    assert.equal(state.items[itemKey]?.revision, 2);
    assert.equal(state.items[itemKey]?.decision.commandStatusMarker, newMarker);
    assert.equal(state.items[itemKey]?.decision.statusCommentId, 81_031);
    assert.equal(state.items[driverKey]?.decision.commandStatusMarker, oldMarker);
    assert.equal(
      Object.keys(state.items).filter((key) => key.startsWith("terminal-finalization:")).length,
      1,
    );
    assert.equal(harness.dispatched.length, 0);

    for (const item of Object.values(state.items)) {
      item.nextAttemptAt = Date.now() - 1;
    }
    state.dispatcher.reviewAdmissionNextAt = 0;
    await harness.storage.put("exact-review-queue", state);
    await harness.queue.alarm();

    const terminal = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(Object.keys(terminal.items).length, 0);
    assert.equal(harness.dispatched.length, 0);
    assert.equal(targetTokens, 0);
  } finally {
    harness.restore();
  }
});

test("private transition retires publication work without erasing durable fences", async () => {
  let admission: HostedPublicTargetProbe = "public";
  let targetTokens = 0;
  const itemNumber = 8088;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:${itemNumber}0:1`;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    hostedPublicTargetProbe: async () => admission,
    targetAccessToken: (_installationId, init) => {
      const body = JSON.parse(String(init?.body)) as {
        permissions?: Record<string, string>;
      };
      if (body.permissions?.issues === "read") targetTokens += 1;
      return jsonResponse({ token: "queue-token" });
    },
  });
  try {
    const request = () =>
      buildExactReviewQueueRequest(
        "publication-private-transition",
        itemNumber,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(itemNumber, `${itemNumber}0`),
      );
    assert.equal((await harness.queue.fetch(request())).status, 202);
    await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/lifecycle-audit/inventory", {
        method: "POST",
        body: "{}",
      }),
    );
    const generationBefore = Number(
      Array.from(
        harness.storage.sql.exec(
          "SELECT storage_generation FROM exact_review_queue_meta WHERE singleton_id = 1",
        ),
      )[0]?.storage_generation,
    );
    admission = "terminal";

    await harness.queue.alarm();

    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items[itemKey], undefined);
    assert.equal(targetTokens, 0);
    assert.equal(sqlCount(harness.storage, "exact_review_queue_deliveries"), 1);
    assert.equal(sqlCount(harness.storage, "exact_review_publication_heads"), 1);
    assert.equal(sqlCount(harness.storage, "exact_review_queue_dead_letters"), 0);
    assert.equal(sqlCount(harness.storage, "exact_review_lifecycle_audit_snapshots_v1"), 1);
    assert.equal(sqlCount(harness.storage, "exact_review_lifecycle_audit_snapshot_rows_v1"), 1);
    const lifecycle = new ExactReviewLifecycleProjectionStore(harness.storage).read(
      `openclaw/gogcli#${itemNumber}`,
      itemKey,
      1,
    );
    assert.equal(lifecycle?.terminalDisposition?.kind, "superseded");
    const generationAfter = Number(
      Array.from(
        harness.storage.sql.exec(
          "SELECT storage_generation FROM exact_review_queue_meta WHERE singleton_id = 1",
        ),
      )[0]?.storage_generation,
    );
    assert.ok(generationAfter > generationBefore);

    admission = "public";
    const replay = await harness.queue.fetch(request());
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).deduped, true);
    const replayed = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(replayed.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("unknown publication visibility defers without spending an attempt", async () => {
  let admission: HostedPublicTargetProbe = "public";
  let targetTokens = 0;
  const itemNumber = 8089;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:${itemNumber}0:1`;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    hostedPublicTargetProbe: async () => admission,
    targetAccessToken: (_installationId, init) => {
      const body = JSON.parse(String(init?.body)) as {
        permissions?: Record<string, string>;
      };
      if (body.permissions?.issues === "read") targetTokens += 1;
      return jsonResponse({ token: "queue-token" });
    },
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "publication-unknown-transition",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(itemNumber, `${itemNumber}0`),
          ),
        )
      ).status,
      202,
    );
    admission = "retryable";

    await harness.queue.alarm();

    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { attempts: number; publicationFailureAttempts?: number; state: string }
      >;
    };
    assert.deepEqual(
      {
        attempts: state.items[itemKey]?.attempts,
        publicationFailureAttempts: state.items[itemKey]?.publicationFailureAttempts,
        state: state.items[itemKey]?.state,
      },
      { attempts: 0, publicationFailureAttempts: undefined, state: "pending" },
    );
    assert.equal(targetTokens, 0);
  } finally {
    harness.restore();
  }
});

test("single claim terminalizes a target before recording a workflow claim", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(8081, "unclaimed");
  item.claimedRunId = undefined;
  item.claimedRunAttempt = undefined;
  item.claimGeneration = undefined;
  item.claimProtocolVersion = undefined;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { hostedPublicTargetProbe: async () => "terminal" },
  );

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        run_id: "80810",
        run_attempt: 1,
      }),
    }),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "private_target_unsupported" });
  const state = (await storage.get("exact-review-queue")) as { items: Record<string, unknown> };
  assert.equal(state.items[item.key], undefined);
});

test("publication batch preflight terminalizes private members and releases retryable members", async () => {
  async function runAdmission(repo: string, number: number, admission: HostedPublicTargetProbe) {
    const storage = new MemoryDurableStorage();
    const env = {
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      EXACT_REVIEW_PUBLICATION_BATCH_SIZE: "1",
      EXACT_REVIEW_PUBLICATION_BATCH_WAIT_MS: "0",
    };
    const queued = await new ExactReviewQueue({ storage }, env).fetch(
      buildExactReviewQueueRequest(
        `publication-${admission}`,
        number,
        "exact_review_artifact_publish",
        "issue",
        repo,
        exactReviewPublicationOverrides(number, `${number}0`, "opened", 1, repo),
      ),
    );
    assert.equal(queued.status, 202);
    const response = await new ExactReviewQueue(
      { storage },
      { ...env, hostedPublicTargetProbe: async () => admission },
    ).fetch(
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({
          claim_id: `admission-${admission}`,
          lease_owner: "publication-worker",
          max_items: 1,
        }),
      }),
    );
    return {
      body: await response.json(),
      state: (await storage.get("exact-review-queue")) as {
        items: Record<string, unknown>;
      },
    };
  }

  const terminal = await runAdmission("openclaw/fs-safe", 8082, "terminal");
  assert.deepEqual(terminal.body, {
    ok: true,
    claimed: false,
    batch: null,
    requested_max_items: 1,
    effective_max_items: 1,
    reason: "private_target_unsupported",
  });
  assert.equal(terminal.state.items["openclaw/fs-safe#8082@publish:80820:1"], undefined);

  const retryable = await runAdmission("openclaw/fs-safe", 8083, "retryable");
  assert.deepEqual(retryable.body, {
    ok: true,
    claimed: false,
    batch: null,
    requested_max_items: 1,
    effective_max_items: 1,
    reason: "target_visibility_unverified",
    retryable: true,
  });
  assert.ok(retryable.state.items["openclaw/fs-safe#8083@publish:80830:1"]);
});

test("exact-review queue coalesces deliveries, dispatches a bound rollout snapshot, and rejects duplicate claims", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  let workflowState = "disabled_manually";
  let signalWorkflowCheckStarted!: () => void;
  let releaseWorkflowCheck!: () => void;
  const workflowCheckStarted = new Promise<void>((resolve) => {
    signalWorkflowCheckStarted = resolve;
  });
  const workflowCheckRelease = new Promise<void>((resolve) => {
    releaseWorkflowCheck = resolve;
  });
  let wroteActiveLease = false;
  const storagePut = storage.put.bind(storage);
  storage.put = async (key, value) => {
    if (key === "exact-review-queue") {
      const snapshot = value as { items?: Record<string, { state?: string }> };
      wroteActiveLease ||= Object.values(snapshot.items || {}).some(
        (item) => item.state === "dispatching" || item.state === "leased",
      );
    }
    await storagePut(key, value);
  };
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      signalWorkflowCheckStarted();
      await workflowCheckRelease;
      return jsonResponse({ state: workflowState });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname)) {
      return jsonResponse({ id: 999 });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname)) {
      return jsonResponse({ state: "open" });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer dispatch-token");
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1",
      },
    );
    const commandStatusMarker =
      "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
    const first = buildExactReviewQueueRequest("delivery-1", 597, "opened", "issue", undefined, {
      commandStatusMarker,
      statusCommentId: 9001,
      additionalPrompt: "Check the maintainer-requested regression path.",
      codexTimeoutMs: 1_200_000,
      mediaProofTimeoutMs: 480_000,
    });
    const duplicate = first.clone();
    const latest = buildExactReviewQueueRequest("delivery-2", 597, "edited");
    const second = buildExactReviewQueueRequest("delivery-3", 598, "opened");
    assert.equal((await queue.fetch(duplicate)).status, 202);
    assert.equal((await queue.fetch(latest)).status, 202);
    assert.equal((await queue.fetch(second)).status, 202);
    assert.equal((await queue.fetch(first)).status, 202);

    const alarm = queue.alarm();
    await workflowCheckStarted;
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-during-preflight", 600, "opened")))
        .status,
      202,
    );
    releaseWorkflowCheck();
    await alarm;
    let stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 3);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.dispatcher.state, "paused");
    assert.equal(stats.dispatcher.reason, "workflow_not_active");
    assert.equal(stats.dispatcher.workflow_state, "disabled_manually");
    assert.equal(wroteActiveLease, false);
    assert.equal(dispatched.length, 0);

    const pausedState = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number }>;
    };
    assert.ok(
      Object.values(pausedState.items).some(
        (item) => item.nextAttemptAt < pausedState.dispatcher.retryAt,
      ),
    );
    // Simulate the pre-repair persisted state, which moved the whole backlog
    // to the dispatcher retry. At the scheduled wake, recovery must not need
    // an operator rewrite.
    pausedState.dispatcher.retryAt = Date.now() - 1;
    for (const item of Object.values(pausedState.items)) {
      item.nextAttemptAt = pausedState.dispatcher.retryAt;
    }
    await storage.put("exact-review-queue", pausedState);
    workflowState = "active";
    await queue.alarm();
    assert.equal(dispatched.length, 1);
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.dispatching, 1);
    assert.equal(stats.leased, 0);
    assert.equal(stats.handoff_health.status, "healthy");
    assert.equal(stats.handoff_health.phases.dispatching.count, 1);
    assert.equal(typeof stats.oldest_dispatching_age_seconds, "number");
    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm > Date.now() + 60_000);
    const payload = dispatched[0].client_payload as Record<string, unknown>;
    const leaseId = String(payload.queue_lease_id || "");
    assert.match(leaseId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(payload, {
      queue_lease_id: leaseId,
      queue_claim: {
        protocol_version: 2,
        item_key: "openclaw/gogcli#597",
        lease_revision: 2,
      },
      target_repo: "openclaw/gogcli",
      target_branch: "main",
      item_number: 597,
      item_kind: "issue",
      source_event: "issues",
      source_action: "edited",
      supersedes_in_progress: true,
      review_options: {
        codex_timeout_ms: 1_200_000,
        media_proof_timeout_ms: 480_000,
        command_status_marker: commandStatusMarker,
        status_comment_id: 9001,
        additional_prompt: "Check the maintainer-requested regression path.",
      },
    });
    assert.equal(Object.keys(payload).length, 10);

    const newer = buildExactReviewQueueRequest("delivery-4", 597, "synchronize", "pull_request");
    assert.equal((await queue.fetch(newer)).status, 202);

    const claimed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#597",
          lease_revision: 2,
          run_id: "100",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claimed.status, 409);
    assert.deepEqual(await claimed.json(), { error: "lease_not_active" });
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.leased, 0);
    const requeued = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          revision: number;
          attempts: number;
          nextAttemptAt: number;
          decision: Record<string, unknown>;
        }
      >;
    };
    assert.equal(requeued.items["openclaw/gogcli#597"].state, "pending");
    assert.equal(requeued.items["openclaw/gogcli#597"].revision, 3);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.commandStatusMarker, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.statusCommentId, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].decision.additionalPrompt, undefined);
    assert.equal(requeued.items["openclaw/gogcli#597"].attempts, 0);
    assert.ok(requeued.items["openclaw/gogcli#597"].nextAttemptAt <= Date.now());
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 3);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.leased, 0);
    assert.match(String(stats.oldest_pending_at), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue resolves a closed item before dispatch", async () => {
  const harness = createExactReviewAdmissionHarness(
    (_targetRepo, itemNumber) =>
      jsonResponse({ state: itemNumber === 113_347 ? "open" : "closed" }),
    { dispatch: () => jsonResponse({ message: "temporary failure" }, { status: 500 }) },
  );
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("terminal-item", 597, "opened")))
        .status,
      202,
    );

    await harness.queue.alarm();

    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(harness.dispatched.length, 0);
    assert.equal(stats.pending, 0);
    assert.equal(stats.dispatching, 0);
    assert.equal(stats.lanes.review.completed_total, 1);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items["openclaw/gogcli#597"], undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue dispatches a closed command item to complete its acknowledgement", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "closed" }));
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("terminal-command-item", 597, "opened", "issue", undefined, {
            commandStatusMarker,
            statusCommentId: 9001,
          }),
        )
      ).status,
      202,
    );
    const seeded = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          attempts: number;
          reviewFailureAttempts?: number;
          dispatchFailureStatus?: number;
          dispatchFailureClass?: string;
          dispatchFailureAt?: number;
          dispatchFailureFingerprint?: string;
        }
      >;
    };
    Object.assign(seeded.items["openclaw/gogcli#597"]!, {
      attempts: 1,
      reviewFailureAttempts: 1,
      dispatchFailureStatus: 503,
      dispatchFailureClass: "github_outage",
      dispatchFailureAt: 1_785_000_000_000,
      dispatchFailureFingerprint: "github_outage:503:upstream",
    });
    await harness.storage.put("exact-review-queue", seeded);

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          leaseDecision?: { commandStatusMarker?: string; statusCommentId?: number };
        }
      >;
    };
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "dispatching");
    assert.equal(
      state.items["openclaw/gogcli#597"]?.leaseDecision?.commandStatusMarker,
      commandStatusMarker,
    );
    assert.equal(state.items["openclaw/gogcli#597"]?.leaseDecision?.statusCommentId, 9001);
  } finally {
    harness.restore();
  }
});

test("exact-review queue limits live admission probes to one bounded pass", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-24T23:45:00.000Z");
  Date.now = () => now;
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    { maxConcurrent: "16" },
  );
  try {
    for (let index = 0; index < 10; index += 1) {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              `bounded-admission-${index}`,
              700 + index,
              "opened",
              "issue",
            ),
          )
        ).status,
        202,
      );
    }

    await harness.queue.alarm();

    assert.equal(liveChecks, 4);
    assert.equal(harness.dispatched.length, 0);
    let stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 6);
    assert.equal(stats.lanes.review.completed_total, 4);
    assert.equal(await harness.storage.getAlarm(), now + 5_000);

    await harness.queue.alarm();

    assert.equal(liveChecks, 4);
    now += 5_000;
    await harness.queue.alarm();

    assert.equal(liveChecks, 8);
    stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 2);
    assert.equal(stats.lanes.review.completed_total, 8);

    now += 5_000;
    await harness.queue.alarm();

    assert.equal(liveChecks, 10);
    stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.pending, 0);
    assert.equal(stats.lanes.review.completed_total, 10);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review queue throttles partial terminal admission passes", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-24T23:50:00.000Z");
  Date.now = () => now;
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    { maxConcurrent: "1" },
  );
  try {
    for (let index = 0; index < 2; index += 1) {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(`partial-admission-${index}`, 800 + index, "opened"),
          )
        ).status,
        202,
      );
    }

    await harness.queue.alarm();

    assert.equal(liveChecks, 1);
    assert.equal(await harness.storage.getAlarm(), now + 5_000);
    await harness.queue.alarm();
    assert.equal(liveChecks, 1);

    now += 5_000;
    await harness.queue.alarm();
    assert.equal(liveChecks, 2);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review queue resolves missing target responses before dispatch", async () => {
  for (const status of [404, 410]) {
    const harness = createExactReviewAdmissionHarness(() => new Response(null, { status }));
    try {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(`missing-item-${status}`, 597, "opened"),
          )
        ).status,
        202,
      );

      await harness.queue.alarm();

      const stats = await (
        await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
      ).json();
      assert.equal(harness.dispatched.length, 0);
      assert.equal(stats.pending, 0);
      assert.equal(stats.dispatching, 0);
    } finally {
      harness.restore();
    }
  }
});

test("exact-review queue terminalizes every admitted ordinary publication before legacy dispatch", async () => {
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    (_targetRepo, itemNumber) => {
      liveChecks += 1;
      return jsonResponse({ state: itemNumber === 9215 ? "closed" : "open" });
    },
    { maxConcurrent: "16" },
  );
  try {
    for (let itemNumber = 9211; itemNumber <= 9215; itemNumber += 1) {
      const itemKind = itemNumber === 9215 ? "pull_request" : "issue";
      const publication = exactReviewPublicationOverrides(
        itemNumber,
        String(itemNumber * 10),
        "opened",
        1,
        "openclaw/gogcli",
      );
      if (itemKind === "pull_request") {
        publication.publication.producerDecision.itemKind = "pull_request";
        publication.publication.producerDecision.sourceEvent = "pull_request";
      }
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              `legacy-terminal-${itemNumber}`,
              itemNumber,
              "exact_review_artifact_publish",
              itemKind,
              "openclaw/gogcli",
              publication,
            ),
          )
        ).status,
        202,
      );
    }

    await harness.queue.alarm();

    // The legacy admission can contain more rows than the four-review probe.
    // Its fifth item is a merged pull request and must never be dispatched.
    assert.equal(liveChecks, 5);
    assert.equal(harness.dispatched.length, 4);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.completed_total, 1);
    assert.equal(stats.lanes.publication.superseded_total, 1);
    const terminal = await (
      await harness.queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fgogcli&item_number=9215",
        ),
      )
    ).json();
    assert.equal(terminal.items.length, 0);
  } finally {
    harness.restore();
  }
});

test("terminal publication cleanup does not block review admission in the same alarm", async () => {
  const publicationNumber = 9220;
  const reviewNumber = 9221;
  const harness = createExactReviewAdmissionHarness(
    (_targetRepo, itemNumber) =>
      jsonResponse({ state: itemNumber === publicationNumber ? "closed" : "open" }),
    {
      maxConcurrent: "1",
      publicationBatching: true,
      publicationBatchSize: "1",
      captureBatchDispatch: true,
    },
  );
  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest(
        "terminal-publication-ahead-of-review",
        publicationNumber,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(publicationNumber, "92200"),
      ),
    );
    await harness.queue.fetch(
      buildExactReviewQueueRequest("review-behind-terminal-publication", reviewNumber, "opened"),
    );

    await harness.queue.alarm();

    assert.equal(harness.batchDispatches, 0);
    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]?.client_payload.item_number, reviewNumber);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.completed_total, 1);
    assert.equal(stats.lanes.review.dispatching, 1);
  } finally {
    harness.restore();
  }
});

test("publication reconcile terminalizes a completed protocol-v1 publication after its target closes", async () => {
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => {
    liveChecks += 1;
    return jsonResponse({ state: "closed" });
  });
  const itemNumber = 9301;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560737:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-terminal",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(itemNumber, "30091560737"),
          ),
        )
      ).status,
      202,
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 1);
    assert.equal(reconciled.changed, 1);
    assert.equal(reconciled.legacy_terminal_eligible, 1);
    assert.equal(reconciled.legacy_terminal_changed, 1);
    assert.equal(reconciled.eligible_remaining, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("publication reconcile dry runs verify terminal legacy rows without deleting them", async () => {
  let terminal = false;
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => {
    liveChecks += 1;
    return jsonResponse({ state: terminal ? "closed" : "open" });
  });
  const itemNumber = 9307;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560744:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-dry-run",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(itemNumber, "30091560744"),
          ),
        )
      ).status,
      202,
    );

    const reconcile = () =>
      harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: false, max_items: 100 }),
        }),
      );
    const openResult = await (await reconcile()).json();
    assert.equal(liveChecks, 1);
    assert.equal(openResult.legacy_terminal_candidates, 1);
    assert.equal(openResult.legacy_terminal_selected, 1);
    assert.equal(openResult.legacy_terminal_eligible, 0);
    assert.equal(openResult.changed, 0);

    terminal = true;
    const terminalResult = await (await reconcile()).json();
    assert.equal(liveChecks, 2);
    assert.equal(terminalResult.legacy_terminal_eligible, 1);
    assert.equal(terminalResult.changed, 0);
    assert.deepEqual(
      {
        command_context: terminalResult.sample[0]?.command_context,
        acknowledgement_state: terminalResult.sample[0]?.acknowledgement_state,
        supersede_safe: terminalResult.sample[0]?.supersede_safe,
      },
      {
        command_context: false,
        acknowledgement_state: "not_required",
        supersede_safe: false,
      },
    );
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(state.items[itemKey]);
  } finally {
    harness.restore();
  }
});

test("publication reconcile terminalizes a closed legacy publication after its lease expires", async () => {
  let liveChecks = 0;
  let probeState: string | undefined;
  const harness = createExactReviewAdmissionHarness(async () => {
    liveChecks += 1;
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string }>;
    };
    probeState = state.items[itemKey]?.state;
    return jsonResponse({ state: "closed" });
  });
  const itemNumber = 9306;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560743:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-expired-lease",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(itemNumber, "30091560743"),
          ),
        )
      ).status,
      202,
    );
    const stored = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    const item = stored.items[itemKey]!;
    Object.assign(item, {
      state: "leased",
      leaseId: "expired-legacy-lease",
      leaseRevision: 1,
      leaseExpiresAt: Date.now() - 1,
      claimedRunId: "9306",
      claimedAt: Date.now() - 60_000,
      leaseDecision: item.decision,
    });
    await harness.storage.put("exact-review-queue", stored);

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 1);
    assert.equal(probeState, "pending");
    assert.equal(reconciled.changed, 1);
    const after = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(after.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("publication reconcile terminalizes a legacy row with outer-only command context", async () => {
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => {
    liveChecks += 1;
    return jsonResponse({ state: "closed" });
  });
  const itemNumber = 9302;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560738:1`;
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:9302:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-command-awaiting-ack",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            {
              ...legacyExactReviewPublicationOverrides(itemNumber, "30091560738"),
              commandStatusMarker,
            },
          ),
        )
      ).status,
      202,
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 1);
    assert.equal(reconciled.changed, 1);
    assert.equal(reconciled.legacy_terminal_eligible, 1);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { commandStatusMarker?: string } }>;
    };
    assert.equal(state.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("publication reconcile preserves a legacy publication owned by an active batch", async () => {
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    { publicationBatching: true },
  );
  const itemNumber = 9303;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560739:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-active-batch",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(itemNumber, "30091560739"),
          ),
        )
      ).status,
      202,
    );
    const claim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({
            claim_id: "legacy-v1-active-batch",
            lease_owner: "legacy-v1-owner",
            max_items: 1,
          }),
        }),
      )
    ).json();
    assert.equal(claim.claimed, true);

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 0);
    assert.equal(reconciled.changed, 0);
    assert.equal(reconciled.legacy_terminal_eligible, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(state.items[itemKey]);
  } finally {
    harness.restore();
  }
});

test("publication reconcile preserves active legacy leases and newer publication authority", async () => {
  let terminal = false;
  let liveChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => {
    liveChecks += 1;
    return jsonResponse({ state: terminal ? "closed" : "open" });
  });
  const leasedItemNumber = 9304;
  const leasedItemKey = `openclaw/gogcli#${leasedItemNumber}@publish:30091560740:1`;
  const supersededItemNumber = 9305;
  const supersededItemKey = `openclaw/gogcli#${supersededItemNumber}@publish:30091560741:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-active-lease",
            leasedItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(leasedItemNumber, "30091560740"),
          ),
        )
      ).status,
      202,
    );
    await harness.queue.alarm();
    const dispatched = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId?: string }>;
    };
    const leaseId = dispatched.items[leasedItemKey]?.leaseId;
    assert.ok(leaseId);
    assert.equal(
      (
        await harness.queue.fetch(
          new Request("https://clawsweeper-exact-review-queue/claim", {
            method: "POST",
            body: JSON.stringify({ lease_id: leaseId, run_id: "9304" }),
          }),
        )
      ).status,
      200,
    );

    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v1-newer-authority",
            supersededItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            legacyExactReviewPublicationOverrides(supersededItemNumber, "30091560741"),
          ),
        )
      ).status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "v2-newer-authority",
            supersededItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(supersededItemNumber, "30091560742", "opened", 2),
          ),
        )
      ).status,
      202,
    );

    terminal = true;
    const checksBeforeReconcile = liveChecks;
    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, checksBeforeReconcile);
    assert.equal(reconciled.changed, 0);
    assert.equal(reconciled.legacy_terminal_eligible, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string }>;
    };
    assert.equal(state.items[leasedItemKey]?.state, "leased");
    assert.ok(state.items[supersededItemKey]);
  } finally {
    harness.restore();
  }
});

test("publication reconcile terminalizes a completed protocol-v2 state-batch publication after its target closes", async () => {
  let liveChecks = 0;
  const producerChecks: Array<[string, number | null, string]> = [];
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      producerRun: (runId, runAttempt, kind) => {
        producerChecks.push([runId, runAttempt, kind]);
        return jsonResponse({
          id: runId,
          run_attempt: 1,
          status: "completed",
          ...(kind === "attempt" ? { conclusion: "success" } : {}),
        });
      },
    },
  );
  const itemNumber = 113313;
  const producerRunId = "30091560737";
  const itemKey = `openclaw/openclaw#${itemNumber}@publish:${producerRunId}:1`;
  const rootPublication = exactReviewPublicationOverrides(
    itemNumber,
    producerRunId,
    "synchronize",
    1,
    "openclaw/openclaw",
  );
  rootPublication.publication.producerDecision = {
    ...rootPublication.publication.producerDecision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
  };
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-state-batch-terminal",
            itemNumber,
            "exact_review_artifact_publish",
            "pull_request",
            "openclaw/openclaw",
            rootPublication,
          ),
        )
      ).status,
      202,
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.deepEqual(producerChecks, [
      [producerRunId, null, "summary"],
      [producerRunId, 1, "attempt"],
    ]);
    assert.equal(liveChecks, 1);
    assert.equal(reconciled.changed, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_candidates, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_selected, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_producer_succeeded, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_eligible, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_changed, 1);
    assert.deepEqual(
      {
        command_context: reconciled.sample[0]?.command_context,
        acknowledgement_state: reconciled.sample[0]?.acknowledgement_state,
        supersede_safe: reconciled.sample[0]?.supersede_safe,
      },
      {
        command_context: false,
        acknowledgement_state: "not_required",
        supersede_safe: false,
      },
    );
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("publication reconcile terminalizes a protocol-v2 row with outer-only command context", async () => {
  let liveChecks = 0;
  let producerChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      producerRun: (runId, _runAttempt, kind) => {
        producerChecks += 1;
        return jsonResponse({
          id: runId,
          run_attempt: 1,
          status: "completed",
          ...(kind === "attempt" ? { conclusion: "success" } : {}),
        });
      },
    },
  );
  const itemNumber = 9313;
  const producerRunId = "30091560738";
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:${producerRunId}:1`;
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:9313:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-command-awaiting-ack",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            {
              ...exactReviewPublicationOverrides(itemNumber, producerRunId),
              commandStatusMarker,
            },
          ),
        )
      ).status,
      202,
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 1);
    assert.equal(producerChecks, 2);
    assert.equal(reconciled.changed, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_candidates, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_eligible, 1);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { decision: { commandStatusMarker?: string } }>;
    };
    assert.equal(state.items[itemKey], undefined);
  } finally {
    harness.restore();
  }
});

test("publication reconcile preserves protocol-v2 state-batch rows owned by an active batch or lease", async () => {
  let batchLiveChecks = 0;
  let batchProducerChecks = 0;
  const batchHarness = createExactReviewAdmissionHarness(
    () => {
      batchLiveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      publicationBatching: true,
      producerRun: () => {
        batchProducerChecks += 1;
        return jsonResponse({ id: "30091560739", run_attempt: 1, status: "completed" });
      },
    },
  );
  const batchItemNumber = 9314;
  const batchItemKey = `openclaw/gogcli#${batchItemNumber}@publish:30091560739:1`;
  try {
    assert.equal(
      (
        await batchHarness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-active-batch",
            batchItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(batchItemNumber, "30091560739"),
          ),
        )
      ).status,
      202,
    );
    const claim = await (
      await batchHarness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({
            claim_id: "legacy-v2-active-batch",
            lease_owner: "legacy-v2-owner",
            max_items: 1,
          }),
        }),
      )
    ).json();
    assert.equal(claim.claimed, true);
    const batchReconciled = await (
      await batchHarness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();
    assert.equal(batchLiveChecks, 0);
    assert.equal(batchProducerChecks, 0);
    assert.equal(batchReconciled.changed, 0);
    assert.equal(batchReconciled.legacy_state_batch_terminal_candidates, 0);
    const batchState = (await batchHarness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(batchState.items[batchItemKey]);
  } finally {
    batchHarness.restore();
  }

  let leaseLiveChecks = 0;
  let leaseProducerChecks = 0;
  const leaseHarness = createExactReviewAdmissionHarness(
    () => {
      leaseLiveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      producerRun: () => {
        leaseProducerChecks += 1;
        return jsonResponse({ id: "30091560740", run_attempt: 1, status: "completed" });
      },
    },
  );
  const leaseItemNumber = 9315;
  const leaseItemKey = `openclaw/gogcli#${leaseItemNumber}@publish:30091560740:1`;
  try {
    assert.equal(
      (
        await leaseHarness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-active-lease",
            leaseItemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(leaseItemNumber, "30091560740"),
          ),
        )
      ).status,
      202,
    );
    const stored = (await leaseHarness.storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    const item = stored.items[leaseItemKey]!;
    Object.assign(item, {
      state: "leased",
      leaseId: "active-legacy-v2-lease",
      leaseRevision: 1,
      leaseExpiresAt: Date.now() + 60_000,
      claimedRunId: "9315",
      claimedAt: Date.now(),
      leaseDecision: item.decision,
    });
    await leaseHarness.storage.put("exact-review-queue", stored);

    const leaseReconciled = await (
      await leaseHarness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      )
    ).json();
    assert.equal(leaseLiveChecks, 0);
    assert.equal(leaseProducerChecks, 0);
    assert.equal(leaseReconciled.changed, 0);
    assert.equal(leaseReconciled.legacy_state_batch_terminal_candidates, 0);
    const leaseState = (await leaseHarness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string }>;
    };
    assert.equal(leaseState.items[leaseItemKey]?.state, "leased");
  } finally {
    leaseHarness.restore();
  }
});

test("publication reconcile leaves a protocol-v2 state-batch row to existing stale-revision handling when a newer head exists", async () => {
  let liveChecks = 0;
  let producerChecks = 0;
  const harness = createExactReviewAdmissionHarness(
    () => {
      liveChecks += 1;
      return jsonResponse({ state: "closed" });
    },
    {
      producerRun: () => {
        producerChecks += 1;
        return jsonResponse({ id: "30091560741", run_attempt: 1, status: "completed" });
      },
    },
  );
  const itemNumber = 9316;
  const itemKey = `openclaw/gogcli#${itemNumber}@publish:30091560741:1`;
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "legacy-v2-newer-head",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(itemNumber, "30091560741"),
          ),
        )
      ).status,
      202,
    );
    harness.storage.sql.exec(
      `INSERT INTO exact_review_publication_heads (target_key, source_revision, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(target_key) DO UPDATE SET source_revision = excluded.source_revision`,
      `openclaw/gogcli#${itemNumber}`,
      2,
      Date.now(),
    );

    const reconciled = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: false, max_items: 100 }),
        }),
      )
    ).json();

    assert.equal(liveChecks, 0);
    assert.equal(producerChecks, 0);
    assert.equal(reconciled.stale_revision_eligible, 1);
    assert.equal(reconciled.legacy_state_batch_terminal_candidates, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(state.items[itemKey]);
  } finally {
    harness.restore();
  }
});

test("exact-review batch preflight follows the publisher owner selection", async () => {
  const checked: Array<[string, number]> = [];
  const harness = createExactReviewAdmissionHarness(
    (targetRepo, itemNumber) => {
      checked.push([targetRepo, itemNumber]);
      return jsonResponse({ state: targetRepo === "alpha/repo" ? "closed" : "open" });
    },
    {
      publicationBatching: true,
      publicationBatchSize: "2",
      captureBatchDispatch: true,
    },
  );
  try {
    for (const [deliveryId, itemNumber, targetRepo] of [
      ["owner-alpha", 9221, "alpha/repo"],
      ["owner-beta-1", 9222, "beta/repo"],
      ["owner-beta-2", 9223, "beta/repo"],
    ] as const) {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              deliveryId,
              itemNumber,
              "exact_review_artifact_publish",
              "issue",
              targetRepo,
              exactReviewPublicationOverrides(
                itemNumber,
                String(itemNumber * 10),
                "opened",
                1,
                targetRepo,
              ),
            ),
          )
        ).status,
        202,
      );
    }

    await harness.queue.alarm();

    // The shared selector picks beta's full batch before either owner ages.
    assert.deepEqual(checked, [
      ["beta/repo", 9222],
      ["beta/repo", 9223],
    ]);
    assert.equal(harness.batchDispatches, 1);
    const alphaStatus = await (
      await harness.queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=alpha%2Frepo&item_number=9221",
        ),
      )
    ).json();
    assert.equal(alphaStatus.items.length, 1);
  } finally {
    harness.restore();
  }
});

test("exact-review batch terminal probe resets for a later departure", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-25T12:00:00.000Z");
  Date.now = () => now;
  let terminal = false;
  let dispatchAttempts = 0;
  const harness = createExactReviewAdmissionHarness(
    () => jsonResponse({ state: terminal ? "closed" : "open" }),
    {
      publicationBatching: true,
      captureBatchDispatch: true,
      batchDispatch: () => {
        dispatchAttempts += 1;
        return new Response(null, { status: 500 });
      },
    },
  );
  try {
    const itemNumber = 9231;
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "batch-probe-reset",
            itemNumber,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(itemNumber, "92310"),
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 1);
    assert.equal(dispatchAttempts, 1);

    terminal = true;
    now += 300_000;
    await harness.queue.alarm();

    // A failed dispatch begins a new departure; it must not reuse the first
    // open probe to publish the now-closed item.
    assert.equal(harness.batchDispatches, 1);
    const item = await (
      await harness.queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fgogcli&item_number=9231",
        ),
      )
    ).json();
    assert.equal(item.items.length, 0);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review batch alarm avoids redundant full queue hydrations", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    captureBatchDispatch: true,
  });
  try {
    const enqueue = buildExactReviewQueueRequest(
      "hydration-count",
      9232,
      "exact_review_artifact_publish",
      "issue",
      "openclaw/gogcli",
      exactReviewPublicationOverrides(9232, "92320"),
    );
    assert.equal((await harness.queue.fetch(enqueue)).status, 202);

    const exec = harness.storage.sql.exec.bind(harness.storage.sql);
    let fullStateReads = 0;
    harness.storage.sql.exec = (query: string, ...bindings: unknown[]) => {
      if (/\bSELECT item_key, item_json FROM exact_review_queue_items\b/.test(query)) {
        fullStateReads += 1;
      }
      return exec(query, ...bindings);
    };

    await harness.queue.alarm();

    assert.equal(harness.batchDispatches, 1);
    assert.equal(fullStateReads, 5);
  } finally {
    harness.restore();
  }
});

test("exact-review batch claims keep a newer departure fence when an older workflow arrives", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-25T13:00:00.000Z");
  Date.now = () => now;
  let releaseBatchDispatch!: () => void;
  let signalBatchDispatch!: () => void;
  const batchDispatchStarted = new Promise<void>((resolve) => {
    signalBatchDispatch = resolve;
  });
  const batchDispatchRelease = new Promise<void>((resolve) => {
    releaseBatchDispatch = resolve;
  });
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    publicationBatchSize: "2",
    publicationFreshLane: true,
    captureBatchDispatch: true,
    batchDispatch: async () => {
      signalBatchDispatch();
      await batchDispatchRelease;
      return new Response(null, { status: 204 });
    },
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "delayed-workflow-old",
            9241,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9241, "92410"),
          ),
        )
      ).status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "delayed-workflow-old-second",
            9242,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9242, "92420"),
          ),
        )
      ).status,
      202,
    );
    now += 16 * 60_000;
    const alarm = harness.queue.alarm();
    await batchDispatchStarted;

    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "delayed-workflow-fresh",
            9243,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9243, "92430"),
          ),
        )
      ).status,
      202,
    );

    const firstDelayedClaim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({ claim_id: "delayed-claim-old", lease_owner: "worker-old" }),
        }),
      )
    ).json();
    const secondDelayedClaim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({ claim_id: "delayed-claim-new", lease_owner: "worker-new" }),
        }),
      )
    ).json();
    assert.equal(firstDelayedClaim.claimed, false);
    assert.equal(firstDelayedClaim.preflight_required, true);
    assert.equal(secondDelayedClaim.claimed, false);
    assert.equal(secondDelayedClaim.preflight_required, true);

    releaseBatchDispatch();
    await alarm;
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("matching empty batch departures release their own fence and redispatch current work", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-25T14:00:00.000Z");
  Date.now = () => now;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    publicationBatchSize: "2",
    publicationFreshLane: true,
    captureBatchDispatch: true,
  });
  try {
    for (const [deliveryId, itemNumber] of [
      ["stale-departure-first", 9251],
      ["stale-departure-second", 9252],
    ] as const) {
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              deliveryId,
              itemNumber,
              "exact_review_artifact_publish",
              "issue",
              "openclaw/gogcli",
              exactReviewPublicationOverrides(itemNumber, String(itemNumber * 10)),
            ),
          )
        ).status,
        202,
      );
    }
    now += 16 * 60_000;
    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 1);

    const reserved = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: {
        publicationBatchDispatchId: string;
        publicationBatchDispatchedAt: number;
        publicationBatchDispatchPendingUntil?: number;
        publicationBatchTerminalProbe?: string;
      };
    };
    const firstDispatch = reserved.dispatcher;
    assert.ok(firstDispatch.publicationBatchTerminalProbe);
    harness.storage.sql.exec(
      "DELETE FROM exact_review_queue_items WHERE item_key IN (?, ?)",
      "openclaw/gogcli#9251@publish:92510:1",
      "openclaw/gogcli#9252@publish:92520:1",
    );

    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "stale-departure-fresh",
            9253,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9253, "92530"),
          ),
        )
      ).status,
      202,
    );

    const stale = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({
            claim_id: "matching-stale-departure",
            lease_owner: "matching-stale-worker",
            dispatch_id: firstDispatch.publicationBatchDispatchId,
            dispatched_at: new Date(firstDispatch.publicationBatchDispatchedAt).toISOString(),
          }),
        }),
      )
    ).json();
    assert.equal(stale.claimed, false);
    assert.equal(stale.preflight_required, true);

    const released = (await harness.storage.get("exact-review-queue")) as typeof reserved;
    assert.equal(released.dispatcher.publicationBatchDispatchPendingUntil, undefined);
    assert.equal(released.dispatcher.publicationBatchTerminalProbe, undefined);

    now += 300_000;
    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 2);
    const refreshed = (await harness.storage.get("exact-review-queue")) as typeof reserved;
    assert.notEqual(
      refreshed.dispatcher.publicationBatchDispatchId,
      firstDispatch.publicationBatchDispatchId,
    );
    assert.ok(refreshed.dispatcher.publicationBatchTerminalProbe);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review batch claim retries re-admit each target and return only public members", async () => {
  let retryPhase = false;
  const probes = new Map<string, number>();
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    publicationBatchSize: "3",
    captureBatchDispatch: true,
    hostedPublicTargetProbe: async (repo) => {
      probes.set(repo, (probes.get(repo) ?? 0) + 1);
      if (!retryPhase || repo === "openclaw/gogcli") return "public";
      return repo === "openclaw/fs-safe" ? "terminal" : "retryable";
    },
  });
  try {
    for (const [index, repo] of [
      "openclaw/gogcli",
      "openclaw/fs-safe",
      "openclaw/openclaw",
    ].entries()) {
      const number = 9244 + index;
      assert.equal(
        (
          await harness.queue.fetch(
            buildExactReviewQueueRequest(
              `batch-claim-retry-${index}`,
              number,
              "exact_review_artifact_publish",
              "issue",
              repo,
              exactReviewPublicationOverrides(number, `${number}0`, "opened", 1, repo),
            ),
          )
        ).status,
        202,
      );
    }
    await harness.queue.alarm();
    assert.equal(harness.batchDispatches, 1);

    const request = () =>
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({ claim_id: "retry-claim", lease_owner: "retry-worker" }),
      });
    const first = await (await harness.queue.fetch(request())).json();
    retryPhase = true;
    probes.clear();
    const resumed = await (await harness.queue.fetch(request())).json();

    assert.equal(first.claimed, true, JSON.stringify(first));
    assert.equal(resumed.claimed, true, JSON.stringify(resumed));
    assert.equal(resumed.batch.batch_id, first.batch.batch_id);
    assert.deepEqual(
      resumed.batch.items.map((item) => item.item_key),
      ["openclaw/gogcli#9244@publish:92440:1"],
    );
    assert.deepEqual(Object.fromEntries(probes), {
      "openclaw/fs-safe": 1,
      "openclaw/gogcli": 1,
      "openclaw/openclaw": 1,
    });
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { attempts: number; publicationFailureAttempts?: number; state: string }
      >;
    };
    assert.equal(state.items["openclaw/fs-safe#9245@publish:92450:1"], undefined);
    assert.deepEqual(
      {
        attempts: state.items["openclaw/openclaw#9246@publish:92460:1"]?.attempts,
        publicationFailureAttempts:
          state.items["openclaw/openclaw#9246@publish:92460:1"]?.publicationFailureAttempts,
        state: state.items["openclaw/openclaw#9246@publish:92460:1"]?.state,
      },
      { attempts: 0, publicationFailureAttempts: undefined, state: "pending" },
    );
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.dead_letters.open, 0);
  } finally {
    harness.restore();
  }
});

test("concurrent identical batch claims replay after admission clears the reservation", async () => {
  const releases: Array<() => void> = [];
  const starts: Array<Promise<void>> = [];
  let blockClaims = false;
  let probes = 0;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    captureBatchDispatch: true,
    hostedPublicTargetProbe: async () => {
      if (!blockClaims) return "public";
      probes += 1;
      let started!: () => void;
      let release!: () => void;
      starts.push(new Promise<void>((resolve) => (started = resolve)));
      const blocked = new Promise<void>((resolve) => (release = resolve));
      releases.push(release);
      started();
      await blocked;
      return "public";
    },
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "concurrent-claim",
            9248,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9248, "92480"),
          ),
        )
      ).status,
      202,
    );
    await harness.queue.alarm();
    const reserved = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: {
        publicationBatchDispatchId: string;
        publicationBatchDispatchedAt: number;
        publicationBatchDispatchPendingUntil?: number;
      };
    };
    const request = () =>
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({
          claim_id: "concurrent-claim",
          lease_owner: "concurrent-worker",
          dispatch_id: reserved.dispatcher.publicationBatchDispatchId,
          dispatched_at: new Date(reserved.dispatcher.publicationBatchDispatchedAt).toISOString(),
        }),
      });

    blockClaims = true;
    const firstPending = harness.queue.fetch(request());
    while (starts.length < 1) await Promise.resolve();
    await starts[0];
    const secondPending = harness.queue.fetch(request());
    while (starts.length < 2) await Promise.resolve();
    await starts[1];

    releases[0]();
    const first = await (await firstPending).json();
    assert.equal(first.claimed, true, JSON.stringify(first));
    const afterFirst = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: { publicationBatchDispatchPendingUntil?: number };
    };
    assert.equal(afterFirst.dispatcher?.publicationBatchDispatchPendingUntil, undefined);

    releases[1]();
    while (starts.length < 3) await Promise.resolve();
    await starts[2];
    releases[2]();
    const second = await (await secondPending).json();
    assert.equal(second.claimed, true, JSON.stringify(second));
    assert.equal(probes, 3);
    const { server_time: firstServerTime, ...firstLease } = first.batch;
    const { server_time: secondServerTime, ...secondLease } = second.batch;
    assert.ok(Date.parse(secondServerTime) >= Date.parse(firstServerTime));
    assert.deepEqual(secondLease, firstLease);
    assert.deepEqual(
      second.batch.items.map((item) => ({
        item_key: item.item_key,
        revision: item.revision,
        claim_generation: item.claim_generation,
      })),
      first.batch.items.map((item) => ({
        item_key: item.item_key,
        revision: item.revision,
        claim_generation: item.claim_generation,
      })),
    );
  } finally {
    harness.restore();
  }
});

test("exact-review batch retry rereads the membership fence after visibility I/O", async () => {
  let retry = false;
  let retryProbeBlocked = false;
  let releaseProbe!: () => void;
  let signalProbe!: () => void;
  const probeStarted = new Promise<void>((resolve) => {
    signalProbe = resolve;
  });
  const probeRelease = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
    captureBatchDispatch: true,
    hostedPublicTargetProbe: async () => {
      if (!retry) return "public";
      if (retryProbeBlocked) return "public";
      retryProbeBlocked = true;
      signalProbe();
      await probeRelease;
      return "terminal";
    },
  });
  try {
    const enqueue = (deliveryId: string, leaseRevision: number) =>
      harness.queue.fetch(
        buildExactReviewQueueRequest(
          deliveryId,
          9247,
          "exact_review_artifact_publish",
          "issue",
          "openclaw/gogcli",
          exactReviewPublicationOverrides(
            9247,
            "92470",
            leaseRevision === 1 ? "opened" : "edited",
            leaseRevision,
          ),
        ),
      );
    assert.equal((await enqueue("batch-fence-initial", 1)).status, 202);
    await harness.queue.alarm();
    const request = () =>
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({ claim_id: "retry-fence", lease_owner: "retry-worker" }),
      });
    assert.equal((await (await harness.queue.fetch(request())).json()).claimed, true);

    retry = true;
    const retryClaim = harness.queue.fetch(request());
    await probeStarted;
    assert.equal((await enqueue("batch-fence-newer", 2)).status, 202);
    releaseProbe();
    const resumed = await (await retryClaim).json();
    assert.equal(resumed.claimed, true);
    assert.deepEqual(resumed.batch.items, []);

    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { revision: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#9247@publish:92470:1"]?.revision, 2);
  } finally {
    harness.restore();
  }
});

test("exact-review batch accepts an in-flight pre-probe rolling-deploy departure", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-07-25T14:00:00.000Z");
  Date.now = () => now;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    publicationBatching: true,
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "pre-probe-departure",
            9245,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/gogcli",
            exactReviewPublicationOverrides(9245, "92450"),
          ),
        )
      ).status,
      202,
    );
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: Record<string, unknown>;
    };
    state.dispatcher = {
      state: "active",
      checkedAt: now,
      publicationBatchDispatchedAt: now,
      publicationBatchDispatchPendingUntil: now + 600_000,
    };
    await harness.storage.put("exact-review-queue", state);

    const claim = await (
      await harness.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
          method: "POST",
          body: JSON.stringify({ claim_id: "pre-probe-claim", lease_owner: "pre-probe-worker" }),
        }),
      )
    ).json();
    assert.equal(claim.claimed, true, JSON.stringify(claim));
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review queue retains a 404 item when the target repository is inaccessible", async () => {
  const harness = createExactReviewAdmissionHarness(() => new Response(null, { status: 404 }), {
    targetRepository: () => new Response(null, { status: 404 }),
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("inaccessible-target", 597, "opened"),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 1);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, 1);
  } finally {
    harness.restore();
  }
});

test("exact-review queue dispatches an item that remains open", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }));
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("open-item", 597, "opened"))).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.dispatching, 1);
  } finally {
    harness.restore();
  }
});

test("exact-review queue supersedes a stale open pull-request head before dispatch", async () => {
  const staleHeadSha = "a".repeat(40);
  const currentHeadSha = "b".repeat(40);
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    targetPull: () => jsonResponse({ state: "open", head: { sha: currentHeadSha } }),
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "stale-pr-head",
            597,
            "synchronize",
            "pull_request",
            undefined,
            {
              sourceHeadSha: staleHeadSha,
            },
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.equal(state.items["openclaw/gogcli#597"], undefined);
    const audit = Array.from(
      harness.storage.sql.exec(
        `SELECT audit_id, item_key, prior_revision, next_revision, source_action, reason_code
           FROM exact_review_queue_supersessions`,
      ),
    ).map((row) => ({ ...row }));
    assert.equal(audit.length, 1);
    assert.match(String(audit[0]?.audit_id), /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      { ...audit[0], audit_id: undefined },
      {
        audit_id: undefined,
        item_key: "openclaw/gogcli#597",
        prior_revision: 1,
        next_revision: 2,
        source_action: "synchronize",
        reason_code: "live_head_advanced",
      },
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "stale-pr-head-again",
            597,
            "synchronize",
            "pull_request",
            undefined,
            { sourceHeadSha: "c".repeat(40) },
          ),
        )
      ).status,
      202,
    );
    await harness.queue.alarm();
    const repeatedAudit = Array.from(
      harness.storage.sql.exec(
        `SELECT audit_id FROM exact_review_queue_supersessions ORDER BY superseded_at, audit_id`,
      ),
    ).map((row) => String(row.audit_id));
    assert.equal(harness.dispatched.length, 0);
    assert.equal(repeatedAudit.length, 2);
    assert.equal(new Set(repeatedAudit).size, 2);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.completed_total, 2);
    assert.equal(stats.lanes.review.superseded_total, 2);
  } finally {
    harness.restore();
  }
});

test("exact-review queue refreshes a stale pull-request command to the current head", async () => {
  const staleHeadSha = "a".repeat(40);
  const currentHeadSha = "b".repeat(40);
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    targetPull: () => jsonResponse({ state: "open", head: { sha: currentHeadSha } }),
  });
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "stale-pr-command",
            597,
            "synchronize",
            "pull_request",
            undefined,
            {
              sourceHeadSha: staleHeadSha,
              commandStatusMarker,
              statusCommentId: 9001,
            },
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    let state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          revision: number;
          attempts: number;
          dispatchFailureStatus?: number;
          dispatchFailureClass?: string;
          dispatchFailureAt?: number;
          dispatchFailureFingerprint?: string;
          decision: {
            sourceHeadSha?: string;
            sourceHeadVerified?: boolean;
            sourceAuthoritySeq?: number;
            commandStatusMarker?: string;
            statusCommentId?: number;
          };
          leaseDecision?: {
            sourceHeadSha?: string;
            commandStatusMarker?: string;
          };
        }
      >;
    };
    const refreshed = state.items["openclaw/gogcli#597"];
    assert.equal(refreshed?.state, "pending");
    assert.equal(refreshed?.revision, 2);
    assert.equal(refreshed?.attempts, 0);
    assert.equal(refreshed?.decision.sourceHeadSha, currentHeadSha);
    assert.equal(refreshed?.decision.sourceHeadVerified, true);
    assert.equal(refreshed?.decision.sourceAuthoritySeq, undefined);
    assert.equal(refreshed?.decision.commandStatusMarker, commandStatusMarker);
    assert.equal(refreshed?.decision.statusCommentId, 9001);
    assert.equal(refreshed?.dispatchFailureStatus, undefined);
    assert.equal(refreshed?.dispatchFailureClass, undefined);
    assert.equal(refreshed?.dispatchFailureAt, undefined);
    assert.equal(refreshed?.dispatchFailureFingerprint, undefined);

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    state = (await harness.storage.get("exact-review-queue")) as typeof state;
    const dispatched = state.items["openclaw/gogcli#597"];
    assert.equal(dispatched?.state, "dispatching");
    assert.equal(dispatched?.attempts, 0);
    assert.equal(dispatched?.leaseDecision?.sourceHeadSha, currentHeadSha);
    assert.equal(dispatched?.leaseDecision?.commandStatusMarker, commandStatusMarker);
  } finally {
    harness.restore();
  }
});

test("exact-review queue bounds item-specific terminal-state check failures", async () => {
  const harness = createExactReviewAdmissionHarness(
    () => new Response(JSON.stringify({ message: "unprocessable" }), { status: 422 }),
  );
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("unavailable-item", 597, "opened")))
        .status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { state: string; attempts: number; reviewFailureAttempts?: number; nextAttemptAt: number }
      >;
    };
    const item = state.items["openclaw/gogcli#597"];
    assert.equal(item?.state, "pending");
    assert.equal(item?.attempts, 1);
    assert.equal(item?.reviewFailureAttempts, 1);
    assert.ok((item?.nextAttemptAt || 0) > Date.now());
  } finally {
    harness.restore();
  }
});

test("exact-review admission warnings expose only closed categories and bounded counts", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const backpressureRepo = "privacy-sentinel/backpressure-item";
  const scheduledRepo = "privacy-sentinel/scheduled-item";
  try {
    const backpressureQueue = new ExactReviewQueue(
      { storage: new MemoryDurableStorage() },
      { EXACT_REVIEW_PENDING_SOFT_LIMIT: "1" },
    );
    await backpressureQueue.fetch(buildExactReviewQueueRequest("seed-pending", 410_000, "opened"));
    const backpressure = await backpressureQueue.fetch(
      buildExactReviewQueueRequest(
        "private-backpressure-delivery",
        410_001,
        "failed_review_shard_recovery",
        "issue",
        backpressureRepo,
      ),
    );
    assert.deepEqual(await backpressure.json(), {
      ok: true,
      shed: true,
      reason: "backpressure",
    });

    const scheduledQueue = new ExactReviewQueue(
      { storage: new MemoryDurableStorage() },
      {
        EXACT_REVIEW_TARGET_RATE_PER_HOUR: "2",
        EXACT_REVIEW_TARGET_BURST: "2",
      },
    );
    await scheduledQueue.fetch(
      buildExactReviewQueueRequest(
        "private-scheduled-first",
        410_002,
        "scheduled_hot_intake",
        "issue",
        scheduledRepo,
      ),
    );
    const scheduled = await scheduledQueue.fetch(
      buildExactReviewQueueRequest(
        "private-scheduled-second",
        410_003,
        "scheduled_hot_intake",
        "issue",
        scheduledRepo,
      ),
    );
    assert.deepEqual(await scheduled.json(), {
      ok: true,
      shed: true,
      reason: "scheduled_rate",
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [
    [
      "exact-review admission shed",
      {
        event: "admission_shed",
        category: "backpressure",
        pending_count: 1,
        configured_limit: 1,
      },
    ],
    [
      "exact-review admission shed",
      {
        event: "admission_shed",
        category: "scheduled_rate",
        lane: "hot_intake",
      },
    ],
  ]);
  assertConsoleCallsExclude(warnings, [
    backpressureRepo,
    scheduledRepo,
    `${backpressureRepo}#410001`,
    `${scheduledRepo}#410003`,
    "private-backpressure-delivery",
    "private-scheduled-second",
  ]);
});

test("exact-review operational warnings omit item identity and raw upstream failures", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  const errorMarker =
    "synthetic-upstream-title at https://privacy.invalid/failure?query=private-query-marker";
  const cases = [
    { repo: "privacy-sentinel/batch-boundary", item: 420_001 },
    { repo: "privacy-sentinel/review-boundary", item: 420_002 },
    { repo: "privacy-sentinel/publication-boundary", item: 420_003 },
    { repo: "privacy-sentinel/reconcile-boundary", item: 420_004 },
    { repo: "privacy-sentinel/token-boundary", item: 420_005 },
    { repo: "privacy-sentinel/producer-boundary", item: 420_006 },
  ] as const;
  console.warn = (...args) => warnings.push(args);
  try {
    const batch = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
      publicationBatching: true,
      captureBatchDispatch: true,
      batchDispatch: () => {
        throw new Error(`${errorMarker}:batch`);
      },
    });
    try {
      const current = cases[0];
      await batch.queue.fetch(
        buildExactReviewQueueRequest(
          "private-batch-delivery",
          current.item,
          "exact_review_artifact_publish",
          "issue",
          current.repo,
          exactReviewPublicationOverrides(
            current.item,
            String(current.item * 10),
            "opened",
            1,
            current.repo,
          ),
        ),
      );
      await batch.queue.alarm();
      assert.equal(batch.batchDispatches, 1);
    } finally {
      batch.restore();
    }

    const review = createExactReviewAdmissionHarness(() => {
      throw new Error(`${errorMarker}:review`);
    });
    try {
      const current = cases[1];
      await review.queue.fetch(
        buildExactReviewQueueRequest(
          "private-review-delivery",
          current.item,
          "opened",
          "issue",
          current.repo,
        ),
      );
      await review.queue.alarm();
      assert.equal(review.dispatched.length, 0);
    } finally {
      review.restore();
    }

    const publication = createExactReviewAdmissionHarness(() => {
      throw new Error(`${errorMarker}:publication`);
    });
    try {
      const current = cases[2];
      await publication.queue.fetch(
        buildExactReviewQueueRequest(
          "private-publication-delivery",
          current.item,
          "exact_review_artifact_publish",
          "issue",
          current.repo,
          exactReviewPublicationOverrides(
            current.item,
            String(current.item * 10),
            "opened",
            1,
            current.repo,
          ),
        ),
      );
      await publication.queue.alarm();
      assert.equal(publication.dispatched.length, 1);
    } finally {
      publication.restore();
    }

    const reconcile = createExactReviewAdmissionHarness(() => {
      throw new Error(`${errorMarker}:reconcile`);
    });
    try {
      const current = cases[3];
      await reconcile.queue.fetch(
        buildExactReviewQueueRequest(
          "private-reconcile-delivery",
          current.item,
          "exact_review_artifact_publish",
          "issue",
          current.repo,
          legacyExactReviewPublicationOverrides(
            current.item,
            String(current.item * 10),
            "opened",
            current.repo,
          ),
        ),
      );
      const response = await reconcile.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      );
      assert.equal(response.status, 200);
    } finally {
      reconcile.restore();
    }

    const token = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
      targetInstallation: () => {
        throw new Error(`${errorMarker}:token`);
      },
    });
    try {
      const current = cases[4];
      await token.queue.fetch(
        buildExactReviewQueueRequest(
          "private-token-delivery",
          current.item,
          "exact_review_artifact_publish",
          "issue",
          current.repo,
          exactReviewPublicationOverrides(
            current.item,
            String(current.item * 10),
            "opened",
            1,
            current.repo,
          ),
        ),
      );
      const response = await token.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      );
      assert.equal(response.status, 200);
    } finally {
      token.restore();
    }

    const producer = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
      producerRun: () => {
        throw new Error(`${errorMarker}:producer`);
      },
    });
    try {
      const current = cases[5];
      await producer.queue.fetch(
        buildExactReviewQueueRequest(
          "private-producer-delivery",
          current.item,
          "exact_review_artifact_publish",
          "issue",
          current.repo,
          exactReviewPublicationOverrides(
            current.item,
            String(current.item * 10),
            "opened",
            1,
            current.repo,
          ),
        ),
      );
      const response = await producer.queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/publications/reconcile", {
          method: "POST",
          body: JSON.stringify({ apply: true, max_items: 100 }),
        }),
      );
      assert.equal(response.status, 200);
    } finally {
      producer.restore();
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [
    [
      "exact-review batch workflow dispatch failed",
      { event: "batch_workflow_dispatch_failed", category: "network" },
    ],
    [
      "exact-review admission target check failed",
      { event: "admission_target_check_failed", category: "network" },
    ],
    [
      "exact-review publication terminal check failed",
      { event: "publication_terminal_check_failed", category: "network" },
    ],
    [
      "exact-review publication terminal check failed",
      { event: "publication_terminal_check_failed", category: "network" },
    ],
    [
      "exact-review legacy state-batch reconciliation could not read producer runs",
      { event: "legacy_state_batch_token_read_failed", category: "network" },
    ],
    [
      "exact-review legacy state-batch producer check failed",
      { event: "legacy_state_batch_producer_check_failed", category: "network" },
    ],
  ]);
  assertConsoleCallsExclude(warnings, [
    errorMarker,
    "synthetic-upstream-title",
    "privacy.invalid",
    "private-query-marker",
    ...cases.flatMap(({ repo, item }) => [repo, `${repo}#${item}`, String(item)]),
    "private-batch-delivery",
    "private-review-delivery",
    "private-publication-delivery",
    "private-reconcile-delivery",
    "private-token-delivery",
    "private-producer-delivery",
  ]);
});

test("exact-review authority deferral warnings omit repository, item, and exception identity", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  const errorMarker =
    "synthetic-authority-title at https://privacy.invalid/authority?query=private-authority-marker";
  const branchRepo = "privacy-sentinel/branch-authority";
  const sourceRepo = "privacy-sentinel/source-authority";
  const branchItem = 430_001;
  const sourceItem = 430_002;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    targetRepository: () => {
      throw new Error(`${errorMarker}:branch`);
    },
    targetPull: () => {
      throw new Error(`${errorMarker}:source`);
    },
  });
  console.warn = (...args) => warnings.push(args);
  try {
    const branch = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/branch-authority", {
        method: "POST",
        body: JSON.stringify({
          delivery_id: "private-branch-authority-delivery",
          installation_id: 999,
          decision: {
            targetRepo: branchRepo,
            itemNumber: branchItem,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: "legacy_dispatch",
            supersedesInProgress: false,
          },
        }),
      }),
    );
    assert.equal(branch.status, 202);

    const source = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/source-authority", {
        method: "POST",
        body: JSON.stringify({
          delivery_id: "private-source-authority-delivery",
          installation_id: 999,
          decision: {
            targetRepo: sourceRepo,
            targetBranch: "main",
            itemNumber: sourceItem,
            itemKind: "pull_request",
            sourceEvent: "pull_request",
            sourceAction: "synchronize",
            supersedesInProgress: true,
            sourceHeadSha: "a".repeat(40),
          },
        }),
      }),
    );
    assert.equal(source.status, 200);

    await harness.queue.alarm();
  } finally {
    console.warn = originalWarn;
    harness.restore();
  }

  assert.deepEqual(warnings, [
    [
      "exact-review branch authority resolution deferred",
      { event: "branch_authority_resolution_deferred", category: "network" },
    ],
    [
      "exact-review source authority verification deferred",
      { event: "source_authority_verification_deferred", category: "network" },
    ],
  ]);
  assertConsoleCallsExclude(warnings, [
    errorMarker,
    "synthetic-authority-title",
    "privacy.invalid",
    "private-authority-marker",
    branchRepo,
    sourceRepo,
    `${branchRepo}#${branchItem}`,
    `${sourceRepo}#${sourceItem}`,
    String(branchItem),
    String(sourceItem),
    "private-branch-authority-delivery",
    "private-source-authority-delivery",
  ]);
});

test("exact-review queue parks an item after repeated item-specific target-state failures", async () => {
  const harness = createExactReviewAdmissionHarness(
    () => new Response(JSON.stringify({ message: "unprocessable" }), { status: 422 }),
  );
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("repeated-unavailable", 597, "opened"),
        )
      ).status,
      202,
    );

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await harness.queue.alarm();
      const state = (await harness.storage.get("exact-review-queue")) as {
        items: Record<
          string,
          {
            state: string;
            attempts: number;
            reviewFailureAttempts?: number;
            reviewRetryPolicyEpoch?: string;
            nextAttemptAt: number;
            updatedAt: number;
            parkedReason?: string;
          }
        >;
      };
      const item = state.items["openclaw/gogcli#597"];
      assert.equal(item?.attempts, attempt);
      assert.equal(item?.reviewFailureAttempts, attempt);
      if (attempt < 8) {
        assert.equal(item?.state, "pending");
        item.nextAttemptAt = Date.now() - 1;
        await harness.storage.put("exact-review-queue", state);
      } else {
        assert.equal(item?.state, "parked");
        assert.equal(item?.parkedReason, "review_retry_exhausted");
        assert.equal(item?.reviewRetryPolicyEpoch, "1");
      }
    }
    const exhausted = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { revision: number; updatedAt: number; parkedRecoveryAttempts?: number }
      >;
    };
    const exhaustedItem = exhausted.items["openclaw/gogcli#597"];
    exhaustedItem.parkedRecoveryAttempts = 3;
    await harness.storage.put("exact-review-queue", exhausted);
    const policyQueue = new ExactReviewQueue(
      { storage: harness.storage },
      { EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" },
    );
    const policyRecovery = await policyQueue.fetch(
      new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
        method: "POST",
        body: JSON.stringify({
          items: [
            {
              item_key: "openclaw/gogcli#597",
              revision: exhaustedItem.revision,
              updated_at_ms: exhaustedItem.updatedAt,
            },
          ],
          idempotency_key: "parked-reconcile:admission-policy-epoch-2",
        }),
      }),
    );
    assert.deepEqual(await policyRecovery.json(), {
      ok: true,
      recovered: 1,
      deduped: 0,
      skipped: 0,
      unchanged: 0,
    });
    assert.equal(harness.dispatched.length, 0);
  } finally {
    harness.restore();
  }
});

test("admission failure starts a fresh budget after a retry policy epoch change", async () => {
  const harness = createExactReviewAdmissionHarness(
    () => new Response(JSON.stringify({ message: "unprocessable" }), { status: 422 }),
    { retryPolicyEpoch: "2" },
  );
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("admission-new-policy", 596, "opened"),
        )
      ).status,
      202,
    );
    const prior = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          attempts: number;
          reviewFailureAttempts?: number;
          reviewRetryPolicyEpoch?: string;
          nextAttemptAt: number;
        }
      >;
    };
    const item = prior.items["openclaw/gogcli#596"];
    item.attempts = 7;
    item.reviewFailureAttempts = 7;
    item.reviewRetryPolicyEpoch = "1";
    item.nextAttemptAt = Date.now() - 1;
    await harness.storage.put("exact-review-queue", prior);

    await harness.queue.alarm();
    const after = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          attempts: number;
          reviewFailureAttempts?: number;
          reviewRetryPolicyEpoch?: string;
        }
      >;
    };
    assert.equal(after.items["openclaw/gogcli#596"].state, "pending");
    assert.equal(after.items["openclaw/gogcli#596"].attempts, 1);
    assert.equal(after.items["openclaw/gogcli#596"].reviewFailureAttempts, 1);
    assert.equal(after.items["openclaw/gogcli#596"].reviewRetryPolicyEpoch, "2");
  } finally {
    harness.restore();
  }
});

test("exact-review queue globally backs off admission GitHub outages without charging item attempts", async () => {
  const harness = createExactReviewAdmissionHarness(
    () => new Response(JSON.stringify({ message: "unavailable" }), { status: 503 }),
  );
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("admission-outage", 597, "opened")))
        .status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: {
        state: string;
        reason: string;
        dispatchFailureStatus: number;
        dispatchConsecutiveFailures: number;
      };
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "dispatch_github_outage");
    assert.equal(state.dispatcher.dispatchFailureStatus, 503);
    assert.equal(state.dispatcher.dispatchConsecutiveFailures, 1);
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 0);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue globally backs off admission 403 rate limits without charging item attempts", async () => {
  const harness = createExactReviewAdmissionHarness(
    () =>
      new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
  );
  try {
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest("admission-rate-limit", 597, "opened"),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: {
        state: string;
        reason: string;
        dispatchFailureStatus: number;
        dispatchFailureClass: string;
      };
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "dispatch_rate_limit");
    assert.equal(state.dispatcher.dispatchFailureStatus, 403);
    assert.equal(state.dispatcher.dispatchFailureClass, "rate_limit");
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 0);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review queue keeps healthy targets moving when one target App access fails", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    maxConcurrent: "2",
    targetInstallation: (targetRepo) =>
      targetRepo === "openclaw/gogcli"
        ? new Response(JSON.stringify({ message: "not installed" }), { status: 404 })
        : jsonResponse({ id: 999 }),
  });
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("target-app-failure", 597, "opened")))
        .status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "healthy-target",
            598,
            "opened",
            "issue",
            "openclaw/openclaw",
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]?.client_payload?.target_repo, "openclaw/openclaw");
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: { state: string };
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.dispatcher.state, "active");
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 1);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, 1);
    assert.equal(state.items["openclaw/openclaw#598"]?.state, "dispatching");
  } finally {
    harness.restore();
  }
});

test("exact-review queue keeps healthy targets moving when one target item read is forbidden", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }), {
    maxConcurrent: "2",
    targetItem: (targetRepo) =>
      targetRepo === "openclaw/gogcli"
        ? new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })
        : jsonResponse({ state: "open" }),
  });
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("forbidden-target", 597, "opened")))
        .status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "healthy-target-after-forbidden",
            598,
            "opened",
            "issue",
            "openclaw/openclaw",
          ),
        )
      ).status,
      202,
    );

    await harness.queue.alarm();

    assert.equal(harness.dispatched.length, 1);
    assert.equal(harness.dispatched[0]?.client_payload?.target_repo, "openclaw/openclaw");
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher: { state: string };
      items: Record<string, { state: string; attempts: number; reviewFailureAttempts?: number }>;
    };
    assert.equal(state.dispatcher.state, "active");
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.attempts, 1);
    assert.equal(state.items["openclaw/gogcli#597"]?.reviewFailureAttempts, 1);
    assert.equal(state.items["openclaw/openclaw#598"]?.state, "dispatching");
  } finally {
    harness.restore();
  }
});

test("exact-review admission does not restore a publication batch claim reservation", async () => {
  let releaseLookup!: () => void;
  let signalLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    signalLookupStarted = resolve;
  });
  const lookupRelease = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const harness = createExactReviewAdmissionHarness(
    async () => {
      signalLookupStarted();
      await lookupRelease;
      return jsonResponse({ state: "open" });
    },
    {
      publicationBatching: true,
      dispatch: () => new Response(JSON.stringify({ message: "unavailable" }), { status: 503 }),
    },
  );
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("batch-claim-race", 597, "opened")))
        .status,
      202,
    );
    assert.equal(
      (
        await harness.queue.fetch(
          buildExactReviewQueueRequest(
            "batch-claim-publication",
            598,
            "exact_review_artifact_publish",
            "issue",
            "openclaw/openclaw",
            exactReviewPublicationOverrides(598, "5980", "opened", 1, "openclaw/openclaw"),
          ),
        )
      ).status,
      202,
    );
    const reserved = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: Record<string, unknown>;
    };
    reserved.dispatcher = {
      state: "active",
      checkedAt: Date.now(),
      publicationBatchDispatchPendingUntil: Date.now() + 5 * 60_000,
    };
    await harness.storage.put("exact-review-queue", reserved);

    const alarm = harness.queue.alarm();
    await lookupStarted;
    const claim = await harness.queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/publication-batches/claim", {
        method: "POST",
        body: JSON.stringify({
          claim_id: "admission-race-batch",
          lease_owner: "admission-race-owner",
          max_items: 1,
        }),
      }),
    );
    assert.equal((await claim.json()).claimed, true);
    const afterClaim = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: { publicationBatchDispatchPendingUntil?: number };
    };
    assert.equal(afterClaim.dispatcher?.publicationBatchDispatchPendingUntil, undefined);

    releaseLookup();
    await alarm;

    const afterAlarm = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: { publicationBatchDispatchPendingUntil?: number };
    };
    assert.equal(afterAlarm.dispatcher?.publicationBatchDispatchPendingUntil, undefined);
  } finally {
    harness.restore();
  }
});

test("exact-review terminal admission does not remove a newer queue revision", async () => {
  let releaseLookup!: () => void;
  let signalLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    signalLookupStarted = resolve;
  });
  const lookupRelease = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const harness = createExactReviewAdmissionHarness(async () => {
    signalLookupStarted();
    await lookupRelease;
    return jsonResponse({ state: "closed" });
  });
  try {
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("stale-terminal", 597, "opened")))
        .status,
      202,
    );
    const alarm = harness.queue.alarm();
    await lookupStarted;
    assert.equal(
      (await harness.queue.fetch(buildExactReviewQueueRequest("newer-revision", 597, "edited")))
        .status,
      202,
    );
    releaseLookup();
    await alarm;

    assert.equal(harness.dispatched.length, 0);
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<string, { state: string; revision: number }>;
    };
    assert.equal(state.items["openclaw/gogcli#597"]?.state, "pending");
    assert.equal(state.items["openclaw/gogcli#597"]?.revision, 2);
  } finally {
    harness.restore();
  }
});

test("exact-review queue upgrades flow metrics without losing publication completions", async () => {
  const storage = new MemoryDurableStorage();
  storage.sql.exec(
    `CREATE TABLE exact_review_queue_metrics (
       singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
       publication_completed_total INTEGER NOT NULL CHECK (publication_completed_total >= 0)
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO exact_review_queue_metrics (singleton_id, publication_completed_total)
     VALUES (1, 42)`,
  );
  storage.sql.exec(
    `CREATE TABLE exact_review_queue_metric_buckets (
       bucket_start INTEGER PRIMARY KEY,
       publication_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (publication_enqueued >= 0),
       publication_resolved INTEGER NOT NULL DEFAULT 0 CHECK (publication_resolved >= 0),
       publication_published INTEGER NOT NULL DEFAULT 0 CHECK (publication_published >= 0),
       publication_superseded INTEGER NOT NULL DEFAULT 0 CHECK (publication_superseded >= 0),
       publication_retried INTEGER NOT NULL DEFAULT 0 CHECK (publication_retried >= 0),
       publication_dead_lettered INTEGER NOT NULL DEFAULT 0
         CHECK (publication_dead_lettered >= 0)
     ) STRICT`,
  );
  storage.sql.exec(
    `INSERT INTO exact_review_queue_metric_buckets
       (bucket_start, publication_enqueued, publication_resolved, publication_published)
     VALUES (?, 2, 1, 1)`,
    Date.now(),
  );
  const queue = new ExactReviewQueue({ storage }, {});

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(
    {
      review_enqueued: stats.lanes.review.enqueued_total,
      review_completed: stats.lanes.review.completed_total,
      review_superseded: stats.lanes.review.superseded_total,
      publication_enqueued: stats.lanes.publication.enqueued_total,
      publication_completed: stats.lanes.publication.completed_total,
    },
    {
      review_enqueued: 0,
      review_completed: 0,
      review_superseded: 0,
      publication_enqueued: 0,
      publication_completed: 42,
    },
  );
  assert.equal(stats.lanes.publication.flow.last_15_minutes.published_rate_per_hour, 4);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.refreshed, 0);
  assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.reconciliation.refreshed, {
    flow_count: 0,
    cause_count: 0,
    complete: true,
  });
  assert.equal(stats.lanes.publication.flow.last_15_minutes.causes.attribution_complete, false);
  assert.deepEqual(stats.lanes.review.flow.last_15_minutes, {
    window_minutes: 15,
    arrival: 0,
    successful: 0,
    retried: 0,
    shed: 0,
    shed_reasons: { backpressure: 0, scheduled_rate: 0 },
    arrival_rate_per_hour: 0,
    successful_rate_per_hour: 0,
    retried_rate_per_hour: 0,
    shed_rate_per_hour: 0,
    retry_amplification: null,
  });
});

test("exact-review publication cause telemetry keeps public cardinality bounded", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.throws(
    () =>
      storage.sql.exec(
        `INSERT INTO exact_review_publication_cause_buckets_v1
           (bucket_start, transition, stage, completion_kind, reason_code,
            revision_relation, pool_class, recovery_cause, backoff_reason,
            attempt_bucket, count)
         VALUES (?, 'retried', 'publication_apply', 'retryable_failure',
                 'private/repository#123', 'same_revision', 'repository_actions',
                 'transient_retry', 'publication_retry', '1', 1)`,
        Date.now(),
      ),
    /CHECK constraint failed/,
  );
  const stages = [
    "publication_prepare",
    "publication_apply",
    "publication_router",
    "state_commit",
    "workflow",
  ];
  const reasons = [
    "github_rate_limit",
    "github_transient",
    "state_contention",
    "review_lease_active",
    "workflow_cancelled",
    "artifact_unavailable",
    "artifact_expired",
    "close_coverage_retry",
    "close_coverage_deferred",
    "invalid_artifact",
    "missing_record_tuple",
    "tuple_protocol_invalid",
    "policy_invariant",
    "unknown_failure",
  ];
  const attempts = ["0", "1", "2", "3_5", "6_13", "14_plus", "unknown"];
  const bucketStart = Math.floor(Date.now() / 300_000) * 300_000;
  for (let index = 0; index < 257; index += 1) {
    const stage = stages[index % stages.length];
    const reason = reasons[Math.floor(index / stages.length) % reasons.length];
    const attempt =
      attempts[Math.floor(index / (stages.length * reasons.length)) % attempts.length];
    storage.sql.exec(
      `INSERT INTO exact_review_publication_cause_buckets_v1
         (bucket_start, transition, stage, completion_kind, reason_code,
          revision_relation, pool_class, recovery_cause, backoff_reason,
          attempt_bucket, count)
       VALUES (?, 'retried', ?, 'retryable_failure', ?, 'same_revision',
               'repository_actions', 'transient_retry', 'publication_retry', ?, 1)`,
      bucketStart,
      stage,
      reason,
      attempt,
    );
  }

  const stats = await (await queue.fetch(new Request("https://queue/stats"))).json();
  const causes = stats.lanes.publication.flow.last_15_minutes.causes;
  assert.equal(causes.rows.length, 256);
  assert.equal(causes.rows_truncated, true);
  assert.equal(causes.attribution_complete, false);
  assert.deepEqual(causes.privacy, { raw_identifiers: false, closed_dimensions: true });
  assert.equal(JSON.stringify(causes).includes("openclaw/"), false);
});

test("exact-review queue migrates delivery receipts and retains them for seven days", async () => {
  const storage = new MemoryDurableStorage();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  await storage.put("exact-review-queue", {
    deliveries: {
      "delivery-expired": Date.now() - sevenDaysMs - 60_000,
      "delivery-within-window": Date.now() - sevenDaysMs + 60_000,
    },
    items: {},
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-fresh", 619, "opened"))).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
  };
  assert.deepEqual(Object.keys(state.deliveries).sort(), [
    "delivery-fresh",
    "delivery-within-window",
  ]);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 2);
  assert.equal(stats.storage_schema_version, 1);
  assert.equal(stats.legacy_rollback_available, true);
  const shadowDeliveries = (
    storage.rawGet("exact-review-queue") as { deliveries: Record<string, number> }
  ).deliveries;
  const shadowGenerationIds = Object.keys(shadowDeliveries).filter((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.equal(shadowGenerationIds.length, 1);
  assert.equal(shadowDeliveries[shadowGenerationIds[0]], Number.MAX_SAFE_INTEGER);
  assert.deepEqual(
    Object.keys(shadowDeliveries)
      .filter((deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"))
      .sort(),
    ["delivery-fresh", "delivery-within-window"],
  );
  assert.ok(shadowDeliveries["delivery-within-window"] > Date.now() - 5 * 24 * 60 * 60 * 1000);

  const restarted = new ExactReviewQueue({ storage }, {});
  const duplicate = await restarted.fetch(
    buildExactReviewQueueRequest("delivery-within-window", 619, "edited"),
  );
  assert.deepEqual(await duplicate.json(), {
    ok: true,
    deduped: true,
    item_key: "openclaw/gogcli#619",
  });
});

test("exact-review receipt acceptance and queue mutation commit atomically", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  storage.failNextSql(/INSERT INTO exact_review_queue_items/);

  await assert.rejects(
    queue.fetch(buildExactReviewQueueRequest("delivery-atomic", 625, "opened")),
    /injected SQL failure/,
  );
  let state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(state.deliveries, {});
  assert.deepEqual(state.items, {});
  let stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 0);

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-atomic", 625, "opened"))).status,
    202,
  );
  state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.deliveries), ["delivery-atomic"]);
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#625"]);
  stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
});

test("exact-review re-upgrade imports rollback-era queue mutations and receipts", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-before-rollback", 626, "opened")))
      .status,
    202,
  );

  const shadow = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, Record<string, unknown>>;
    },
  );
  const oldGenerationId = Object.keys(shadow.deliveries).find((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.ok(oldGenerationId);
  const rollbackItem = structuredClone(shadow.items["openclaw/gogcli#626"]);
  rollbackItem.key = "openclaw/gogcli#627";
  rollbackItem.decision = {
    ...(rollbackItem.decision as Record<string, unknown>),
    itemNumber: 627,
  };
  delete shadow.items["openclaw/gogcli#626"];
  shadow.items["openclaw/gogcli#627"] = rollbackItem;
  shadow.deliveries["delivery-during-rollback"] = Date.now();
  storage.rawPut("exact-review-queue", shadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 2);
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#627"]);
  assert.deepEqual(Object.keys(state.deliveries).sort(), [
    "delivery-before-rollback",
    "delivery-during-rollback",
  ]);
  const upgradedShadow = storage.rawGet("exact-review-queue") as {
    deliveries: Record<string, number>;
  };
  const upgradedGenerationIds = Object.keys(upgradedShadow.deliveries).filter((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.equal(upgradedGenerationIds.length, 1);
  assert.match(upgradedGenerationIds[0], /^__clawsweeper_sql_generation:\d+$/);
  assert.notEqual(upgradedGenerationIds[0], oldGenerationId);
  assert.deepEqual(
    Object.keys(upgradedShadow.deliveries)
      .filter((deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"))
      .sort(),
    ["delivery-before-rollback", "delivery-during-rollback"],
  );
});

test("exact-review re-upgrade distinguishes a refreshed rollback receipt", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-refreshed", 634, "opened"))).status,
    202,
  );
  const oldReceivedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const refreshedAt = Date.now();
  storage.setExactReviewReceiptTime("delivery-refreshed", oldReceivedAt);
  const rollback = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, { revision: number; updatedAt: number }>;
    },
  );
  rollback.deliveries["delivery-refreshed"] = refreshedAt;
  rollback.items["openclaw/gogcli#634"].revision += 1;
  rollback.items["openclaw/gogcli#634"].updatedAt = refreshedAt;
  storage.rawPut("exact-review-queue", rollback);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, { revision: number }>;
  };
  assert.equal(state.deliveries["delivery-refreshed"], refreshedAt);
  assert.equal(state.items["openclaw/gogcli#634"].revision, 2);
  assert.deepEqual(
    await (
      await upgraded.fetch(buildExactReviewQueueRequest("delivery-refreshed", 634, "edited"))
    ).json(),
    { ok: true, deduped: true, item_key: "openclaw/gogcli#634" },
  );
});

test("exact-review receipt pruning removes its translated shadow atomically", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-pruned", 635, "opened"))).status,
    202,
  );
  const expiredAt = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1;
  storage.setExactReviewReceiptTime("delivery-pruned", expiredAt);
  const staleShadow = structuredClone(
    storage.rawGet("exact-review-queue") as { deliveries: Record<string, number> },
  );
  staleShadow.deliveries["delivery-pruned"] = expiredAt + 2 * 24 * 60 * 60 * 1000;
  storage.rawPut("exact-review-queue", staleShadow);

  let stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 0);
  const refreshedShadow = storage.rawGet("exact-review-queue") as {
    deliveries: Record<string, number>;
  };
  assert.deepEqual(
    Object.keys(refreshedShadow.deliveries).filter(
      (deliveryId) => !deliveryId.startsWith("__clawsweeper_sql_generation:"),
    ),
    [],
  );

  const restarted = new ExactReviewQueue({ storage }, {});
  stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.delivery_receipts, 0);
});

test("exact-review re-upgrade fails closed for a divergent stale rollback shadow", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-stale-1", 628, "opened"))).status,
    202,
  );
  const staleShadow = structuredClone(storage.rawGet("exact-review-queue"));
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-stale-2", 629, "opened"))).status,
    202,
  );
  storage.rawPut("exact-review-queue", staleShadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  await assert.rejects(
    upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats")),
    /ambiguous exact-review legacy rollback state/,
  );
  const sqlState = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(sqlState.items).sort(), [
    "openclaw/gogcli#628",
    "openclaw/gogcli#629",
  ]);
  assert.deepEqual(storage.rawGet("exact-review-queue"), staleShadow);
});

test("exact-review discards a stale rollback shadow when its refresh fails", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(storage.rawHas("exact-review-queue"), true);
  storage.failNextPut("exact-review-queue");
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-mirror-failure", 630, "opened")))
        .status,
      202,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(storage.rawHas("exact-review-queue"), false);
  assert.deepEqual(warnings, [["exact_review_legacy_rollback_shadow_unavailable"]]);

  const restarted = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(storage.rawHas("exact-review-queue"), true);
});

test("exact-review rolls SQL back when an obsolete shadow cannot be removed", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const originalShadow = structuredClone(storage.rawGet("exact-review-queue"));
  const secret = "legacy-shadow-secret";
  storage.failNextPut("exact-review-queue");
  storage.failNextDelete(
    "exact-review-queue",
    new Error(
      `legacy shadow delete failed at https://operator:${secret}@storage.example/shadow?token=${secret}`,
    ),
  );
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await assert.rejects(
      queue.fetch(buildExactReviewQueueRequest("delivery-atomic-shadow", 633, "opened")),
      /exact-review legacy rollback shadow cleanup failed/,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [["exact_review_legacy_rollback_shadow_cleanup_failed"]]);
  assert.doesNotMatch(warnings.flat().join("\n"), new RegExp(secret));
  assert.deepEqual(storage.rawGet("exact-review-queue"), originalShadow);
  let state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(state.deliveries, {});
  assert.deepEqual(state.items, {});

  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-atomic-shadow", 633, "opened")))
      .status,
    202,
  );
  state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.deliveries), ["delivery-atomic-shadow"]);
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#633"]);
});

test("exact-review SQL rows outgrow the bounded rollback shadow without blocking intake", async () => {
  const storage = new MemoryDurableStorage();
  const now = Date.now();
  const items = Object.fromEntries(
    Array.from({ length: 220 }, (_, index) => {
      const itemNumber = 10_000 + index;
      const key = `openclaw/openclaw#${itemNumber}`;
      return [
        key,
        {
          key,
          decision: {
            targetRepo: "openclaw/openclaw",
            targetBranch: "main",
            itemNumber,
            itemKind: "issue",
            sourceEvent: "issues",
            sourceAction: "opened",
            supersedesInProgress: false,
            additionalPrompt: "x".repeat(5_000),
          },
          state: "pending",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: now,
          attempts: 0,
        },
      ];
    }),
  );
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let queue: ExactReviewQueue;
  try {
    queue = new ExactReviewQueue({ storage }, {});
    const response = await queue.fetch(
      buildExactReviewQueueRequest("delivery-after-large-migration", 20_000, "opened"),
    );
    assert.equal(response.status, 202);
  } finally {
    console.warn = originalWarn;
  }

  const stats = await (
    await queue!.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 221);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(stats.legacy_rollback_available, false);
  assert.deepEqual(warnings, [["exact_review_legacy_rollback_shadow_unavailable"]]);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("exact-review migration removes its rollback shadow after one day", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-shadow", 626, "opened"))).status,
    202,
  );
  assert.equal(storage.rawHas("exact-review-queue"), true);

  storage.setExactReviewMigrationTime(Date.now() - 24 * 60 * 60 * 1000 - 1);
  const restarted = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 1);
  assert.equal(stats.legacy_rollback_available, false);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("exact-review imports an active rollback before expiring an old bridge", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("delivery-old-bridge", 631, "opened"))).status,
    202,
  );
  const shadow = structuredClone(
    storage.rawGet("exact-review-queue") as {
      deliveries: Record<string, number>;
      items: Record<string, Record<string, unknown>>;
    },
  );
  const oldMigrationTime = Date.now() - 24 * 60 * 60 * 1000 - 1;
  storage.setExactReviewMigrationTime(oldMigrationTime);
  const generationId = Object.keys(shadow.deliveries).find((deliveryId) =>
    deliveryId.startsWith("__clawsweeper_sql_generation:"),
  );
  assert.ok(generationId);
  assert.equal(shadow.deliveries[generationId], Number.MAX_SAFE_INTEGER);
  for (const [deliveryId, receivedAt] of Object.entries(shadow.deliveries)) {
    if (receivedAt <= Date.now() - 5 * 24 * 60 * 60 * 1000) {
      delete shadow.deliveries[deliveryId];
    }
  }
  assert.equal(shadow.deliveries[generationId], Number.MAX_SAFE_INTEGER);
  shadow.deliveries["delivery-old-bridge-rollback"] = Date.now();
  const rollbackItem = structuredClone(shadow.items["openclaw/gogcli#631"]);
  rollbackItem.key = "openclaw/gogcli#632";
  rollbackItem.decision = {
    ...(rollbackItem.decision as Record<string, unknown>),
    itemNumber: 632,
  };
  delete shadow.items["openclaw/gogcli#631"];
  shadow.items["openclaw/gogcli#632"] = rollbackItem;
  storage.rawPut("exact-review-queue", shadow);

  const upgraded = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await upgraded.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.delivery_receipts, 2);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(state.items), ["openclaw/gogcli#632"]);
  assert.equal(storage.rawHas("exact-review-queue"), false);
});

test("a newer exact-review enqueue revokes a claimed immutable decision", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(620);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#620": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const claim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-620",
        item_key: "openclaw/openclaw#620",
        lease_revision: 1,
        run_id: "6200",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), {
    ok: true,
    claimed: true,
    protocol_version: 2,
    item_key: "openclaw/openclaw#620",
    lease_revision: 1,
    claim_generation: 1,
    repeat_revision: false,
    decision: item.leaseDecision,
  });

  const newer = buildExactReviewQueueRequest(
    "newer-620",
    620,
    "edited",
    "pull_request",
    "openclaw/openclaw",
  );
  assert.equal((await queue.fetch(newer)).status, 202);

  const claimedState = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        revision: number;
        decision: { sourceAction: string; itemKind: string };
        state: string;
        leaseDecision?: { sourceAction: string; itemKind: string };
      }
    >;
  };
  assert.equal(claimedState.items["openclaw/openclaw#620"].state, "pending");
  assert.equal(claimedState.items["openclaw/openclaw#620"].revision, 2);
  assert.deepEqual(claimedState.items["openclaw/openclaw#620"].decision, {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: 620,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "edited",
    supersedesInProgress: true,
  });
  assert.equal(claimedState.items["openclaw/openclaw#620"].leaseDecision, undefined);

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-620",
        item_key: "openclaw/openclaw#620",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6200",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(complete.status, 409);
  assert.deepEqual(await complete.json(), {
    error: "lease_superseded",
    superseded_by_revision: 2,
  });

  const mismatchedGeneration = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-620",
        item_key: "openclaw/openclaw#620",
        lease_revision: 1,
        claim_generation: 2,
        run_id: "6200",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(mismatchedGeneration.status, 409);
  assert.deepEqual(await mismatchedGeneration.json(), { error: "lease_not_claimed" });
});

test("status receipt binding rejects an unknown heartbeat item without mutation", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: {} });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        item_key: "openclaw/openclaw#626",
        lease_id: "lease-626",
        lease_revision: 1,
        run_id: "6260",
        run_attempt: 1,
        claim_generation: 1,
        source_head_sha: "a".repeat(40),
        review_acknowledgement_comment_id: 62_600,
        phase: "status",
      }),
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "lease_not_active" });
  const state = (await storage.get("exact-review-queue")) as { items: Record<string, unknown> };
  assert.deepEqual(state.items, {});
});

test("status receipt binding validates the full active lease tuple first", async (t) => {
  for (const [field, value] of Object.entries({
    lease_id: "stale-lease",
    lease_revision: 2,
    run_id: "9999",
    run_attempt: 2,
    claim_generation: 2,
    source_head_sha: "b".repeat(40),
  })) {
    await t.test(field, async () => {
      const storage = new MemoryDurableStorage();
      const item = leasedExactReviewQueueItem(627, "6270");
      for (const decision of [item.decision, item.leaseDecision]) {
        Object.assign(decision, {
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceHeadSha: "a".repeat(40),
        });
      }
      await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
      const queue = new ExactReviewQueue({ storage }, {});
      const tuple = {
        item_key: item.key,
        lease_id: item.leaseId,
        lease_revision: 1,
        run_id: "6270",
        run_attempt: 1,
        claim_generation: 1,
        source_head_sha: "a".repeat(40),
        phase: "status",
      };
      const heartbeat = (payload: Record<string, unknown>) =>
        queue.fetch(
          new Request("https://clawsweeper-exact-review-queue/heartbeat", {
            method: "POST",
            body: JSON.stringify(payload),
          }),
        );
      const stale = await heartbeat({
        ...tuple,
        [field]: value,
        review_acknowledgement_comment_id: 62_700,
      });
      assert.equal(stale.status, 409);
      assert.deepEqual(await stale.json(), { error: "lease_not_active" });
      const accepted = await heartbeat({
        ...tuple,
        review_acknowledgement_comment_id: 62_701,
      });
      assert.equal(accepted.status, 200);
      const state = (await storage.get("exact-review-queue")) as {
        items: Record<string, { leaseDecision: { reviewAcknowledgementCommentId?: number } }>;
      };
      assert.equal(state.items[item.key].leaseDecision.reviewAcknowledgementCommentId, 62_701);
    });
  }
});

test("a newer revision accumulated during status revokes the old lease when status exits", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(622);
  for (const decision of [item.decision, item.leaseDecision]) {
    Object.assign(decision, {
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceHeadSha: "a".repeat(40),
      sourceHeadVerified: true,
      sourceAuthoritySeq: 1,
      sourceUpdatedAt: "2026-09-03T13:00:00.000Z",
    });
  }
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#622": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-622",
            item_key: "openclaw/openclaw#622",
            lease_revision: 1,
            run_id: "6220",
            run_attempt: 1,
          }),
        }),
      )
    ).status,
    200,
  );
  const heartbeat = (phase: "status" | "finalizing") =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-622",
          item_key: "openclaw/openclaw#622",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "6220",
          run_attempt: 1,
          source_head_sha: "a".repeat(40),
          ...(phase === "status" ? { review_acknowledgement_comment_id: 62_200 } : {}),
          phase,
        }),
      }),
    );
  assert.equal((await heartbeat("status")).status, 200);
  const statusState = (await storage.get("exact-review-queue")) as {
    items: Record<string, { leaseDecision?: { reviewAcknowledgementCommentId?: number } }>;
  };
  assert.equal(
    statusState.items["openclaw/openclaw#622"].leaseDecision?.reviewAcknowledgementCommentId,
    62_200,
  );
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "newer-status-622",
          622,
          "synchronize",
          "pull_request",
          "openclaw/openclaw",
          {
            sourceHeadSha: "b".repeat(40),
            sourceHeadVerified: true,
            sourceAuthoritySeq: 2,
            sourceUpdatedAt: "2026-09-03T13:01:00.000Z",
          },
        ),
      )
    ).status,
    202,
  );
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "metadata-after-newer-status-622",
          622,
          "converted_to_draft",
          "pull_request",
          "openclaw/openclaw",
          {
            sourceHeadSha: "b".repeat(40),
            sourceHeadVerified: true,
            sourceAuthoritySeq: 3,
            sourceUpdatedAt: "2026-09-03T13:01:01.000Z",
            sourceIsDraft: true,
          },
        ),
      )
    ).status,
    202,
  );

  const release = await heartbeat("finalizing");
  assert.equal(release.status, 409);
  assert.deepEqual(await release.json(), {
    error: "lease_superseded",
    superseded_by_revision: 3,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        revision: number;
        leaseId?: string;
        leasePhase?: string;
        decision: { sourceHeadSha?: string };
      }
    >;
  };
  assert.equal(state.items["openclaw/openclaw#622"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#622"].revision, 3);
  assert.equal(state.items["openclaw/openclaw#622"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#622"].leasePhase, undefined);
  assert.equal(state.items["openclaw/openclaw#622"].decision.sourceHeadSha, "b".repeat(40));
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-622",
        item_key: "openclaw/openclaw#622",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6220",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(completed.status, 409);
  assert.deepEqual(await completed.json(), {
    error: "lease_superseded",
    superseded_by_revision: 3,
  });
});

test("a non-superseding revision accumulated during status preserves the active lease", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(624);
  for (const decision of [item.decision, item.leaseDecision]) {
    Object.assign(decision, {
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceHeadSha: "a".repeat(40),
      sourceHeadVerified: true,
      sourceAuthoritySeq: 1,
      sourceUpdatedAt: "2026-09-03T15:00:00.000Z",
    });
  }
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#624": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-624",
            item_key: "openclaw/openclaw#624",
            lease_revision: 1,
            run_id: "6240",
            run_attempt: 1,
          }),
        }),
      )
    ).status,
    200,
  );
  const heartbeat = (phase: "status" | "finalizing") =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-624",
          item_key: "openclaw/openclaw#624",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "6240",
          run_attempt: 1,
          source_head_sha: "a".repeat(40),
          phase,
        }),
      }),
    );
  assert.equal((await heartbeat("status")).status, 200);
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "metadata-status-624",
          624,
          "labeled",
          "pull_request",
          "openclaw/openclaw",
          {
            sourceHeadSha: "a".repeat(40),
            sourceHeadVerified: true,
            sourceAuthoritySeq: 2,
            sourceUpdatedAt: "2026-09-03T15:01:00.000Z",
          },
        ),
      )
    ).status,
    202,
  );
  assert.equal((await heartbeat("finalizing")).status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; revision: number; leaseId?: string; leasePhase?: string }
    >;
  };
  assert.equal(state.items["openclaw/openclaw#624"].state, "leased");
  assert.equal(state.items["openclaw/openclaw#624"].revision, 2);
  assert.equal(state.items["openclaw/openclaw#624"].leaseId, "lease-624");
  assert.equal(state.items["openclaw/openclaw#624"].leasePhase, "finalizing");
});

test("a markerless pre-deploy status lease still detects its superseding revision", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(625, "6250");
  Object.assign(item.leaseDecision, {
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "opened",
    sourceHeadSha: "a".repeat(40),
    sourceHeadVerified: true,
    sourceAuthoritySeq: 1,
    sourceUpdatedAt: "2026-09-03T16:00:00.000Z",
  });
  Object.assign(item.decision, {
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "synchronize",
    supersedesInProgress: true,
    sourceHeadSha: "b".repeat(40),
    sourceHeadVerified: true,
    sourceAuthoritySeq: 2,
    sourceUpdatedAt: "2026-09-03T16:01:00.000Z",
  });
  item.revision = 2;
  item.leaseRevision = 1;
  item.leasePhase = "status";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#625": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const release = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6250",
        run_attempt: 1,
        source_head_sha: "a".repeat(40),
        phase: "finalizing",
      }),
    }),
  );
  assert.equal(release.status, 409);
  assert.deepEqual(await release.json(), {
    error: "lease_superseded",
    superseded_by_revision: 2,
  });
});

test("a newer revision supersedes a general finalizing lease", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(623);
  for (const decision of [item.decision, item.leaseDecision]) {
    Object.assign(decision, {
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceHeadSha: "a".repeat(40),
      sourceHeadVerified: true,
      sourceAuthoritySeq: 1,
      sourceUpdatedAt: "2026-09-03T14:00:00.000Z",
    });
  }
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#623": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-623",
            item_key: "openclaw/openclaw#623",
            lease_revision: 1,
            run_id: "6230",
            run_attempt: 1,
          }),
        }),
      )
    ).status,
    200,
  );
  const fence = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-623",
        item_key: "openclaw/openclaw#623",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6230",
        run_attempt: 1,
        source_head_sha: "a".repeat(40),
        phase: "finalizing",
      }),
    }),
  );
  assert.equal(fence.status, 200);

  const newer = buildExactReviewQueueRequest(
    "newer-finalizing-623",
    623,
    "synchronize",
    "pull_request",
    "openclaw/openclaw",
    {
      sourceHeadSha: "b".repeat(40),
      sourceHeadVerified: true,
      sourceAuthoritySeq: 2,
      sourceUpdatedAt: "2026-09-03T14:01:00.000Z",
    },
  );
  assert.equal((await queue.fetch(newer)).status, 202);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        revision: number;
        leasePhase?: string;
        leaseId?: string;
        leaseDecision?: { sourceHeadSha?: string };
        decision: { sourceHeadSha?: string };
      }
    >;
  };
  assert.equal(state.items["openclaw/openclaw#623"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#623"].revision, 2);
  assert.equal(state.items["openclaw/openclaw#623"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#623"].leasePhase, undefined);
  assert.equal(state.items["openclaw/openclaw#623"].leaseDecision, undefined);
  assert.equal(state.items["openclaw/openclaw#623"].decision.sourceHeadSha, "b".repeat(40));
});

test("a newer exact-review enqueue revokes a claimed legacy workflow lease", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(624);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#624": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const legacyClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        run_id: "6240",
        run_attempt: 1,
      }),
    }),
  );
  assert.equal(legacyClaim.status, 200);
  assert.deepEqual(await legacyClaim.json(), {
    ok: true,
    claimed: true,
    protocol_version: 1,
    item_key: "openclaw/openclaw#624",
    revision: 1,
    lease_revision: 1,
    claim_generation: 1,
    decision: item.leaseDecision,
  });

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "newer-624",
          624,
          "edited",
          "pull_request",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const strictCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        item_key: "openclaw/openclaw#624",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6240",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(strictCompletion.status, 409);
  assert.deepEqual(await strictCompletion.json(), { error: "lease_not_claimed" });

  const legacyCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-624",
        run_id: "6240",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );
  assert.equal(legacyCompletion.status, 409);
  assert.deepEqual(await legacyCompletion.json(), { error: "lease_not_claimed" });
  const requeued = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(requeued.items["openclaw/openclaw#624"].state, "pending");
  assert.equal(requeued.items["openclaw/openclaw#624"].claimProtocolVersion, undefined);
  assert.equal(
    (requeued.items["openclaw/openclaw#624"].decision as { sourceAction: string }).sourceAction,
    "edited",
  );
});

test("exact-review claims advance generations only for newer run attempts", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#621": unclaimedExactReviewQueueItem(621) },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const claim = (runAttempt?: number) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-621",
          item_key: "openclaw/openclaw#621",
          lease_revision: 1,
          run_id: "6210",
          ...(runAttempt === undefined ? {} : { run_attempt: runAttempt }),
        }),
      }),
    );

  const first = await claim(1);
  assert.equal(first.status, 200);
  const firstPayload = await first.json();
  assert.equal(firstPayload.claim_generation, 1);
  assert.equal(firstPayload.lease_revision, 1);

  const beforeReplay = (await storage.get("exact-review-queue")) as {
    items: Record<string, { leaseExpiresAt: number }>;
  };
  beforeReplay.items["openclaw/openclaw#621"].leaseExpiresAt = Date.now() + 1_000;
  await storage.put("exact-review-queue", beforeReplay);

  const replay = await claim(1);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), firstPayload);
  const afterReplay = (await storage.get("exact-review-queue")) as typeof beforeReplay;
  assert.ok(afterReplay.items["openclaw/openclaw#621"].leaseExpiresAt - Date.now() > 120 * 60_000);

  const nextAttempt = await claim(2);
  assert.equal(nextAttempt.status, 200);
  assert.equal((await nextAttempt.json()).claim_generation, 2);
  const latestState = structuredClone(await storage.get("exact-review-queue"));

  const staleAttempt = await claim(1);
  assert.equal(staleAttempt.status, 409);
  assert.deepEqual(await staleAttempt.json(), { error: "stale_run_attempt" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);

  const missingAttempt = await claim();
  assert.equal(missingAttempt.status, 409);
  assert.deepEqual(await missingAttempt.json(), { error: "missing_run_attempt" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);

  const staleCompletion = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-621",
        item_key: "openclaw/openclaw#621",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "6210",
        run_attempt: 1,
        outcome: "failure",
      }),
    }),
  );
  assert.equal(staleCompletion.status, 409);
  assert.deepEqual(await staleCompletion.json(), { error: "lease_not_claimed" });
  assert.deepEqual(await storage.get("exact-review-queue"), latestState);
});

test("exact-review claim upgrades a legacy same-attempt generation", async () => {
  const storage = new MemoryDurableStorage();
  const item = unclaimedExactReviewQueueItem(622);
  item.state = "leased";
  item.claimedRunId = "6220";
  item.claimedRunAttempt = 1;
  item.leaseDecision = structuredClone(item.decision);
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#622": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-622",
        item_key: "openclaw/openclaw#622",
        lease_revision: 1,
        run_id: "6220",
        run_attempt: 1,
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).claim_generation, 1);
  const stored = (await storage.get("exact-review-queue")) as {
    items: Record<string, { claimGeneration?: number }>;
  };
  assert.equal(stored.items["openclaw/openclaw#622"].claimGeneration, 1);
});

test("exact-review claim and completion reject forged or incomplete lease tuples", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#622": unclaimedExactReviewQueueItem(622),
      "openclaw/openclaw#623": unclaimedExactReviewQueueItem(623),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const claimBase = {
    lease_id: "lease-622",
    item_key: "openclaw/openclaw#622",
    lease_revision: 1,
    run_id: "6220",
    run_attempt: 1,
  };
  const initialState = structuredClone(await storage.get("exact-review-queue"));
  const invalidClaims = [
    { body: { ...claimBase, item_key: undefined }, status: 400 },
    { body: { ...claimBase, lease_revision: undefined }, status: 400 },
    { body: { ...claimBase, item_key: "openclaw/openclaw#623" }, status: 409 },
    { body: { ...claimBase, lease_revision: 2 }, status: 409 },
    {
      body: {
        ...claimBase,
        lease_id: "lease-623",
        item_key: "openclaw/openclaw#622",
      },
      status: 409,
    },
  ];
  for (const candidate of invalidClaims) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify(candidate.body),
      }),
    );
    assert.equal(response.status, candidate.status);
    assert.deepEqual(await storage.get("exact-review-queue"), initialState);
  }

  const validClaim = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/claim", {
      method: "POST",
      body: JSON.stringify(claimBase),
    }),
  );
  assert.equal(validClaim.status, 200);
  assert.equal((await validClaim.json()).claim_generation, 1);

  const completeBase = {
    ...claimBase,
    claim_generation: 1,
    outcome: "failure",
  };
  const claimedState = structuredClone(await storage.get("exact-review-queue"));
  const invalidCompletions = [
    { body: { ...completeBase, item_key: undefined }, status: 400 },
    { body: { ...completeBase, item_key: "openclaw/openclaw#623" }, status: 409 },
    { body: { ...completeBase, lease_revision: undefined }, status: 400 },
    { body: { ...completeBase, lease_revision: 2 }, status: 409 },
    { body: { ...completeBase, claim_generation: undefined }, status: 400 },
    { body: { ...completeBase, claim_generation: 2 }, status: 409 },
  ];
  for (const candidate of invalidCompletions) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify(candidate.body),
      }),
    );
    assert.equal(response.status, candidate.status);
    assert.deepEqual(await storage.get("exact-review-queue"), claimedState);
  }
});

test("exact-review queue admits at most one active item per target repository", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return jsonResponse({ state: "active" });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname)) {
      return jsonResponse({ id: 999 });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname)) {
      return jsonResponse({ state: "open" });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "2",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "1",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-target-a-1", 601, "opened"));
    await queue.fetch(buildExactReviewQueueRequest("delivery-target-a-2", 602, "opened"));
    await queue.fetch(
      buildExactReviewQueueRequest(
        "delivery-target-b-1",
        603,
        "opened",
        "issue",
        "openclaw/openclaw",
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "delivery-target-c-1",
        604,
        "opened",
        "issue",
        "openclaw/clawsweeper",
      ),
    );

    await queue.alarm();
    assert.equal(dispatched.length, 2);
    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm > Date.now() + 60_000);
    const targets = dispatched.map((payload) =>
      String((payload.client_payload as Record<string, unknown>).target_repo),
    );
    assert.equal(new Set(targets).size, 2);
    assert.equal(targets.filter((target) => target === "openclaw/gogcli").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review review retries park at the attempt ceiling and recover after cooldown", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const liveHeadSha = `956eaead7f${"0".repeat(30)}`;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      return jsonResponse({ state: "active" });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (/^\/repos\/openclaw\/openclaw\/pulls\/\d+$/.test(url.pathname)) {
      return jsonResponse({ state: "open", head: { sha: liveHeadSha } });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "dispatch-token" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const itemKey = "openclaw/openclaw#113341";
  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_RETRY_POLICY_EPOCH: "2",
      },
    );
    assert.equal(
      (
        await queue.fetch(
          buildExactReviewQueueRequest(
            "ceiling-1",
            113_341,
            "synchronize",
            "pull_request",
            "openclaw/openclaw",
            {
              sourceHeadSha: `956eaead7f${"0".repeat(30)}`,
              sourceHeadVerified: true,
              sourceAuthoritySeq: 1,
              sourceUpdatedAt: new Date().toISOString(),
            },
          ),
        )
      ).status,
      202,
    );

    const failOnce = async (cycle: number) => {
      const ready = (await storage.get("exact-review-queue")) as {
        items: Record<string, { state: string; nextAttemptAt: number }>;
      };
      if (ready.items[itemKey]?.state === "pending") {
        ready.items[itemKey].nextAttemptAt = Date.now() - 1;
        await storage.put("exact-review-queue", ready);
      }
      const before = dispatched.length;
      await queue.alarm();
      if (dispatched.length === before) return false;
      const payload = dispatched.at(-1)?.client_payload as {
        queue_lease_id: string;
        queue_claim: { item_key: string; lease_revision: number };
      };
      const claim = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: payload.queue_lease_id,
            item_key: payload.queue_claim.item_key,
            lease_revision: payload.queue_claim.lease_revision,
            run_id: `90000${cycle}`,
            run_attempt: 1,
          }),
        }),
      );
      assert.equal(claim.status, 200);
      const claimed = (await claim.json()) as { claim_generation: number };
      const completed = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/complete", {
          method: "POST",
          body: JSON.stringify({
            lease_id: payload.queue_lease_id,
            item_key: payload.queue_claim.item_key,
            lease_revision: payload.queue_claim.lease_revision,
            claim_generation: claimed.claim_generation,
            run_id: `90000${cycle}`,
            run_attempt: 1,
            outcome: "failure",
          }),
        }),
      );
      assert.equal(completed.status, 200);
      return true;
    };

    const readItem = async () => {
      const state = (await storage.get("exact-review-queue")) as {
        items: Record<
          string,
          {
            state: string;
            attempts: number;
            nextAttemptAt: number;
            parkedReason?: string;
            parkedRecoveryAttempts?: number;
            reviewRetryPolicyEpoch?: string;
          }
        >;
      };
      return state.items[itemKey];
    };

    for (let cycle = 1; cycle <= 7; cycle += 1) {
      assert.equal(await failOnce(cycle), true);
      const item = await readItem();
      assert.equal(item.state, "pending");
      assert.equal(item.attempts, cycle);
      assert.equal(item.parkedReason, undefined);
      assert.ok(item.nextAttemptAt > Date.now());
    }

    assert.equal(await failOnce(8), true);
    const parked = await readItem();
    assert.equal(parked.state, "parked");
    assert.equal(parked.attempts, 8);
    assert.equal(parked.parkedReason, "review_retry_exhausted");
    assert.equal(dispatched.length, 8);

    assert.equal(await failOnce(9), false);
    assert.equal(dispatched.length, 8);
    assert.equal((await readItem()).state, "parked");

    const stats = (await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json()) as { lanes: { review: { parked: number; pending: number } } };
    assert.equal(stats.lanes.review.parked, 1);
    assert.equal(stats.lanes.review.pending, 0);

    const status = (await (
      await queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fopenclaw&item_number=113341",
        ),
      )
    ).json()) as { items: Array<{ state: string; parked_reason: string | null }> };
    assert.deepEqual(
      status.items.map((entry) => [entry.state, entry.parked_reason]),
      [["parked", "review_retry_exhausted"]],
    );

    const due = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        { parkedRecoveryAt?: number; updatedAt: number; reviewRetryPolicyEpoch?: string }
      >;
    };
    due.items[itemKey].parkedRecoveryAt = due.items[itemKey].updatedAt;
    due.items[itemKey].reviewRetryPolicyEpoch = "1";
    await storage.put("exact-review-queue", due);
    await queue.alarm();
    assert.equal(dispatched.length, 9);
    const recovered = await readItem();
    assert.equal(recovered.state, "dispatching");
    assert.equal(recovered.attempts, 0);
    assert.equal(recovered.parkedReason, undefined);
    assert.equal(recovered.parkedRecoveryAttempts, 0);
    assert.equal(recovered.reviewRetryPolicyEpoch, "2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review parking spreads a same-tick cohort across persisted recovery timestamps", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const items = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const item = leasedExactReviewQueueItem(120_000 + index, `12000${index}`);
        item.attempts = 7;
        item.reviewFailureAttempts = 7;
        return [item.key, item];
      }),
    );
    await storage.put("exact-review-queue", { deliveries: {}, items });
    const queue = new ExactReviewQueue({ storage }, {}, seededRandom(0x5eed));

    for (const item of Object.values(items)) {
      const response = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/complete", {
          method: "POST",
          body: JSON.stringify({
            lease_id: item.leaseId,
            item_key: item.key,
            lease_revision: item.leaseRevision,
            claim_generation: item.claimGeneration,
            run_id: item.claimedRunId,
            run_attempt: item.claimedRunAttempt,
            outcome: "failure",
          }),
        }),
      );
      assert.equal(response.status, 200);
    }

    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, { state: string; parkedRecoveryAt?: number }>;
    };
    const recoveryTimes = Object.values(state.items).map((item) => {
      assert.equal(item.state, "parked");
      assert.ok(Number(item.parkedRecoveryAt) >= now + 3.75 * 60_000);
      assert.ok(Number(item.parkedRecoveryAt) <= now + 7.5 * 60_000);
      return Number(item.parkedRecoveryAt);
    });
    assert.ok(new Set(recoveryTimes).size > 1);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review automatic parked recovery remains bounded", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-10T15:00:00.000Z");
  Date.now = () => now;
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  try {
    await queue.fetch(buildExactReviewQueueRequest("bounded-parked-recovery", 113_342, "opened"));
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          parkedReason?: string;
          parkedRecoveryAttempts?: number;
          parkedTerminalCheckedAt?: number;
          updatedAt: number;
        }
      >;
    };
    const item = state.items["openclaw/gogcli#113342"];
    item.state = "parked";
    item.parkedReason = "review_retry_exhausted";
    item.parkedRecoveryAttempts = 3;
    item.updatedAt = now - 24 * 60 * 60_000;
    await storage.put("exact-review-queue", state);
    await storage.deleteAlarm();

    await queue.alarm();

    const retained = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(retained.items["openclaw/gogcli#113342"].state, "parked");
    assert.equal(retained.items["openclaw/gogcli#113342"].parkedRecoveryAttempts, 3);
    const nextAlarm = Number(await storage.getAlarm());
    assert.ok(nextAlarm > now);
    assert.ok(nextAlarm <= now + 5 * 60_000);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review queue removes a terminal target after parked recovery is exhausted", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-10T15:30:00.000Z");
  Date.now = () => now;
  let workflowChecks = 0;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "closed" }), {
    workflow: () =>
      ++workflowChecks <= 2
        ? jsonResponse({ state: "active" })
        : jsonResponse({ message: "temporary failure" }, { status: 500 }),
  });
  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest("terminal-exhausted-parked", 113_343, "opened"),
    );
    await harness.queue.fetch(
      buildExactReviewQueueRequest("second-terminal-exhausted-parked", 113_346, "opened"),
    );
    await harness.queue.fetch(
      buildExactReviewQueueRequest("third-terminal-exhausted-parked", 113_348, "opened"),
    );
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: { parkedTerminalCheckedAt?: number };
      items: Record<
        string,
        {
          state: string;
          parkedReason?: string;
          parkedRecoveryAttempts?: number;
          parkedTerminalCheckedAt?: number;
        }
      >;
    };
    const item = state.items["openclaw/gogcli#113343"];
    item.state = "parked";
    item.parkedReason = "review_retry_exhausted";
    item.parkedRecoveryAttempts = 3;
    item.parkedTerminalCheckedAt = now - 10 * 60_000;
    const second = state.items["openclaw/gogcli#113346"];
    second.state = "parked";
    second.parkedReason = "review_retry_exhausted";
    second.parkedRecoveryAttempts = 3;
    second.parkedTerminalCheckedAt = now - 9 * 60_000;
    const third = state.items["openclaw/gogcli#113348"];
    third.state = "parked";
    third.parkedReason = "review_retry_exhausted";
    third.parkedRecoveryAttempts = 3;
    third.parkedTerminalCheckedAt = now - 8 * 60_000;
    await harness.storage.put("exact-review-queue", state);

    await harness.queue.alarm();

    const reconciled = (await harness.storage.get("exact-review-queue")) as typeof state;
    assert.equal(reconciled.items["openclaw/gogcli#113343"], undefined);
    assert.equal(reconciled.items["openclaw/gogcli#113346"].state, "parked");
    assert.equal(reconciled.dispatcher?.parkedTerminalCheckedAt, now);
    assert.equal(await harness.storage.getAlarm(), now + 5 * 60_000);
    assert.equal(harness.dispatched.length, 0);
    const stats = await (
      await harness.queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.parked, 2);
    assert.equal(stats.lanes.review.completed_total, 1);

    now += 5 * 60_000;
    await harness.storage.deleteAlarm();
    await harness.queue.alarm();
    const secondReconciled = (await harness.storage.get("exact-review-queue")) as typeof state;
    assert.equal(secondReconciled.items["openclaw/gogcli#113346"], undefined);
    assert.equal(secondReconciled.items["openclaw/gogcli#113348"].state, "parked");
    assert.equal(secondReconciled.dispatcher?.parkedTerminalCheckedAt, now);
    assert.equal(await harness.storage.getAlarm(), now + 5 * 60_000);

    const terminalCheckedAt = now;
    now += 5 * 60_000;
    await harness.storage.deleteAlarm();
    await harness.queue.alarm();
    const failedPreflight = (await harness.storage.get("exact-review-queue")) as typeof state;
    assert.equal(failedPreflight.dispatcher?.parkedTerminalCheckedAt, terminalCheckedAt);
    assert.ok(Number(await harness.storage.getAlarm()) > now);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review queue retains open exhausted parked work and schedules another terminal check", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-08-10T16:00:00.000Z");
  Date.now = () => now;
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "open" }));
  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest("open-exhausted-parked", 113_344, "opened"),
    );
    now += 1;
    await harness.queue.fetch(
      buildExactReviewQueueRequest("second-open-exhausted-parked", 113_345, "opened"),
    );
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          attempts: number;
          parkedReason?: string;
          parkedRecoveryAttempts?: number;
          parkedTerminalCheckedAt?: number;
        }
      >;
    };
    const item = state.items["openclaw/gogcli#113344"];
    item.state = "parked";
    item.attempts = 8;
    item.parkedReason = "review_retry_exhausted";
    item.parkedRecoveryAttempts = 3;
    const second = state.items["openclaw/gogcli#113345"];
    second.state = "parked";
    second.attempts = 8;
    second.parkedReason = "review_retry_exhausted";
    second.parkedRecoveryAttempts = 3;
    await harness.storage.put("exact-review-queue", state);

    await harness.queue.alarm();

    const retained = (await harness.storage.get("exact-review-queue")) as typeof state;
    const checked = retained.items["openclaw/gogcli#113344"];
    assert.equal(checked.state, "parked");
    assert.equal(checked.attempts, 8);
    assert.equal(checked.parkedRecoveryAttempts, 3);
    assert.equal(checked.parkedTerminalCheckedAt, now);
    assert.equal(retained.items["openclaw/gogcli#113345"].parkedTerminalCheckedAt, undefined);
    assert.equal(harness.dispatched.length, 0);
    assert.equal(await harness.storage.getAlarm(), now + 5 * 60_000);
    assert.equal(
      exactReviewQueueNextWakeAt(
        {
          ...retained,
          dispatcher: { state: "blocked", checkedAt: now, retryAt: now + 10 * 60_000 },
        } as never,
        now,
      ),
      now + 10 * 60_000,
    );

    now += 4 * 60_000;
    await harness.queue.alarm();
    const notDue = (await harness.storage.get("exact-review-queue")) as typeof state;
    assert.equal(
      notDue.items["openclaw/gogcli#113344"].parkedTerminalCheckedAt,
      checked.parkedTerminalCheckedAt,
    );
    assert.equal(notDue.items["openclaw/gogcli#113345"].parkedTerminalCheckedAt, undefined);

    now += 60_000;
    await harness.queue.alarm();
    const rotated = (await harness.storage.get("exact-review-queue")) as typeof state;
    assert.equal(rotated.items["openclaw/gogcli#113345"].parkedTerminalCheckedAt, now);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("failed parked terminal check does not block healthy pending review dispatch", async () => {
  const originalNow = Date.now;
  const now = Date.parse("2026-08-10T16:30:00.000Z");
  Date.now = () => now;
  const harness = createExactReviewAdmissionHarness((_targetRepo, itemNumber) =>
    itemNumber === 113_350
      ? jsonResponse({ message: "temporary GitHub outage" }, { status: 503 })
      : jsonResponse({ state: "open" }),
  );
  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest("unavailable-exhausted-parked", 113_350, "opened"),
    );
    await harness.queue.fetch(
      buildExactReviewQueueRequest("healthy-pending-review", 113_351, "opened"),
    );
    const state = (await harness.storage.get("exact-review-queue")) as {
      dispatcher?: { state?: string; reason?: string; parkedTerminalCheckedAt?: number };
      items: Record<
        string,
        {
          state: string;
          attempts: number;
          parkedReason?: string;
          parkedRecoveryAttempts?: number;
          parkedTerminalCheckedAt?: number;
        }
      >;
    };
    const parked = state.items["openclaw/gogcli#113350"];
    parked.state = "parked";
    parked.attempts = 8;
    parked.parkedReason = "review_retry_exhausted";
    parked.parkedRecoveryAttempts = 3;
    await harness.storage.put("exact-review-queue", state);

    await harness.queue.alarm();

    const checked = (await harness.storage.get("exact-review-queue")) as typeof state;
    assert.equal(checked.dispatcher?.state, "active");
    assert.equal(checked.dispatcher?.reason, undefined);
    assert.equal(checked.dispatcher?.parkedTerminalCheckedAt, now);
    assert.equal(checked.items["openclaw/gogcli#113350"].state, "parked");
    assert.equal(checked.items["openclaw/gogcli#113350"].attempts, 8);
    assert.equal(checked.items["openclaw/gogcli#113350"].parkedTerminalCheckedAt, now);
    assert.equal(checked.items["openclaw/gogcli#113351"].state, "dispatching");
    assert.equal(harness.dispatched.length, 1);
  } finally {
    Date.now = originalNow;
    harness.restore();
  }
});

test("exact-review queue removes a terminal dispatch rejection after parked recovery is exhausted", async () => {
  const harness = createExactReviewAdmissionHarness(() => jsonResponse({ state: "closed" }));
  try {
    await harness.queue.fetch(
      buildExactReviewQueueRequest("terminal-exhausted-dispatch-rejection", 113_349, "opened"),
    );
    const state = (await harness.storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          parkedReason?: string;
          parkedRecoveryAttempts?: number;
        }
      >;
    };
    const item = state.items["openclaw/gogcli#113349"];
    item.state = "parked";
    item.parkedReason = "dispatch_rejected";
    item.parkedRecoveryAttempts = 3;
    await harness.storage.put("exact-review-queue", state);

    await harness.queue.alarm();

    const reconciled = (await harness.storage.get("exact-review-queue")) as typeof state;
    assert.equal(reconciled.items["openclaw/gogcli#113349"], undefined);
    assert.equal(harness.dispatched.length, 0);
  } finally {
    harness.restore();
  }
});

test("parked review operator routes paginate, resolve, and recover idempotently within caps", async () => {
  const storage = new MemoryDurableStorage();
  const now = Date.parse("2026-08-10T12:00:00.000Z");
  const items = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => {
      const item = leasedExactReviewQueueItem(114_000 + index, `91400${index}`);
      item.state = "parked";
      item.parkedReason = index === 7 ? "dead_letter_capacity" : "review_retry_exhausted";
      item.parkedRecoveryAttempts = index === 6 ? 2 : 3;
      item.parkedRecoveryAt = undefined;
      item.attempts = 8;
      item.reviewFailureAttempts = 8;
      item.firstFailureAt = now - 60_000;
      item.updatedAt = now + index;
      return [item.key, item];
    }),
  );
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "10" },
  );

  const first = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
        method: "POST",
        body: JSON.stringify({ limit: 2 }),
      }),
    )
  ).json();
  assert.equal(first.parked_reviews.length, 2);
  const all = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
        method: "POST",
        body: JSON.stringify({ limit: 50 }),
      }),
    )
  ).json();
  assert.equal(all.parked_reviews.length, 6);
  const rotatedFirstKeys = [];
  for (const scanSeed of ["rotation-a", "rotation-b", "rotation-c", "rotation-d"]) {
    const rotated = await (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
          method: "POST",
          body: JSON.stringify({ limit: 1, scan_seed: scanSeed }),
        }),
      )
    ).json();
    rotatedFirstKeys.push(rotated.parked_reviews[0].item_key);
  }
  assert.ok(new Set(rotatedFirstKeys).size > 1);
  assert.equal(
    all.parked_reviews.some((item) => item.item_key === "openclaw/openclaw#114006"),
    false,
  );
  assert.equal(
    all.parked_reviews.some((item) => item.item_key === "openclaw/openclaw#114007"),
    false,
  );
  assert.equal(first.parked_reviews[0].item_key, "openclaw/openclaw#114000");
  assert.deepEqual(
    Object.keys(first.parked_reviews[0]).sort(),
    [
      "first_failed_at",
      "item_key",
      "item_kind",
      "last_failure_reason",
      "parked_reason",
      "parked_recovery_attempts",
      "revision",
      "retry_policy_changed",
      "retry_policy_epoch",
      "source_base_sha",
      "source_content_revision",
      "source_head_sha",
      "source_is_draft",
      "source_updated_at",
      "target_repo",
      "item_number",
      "updated_at",
      "updated_at_ms",
    ].sort(),
  );
  assert.equal(first.parked_reviews[0].parked_recovery_attempts, 3);
  assert.equal(first.parked_reviews[0].last_failure_reason, "review_retry_exhausted");
  assert.equal(first.next_cursor, "openclaw/openclaw#114001");

  const second = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
        method: "POST",
        body: JSON.stringify({ limit: 2, cursor: first.next_cursor }),
      }),
    )
  ).json();
  assert.deepEqual(
    second.parked_reviews.map((item) => item.item_key),
    ["openclaw/openclaw#114002", "openclaw/openclaw#114003"],
  );

  const ineligible = [6, 7].map((index) => ({
    item_key: `openclaw/openclaw#${114_000 + index}`,
    revision: 1,
    updated_at_ms: now + index,
  }));
  const earlyResolve = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/resolve", {
      method: "POST",
      body: JSON.stringify({ items: ineligible, note: "must remain parked" }),
    }),
  );
  assert.deepEqual(await earlyResolve.json(), { ok: true, resolved: 0, skipped: 2 });
  const earlyRecover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        items: ineligible,
        idempotency_key: "parked-reconcile:ineligible",
      }),
    }),
  );
  assert.deepEqual(await earlyRecover.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 2,
    unchanged: 0,
  });
  const guarded = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; parkedRecoveryAttempts?: number; parkedReason?: string }
    >;
  };
  assert.equal(guarded.items["openclaw/openclaw#114006"].state, "parked");
  assert.equal(guarded.items["openclaw/openclaw#114006"].parkedRecoveryAttempts, 2);
  assert.equal(guarded.items["openclaw/openclaw#114007"].state, "parked");
  assert.equal(guarded.items["openclaw/openclaw#114007"].parkedReason, "dead_letter_capacity");

  const terminal = first.parked_reviews[0];
  const resolved = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/resolve", {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            item_key: terminal.item_key,
            revision: terminal.revision,
            updated_at_ms: terminal.updated_at_ms,
          },
        ],
        note: "automatic reconciliation: terminal test target",
      }),
    }),
  );
  assert.deepEqual(await resolved.json(), { ok: true, resolved: 1, skipped: 0 });

  const recoverable = first.parked_reviews[1];
  const recoveryPayload = {
    items: [
      {
        item_key: recoverable.item_key,
        revision: recoverable.revision,
        updated_at_ms: recoverable.updated_at_ms,
      },
    ],
    idempotency_key: "parked-reconcile:test:114001",
    override_retry_budget: true,
  };
  const observed = (await storage.get("exact-review-queue")) as {
    items: Record<string, { updatedAt: number }>;
  };
  observed.items[recoverable.item_key].updatedAt += 5 * 60_000;
  await storage.put("exact-review-queue", observed);
  const recover = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
        method: "POST",
        body: JSON.stringify(recoveryPayload),
      }),
    );
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unchanged: 0,
  });
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 0,
    deduped: 1,
    skipped: 0,
    unchanged: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        attempts: number;
        reviewFailureAttempts?: number;
        parkedReason?: string;
        parkedRecoveryAttempts?: number;
      }
    >;
  };
  assert.equal(state.items[terminal.item_key], undefined);
  assert.equal(state.items[recoverable.item_key].state, "pending");
  assert.equal(state.items[recoverable.item_key].attempts, 0);
  assert.equal(state.items[recoverable.item_key].reviewFailureAttempts, 0);
  assert.equal(state.items[recoverable.item_key].parkedReason, undefined);
  assert.equal(state.items[recoverable.item_key].parkedRecoveryAttempts, 0);

  assert.equal(
    (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
          method: "POST",
          body: JSON.stringify({ limit: 51 }),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
          method: "POST",
          body: JSON.stringify({
            items: second.parked_reviews
              .concat([
                {
                  ...second.parked_reviews[0],
                  item_key: "openclaw/openclaw#114004",
                  updated_at_ms: now + 4,
                },
                {
                  ...second.parked_reviews[0],
                  item_key: "openclaw/openclaw#114005",
                  updated_at_ms: now + 5,
                },
                {
                  ...second.parked_reviews[0],
                  item_key: "openclaw/openclaw#114006",
                  updated_at_ms: now + 6,
                },
                {
                  ...second.parked_reviews[0],
                  item_key: "openclaw/openclaw#114007",
                  updated_at_ms: now + 7,
                },
              ])
              .map((item) => ({
                item_key: item.item_key,
                revision: item.revision,
                updated_at_ms: item.updated_at_ms,
              })),
            idempotency_key: "parked-reconcile:over-cap",
          }),
        }),
      )
    ).status,
    400,
  );
});

test("parked review operator routes flag and refuse both command-context variants", async () => {
  const storage = new MemoryDurableStorage();
  const now = Date.parse("2026-08-10T12:30:00.000Z");
  const ordinary = leasedExactReviewQueueItem(114_020, "914020");
  const markerOnly = leasedExactReviewQueueItem(114_021, "914021");
  const commentOnly = leasedExactReviewQueueItem(114_022, "914022");
  for (const item of [ordinary, markerOnly, commentOnly]) {
    item.state = "parked";
    item.parkedReason = "review_retry_exhausted";
    item.parkedRecoveryAttempts = 3;
    item.parkedRecoveryAt = undefined;
    item.attempts = 8;
    item.reviewFailureAttempts = 8;
    item.updatedAt = now;
  }
  markerOnly.decision.commandStatusMarker =
    "<!-- clawsweeper-command-status:114021:re_review:parked -->";
  commentOnly.decision.statusCommentId = 914_022;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      [ordinary.key]: ordinary,
      [markerOnly.key]: markerOnly,
      [commentOnly.key]: commentOnly,
    },
  });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const inventory = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
        method: "POST",
        body: JSON.stringify({ limit: 50 }),
      }),
    )
  ).json();
  assert.equal(inventory.parked_reviews.length, 3);
  const ordinaryRow = inventory.parked_reviews.find((row) => row.item_key === ordinary.key);
  const commandRows = [markerOnly, commentOnly].map((command) =>
    inventory.parked_reviews.find((row) => row.item_key === command.key),
  );
  assert.equal(ordinaryRow.excluded_reason, undefined);
  assert.deepEqual(
    commandRows.map((row) => row.excluded_reason),
    ["command_context", "command_context"],
  );
  const commandMutations = commandRows.map((row) => ({
    item_key: row.item_key,
    revision: row.revision,
    updated_at_ms: row.updated_at_ms,
  }));

  const resolve = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/resolve", {
      method: "POST",
      body: JSON.stringify({
        items: commandMutations,
        note: "must remain parked for command acknowledgement",
      }),
    }),
  );
  assert.deepEqual(await resolve.json(), { ok: true, resolved: 0, skipped: 2 });
  const recover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        items: commandMutations,
        idempotency_key: "parked-reconcile:command-context",
      }),
    }),
  );
  assert.deepEqual(await recover.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 2,
    unchanged: 0,
  });

  const ordinaryRecover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            item_key: ordinaryRow.item_key,
            revision: ordinaryRow.revision,
            updated_at_ms: ordinaryRow.updated_at_ms,
          },
        ],
        idempotency_key: "parked-reconcile:ordinary",
        override_retry_budget: true,
      }),
    }),
  );
  assert.deepEqual(await ordinaryRecover.json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unchanged: 0,
  });

  const after = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        revision: number;
        attempts: number;
        parkedReason?: string;
        parkedRecoveryAttempts?: number;
        decision: { commandStatusMarker?: string; statusCommentId?: number };
      }
    >;
  };
  assert.equal(after.items[ordinary.key].state, "pending");
  assert.equal(after.items[ordinary.key].parkedRecoveryAttempts, 0);
  for (const [index, command] of [markerOnly, commentOnly].entries()) {
    assert.equal(after.items[command.key].state, "parked");
    assert.equal(after.items[command.key].revision, commandRows[index].revision);
    assert.equal(after.items[command.key].attempts, 8);
    assert.equal(after.items[command.key].parkedReason, "review_retry_exhausted");
    assert.equal(after.items[command.key].parkedRecoveryAttempts, 3);
  }
  assert.equal(
    after.items[markerOnly.key].decision.commandStatusMarker,
    "<!-- clawsweeper-command-status:114021:re_review:parked -->",
  );
  assert.equal(after.items[commentOnly.key].decision.statusCommentId, 914_022);
});

test("seeded parked-review pagination survives removal of the cursor item", async () => {
  const storage = new MemoryDurableStorage();
  const items = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => {
      const item = leasedExactReviewQueueItem(114_040 + index, `91404${index}`);
      item.state = "parked";
      item.parkedReason = "review_retry_exhausted";
      item.parkedRecoveryAttempts = 3;
      item.parkedRecoveryAt = undefined;
      return [item.key, item];
    }),
  );
  await storage.put("exact-review-queue", { deliveries: {}, items });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" });
  const scanSeed = "cursor-mutation-proof";
  const first = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
        method: "POST",
        body: JSON.stringify({ limit: 2, scan_seed: scanSeed }),
      }),
    )
  ).json();
  assert.equal(first.parked_reviews.length, 2);
  assert.match(first.next_cursor, /^[0-9a-f]{64}:/);

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  delete state.items[first.parked_reviews[1].item_key];
  await storage.put("exact-review-queue", state);
  const secondResponse = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
      method: "POST",
      body: JSON.stringify({ limit: 2, scan_seed: scanSeed, cursor: first.next_cursor }),
    }),
  );
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal(
    second.parked_reviews.some((entry) => entry.item_key === first.parked_reviews[0].item_key),
    false,
  );
});

test("unseeded parked-review pagination uses its locale ordering for the cursor", async () => {
  const storage = new MemoryDurableStorage();
  const first = leasedExactReviewQueueItem(114_048, "914048");
  first.key = "openclaw/a#114048";
  first.decision = { ...first.decision, targetRepo: "openclaw/a" };
  first.leaseDecision = { ...first.decision };
  first.state = "parked";
  first.parkedReason = "review_retry_exhausted";
  first.parkedRecoveryAttempts = 3;
  first.parkedRecoveryAt = undefined;
  const second = leasedExactReviewQueueItem(114_049, "914049");
  second.key = "openclaw/B#114049";
  second.decision = { ...second.decision, targetRepo: "openclaw/B" };
  second.leaseDecision = { ...second.decision };
  second.state = "parked";
  second.parkedReason = "review_retry_exhausted";
  second.parkedRecoveryAttempts = 3;
  second.parkedRecoveryAt = undefined;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [first.key]: first, [second.key]: second },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const page = async (cursor?: string) =>
    (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/parked-reviews/list", {
          method: "POST",
          body: JSON.stringify({ limit: 1, ...(cursor ? { cursor } : {}) }),
        }),
      )
    ).json();
  const pageOne = await page();
  const pageTwo = await page(pageOne.next_cursor);
  assert.deepEqual(
    [...pageOne.parked_reviews, ...pageTwo.parked_reviews].map((entry) => entry.item_key),
    [first.key, second.key],
  );
});

test("parked review retry budgets reset only for source or policy drift", async () => {
  const now = Date.parse("2026-08-10T13:00:00.000Z");
  const sourceUpdatedAt = "2026-08-10T12:00:00.000Z";
  const item = leasedExactReviewQueueItem(114_030, "914030");
  item.decision.sourceUpdatedAt = sourceUpdatedAt;
  item.leaseDecision = { ...item.decision };
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.parkedRecoveryAt = undefined;
  item.attempts = 8;
  item.reviewFailureAttempts = 8;
  item.reviewRetryPolicyEpoch = "1";
  item.updatedAt = now;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" },
  );

  const recovery = (overrides: Record<string, unknown> = {}) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
        method: "POST",
        body: JSON.stringify({
          items: [
            {
              item_key: item.key,
              revision: 1,
              updated_at_ms: now,
              source_updated_at: sourceUpdatedAt,
              ...overrides,
            },
          ],
          idempotency_key: `parked-reconcile:${String(overrides.source_updated_at || "same")}`,
        }),
      }),
    );

  assert.deepEqual(await (await recovery()).json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unchanged: 1,
  });
  let state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].state, "parked");
  assert.equal(state.items[item.key].parkedRecoveryAttempts, 3);
  assert.equal(state.items[item.key].reviewFailureAttempts, 8);

  const changedSourceUpdatedAt = "2026-08-10T12:05:00.000Z";
  assert.deepEqual(await (await recovery({ source_updated_at: changedSourceUpdatedAt })).json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unchanged: 0,
  });
  state = (await storage.get("exact-review-queue")) as { items: Record<string, typeof item> };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].revision, 2);
  assert.equal(state.items[item.key].decision.sourceUpdatedAt, changedSourceUpdatedAt);
  assert.equal(state.items[item.key].parkedRecoveryAttempts, 0);
  assert.equal(state.items[item.key].reviewFailureAttempts, 0);

  const policyItem = leasedExactReviewQueueItem(114_031, "914031");
  policyItem.state = "parked";
  policyItem.parkedReason = "review_retry_exhausted";
  policyItem.parkedRecoveryAttempts = 3;
  policyItem.parkedRecoveryAt = undefined;
  policyItem.updatedAt = now;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [policyItem.key]: policyItem },
  });
  const policyQueue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" },
  );
  const policyRecovery = await policyQueue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            item_key: policyItem.key,
            revision: 1,
            updated_at_ms: now,
          },
        ],
        idempotency_key: "parked-reconcile:policy-epoch-2",
      }),
    }),
  );
  assert.deepEqual(await policyRecovery.json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unchanged: 0,
  });
  state = (await storage.get("exact-review-queue")) as { items: Record<string, typeof item> };
  assert.equal(state.items[policyItem.key].reviewRetryPolicyEpoch, "2");
});

test("older issue revisions cannot reset an exhausted review budget", async () => {
  const item = leasedExactReviewQueueItem(114_049, "914049");
  item.decision = {
    ...item.decision,
    sourceAction: "edited",
    sourceContentRevision: "b".repeat(64),
    sourceUpdatedAt: "2026-08-10T12:05:00.000Z",
  };
  item.leaseDecision = { ...item.decision };
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.parkedRecoveryAt = undefined;
  item.attempts = 8;
  item.reviewFailureAttempts = 8;
  item.reviewRetryPolicyEpoch = "1";
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" });

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "older-issue-revision",
      114_049,
      "edited",
      "issue",
      "openclaw/openclaw",
      {
        sourceContentRevision: "a".repeat(64),
        sourceUpdatedAt: "2026-08-10T12:00:00.000Z",
      },
    ),
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    ok: true,
    deduped: true,
    item_key: item.key,
    stale_source: true,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].state, "parked");
  assert.equal(state.items[item.key].revision, 1);
  assert.equal(state.items[item.key].reviewFailureAttempts, 8);
  assert.equal(state.items[item.key].decision.sourceContentRevision, "b".repeat(64));
  assert.equal(state.items[item.key].decision.sourceUpdatedAt, "2026-08-10T12:05:00.000Z");

  const equalTimestamp = await queue.fetch(
    buildExactReviewQueueRequest(
      "equal-timestamp-issue-revision",
      114_049,
      "edited",
      "issue",
      "openclaw/openclaw",
      {
        sourceContentRevision: "c".repeat(64),
        sourceUpdatedAt: "2026-08-10T12:05:00.000Z",
      },
    ),
  );
  assert.equal(equalTimestamp.status, 202);
  assert.equal((await equalTimestamp.json()).stale_source, true);
  const afterEqualTimestamp = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(afterEqualTimestamp.items[item.key].state, "parked");
  assert.equal(afterEqualTimestamp.items[item.key].reviewFailureAttempts, 8);
  assert.equal(afterEqualTimestamp.items[item.key].decision.sourceContentRevision, "b".repeat(64));

  const equalDigestDifferentAction = await queue.fetch(
    buildExactReviewQueueRequest(
      "equal-timestamp-equal-digest-different-action",
      114_049,
      "reopened",
      "issue",
      "openclaw/openclaw",
      {
        sourceContentRevision: "b".repeat(64),
        sourceUpdatedAt: "2026-08-10T12:05:00.000Z",
      },
    ),
  );
  assert.equal(equalDigestDifferentAction.status, 202);
  assert.equal((await equalDigestDifferentAction.json()).stale_source, true);
  const afterDifferentAction = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(afterDifferentAction.items[item.key].state, "parked");
  assert.equal(afterDifferentAction.items[item.key].revision, 1);
  assert.equal(afterDifferentAction.items[item.key].reviewFailureAttempts, 8);
});

test("same-second issue successors remain queued behind an active review", async () => {
  const item = leasedExactReviewQueueItem(114_051, "914051");
  item.decision = {
    ...item.decision,
    sourceAction: "edited",
    sourceContentRevision: "b".repeat(64),
    sourceUpdatedAt: "2026-08-10T12:05:00.000Z",
  };
  item.leaseDecision = { ...item.decision };
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" });

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "same-second-active-issue-successor",
      114_051,
      "edited",
      "issue",
      "openclaw/openclaw",
      {
        sourceContentRevision: "c".repeat(64),
        sourceUpdatedAt: "2026-08-10T12:05:00.000Z",
      },
    ),
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).stale_source, undefined);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].revision, 2);
  assert.equal(state.items[item.key].decision.sourceContentRevision, "c".repeat(64));
});

test("same-source queue revisions preserve an exhausted review budget", async () => {
  const now = Date.parse("2026-08-10T14:00:00.000Z");
  const sourceUpdatedAt = "2026-08-10T13:00:00.000Z";
  const item = leasedExactReviewQueueItem(114_032, "914032");
  item.decision.sourceUpdatedAt = sourceUpdatedAt;
  item.leaseDecision = { ...item.decision };
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 1;
  item.parkedRecoveryAt = now + 5 * 60_000;
  item.attempts = 8;
  item.reviewFailureAttempts = 8;
  item.reviewRetryPolicyEpoch = "1";
  item.updatedAt = now;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" },
  );

  const enqueue = (deliveryId: string, updatedAt: string) =>
    queue.fetch(
      buildExactReviewQueueRequest(deliveryId, 114_032, "opened", "issue", "openclaw/openclaw", {
        sourceUpdatedAt: updatedAt,
      }),
    );
  const enqueueStartedAt = Date.now();
  assert.equal((await enqueue("retry-same-source", sourceUpdatedAt)).status, 202);
  let state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].revision, 2);
  assert.equal(state.items[item.key].state, "parked");
  assert.equal(state.items[item.key].parkedRecoveryAttempts, 1);
  assert.equal(state.items[item.key].reviewFailureAttempts, 8);
  assert.ok(Number(state.items[item.key].parkedRecoveryAt) >= enqueueStartedAt);
  assert.ok(Number(state.items[item.key].parkedRecoveryAt) <= Date.now());

  assert.equal((await enqueue("retry-new-source", "2026-08-10T13:05:00.000Z")).status, 202);
  state = (await storage.get("exact-review-queue")) as { items: Record<string, typeof item> };
  assert.equal(state.items[item.key].revision, 3);
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].parkedRecoveryAttempts, 0);
  assert.equal(state.items[item.key].reviewFailureAttempts, 0);
});

test("target branch changes reset an exhausted review budget", async () => {
  const sourceUpdatedAt = "2026-08-10T13:00:00.000Z";
  const item = leasedExactReviewQueueItem(114_050, "914050");
  item.decision = { ...item.decision, sourceUpdatedAt };
  item.leaseDecision = { ...item.decision };
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.attempts = 8;
  item.reviewFailureAttempts = 8;
  item.reviewRetryPolicyEpoch = "1";
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" },
  );

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "retry-new-target-branch",
      114_050,
      "opened",
      "issue",
      "openclaw/openclaw",
      { targetBranch: "next", sourceUpdatedAt },
    ),
  );
  assert.equal(response.status, 202);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].decision.targetBranch, "next");
  assert.equal(state.items[item.key].parkedRecoveryAttempts, 0);
  assert.equal(state.items[item.key].reviewFailureAttempts, 0);
});

test("standalone prompt changes reset an exhausted review budget", async () => {
  const sourceUpdatedAt = "2026-08-10T13:30:00.000Z";
  const item = leasedExactReviewQueueItem(114_046, "914046");
  item.decision = { ...item.decision, sourceUpdatedAt, additionalPrompt: "old policy" };
  item.leaseDecision = { ...item.decision };
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.parkedRecoveryAt = undefined;
  item.attempts = 8;
  item.reviewFailureAttempts = 8;
  item.reviewRetryPolicyEpoch = "1";
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" },
  );

  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "retry-new-standalone-prompt",
      114_046,
      "opened",
      "issue",
      "openclaw/openclaw",
      { sourceUpdatedAt, additionalPrompt: "new policy" },
    ),
  );
  assert.equal(response.status, 202);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 0);
  assert.equal(state.items[item.key].reviewFailureAttempts, 0);
  assert.equal(state.items[item.key].decision.additionalPrompt, "new policy");
});

test("parked recovery advances source authority past delayed older webhooks", async () => {
  const recoveredAt = Date.parse("2026-08-10T14:00:00.000Z");
  const oldUpdatedAt = "2026-08-10T13:55:00.000Z";
  const liveUpdatedAt = "2026-08-10T14:00:00.000Z";
  const oldRevision = "a".repeat(64);
  const liveRevision = "b".repeat(64);
  const sourceHeadSha = "c".repeat(40);
  const sourceBaseSha = "d".repeat(40);
  const item = leasedExactReviewQueueItem(114_047, "914047");
  item.decision = {
    ...item.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceAction: "edited",
    supersedesInProgress: true,
    sourceHeadSha,
    sourceBaseSha,
    sourceIsDraft: false,
    sourceContentRevision: oldRevision,
    sourceUpdatedAt: oldUpdatedAt,
    sourceHeadVerified: true,
    sourceAuthoritySeq: 10,
  };
  item.leaseDecision = { ...item.decision };
  item.sourceAuthorityWatermark = { sequence: 10, updatedAt: oldUpdatedAt };
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.parkedRecoveryAt = undefined;
  item.attempts = 8;
  item.reviewFailureAttempts = 8;
  item.reviewRetryPolicyEpoch = "1";
  item.updatedAt = recoveredAt;
  for (const field of [
    "leaseId",
    "leaseRevision",
    "leaseDecision",
    "leaseExpiresAt",
    "claimedRunId",
    "claimedRunAttempt",
    "claimGeneration",
    "claimProtocolVersion",
  ] as const) {
    delete item[field];
  }
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0", EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" },
  );

  const recovered = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/parked-reviews/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            item_key: item.key,
            revision: 1,
            updated_at_ms: recoveredAt,
            source_head_sha: sourceHeadSha,
            source_base_sha: sourceBaseSha,
            source_is_draft: false,
            source_content_revision: liveRevision,
            source_updated_at: liveUpdatedAt,
          },
        ],
        idempotency_key: "parked-reconcile:authority-watermark",
      }),
    }),
  );
  assert.deepEqual(await recovered.json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unchanged: 0,
  });

  const delayed = await queue.fetch(
    buildExactReviewQueueRequest(
      "delayed-older-authority",
      114_047,
      "edited",
      "pull_request",
      "openclaw/openclaw",
      {
        sourceHeadSha,
        sourceBaseSha,
        sourceIsDraft: false,
        sourceContentRevision: oldRevision,
        sourceUpdatedAt: oldUpdatedAt,
        sourceHeadVerified: true,
        sourceAuthoritySeq: 11,
      },
    ),
  );
  assert.equal(delayed.status, 202);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].revision, 2);
  assert.equal(state.items[item.key].decision.sourceContentRevision, liveRevision);
  assert.equal(state.items[item.key].decision.sourceUpdatedAt, liveUpdatedAt);
  assert.deepEqual(state.items[item.key].sourceAuthorityWatermark, {
    sequence: 10,
    updatedAt: liveUpdatedAt,
  });
});

test("timestamp-only successors discard inherited content digests", async () => {
  const item = leasedExactReviewQueueItem(114_045, "914045");
  item.decision.sourceContentRevision = "a".repeat(64);
  item.decision.sourceUpdatedAt = "2026-08-10T14:00:00.000Z";
  item.leaseDecision = { ...item.decision };
  item.state = "parked";
  item.parkedReason = "review_retry_exhausted";
  item.parkedRecoveryAttempts = 3;
  item.parkedRecoveryAt = undefined;
  item.reviewRetryPolicyEpoch = "1";
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    buildExactReviewQueueRequest(
      "timestamp-only-successor",
      114_045,
      "opened",
      "issue",
      "openclaw/openclaw",
      { sourceUpdatedAt: "2026-08-10T14:05:00.000Z" },
    ),
  );
  assert.equal(response.status, 202);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; decision: { sourceContentRevision?: string; sourceUpdatedAt?: string } }
    >;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].decision.sourceContentRevision, undefined);
  assert.equal(state.items[item.key].decision.sourceUpdatedAt, "2026-08-10T14:05:00.000Z");
});

test("same-source successor revisions cannot bypass the active lease retry ceiling", async () => {
  const sourceUpdatedAt = "2026-08-10T15:00:00.000Z";
  const item = leasedExactReviewQueueItem(114_033, "914033");
  item.leaseDecision = { ...item.decision, sourceUpdatedAt };
  item.decision = { ...item.leaseDecision };
  item.revision = 2;
  item.attempts = 7;
  item.reviewFailureAttempts = 7;
  item.reviewRetryPolicyEpoch = "1";
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" },
    () => 0.5,
  );

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
      }),
    }),
  );
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].revision, 2);
  assert.equal(state.items[item.key].state, "parked");
  assert.equal(state.items[item.key].reviewFailureAttempts, 8);
  assert.equal(state.items[item.key].parkedReason, "review_retry_exhausted");
});

test("a policy epoch change resets a failing same-revision lease budget", async () => {
  const item = leasedExactReviewQueueItem(114_035, "914035");
  item.attempts = 7;
  item.reviewFailureAttempts = 7;
  item.reviewRetryPolicyEpoch = "1";
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" });

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 0);
  assert.equal(state.items[item.key].reviewFailureAttempts, 0);
  assert.equal(state.items[item.key].reviewRetryPolicyEpoch, "2");
});

test("fresh review admissions start on the active retry policy epoch", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" });
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("retry-epoch-2-fresh", 114_036, "opened")))
      .status,
    202,
  );
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { reviewRetryPolicyEpoch?: string }>;
  };
  assert.equal(state.items["openclaw/gogcli#114036"].reviewRetryPolicyEpoch, "2");
});

test("expired same-source successor leases preserve their retry budget", async () => {
  const sourceUpdatedAt = "2026-08-10T16:00:00.000Z";
  const item = leasedExactReviewQueueItem(114_034, "914034");
  item.leaseDecision = { ...item.decision, sourceUpdatedAt };
  item.decision = { ...item.leaseDecision };
  item.revision = 2;
  item.attempts = 7;
  item.reviewFailureAttempts = 7;
  item.reviewRetryPolicyEpoch = "1";
  item.leaseExpiresAt = Date.now() - 1;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "1" });

  assert.equal(
    (await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))).status,
    200,
  );
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, typeof item>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 7);
  assert.equal(state.items[item.key].reviewFailureAttempts, 7);
  assert.equal(state.items[item.key].reviewRecoveryReason, "execution_timeout");
});

test("exact-review admission requeue_latest resets failures instead of parking at the review ceiling", async () => {
  const storage = new MemoryDurableStorage();
  const review = leasedExactReviewQueueItem(113_342, "9130");
  const publication = leasedExactReviewPublicationItem(113_343, "9131");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      [review.key]: { ...review, attempts: 7, reviewFailureAttempts: 7 },
      [publication.key]: { ...publication, attempts: 40, reviewFailureAttempts: 40 },
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const completion = (item: { key: string }, runId: string, extra: Record<string, unknown>) =>
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: `lease-${item.key.split("#")[1].split("@")[0]}`,
        item_key: item.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: runId,
        run_attempt: 1,
        ...extra,
      }),
    });

  assert.equal(
    (await queue.fetch(completion(review, "9130", { outcome: "success", requeue_latest: true })))
      .status,
    200,
  );
  assert.equal(
    (await queue.fetch(completion(publication, "9131", { outcome: "failure" }))).status,
    200,
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; attempts: number; reviewFailureAttempts?: number; parkedReason?: string }
    >;
  };
  assert.equal(state.items[review.key].state, "pending");
  assert.equal(state.items[review.key].attempts, 0);
  assert.equal(state.items[review.key].reviewFailureAttempts, 0);
  assert.equal(state.items[review.key].parkedReason, undefined);
  assert.equal(state.items[publication.key].state, "pending");
  assert.equal(state.items[publication.key].attempts, 41);
  assert.equal(state.items[publication.key].parkedReason, undefined);
});

test("exact-review queue can use the global capacity for one target", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "4",
      },
    );
    for (const itemNumber of [701, 702, 703, 704]) {
      await queue.fetch(
        buildExactReviewQueueRequest(`delivery-${itemNumber}`, itemNumber, "opened"),
      );
    }

    await queue.alarm();

    assert.equal(dispatched.length, 4);
    assert.equal(
      new Set(
        dispatched.map(
          (payload) => (payload.client_payload as Record<string, unknown>).target_repo,
        ),
      ).size,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue keeps publication artifacts durable outside review capacity", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse(Object.fromEntries([["token", "t"]]));
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "4",
      },
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:100:1",
        801,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(801, "100"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:101:1",
        802,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(802, "101"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:102:1",
        803,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(803, "102"),
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "publisher:103:1",
        804,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/gogcli",
        exactReviewPublicationOverrides(804, "103", "failed_review_shard_recovery"),
      ),
    );
    await queue.fetch(buildExactReviewQueueRequest("ordinary-801", 801, "edited"));
    await queue.fetch(buildExactReviewQueueRequest("ordinary-803", 803, "edited"));

    const state = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          createdAt: number;
          decision: Record<string, unknown>;
          dispatchedAt?: number;
          leaseDecision?: Record<string, unknown>;
          leaseExpiresAt?: number;
          leaseId?: string;
          leaseRevision?: number;
          nextAttemptAt: number;
          revision: number;
          state: string;
        }
      >;
    };
    assert.deepEqual(Object.keys(state.items).sort(), [
      "openclaw/gogcli#801",
      "openclaw/gogcli#801@publish:100:1",
      "openclaw/gogcli#802@publish:101:1",
      "openclaw/gogcli#803",
      "openclaw/gogcli#803@publish:102:1",
      "openclaw/gogcli#804@publish:103:1",
    ]);
    state.items["openclaw/gogcli#802@publish:101:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#802@publish:101:1"].nextAttemptAt = Date.now() - 1;
    state.items["openclaw/gogcli#803@publish:102:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#803@publish:102:1"].nextAttemptAt = Date.now() - 1;
    state.items["openclaw/gogcli#804@publish:103:1"].createdAt =
      Date.now() - 81 * 24 * 60 * 60 * 1000;
    state.items["openclaw/gogcli#804@publish:103:1"].nextAttemptAt = Date.now() - 1;
    const activeFreshReview = state.items["openclaw/gogcli#803"];
    activeFreshReview.state = "leased";
    activeFreshReview.decision = {
      ...activeFreshReview.decision,
      additionalPrompt: "newer maintainer context",
    };
    activeFreshReview.revision = 4;
    activeFreshReview.leaseId = "lease-fresh-803";
    activeFreshReview.leaseRevision = 4;
    activeFreshReview.leaseDecision = { ...activeFreshReview.decision };
    activeFreshReview.leaseExpiresAt = Date.now() + 60_000;
    const activeFreshReviewBeforeExpiry = structuredClone(activeFreshReview);
    await storage.put("exact-review-queue", state);

    await queue.alarm();
    const sourceActions = dispatched.map((payload) =>
      String((payload.client_payload as Record<string, unknown>).source_action),
    );
    assert.equal(
      sourceActions.filter((action) => action === "exact_review_artifact_publish").length,
      1,
    );
    assert.equal(sourceActions.filter((action) => action === "edited").length, 1);
    assert.equal(
      sourceActions.filter((action) => action === "artifact_retention_recovery").length,
      1,
    );
    assert.equal(
      sourceActions.filter((action) => action === "failed_review_shard_recovery").length,
      1,
    );
    assert.equal(
      dispatched.some(
        (payload) =>
          Number((payload.client_payload as Record<string, unknown>).item_number) === 803,
      ),
      false,
    );
    const afterExpiry = (await storage.get("exact-review-queue")) as typeof state;
    assert.deepEqual(afterExpiry.items["openclaw/gogcli#803"], activeFreshReviewBeforeExpiry);
    assert.equal(afterExpiry.items["openclaw/gogcli#803@publish:102:1"], undefined);
    const reservedPublisher = afterExpiry.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(reservedPublisher.state, "dispatching");
    assert.ok((reservedPublisher.leaseExpiresAt ?? 0) - Date.now() > 14 * 60_000);
    assert.ok((reservedPublisher.leaseExpiresAt ?? 0) - Date.now() <= 15 * 60_000);
    const publicationPayload = dispatched.find(
      (payload) =>
        (payload.client_payload as Record<string, unknown>).source_action ===
        "exact_review_artifact_publish",
    )?.client_payload as Record<string, unknown>;
    assert.match(
      String((publicationPayload.queue_claim as Record<string, unknown>).item_key),
      /@publish:/,
    );
    assert.ok(
      (
        (publicationPayload.review_options as Record<string, unknown>).publication as Record<
          string,
          unknown
        >
      ).producerDecision,
    );

    const firstPublicationLease = {
      leaseId: reservedPublisher.leaseId,
      leaseRevision: reservedPublisher.leaseRevision,
    };
    reservedPublisher.dispatchedAt = Date.now() - 16 * 60_000;
    reservedPublisher.leaseExpiresAt = Date.now() + 7 * 24 * 60 * 60_000;
    await storage.put("exact-review-queue", afterExpiry);

    let queueMaintenance: Promise<unknown> | undefined;
    await worker.scheduled(
      {},
      { EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue) },
      { waitUntil: (promise) => (queueMaintenance = promise) },
    );
    await queueMaintenance;
    const afterScheduledMaintenance = (await storage.get("exact-review-queue")) as typeof state;
    const scheduledPublisher = afterScheduledMaintenance.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(scheduledPublisher.state, "pending");
    assert.equal(scheduledPublisher.leaseId, undefined);
    assert.ok(((await storage.getAlarm()) ?? Number.POSITIVE_INFINITY) <= Date.now() + 1_000);

    await queue.alarm();
    const afterScheduledRedispatch = (await storage.get("exact-review-queue")) as typeof state;
    const scheduledRedispatch = afterScheduledRedispatch.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(scheduledRedispatch.state, "dispatching");
    assert.notEqual(scheduledRedispatch.leaseId, firstPublicationLease.leaseId);
    assert.equal(
      dispatched.filter(
        (payload) =>
          (payload.client_payload as Record<string, unknown>).source_action ===
          "exact_review_artifact_publish",
      ).length,
      2,
    );

    const scheduledPublicationLease = {
      leaseId: scheduledRedispatch.leaseId,
      leaseRevision: scheduledRedispatch.leaseRevision,
    };
    scheduledRedispatch.dispatchedAt = Date.now() - 16 * 60_000;
    scheduledRedispatch.leaseExpiresAt = Date.now() + 7 * 24 * 60 * 60_000;
    await storage.put("exact-review-queue", afterScheduledRedispatch);

    const expiredLegacyClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: scheduledPublicationLease.leaseId,
          item_key: "openclaw/gogcli#801@publish:100:1",
          lease_revision: scheduledPublicationLease.leaseRevision,
          run_id: "999998",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(expiredLegacyClaim.status, 409);
    assert.deepEqual(await expiredLegacyClaim.json(), { error: "lease_not_active" });
    const afterExpiredClaim = (await storage.get("exact-review-queue")) as typeof state;
    const reclaimedPublisher = afterExpiredClaim.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(reclaimedPublisher.state, "pending");
    assert.equal(reclaimedPublisher.leaseId, undefined);
    assert.ok(((await storage.getAlarm()) ?? Number.POSITIVE_INFINITY) <= Date.now() + 1_000);

    await queue.alarm();

    const publicationDispatches = dispatched.filter(
      (payload) =>
        (payload.client_payload as Record<string, unknown>).source_action ===
        "exact_review_artifact_publish",
    );
    assert.equal(publicationDispatches.length, 3);
    const afterRedispatch = (await storage.get("exact-review-queue")) as typeof state;
    const redispatchedPublisher = afterRedispatch.items["openclaw/gogcli#801@publish:100:1"];
    assert.equal(redispatchedPublisher.state, "dispatching");
    assert.notEqual(redispatchedPublisher.leaseId, scheduledPublicationLease.leaseId);
    assert.ok((redispatchedPublisher.leaseExpiresAt ?? 0) - Date.now() > 14 * 60_000);
    const staleClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: firstPublicationLease.leaseId,
          item_key: "openclaw/gogcli#801@publish:100:1",
          lease_revision: firstPublicationLease.leaseRevision,
          run_id: "999999",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(staleClaim.status, 409);
    assert.deepEqual(await staleClaim.json(), { error: "lease_not_active" });
    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.review.enqueued_total, 4);
    assert.equal(stats.lanes.publication.enqueued_total, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue wakes while target capacity remains", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "2",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-801", 801, "opened"));
    await queue.alarm();
    await queue.fetch(buildExactReviewQueueRequest("delivery-802", 802, "opened"));

    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm <= Date.now() + 5_000);

    await queue.alarm();
    assert.equal(dispatched.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue defers retained backlog until a paused dispatcher retry", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const dispatched: Record<string, unknown>[] = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatched.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
        EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "4",
        EXACT_REVIEW_TARGET_MAX_CONCURRENT: "2",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-a", 801, "opened"));
    await queue.alarm();
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-b", 802, "opened"));
    await queue.fetch(buildExactReviewQueueRequest("delivery-paused-c", 803, "opened"));

    const state = (await storage.get("exact-review-queue")) as {
      dispatcher?: Record<string, unknown>;
      items: Record<
        string,
        { leaseExpiresAt?: number; nextAttemptAt: number; state: string; backoffReason?: string }
      >;
    };
    const leaseExpiresAt = Date.now() + 60_000;
    const retryAt = Date.now() + 15 * 60_000;
    const retainedAttemptAt = Date.now() - 1;
    state.dispatcher = {
      state: "paused",
      reason: "workflow_not_active",
      checkedAt: Date.now(),
      retryAt,
    };
    state.items["openclaw/gogcli#801"].leaseExpiresAt = leaseExpiresAt;
    state.items["openclaw/gogcli#802"].nextAttemptAt = retryAt;
    state.items["openclaw/gogcli#802"].backoffReason = "dispatcher_backoff";
    state.items["openclaw/gogcli#803"].nextAttemptAt = retainedAttemptAt;
    await storage.put("exact-review-queue", state);
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));

    const nextAlarm = await storage.getAlarm();
    assert.ok(nextAlarm && nextAlarm <= leaseExpiresAt);

    // Emulate a pre-pause alarm that remains scheduled for an active lease,
    // then fires before the paused dispatcher's retry deadline.
    state.items["openclaw/gogcli#801"].leaseExpiresAt = Date.now() - 1;
    await storage.put("exact-review-queue", state);
    await queue.alarm();
    assert.equal(dispatched.length, 1);
    const after = (await storage.get("exact-review-queue")) as typeof state;
    assert.equal(after.items["openclaw/gogcli#802"].nextAttemptAt, retryAt);
    assert.equal(after.items["openclaw/gogcli#802"].backoffReason, "dispatcher_backoff");
    assert.equal(after.items["openclaw/gogcli#803"].nextAttemptAt, retainedAttemptAt);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("canonical tuple publication updates Worker authority without a git projection row", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const item =
    "---\nrepo: openclaw/openclaw\nnumber: 42\nreviewed_at: 2026-07-26T02:00:00.000Z\n---\n\nreview\n";
  const mutation = {
    deliveryId: "record-tuple:run-1:42",
    key: "openclaw-openclaw/42",
    operations: [
      {
        path: "records/openclaw-openclaw/items/42.md",
        expectedDigest: null,
        contentBase64: Buffer.from(item).toString("base64"),
      },
      { path: "records/openclaw-openclaw/closed/42.md", expectedDigest: null },
      { path: "records/openclaw-openclaw/plans/42.md", expectedDigest: null },
      { path: "records/openclaw-openclaw/decision-packets/42.json", expectedDigest: null },
    ],
  };

  const first = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    ok: true,
    accepted: true,
    deduped: false,
    revision: 1,
  });
  const duplicate = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).deduped, true);

  const canonical = await (
    await queue.fetch(
      new Request("https://queue/records/openclaw-openclaw/items/42", { method: "GET" }),
    )
  ).json();
  assert.equal(canonical.content, item);
  assert.equal(canonical.digest, createHash("sha256").update(item).digest("hex"));
  assert.equal(canonical.revision, 1);

  const reconciledItem = item.replace(
    "reviewed_at: 2026-07-26T02:00:00.000Z",
    "reviewed_at: 2026-07-26T02:00:00.000Z\nreconciled_at: 2026-07-27T02:00:00.000Z",
  );
  const reconciliation = structuredClone(mutation);
  reconciliation.deliveryId = "record-reconcile:openclaw-openclaw:42:authority-fix";
  reconciliation.operations[0]!.expectedDigest = createHash("sha256").update(item).digest("hex");
  reconciliation.operations[0]!.contentBase64 = Buffer.from(reconciledItem).toString("base64");
  const reconciled = await queue.fetch(stateAppendQueueRequest("/records/tuples", reconciliation));
  assert.equal(reconciled.status, 202);
  assert.equal((await reconciled.json()).revision, 2);

  const conflict = structuredClone(mutation);
  conflict.deliveryId = "record-tuple:run-2:42";
  conflict.operations[0]!.expectedDigest = "0".repeat(64);
  const rejected = await queue.fetch(stateAppendQueueRequest("/records/tuples", conflict));
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {
    error: "canonical_record_tuple_conflict",
    current: {
      key: "openclaw-openclaw/42",
      revision: 2,
      deliveryId: reconciliation.deliveryId,
      operations: [
        {
          path: "records/openclaw-openclaw/items/42.md",
          expectedDigest: createHash("sha256").update(reconciledItem).digest("hex"),
          contentBase64: Buffer.from(reconciledItem).toString("base64"),
        },
        { path: "records/openclaw-openclaw/closed/42.md", expectedDigest: null },
        { path: "records/openclaw-openclaw/plans/42.md", expectedDigest: null },
        {
          path: "records/openclaw-openclaw/decision-packets/42.json",
          expectedDigest: null,
        },
      ],
    },
  });
});

test("fallback tuple publication normalizes mixed-case keys onto existing lowercase storage", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const item =
    "---\nrepo: steipete/CodexBar\nnumber: 2831\nreviewed_at: 2026-08-10T08:00:00.000Z\n---\n\nreview\n";
  const mutation = {
    deliveryId: "record-tuple:mixed-case:2831",
    key: "steipete-CodexBar/2831",
    operations: [
      {
        path: "records/steipete-codexbar/items/2831.md",
        expectedDigest: null,
        contentBase64: Buffer.from(item).toString("base64"),
      },
      { path: "records/steipete-codexbar/closed/2831.md", expectedDigest: null },
      { path: "records/steipete-codexbar/plans/2831.md", expectedDigest: null },
      {
        path: "records/steipete-codexbar/decision-packets/2831.json",
        expectedDigest: null,
      },
    ],
  };

  const accepted = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    accepted: true,
    deduped: false,
    revision: 1,
  });

  const normalizedRetry = structuredClone(mutation);
  normalizedRetry.key = "steipete-codexbar/2831";
  const deduped = await queue.fetch(stateAppendQueueRequest("/records/tuples", normalizedRetry));
  assert.equal(deduped.status, 202);
  assert.deepEqual(await deduped.json(), {
    ok: true,
    accepted: false,
    deduped: true,
    revision: 1,
  });

  const canonical = await (
    await queue.fetch(
      new Request("https://queue/records/steipete-codexbar/items/2831", { method: "GET" }),
    )
  ).json();
  assert.equal(canonical.content, item);
  assert.equal(canonical.revision, 1);

  const parallelNamespace = await queue.fetch(
    new Request("https://queue/records/steipete-CodexBar/items/2831", { method: "GET" }),
  );
  assert.equal(parallelNamespace.status, 404);

  const uppercasePaths = structuredClone(mutation);
  uppercasePaths.deliveryId = "record-tuple:mixed-case:2831:uppercase-path";
  uppercasePaths.operations = uppercasePaths.operations.map((operation) => ({
    ...operation,
    path: operation.path.replace("steipete-codexbar", "steipete-CodexBar"),
  }));
  const casingStorage = new MemoryDurableStorage();
  const casingQueue = new ExactReviewQueue({ storage: casingStorage }, {});
  const uppercaseAccepted = await casingQueue.fetch(
    stateAppendQueueRequest("/records/tuples", uppercasePaths),
  );
  assert.equal(uppercaseAccepted.status, 202);
  assert.equal((await uppercaseAccepted.json()).accepted, true);

  const lowercasePathRetry = structuredClone(uppercasePaths);
  lowercasePathRetry.operations = lowercasePathRetry.operations.map((operation) => ({
    ...operation,
    path: operation.path.replace("steipete-CodexBar", "steipete-codexbar"),
  }));
  const casingDeduped = await casingQueue.fetch(
    stateAppendQueueRequest("/records/tuples", lowercasePathRetry),
  );
  assert.equal(casingDeduped.status, 202);
  assert.deepEqual(await casingDeduped.json(), {
    ok: true,
    accepted: false,
    deduped: true,
    revision: 1,
  });

  const lowercaseCanonical = await casingQueue.fetch(
    new Request("https://queue/records/steipete-codexbar/items/2831", { method: "GET" }),
  );
  assert.equal(lowercaseCanonical.status, 200);
  assert.equal((await lowercaseCanonical.json()).content, item);
  assert.equal(
    (
      await casingQueue.fetch(
        new Request("https://queue/records/steipete-CodexBar/items/2831", { method: "GET" }),
      )
    ).status,
    404,
  );
  const [uppercaseNamespaceRows] = Array.from(
    casingStorage.sql.exec(
      `SELECT
         (SELECT COUNT(*) FROM exact_review_canonical_records
           WHERE repo_slug = 'steipete-CodexBar') AS canonical_count,
         (SELECT COUNT(*) FROM exact_review_record_export_index
           WHERE repo_slug = 'steipete-CodexBar') AS export_count`,
    ),
  );
  assert.equal(uppercaseNamespaceRows?.canonical_count, 0);
  assert.equal(uppercaseNamespaceRows?.export_count, 0);

  const differentRepository = structuredClone(mutation);
  differentRepository.deliveryId = "record-tuple:mixed-case:2831:different-repository";
  differentRepository.operations = differentRepository.operations.map((operation) => ({
    ...operation,
    path: operation.path.replace("steipete-codexbar", "steipete-other"),
  }));
  const rejected = await casingQueue.fetch(
    stateAppendQueueRequest("/records/tuples", differentRepository),
  );
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invalid_canonical_record_tuple" });
});

test("review coverage summarizes canonical item records per fleet", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const now = Date.now();
  const itemRecord = (repo: string | null, number: number, frontMatter: string) =>
    `---\n${repo ? `repo: ${repo}\n` : ""}number: ${number}\n${frontMatter}---\n\nreview body\n`;
  const publish = async (slug: string, number: number, content: string) => {
    const response = await queue.fetch(
      stateAppendQueueRequest("/records/tuples", {
        deliveryId: `record-tuple:coverage:${slug}:${number}`,
        key: `${slug}/${number}`,
        operations: [
          {
            path: `records/${slug}/items/${number}.md`,
            expectedDigest: null,
            contentBase64: Buffer.from(content).toString("base64"),
          },
          { path: `records/${slug}/closed/${number}.md`, expectedDigest: null },
          { path: `records/${slug}/plans/${number}.md`, expectedDigest: null },
          { path: `records/${slug}/decision-packets/${number}.json`, expectedDigest: null },
        ],
      }),
    );
    assert.equal(response.status, 202);
  };
  const fresh = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const outdated = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
  await publish(
    "openclaw-openclaw",
    1,
    itemRecord("openclaw/openclaw", 1, `reviewed_at: ${fresh}\nreview_status: complete\n`),
  );
  await publish(
    "openclaw-openclaw",
    2,
    itemRecord("openclaw/openclaw", 2, `reviewed_at: ${outdated}\nreview_status: complete\n`),
  );
  await publish(
    "openclaw-openclaw",
    3,
    itemRecord("openclaw/openclaw", 3, `reviewed_at: ${outdated}\nreview_status: stale_reopened\n`),
  );
  await publish(
    "openclaw-openclaw",
    4,
    itemRecord("openclaw/openclaw", 4, `reviewed_at: ${fresh}\nreview_status: failed\n`),
  );
  await publish(
    "openclaw-openclaw",
    5,
    itemRecord(
      "openclaw/openclaw",
      5,
      `labels: ["security"]\nreviewed_at: ${fresh}\nreview_status: complete\n`,
    ),
  );
  await publish(
    "other-repo",
    9,
    itemRecord(null, 9, `reviewed_at: "${fresh}"\nreview_status: "complete"\n`),
  );
  await publish(
    "unmanaged-repo",
    10,
    itemRecord(null, 10, `reviewed_at: "${fresh}"\nreview_status: "complete"\n`),
  );
  const inventory = await queue.fetch(
    new Request("https://queue/review-coverage/inventory", {
      method: "POST",
      body: JSON.stringify({
        generated_at: new Date(now).toISOString(),
        repositories: [
          {
            repo: "openclaw/openclaw",
            repo_slug: "openclaw-openclaw",
            open_issues: 5,
            open_pull_requests: 2,
          },
          {
            repo: "other/repo",
            repo_slug: "other-repo",
            open_issues: 1,
            open_pull_requests: 1,
          },
        ],
      }),
    }),
  );
  assert.equal(inventory.status, 202);

  const response = await queue.fetch(new Request("https://queue/review-coverage"));
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    ok: boolean;
    window_days: number;
    generated_at: string;
    fleets: Array<Record<string, unknown>>;
    totals: Record<string, unknown>;
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.window_days, 7);
  assert.equal(payload.inventory_status, "current");
  assert.equal(payload.fleets.length, 3);
  const [openclaw, other, unmanaged] = payload.fleets;
  assert.equal(openclaw.repo, "openclaw/openclaw");
  assert.equal(openclaw.repo_slug, "openclaw-openclaw");
  assert.equal(openclaw.open_records, 7);
  assert.equal(openclaw.reviewable_records, 6);
  assert.equal(openclaw.tracked_records, 5);
  assert.equal(openclaw.reviewed_recent, 1);
  assert.equal(openclaw.stale, 1);
  assert.equal(openclaw.failed, 1);
  assert.equal(openclaw.expired, 1);
  assert.equal(openclaw.untracked_open, 2);
  assert.equal(openclaw.pending, 3);
  assert.equal(openclaw.excluded, 1);
  assert.equal(openclaw.coverage_percent, 16.7);
  assert.equal(openclaw.oldest_reviewed_at, new Date(Date.parse(outdated)).toISOString());
  assert.equal(other.repo, "other/repo");
  assert.equal(other.open_records, 2);
  assert.equal(other.reviewed_recent, 1);
  assert.equal(other.untracked_open, 1);
  assert.equal(other.coverage_percent, 50);
  assert.equal(unmanaged.schedulable, false);
  assert.equal(unmanaged.tracked_records, 1);
  assert.equal(unmanaged.unschedulable_records, 1);
  assert.deepEqual(payload.totals, {
    open_records: 9,
    reviewable_records: 8,
    tracked_records: 6,
    reviewed_recent: 2,
    stale: 1,
    failed: 1,
    expired: 1,
    unreviewed_records: 0,
    untracked_open: 3,
    pending: 4,
    excluded: 1,
    unschedulable_records: 1,
    record_drift: 0,
    coverage_percent: 25,
  });

  // Deleting the record tombstones it out of the open universe.
  await queue.fetch(
    stateAppendQueueRequest("/records/tuples", {
      deliveryId: "record-tuple:coverage:other-repo:9:close",
      key: "other-repo/9",
      operations: [
        {
          path: "records/other-repo/items/9.md",
          expectedDigest: createHash("sha256")
            .update(itemRecord(null, 9, `reviewed_at: "${fresh}"\nreview_status: "complete"\n`))
            .digest("hex"),
        },
        { path: "records/other-repo/closed/9.md", expectedDigest: null },
        { path: "records/other-repo/plans/9.md", expectedDigest: null },
        { path: "records/other-repo/decision-packets/9.json", expectedDigest: null },
      ],
    }),
  );
  const cached = (await (
    await queue.fetch(new Request("https://queue/review-coverage"))
  ).json()) as {
    generated_at: string;
    totals: Record<string, unknown>;
  };
  // Responses are cached for up to a minute; the tombstone appears on refresh.
  assert.equal(cached.generated_at, payload.generated_at);
  assert.equal(cached.totals.open_records, 9);
  assert.equal(cached.totals.tracked_records, 6);
});

test("worker exposes review coverage through the public API route", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const secret = "coverage-secret";
  const env = {
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
  };
  const inventoryBody = JSON.stringify({
    generated_at: new Date().toISOString(),
    repositories: [
      {
        repo: "openclaw/openclaw",
        repo_slug: "openclaw-openclaw",
        open_issues: 1,
        open_pull_requests: 0,
      },
    ],
  });
  const inventorySignature = `sha256=${createHmac("sha256", secret).update(inventoryBody).digest("hex")}`;
  const inventoryResponse = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/review-coverage/inventory", {
      method: "POST",
      headers: { "x-clawsweeper-exact-review-signature": inventorySignature },
      body: inventoryBody,
    }),
    env,
  );
  assert.equal(inventoryResponse.status, 202);
  const publicQueryMarker = ["synthetic", "coverage", "filter"].join("_");
  const response = await worker.fetch(
    new Request(`https://clawsweeper.openclaw.ai/api/review-coverage?repo=${publicQueryMarker}`),
    env,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    ok: boolean;
    totals: { open_records: number };
    fleets?: unknown[];
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.totals.open_records, 1);
  assert.equal(Object.hasOwn(payload, "fleets"), false);
  assert.equal(JSON.stringify(payload).includes(publicQueryMarker), false);

  const unconfigured = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/review-coverage"),
    {},
  );
  assert.equal(unconfigured.status, 503);
});

test("apply preselect and checkpoint publish captured canonical tuple baselines", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-apply-preselect-source-"));
  const sparseStateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-apply-preselect-state-"),
  );
  const canonicalBaselineRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-apply-preselect-baseline-"),
  );
  const itemId = 100078;
  const tupleRoot = "records/openclaw-openclaw";
  const itemPath = `${tupleRoot}/items/${itemId}.md`;
  const closedPath = `${tupleRoot}/closed/${itemId}.md`;
  const planPath = `${tupleRoot}/plans/${itemId}.md`;
  const packetPath = `${tupleRoot}/decision-packets/${itemId}.json`;
  const packet = (state: "open" | "closed", reportPath: string, number = itemId) =>
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: "2026-07-27T18:00:00.000Z",
        updatedAt: "2026-07-27T17:00:00.000Z",
        subject: { repo: "openclaw/openclaw", kind: "issue", number, state },
        source: { reportPath, reviewedAt: "2026-07-27T18:00:00.000Z" },
      },
      null,
      2,
    )}\n`;
  const primary = (
    state: "open" | "closed",
    packetContent: string,
    reconciledAt: string,
    number = itemId,
  ) =>
    [
      "---",
      `decision_packet_sha256: ${createHash("sha256").update(packetContent).digest("hex")}`,
      `decision_packet_path: ${tupleRoot}/decision-packets/${number}.json`,
      `number: ${number}`,
      "repository: openclaw/openclaw",
      `current_state: ${state}`,
      "reviewed_at: 2026-07-27T18:00:00.000Z",
      `reconciled_at: ${reconciledAt}`,
      "---",
      "",
      "production-shaped canonical record",
      "",
    ].join("\n");

  const openPacket = packet("open", itemPath);
  const openPrimary = primary("open", openPacket, "2026-07-27T19:00:00.000Z");
  const seeded = await queue.fetch(
    stateAppendQueueRequest("/records/tuples", {
      deliveryId: `record-reconcile:openclaw-openclaw:${itemId}:corrective-tuple`,
      key: `openclaw-openclaw/${itemId}`,
      operations: [
        {
          path: itemPath,
          expectedDigest: null,
          contentBase64: Buffer.from(openPrimary).toString("base64"),
        },
        { path: closedPath, expectedDigest: null },
        { path: planPath, expectedDigest: null },
        {
          path: packetPath,
          expectedDigest: null,
          contentBase64: Buffer.from(openPacket).toString("base64"),
        },
      ],
    }),
  );
  assert.equal(seeded.status, 202, await seeded.text());

  const write = (base: string, relativePath: string, content: string) => {
    const destination = path.join(base, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, "utf8");
  };
  // Worker hydration writes canonical records to the lane worktree. The state
  // checkout is sparse and intentionally has no records/ baseline.
  write(root, itemPath, openPrimary);
  write(root, packetPath, openPacket);
  captureCanonicalRecordBaseline({
    baselineRoot: canonicalBaselineRoot,
    repositorySlug: "openclaw-openclaw",
    itemNumber: itemId,
    sources: [
      { section: "items", name: `${itemId}.md`, path: path.join(root, itemPath) },
      { section: "closed", name: `${itemId}.md`, path: path.join(root, closedPath) },
      { section: "plans", name: `${itemId}.md`, path: path.join(root, planPath) },
      {
        section: "decision-packets",
        name: `${itemId}.json`,
        path: path.join(root, packetPath),
      },
    ],
  });

  const closedPacket = packet("closed", closedPath);
  const closedPrimary = primary("closed", closedPacket, "2026-07-28T04:33:00.000Z");
  fs.unlinkSync(path.join(root, itemPath));
  write(root, closedPath, closedPrimary);
  write(root, packetPath, closedPacket);

  const laneResponses: Array<{ status: number; body: Record<string, unknown> }> = [];
  await publishMainWithStateAppend(
    {
      message: "chore: persist sweep reconciliation",
      paths: [itemPath, closedPath, planPath, packetPath],
      rebaseStrategy: "normal",
    },
    {
      root,
      env: {
        CLAWSWEEPER_STATE_DIR: sparseStateRoot,
        CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: canonicalBaselineRoot,
        CLAWSWEEPER_CANONICAL_PUBLICATION_KIND: "reconcile",
        QUEUE_URL: "https://queue.test",
        CLAWSWEEPER_WEBHOOK_SECRET: "apply-preselect-test-secret",
      },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const mutation = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const response = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
        const body = (await response.json()) as Record<string, unknown>;
        laneResponses.push({ status: response.status, body });
        return Response.json(body, { status: response.status });
      }) as typeof fetch,
      publishGit: () => {
        throw new Error("canonical reconciliation must not use Git publication");
      },
    },
  );

  assert.equal(laneResponses[0]?.status, 202);
  const closed = await queue.fetch(
    new Request(`https://queue/records/openclaw-openclaw/closed/${itemId}`, { method: "GET" }),
  );
  assert.equal(
    closed.status,
    200,
    "the legitimate items-to-closed move must reach canonical state",
  );
  assert.equal((await closed.json()).content, closedPrimary);

  // The checkpoint lane mutates a hydrated record after preselect. Its state
  // checkout still has no records/, and the broad records path must be scoped
  // to the tuple captured immediately before this mutation.
  const applyItemId = itemId + 1;
  const applyItemPath = `${tupleRoot}/items/${applyItemId}.md`;
  const applyClosedPath = `${tupleRoot}/closed/${applyItemId}.md`;
  const applyPlanPath = `${tupleRoot}/plans/${applyItemId}.md`;
  const applyPacketPath = `${tupleRoot}/decision-packets/${applyItemId}.json`;
  const applyPacket = packet("open", applyItemPath, applyItemId);
  const applyBefore = primary("open", applyPacket, "2026-07-28T04:34:00.000Z", applyItemId);
  const applySeed = await queue.fetch(
    stateAppendQueueRequest("/records/tuples", {
      deliveryId: `record-reconcile:openclaw-openclaw:${applyItemId}:seed`,
      key: `openclaw-openclaw/${applyItemId}`,
      operations: [
        {
          path: applyItemPath,
          expectedDigest: null,
          contentBase64: Buffer.from(applyBefore).toString("base64"),
        },
        { path: applyClosedPath, expectedDigest: null },
        { path: applyPlanPath, expectedDigest: null },
        {
          path: applyPacketPath,
          expectedDigest: null,
          contentBase64: Buffer.from(applyPacket).toString("base64"),
        },
      ],
    }),
  );
  assert.equal(applySeed.status, 202, await applySeed.text());
  write(root, applyItemPath, applyBefore);
  write(root, applyPacketPath, applyPacket);

  const applyBaselineRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "clawsweeper-apply-checkpoint-baseline-"),
  );
  captureCanonicalRecordBaseline({
    baselineRoot: applyBaselineRoot,
    repositorySlug: "openclaw-openclaw",
    itemNumber: applyItemId,
    sources: [
      { section: "items", name: `${applyItemId}.md`, path: path.join(root, applyItemPath) },
      {
        section: "closed",
        name: `${applyItemId}.md`,
        path: path.join(root, applyClosedPath),
      },
      { section: "plans", name: `${applyItemId}.md`, path: path.join(root, applyPlanPath) },
      {
        section: "decision-packets",
        name: `${applyItemId}.json`,
        path: path.join(root, applyPacketPath),
      },
    ],
  });
  const applyAfter = applyBefore.replace(
    "reconciled_at: 2026-07-28T04:34:00.000Z",
    "reconciled_at: 2026-07-28T04:34:00.000Z\napply_checked_at: 2026-07-28T05:24:00.000Z",
  );
  write(root, applyItemPath, applyAfter);

  const unrelatedItemId = applyItemId + 1;
  const unrelatedItemPath = `${tupleRoot}/items/${unrelatedItemId}.md`;
  const unrelatedPacketPath = `${tupleRoot}/decision-packets/${unrelatedItemId}.json`;
  const unrelatedPacket = packet("open", unrelatedItemPath, unrelatedItemId);
  write(
    root,
    unrelatedItemPath,
    primary("open", unrelatedPacket, "2026-07-28T04:35:00.000Z", unrelatedItemId),
  );
  write(root, unrelatedPacketPath, unrelatedPacket);

  const applyMutations: Array<Record<string, unknown>> = [];
  await publishMainWithStateAppend(
    {
      message: "chore: apply sweep decisions checkpoint 1",
      paths: [tupleRoot],
      rebaseStrategy: "normal",
    },
    {
      root,
      env: {
        CLAWSWEEPER_STATE_DIR: sparseStateRoot,
        CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR: applyBaselineRoot,
        QUEUE_URL: "https://queue.test",
        CLAWSWEEPER_WEBHOOK_SECRET: "apply-checkpoint-test-secret",
      },
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
        const mutation = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        applyMutations.push(mutation);
        const response = await queue.fetch(stateAppendQueueRequest("/records/tuples", mutation));
        return Response.json(await response.json(), { status: response.status });
      }) as typeof fetch,
      publishGit: () => {
        throw new Error("canonical apply checkpoint must not use Git publication");
      },
    },
  );

  assert.equal(applyMutations.length, 1);
  assert.equal(applyMutations[0]?.key, `openclaw-openclaw/${applyItemId}`);
  const applied = await queue.fetch(
    new Request(`https://queue/records/openclaw-openclaw/items/${applyItemId}`, { method: "GET" }),
  );
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).content, applyAfter);
});

test("canonical tuple failures return stable errors and sanitize server logs", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const marker =
    "synthetic-record-title at https://privacy.invalid/private-path?query=canonical-marker";
  storage.failNextSql(
    /INSERT INTO exact_review_canonical_records/,
    new Error(`database unavailable for ${marker}`),
  );
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
  try {
    const response = await queue.fetch(
      stateAppendQueueRequest("/records/tuples", {
        deliveryId: "record-tuple:failure:42",
        key: "openclaw-openclaw/42",
        operations: [
          {
            path: "records/openclaw-openclaw/items/42.md",
            expectedDigest: null,
            contentBase64: Buffer.from("record\n").toString("base64"),
          },
          { path: "records/openclaw-openclaw/closed/42.md", expectedDigest: null },
          { path: "records/openclaw-openclaw/plans/42.md", expectedDigest: null },
          { path: "records/openclaw-openclaw/decision-packets/42.json", expectedDigest: null },
        ],
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_canonical_record_tuple" });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ["canonical_record_tuple_rejected"]);
  assert.doesNotMatch(
    warnings.join("\n"),
    /synthetic-record-title|privacy\.invalid|private-path|canonical-marker/,
  );
});

test("publication plan, lifecycle, and snapshot failures log only fixed events", async () => {
  const planMarker =
    "synthetic-plan-title-at-https://privacy.invalid/private-plan?query=plan-marker";
  const lifecycleMarker =
    "synthetic-lifecycle-title-at-https://privacy.invalid/private-lifecycle?query=lifecycle-marker";
  const snapshotMarker =
    "synthetic-snapshot-title-at-https://privacy.invalid/private-snapshot?query=snapshot-marker";
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...values: unknown[]) => warnings.push(values);
  console.error = (...values: unknown[]) => errors.push(values);
  try {
    const canonicalTargetKey = "privacy-sentinel/private-item#440001";
    const publicationQueue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
    const publication = await publicationQueue.fetch(
      new Request("https://clawsweeper-exact-review-queue/publication-results", {
        method: "POST",
        body: JSON.stringify({
          canonicalTargetKey,
          fenceKey: canonicalTargetKey,
          revision: 1,
          identity: {
            canonicalTargetKey,
            fenceKey: canonicalTargetKey,
            revision: 1,
            claimGeneration: 1,
          },
          operations: [
            {
              path: planMarker,
              mode: "100644",
              bytes: 0,
              contentBase64: "",
            },
          ],
        }),
      }),
    );
    assert.equal(publication.status, 400);
    assert.equal((await publication.json()).error, "invalid_direct_publication_plan");

    const lifecycleStorage = new MemoryDurableStorage();
    const lifecycleBody = {
      canonical_target_key: "privacy-sentinel/lifecycle-item#440002",
      fence_key: lifecycleMarker,
      revision: 1,
      receipt_id: lifecycleMarker,
    };
    new ExactReviewLifecycleProjectionStore(lifecycleStorage).recordAdmission({
      canonicalTargetKey: lifecycleBody.canonical_target_key,
      fenceKey: lifecycleBody.fence_key,
      revision: lifecycleBody.revision,
      deliveryId: lifecycleMarker,
      sourceAction: "synthetic_lifecycle_test",
      commandOriginated: false,
      statusMarker: null,
      statusCommentId: null,
      observedAt: Date.now(),
    });
    lifecycleStorage.failNextSql(
      /INSERT INTO exact_review_lifecycle_projection_v1/,
      new Error(lifecycleMarker),
    );
    const lifecycleQueue = new ExactReviewQueue({ storage: lifecycleStorage }, {});
    const conflicting = await lifecycleQueue.fetch(
      new Request("https://clawsweeper-exact-review-queue/lifecycle/canonical-receipt", {
        method: "POST",
        body: JSON.stringify({ ...lifecycleBody, outcome: "accepted" }),
      }),
    );
    assert.equal(conflicting.status, 409);
    assert.deepEqual(await conflicting.json(), {
      error: "invalid_lifecycle_canonical_receipt",
    });

    const snapshotBucket = {
      createMultipartUpload: async (_key: string) => {
        throw new Error(snapshotMarker);
      },
      head: async (_key: string) => null,
      get: async (_key: string) => null,
      delete: async (_keys: string | string[]) => undefined,
    };
    const snapshotQueue = new ExactReviewQueue(
      { storage: new MemoryDurableStorage() },
      { STATE_SNAPSHOTS: snapshotBucket },
    );
    const snapshot = await snapshotQueue.fetch(
      new Request("https://clawsweeper-exact-review-queue/records/snapshots/trigger", {
        method: "POST",
        body: JSON.stringify({ repoSlug: "privacy-sentinel" }),
      }),
    );
    assert.equal(snapshot.status, 503);
    assert.deepEqual(await snapshot.json(), {
      error: "snapshot_store_unavailable",
      snapshotStoreAvailable: false,
      detail: "STATE_SNAPSHOTS is not available",
    });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.deepEqual(warnings, [
    ["direct_publication_plan_rejected"],
    ["lifecycle_canonical_receipt_rejected"],
  ]);
  assert.deepEqual(errors, [["snapshot_store_unavailable"]]);
  assertConsoleCallsExclude(
    [...warnings, ...errors],
    [
      planMarker,
      lifecycleMarker,
      snapshotMarker,
      "privacy.invalid",
      "private-plan",
      "private-lifecycle",
      "private-snapshot",
      "plan-marker",
      "lifecycle-marker",
      "snapshot-marker",
    ],
  );
});

test("canonical tuple publication accepts explicit absent sidecars and closed records", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const packet = '{"version":1}\n';
  const packetDigest = createHash("sha256").update(packet).digest("hex");
  const cases = [
    {
      itemId: 51,
      primarySection: "items",
      primary: [
        "---",
        `decision_packet_sha256: ${packetDigest}`,
        "decision_packet_path: records/openclaw-openclaw/decision-packets/51.json",
        "---",
        "open item without a plan",
        "",
      ].join("\n"),
      plan: null,
      packet,
    },
    {
      itemId: 52,
      primarySection: "items",
      primary:
        "---\ndecision_packet_sha256: none\ndecision_packet_path: none\n---\nopen item without a packet\n",
      plan: "---\nreviewed_at: 2026-07-26T01:00:00Z\n---\nwork plan\n",
      packet: null,
    },
    {
      itemId: 53,
      primarySection: "closed",
      primary: "---\ndecision_packet_sha256: none\ndecision_packet_path: none\n---\nclosed item\n",
      plan: null,
      packet: null,
    },
  ] as const;

  for (const fixture of cases) {
    const content = new Map<string, string | null>([
      ["items", fixture.primarySection === "items" ? fixture.primary : null],
      ["closed", fixture.primarySection === "closed" ? fixture.primary : null],
      ["plans", fixture.plan],
      ["decision-packets", fixture.packet],
    ]);
    const operations = [...content].map(([section, value]) => ({
      path: `records/openclaw-openclaw/${section}/${fixture.itemId}.${section === "decision-packets" ? "json" : "md"}`,
      expectedDigest: null,
      ...(value === null ? {} : { contentBase64: Buffer.from(value).toString("base64") }),
    }));
    const response = await queue.fetch(
      stateAppendQueueRequest("/records/tuples", {
        deliveryId: `record-tuple:partial:${fixture.itemId}`,
        key: `openclaw-openclaw/${fixture.itemId}`,
        operations,
      }),
    );
    assert.equal(response.status, 202, await response.text());
  }
});

test("internal state endpoints reject invalid HMAC signatures", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const payload = { deliveryId: "auth-check", key: "openclaw-openclaw/1", operations: [] };
  const unsigned = await worker.fetch(
    stateAppendQueueRequest(
      "/internal/state/records/tuples",
      payload,
      "https://clawsweeper.openclaw.ai",
    ),
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });

  // A correctly signed request passes authentication and fails only on its
  // payload shape, proving the signature gate is what rejected the call above.
  const signed = await worker.fetch(
    signedStateAppendRequest("/internal/state/records/tuples", payload, "test-secret"),
    env,
  );
  assert.equal(signed.status, 400);
});

test("internal state writer routes authenticate and preserve durable ticket identity", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: "test-clawsweeper-webhook-secret",
    EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
  };
  const acquire = {
    ticket_id: "state-writer:test-route",
    owner: "11111111-1111-4111-8111-111111111111",
    branch: "state",
    repository: "openclaw/clawsweeper-state",
    workflow: "State materializer",
    job: "materialize",
    run_id: "12345",
    run_attempt: 1,
    writer_class: "ordinary",
  };

  const unsigned = await worker.fetch(
    stateAppendQueueRequest(
      "/internal/state-writer/acquire",
      acquire,
      "https://clawsweeper.openclaw.ai",
    ),
    env,
  );
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { error: "invalid_signature" });

  const invalid = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      { ...acquire, ticket_id: "state-writer:invalid", workflow: "bad\u0000metadata" },
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_state_writer_ticket" });

  const acquiredResponse = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      acquire,
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(acquiredResponse.status, 200);
  const acquired = (await acquiredResponse.json()) as {
    ok: boolean;
    ticket: { ticketId: string; owner: string; leaseToken: string; state: string };
  };
  assert.equal(acquired.ok, true);
  assert.equal(acquired.ticket.ticketId, acquire.ticket_id);
  assert.equal(acquired.ticket.owner, acquire.owner);
  assert.equal(acquired.ticket.state, "leased");

  const legacyTicket = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/acquire",
      {
        ...acquire,
        ticket_id: "state-writer:legacy-route",
        owner: "22222222-2222-4222-8222-222222222222",
        writer_class: undefined,
      },
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(legacyTicket.status, 200, "rolling-deploy clients default to ordinary admission");

  const ownership = {
    ticket_id: acquired.ticket.ticketId,
    owner: acquired.ticket.owner,
    ["lease_token"]: acquired.ticket.leaseToken,
  };
  const heartbeat = await worker.fetch(
    signedStateAppendRequest(
      "/internal/state-writer/heartbeat",
      ownership,
      "test-clawsweeper-webhook-secret",
    ),
    env,
  );
  assert.equal(heartbeat.status, 200);
  assert.equal(((await heartbeat.json()) as { ticket: { state: string } }).ticket.state, "leased");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const release = await worker.fetch(
      signedStateAppendRequest(
        "/internal/state-writer/release",
        ownership,
        "test-clawsweeper-webhook-secret",
      ),
      env,
    );
    assert.equal(release.status, 200);
    assert.deepEqual(await release.json(), { ok: true, released: true });
  }
  const stats = (await (await queue.fetch(new Request("https://queue/stats"))).json()) as {
    state_writer: { coordinator: { completed: number; active: unknown } };
  };
  assert.equal(stats.state_writer.coordinator.completed, 1);
  assert.equal(stats.state_writer.coordinator.active, null);
});

test("authenticated legacy exact-review intake enters the durable queue", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const commandStatusMarker =
    "<!-- clawsweeper-command-status:597:re_review:0123456789abcdef0123456789abcdef01234567 -->";
  const payload = JSON.stringify({
    delivery_id: "legacy:100:1",
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 597,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: false,
      commandStatusMarker,
      statusCommentId: "9001",
      additionalPrompt: "Check the maintainer-requested regression path.",
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;

  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    ok: true,
    queued: true,
    item_key: "openclaw/gogcli#597",
    superseded_publications: 0,
  });
  const stored = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: Record<string, unknown> }>;
  };
  assert.deepEqual(
    {
      commandStatusMarker: stored.items["openclaw/gogcli#597"].decision.commandStatusMarker,
      statusCommentId: stored.items["openclaw/gogcli#597"].decision.statusCommentId,
      additionalPrompt: stored.items["openclaw/gogcli#597"].decision.additionalPrompt,
    },
    {
      commandStatusMarker,
      statusCommentId: 9001,
      additionalPrompt: "Check the maintainer-requested regression path.",
    },
  );

  const denied = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(denied.status, 401);
});

test("authenticated legacy pull request intake reserves source authority", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const payload = JSON.stringify({
    delivery_id: "legacy:edited:857:1",
    installation_id: 123,
    decision: {
      targetRepo: "openclaw/gogcli",
      targetBranch: "main",
      itemNumber: 857,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "edited",
      supersedesInProgress: true,
      sourceHeadSha: "a".repeat(40),
      sourceBaseSha: "b".repeat(40),
      sourceIsDraft: false,
      sourceContentRevision: "c".repeat(64),
      sourceUpdatedAt: "2026-07-26T09:00:00Z",
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;

  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/source-authority", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, source_authority_seq: 1 });
});

test("authenticated legacy intake durably reserves missing branch authority", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const payload = JSON.stringify({
    delivery_id: "legacy:branchless:858:1",
    installation_id: 123,
    decision: {
      targetRepo: "openclaw/gogcli",
      itemNumber: 858,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "legacy_dispatch",
      supersedesInProgress: false,
    },
  });
  const signature = `sha256=${createHmac("sha256", "test-secret").update(payload).digest("hex")}`;
  const accepted = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/internal/exact-review/branch-authority", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body: payload,
    }),
    {
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    },
  );
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true, branch_authority_pending: true });
  assert.equal(
    storage.rawHas("exact-review-branch-authority-reservation:v1:legacy%3Abranchless%3A858%3A1"),
    true,
  );
});

test("exact-review queue rejects unbounded or unsafe command context", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  const invalidDecisions = [
    {
      commandStatusMarker: "<!-- clawsweeper-command-status:597:re_review:na -->\nextra",
    },
    { statusCommentId: Number.MAX_SAFE_INTEGER + 1 },
    { additionalPrompt: "x".repeat(5001) },
    { additionalPrompt: "unsafe\0prompt" },
  ];

  for (const [index, decision] of invalidDecisions.entries()) {
    const response = await queue.fetch(
      buildExactReviewQueueRequest(
        `invalid-command-context-${index}`,
        597,
        "legacy_dispatch",
        "issue",
        undefined,
        decision,
      ),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_exact_review_item" });
  }

  const reservedDelivery = await queue.fetch(
    buildExactReviewQueueRequest("__clawsweeper_sql_generation:99", 597, "opened"),
  );
  assert.equal(reservedDelivery.status, 400);
  assert.deepEqual(await reservedDelivery.json(), { error: "reserved_delivery_id" });
});

test("exact-review queue retries dispatch failures and reclaims an unclaimed lease", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchAttempts = 0;
  let workflowStatusAvailable = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
      if (!workflowStatusAvailable) {
        return new Response(JSON.stringify({ message: "temporarily unavailable" }), {
          status: 503,
        });
      }
      return jsonResponse({ state: "active" });
    }
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchAttempts += 1;
      if (dispatchAttempts === 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
      }
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("delivery-1", 599, "opened"))).status,
      202,
    );

    await queue.alarm();
    let state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 1, dispatching: 0, leased: 0 },
    );
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "workflow_status_unavailable");
    assert.equal(dispatchAttempts, 0);

    const stored = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number }>;
    };
    workflowStatusAvailable = true;
    stored.dispatcher.retryAt = Date.now() - 1;
    stored.items["openclaw/gogcli#599"].nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", stored);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 1, dispatching: 0, leased: 0 },
    );
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "dispatch_rate_limit");
    assert.equal(state.dispatcher.dispatch_failure_status, 429);
    assert.equal(state.dispatcher.dispatch_failure_class, "rate_limit");
    assert.equal(dispatchAttempts, 1);

    const retried = (await storage.get("exact-review-queue")) as {
      dispatcher: { retryAt: number };
      items: Record<string, { nextAttemptAt: number; attempts: number }>;
    };
    assert.equal(retried.items["openclaw/gogcli#599"].attempts, 0);
    retried.dispatcher.retryAt = Date.now() - 1;
    retried.items["openclaw/gogcli#599"].nextAttemptAt = Date.now() - 1;
    await storage.put("exact-review-queue", retried);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 0, dispatching: 1, leased: 0 },
    );

    const leased = (await storage.get("exact-review-queue")) as {
      items: Record<string, { leaseExpiresAt: number; leaseId: string; leaseRevision: number }>;
    };
    const firstLease = leased.items["openclaw/gogcli#599"];
    assert.ok(firstLease.leaseExpiresAt - Date.now() > 350_000);
    assert.ok(firstLease.leaseExpiresAt - Date.now() <= 360_000);
    firstLease.leaseExpiresAt = Date.now() - 1;
    await storage.put("exact-review-queue", leased);
    await queue.alarm();
    state = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: state.pending, dispatching: state.dispatching, leased: state.leased },
      { pending: 0, dispatching: 1, leased: 0 },
    );
    assert.equal(state.handoff_health.recovery_reasons.claim_timeout, 1);
    assert.equal(dispatchAttempts, 3);
    const reclaimed = (await storage.get("exact-review-queue")) as {
      items: Record<string, { reviewRecoveryReason?: string }>;
    };
    assert.equal(reclaimed.items["openclaw/gogcli#599"].reviewRecoveryReason, "claim_timeout");
    const staleClaim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: firstLease.leaseId,
          item_key: "openclaw/gogcli#599",
          lease_revision: firstLease.leaseRevision,
          run_id: "5990",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(staleClaim.status, 409);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue automatically retries a parked dispatch rejection after cooldown", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchStatus = 422;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches")
      return dispatchStatus === 204
        ? new Response(null, { status: 204 })
        : new Response(
            JSON.stringify({
              message: "Validation Failed: must-not-persist",
              errors: [
                {
                  resource: "Repository",
                  field: "client_payload",
                  code: "invalid",
                  value: "https://private.example/secret?token=must-not-persist",
                },
              ],
            }),
            { status: dispatchStatus },
          );
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("dispatch-rejected", 600, "opened"))).status,
      202,
    );
    await queue.alarm();

    const status = await (
      await queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fgogcli&item_number=600",
        ),
      )
    ).json();
    assert.equal(status.items[0].state, "parked");
    assert.equal(status.items[0].parked_reason, "dispatch_rejected");
    assert.equal(status.items[0].attempts, 0);
    assert.equal(status.items[0].dispatch_failure_status, 422);
    assert.equal(status.items[0].dispatch_failure_class, "permanent_rejection");
    assert.deepEqual(status.items[0].dispatch_failure_detail, {
      validation_fields: ["client_payload"],
      validation_codes: ["invalid"],
    });
    assert.match(status.items[0].dispatch_failure_fingerprint, /^dispatch-[0-9a-f]{8}$/);

    const parkedState = (await storage.get("exact-review-queue")) as {
      items: Record<string, { reviewRetryPolicyEpoch?: string }>;
    };
    assert.equal(parkedState.items["openclaw/gogcli#600"].reviewRetryPolicyEpoch, "1");
    const persisted = JSON.stringify(parkedState);
    assert.doesNotMatch(persisted, /must-not-persist|private\.example|token=/);

    dispatchStatus = 204;
    const due = (await storage.get("exact-review-queue")) as {
      items: Record<string, { updatedAt: number; parkedRecoveryAt?: number }>;
    };
    const parked = due.items["openclaw/gogcli#600"];
    assert.ok(Number(parked.parkedRecoveryAt) >= parked.updatedAt + 3.75 * 60_000);
    assert.ok(Number(parked.parkedRecoveryAt) <= parked.updatedAt + 7.5 * 60_000);
    parked.parkedRecoveryAt = parked.updatedAt;
    await storage.put("exact-review-queue", due);
    await queue.alarm();
    const recovered = (await storage.get("exact-review-queue")) as {
      items: Record<
        string,
        {
          state: string;
          parkedReason?: string;
          parkedRecoveryAttempts?: number;
          dispatchFailureClass?: string;
          attempts: number;
        }
      >;
    };
    assert.equal(recovered.items["openclaw/gogcli#600"].state, "dispatching");
    assert.equal(recovered.items["openclaw/gogcli#600"].parkedReason, undefined);
    assert.equal(recovered.items["openclaw/gogcli#600"].parkedRecoveryAttempts, 1);
    assert.equal(recovered.items["openclaw/gogcli#600"].dispatchFailureClass, undefined);
    assert.equal(recovered.items["openclaw/gogcli#600"].attempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue retains a synchronize update after an unclassified 422", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let dispatchedPayload: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/repos/openclaw/clawsweeper/pulls/842")
      return jsonResponse({
        state: "open",
        head: { sha: "81e4abc894e7d3ec1fddbd856378b6aadb4392f3" },
      });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      dispatchedPayload = JSON.parse(String(init?.body || "{}"));
      return new Response(
        JSON.stringify({
          message: "Validation Failed: must-not-persist",
          errors: [
            {
              resource: "Repository",
              field: "event_type",
              code: "invalid",
              value: "https://private.example/secret?token=must-not-persist",
            },
          ],
        }),
        { status: 422 },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "842-command",
        842,
        "legacy_dispatch",
        "pull_request",
        "openclaw/clawsweeper",
        { commandStatusMarker: "<!-- clawsweeper-command-status:842:re_review:old -->" },
      ),
    );
    await queue.fetch(
      buildExactReviewQueueRequest(
        "842-synchronize",
        842,
        "synchronize",
        "pull_request",
        "openclaw/clawsweeper",
        {
          sourceHeadSha: "81e4abc894e7d3ec1fddbd856378b6aadb4392f3",
          sourceHeadVerified: true,
          sourceAuthoritySeq: 1,
        },
      ),
    );
    await queue.alarm();

    const clientPayload = (dispatchedPayload?.client_payload || {}) as Record<string, unknown>;
    assert.equal(Object.keys(clientPayload).length, 10);
    assert.equal(clientPayload.source_head_sha, undefined);
    assert.equal(
      (clientPayload.queue_claim as Record<string, unknown>).source_head_sha,
      "81e4abc894e7d3ec1fddbd856378b6aadb4392f3",
    );
    assert.ok(clientPayload.review_options);

    const status = await (
      await queue.fetch(
        new Request(
          "https://clawsweeper-exact-review-queue/item-status?target_repo=openclaw%2Fclawsweeper&item_number=842",
        ),
      )
    ).json();
    assert.equal(status.items[0].state, "pending");
    assert.equal(status.items[0].parked_reason, null);
    assert.equal(status.items[0].dispatch_failure_status, 422);
    assert.equal(status.items[0].dispatch_failure_class, "validation_unknown");
    assert.deepEqual(status.items[0].dispatch_failure_detail, {
      validation_fields: ["event_type"],
      validation_codes: ["invalid"],
    });

    const queueStatus = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(queueStatus.dispatcher.state, "blocked");
    assert.equal(queueStatus.dispatcher.reason, "dispatch_validation");
    assert.ok(Date.parse(queueStatus.dispatcher.retry_at) > Date.now());
    assert.deepEqual(queueStatus.dispatcher.dispatch_failure_detail, {
      validation_fields: ["event_type"],
      validation_codes: ["invalid"],
    });
    assert.doesNotMatch(
      JSON.stringify(await storage.get("exact-review-queue")),
      /must-not-persist|private\.example|token=/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue treats a secondary-limit 422 as a global retry", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches")
      return new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
        {
          status: 422,
        },
      );
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("secondary-limit", 843, "synchronize"));
    await queue.alarm();
    const status = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(status.dispatcher.state, "blocked");
    assert.equal(status.dispatcher.reason, "dispatch_rate_limit");
    assert.equal(status.dispatcher.dispatch_failure_status, 422);
    assert.equal(status.dispatcher.dispatch_failure_class, "rate_limit");
    assert.equal(status.pending, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue globally backs off GitHub outages without charging item attempts", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "dispatch-token" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches")
      return new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    await queue.fetch(buildExactReviewQueueRequest("github-outage", 602, "opened"));
    await queue.alarm();
    const state = (await storage.get("exact-review-queue")) as {
      dispatcher: {
        state: string;
        reason: string;
        dispatchFailureStatus: number;
        dispatchConsecutiveFailures: number;
      };
      items: Record<string, { state: string; attempts: number; dispatchFailureClass?: string }>;
    };
    assert.equal(state.dispatcher.state, "blocked");
    assert.equal(state.dispatcher.reason, "dispatch_github_outage");
    assert.equal(state.dispatcher.dispatchFailureStatus, 503);
    assert.equal(state.dispatcher.dispatchConsecutiveFailures, 1);
    assert.equal(state.items["openclaw/gogcli#602"].state, "pending");
    assert.equal(state.items["openclaw/gogcli#602"].attempts, 0);
    assert.equal(state.items["openclaw/gogcli#602"].dispatchFailureClass, "github_outage");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue preserves a claimed lease after an ambiguous dispatch failure", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let signalDispatchStarted!: () => void;
  let releaseDispatch!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => {
    signalDispatchStarted = resolve;
  });
  const dispatchRelease = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml")
      return jsonResponse({ state: "active" });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/installation$/.test(url.pathname))
      return jsonResponse({ id: 999 });
    if (/^\/repos\/openclaw\/(?:clawsweeper|gogcli|openclaw)\/issues\/\d+$/.test(url.pathname))
      return jsonResponse({ state: "open" });
    if (url.pathname === "/app/installations/999/access_tokens")
      return jsonResponse({ token: "t" });
    if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
      signalDispatchStarted();
      await dispatchRelease;
      throw new DOMException("timeout", "AbortError");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const queue = new ExactReviewQueue(
      { storage },
      {
        CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
        CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
        EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      },
    );
    assert.equal(
      (await queue.fetch(buildExactReviewQueueRequest("ambiguous-dispatch", 601, "opened"))).status,
      202,
    );

    const alarm = queue.alarm();
    await dispatchStarted;
    const dispatching = (await storage.get("exact-review-queue")) as {
      items: Record<string, { leaseId: string; leaseRevision: number }>;
    };
    const dispatchingItem = dispatching.items["openclaw/gogcli#601"];
    const leaseId = dispatchingItem.leaseId;
    const claim = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/claim", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: dispatchingItem.leaseRevision,
          run_id: "6010",
          run_attempt: 1,
        }),
      }),
    );
    assert.equal(claim.status, 200);
    releaseDispatch();
    await alarm;

    const stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(
      { pending: stats.pending, dispatching: stats.dispatching, leased: stats.leased },
      { pending: 0, dispatching: 0, leased: 1 },
    );
    assert.equal(stats.dispatcher.reason, "dispatch_timeout");
    const completed = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: "openclaw/gogcli#601",
          lease_revision: dispatchingItem.leaseRevision,
          claim_generation: 1,
          run_id: "6010",
          run_attempt: 1,
        }),
      }),
    );
    assert.deepEqual(await completed.json(), { ok: true, requeued: false });
    const released = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(released.leased, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review queue requeues a cancelled claimed lease", async () => {
  const storage = new MemoryDurableStorage();
  const completedAfter = Date.now();
  const retryAt = completedAfter + 10_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    dispatcher: {
      state: "paused",
      reason: "workflow_not_active",
      workflowState: "disabled_manually",
      checkedAt: Date.now(),
      retryAt,
    },
    items: {
      "openclaw/openclaw#710": leasedExactReviewQueueItem(710, "7100"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-710",
        item_key: "openclaw/openclaw#710",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7100",
        run_attempt: 1,
        outcome: "cancelled",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#710"].state, "pending");
  assert.ok(Number(state.items["openclaw/openclaw#710"].nextAttemptAt) >= completedAfter + 30_000);
  assert.ok(Number(state.items["openclaw/openclaw#710"].nextAttemptAt) > retryAt);
  assert.equal(state.items["openclaw/openclaw#710"].attempts, 1);
  assert.equal(state.items["openclaw/openclaw#710"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimedRunId, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimedRunAttempt, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].claimGeneration, undefined);
  assert.equal(state.items["openclaw/openclaw#710"].reviewRecoveryReason, "workflow_cancelled");
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.handoff_health.recovery_reasons.workflow_cancelled, 1);
});

test("exact-review publication capacity backs off on GitHub pressure and recovers gradually", async () => {
  const originalNow = Date.now;
  let now = Date.parse("2026-07-16T08:00:00.000Z");
  Date.now = () => now;
  try {
    const storage = new MemoryDurableStorage();
    const rateLimited = leasedExactReviewPublicationItem(720, "7200");
    await storage.put("exact-review-queue", {
      deliveries: {},
      items: { [rateLimited.key]: rateLimited },
    });
    const queue = new ExactReviewQueue({ storage }, {});
    const complete = (
      item: ReturnType<typeof leasedExactReviewPublicationItem>,
      outcome: "success" | "failure",
      failureKind?: "github_rate_limit" | "github_transient",
    ) =>
      queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/complete", {
          method: "POST",
          body: JSON.stringify({
            lease_id: item.leaseId,
            item_key: item.key,
            lease_revision: item.leaseRevision,
            claim_generation: item.claimGeneration,
            run_id: item.claimedRunId,
            run_attempt: item.claimedRunAttempt,
            outcome,
            ...(failureKind ? { failure_kind: failureKind } : {}),
          }),
        }),
      );

    storage.failNextPut("exact-review-publication-control:v1");
    await assert.rejects(
      complete(rateLimited, "failure", "github_rate_limit"),
      /injected storage put failure/,
    );
    let preserved = (await storage.get("exact-review-queue")) as {
      items: Record<string, unknown>;
    };
    assert.ok(preserved.items[rateLimited.key]);
    assert.equal((await complete(rateLimited, "failure", "github_rate_limit")).status, 200);
    let stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.deepEqual(stats.lanes.publication.capacity_control, {
      mode: "throttled",
      minimum: 4,
      base: 24,
      maximum: 48,
      ceiling: 12,
      demand_capacity: 24,
      demand_samples: 1,
      demand_tier: 0,
      last_scale_at: null,
      cooldown_until: "2026-07-16T08:15:00.000Z",
      recovery_successes: 0,
      last_failure_at: "2026-07-16T08:00:00.000Z",
      last_failure_kind: "github_rate_limit",
    });

    const state = (await storage.get("exact-review-queue")) as {
      deliveries: Record<string, number>;
      items: Record<string, ReturnType<typeof leasedExactReviewPublicationItem>>;
    };
    // One ceiling step per DEFAULT_EXACT_REVIEW_PUBLICATION_RECOVERY_SUCCESSES
    // (10) consecutive clean publications.
    const recovered = Array.from({ length: 10 }, (_, index) =>
      leasedExactReviewPublicationItem(721 + index, String(7210 + index)),
    );
    for (const item of recovered) state.items[item.key] = item;
    await storage.put("exact-review-queue", state);
    now += 15 * 60_000;
    for (const item of recovered) {
      assert.equal((await complete(item, "success")).status, 200);
    }

    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 20);
    assert.equal(stats.lanes.publication.capacity_control.recovery_successes, 0);

    const transient = leasedExactReviewPublicationItem(780, "7800");
    const latest = (await storage.get("exact-review-queue")) as typeof state;
    latest.items[transient.key] = transient;
    await storage.put("exact-review-queue", latest);
    assert.equal((await complete(transient, "failure", "github_transient")).status, 200);
    stats = await (
      await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
    ).json();
    assert.equal(stats.lanes.publication.capacity_control.ceiling, 12);
    assert.equal(
      stats.lanes.publication.capacity_control.cooldown_until,
      "2026-07-16T08:20:00.000Z",
    );
    assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, "github_transient");
    preserved = (await storage.get("exact-review-queue")) as typeof preserved;
    assert.ok(preserved.items[rateLimited.key]);
  } finally {
    Date.now = originalNow;
  }
});

test("exact-review publication retries a state fetch timeout without throttling capacity", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7801, "78010");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "github_transient",
        error_fingerprint: "sha256:state-fetch-timeout",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; lastFailureReason?: string }>;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "github_transient");

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
});

test("exact-review publication records an unattempted target-app quota circuit as backoff", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7804, "78040");
  const retryAt = Date.now() + 10 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "github_rate_limit",
        attempted: false,
        pool_class: "target_app",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.flow.last_15_minutes.retried, 0);
  assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.rows, [
    {
      transition: "backoff",
      stage: "publication_apply",
      completion_kind: "retryable_failure",
      reason_code: "github_rate_limit",
      revision_relation: "same_revision",
      pool_class: "target_app",
      recovery_cause: "credential_circuit",
      backoff_reason: "publication_retry",
      attempt_bucket: "0",
      count: 1,
    },
  ]);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.causes.attribution_complete, true);
});

test("exact-review publication gives state contention the transient retry budget", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7803, "78030");
  item.publicationFailureAttempts = 4;
  item.firstFailureAt = Date.now() - 30 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "state_contention",
        error_fingerprint: "sha256:state-publish-contention",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        lastFailureReason?: string;
        publicationFailureAttempts?: number;
        nextAttemptAt?: number;
      }
    >;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "state_contention");
  assert.equal(state.items[item.key]?.publicationFailureAttempts, 5);
  assert.ok((state.items[item.key]?.nextAttemptAt ?? Infinity) <= Date.now() + 6 * 60_000);

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
  assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.rows, [
    {
      transition: "retried",
      stage: "state_commit",
      completion_kind: "retryable_failure",
      reason_code: "state_contention",
      revision_relation: "same_revision",
      pool_class: "target_app",
      recovery_cause: "state_retry",
      backoff_reason: "publication_retry",
      attempt_bucket: "3_5",
      count: 1,
    },
  ]);
  assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.reconciliation.retried, {
    flow_count: 1,
    cause_count: 1,
    complete: true,
  });
  assert.equal(stats.lanes.publication.flow.last_15_minutes.causes.attribution_complete, true);
});

test("exact-review publication defers an active review lease without throttling capacity", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7802, "78020");
  const retryAt = Date.now() + 12 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "retryable_failure",
        reason_code: "review_lease_active",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; lastFailureReason?: string; nextAttemptAt?: number }>;
  };
  assert.equal(state.items[item.key]?.state, "pending");
  assert.equal(state.items[item.key]?.lastFailureReason, "review_lease_active");
  assert.ok(Number(state.items[item.key]?.nextAttemptAt) >= retryAt);

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.mode, "adaptive");
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 48);
  assert.equal(stats.lanes.publication.capacity_control.last_failure_kind, null);
});

test("exact-review publication supersedes stale tuples without counting a publish", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(781, "7810");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "superseded",
        reason_code: "remote_newer_tuple",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as { items: Record<string, unknown> };
  assert.equal(state.items[item.key], undefined);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.completed_total, 1);
  assert.equal(stats.lanes.publication.published_total, 0);
  assert.equal(stats.lanes.publication.superseded_total, 1);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.published_rate_per_hour, 0);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.superseded_rate_per_hour, 4);
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
  assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.rows, [
    {
      transition: "superseded",
      stage: "publication_apply",
      completion_kind: "superseded",
      reason_code: "remote_newer_tuple",
      revision_relation: "newer_remote_revision",
      pool_class: "target_app",
      recovery_cause: "remote_revision",
      backoff_reason: "none",
      attempt_bucket: "0",
      count: 1,
    },
  ]);
});

test("exact-review publication dead-letters exhausted permanent failures and replays idempotently", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(782, "7820");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.firstFailureAt = Date.now() - 6 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
        error_fingerprint: "sha256:deadbeef",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });

  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(listed.dead_letters.length, 1);
  assert.equal(listed.dead_letters[0].reason_code, "invalid_artifact");
  assert.equal(listed.dead_letters[0].attempts, 3);
  const id = listed.dead_letters[0].dead_letter_id;
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.rows, [
    {
      transition: "dead_lettered",
      stage: "publication_prepare",
      completion_kind: "permanent_failure",
      reason_code: "invalid_artifact",
      revision_relation: "same_revision",
      pool_class: "target_app",
      recovery_cause: "retry_budget_exhausted",
      backoff_reason: "none",
      attempt_bucket: "3_5",
      count: 1,
    },
  ]);
  assert.deepEqual(
    stats.lanes.publication.flow.last_15_minutes.causes.reconciliation.dead_lettered,
    {
      flow_count: 1,
      cause_count: 1,
      complete: true,
    },
  );
  assert.equal(stats.lanes.publication.flow.last_15_minutes.causes.attribution_complete, true);
  const serializedCauses = JSON.stringify(stats.lanes.publication.flow.last_15_minutes.causes);
  for (const sentinel of [item.key, "openclaw/openclaw", "782", "sha256:deadbeef"]) {
    assert.equal(serializedCauses.includes(sentinel), false, sentinel);
  }

  const replay = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/replay", {
        method: "POST",
        body: JSON.stringify({ ids: [id], idempotency_key: "operator:782:v1" }),
      }),
    );
  assert.deepEqual(await (await replay()).json(), {
    ok: true,
    replayed: 1,
    deduped: 0,
    skipped: 0,
  });
  assert.deepEqual(await (await replay()).json(), {
    ok: true,
    replayed: 0,
    deduped: 1,
    skipped: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number }>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 0);
});

test("exact-review dead letters expose diagnostics and recover fresh reviews in bounded batches", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(792, "7920");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.firstFailureAt = Date.now() - 6 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_RETRY_POLICY_EPOCH: "2" });

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
        error_fingerprint: "sha256:fresh-recovery",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });

  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const row = listed.dead_letters[0];
  assert.equal(row.item.key, item.key);
  assert.deepEqual(row.diagnostic.reason_code, "invalid_artifact");
  assert.equal(row.diagnostic.attempts, 3);
  assert.equal(row.diagnostic.error_fingerprint, "sha256:fresh-recovery");
  assert.equal(typeof row.diagnostic.first_failed_at, "string");
  assert.equal(typeof row.diagnostic.last_failed_at, "string");
  assert.deepEqual(row.fresh_recovery, {
    mode: "fresh_review_only",
    eligible: true,
    reason: "eligible",
    item_key: "openclaw/openclaw#792",
  });

  const tooMany = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: Array.from({ length: 11 }, (_, index) => `dead-letter-${index}`),
        idempotency_key: "operator:792:too-many",
      }),
    }),
  );
  assert.equal(tooMany.status, 400);
  assert.deepEqual(await tooMany.json(), { error: "invalid_dead_letter_ids" });

  const recover = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
        method: "POST",
        body: JSON.stringify({ ids: [row.dead_letter_id], idempotency_key: "operator:792:v1" }),
      }),
    );
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 0,
    deduped: 1,
    skipped: 0,
    unparked: 0,
  });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        attempts: number;
        state: string;
        reviewRetryPolicyEpoch?: string;
        decision: { sourceAction: string };
      }
    >;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(state.items["openclaw/openclaw#792"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#792"].attempts, 0);
  assert.equal(state.items["openclaw/openclaw#792"].reviewRetryPolicyEpoch, "2");
  assert.equal(
    state.items["openclaw/openclaw#792"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  assert.equal(Object.hasOwn(state.items["openclaw/openclaw#792"].decision, "publication"), false);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
  assert.equal(stats.lanes.review.flow.last_15_minutes.arrival, 1);

  const resolved = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10, status: "all" }),
      }),
    )
  ).json();
  assert.equal(resolved.dead_letters[0].status, "resolved");
  assert.equal(resolved.dead_letters[0].resolution_note, "recovered_fresh");
  assert.equal(resolved.dead_letters[0].replay_key, "operator:792:v1");
  assert.equal(resolved.dead_letters[0].fresh_recovery.reason, "fresh_review_already_active");
});

test("a later exact-review cycle still publishes after an earlier cycle raised the publication head", async () => {
  const storage = new MemoryDurableStorage();
  const published = leasedExactReviewPublicationItem(864, "8640");
  published.decision.publication.leaseRevision = 2;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [published.key]: published },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: published.leaseId,
        item_key: published.key,
        lease_revision: published.leaseRevision,
        claim_generation: published.claimGeneration,
        run_id: published.claimedRunId,
        run_attempt: published.claimedRunAttempt,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const drained = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(drained.items), []);

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("cycle-b-review", 864, "opened", "issue", "openclaw/openclaw"),
      )
    ).status,
    202,
  );
  const reopened = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };

  const republished = await (
    await queue.fetch(
      buildExactReviewQueueRequest(
        "cycle-b-publish",
        864,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        exactReviewPublicationOverrides(
          864,
          "8641",
          "opened",
          reopened.items["openclaw/openclaw#864"].revision,
          "openclaw/openclaw",
        ),
      ),
    )
  ).json();
  assert.equal(republished.queued, true);
  assert.equal(republished.deduped, undefined);
  assert.equal(republished.superseded, undefined);
  assert.equal(republished.item_key, "openclaw/openclaw#864@publish:8641:1");
  assert.equal(reopened.items["openclaw/openclaw#864"].revision, 3);
});

test("an existing exact-review item rebases above the publication head on a newer source event", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const reviewKey = "openclaw/openclaw#865";

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "existing-review",
          865,
          "opened",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );
  const existing = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };
  existing.items[reviewKey].revision = 7;
  await storage.put("exact-review-queue", existing);

  const recorded = await (
    await queue.fetch(
      buildExactReviewQueueRequest(
        "record-publication-head",
        865,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        exactReviewPublicationOverrides(865, "8650", "opened", 12, "openclaw/openclaw"),
      ),
    )
  ).json();
  assert.equal(recorded.queued, true);

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("newer-source", 865, "edited", "issue", "openclaw/openclaw"),
      )
    ).status,
    202,
  );
  const rebased = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };
  assert.equal(rebased.items[reviewKey].revision, 13);

  const republished = await (
    await queue.fetch(
      buildExactReviewQueueRequest(
        "rebased-publication",
        865,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        exactReviewPublicationOverrides(
          865,
          "8651",
          "edited",
          rebased.items[reviewKey].revision,
          "openclaw/openclaw",
        ),
      ),
    )
  ).json();
  assert.equal(republished.queued, true);
  assert.equal(republished.superseded, undefined);
});

test("dead-letter fresh recovery seeds a review revision that can still publish", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(866, "8660");
  item.decision.publication.leaseRevision = 2;
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.firstFailureAt = Date.now() - 6 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
        error_fingerprint: "sha256:recovery-ratchet",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });

  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.deepEqual(
    await (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
          method: "POST",
          body: JSON.stringify({
            ids: [listed.dead_letters[0].dead_letter_id],
            idempotency_key: "operator:866:v1",
          }),
        }),
      )
    ).json(),
    { ok: true, recovered: 1, deduped: 0, skipped: 0, unparked: 0 },
  );

  const recovered = (await storage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };
  assert.equal(recovered.items["openclaw/openclaw#866"].revision, 3);

  const republished = await (
    await queue.fetch(
      buildExactReviewQueueRequest(
        "recovery-publish",
        866,
        "exact_review_artifact_publish",
        "issue",
        "openclaw/openclaw",
        exactReviewPublicationOverrides(
          866,
          "8661",
          "artifact_retention_recovery",
          recovered.items["openclaw/openclaw#866"].revision,
          "openclaw/openclaw",
        ),
      ),
    )
  ).json();
  assert.equal(republished.queued, true);
  assert.equal(republished.superseded, undefined);
});

test("exact-review fresh recovery preserves failed-shard review-only behavior", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(794, "7940");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  item.decision.publication.producerDecision.sourceAction = "failed_review_shard_recovery";
  item.leaseDecision.publication.producerDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();

  const recover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [listed.dead_letters[0].dead_letter_id],
        idempotency_key: "operator:794:v1",
      }),
    }),
  );
  assert.deepEqual(await recover.json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string } }>;
  };
  assert.equal(
    state.items["openclaw/openclaw#794"].decision.sourceAction,
    "failed_review_shard_recovery",
  );
});

test("exact-review fresh recovery leaves an active review item untouched", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(793, "7930");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const id = listed.dead_letters[0].dead_letter_id;

  const enqueue = await queue.fetch(
    buildExactReviewQueueRequest(
      "fresh-recovery-guard",
      793,
      "opened",
      "issue",
      "openclaw/openclaw",
    ),
  );
  assert.equal(enqueue.status, 202);
  const before = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  const active = before.items["openclaw/openclaw#793"];
  assert.equal(active.state, "pending");
  assert.equal(active.decision.sourceAction, "opened");

  const recover = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({ ids: [id], idempotency_key: "operator:793:v1" }),
    }),
  );
  assert.deepEqual(await recover.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });

  const after = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  assert.deepEqual(after.items["openclaw/openclaw#793"], active);
  const guarded = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(guarded.dead_letters[0].fresh_recovery.reason, "fresh_review_already_active");
});

test("guarded dead-letter recovery atomically rejects transferred active aliases", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(1793, "17930");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const id = listed.dead_letters[0].dead_letter_id;
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("guarded-alias", 19, "opened", "issue", "openclaw/new"),
      )
    ).status,
    202,
  );
  const guarded = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1793:guarded",
        inventory_fingerprint: deadLetterFingerprint([id]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1793", "openclaw/new#19"] }],
        recovery_targets: [{ id, target: "openclaw/new#19" }],
      }),
    }),
  );
  assert.deepEqual(await guarded.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string }>;
  };
  assert.equal(state.items["openclaw/openclaw#1793"], undefined);
  assert.equal(state.items["openclaw/new#19"].state, "pending");
});

test("guarded dead-letter recovery rejects inventory changes inside its transaction", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(1794, "17940");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const id = listed.dead_letters[0].dead_letter_id;
  const guarded = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1794:stale",
        inventory_fingerprint: deadLetterFingerprint([]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1794"] }],
        recovery_targets: [{ id, target: "openclaw/openclaw#1794" }],
      }),
    }),
  );
  assert.deepEqual(await guarded.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
    stale_inventory: true,
  });
});

test("guarded dead-letter resolution preserves a concurrently active transferred alias", async () => {
  const { storage, queue, id } = await guardedDeadLetterFixture(1795);
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("resolve-guard-alias", 19, "opened", "issue", "openclaw/new"),
      )
    ).status,
    202,
  );
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/resolve", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        note: "automatic duplicate cleanup",
        resolution_aliases: [{ id, aliases: ["openclaw/openclaw#1795", "openclaw/new#19"] }],
      }),
    }),
  );
  assert.deepEqual(await response.json(), { ok: true, resolved: 0, skipped: 1, unparked: 0 });
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(listed.dead_letters[0].dead_letter_id, id);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string }>;
  };
  assert.equal(state.items["openclaw/new#19"].state, "pending");
});

test("superseded dead-letter resolution records its note and queue metrics honestly", async () => {
  const { queue, id } = await guardedDeadLetterFixture(17950);
  const before = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  const note = `automatic reconciliation: stale publication superseded by completed canonical record at newer head ${"b".repeat(40)}; evidence=/internal/state/records/openclaw-openclaw/items/17950`;
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/resolve", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        note,
        resolution_outcome: "superseded",
        resolution_aliases: [{ id, aliases: ["openclaw/openclaw#17950"] }],
      }),
    }),
  );
  assert.deepEqual(await response.json(), { ok: true, resolved: 1, skipped: 0, unparked: 0 });
  const after = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(
    after.lanes.publication.completed_total,
    before.lanes.publication.completed_total + 1,
  );
  assert.equal(
    after.lanes.publication.superseded_total,
    before.lanes.publication.superseded_total + 1,
  );
  assert.equal(after.lanes.publication.published_total, before.lanes.publication.published_total);
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ status: "all", limit: 10 }),
      }),
    )
  ).json();
  assert.equal(listed.dead_letters[0].resolution_note, note);

  const invalid = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/resolve", {
      method: "POST",
      body: JSON.stringify({ ids: [id], note: "invalid", resolution_outcome: "published" }),
    }),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid_resolution_outcome" });

  const unguarded = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/resolve", {
      method: "POST",
      body: JSON.stringify({ ids: [id], note: "unguarded", resolution_outcome: "superseded" }),
    }),
  );
  assert.equal(unguarded.status, 400);
  assert.deepEqual(await unguarded.json(), { error: "invalid_resolution_guard" });
});

test("guarded dead-letter resolution rejects an entire mixed-safe batch atomically", async () => {
  const { storage, queue, id: safeId } = await guardedDeadLetterFixture(17951);
  const unsafe = leasedExactReviewPublicationItem(17952, "179520");
  unsafe.attempts = 2;
  Object.assign(unsafe, { publicationFailureAttempts: 2 });
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, unknown>;
    items: Record<string, typeof unsafe>;
  };
  state.items[unsafe.key] = unsafe;
  await storage.put("exact-review-queue", state);
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: unsafe.leaseId,
        item_key: unsafe.key,
        lease_revision: unsafe.leaseRevision,
        claim_generation: unsafe.claimGeneration,
        run_id: unsafe.claimedRunId,
        run_attempt: unsafe.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  const before = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  const unsafeId = before.dead_letters.find(
    (entry) => entry.dead_letter_id !== safeId,
  ).dead_letter_id;
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/resolve", {
      method: "POST",
      body: JSON.stringify({
        ids: [safeId, unsafeId],
        note: "automatic duplicate cleanup",
        resolution_aliases: [
          { id: safeId, aliases: ["openclaw/openclaw#17951"] },
          { id: unsafeId, aliases: ["openclaw/incorrect#1"] },
        ],
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, resolved: 0, skipped: 2, unparked: 0 });
  const after = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.deepEqual(
    after.dead_letters.map((entry) => entry.dead_letter_id).sort(),
    [safeId, unsafeId].sort(),
  );
});

test("guarded dead-letter recovery retries remain idempotent after inventory changes", async () => {
  const { queue, id } = await guardedDeadLetterFixture(1796);
  const payload = {
    ids: [id],
    idempotency_key: "operator:1796:idempotent",
    inventory_fingerprint: deadLetterFingerprint([id]),
    recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1796"] }],
    recovery_targets: [{ id, target: "openclaw/openclaw#1796" }],
  };
  const recover = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  assert.deepEqual(await (await recover()).json(), {
    ok: true,
    recovered: 0,
    deduped: 1,
    skipped: 0,
    unparked: 0,
  });
});

test("guarded dead-letter recovery enforces live review capacity transactionally", async () => {
  const { storage, queue, id } = await guardedDeadLetterFixture(1797, {
    EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "1",
  });
  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, unknown>;
    items: Record<string, ReturnType<typeof leasedExactReviewQueueItem>>;
  };
  const active = leasedExactReviewQueueItem(9999, "99990");
  state.items[active.key] = active;
  await storage.put("exact-review-queue", state);
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1797:capacity",
        inventory_fingerprint: deadLetterFingerprint([id]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1797"] }],
        recovery_targets: [{ id, target: "openclaw/openclaw#1797" }],
      }),
    }),
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });
});

test("guarded dead-letter recovery enqueues transferred items at their canonical target", async () => {
  const { storage, queue, id } = await guardedDeadLetterFixture(1798);
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1798:transferred",
        inventory_fingerprint: deadLetterFingerprint([id]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1798", "openclaw/new#19"] }],
        recovery_targets: [{ id, target: "openclaw/new#19" }],
      }),
    }),
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    recovered: 1,
    deduped: 0,
    skipped: 0,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { targetRepo: string; itemNumber: number } }>;
  };
  assert.equal(state.items["openclaw/openclaw#1798"], undefined);
  assert.deepEqual(
    {
      targetRepo: state.items["openclaw/new#19"].decision.targetRepo,
      itemNumber: state.items["openclaw/new#19"].decision.itemNumber,
    },
    { targetRepo: "openclaw/new", itemNumber: 19 },
  );
});

test("guarded dead-letter recovery rejects canonical targets outside the sibling alias fence", async () => {
  const { storage, queue, id } = await guardedDeadLetterFixture(1799);
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/dead-letters/recover-fresh", {
      method: "POST",
      body: JSON.stringify({
        ids: [id],
        idempotency_key: "operator:1799:untrusted-target",
        inventory_fingerprint: deadLetterFingerprint([id]),
        recovery_aliases: [{ id, aliases: ["openclaw/openclaw#1799"] }],
        recovery_targets: [{ id, target: "openclaw/untrusted#19" }],
      }),
    }),
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    recovered: 0,
    deduped: 0,
    skipped: 1,
    unparked: 0,
  });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(state.items["openclaw/untrusted#19"], undefined);
});

test("exact-review publication refreshes an artifact after its third unavailable attempt", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(783, "7830");
  item.attempts = 2;
  Object.assign(item, { publicationFailureAttempts: 2 });
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "retryable_failure",
        reason_code: "artifact_unavailable",
      }),
    }),
  );
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(
    state.items["openclaw/openclaw#783"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.refreshed_total, 1);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.refreshed, 1);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.refreshed_rate_per_hour, 4);
  assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.reconciliation.refreshed, {
    flow_count: 1,
    cause_count: 1,
    complete: true,
  });
  assert.equal(stats.lanes.publication.flow.last_15_minutes.causes.attribution_complete, true);
});

test("exact-review publication refreshes a deterministic invalid artifact immediately", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7833, "78330");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "refresh_required",
        reason_code: "invalid_artifact",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string; publication?: unknown } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(
    state.items["openclaw/openclaw#7833"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  assert.equal(state.items["openclaw/openclaw#7833"].decision.publication, undefined);
});

test("exact-review publication completes a close-coverage deferral without refreshing", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7831, "78310");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });
  const lifecycle = new ExactReviewLifecycleProjectionStore(storage);
  const identity = {
    canonicalTargetKey: `${item.decision.targetRepo}#${item.decision.itemNumber}`,
    fenceKey: item.key,
    revision: item.leaseRevision,
  };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "close-coverage-delivery:7831",
    sourceAction: item.decision.sourceAction,
    commandOriginated: false,
    statusMarker: null,
    statusCommentId: null,
    observedAt: 1_700_000_000_000,
  });
  lifecycle.recordCanonicalReceipt({
    ...identity,
    outcome: "accepted",
    receiptId: "close-coverage:7831:accepted",
    observedAt: 1_700_000_000_001,
  });
  lifecycle.recordRouterReceipt({
    ...identity,
    outcome: "durable",
    receiptId: "router-proof:7831:1",
    observedAt: 1_700_000_000_002,
  });
  lifecycle.recordTerminalDisposition({
    ...identity,
    kind: "review_completed_routed",
    observedAt: 1_700_000_000_003,
  });

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "deferred",
        reason_code: "close_coverage_deferred",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  assert.equal(
    lifecycleState(
      lifecycle.read(identity.canonicalTargetKey, identity.fenceKey, identity.revision)!,
    ),
    "completed",
  );
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string; publication?: unknown } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(state.items["openclaw/openclaw#7831"], undefined);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.refreshed_total, 0);
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
  assert.equal(stats.lanes.publication.published_total, 0);
  assert.deepEqual(
    stats.lanes.publication.flow.last_15_minutes.causes.rows.map((row) => ({
      transition: row.transition,
      completion_kind: row.completion_kind,
      reason_code: row.reason_code,
      recovery_cause: row.recovery_cause,
    })),
    [
      {
        transition: "deferred",
        completion_kind: "deferred",
        reason_code: "close_coverage_deferred",
        recovery_cause: "coverage_retry",
      },
    ],
  );
});

test("exact-review publication accepts the legacy close-coverage refresh during rollout", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7832, "78320");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, { EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0" });

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        completion_kind: "refresh_required",
        reason_code: "close_coverage_retry",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { decision: { sourceAction: string; publication?: unknown } }>;
  };
  assert.equal(state.items[item.key], undefined);
  assert.equal(
    state.items["openclaw/openclaw#7832"].decision.sourceAction,
    "artifact_retention_recovery",
  );
  assert.equal(state.items["openclaw/openclaw#7832"].decision.publication, undefined);
});

test("exact-review publication retry budgets ignore earlier dispatch failures", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(785, "7850");
  item.attempts = 2;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "invalid_artifact",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { attempts: number; publicationFailureAttempts?: number }>;
  };
  assert.equal(state.items[item.key].attempts, 1);
  assert.equal(state.items[item.key].publicationFailureAttempts, 1);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("exact-review publication retains one unknown completion for a current-workflow retry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7851, "78510");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "permanent_failure",
        reason_code: "unknown_failure",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; publicationFailureAttempts?: number }>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].attempts, 1);
  assert.equal(state.items[item.key].publicationFailureAttempts, 1);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.dead_letters.open, 0);
});

test("exact-review exhausted unknown failures retain durable privacy-safe cause attribution", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(7852, "78520");
  item.publicationFailureAttempts = 13;
  item.firstFailureAt = Date.now() - 30 * 60_000;
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  storage.sql.exec(
    `INSERT INTO exact_review_publication_cause_buckets_v1
       (bucket_start, transition, stage, completion_kind, reason_code,
        revision_relation, pool_class, recovery_cause, backoff_reason,
        attempt_bucket, count)
     VALUES (?, 'retried', 'workflow', 'retryable_failure', 'workflow_cancelled',
             'same_revision', 'repository_actions', 'workflow_retry',
             'publication_retry', '1', 1)`,
    Date.now() - 49 * 60 * 60_000,
  );
  const body = {
    lease_id: item.leaseId,
    item_key: item.key,
    lease_revision: item.leaseRevision,
    claim_generation: item.claimGeneration,
    run_id: item.claimedRunId,
    run_attempt: item.claimedRunAttempt,
    outcome: "failure",
    completion_kind: "permanent_failure",
    reason_code: "unknown_failure",
    error_fingerprint: "sha256:private-unknown-fingerprint",
  };

  const complete = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  assert.deepEqual(await complete.json(), { ok: true, requeued: false });
  const duplicate = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  assert.equal(duplicate.status, 409);
  const listed = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/dead-letters/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(listed.dead_letters[0].reason_code, "retry_exhausted");
  assert.equal(
    Number(
      Array.from(
        storage.sql.exec("SELECT COUNT(*) AS count FROM exact_review_publication_cause_buckets_v1"),
      )[0]?.count,
    ),
    1,
    "expired attribution and a duplicate completion cannot amplify the durable cause count",
  );

  const restarted = new ExactReviewQueue({ storage }, {});
  const stats = await (
    await restarted.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(stats.lanes.publication.flow.last_15_minutes.causes.rows, [
    {
      transition: "dead_lettered",
      stage: "publication_apply",
      completion_kind: "permanent_failure",
      reason_code: "unknown_failure",
      revision_relation: "same_revision",
      pool_class: "target_app",
      recovery_cause: "retry_budget_exhausted",
      backoff_reason: "none",
      attempt_bucket: "14_plus",
      count: 1,
    },
  ]);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.causes.attribution_complete, true);
  const serialized = JSON.stringify(stats.lanes.publication.flow.last_15_minutes.causes);
  for (const sentinel of [item.key, "openclaw/openclaw", "7852", body.error_fingerprint]) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test("ordinary exact-review retries do not increment publication retry telemetry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(786, "7860");
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.retried_total, 0);
  assert.equal(stats.lanes.publication.flow.last_15_minutes.retried, 0);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retried, 1);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retried_rate_per_hour, 4);
  assert.equal(stats.lanes.review.flow.last_15_minutes.retry_amplification, null);
});

test("exact-review completion rejects incompatible structured dispositions", async () => {
  const item = leasedExactReviewPublicationItem(784, "7840");
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", { deliveries: {}, items: { [item.key]: item } });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        completion_kind: "superseded",
        reason_code: "remote_closed",
      }),
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "completion_outcome_mismatch" });
});

test("exact-review publication recovery ignores successful source-drift requeues", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(790, "7900");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  await storage.put("exact-review-publication-control:v1", {
    capacityCeiling: 12,
    cooldownUntil: Date.now() - 1,
    recoverySuccesses: 49,
    lastFailureAt: Date.now() - 60_000,
    lastFailureKind: "github_rate_limit",
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "success",
        requeue_latest: true,
      }),
    }),
  );

  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.publication.capacity_control.ceiling, 12);
  assert.equal(stats.lanes.publication.capacity_control.recovery_successes, 49);
});

test("exact-review queue completes a failed shard recovery without a second retry", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(710, "7101");
  item.decision.sourceAction = "failed_review_shard_recovery";
  item.leaseDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-710",
        item_key: "openclaw/openclaw#710",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7101",
        run_attempt: 1,
        outcome: "failure",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(Object.keys(state.items).length, 0);
});

test("failed shard recovery does not replace an already-pending ordinary event", async () => {
  const storage = new MemoryDurableStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  assert.equal(
    (await queue.fetch(buildExactReviewQueueRequest("ordinary-event", 710, "edited"))).status,
    202,
  );
  const beforeRecovery = (await storage.get("exact-review-queue")) as {
    items: Record<string, { attempts: number; nextAttemptAt: number }>;
  };
  const ordinary = beforeRecovery.items["openclaw/gogcli#710"];
  ordinary.attempts = 1;
  ordinary.nextAttemptAt = Date.now() + 30_000;
  await storage.put("exact-review-queue", beforeRecovery);
  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest("failed-shard-recovery", 710, "failed_review_shard_recovery"),
      )
    ).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        attempts: number;
        nextAttemptAt: number;
        revision: number;
        decision: { sourceAction: string; supersedesInProgress: boolean };
      }
    >;
  };
  assert.equal(state.items["openclaw/gogcli#710"].decision.sourceAction, "edited");
  assert.equal(state.items["openclaw/gogcli#710"].decision.supersedesInProgress, true);
  assert.equal(state.items["openclaw/gogcli#710"].revision, 1);
  assert.equal(state.items["openclaw/gogcli#710"].attempts, 1);
  assert.equal(state.items["openclaw/gogcli#710"].nextAttemptAt, ordinary.nextAttemptAt);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.lanes.review.enqueued_total, 1);
});

test("failed shard recovery does not replace an ordinary active lease", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#710": leasedExactReviewQueueItem(710, "7102"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-active-lease",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const beforeComplete = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      {
        state: string;
        revision: number;
        decision: { sourceAction: string };
        leaseDecision?: { sourceAction: string };
      }
    >;
  };
  const ordinary = beforeComplete.items["openclaw/openclaw#710"];
  assert.equal(ordinary.state, "leased");
  assert.equal(ordinary.revision, 1);
  assert.equal(ordinary.decision.sourceAction, "opened");
  assert.equal(ordinary.leaseDecision?.sourceAction, "opened");

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "7102",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 0, completed: 1 });
  const afterComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(afterComplete.items["openclaw/openclaw#710"], undefined);
});

test("failed shard recovery does not replace an active recovery lease", async () => {
  const storage = new MemoryDurableStorage();
  const recovery = leasedExactReviewQueueItem(710, "7103");
  recovery.decision.sourceAction = "failed_review_shard_recovery";
  recovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": recovery },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-active-recovery",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const beforeComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; revision: number; decision: { sourceAction: string } }>;
  };
  const activeRecovery = beforeComplete.items["openclaw/openclaw#710"];
  assert.equal(activeRecovery.state, "leased");
  assert.equal(activeRecovery.revision, 1);
  assert.equal(activeRecovery.decision.sourceAction, "failed_review_shard_recovery");

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "7103",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, reconciled: 1, requeued: 0, completed: 1 });
  const afterComplete = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(afterComplete.items["openclaw/openclaw#710"], undefined);
});

test("failed shard recovery replaces an expired recovery lease", async () => {
  const storage = new MemoryDurableStorage();
  const expiredRecovery = leasedExactReviewQueueItem(710, "7104");
  expiredRecovery.decision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseExpiresAt = Date.now() - 1;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#710": expiredRecovery },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  assert.equal(
    (
      await queue.fetch(
        buildExactReviewQueueRequest(
          "failed-shard-recovery-expired-recovery",
          710,
          "failed_review_shard_recovery",
          "issue",
          "openclaw/openclaw",
        ),
      )
    ).status,
    202,
  );

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<
      string,
      { state: string; revision: number; decision: { sourceAction: string }; leaseId?: string }
    >;
  };
  const replacement = state.items["openclaw/openclaw#710"];
  assert.equal(replacement.state, "pending");
  assert.equal(replacement.revision, 1);
  assert.equal(replacement.decision.sourceAction, "failed_review_shard_recovery");
  assert.equal(replacement.leaseId, undefined);
});

for (const retryKind of ["coordination", "throttle"] as const) {
  test(`exact-review queue defers ${retryKind} without spending review attempts`, async () => {
    const originalNow = Date.now;
    let now = Date.parse("2026-08-08T13:00:00.000Z");
    Date.now = () => now;
    try {
      const storage = new MemoryDurableStorage();
      const retryAt = now + 45 * 60_000;
      const item = leasedExactReviewQueueItem(711, "7110");
      item.attempts = 3;
      item.reviewFailureAttempts = 2;
      await storage.put("exact-review-queue", {
        deliveries: {},
        items: {
          "openclaw/openclaw#711": item,
        },
      });
      if (retryKind === "throttle") {
        await storage.put("exact-review-scheduled-feed:v1:global", {
          tokens: 1,
          updatedAt: now,
          throttleObservedAt: now - 60_000,
          throttleUntil: now + 90 * 60_000,
          throttleSource: "review_completion",
        });
      }
      const queue = new ExactReviewQueue({ storage }, {}, () => 0);

      const response = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/complete", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-711",
            item_key: "openclaw/openclaw#711",
            lease_revision: 1,
            claim_generation: 1,
            run_id: "7110",
            run_attempt: 1,
            outcome: "failure",
            retry_kind: retryKind,
            retry_at: new Date(retryAt).toISOString(),
          }),
        }),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, requeued: true });
      const state = (await storage.get("exact-review-queue")) as {
        items: Record<string, Record<string, unknown>>;
      };
      const deferred = state.items["openclaw/openclaw#711"];
      assert.equal(
        deferred.nextAttemptAt,
        retryKind === "throttle" ? now + 33.75 * 60_000 : retryAt,
      );
      assert.equal(deferred.attempts, 3);
      assert.equal(deferred.reviewFailureAttempts, 2);
      assert.equal(deferred.backoffReason, `${retryKind}_retry`);
      assert.equal(deferred.reviewRecoveryReason, undefined);
      assert.equal(deferred.reviewRecoveryAt, undefined);
      const recoveryStats = await (
        await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
      ).json();
      assert.equal(recoveryStats.handoff_health.recovery_reasons.workflow_failed, 0);
      if (retryKind === "throttle") {
        const stats = recoveryStats;
        assert.equal(stats.scheduled_feed.throttle_source, "review_completion");
        assert.equal(stats.scheduled_feed.throttle_observed_at, new Date(now).toISOString());
        assert.equal(
          stats.scheduled_feed.throttle_recovery_at,
          new Date(now + 90 * 60_000).toISOString(),
        );
        assert.ok(stats.scheduled_feed.token_balance >= 0);
      }
      const scheduled = await queue.fetch(
        buildExactReviewQueueRequest(
          `scheduled-after-${retryKind}`,
          712,
          "scheduled_normal_backfill",
        ),
      );
      assert.deepEqual(
        await scheduled.json(),
        retryKind === "throttle"
          ? { ok: true, shed: true, reason: "scheduled_rate" }
          : {
              ok: true,
              queued: true,
              item_key: "openclaw/gogcli#712",
              superseded_publications: 0,
            },
      );
      for (const [index, sourceAction] of [
        "failed_review_shard_recovery",
        "artifact_retention_recovery",
        "source_drift_requeue",
      ].entries()) {
        const background = await queue.fetch(
          buildExactReviewQueueRequest(
            `background-after-${retryKind}-${sourceAction}`,
            713 + index,
            sourceAction,
          ),
        );
        assert.deepEqual(
          await background.json(),
          retryKind === "throttle"
            ? { ok: true, shed: true, reason: "scheduled_rate" }
            : {
                ok: true,
                queued: true,
                item_key: `openclaw/gogcli#${713 + index}`,
                superseded_publications: 0,
              },
        );
      }
      const interactive = await queue.fetch(
        buildExactReviewQueueRequest(`interactive-after-${retryKind}`, 716, "opened"),
      );
      assert.deepEqual(await interactive.json(), {
        ok: true,
        queued: true,
        item_key: "openclaw/gogcli#716",
        superseded_publications: 0,
      });
      if (retryKind === "throttle") {
        now += 91 * 60_000;
        const recovered = await queue.fetch(
          buildExactReviewQueueRequest(
            "background-after-throttle-recovery",
            717,
            "source_drift_requeue",
          ),
        );
        assert.deepEqual(await recovered.json(), {
          ok: true,
          queued: true,
          item_key: "openclaw/gogcli#717",
          superseded_publications: 0,
        });
        const recoveredStats = await (
          await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
        ).json();
        assert.equal("throttle_source" in recoveredStats.scheduled_feed, false);
        assert.equal("throttle_observed_at" in recoveredStats.scheduled_feed, false);
        assert.equal("throttle_recovery_at" in recoveredStats.scheduled_feed, false);
      }
    } finally {
      Date.now = originalNow;
    }
  });
}

test("exact-review queue terminates deterministic refusals only for the unchanged revision", async () => {
  const storage = new MemoryDurableStorage();
  const terminal = leasedExactReviewQueueItem(709, "7090");
  const transient = leasedExactReviewQueueItem(710, "7100");
  const newer = leasedExactReviewQueueItem(711, "7110");
  const findingsTerminal = leasedExactReviewQueueItem(712, "7120");
  newer.revision = 2;
  newer.decision = { ...newer.decision, sourceAction: "synchronize" };
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#709": terminal,
      "openclaw/openclaw#710": transient,
      "openclaw/openclaw#711": newer,
      "openclaw/openclaw#712": findingsTerminal,
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = (itemNumber: number, runId: string, reviewFailureReason?: string) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: `lease-${itemNumber}`,
          item_key: `openclaw/openclaw#${itemNumber}`,
          lease_revision: 1,
          claim_generation: 1,
          run_id: runId,
          run_attempt: 1,
          outcome: "failure",
          ...(reviewFailureReason ? { review_failure_reason: reviewFailureReason } : {}),
        }),
      }),
    );

  const terminalResponse = await complete(709, "7090", "incomplete_source");
  assert.equal(terminalResponse.status, 200);
  assert.deepEqual(await terminalResponse.json(), { ok: true, requeued: false });

  const transientResponse = await complete(710, "7100");
  assert.equal(transientResponse.status, 200);
  assert.deepEqual(await transientResponse.json(), { ok: true, requeued: true });

  const newerResponse = await complete(711, "7110", "incomplete_source");
  assert.equal(newerResponse.status, 200);
  assert.deepEqual(await newerResponse.json(), { ok: true, requeued: true });

  const findingsResponse = await complete(712, "7120", "findings");
  assert.equal(findingsResponse.status, 200);
  assert.deepEqual(await findingsResponse.json(), { ok: true, requeued: false });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#709"], undefined);
  assert.equal(state.items["openclaw/openclaw#710"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#710"].reviewFailureAttempts, 1);
  assert.equal(state.items["openclaw/openclaw#711"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#711"].revision, 2);
  assert.equal(state.items["openclaw/openclaw#711"].reviewFailureAttempts, 0);
  assert.equal(state.items["openclaw/openclaw#712"], undefined);
  const failureStats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.deepEqual(failureStats.review_failure_health, {
    status: "degraded",
    reasons: ["terminal_review_failure", "retryable_review_failure"],
    window_minutes: 60,
    attempts: 4,
    affected_targets: 4,
    retryable_attempts: 1,
    terminal_attempts: 3,
    terminal_status_observed: 0,
    terminal_status_failed: 0,
    repeated_identities: 0,
    first_seen_at: failureStats.review_failure_health.first_seen_at,
    last_seen_at: failureStats.review_failure_health.last_seen_at,
    by_stage: {
      agent_input_scan: 3,
      source_preparation: 0,
      provider_or_model: 0,
      workflow: 1,
    },
  });
  assert.ok(failureStats.review_failure_health.first_seen_at);
  assert.ok(failureStats.review_failure_health.last_seen_at);
  const failureInventory = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/review-failures/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(failureInventory.attempts.length, 4);
  assert.deepEqual(
    new Set(failureInventory.attempts.map((attempt) => attempt.reason_code)),
    new Set(["findings", "incomplete_source", "workflow_failed"]),
  );
  const sourceStorage = new MemoryDurableStorage();
  const sourceNewer = leasedExactReviewQueueItem(714, "7140");
  sourceNewer.revision = 2;
  sourceNewer.decision = { ...sourceNewer.decision, sourceAction: "synchronize" };
  await sourceStorage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#713": leasedExactReviewQueueItem(713, "7130"),
      "openclaw/openclaw#714": sourceNewer,
    },
  });
  const sourceQueue = new ExactReviewQueue({ storage: sourceStorage }, {});
  const completeSource = (itemNumber: number, runId: string) =>
    sourceQueue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: `lease-${itemNumber}`,
          item_key: `openclaw/openclaw#${itemNumber}`,
          lease_revision: 1,
          claim_generation: 1,
          run_id: runId,
          run_attempt: 1,
          outcome: "failure",
          review_failure_reason: "source_incompatible",
        }),
      }),
    );
  assert.deepEqual(await (await completeSource(713, "7130")).json(), {
    ok: true,
    requeued: false,
  });
  assert.deepEqual(await (await completeSource(714, "7140")).json(), {
    ok: true,
    requeued: true,
  });
  const sourceState = (await sourceStorage.get("exact-review-queue")) as {
    items: Record<string, { revision: number }>;
  };
  assert.equal(sourceState.items["openclaw/openclaw#713"], undefined);
  assert.equal(sourceState.items["openclaw/openclaw#714"].revision, 2);
});

test("terminal PR refusals retain a verified explanation receipt without retrying", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(718, "7180");
  for (const decision of [item.decision, item.leaseDecision]) {
    Object.assign(decision, {
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceHeadSha: "a".repeat(40),
      reviewAcknowledgementCommentId: 71_800,
    });
  }
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7180",
        run_attempt: 1,
        outcome: "failure",
        review_failure_reason: "findings",
        review_failure_status: {
          outcome: "observed",
          comment_id: 71_800,
          completed_at: "2026-09-03T12:00:00.000Z",
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: false });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, unknown>;
  };
  assert.equal(state.items[item.key], undefined);

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.review_failure_health.terminal_status_observed, 1);
  assert.equal(stats.review_failure_health.terminal_status_failed, 0);
  const inventory = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/review-failures/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.deepEqual(inventory.attempts[0]?.terminal_status, {
    outcome: "observed",
    comment_id: 71_800,
    completed_at: "2026-09-03T12:00:00.000Z",
  });
});

test("exact-review queue validates terminal review failure reasons", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  for (const [body, error] of [
    [
      { outcome: "failure", review_failure_reason: "scanner_failed" },
      "invalid_review_failure_reason",
    ],
    [
      { outcome: "success", review_failure_reason: "incomplete_source" },
      "review_failure_reason_without_failure",
    ],
    [
      {
        outcome: "failure",
        review_failure_reason: "incomplete_source",
        retry_kind: "coordination",
        retry_at: new Date(Date.now() + 60_000).toISOString(),
      },
      "review_failure_reason_with_retry",
    ],
    [
      {
        outcome: "failure",
        review_failure: { stage: "unsafe detail", reason_code: "findings", retryable: false },
      },
      "invalid_review_failure",
    ],
    [
      {
        outcome: "success",
        review_failure: {
          stage: "agent_input_scan",
          reason_code: "findings",
          retryable: false,
        },
      },
      "review_failure_without_failure",
    ],
    [
      {
        outcome: "failure",
        review_failure_reason: "findings",
        review_failure: {
          stage: "agent_input_scan",
          reason_code: "findings",
          retryable: true,
        },
      },
      "review_failure_retryability_mismatch",
    ],
  ] as const) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({ lease_id: "lease-1", run_id: "1", ...body }),
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
});

test("review failure telemetry binds the active lease source before a queued successor", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(715, "7150");
  const leasedHead = "a".repeat(40);
  const successorHead = "b".repeat(40);
  item.leaseDecision = {
    ...item.leaseDecision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceHeadSha: leasedHead,
    sourceUpdatedAt: "2026-09-02T19:00:00Z",
  };
  item.decision = {
    ...item.decision,
    itemKind: "pull_request",
    sourceEvent: "pull_request",
    sourceHeadSha: successorHead,
    sourceUpdatedAt: "2026-09-02T19:05:00Z",
  };
  item.revision = 2;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const completed = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7150",
        run_attempt: 1,
        outcome: "failure",
        review_failure: {
          stage: "transport_network",
          reason_code: "transport_network",
          retryable: true,
        },
      }),
    }),
  );
  assert.deepEqual(await completed.json(), { ok: true, requeued: true });
  const inventory = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/review-failures/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(inventory.attempts.length, 1);
  assert.equal(inventory.attempts[0].source_head_sha, leasedHead);
  assert.notEqual(inventory.attempts[0].source_head_sha, successorHead);
});

test("review failure telemetry records failed workflows recovered by reconciliation", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(718, "7180");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "7180",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "failure",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(await response.json(), {
    ok: true,
    reconciled: 1,
    requeued: 1,
    completed: 0,
  });
  const inventory = await (
    await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/review-failures/list", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      }),
    )
  ).json();
  assert.equal(inventory.attempts.length, 1);
  assert.deepEqual(
    {
      target: inventory.attempts[0].target,
      stage: inventory.attempts[0].stage,
      reason_code: inventory.attempts[0].reason_code,
      retryable: inventory.attempts[0].retryable,
    },
    {
      target: "openclaw/openclaw#718",
      stage: "workflow",
      reason_code: "workflow_failed",
      retryable: true,
    },
  );
});

test("review failure telemetry excludes coordination and throttle deferrals", async () => {
  for (const [index, retryKind] of ["coordination", "throttle"].entries()) {
    const storage = new MemoryDurableStorage();
    const itemNumber = 719 + index;
    const runId = String(itemNumber * 10);
    const item = leasedExactReviewQueueItem(itemNumber, runId);
    await storage.put("exact-review-queue", {
      deliveries: {},
      items: { [item.key]: item },
    });
    const queue = new ExactReviewQueue({ storage }, {});
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: item.leaseId,
          item_key: item.key,
          lease_revision: 1,
          claim_generation: 1,
          run_id: runId,
          run_attempt: 1,
          outcome: "failure",
          retry_kind: retryKind,
          retry_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      }),
    );
    assert.deepEqual(await response.json(), { ok: true, requeued: true });
    const inventory = await (
      await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/review-failures/list", {
          method: "POST",
          body: JSON.stringify({ limit: 10 }),
        }),
      )
    ).json();
    assert.deepEqual(inventory.attempts, []);
  }
});

test("review failure telemetry cannot block queue completion", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(716, "7160");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  storage.failNextSql(/exact_review_failure_attempts_v1/);
  const queue = new ExactReviewQueue({ storage }, {});
  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7160",
        run_attempt: 1,
        outcome: "failure",
      }),
    }),
  );
  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; reviewFailureAttempts?: number }>;
  };
  assert.equal(state.items[item.key].state, "pending");
  assert.equal(state.items[item.key].reviewFailureAttempts, 1);
  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.review_failure_health.status, "unknown");
  assert.deepEqual(stats.review_failure_health.reasons, ["telemetry_unavailable"]);
});

test("exact-review queue spends review attempts for an untyped retry deadline", async () => {
  const storage = new MemoryDurableStorage();
  const retryAt = Date.now() + 45 * 60_000;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#711": leasedExactReviewQueueItem(711, "7110"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-711",
        item_key: "openclaw/openclaw#711",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7110",
        run_attempt: 1,
        outcome: "failure",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.equal(response.status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#711"].attempts, 1);
  assert.equal(state.items["openclaw/openclaw#711"].reviewFailureAttempts, 1);
  assert.equal(state.items["openclaw/openclaw#711"].nextAttemptAt, retryAt);
});

test("exact-review queue does not carry an old coordination deadline or reset budget on a same-source successor", async () => {
  const storage = new MemoryDurableStorage();
  const retryAt = Date.now() + 45 * 60_000;
  const item = leasedExactReviewQueueItem(712, "7120");
  item.attempts = 3;
  item.reviewFailureAttempts = 2;
  item.revision = Number(item.leaseRevision) + 1;
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#712": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-712",
        item_key: "openclaw/openclaw#712",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7120",
        run_attempt: 1,
        outcome: "failure",
        retry_kind: "coordination",
        retry_at: new Date(retryAt).toISOString(),
      }),
    }),
  );

  assert.equal(response.status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.ok(Number(state.items["openclaw/openclaw#712"].nextAttemptAt) < retryAt);
  assert.equal(state.items["openclaw/openclaw#712"].attempts, 3);
  assert.equal(state.items["openclaw/openclaw#712"].reviewFailureAttempts, 2);
});

test("exact-review queue rejects invalid retry deferral contracts", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  for (const [payload, error] of [
    [
      { retry_kind: "capacity", retry_at: new Date(Date.now() + 60_000).toISOString() },
      "invalid_retry_kind",
    ],
    [{ retry_kind: "coordination" }, "retry_kind_without_retry_at"],
    [
      {
        outcome: "success",
        retry_kind: "coordination",
        retry_at: new Date(Date.now() + 60_000).toISOString(),
      },
      "retry_kind_without_failure",
    ],
    [{ retry_kind: "coordination", retry_at: "not-a-timestamp" }, "invalid_retry_at"],
    [
      {
        retry_kind: "throttle",
        retry_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
      },
      "invalid_retry_at",
    ],
  ] as const) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-712",
          item_key: "openclaw/openclaw#712",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7120",
          run_attempt: 1,
          outcome: "failure",
          ...payload,
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
  }
});

test("exact-review queue rejects regular-review retry kinds for publication work", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewPublicationItem(712, "7120");
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { [item.key]: item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: item.leaseId,
        item_key: item.key,
        lease_revision: item.leaseRevision,
        claim_generation: item.claimGeneration,
        run_id: item.claimedRunId,
        run_attempt: item.claimedRunAttempt,
        outcome: "failure",
        retry_kind: "throttle",
        retry_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "retry_kind_outside_regular_review" });
});

test("exact-review queue requeues a verified source drift exactly once without failure backoff", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#713": leasedExactReviewQueueItem(713, "9113"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = () =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-713",
          item_key: "openclaw/openclaw#713",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "9113",
          run_attempt: 1,
          outcome: "success",
          requeue_latest: true,
        }),
      }),
    );

  const response = await complete();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, requeued: true });
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#713"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#713"].attempts, 0);
  assert.equal(state.items["openclaw/openclaw#713"].revision, 1);
  assert.equal(state.items["openclaw/openclaw#713"].leaseId, undefined);
  assert.equal((await complete()).status, 409);
  const replayedState = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(Object.keys(replayedState.items).length, 1);
  assert.equal(replayedState.items["openclaw/openclaw#713"].state, "pending");
  const reconciled = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "9113",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "success",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(await reconciled.json(), {
    ok: true,
    reconciled: 0,
    requeued: 0,
    completed: 0,
  });
  const reconciledState = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(reconciledState.items["openclaw/openclaw#713"].state, "pending");
});

test("exact-review success preserves an already-enqueued newer decision", async () => {
  const storage = new MemoryDurableStorage();
  const item = leasedExactReviewQueueItem(714, "7140");
  item.revision = 2;
  item.decision.sourceAction = "edited";
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: { "openclaw/openclaw#714": item },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/complete", {
      method: "POST",
      body: JSON.stringify({
        lease_id: "lease-714",
        item_key: "openclaw/openclaw#714",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "7140",
        run_attempt: 1,
        outcome: "success",
      }),
    }),
  );

  assert.equal(response.status, 200);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; revision: number; decision: { sourceAction: string } }>;
  };
  assert.equal(Object.keys(state.items).length, 1);
  assert.equal(state.items["openclaw/openclaw#714"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#714"].revision, 2);
  assert.equal(state.items["openclaw/openclaw#714"].decision.sourceAction, "edited");
});

test("exact-review queue rejects invalid source-drift requeue requests", async () => {
  const queue = new ExactReviewQueue({ storage: new MemoryDurableStorage() }, {});
  for (const body of [
    { outcome: "success", requeue_latest: "true" },
    { outcome: "failure", requeue_latest: true },
  ]) {
    const response = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-715",
          item_key: "openclaw/openclaw#715",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "7150",
          run_attempt: 1,
          ...body,
        }),
      }),
    );
    assert.equal(response.status, 400);
  }
});

test("exact-review completion rejects stale owners and is race-idempotent", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#716": leasedExactReviewQueueItem(716, "9100", 2),
      "openclaw/openclaw#717": leasedExactReviewQueueItem(717, "9101", 1),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const complete = (
    itemNumber: number,
    leaseId: string,
    runId: string,
    runAttempt: number,
    outcome: string,
  ) =>
    queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: leaseId,
          item_key: `openclaw/openclaw#${itemNumber}`,
          lease_revision: 1,
          claim_generation: 1,
          run_id: runId,
          run_attempt: runAttempt,
          outcome,
        }),
      }),
    );

  assert.equal((await complete(716, "lease-716", "9100", 1, "failure")).status, 409);
  assert.equal((await complete(716, "lease-716", "9999", 2, "failure")).status, 409);
  const failed = await complete(716, "lease-716", "9100", 2, "failure");
  assert.equal(failed.status, 200);
  assert.deepEqual(await failed.json(), { ok: true, requeued: true });
  assert.equal((await complete(716, "lease-716", "9100", 2, "success")).status, 409);

  const completed = await complete(717, "lease-717", "9101", 1, "success");
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { ok: true, requeued: false });
  assert.equal((await complete(717, "lease-717", "9101", 1, "failure")).status, 409);
  const reconciledAfterSuccess = await queue.fetch(
    new Request("https://clawsweeper-exact-review-queue/reconcile", {
      method: "POST",
      body: JSON.stringify({
        runs: [
          {
            run_id: "9101",
            run_attempt: 1,
            claimed_run_attempt: 1,
            claim_generation: 1,
            outcome: "failure",
          },
        ],
      }),
    }),
  );
  assert.deepEqual(await reconciledAfterSuccess.json(), {
    ok: true,
    reconciled: 0,
    requeued: 0,
    completed: 0,
  });

  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, Record<string, unknown>>;
  };
  assert.equal(state.items["openclaw/openclaw#716"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#716"].attempts, 1);
  assert.equal(state.items["openclaw/openclaw#716"].leaseId, undefined);
  assert.equal(state.items["openclaw/openclaw#717"], undefined);
});

test("signed exact-review reconciliation releases only immutable terminal runs", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#711": leasedExactReviewQueueItem(711, "9001"),
      "openclaw/openclaw#712": leasedExactReviewQueueItem(712, "9002"),
      "openclaw/openclaw#720": leasedExactReviewQueueItem(720, "9004"),
      "openclaw/openclaw#719": leasedExactReviewQueueItem(719, "9003"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      assert.deepEqual(JSON.parse(String(init?.body)).permissions, { actions: "read" });
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml/runs") {
      assert.equal(url.searchParams.get("event"), "repository_dispatch");
      assert.equal(url.searchParams.get("status"), null);
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = url.searchParams.get("page");
      if (page === "1") {
        return jsonResponse({
          workflow_runs: Array.from({ length: 100 }, (_, index) => ({
            id: 10_000 + index,
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
          })),
        });
      }
      assert.equal(page, "2");
      return jsonResponse({
        workflow_runs: [
          { id: 9001, run_attempt: 1, status: "completed", conclusion: "cancelled" },
          { id: 9002, run_attempt: 1, status: "in_progress", conclusion: null },
          { id: 9003, run_attempt: 1, status: "completed", conclusion: "success" },
        ],
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9001/attempts/1") {
      return jsonResponse({
        id: 9001,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9003/attempts/1") {
      return jsonResponse({
        id: 9003,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [{ run_id: "9001", run_attempt: 1 }],
      include_all_claimed: true,
    });
    const unsigned = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        body,
      }),
      env,
    );
    assert.equal(unsigned.status, 401);

    const oversizedBody = JSON.stringify({
      run_ids: Array.from({ length: 129 }, (_, index) => String(index + 1)),
    });
    const oversizedSignature = `sha256=${createHmac("sha256", "test-secret").update(oversizedBody).digest("hex")}`;
    const oversized = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": oversizedSignature },
        body: oversizedBody,
      }),
      env,
    );
    assert.equal(oversized.status, 400);
    assert.deepEqual(await oversized.json(), { error: "invalid_runs" });

    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      ok: false,
      requested: 1,
      claimed: 4,
      terminal: 2,
      unavailable: 1,
      reconciled: 2,
      requeued: 1,
      completed: 1,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#711"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#711"].claimedRunId, undefined);
    assert.equal(state.items["openclaw/openclaw#712"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#712"].claimedRunId, "9002");
    assert.equal(state.items["openclaw/openclaw#720"].claimedRunId, "9004");
    assert.equal(state.items["openclaw/openclaw#719"], undefined);
    const staleAttemptBody = JSON.stringify({
      runs: [{ run_id: "9004", run_attempt: 2 }],
      include_all_claimed: true,
    });
    const staleAttemptSignature = `sha256=${createHmac("sha256", "test-secret").update(staleAttemptBody).digest("hex")}`;
    const staleAttempt = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": staleAttemptSignature },
        body: staleAttemptBody,
      }),
      env,
    );
    assert.equal(staleAttempt.status, 502);
    const staleAttemptResult = (await staleAttempt.json()) as { unavailable: number };
    assert.equal(staleAttemptResult.unavailable, 1);
    const unavailableBody = JSON.stringify({
      runs: [{ run_id: "9004", run_attempt: 1 }],
      include_all_claimed: true,
    });
    const unavailableSignature = `sha256=${createHmac("sha256", "test-secret").update(unavailableBody).digest("hex")}`;
    const unavailable = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": unavailableSignature },
        body: unavailableBody,
      }),
      env,
    );
    assert.equal(unavailable.status, 502);
    assert.deepEqual(await unavailable.json(), {
      ok: false,
      requested: 1,
      claimed: 2,
      terminal: 0,
      unavailable: 1,
      reconciled: 0,
      requeued: 0,
      completed: 0,
    });
    const staleFailure = await queue.fetch(
      new Request("https://clawsweeper-exact-review-queue/complete", {
        method: "POST",
        body: JSON.stringify({
          lease_id: "lease-719",
          item_key: "openclaw/openclaw#719",
          lease_revision: 1,
          claim_generation: 1,
          run_id: "9003",
          run_attempt: 1,
          outcome: "failure",
        }),
      }),
    );
    assert.equal(staleFailure.status, 409);

    const replayBody = JSON.stringify({ runs: [{ run_id: "9001", run_attempt: 1 }] });
    const replaySignature = `sha256=${createHmac("sha256", "test-secret").update(replayBody).digest("hex")}`;
    const replay = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": replaySignature },
        body: replayBody,
      }),
      env,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), {
      ok: true,
      requested: 1,
      claimed: 0,
      terminal: 0,
      unavailable: 0,
      reconciled: 0,
      requeued: 0,
      completed: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review reconciliation targets leases beyond 64 entries without accepting stale claims", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  const fillerItems = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => {
      const itemNumber = 8000 + index;
      return [
        `openclaw/openclaw#${itemNumber}`,
        leasedExactReviewQueueItem(itemNumber, String(10_000 + index)),
      ];
    }),
  );
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      ...fillerItems,
      "openclaw/openclaw#8065": leasedExactReviewQueueItem(8065, "9901", 2),
      "openclaw/openclaw#8066": leasedExactReviewQueueItem(8066, "9902"),
      "openclaw/openclaw#8067": leasedExactReviewQueueItem(8067, "9903"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9901") {
      return jsonResponse({ id: 9901, run_attempt: 2, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9902") {
      return jsonResponse({ id: 9902, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9902/attempts/1") {
      const claim = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-8066",
            item_key: "openclaw/openclaw#8066",
            lease_revision: 1,
            run_id: "9902",
            run_attempt: 2,
          }),
        }),
      );
      assert.equal(claim.status, 200);
      return jsonResponse({
        id: 9902,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9903") {
      return jsonResponse({ id: 9903, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9903/attempts/1") {
      return jsonResponse({
        id: 9903,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [
        { run_id: "9901", run_attempt: 1 },
        { run_id: "9902", run_attempt: 1 },
        { run_id: "9903", run_attempt: 1 },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requested: 3,
      claimed: 3,
      terminal: 2,
      unavailable: 0,
      reconciled: 1,
      requeued: 1,
      completed: 0,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#8000"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8065"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8065"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#8065"].claimGeneration, 1);
    assert.equal(state.items["openclaw/openclaw#8066"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#8066"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#8066"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#8067"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#8067"].attempts, 1);
    assert.equal(state.items["openclaw/openclaw#8067"].claimedRunId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review reconciliation cannot release a later attempt with the same run id", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#713": leasedExactReviewQueueItem(713, "9010"),
      "openclaw/openclaw#714": {
        ...leasedExactReviewQueueItem(714, "9011"),
        claimedRunAttempt: undefined,
        claimGeneration: 2,
      },
      "openclaw/openclaw#715": leasedExactReviewQueueItem(715, "9012"),
      "openclaw/openclaw#718": leasedExactReviewQueueItem(718, "9013"),
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/openclaw/clawsweeper/installation") {
      return jsonResponse({ id: 999 });
    }
    if (url.pathname === "/app/installations/999/access_tokens") {
      return jsonResponse({ token: "t" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9010") {
      return jsonResponse({ id: 9010, run_attempt: 1, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9010/attempts/1") {
      const claim = await queue.fetch(
        new Request("https://clawsweeper-exact-review-queue/claim", {
          method: "POST",
          body: JSON.stringify({
            lease_id: "lease-713",
            item_key: "openclaw/openclaw#713",
            lease_revision: 1,
            run_id: "9010",
            run_attempt: 2,
          }),
        }),
      );
      assert.equal(claim.status, 200);
      return jsonResponse({
        id: 9010,
        run_attempt: 1,
        status: "completed",
        conclusion: "cancelled",
      });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9011") {
      return jsonResponse({ id: 9011, run_attempt: 2, status: "in_progress", conclusion: null });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9012") {
      return jsonResponse({ id: 9012, run_attempt: 2, status: "queued", conclusion: null });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9013") {
      return jsonResponse({ id: 9013, run_attempt: 2, status: "completed" });
    }
    if (url.pathname === "/repos/openclaw/clawsweeper/actions/runs/9013/attempts/2") {
      return jsonResponse({ id: 9013, run_attempt: 2, status: "completed", conclusion: "failure" });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const env = {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23test",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
      CLAWSWEEPER_WEBHOOK_SECRET: "test-secret",
      EXACT_REVIEW_QUEUE: new MemoryDurableNamespace(queue),
    };
    const body = JSON.stringify({
      runs: [
        { run_id: "9010", run_attempt: 1 },
        { run_id: "9011", run_attempt: 1 },
        { run_id: "9012", run_attempt: 1 },
        { run_id: "9013", run_attempt: 2 },
      ],
    });
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    const response = await worker.fetch(
      new Request("https://clawsweeper.openclaw.ai/internal/exact-review/reconcile", {
        method: "POST",
        headers: { "x-clawsweeper-exact-review-signature": signature },
        body,
      }),
      env,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      requested: 4,
      claimed: 4,
      terminal: 2,
      unavailable: 0,
      reconciled: 1,
      requeued: 1,
      completed: 0,
    });
    const state = (await storage.get("exact-review-queue")) as {
      items: Record<string, Record<string, unknown>>;
    };
    assert.equal(state.items["openclaw/openclaw#713"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#713"].claimedRunId, "9010");
    assert.equal(state.items["openclaw/openclaw#713"].claimedRunAttempt, 2);
    assert.equal(state.items["openclaw/openclaw#713"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#714"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#714"].claimedRunId, "9011");
    assert.equal(state.items["openclaw/openclaw#714"].claimedRunAttempt, undefined);
    assert.equal(state.items["openclaw/openclaw#714"].claimGeneration, 2);
    assert.equal(state.items["openclaw/openclaw#715"].state, "leased");
    assert.equal(state.items["openclaw/openclaw#715"].claimedRunId, "9012");
    assert.equal(state.items["openclaw/openclaw#715"].claimedRunAttempt, 1);
    assert.equal(state.items["openclaw/openclaw#715"].claimGeneration, 1);
    assert.equal(state.items["openclaw/openclaw#718"].state, "pending");
    assert.equal(state.items["openclaw/openclaw#718"].attempts, 1);
    assert.equal(state.items["openclaw/openclaw#718"].claimedRunId, undefined);
    assert.equal(state.items["openclaw/openclaw#718"].reviewRecoveryReason, "workflow_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exact-review stats heals a missing or stale alarm and expired lease", async () => {
  const storage = new MemoryDurableStorage();
  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#700": {
        key: "openclaw/openclaw#700",
        decision: {
          targetRepo: "openclaw/openclaw",
          targetBranch: "main",
          itemNumber: 700,
          itemKind: "pull_request",
          sourceEvent: "pull_request",
          sourceAction: "synchronize",
          supersedesInProgress: true,
        },
        state: "leased",
        revision: 1,
        createdAt: Date.now() - 120_000,
        updatedAt: Date.now() - 120_000,
        nextAttemptAt: Date.now() - 120_000,
        attempts: 0,
        leaseId: "expired-lease",
        leaseRevision: 1,
        leaseExpiresAt: Date.now() - 1,
        claimedRunId: "run-700",
      },
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const response = await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.equal(stats.pending, 1);
  assert.equal(stats.dispatching, 0);
  assert.equal(stats.leased, 0);
  assert.equal(stats.target_stats[0].target_repo, "openclaw/openclaw");
  assert.equal(stats.target_stats[0].pending, 1);
  assert.ok(stats.oldest_pending_age_seconds >= 120);
  assert.equal(stats.oldest_pending_key, "openclaw/openclaw#700");
  assert.equal(stats.lanes.review.oldest_pending_key, "openclaw/openclaw#700");
  assert.equal(stats.handoff_health.recovery_reasons.execution_timeout, 1);
  assert.ok(stats.next_wake_at);
  assert.ok((await storage.getAlarm()) !== null);

  const state = (await storage.get("exact-review-queue")) as {
    deliveries: Record<string, number>;
    items: Record<string, Record<string, unknown>>;
  };
  const activeLeaseExpiry = Date.now() + 60_000;
  state.items["openclaw/openclaw#701"] = {
    key: "openclaw/openclaw#701",
    decision: state.items["openclaw/openclaw#700"].decision,
    state: "leased",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
    leaseId: "active-lease",
    leaseRevision: 1,
    leaseExpiresAt: activeLeaseExpiry,
    claimedRunId: "run-701",
  };
  state.items["openclaw/openclaw#702"] = {
    key: "openclaw/openclaw#702",
    decision: {
      ...state.items["openclaw/openclaw#700"].decision,
      itemNumber: 702,
    },
    state: "pending",
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    attempts: 0,
  };
  await storage.put("exact-review-queue", state);
  await storage.setAlarm(Date.now() + 1_000);
  const scheduledBeforePoll = await storage.getAlarm();
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const scheduledAfterPoll = await storage.getAlarm();
  assert.ok(scheduledBeforePoll !== null && scheduledAfterPoll !== null);
  assert.ok(scheduledAfterPoll <= scheduledBeforePoll);

  await storage.setAlarm(Date.now() - 1_000);
  const staleAlarmPollStartedAt = Date.now();
  await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"));
  const rescheduledAlarm = await storage.getAlarm();
  assert.ok(rescheduledAlarm !== null && rescheduledAlarm > staleAlarmPollStartedAt);
});

test("exact-review queue drops an expired failed-shard recovery unless a newer revision superseded it", async () => {
  const storage = new MemoryDurableStorage();
  const expiredRecovery = leasedExactReviewQueueItem(702, "7020");
  expiredRecovery.decision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  expiredRecovery.leaseExpiresAt = Date.now() - 1;

  const supersededRecovery = leasedExactReviewQueueItem(703, "7030");
  supersededRecovery.leaseDecision.sourceAction = "failed_review_shard_recovery";
  supersededRecovery.decision.sourceAction = "edited";
  supersededRecovery.decision.supersedesInProgress = true;
  supersededRecovery.revision = 2;
  supersededRecovery.leaseExpiresAt = Date.now() - 1;

  await storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      "openclaw/openclaw#702": expiredRecovery,
      "openclaw/openclaw#703": supersededRecovery,
    },
  });
  const queue = new ExactReviewQueue({ storage }, {});

  const stats = await (
    await queue.fetch(new Request("https://clawsweeper-exact-review-queue/stats"))
  ).json();
  assert.equal(stats.pending, 1);
  const state = (await storage.get("exact-review-queue")) as {
    items: Record<string, { state: string; attempts: number; decision: { sourceAction: string } }>;
  };
  assert.equal(state.items["openclaw/openclaw#702"], undefined);
  assert.equal(state.items["openclaw/openclaw#703"].state, "pending");
  assert.equal(state.items["openclaw/openclaw#703"].attempts, 0);
  assert.equal(state.items["openclaw/openclaw#703"].decision.sourceAction, "edited");
});
