import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";

import { finishDetachedCleanupProcess } from "./detached-cleanup.js";

const COORDINATOR_POLL_MS = 1_000;
const COORDINATOR_HEARTBEAT_MS = 30_000;
const COORDINATOR_REQUEST_TIMEOUT_MS = 10_000;
const COORDINATOR_AMBIGUOUS_REQUEST_LIMIT = 3;

export type StateWriterCoordinatorTicket = {
  ticketId: string;
  owner: string;
  leaseToken: string;
  leaseGeneration: number;
  leaseExpiresAt: number;
  leaseDeadlineAt: number;
  seq: number;
};

export type StateWriterCoordinatorGuard = {
  ticket: StateWriterCoordinatorTicket;
  assertActive: () => void;
  release: () => boolean;
};

type CoordinatorResponse = {
  ok?: boolean;
  released?: boolean;
  error?: string;
  ticket?: {
    seq?: number;
    ticketId?: string;
    owner?: string;
    state?: string;
    leaseToken?: string | null;
    leaseGeneration?: number;
    leaseExpiresAt?: number | null;
    leaseDeadlineAt?: number | null;
    position?: number;
  };
};

type CoordinatorRuntime = {
  request?: (path: string, payload: unknown) => CoordinatorResponse;
  sleep?: (milliseconds: number) => void;
  startWatchdog?: (ticket: StateWriterCoordinatorTicket) => {
    close: (ownershipReleased: boolean) => void;
  };
  onAcquireAttempt?: () => void;
};

export function stateWriterCoordinatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAWSWEEPER_STATE_COORDINATOR_ENABLED === "1";
}

export function acquireStateWriterCoordinator(
  branch: string,
  runtime: CoordinatorRuntime = {},
  env: NodeJS.ProcessEnv = process.env,
): StateWriterCoordinatorGuard | null {
  if (!stateWriterCoordinatorEnabled(env)) return null;
  const config = coordinatorConfig(env);
  const owner = randomUUID();
  const ticketId = `state-writer:${randomUUID()}`;
  const request = runtime.request ?? signedCoordinatorRequest(config);
  const sleep = runtime.sleep ?? sleepSync;
  let lastPosition: number | null = null;
  let ambiguousRequestFailures = 0;

  while (true) {
    let response: CoordinatorResponse;
    try {
      runtime.onAcquireAttempt?.();
      response = request("/internal/state-writer/acquire", {
        ticket_id: ticketId,
        owner,
        branch,
        repository: env.GITHUB_REPOSITORY || "local/clawsweeper",
        workflow: env.GITHUB_WORKFLOW || "local",
        job: env.GITHUB_JOB || "local",
        run_id: env.GITHUB_RUN_ID || "local",
        run_attempt: positiveInteger(env.GITHUB_RUN_ATTEMPT, 1),
        writer_class:
          env.CLAWSWEEPER_STATE_COORDINATOR_CLASS === "publication_batch"
            ? "publication_batch"
            : "ordinary",
      });
      ambiguousRequestFailures = 0;
    } catch (error) {
      ambiguousRequestFailures += 1;
      if (ambiguousRequestFailures >= COORDINATOR_AMBIGUOUS_REQUEST_LIMIT) {
        throw new Error(
          `state writer coordinator acquire could not recover its durable ticket: ${errorMessage(error)}`,
        );
      }
      // Re-read the same ticket identity. The prior request may have committed
      // in the Durable Object even though its response never reached this runner.
      console.log(
        `State writer ticket acquire response was ambiguous; recovering the same durable identity attempt=${ambiguousRequestFailures}`,
      );
      sleep(COORDINATOR_POLL_MS);
      continue;
    }
    const ticket = response.ticket;
    if (!response.ok || !ticket) {
      throw new Error(
        `state writer coordinator acquire failed: ${response.error || "invalid response"}`,
      );
    }
    if (ticket.state === "leased") {
      const acquired = normalizeTicket(ticket, ticketId, owner);
      console.log(
        `Acquired durable state writer ticket seq=${acquired.seq} run=${env.GITHUB_RUN_ID || "local"} workflow=${env.GITHUB_WORKFLOW || "local"}`,
      );
      const watchdog =
        runtime.startWatchdog?.(acquired) ?? startCoordinatorWatchdog(config, acquired);
      let released = false;
      return {
        ticket: acquired,
        assertActive: () => {
          if (released) throw new Error("durable state writer ticket was already released");
          const heartbeat = request("/internal/state-writer/heartbeat", ticketPayload(acquired));
          if (!heartbeat.ok || !heartbeat.ticket) {
            throw new Error(
              `durable state writer ticket lost ownership: ${heartbeat.error || "invalid response"}`,
            );
          }
          const refreshed = normalizeTicket(heartbeat.ticket, ticketId, owner);
          if (
            refreshed.leaseToken !== acquired.leaseToken ||
            refreshed.leaseGeneration !== acquired.leaseGeneration ||
            refreshed.seq !== acquired.seq
          ) {
            throw new Error("durable state writer ticket changed ownership generation");
          }
          acquired.leaseExpiresAt = refreshed.leaseExpiresAt;
          acquired.leaseDeadlineAt = refreshed.leaseDeadlineAt;
        },
        release: () => {
          if (released) return true;
          let releaseSucceeded = false;
          try {
            const result = request("/internal/state-writer/release", ticketPayload(acquired));
            releaseSucceeded = result.ok === true && result.released === true;
            released = releaseSucceeded;
            console.log(
              releaseSucceeded
                ? `Released durable state writer ticket seq=${acquired.seq}`
                : `Durable state writer ticket release deferred to stale-owner recovery seq=${acquired.seq}`,
            );
          } catch (error) {
            console.log(
              `Durable state writer ticket release failed; stale-owner recovery remains armed: ${errorMessage(error)}`,
            );
          } finally {
            watchdog.close(releaseSucceeded);
          }
          return releaseSucceeded;
        },
      };
    }
    if (ticket.state !== "queued") {
      throw new Error(`state writer coordinator returned terminal ticket state ${ticket.state}`);
    }
    const position = Number(ticket.position || 0);
    if (position !== lastPosition) {
      console.log(`Queued durable state writer ticket position=${position} seq=${ticket.seq}`);
      lastPosition = position;
    }
    sleep(COORDINATOR_POLL_MS);
  }
}

function coordinatorConfig(env: NodeJS.ProcessEnv) {
  const queueUrl = String(env.CLAWSWEEPER_STATE_COORDINATOR_URL || env.QUEUE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const rawCredential =
    env.CLAWSWEEPER_STATE_COORDINATOR_SECRET || env.CLAWSWEEPER_WEBHOOK_SECRET || "";
  const secret = String(rawCredential);
  if (!/^https?:\/\//.test(queueUrl)) {
    throw new Error("state writer coordinator URL is required when coordinator mode is enabled");
  }
  if (!secret) {
    throw new Error("state writer coordinator secret is required when coordinator mode is enabled");
  }
  return { queueUrl, secret };
}

function signedCoordinatorRequest(config: { queueUrl: string; secret: string }) {
  return (path: string, payload: unknown): CoordinatorResponse => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", config.secret).update(body).digest("hex")}`;
    const script = String.raw`
      const [url, body, signature, timeoutText] = process.argv.slice(1);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(timeoutText));
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": signature,
          },
          body,
          signal: controller.signal,
        });
        const text = await response.text();
        process.stdout.write(JSON.stringify({ status: response.status, body: text }));
      } finally {
        clearTimeout(timer);
      }
    `;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        `${config.queueUrl}${path}`,
        body,
        signature,
        String(COORDINATOR_REQUEST_TIMEOUT_MS),
      ],
      { encoding: "utf8", timeout: COORDINATOR_REQUEST_TIMEOUT_MS + 2_000, windowsHide: true },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        result.stderr.trim() || `state writer coordinator request exited ${result.status}`,
      );
    }
    const envelope = JSON.parse(result.stdout) as { status?: number; body?: string };
    const response = JSON.parse(String(envelope.body || "null")) as CoordinatorResponse;
    if (!Number.isInteger(envelope.status) || Number(envelope.status) >= 500) {
      throw new Error(`state writer coordinator returned ${envelope.status || "invalid status"}`);
    }
    return response;
  };
}

function startCoordinatorWatchdog(
  config: { queueUrl: string; secret: string },
  ticket: StateWriterCoordinatorTicket,
): { close: (ownershipReleased: boolean) => void } {
  const payload = JSON.stringify(ticketPayload(ticket));
  const heartbeatSignature = `sha256=${createHmac("sha256", config.secret)
    .update(payload)
    .digest("hex")}`;
  const releaseSignature = heartbeatSignature;
  const script = String.raw`
    const [baseUrl, payload, heartbeatSignature, releaseSignature, intervalText] =
      process.argv.slice(1);
    const post = async (path, signature) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        await fetch(baseUrl + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-clawsweeper-exact-review-signature": signature,
          },
          body: payload,
          signal: controller.signal,
        });
      } catch {}
      finally { clearTimeout(timer); }
    };
    const interval = setInterval(
      () => void post("/internal/state-writer/heartbeat", heartbeatSignature),
      Number(intervalText),
    );
    process.stdin.resume();
    process.stdin.on("end", async () => {
      clearInterval(interval);
      await post("/internal/state-writer/release", releaseSignature);
      process.exit(0);
    });
  `;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      config.queueUrl,
      payload,
      heartbeatSignature,
      releaseSignature,
      String(COORDINATOR_HEARTBEAT_MS),
    ],
    { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
  );
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.unref();
  let closed = false;
  return {
    close: (ownershipReleased) => {
      if (closed) return;
      closed = true;
      finishDetachedCleanupProcess(child, ownershipReleased);
    },
  };
}

function normalizeTicket(
  ticket: NonNullable<CoordinatorResponse["ticket"]>,
  ticketId: string,
  owner: string,
): StateWriterCoordinatorTicket {
  if (
    ticket.ticketId !== ticketId ||
    ticket.owner !== owner ||
    ticket.state !== "leased" ||
    typeof ticket.leaseToken !== "string" ||
    !ticket.leaseToken ||
    !Number.isSafeInteger(ticket.leaseGeneration) ||
    Number(ticket.leaseGeneration) < 1 ||
    !Number.isFinite(ticket.leaseExpiresAt) ||
    !Number.isFinite(ticket.leaseDeadlineAt) ||
    Number(ticket.leaseExpiresAt) > Number(ticket.leaseDeadlineAt) ||
    !Number.isSafeInteger(ticket.seq) ||
    Number(ticket.seq) < 1
  ) {
    throw new Error("state writer coordinator returned an invalid ownership ticket");
  }
  return {
    ticketId,
    owner,
    leaseToken: String(ticket.leaseToken),
    leaseGeneration: Number(ticket.leaseGeneration),
    leaseExpiresAt: Number(ticket.leaseExpiresAt),
    leaseDeadlineAt: Number(ticket.leaseDeadlineAt),
    seq: Number(ticket.seq),
  };
}

function ticketPayload(ticket: StateWriterCoordinatorTicket) {
  return {
    ticket_id: ticket.ticketId,
    owner: ticket.owner,
    lease_token: String(ticket.leaseToken),
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
