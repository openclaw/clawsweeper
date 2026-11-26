import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  prepareSafeReadRoot,
  prepareSafeWriteTarget,
  writeUtf8FileExclusiveNoFollow,
} from "./action-ledger-files.js";
import {
  ACTION_EVENT_IMPORT_BINDING_MAX_BYTES,
  ACTION_EVENT_SHARD_IMPORT_LIMITS,
  actionEventPublicationPaths,
  actionEventShardImportBindings,
  readImportedActionEventShards,
} from "./action-ledger-import.js";
import {
  ACTION_EVENT_SHARD_FILE_LIMITS,
  actionEventShardImportBindingRelativePaths,
  actionLedgerJson,
  parseActionEventShardImportCompletion,
  parseActionEventShardImportReservation,
} from "./action-ledger.js";
import { sha256 } from "./content-hash.js";
import { readReviewUsageReport } from "./review-usage-report.js";
import { isRecord } from "./value-coerce.js";

export const REVIEW_USAGE_EXPORT_LIMITS = {
  requests: 128,
  listPages: 32,
  metadataBytes: 8 * 1024 * 1024,
  payloadBytes: 16 * 1024 * 1024,
  deadlineMs: 120_000,
} as const;

type Limits = { [Key in keyof typeof REVIEW_USAGE_EXPORT_LIMITS]: number };
type Descriptor = { path: string; bytes: number; digest: string };

/** Export one closed native full-review producer, never an entire ledger tree. */
export async function exportReviewUsage(options: {
  runId: string;
  runAttempt: number;
  sourceSha: string;
  partitionDate: string;
  output: string;
  webhookSecret: string;
  fetchImpl?: typeof fetch;
  limits?: Partial<Limits>;
}) {
  function incomplete(reason: string, cause?: unknown): never {
    throw new Error(`review usage export incomplete (${reason})`, { cause });
  }
  const limits: Limits = { ...REVIEW_USAGE_EXPORT_LIMITS, ...options.limits };
  for (const key of Object.keys(limits) as Array<keyof Limits>) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] <= 0 ||
      limits[key] > REVIEW_USAGE_EXPORT_LIMITS[key]
    )
      incomplete("invalid_budget");
  }
  if (
    !/^[1-9]\d{0,31}$/.test(options.runId) ||
    !Number.isSafeInteger(options.runAttempt) ||
    options.runAttempt < 1 ||
    !/^[0-9a-f]{40}$/.test(options.sourceSha) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.partitionDate) ||
    !Number.isFinite(Date.parse(`${options.partitionDate}T00:00:00Z`)) ||
    new Date(`${options.partitionDate}T00:00:00Z`).toISOString().slice(0, 10) !==
      options.partitionDate
  )
    incomplete("invalid_producer_selector");
  if (!options.webhookSecret) incomplete("missing_webhook_secret");

  const output = resolve(options.output);
  prepareSafeReadRoot(dirname(output), "private export parent");
  const controller = new AbortController();
  const expires = performance.now() + limits.deadlineMs;
  const timer = setTimeout(() => controller.abort("deadline"), limits.deadlineMs);
  const spent = { requests: 0, metadataBytes: 0, payloadBytes: 0 };
  const checkTime = () => {
    if (controller.signal.aborted)
      incomplete(controller.signal.reason === "byte_budget" ? "byte_budget" : "deadline");
    if (performance.now() >= expires) {
      controller.abort("deadline");
      incomplete("deadline");
    }
  };
  let created = false;
  try {
    // An existing destination belongs to its caller. Only this exclusive private
    // root is disposable; canonical ledger paths appear after closure validates.
    mkdirSync(output, { mode: 0o700 });
    created = true;
    const stage = realpathSync(mkdtempSync(join(output, ".staging-")));
    const saved = new Map<string, string>();

    async function request(
      operation: "list" | "stat" | "chunk",
      body: Record<string, unknown>,
      maxBytes: number,
    ) {
      checkTime();
      if (spent.requests >= limits.requests) incomplete("request_budget");
      spent.requests += 1;
      const text = JSON.stringify(body);
      let response: Response;
      try {
        // No automatic retries or redirects: every physical request and response
        // is charged to this export's single monotonic budget, including errors.
        response = await (options.fetchImpl ?? fetch)(
          `https://clawsweeper.openclaw.ai/internal/state/blobs/${operation}`,
          {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              "x-clawsweeper-exact-review-signature": `sha256=${createHmac("sha256", options.webhookSecret).update(text).digest("hex")}`,
            },
            body: text,
          },
        );
      } catch (error) {
        checkTime();
        return incomplete("request_failed", error);
      }
      const category = operation === "chunk" ? "payloadBytes" : "metadataBytes";
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      if (!reader) incomplete("missing_body");
      try {
        while (true) {
          checkTime();
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          spent[category] += next.value.byteLength;
          if (bytes > maxBytes || spent[category] > limits[category]) {
            controller.abort("byte_budget");
            incomplete("byte_budget");
          }
          chunks.push(next.value);
        }
      } catch (error) {
        checkTime();
        return incomplete("response_failed", error);
      } finally {
        reader.releaseLock();
      }
      checkTime();
      if (!response.ok) incomplete(`http_${response.status}`);
      return { response, bytes: Buffer.concat(chunks, bytes) };
    }

    async function metadata(operation: "list" | "stat", body: Record<string, unknown>) {
      const result = await request(operation, body, limits.metadataBytes);
      const value: unknown = JSON.parse(result.bytes.toString("utf8"));
      if (!isRecord(value) || value.ok !== true) return incomplete("invalid_metadata");
      return value;
    }

    function descriptor(value: unknown, expectedPath?: string): Descriptor {
      if (
        !isRecord(value) ||
        typeof value.path !== "string" ||
        (expectedPath !== undefined && value.path !== expectedPath) ||
        !Number.isSafeInteger(value.bytes) ||
        Number(value.bytes) < 1 ||
        typeof value.digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.digest) ||
        value.digestVerified !== true
      )
        return incomplete("unverified_descriptor");
      return { path: value.path, bytes: Number(value.bytes), digest: value.digest };
    }

    async function download(path: string, listed?: Descriptor): Promise<string> {
      const previous = saved.get(path);
      if (previous !== undefined) return previous;
      const info = listed ?? descriptor((await metadata("stat", { path })).blob, path);
      const maxBytes = path.startsWith("ledger/v1/events/")
        ? ACTION_EVENT_SHARD_FILE_LIMITS.maxBytes
        : ACTION_EVENT_IMPORT_BINDING_MAX_BYTES;
      if (info.bytes > maxBytes || info.bytes > limits.payloadBytes - spent.payloadBytes)
        incomplete("payload_budget");
      const target = prepareSafeWriteTarget(stage, path, "canonical review export");
      const result = await request("chunk", { path, offset: 0, length: info.bytes }, info.bytes);
      if (
        result.response.status !== 206 ||
        result.bytes.byteLength !== info.bytes ||
        result.response.headers.get("content-range") !==
          `bytes 0-${info.bytes - 1}/${info.bytes}` ||
        (result.response.headers.has("x-clawsweeper-blob-digest") &&
          result.response.headers.get("x-clawsweeper-blob-digest") !== info.digest) ||
        sha256(result.bytes) !== info.digest
      )
        incomplete("blob_integrity");
      const content = result.bytes.toString("utf8");
      if (!Buffer.from(content).equals(result.bytes)) incomplete("invalid_utf8");
      writeUtf8FileExclusiveNoFollow(target, content);
      saved.set(path, content);
      return content;
    }

    const prefix = `ledger/v1/events/${options.partitionDate.replaceAll("-", "/")}/openclaw-clawsweeper/`;
    const filename = `${options.runId}-${options.runAttempt}-event-review-apply-`;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let selected: Descriptor | undefined;
    for (let pageIndex = 0; pageIndex < limits.listPages; pageIndex += 1) {
      const page = await metadata("list", { prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (page.prefix !== prefix || !Array.isArray(page.blobs) || page.blobs.length > 1000)
        incomplete("invalid_listing");
      for (const value of page.blobs) {
        if (!isRecord(value) || typeof value.path !== "string" || !value.path.startsWith(prefix))
          incomplete("listing_outside_prefix");
        const parts = value.path.slice(prefix.length).split("/");
        // Projection failures are separate transactions that can sort before
        // their review producer; they do not contain full-review usage.
        if (
          parts.length === 2 &&
          parts[0]!.startsWith("review.") &&
          !parts[0]!.endsWith(".crabfleet_projection") &&
          parts[1]!.startsWith(filename) &&
          parts[1]!.endsWith(".jsonl")
        ) {
          selected = descriptor(value);
          break;
        }
      }
      if (selected) break;
      if (page.nextCursor === null) break;
      if (
        typeof page.nextCursor !== "string" ||
        !page.nextCursor ||
        page.nextCursor.length > 8192 ||
        cursors.has(page.nextCursor)
      )
        incomplete("invalid_cursor");
      cursor = page.nextCursor;
      cursors.add(cursor);
    }
    if (!selected) incomplete("producer_not_found_within_budget");
    const selectedPath = selected.path;
    await download(selectedPath, selected);
    const first = readImportedActionEventShards(
      prepareSafeReadRoot(stage, "export stage"),
      [selectedPath],
      { partial: true },
    )[0]!;
    const identity = first.identity;
    if (
      identity.repository !== "openclaw/clawsweeper" ||
      identity.workflow !== "sweep.yml" ||
      identity.job !== "event-review-apply" ||
      !identity.producer.startsWith("review.") ||
      identity.runId !== options.runId ||
      identity.runAttempt !== options.runAttempt ||
      identity.sha !== options.sourceSha ||
      identity.partitionDate !== options.partitionDate
    )
      incomplete("wrong_producer");

    const markers = actionEventShardImportBindingRelativePaths(identity);
    const reservationText = await download(markers.reservation);
    const reservation = parseActionEventShardImportReservation(
      reservationText,
      identity,
      markers.reservation,
    );
    if (
      reservation.shards.length > ACTION_EVENT_SHARD_IMPORT_LIMITS.maxFiles ||
      !reservation.shards.some((item) => item.path === selectedPath)
    )
      incomplete("invalid_reservation");
    parseActionEventShardImportCompletion(
      await download(markers.completion),
      identity,
      sha256(reservationText),
      markers.completion,
    );
    const paths = reservation.shards.map((item) => item.path).sort();
    for (const path of paths) await download(path);
    const shards = readImportedActionEventShards(prepareSafeReadRoot(stage, "export stage"), paths);
    if (shards.some((shard) => actionLedgerJson(shard.identity) !== actionLedgerJson(identity)))
      incomplete("mixed_producer");
    const bindings = actionEventShardImportBindings(shards);
    for (const binding of bindings) await download(binding.relativePath);
    actionEventPublicationPaths(
      stage,
      [...paths, ...bindings.map((binding) => binding.relativePath)].sort(),
    );
    const report = readReviewUsageReport(stage, paths);
    checkTime();
    // The complete canonical transaction becomes visible together; markerless
    // or partial imports never become usable input to the offline reader.
    renameSync(join(stage, "ledger"), join(output, "ledger"));
    rmSync(stage, { recursive: true });
    return { selection: { producer: identity, paths }, report };
  } catch (error) {
    controller.abort();
    if (created) rmSync(output, { recursive: true });
    if (error instanceof Error && error.message.startsWith("review usage export incomplete ("))
      throw error;
    throw new Error("review usage export incomplete (canonical_validation)", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        "run-id": { type: "string" },
        "run-attempt": { type: "string" },
        "source-sha": { type: "string" },
        date: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(
        "review-usage-export --run-id ID --run-attempt N --source-sha SHA --date YYYY-MM-DD --output NEW_PRIVATE_DIRECTORY",
      );
    } else {
      if (!values.output) throw new Error("missing output");
      console.log(
        JSON.stringify(
          await exportReviewUsage({
            runId: values["run-id"] ?? "",
            runAttempt: Number(values["run-attempt"]),
            sourceSha: values["source-sha"] ?? "",
            partitionDate: values.date ?? "",
            output: values.output,
            webhookSecret: process.env.CLAWSWEEPER_WEBHOOK_SECRET ?? "",
          }),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error && error.message.startsWith("review usage export incomplete (")
        ? error.message
        : "review usage export incomplete (invalid_arguments)",
    );
    process.exitCode = 1;
  }
}
