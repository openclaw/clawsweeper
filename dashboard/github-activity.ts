import {
  normalizeGithubActivity,
  renderGithubActivityMessage,
  routineGithubActivityReason,
} from "../src/repair/github-activity.ts";
import {
  isConclusiveHookDelivery,
  postOpenClawAgentHook,
  resolveOpenClawHookConfig,
} from "../src/repair/openclaw-hook.ts";

export type GithubActivityEnv = Record<string, string | undefined>;

// These are the App's subscribed events, not every event the normalizer supports.
const WEBHOOK_EVENTS: Record<string, true> = {
  issues: true,
  issue_comment: true,
  pull_request: true,
};

export function githubWebhookActivityEnabled(env: GithubActivityEnv, event: string): boolean {
  return env.CLAWSWEEPER_GITHUB_ACTIVITY_FROM_WEBHOOK === "1" && WEBHOOK_EVENTS[event] === true;
}

export async function forwardGithubWebhookActivity(
  input: {
    event: string;
    payload: unknown;
    deliveryId: string | null;
    env: GithubActivityEnv;
    admitRetry: () => Promise<boolean>;
  },
  options: {
    fetch?: typeof fetch;
    now?: () => Date;
    log?: (value: unknown) => void;
  } = {},
): Promise<void> {
  if (!githubWebhookActivityEnabled(input.env, input.event)) {
    return;
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  let attempts = 0;
  let hookStatus: number | null = null;
  let admissionRevoked = false;
  const activity = normalizeGithubActivity({
    eventName: input.event,
    payload: input.payload,
    deliveryId: input.deliveryId ?? "",
  });
  if (!activity) return;
  const log = options.log ?? ((value: unknown) => console.log(JSON.stringify(value)));
  const record = (outcome: string, reason?: string) =>
    log({
      event: "github_activity_hook",
      source_event: input.event,
      delivery_id: input.deliveryId,
      repository: activity.repo,
      item_number: activity.subject.number,
      hook_status: hookStatus,
      attempts,
      duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
      outcome,
      ...(reason ? { reason } : {}),
    });
  if (!input.deliveryId) {
    record("failed", "missing_delivery_id");
    return;
  }
  const reason = routineGithubActivityReason(activity);
  if (reason) {
    record("filtered", reason);
    return;
  }
  try {
    const config = resolveOpenClawHookConfig(input.env);
    if (!config) {
      record("failed", "hook_not_configured");
      return;
    }
    const deadline = AbortSignal.timeout(25_000);
    const result = await postOpenClawAgentHook({
      config: { ...config, retryAttempts: 2 },
      fetcher: async (request, init) => {
        if (attempts > 0 && !(await input.admitRetry())) {
          admissionRevoked = true;
          throw new Error("activity_retry_admission_revoked");
        }
        deadline.throwIfAborted();
        attempts += 1;
        const response = await (options.fetch ?? fetch)(request, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
        });
        hookStatus = response.status;
        return response;
      },
      // The overall 25s hook deadline includes retry admission checks; no hook
      // POST starts after it, leaving headroom in the 30s waitUntil lifetime.
      fetchTimeoutMs: 12_000,
      retryDelaysMs: [1_000],
      post: {
        name: `GitHub ${activity.type} ${activity.repo}`,
        message: renderGithubActivityMessage(activity, {
          discordTarget: config.discordTarget,
          observedAt: startedAt.toISOString(),
        }),
        idempotencyKey: activity.idempotencyKey,
        deliver: false,
      },
    });
    record(isConclusiveHookDelivery(result.delivery) ? result.delivery.status : "failed");
  } catch {
    // Never log the request, hook URL/token, or untrusted response body.
    record("failed", admissionRevoked ? "target_admission_changed" : "hook_request_failed");
  }
}
