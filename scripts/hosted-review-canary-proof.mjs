import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { terminateCodexProcessTree } from "../dist/codex-spawn.js";

export const HOSTED_REVIEW_ROLLOUT_MAX_BYTES = 4 * 1024 * 1024;
const ROLLOUT_RECORD_MAX_BYTES = 512 * 1024;
const ROLLOUT_MAX_RECORDS = 4096;
const CODEX_VERSION = "0.153.3";
export const HOSTED_MULTILINE_PROVIDER_ERROR = "Rate limit reached.\nPlease try again in 1ms.";
// Codex 0.153.3 adds the protocol category, then human rendering adds ERROR.
export const HOSTED_MULTILINE_RETRY_HINT = `ERROR: rate limit exceeded: ${HOSTED_MULTILINE_PROVIDER_ERROR}`;

const nativeCheckpoint = (value) =>
  [
    "setup",
    "outer_identity",
    "wait",
    "receipt_read",
    "launch_count",
    "native_stop",
    "outer_stop",
    "native_quiescence",
    "outer_quiescence",
    "child_assertion",
  ].includes(value)
    ? value
    : null;
const nativeBoolean = (value) => (typeof value === "boolean" ? value : null);
const nativeCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const nativeStatus = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
const nativeSignal = (value) =>
  ["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGPIPE"].includes(value) ? value : null;
const nativeErrorCode = (value) =>
  ["ETIMEDOUT", "ENOENT", "ENOBUFS", "EACCES", "ECONNRESET", "EPIPE"].includes(value)
    ? value
    : null;

export function latchHostedNativeFailure(facts, abortReason = null) {
  // Cleanup can fail too; retain the boundary that first made this proof fail.
  facts.failureCheckpoint ??= facts.checkpoint;
  facts.abortReason ??= abortReason;
}

function selectHostedNativeChildFacts(value) {
  return {
    kind: "hosted_native_child_failure",
    stage: ["run_codex", "failure_decision", "checkout_observation", "failure_assertion"].includes(
      value.stage,
    )
      ? value.stage
      : null,
    codexReviewError: nativeBoolean(value.codexReviewError),
    status: nativeStatus(value.status),
    signal: nativeSignal(value.signal),
    errorCode: nativeErrorCode(value.errorCode),
    inspectionFailed: nativeBoolean(value.inspectionFailed),
    terminalFailure: nativeBoolean(value.terminalFailure),
    retryable: nativeBoolean(value.retryable),
    diagnosticEmpty: nativeBoolean(value.diagnosticEmpty),
    hintMatched: nativeBoolean(value.hintMatched),
    resultPresent: nativeBoolean(value.resultPresent),
    checkoutUnchanged: nativeBoolean(value.checkoutUnchanged),
  };
}

export function hostedNativeChildFailureFacts(stage, error, decision, observations) {
  return selectHostedNativeChildFacts({
    stage,
    codexReviewError:
      error instanceof Error &&
      error.constructor.name === "CodexReviewError" &&
      error.name === "CodexReviewError",
    status: error?.status,
    signal: error?.signal,
    errorCode: error?.errorCode,
    inspectionFailed: decision?.checkoutInspectionFailed,
    terminalFailure: decision?.codexTerminalFailure,
    retryable: error?.retryable,
    diagnosticEmpty: typeof error?.diagnostic === "string" ? error.diagnostic === "" : null,
    hintMatched:
      typeof error?.retryHint === "string" ? error.retryHint === HOSTED_MULTILINE_RETRY_HINT : null,
    resultPresent: observations?.resultExists,
    checkoutUnchanged: observations?.checkoutUnchanged,
  });
}

export function hostedNativeFailureLine(facts, childBytes) {
  let child = null;
  // This channel is diagnostic only. Reject extra fields and invalid values, not
  // just raw error text; never serialize the child object or an assertion error.
  if (childBytes.length > 0 && childBytes.length <= 2048) {
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(childBytes));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const selected = selectHostedNativeChildFacts(value);
        if (
          Object.keys(value).length === Object.keys(selected).length &&
          Object.entries(selected).every(([key, field]) => value[key] === field)
        )
          child = selected;
      }
    } catch {}
  }
  const line =
    JSON.stringify({
      kind: "hosted_native_failure",
      checkpoint: nativeCheckpoint(facts.failureCheckpoint),
      abortReason: ["signal", "request", "spawn", "capture", "deadline"].includes(facts.abortReason)
        ? facts.abortReason
        : null,
      outerIdentityRecorded: nativeBoolean(facts.outerIdentityRecorded),
      outerClosed: nativeBoolean(facts.outerClosed),
      outerStatus: nativeStatus(facts.outerStatus),
      outerSignal: nativeSignal(facts.outerSignal),
      requestCount: nativeCount(facts.requestCount),
      receiptPresent: nativeBoolean(facts.receiptPresent),
      receiptCount:
        nativeCount(facts.receiptCount) !== null && facts.receiptCount <= 8
          ? facts.receiptCount
          : null,
      nativeQuiescent: nativeBoolean(facts.nativeQuiescent),
      outerQuiescent: nativeBoolean(facts.outerQuiescent),
      capturedBytes: nativeCount(facts.capturedBytes),
      child,
    }) + "\n";
  assert.ok(Buffer.byteLength(line) <= 2048, "Hosted native failure facts exceeded their bound.");
  return line;
}

export async function withHostedFixtureSignals(refuse, operation) {
  let cancelled = false;
  const onSignal = () => {
    if (cancelled) return;
    cancelled = true;
    refuse();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const result = await operation();
    // The owner's awaited finally has finished; a signal during it still rejects proof.
    assert.equal(cancelled, false, "Hosted fixture cancelled.");
    return result;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export function hostedProcessIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    assert.match(fields[19], /^\d+$/);
    return { pid, pgid: Number(fields[2]), start: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function recordHostedLifecycle(path, record) {
  const text = JSON.stringify(record) + "\n";
  assert.ok(Buffer.byteLength(text) <= 2048);
  try {
    assert.ok(lstatSync(path).isFile() && lstatSync(path).size <= 14 * 1024);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  appendFileSync(path, text, { mode: 0o600 });
}

export function readHostedLifecycle(path, nonce) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.ok(fstatSync(file).isFile());
    const bytes = Buffer.alloc(16 * 1024 + 1);
    const size = readSync(file, bytes, 0, bytes.length, 0);
    assert.ok(size > 0 && size < bytes.length);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    assert.ok(text.endsWith("\n"));
    const records = text.slice(0, -1).split("\n").map(JSON.parse);
    assert.ok(records.length <= 8);
    for (const record of records) assert.equal(record.fixtureNonce, nonce);
    return records;
  } finally {
    closeSync(file);
  }
}

function hostedGroupGone(identity) {
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 1);
  assert.equal(identity.pgid, identity.pid);
  assert.match(identity.start, /^\d+$/);
  try {
    process.kill(-identity.pgid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}

export function assertHostedProcessGroupGone(identity) {
  assert.ok(hostedGroupGone(identity), "hosted process group still exists");
}

async function awaitHostedCondition(condition, deadline, cancelled = () => false) {
  for (;;) {
    assert.equal(cancelled(), false, "Hosted fixture cancelled.");
    assert.ok(Date.now() < deadline, "hosted fixture did not become quiescent");
    const complete = condition();
    assert.equal(cancelled(), false, "Hosted fixture cancelled.");
    assert.ok(Date.now() < deadline, "hosted fixture did not become quiescent");
    if (complete) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))),
    );
  }
}

export async function stopHostedNativeGroup(identity) {
  assert.equal(identity.pid, identity.pgid);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    if (hostedGroupGone(identity)) return;
    assert.deepEqual(hostedProcessIdentity(identity.pid), identity);
    // Revalidate separately before escalation; the owner's timer alone cannot do that.
    clearTimeout(terminateCodexProcessTree({ pid: identity.pid }, signal));
    const until = Date.now() + (signal === "SIGTERM" ? 1000 : 2000);
    while (!hostedGroupGone(identity) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(hostedGroupGone(identity), "hosted native process group survived cleanup");
}

export async function assertHostedNativeQuiescent(
  records,
  { outerIdentity, deadline, facts, cancelled },
) {
  facts.checkpoint = "native_quiescence";
  assert.ok(records.length > 0 && records.length <= 4);
  for (const record of records) {
    assert.equal(record.kind, "native");
    assert.equal(record.identity.pid, record.identity.pgid);
  }
  const observe = (identities, key) => {
    facts[key] = null;
    let gone = true;
    for (const identity of identities) {
      const current = hostedProcessIdentity(identity.pid);
      if (current) assert.deepEqual(current, identity);
      if (!hostedGroupGone(identity)) gone = false;
    }
    facts[key] = gone;
    return gone;
  };
  // Direct-child closure does not attest group exit. All observations share the
  // original fixture deadline; only ESRCH proves a recorded group is gone.
  await awaitHostedCondition(
    () =>
      observe(
        records.map((record) => record.identity),
        "nativeQuiescent",
      ),
    deadline,
    cancelled,
  );
  facts.checkpoint = "outer_quiescence";
  await awaitHostedCondition(() => observe([outerIdentity], "outerQuiescent"), deadline, cancelled);
}

export function recordHostedTerminalPublication(path, fixtureNonce, publication, values) {
  assert.ok(Buffer.byteLength(publication) <= 512);
  const fields = publication.split("|");
  assert.equal(fields[0], "v1");
  assert.equal(fields[1], "armed");
  const [socket, serverPid, sessionId] = values.tmux.split(",");
  assert.match(sessionId, /^\d+$/);
  const server = hostedProcessIdentity(Number(serverPid));
  assert.ok(server);
  const socketStat = lstatSync(socket);
  assert.ok(socketStat.isSocket());
  const lease = lstatSync(values.lease);
  assert.ok(lease.isFile() && !lease.isSymbolicLink());
  assert.equal(`${lease.dev}:${lease.ino}`, fields[5]);
  recordHostedLifecycle(path, {
    kind: "terminal",
    fixtureNonce,
    publication: publication + "\n",
    socket,
    socketIdentity: `${socketStat.dev}:${socketStat.ino}`,
    server,
    session: `$${sessionId}`,
    lease: values.lease,
    request: values.request,
    result: values.result,
    watchdog: hostedProcessIdentity(Number(fields[6])),
  });
}

export function hostedTerminalObserverSource(path, nonce) {
  const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
  const observation = `
import { recordHostedTerminalPublication } from ${JSON.stringify(import.meta.url)};
recordHostedTerminalPublication(${JSON.stringify(path)}, ${JSON.stringify(nonce)}, process.argv[1], {
  tmux: process.argv[2], lease: process.argv[3], request: process.argv[4], result: process.argv[5],
});
`;
  // The watchdog cannot finish before this armed-publication callback returns.
  // Done is observed at the controller's read boundary, before owner teardown.
  return `
mv() {
  local publication= watched=0 status
  if [ "$#" -eq 4 ] && [ -n "\${result_temporary-}" ] && [ "$3" = "$result_temporary" ] && [ "$4" = "$result" ]; then
    IFS= read -r publication <"$3" && watched=1
  fi
  command mv "$@"
  status=$?
  if [ "$status" -eq 0 ] && [ "$watched" -eq 1 ]; then
    case "$publication" in
      "v1|armed|"*) ${quote(process.execPath)} --input-type=module --eval ${quote(observation)} "$publication" "\${TMUX-}" "$lease_path" "$request" "$result" >/dev/null 2>&1 || : ;;
    esac
  fi
  return "$status"
}
`;
}

export function observeHostedTerminalRead(path, nonce, args, count) {
  const [descriptor, buffer, offset, length, position] = args;
  if (
    !Number.isSafeInteger(descriptor) ||
    !Buffer.isBuffer(buffer) ||
    buffer.length !== 513 ||
    offset !== 0 ||
    length !== 513 ||
    position !== 0 ||
    count <= 0 ||
    count > 512
  )
    return;
  const publication = buffer.subarray(0, count).toString("utf8");
  if (!publication.startsWith("v1|done|") || !publication.endsWith("|ok|0\n")) return;
  const records = readHostedLifecycle(path, nonce);
  if (records.length === 2) {
    assertHostedTerminalDone(records);
    return;
  }
  assert.equal(records.length, 1);
  const armed = records[0];
  assert.ok(fstatSync(descriptor).isFile());
  assert.equal(realpathSync(`/proc/self/fd/${descriptor}`), armed.result);
  const { watchdog: _, ...identity } = armed;
  const done = { ...identity, publication };
  assertHostedTerminalDone([armed, done]);
  recordHostedLifecycle(path, done);
}

export function hostedBlobPreloadSource({ entrypoint, startsPath, terminalReceipts, nonce }) {
  return `import fs from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { observeHostedTerminalRead } from ${JSON.stringify(import.meta.url)};
if (process.argv[1] === ${JSON.stringify(entrypoint)} &&
    ["live-proof-review", "live-proof"].includes(process.argv[2])) {
  fs.appendFileSync(${JSON.stringify(startsPath)}, JSON.stringify({
    command: process.argv[2], args: process.argv.slice(3), temporaryRoot: tmpdir(),
  }) + "\\n", { mode: 0o600 });
}
if (process.argv[1] === ${JSON.stringify(entrypoint)} && process.argv[2] === "live-proof") {
  const original = fs.readSync;
  let observing = false;
  fs.readSync = function(...args) {
    const count = original.apply(this, args);
    if (!observing) {
      observing = true;
      try { observeHostedTerminalRead(${JSON.stringify(terminalReceipts)}, ${JSON.stringify(nonce)}, args, count); }
      catch {}
      finally { observing = false; }
    }
    return count;
  };
  syncBuiltinESMExports();
}
`;
}

export function assertHostedTerminalDone(records) {
  assert.equal(records.length, 2);
  const [armed, done] = records;
  assert.equal(armed.kind, "terminal");
  assert.equal(done.kind, "terminal");
  assert.equal(done.fixtureNonce, armed.fixtureNonce);
  const fields = armed.publication.trimEnd().split("|");
  assert.equal(fields.length, 7);
  assert.equal(fields[0], "v1");
  assert.equal(fields[1], "armed");
  assert.match(fields[2], /^[0-9a-f-]{36}$/);
  assert.match(fields[3], /^[1-9]\d+$/);
  assert.match(fields[4], /^\/dev\/[^\s|]+$/);
  assert.match(fields[5], /^\d+:\d+$/);
  assert.ok(armed.watchdog && armed.watchdog.pid === Number(fields[6]));
  assert.equal(armed.publication, fields.join("|") + "\n");
  for (const key of ["socket", "socketIdentity", "session", "lease", "request", "result"]) {
    assert.equal(done[key], armed[key]);
  }
  assert.deepEqual(done.server, armed.server);
  const identity = fields.slice(2, 6).join("|");
  assert.ok(
    ["controller", "pane-death"].some(
      (trigger) => done.publication === `v1|done|${identity}|${trigger}|ok|0\n`,
    ),
  );
  return armed;
}

export async function assertHostedTerminalQuiescent(records) {
  const armed = assertHostedTerminalDone(records);
  await awaitHostedCondition(() => {
    if (hostedProcessIdentity(armed.server.pid)) return false;
    try {
      lstatSync(armed.socket);
      return false;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  }, Date.now() + 2000);
}

export async function stopHostedTerminal({ path, nonce, tmux }) {
  let records = readHostedLifecycle(path, nonce);
  const armed = records[0];
  assert.equal(armed.kind, "terminal");
  const fields = armed.publication.trimEnd().split("|");
  assert.equal(fields[0], "v1");
  assert.equal(fields[1], "armed");
  assert.equal(fields.length, 7);
  assert.ok(armed.lease.endsWith(".lease"));
  const prefix = armed.lease.slice(0, -".lease".length);
  assert.equal(armed.request, prefix + ".start");
  assert.equal(armed.result, prefix + ".cleanup.result");
  const identity = fields.slice(2, 6).join("|");
  const command = (...args) =>
    execFileSync(tmux, ["-S", armed.socket, ...args], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 4096,
    }).trim();
  if (records.length === 1) {
    const root = realpathSync(dirname(path));
    const directory = realpathSync(dirname(armed.lease));
    assert.ok(directory === root || directory.startsWith(root + sep));
    assert.deepEqual(hostedProcessIdentity(armed.server.pid), armed.server);
    const socket = lstatSync(armed.socket);
    assert.ok(socket.isSocket());
    assert.equal(`${socket.dev}:${socket.ino}`, armed.socketIdentity);
    assert.deepEqual(hostedProcessIdentity(armed.watchdog.pid), armed.watchdog);
    const lease = lstatSync(armed.lease);
    assert.ok(lease.isFile() && !lease.isSymbolicLink());
    assert.equal(`${lease.dev}:${lease.ino}`, fields[5]);
    assert.equal(
      command("display-message", "-p", "-t", `${armed.session}:0.0`, "#{pane_pid}|#{pane_tty}"),
      `${fields[3]}|${fields[4]}`,
    );
    const request = `v1|cleanup|${identity}\n`;
    const temporary = `${armed.request}.hosted-cleanup`;
    writeFileSync(temporary, request, { mode: 0o600, flag: "wx" });
    try {
      try {
        linkSync(temporary, armed.request);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        assert.equal(readFileSync(armed.request, "utf8"), request);
      }
    } finally {
      rmSync(temporary);
    }
    await awaitHostedCondition(() => {
      records = readHostedLifecycle(path, nonce);
      return records.length === 2;
    }, Date.now() + 12_000);
  }
  assertHostedTerminalDone(records);
  const proveCompleted = async () => {
    const fresh = readHostedLifecycle(path, nonce);
    assert.deepEqual(fresh, records);
    await assertHostedTerminalQuiescent(fresh);
  };
  if (hostedProcessIdentity(armed.server.pid)) {
    assert.deepEqual(hostedProcessIdentity(armed.server.pid), armed.server);
    const socket = lstatSync(armed.socket);
    assert.ok(socket.isSocket());
    assert.equal(`${socket.dev}:${socket.ino}`, armed.socketIdentity);
    let paneIdentity;
    try {
      paneIdentity = command(
        "display-message",
        "-p",
        "-t",
        `${armed.session}:0.0`,
        "#{pane_pid}|#{pane_tty}",
      );
    } catch {
      // After DONE the real controller can remove its session concurrently.
      // A failed command is not success without fresh receipts and quiescence.
      await proveCompleted();
      return;
    }
    assert.equal(paneIdentity, `${fields[3]}|${fields[4]}`);
    try {
      command("kill-session", "-t", armed.session);
    } catch {
      await proveCompleted();
      return;
    }
  }
  await proveCompleted();
}

export function assertHostedBlobStarts(starts, repo, item, childCount, temporaryRoot) {
  assert.equal(starts.length, childCount + 1);
  assert.equal(starts[0].command, "live-proof-review");
  for (const [index, start] of starts.entries()) {
    assert.equal(start.command, index === 0 ? "live-proof-review" : "live-proof");
    assert.equal(start.args[start.args.indexOf("--repo") + 1], repo);
    assert.equal(start.args[start.args.indexOf("--item") + 1], String(item));
    if (index === 0) {
      assert.equal(start.temporaryRoot, temporaryRoot);
    } else {
      const outputIndex = start.args.indexOf("--output");
      assert.ok(outputIndex >= 0);
      const bundle = start.args[outputIndex + 1];
      const scratch = dirname(bundle);
      assert.equal(dirname(scratch), temporaryRoot);
      assert.ok(basename(scratch).startsWith(`clawsweeper-live-proof-${item}-`));
      assert.equal(bundle, join(scratch, "bundle"));
      assert.equal(start.temporaryRoot, join(scratch, "profile", "tmp"));
    }
  }
}

export async function assertHostedMultilineRequest(request, requestCount) {
  assert.equal(requestCount, 1);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/responses");
  assert.equal(request.headers.authorization, undefined);
  const encoding = request.headers["content-encoding"];
  assert.ok(encoding === undefined || encoding === "gzip");
  const maxBytes = 1024 * 1024;
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    assert.ok(bytes <= maxBytes);
    chunks.push(chunk);
  }
  const compressed = Buffer.concat(chunks);
  const decoded =
    encoding === "gzip" ? gunzipSync(compressed, { maxOutputLength: maxBytes }) : compressed;
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  assert.equal(body.model, "gpt-5.4");
}

export function summarizeHostedMultilineFailure(error, decision, observations) {
  assert.ok(error instanceof Error);
  assert.equal(error.constructor.name, "CodexReviewError");
  assert.equal(error.name, "CodexReviewError");
  assert.equal(error.status, 1);
  assert.equal(error.signal, null);
  assert.equal(error.errorCode, null);
  assert.equal(error.stdout, "");
  assert.equal(error.diagnostic, "");
  assert.equal(error.retryHint, HOSTED_MULTILINE_RETRY_HINT);
  assert.ok(error.stderr.includes(HOSTED_MULTILINE_RETRY_HINT));
  assert.equal(error.retryable, true);
  assert.ok(!error.message.includes(HOSTED_MULTILINE_PROVIDER_ERROR));
  assert.equal(decision.codexTerminalFailure, false);
  assert.match(decision.summary, /retryable codex transport failure \(capacity\)/);
  assert.doesNotMatch(decision.summary, /model unavailable|access denied/);
  assert.equal(
    decision.evidence.some((entry) => entry.label === "codex terminal error"),
    false,
  );
  assert.match(
    decision.evidence.find((entry) => entry.label === "codex retry hint")?.detail ?? "",
    /Non-authoritative/,
  );
  assert.equal(observations.resultExists, false);
  assert.equal(observations.checkoutUnchanged, true);
  return {
    nativeMultilineFailureCount: 1,
    nativeMultilineRetryEligible: true,
    nativeMultilineTrustedDiagnosticEmpty: true,
    nativeMultilineTerminalDenial: false,
    nativeMultilineResultAbsent: true,
    nativeMultilineCheckoutUnchanged: true,
  };
}

export function assertMatchesJsonSchema(value, schema, path = "$") {
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((candidate) => {
      try {
        assertMatchesJsonSchema(value, candidate, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(matches.length > 0, `${path} did not match any allowed schema`);
  }
  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value;
    assert.ok(
      allowedTypes.includes(actualType) ||
        (actualType === "integer" && allowedTypes.includes("number")),
      `${path} has invalid type`,
    );
  }
  if (schema.const !== undefined)
    assert.deepEqual(value, schema.const, `${path} has invalid value`);
  if (schema.enum) {
    assert.ok(
      schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)),
      `${path} has invalid enum value`,
    );
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${path}.${key} is not allowed`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) assertMatchesJsonSchema(value[key], child, `${path}.${key}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined)
      assert.ok(value.length >= schema.minItems, `${path} has too few items`);
    if (schema.maxItems !== undefined)
      assert.ok(value.length <= schema.maxItems, `${path} has too many items`);
    if (schema.items) {
      value.forEach((entry, index) =>
        assertMatchesJsonSchema(entry, schema.items, `${path}[${index}]`),
      );
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined)
      assert.ok(value.length >= schema.minLength, `${path} is too short`);
    if (schema.maxLength !== undefined)
      assert.ok(value.length <= schema.maxLength, `${path} is too long`);
    if (schema.pattern !== undefined)
      assert.match(value, new RegExp(schema.pattern, "u"), `${path} does not match its pattern`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined)
      assert.ok(value >= schema.minimum, `${path} is below its minimum`);
    if (schema.maximum !== undefined)
      assert.ok(value <= schema.maximum, `${path} is above its maximum`);
    if (schema.exclusiveMinimum !== undefined)
      assert.ok(value > schema.exclusiveMinimum, `${path} is below its exclusive minimum`);
  }
}

const traceAssertionIds = new Set([
  "discovery_home",
  "discovery_depth",
  "discovery_directory",
  "discovery_count",
  "discovery_symlink",
  "discovery_file",
  "discovery_previous",
  "discovery_added",
  "read_file",
  "read_size",
  "read_stable",
  "trace_size",
  "trace_utf8",
  "trace_frame",
  "record_count",
  "record_size",
  "record_json",
  "ordinal",
  "record_kind",
  "session_count",
  "session_position",
  "session_id",
  "session_path",
  "session_version",
  "session_source",
  "session_history",
  "session_cwd",
  "event_kind",
  "turn_count",
  "turn_id",
  "turn_error",
  "turn_position",
  "response_kind",
  "call_count",
  "result_count",
  "call_name",
  "call_id",
  "call_turn",
  "call_arguments_json",
  "call_command",
  "call_cwd",
  "call_login",
  "result_call",
  "result_turn",
  "result_marker",
  "completed_item_thread",
  "completed_item_turn",
  "completed_item_kind",
  "command_count",
  "command_call",
  "command_arguments",
  "command_cwd",
  "command_status",
  "command_exit",
  "command_marker",
  "command_order",
  "final_terminal",
  "final_count",
  "final_order",
  "final_marker",
]);
// Canonical ResponseItem tags from pinned Codex models.rs. This bounds
// diagnostics only; it does not widen the canary's accepted response kinds.
const traceResponseKinds = new Set([
  "additional_tools",
  "message",
  "agent_message",
  "reasoning",
  "local_shell_call",
  "function_call",
  "tool_search_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_output",
  "web_search_call",
  "image_generation_call",
  "compaction",
  "compaction_trigger",
  "context_compaction",
  "other",
]);
const runTraceAssertion = (_id, operation) => operation();

export function runWithHostedTraceDiagnostics(message, operation) {
  let failure = null;
  const check = (id, assertion, count = null, unexpectedKind = null) => {
    try {
      return assertion();
    } catch (error) {
      // Latch the first failure, including unknown exceptions, before finally.
      // Known parser failures identify only their owner; never read error text.
      if (failure === null) {
        const identified =
          error instanceof assert.AssertionError ||
          (id === "trace_utf8" && error instanceof TypeError) ||
          ((id === "record_json" || id === "call_arguments_json") && error instanceof SyntaxError);
        failure = {
          assertionId: identified && traceAssertionIds.has(id) ? id : "unknown",
          observedCount: identified ? nativeCount(count) : null,
          unexpectedKind: !identified
            ? null
            : id === "response_kind"
              ? traceResponseKinds.has(unexpectedKind)
                ? unexpectedKind
                : "other"
              : unexpectedKind === null
                ? null
                : (id === "record_kind" && unexpectedKind === "security_risk_score") ||
                    (id === "event_kind" && unexpectedKind === "thread_settings_applied") ||
                    (id === "completed_item_kind" && unexpectedKind === "FunctionCallOutput")
                  ? unexpectedKind
                  : "other",
        };
      }
      throw error;
    }
  };
  try {
    return operation(check);
  } catch {
    const line =
      JSON.stringify({
        kind: "hosted_trace_failure",
        assertionId: failure?.assertionId ?? "unknown",
        observedCount: failure?.observedCount ?? null,
        unexpectedKind: failure?.unexpectedKind ?? null,
      }) + "\n";
    assert.ok(Buffer.byteLength(line) <= 512);
    process.stderr.write(line);
    throw new Error(message);
  }
}

export function snapshotHostedReviewRollouts(codexHome, check = runTraceAssertion) {
  check("discovery_home", () => assert.ok(codexHome, "canary requires its isolated CODEX_HOME"));
  const home = resolve(codexHome);
  check("discovery_home", () =>
    assert.equal(realpathSync(home), home, "canary CODEX_HOME must not traverse a symlink"),
  );
  check("discovery_home", () =>
    assert.ok(lstatSync(home).isDirectory(), "canary CODEX_HOME must be a directory"),
  );
  const root = join(home, "sessions");
  try {
    lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const paths = [];
  let entries = 0;
  const visit = (path, depth) => {
    check(
      "discovery_depth",
      () => assert.ok(depth <= 4, "canary rollout directory depth exceeded"),
      depth,
    );
    const info = lstatSync(path);
    check("discovery_directory", () =>
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), "unsafe canary rollout directory"),
    );
    const directory = opendirSync(path);
    try {
      for (let entry; (entry = directory.readSync()) !== null;) {
        check(
          "discovery_count",
          () => assert.ok(++entries <= 512, "canary rollout path inventory exceeded"),
          entries + 1,
        );
        const child = join(path, entry.name);
        check("discovery_symlink", () =>
          assert.ok(!entry.isSymbolicLink(), "canary rollout path is a symlink"),
        );
        if (entry.isDirectory()) visit(child, depth + 1);
        else {
          check("discovery_file", () =>
            assert.ok(entry.isFile() && entry.name.endsWith(".jsonl"), "unexpected rollout path"),
          );
          paths.push(child);
        }
      }
    } finally {
      directory.closeSync();
    }
  };
  visit(root, 0);
  return paths.sort();
}

export function readHostedReviewRollout(codexHome, before, check = runTraceAssertion) {
  const after = snapshotHostedReviewRollouts(codexHome, check);
  check("discovery_previous", () =>
    assert.ok(
      before.every((path) => after.includes(path)),
      "existing rollout paths changed",
    ),
  );
  const added = after.filter((path) => !before.includes(path));
  check(
    "discovery_added",
    () => assert.equal(added.length, 1, "canary must create exactly one new rollout"),
    added.length,
  );
  const path = added[0];
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(file);
    check("read_file", () => assert.ok(initial.isFile(), "canary rollout must be a regular file"));
    check(
      "read_size",
      () =>
        assert.ok(initial.size <= HOSTED_REVIEW_ROLLOUT_MAX_BYTES, "canary rollout bytes exceeded"),
      initial.size,
    );
    const buffer = Buffer.alloc(initial.size + 1);
    let bytes = 0;
    for (;;) {
      const count = readSync(file, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
      check(
        "read_stable",
        () => assert.ok(bytes <= initial.size, "canary rollout changed while reading"),
        bytes,
      );
    }
    const final = lstatSync(path);
    check(
      "read_stable",
      () =>
        assert.ok(
          final.isFile() &&
            final.dev === initial.dev &&
            final.ino === initial.ino &&
            final.size === bytes &&
            bytes === initial.size &&
            final.mtimeMs === initial.mtimeMs,
          "canary rollout changed while reading",
        ),
      bytes,
    );
    return { path, bytes: buffer.subarray(0, bytes) };
  } finally {
    closeSync(file);
  }
}

export function summarizeHostedReviewTrace(
  { rollout, cwd, marker, expectedCommand, finalDecisionText, checkoutUnchanged },
  check = runTraceAssertion,
) {
  // The pinned CLI persists typed completed items in paginated rollouts.
  // Human stderr includes untrusted tool text and cannot establish tool success.
  check(
    "trace_size",
    () =>
      assert.ok(
        rollout.bytes.length <= HOSTED_REVIEW_ROLLOUT_MAX_BYTES,
        "canary rollout bytes exceeded",
      ),
    rollout.bytes.length,
  );
  const text = check("trace_utf8", () =>
    new TextDecoder("utf-8", { fatal: true }).decode(rollout.bytes),
  );
  check("trace_frame", () => assert.ok(text.endsWith("\n"), "canary rollout is incomplete"));
  const lines = text.slice(0, -1).split("\n");
  check(
    "record_count",
    () => assert.ok(lines.length <= ROLLOUT_MAX_RECORDS, "canary rollout record count exceeded"),
    lines.length,
  );
  const records = lines.map((line, index) => {
    check(
      "record_size",
      () =>
        assert.ok(
          Buffer.byteLength(line) <= ROLLOUT_RECORD_MAX_BYTES,
          "canary rollout record bytes exceeded",
        ),
      Buffer.byteLength(line),
    );
    const record = check("record_json", () => JSON.parse(line));
    check(
      "ordinal",
      () => assert.equal(record.ordinal, index, "canary rollout order is incomplete"),
      index,
    );
    check(
      "record_kind",
      () =>
        assert.ok(
          [
            "session_meta",
            "event_msg",
            "response_item",
            "world_state",
            "turn_context",
            "token_usage_record",
          ].includes(record.type),
          "canary rollout contains an unexpected record",
        ),
      null,
      record.type,
    );
    return { ...record, index };
  });
  const metadata = records.filter((record) => record.type === "session_meta");
  check(
    "session_count",
    () => assert.equal(metadata.length, 1, "canary rollout session is ambiguous"),
    metadata.length,
  );
  check("session_position", () => assert.equal(metadata[0].index, 0));
  const session = metadata[0].payload;
  check("session_id", () =>
    assert.match(session.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  );
  check("session_id", () => assert.equal(session.session_id, session.id));
  check("session_path", () =>
    assert.ok(
      rollout.path.endsWith(`-${session.id}.jsonl`),
      "canary rollout session path mismatch",
    ),
  );
  check("session_version", () =>
    assert.equal(session.cli_version, CODEX_VERSION, "canary rollout version mismatch"),
  );
  check("session_source", () => assert.equal(session.source, "exec"));
  check("session_source", () => assert.equal(session.originator, "codex_exec"));
  check("session_history", () => assert.equal(session.history_mode, "paginated"));
  check("session_cwd", () => assert.equal(session.cwd, cwd, "canary rollout cwd mismatch"));
  const events = records.filter((record) => record.type === "event_msg");
  let unexpectedEventKind = null;
  const acceptedEvents = events.every((record) => {
    const accepted = ["task_started", "item_completed", "token_count", "task_complete"].includes(
      record.payload.type,
    );
    if (!accepted) unexpectedEventKind = record.payload.type;
    return accepted;
  });
  check(
    "event_kind",
    () => assert.ok(acceptedEvents, "canary rollout contains an unexpected event or abort"),
    events.length,
    unexpectedEventKind,
  );
  const starts = events.filter((record) => record.payload.type === "task_started");
  const ends = events.filter((record) => record.payload.type === "task_complete");
  check(
    "turn_count",
    () => assert.equal(starts.length, 1, "canary must start exactly one turn"),
    starts.length,
  );
  check(
    "turn_count",
    () => assert.equal(ends.length, 1, "canary must complete exactly one turn"),
    ends.length,
  );
  const turn = starts[0].payload.turn_id;
  check("turn_id", () => assert.match(turn, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/));
  check("turn_id", () => assert.equal(ends[0].payload.turn_id, turn));
  check("turn_error", () =>
    assert.ok(!Object.hasOwn(ends[0].payload, "error"), "canary terminal turn failed"),
  );
  check("turn_position", () =>
    assert.equal(ends[0].index, records.length - 1, "canary terminal record is not last"),
  );

  const responses = records.filter((record) => record.type === "response_item");
  let unexpectedResponseKind = null;
  const acceptedResponses = responses.every((record) => {
    const type = record.payload.type;
    const accepted = ["message", "reasoning", "function_call", "function_call_output"].includes(
      type,
    );
    if (!accepted) unexpectedResponseKind = type;
    return accepted;
  });
  check(
    "response_kind",
    () => assert.ok(acceptedResponses, "canary contains an unsupported response item"),
    responses.length,
    unexpectedResponseKind,
  );
  const calls = responses.filter((record) => record.payload.type === "function_call");
  const results = responses.filter((record) => record.payload.type === "function_call_output");
  check(
    "call_count",
    () => assert.equal(calls.length, 1, "canary must attempt exactly one review tool"),
    calls.length,
  );
  check(
    "result_count",
    () => assert.equal(results.length, 1, "canary must receive exactly one tool result"),
    results.length,
  );
  const call = calls[0];
  check("call_name", () =>
    assert.equal(call.payload.name, "exec_command", "canary must use the native command tool"),
  );
  check("call_id", () =>
    assert.ok(typeof call.payload.call_id === "string" && call.payload.call_id.length > 0),
  );
  check("call_turn", () =>
    assert.equal(call.payload.internal_chat_message_metadata_passthrough?.turn_id, turn),
  );
  const args = check("call_arguments_json", () => JSON.parse(call.payload.arguments));
  check("call_command", () =>
    assert.equal(
      args.cmd,
      expectedCommand,
      "canary command did not match the required diff inspection",
    ),
  );
  if (args.workdir !== undefined) check("call_cwd", () => assert.equal(args.workdir, cwd));
  if (Object.hasOwn(args, "login")) {
    check("call_login", () =>
      assert.equal(typeof args.login, "boolean", "canary command login must be a boolean"),
    );
  }
  check("result_call", () => assert.equal(results[0].payload.call_id, call.payload.call_id));
  check("result_turn", () =>
    assert.equal(results[0].payload.internal_chat_message_metadata_passthrough?.turn_id, turn),
  );
  check("result_marker", () =>
    assert.ok(
      typeof results[0].payload.output === "string" && results[0].payload.output.includes(marker),
      "canary model-facing tool result did not contain the fixture marker",
    ),
  );

  const completed = events.filter((record) => record.payload.type === "item_completed");
  for (const record of completed) {
    check("completed_item_thread", () =>
      assert.equal(record.payload.thread_id, session.id, "canary item thread mismatch"),
    );
    check("completed_item_turn", () =>
      assert.equal(record.payload.turn_id, turn, "canary item turn mismatch"),
    );
    check(
      "completed_item_kind",
      () =>
        assert.ok(
          ["UserMessage", "Reasoning", "AgentMessage", "CommandExecution"].includes(
            record.payload.item.type,
          ),
          "canary attempted an additional tool",
        ),
      null,
      record.payload.item.type,
    );
  }
  const commands = completed.filter((record) => record.payload.item.type === "CommandExecution");
  check(
    "command_count",
    () => assert.equal(commands.length, 1, "canary must complete exactly one review command"),
    commands.length,
  );
  const command = commands[0];
  check("command_call", () =>
    assert.equal(
      command.payload.item.id,
      call.payload.call_id,
      "canary completed a different call",
    ),
  );
  // The isolated canary keeps the pinned CLI's login-enabled default.
  // An explicit login:false must match the native non-login invocation.
  check("command_arguments", () =>
    assert.deepEqual(
      command.payload.item.command,
      ["/bin/bash", args.login === false ? "-c" : "-lc", expectedCommand],
      "canary executed different command arguments",
    ),
  );
  check("command_cwd", () =>
    assert.equal(command.payload.item.cwd, pathToFileURL(cwd).href, "canary command cwd mismatch"),
  );
  check("command_status", () =>
    assert.equal(command.payload.item.status, "completed", "canary command did not complete"),
  );
  check("command_exit", () =>
    assert.equal(command.payload.item.exit_code, 0, "canary command failed"),
  );
  check("command_marker", () =>
    assert.ok(
      typeof command.payload.item.aggregated_output === "string" &&
        command.payload.item.aggregated_output.includes(marker),
      "canary command did not return the fixture marker",
    ),
  );
  check("command_order", () =>
    assert.ok(
      starts[0].index < call.index &&
        call.index < command.index &&
        command.index < results[0].index,
      "canary command and result order is invalid",
    ),
  );
  check("final_terminal", () =>
    assert.equal(
      ends[0].payload.last_agent_message,
      finalDecisionText,
      "canary terminal answer mismatch",
    ),
  );
  // The pinned CLI selects the terminal answer from completed messages without
  // requiring phase metadata, which some providers omit.
  const finals = completed.filter((record) => {
    const item = record.payload.item;
    return (
      record.index > results[0].index &&
      item.type === "AgentMessage" &&
      Array.isArray(item.content) &&
      item.content.length === 1 &&
      item.content[0]?.type === "Text" &&
      item.content[0].text === finalDecisionText
    );
  });
  check(
    "final_count",
    () => assert.equal(finals.length, 1, "canary final review is ambiguous"),
    finals.length,
  );
  const final = finals[0];
  check("final_order", () =>
    assert.ok(
      results[0].index < final.index && final.index < ends[0].index,
      "final review was not emitted after the command",
    ),
  );
  check("final_marker", () =>
    assert.ok(
      String(JSON.parse(finalDecisionText).summary ?? "").includes(marker),
      "final review did not use the fixture marker",
    ),
  );

  return {
    eventCount: records.length,
    toolAttemptCount: calls.length,
    completedToolCount: commands.length,
    fixtureToolCount: 1,
    reviewAfterToolCount: 1,
    terminalTurnCount: ends.length,
    checkoutUnchanged: Boolean(checkoutUnchanged),
  };
}

export function assertBooleanCountArtifact(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  for (const entry of Object.values(value)) {
    assert.ok(
      typeof entry === "boolean" || (typeof entry === "number" && Number.isInteger(entry)),
      "hosted canary artifacts may contain only booleans and integer counts",
    );
  }
}

export function runWithWithheldDiagnostics(message, operation) {
  try {
    return operation();
  } catch {
    throw new Error(message);
  }
}
