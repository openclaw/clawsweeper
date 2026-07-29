import { createHmac } from "node:crypto";

export type StateAppendInputRecord = {
  kind: "sweep_status" | "comment_router" | "apply_proof" | "cluster_intake";
  key: string;
  payload: unknown;
  produced_at: string;
};

export type StateAppendResult = {
  ok: boolean;
  shed: boolean;
  deduped: boolean;
};

export type CanonicalRecordTupleOperation = {
  path: string;
  expectedDigest: string | null;
  contentBase64?: string;
};

export type CanonicalRecordTupleMutation = {
  deliveryId: string;
  key: string;
  operations: CanonicalRecordTupleOperation[];
};

export type CanonicalRecordTupleConflictState = {
  key: string;
  revision: number;
  deliveryId: string | null;
  operations: CanonicalRecordTupleOperation[];
};

export class CanonicalRecordTupleConflictError extends Error {
  readonly current: CanonicalRecordTupleConflictState | null;

  constructor(current: CanonicalRecordTupleConflictState | null) {
    super("POST /internal/state/records/tuples returned 409: canonical_record_tuple_conflict");
    this.name = "CanonicalRecordTupleConflictError";
    this.current = current;
  }
}

export class CanonicalRecordTupleRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`POST /internal/state/records/tuples returned ${status}: ${code}`);
    this.name = "CanonicalRecordTupleRequestError";
    this.status = status;
    this.code = code;
  }
}

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
    if (isRecord(value) && value.shed === true) return { ok: false, shed: true, deduped: false };
    if (!response.ok) {
      throw new Error(`POST /internal/state/append returned ${response.status}`);
    }
    if (!isRecord(value) || typeof value.ok !== "boolean") {
      throw new Error("POST /internal/state/append returned an invalid response");
    }
    return { ok: value.ok, shed: false, deduped: value.deduped === true };
  } catch (error) {
    throw new Error(redactStateAppendSecrets(errorMessage(error)));
  }
}

export async function postCanonicalRecordTuple(options: {
  queueUrl: string;
  webhookSecret: string;
  mutation: CanonicalRecordTupleMutation;
  fetchImpl?: typeof fetch;
}): Promise<{ revision: number; sequence: number; deduped: boolean }> {
  registerStateAppendSecretForRedaction(options.webhookSecret);
  try {
    const queueUrl = options.queueUrl.replace(/\/+$/, "");
    if (!queueUrl) throw new Error("canonical record queue URL is required");
    if (!options.webhookSecret) throw new Error("canonical record webhook secret is required");
    const body = JSON.stringify(options.mutation);
    const signature = `sha256=${createHmac("sha256", options.webhookSecret)
      .update(body)
      .digest("hex")}`;
    const response = await (options.fetchImpl ?? fetch)(
      `${queueUrl}/internal/state/records/tuples`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature": signature,
        },
        body,
      },
    );
    const value = (await response.json().catch(() => null)) as unknown;
    const responseRecord = isRecord(value) ? value : null;
    if (!response.ok || !responseRecord || responseRecord.ok !== true) {
      const code = responseRecord
        ? String(responseRecord.error || "unknown_error")
        : "invalid_response";
      if (response.status === 409 && code === "canonical_record_tuple_conflict") {
        throw new CanonicalRecordTupleConflictError(parseConflictState(responseRecord?.current));
      }
      throw new CanonicalRecordTupleRequestError(response.status, code);
    }
    const revision = Number(responseRecord.revision);
    const sequence = Number(responseRecord.sequence);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      throw new Error("POST /internal/state/records/tuples returned an invalid receipt");
    }
    return { revision, sequence, deduped: responseRecord.deduped === true };
  } catch (error) {
    if (
      error instanceof CanonicalRecordTupleConflictError ||
      error instanceof CanonicalRecordTupleRequestError
    ) {
      throw error;
    }
    throw new Error(redactStateAppendSecrets(errorMessage(error)));
  }
}

function parseConflictState(value: unknown): CanonicalRecordTupleConflictState | null {
  if (!isRecord(value)) return null;
  const key = typeof value.key === "string" ? value.key : "";
  const revision = Number(value.revision);
  const deliveryId =
    value.deliveryId === null || typeof value.deliveryId === "string"
      ? value.deliveryId
      : undefined;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\/[1-9]\d*$/.test(key) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    deliveryId === undefined ||
    !Array.isArray(value.operations) ||
    value.operations.length !== 4
  ) {
    return null;
  }
  const operations: CanonicalRecordTupleOperation[] = [];
  for (const raw of value.operations) {
    if (!isRecord(raw) || typeof raw.path !== "string") return null;
    const expectedDigest = raw.expectedDigest;
    if (expectedDigest !== null && !/^[a-f0-9]{64}$/.test(String(expectedDigest))) return null;
    if (raw.contentBase64 !== undefined && typeof raw.contentBase64 !== "string") return null;
    operations.push({
      path: raw.path,
      expectedDigest: expectedDigest === null ? null : String(expectedDigest),
      ...(typeof raw.contentBase64 === "string" ? { contentBase64: raw.contentBase64 } : {}),
    });
  }
  return { key, revision, deliveryId, operations };
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
