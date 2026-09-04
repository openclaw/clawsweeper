import { createHmac } from "node:crypto";
import { GitHubRateLimitError } from "../github-retry.js";
import { recordUnobservedGitHubInvocation } from "../github-egress-observer.js";
import {
  COMMAND_PROOF_ARCHIVE_MAX_BYTES,
  type CommandProofClaim,
} from "../command-proof-contract.js";
import type { CommandProofTransport } from "./command-proof-consumer.js";

export class CommandProofHttpTransport implements CommandProofTransport {
  private fetcher: typeof fetch;
  private githubBase: URL;
  constructor(
    private options: {
      githubToken: string;
      queueUrl: string;
      queueSecret: string;
      fetchImpl?: typeof fetch;
      githubBase?: string;
      status: (claim: CommandProofClaim, state: string, detail: string) => Promise<void>;
    },
  ) {
    this.fetcher = options.fetchImpl ?? fetch;
    this.githubBase = new URL(options.githubBase ?? "https://api.github.com/");
    if (
      !(this.githubBase.protocol === "https:" && this.githubBase.hostname === "api.github.com") &&
      !(
        this.githubBase.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(this.githubBase.hostname)
      )
    )
      throw new Error("invalid_proof_github_origin");
    const queue = new URL(options.queueUrl);
    if (
      queue.protocol !== "https:" &&
      !(queue.protocol === "http:" && ["127.0.0.1", "localhost"].includes(queue.hostname))
    )
      throw new Error("invalid_proof_queue_origin");
    if (!options.githubToken || !options.queueSecret)
      throw new Error("proof_credentials_unavailable");
  }
  async github(path: string, body?: unknown): Promise<unknown> {
    if (
      !path.startsWith("repos/openclaw/openclaw") ||
      (body !== undefined &&
        !/^repos\/openclaw\/openclaw\/actions\/workflows\/[^/]+\/dispatches$/.test(path))
    )
      throw new Error("invalid_proof_github_operation");
    recordUnobservedGitHubInvocation([
      "api",
      path,
      "--method",
      body === undefined ? "GET" : "POST",
    ]);
    const response = await this.fetcher(new URL(path, this.githubBase), {
      method: body === undefined ? "GET" : "POST",
      headers: this.githubHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    await rejectGithubThrottle(response);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("proof_github_http_" + response.status);
    }
    if (response.status === 204) return {};
    return JSON.parse((await boundedBytes(response, 1024 * 1024)).toString("utf8"));
  }
  async artifact(id: string): Promise<Buffer> {
    if (!/^[1-9][0-9]{0,19}$/.test(id)) throw new Error("invalid_proof_artifact_id");
    recordUnobservedGitHubInvocation([
      "api",
      "repos/openclaw/openclaw/actions/artifacts/" + id + "/zip",
    ]);
    let response = await this.fetcher(
      new URL("repos/openclaw/openclaw/actions/artifacts/" + id + "/zip", this.githubBase),
      {
        headers: this.githubHeaders(),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      },
    );
    await rejectGithubThrottle(response);
    if (response.status === 302) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("missing_proof_artifact_redirect");
      const target = new URL(location);
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        ![".blob.core.windows.net", ".actions.githubusercontent.com"].some((suffix) =>
          target.hostname.endsWith(suffix),
        )
      )
        throw new Error("untrusted_proof_artifact_redirect");
      // Never forward API credentials to the signed blob URL or expose that URL in logs.
      response = await this.fetcher(target, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("proof_artifact_http_" + response.status);
    }
    return boundedBytes(response, COMMAND_PROOF_ARCHIVE_MAX_BYTES);
  }
  queue(operation: "claim" | "pending" | "update", body: unknown) {
    return this.signedPost("/internal/command-proof/" + operation, body);
  }
  enqueue(body: unknown) {
    return this.signedPost("/internal/exact-review/enqueue", body);
  }
  status(claim: CommandProofClaim, state: string, detail: string) {
    return this.options.status(claim, state, detail);
  }
  private async signedPost(path: string, value: unknown) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 128 * 1024) throw new Error("proof_request_too_large");
    const response = await this.fetcher(this.options.queueUrl.replace(/\/$/, "") + path, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-clawsweeper-exact-review-signature":
          "sha256=" + createHmac("sha256", this.options.queueSecret).update(body).digest("hex"),
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("proof_queue_http_" + response.status);
    }
    return JSON.parse((await boundedBytes(response, 128 * 1024)).toString("utf8"));
  }
  private githubHeaders() {
    return {
      authorization: "Bearer " + this.options.githubToken,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2026-03-10",
      "user-agent": "clawsweeper-command-proof",
    };
  }
}
async function rejectGithubThrottle(response: Response) {
  const retry = response.headers.get("retry-after"),
    remaining = response.headers.get("x-ratelimit-remaining");
  if (response.status !== 429 && !(response.status === 403 && (retry || remaining === "0"))) return;
  const now = Date.now(),
    reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  const hinted = retry
    ? /^[0-9]+$/.test(retry)
      ? now + Number(retry) * 1000
      : Date.parse(retry)
    : reset;
  await response.body?.cancel();
  throw new GitHubRateLimitError("commanded proof GitHub request throttled", now, {
    retryAt: Number.isFinite(hinted) ? Math.max(now + 60000, hinted) : now + 60000,
    provenance: retry ? "retry_after" : remaining === "0" ? "rate_limit_reset" : "fallback",
    scope: "target_app",
  });
}
async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit || !response.body) {
    await response.body?.cancel();
    throw new Error("proof_response_too_large_or_empty");
  }
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("proof_response_too_large");
      parts.push(value);
    }
    return Buffer.concat(parts, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
