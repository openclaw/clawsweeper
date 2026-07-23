import { createHmac } from "node:crypto";

export type StateAppendInputRecord = {
  kind: "sweep_status" | "comment_router" | "apply_proof";
  key: string;
  payload: unknown;
  produced_at: string;
};

export type StateAppendResult = {
  ok: boolean;
  shed: boolean;
};

export async function postStateAppend(options: {
  queueUrl: string;
  webhookSecret: string;
  deliveryId: string;
  records: readonly StateAppendInputRecord[];
  fetchImpl?: typeof fetch;
}): Promise<StateAppendResult> {
  registerStateAppendSecretForRedaction(options.webhookSecret);
  try {
    const queueUrl = options.queueUrl.replace(/\/+$/, "");
    if (!queueUrl) throw new Error("state append queue URL is required");
    if (!options.webhookSecret) throw new Error("state append webhook secret is required");
    if (!options.deliveryId) throw new Error("state append delivery ID is required");
    if (options.records.length === 0) throw new Error("state append records are required");

    const body = JSON.stringify({
      delivery_id: options.deliveryId,
      records: options.records,
    });
    const signature = `sha256=${createHmac("sha256", options.webhookSecret)
      .update(body)
      .digest("hex")}`;
    const response = await (options.fetchImpl ?? fetch)(`${queueUrl}/internal/state/append`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature": signature,
      },
      body,
    });
    const value = (await response.json().catch(() => null)) as unknown;
    if (isRecord(value) && value.shed === true) return { ok: false, shed: true };
    if (!response.ok) {
      throw new Error(`POST /internal/state/append returned ${response.status}`);
    }
    if (!isRecord(value) || typeof value.ok !== "boolean") {
      throw new Error("POST /internal/state/append returned an invalid response");
    }
    return { ok: value.ok, shed: false };
  } catch (error) {
    throw new Error(redactStateAppendSecrets(errorMessage(error)));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let stateAppendSecretsToRedact: string[] = [];

function registerStateAppendSecretForRedaction(secret: string): void {
  if (secret && !stateAppendSecretsToRedact.includes(secret)) {
    stateAppendSecretsToRedact.push(secret);
  }
}

// Error text can transit request internals; never let a registered secret
// value reach the log stream in clear text.
function redactStateAppendSecrets(message: string): string {
  let redacted = message;
  for (const secret of stateAppendSecretsToRedact) {
    redacted = redacted.split(secret).join("<redacted>");
  }
  return redacted;
}
