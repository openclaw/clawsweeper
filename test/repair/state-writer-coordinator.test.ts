import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireStateWriterCoordinator,
  stateWriterCoordinatorEnabled,
} from "../../dist/repair/state-writer-coordinator.js";

type RequestPayload = {
  ticket_id: string;
  owner: string;
  branch?: string;
  repository?: string;
  workflow?: string;
  job?: string;
  run_id?: string;
  run_attempt?: number;
  lease_token?: string;
};

const COORDINATOR_HMAC_FIXTURE = "test-clawsweeper-state-coordinator-secret";
const enabledEnv = {
  CLAWSWEEPER_STATE_COORDINATOR_ENABLED: "1",
  CLAWSWEEPER_STATE_COORDINATOR_URL: "https://coordinator.example.test",
  ["CLAWSWEEPER_STATE_COORDINATOR_SECRET"]: COORDINATOR_HMAC_FIXTURE,
  GITHUB_REPOSITORY: "openclaw/clawsweeper",
  GITHUB_WORKFLOW: "Exact review batch publish",
  GITHUB_JOB: "publish",
  GITHUB_RUN_ID: "12345",
  GITHUB_RUN_ATTEMPT: "2",
} satisfies NodeJS.ProcessEnv;

test("state writer coordinator is disabled by default before configuration is inspected", () => {
  let requested = false;
  assert.equal(stateWriterCoordinatorEnabled({}), false);
  assert.equal(
    acquireStateWriterCoordinator(
      "state",
      {
        request() {
          requested = true;
          throw new Error("must not request");
        },
      },
      {},
    ),
    null,
  );
  assert.equal(requested, false);
});

test("enabled coordinator mode fails closed when URL or secret is missing", () => {
  assert.throws(
    () =>
      acquireStateWriterCoordinator("state", {}, { CLAWSWEEPER_STATE_COORDINATOR_ENABLED: "1" }),
    /coordinator URL is required/,
  );
  assert.throws(
    () =>
      acquireStateWriterCoordinator(
        "state",
        {},
        {
          CLAWSWEEPER_STATE_COORDINATOR_ENABLED: "1",
          CLAWSWEEPER_STATE_COORDINATOR_URL: "https://coordinator.example.test",
        },
      ),
    /coordinator secret is required/,
  );
});

test("queued polling preserves one durable identity through heartbeat and release", () => {
  const acquirePayloads: RequestPayload[] = [];
  const paths: string[] = [];
  const sleeps: number[] = [];
  const watchdogCloses: boolean[] = [];
  const guard = required(
    acquireStateWriterCoordinator(
      "state",
      {
        request(path, rawPayload) {
          paths.push(path);
          const payload = requestPayload(rawPayload);
          if (path === "/internal/state-writer/acquire") {
            acquirePayloads.push(payload);
            if (acquirePayloads.length === 1) return queued(payload, 2);
            return leased(payload, { leaseExpiresAt: 20_000, leaseDeadlineAt: 30_000 });
          }
          if (path === "/internal/state-writer/heartbeat") {
            return leased(payload, { leaseExpiresAt: 21_000, leaseDeadlineAt: 30_000 });
          }
          assert.equal(path, "/internal/state-writer/release");
          return { ok: true, released: true };
        },
        sleep(milliseconds) {
          sleeps.push(milliseconds);
        },
        startWatchdog() {
          return { close: (released) => watchdogCloses.push(released) };
        },
      },
      enabledEnv,
    ),
  );

  assert.equal(acquirePayloads.length, 2);
  assert.equal(acquirePayloads[0]?.ticket_id, acquirePayloads[1]?.ticket_id);
  assert.equal(acquirePayloads[0]?.owner, acquirePayloads[1]?.owner);
  assert.deepEqual(
    pick(required(acquirePayloads[0]), [
      "branch",
      "repository",
      "workflow",
      "job",
      "run_id",
      "run_attempt",
    ]),
    {
      branch: "state",
      repository: "openclaw/clawsweeper",
      workflow: "Exact review batch publish",
      job: "publish",
      run_id: "12345",
      run_attempt: 2,
    },
  );
  assert.deepEqual(sleeps, [1_000]);

  guard.assertActive();
  assert.equal(guard.ticket.leaseExpiresAt, 21_000);
  assert.equal(guard.release(), true);
  assert.equal(guard.release(), true);
  assert.equal(paths.filter((path) => path.endsWith("/release")).length, 1);
  assert.deepEqual(watchdogCloses, [true]);
});

test("an ambiguous acquire response rereads the same durable ticket identity", () => {
  const payloads: RequestPayload[] = [];
  const sleeps: number[] = [];
  let attempts = 0;
  const guard = required(
    acquireStateWriterCoordinator(
      "state",
      {
        onAcquireAttempt() {
          attempts += 1;
        },
        request(path, rawPayload) {
          const payload = requestPayload(rawPayload);
          if (path === "/internal/state-writer/acquire") {
            payloads.push(payload);
            if (payloads.length === 1) throw new Error("response lost after durable insert");
            return leased(payload);
          }
          return { ok: true, released: true };
        },
        sleep(milliseconds) {
          sleeps.push(milliseconds);
        },
        startWatchdog() {
          return { close() {} };
        },
      },
      enabledEnv,
    ),
  );

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [1_000]);
  assert.equal(payloads[0]?.ticket_id, payloads[1]?.ticket_id);
  assert.equal(payloads[0]?.owner, payloads[1]?.owner);
  assert.equal(guard.release(), true);
});

test("heartbeat ownership changes fence the acquired writer", () => {
  let acquiredPayload: RequestPayload | undefined;
  const guard = required(
    acquireStateWriterCoordinator(
      "state",
      {
        request(path, rawPayload) {
          const payload = requestPayload(rawPayload);
          if (path === "/internal/state-writer/acquire") {
            acquiredPayload = payload;
            return leased(payload);
          }
          if (path === "/internal/state-writer/heartbeat") {
            return leased(payload, { leaseToken: "fixture-lease-token", leaseGeneration: 2 });
          }
          return { ok: true, released: true };
        },
        startWatchdog() {
          return { close() {} };
        },
      },
      enabledEnv,
    ),
  );

  assert.ok(acquiredPayload);
  assert.throws(() => guard.assertActive(), /changed ownership generation/);
  assert.equal(guard.release(), true);
});

test("a failed release remains retryable until the coordinator acknowledges it", () => {
  let releaseAttempts = 0;
  const watchdogCloses: boolean[] = [];
  let watchdogClosed = false;
  const guard = required(
    acquireStateWriterCoordinator(
      "state",
      {
        request(path, rawPayload) {
          const payload = requestPayload(rawPayload);
          if (path === "/internal/state-writer/acquire") return leased(payload);
          assert.equal(path, "/internal/state-writer/release");
          releaseAttempts += 1;
          if (releaseAttempts === 1) throw new Error("release response lost");
          return { ok: true, released: true };
        },
        startWatchdog() {
          return {
            close(released) {
              if (watchdogClosed) return;
              watchdogClosed = true;
              watchdogCloses.push(released);
            },
          };
        },
      },
      enabledEnv,
    ),
  );

  assert.equal(guard.release(), false);
  assert.equal(guard.release(), true);
  assert.equal(guard.release(), true);
  assert.equal(releaseAttempts, 2);
  assert.deepEqual(watchdogCloses, [false]);
});

function requestPayload(value: unknown): RequestPayload {
  assert.ok(value && typeof value === "object");
  const payload = value as RequestPayload;
  assert.equal(typeof payload.ticket_id, "string");
  assert.equal(typeof payload.owner, "string");
  return payload;
}

function queued(payload: RequestPayload, position: number) {
  return {
    ok: true,
    ticket: {
      seq: 7,
      ticketId: payload.ticket_id,
      owner: payload.owner,
      state: "queued",
      leaseToken: null,
      leaseGeneration: 0,
      leaseExpiresAt: null,
      leaseDeadlineAt: null,
      position,
    },
  };
}

function leased(
  payload: RequestPayload,
  overrides: {
    leaseToken?: string;
    leaseGeneration?: number;
    leaseExpiresAt?: number;
    leaseDeadlineAt?: number;
  } = {},
) {
  return {
    ok: true,
    ticket: {
      seq: 7,
      ticketId: payload.ticket_id,
      owner: payload.owner,
      state: "leased",
      ["leaseToken"]: overrides.leaseToken ?? payload.lease_token ?? "test-lease-token",
      leaseGeneration: overrides.leaseGeneration ?? 1,
      leaseExpiresAt: overrides.leaseExpiresAt ?? 20_000,
      leaseDeadlineAt: overrides.leaseDeadlineAt ?? 30_000,
      position: 0,
    },
  };
}

function required<T>(value: T | null | undefined): T {
  assert.notEqual(value, null);
  assert.notEqual(value, undefined);
  return value as T;
}

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as Pick<T, K>;
}
