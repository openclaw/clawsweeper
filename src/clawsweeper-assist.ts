import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runAgentProcess } from "./agent-runner.js";
import {
  ASSIST_ANSWER_MAX_BYTES,
  ASSIST_ARTIFACT_MAX_BYTES,
  assertAssistArtifactLiveRevision,
  assistSourceCommentSha256,
  createAssistArtifact,
  parseAssistArtifact,
  type AssistArtifact,
  type AssistRequestBinding,
} from "./assist-artifact.js";
import { numberArg, stringArg, type Args } from "./clawsweeper-args.js";
import { DEFAULT_SERVICE_TIER } from "./clawsweeper-policy.js";
import { safeOutputTail } from "./clawsweeper-text.js";
import type {
  AssistSourceCommentSnapshot,
  Item,
  ItemContext,
  LiveAssistBinding,
} from "./clawsweeper-types.js";
import { codexLoginConfig, PUBLIC_CODEX_MODEL } from "./codex-env.js";
import type { RepositoryProfile } from "./repository-profiles.js";
import { stableJson } from "./stable-json.js";

interface AssistWorkflowDependencies {
  root: string;
  asRecord: (value: unknown) => Record<string, unknown>;
  canPatchReviewComment: (comment: Record<string, unknown> | undefined) => boolean;
  collectItemContext: (item: Item) => ItemContext;
  ensureDir: (path: string) => void;
  fetchItem: (number: number) => { item: Item; state: string };
  ghJson: <T>(args: string[]) => T;
  ghPaged: <T>(path: string) => T[];
  ghWithRetry: (args: string[]) => string;
  repoFromArgs: (args: Args) => RepositoryProfile;
  sha256: (text: string) => string;
  targetRepo: () => string;
  untrustedCodexEnv: () => NodeJS.ProcessEnv;
  writeCommentPayload: (number: number, body: string) => string;
}

export function createAssistWorkflow({
  root,
  asRecord,
  canPatchReviewComment,
  collectItemContext,
  ensureDir,
  fetchItem,
  ghJson,
  ghPaged,
  ghWithRetry,
  repoFromArgs,
  sha256,
  targetRepo,
  untrustedCodexEnv,
  writeCommentPayload,
}: AssistWorkflowDependencies) {
  function stripTextFence(markdown: string): string {
    const trimmed = markdown.trim();
    const match = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```\s*$/i);
    return match ? (match[1]?.trim() ?? trimmed) : trimmed;
  }

  const ASSIST_ISSUE_VOLATILE_PROMPT_FIELDS = new Set(["comments", "updatedAt"]);
  const ASSIST_PULL_VOLATILE_PROMPT_FIELDS = new Set(["mergeable", "mergeableState", "updatedAt"]);

  function omitRecordFields(value: unknown, omitted: ReadonlySet<string>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(asRecord(value)).filter(([key]) => !omitted.has(key)));
  }

  function assistPromptContext(context: ItemContext): Record<string, unknown> {
    const projected: Record<string, unknown> = {
      issue: omitRecordFields(context.issue, ASSIST_ISSUE_VOLATILE_PROMPT_FIELDS),
      comments: context.comments,
      sourceRevision: context.sourceRevision ?? null,
    };
    if (context.goodFirstIssueHumanLabelState !== undefined) {
      projected.goodFirstIssueHumanLabelState = context.goodFirstIssueHumanLabelState;
    }
    if (context.previousClawSweeperReview !== undefined) {
      projected.previousClawSweeperReview = context.previousClawSweeperReview;
    }
    if (context.closingPullRequests !== undefined) {
      projected.closingPullRequests = context.closingPullRequests.map((pull) =>
        omitRecordFields(pull, ASSIST_PULL_VOLATILE_PROMPT_FIELDS),
      );
    }
    if (context.referencingMergedPullRequests !== undefined) {
      projected.referencingMergedPullRequests = context.referencingMergedPullRequests;
    }
    if (context.pullRequest !== undefined) {
      projected.pullRequest = omitRecordFields(
        context.pullRequest,
        ASSIST_PULL_VOLATILE_PROMPT_FIELDS,
      );
    }
    if (context.pullFiles !== undefined) projected.pullFiles = context.pullFiles;
    if (context.pullCommits !== undefined) projected.pullCommits = context.pullCommits;
    if (context.pullReviewComments !== undefined) {
      projected.pullReviewComments = context.pullReviewComments;
    }
    return projected;
  }

  function assistPromptContextForTest(context: unknown): Record<string, unknown> {
    return assistPromptContext(context as ItemContext);
  }

  function buildAssistPrompt(options: {
    item: Item;
    context: ItemContext;
    question: string;
    sourceCommentUrl: string;
    author: string;
    mode?: string;
    lens?: string;
  }): string {
    if (options.mode === "visual")
      return buildVisualPrompt({
        item: options.item,
        context: options.context,
        question: options.question,
        sourceCommentUrl: options.sourceCommentUrl,
        author: options.author,
        ...(options.lens === undefined ? {} : { lens: options.lens }),
      });
    return [
      "You are ClawSweeper assist, a lightweight read-only maintainer Q&A helper for GitHub issues and pull requests.",
      "",
      "Hard safety contract:",
      "- Answer the maintainer's question concisely from the supplied context.",
      "- Do not recommend closing, merging, labeling, pushing, rebasing, or repairing as an executed action.",
      "- Do not emit hidden ClawSweeper verdict, action, security, or review markers.",
      "- If the question needs a full correctness review, say that and suggest `@clawsweeper review`.",
      "- If the question needs branch edits or CI repair, say that and suggest the existing repair command.",
      "- Prefer concrete evidence: check names, comments, files, commit SHAs, timestamps, and URLs present in context.",
      "",
      "Response format:",
      "- Start with `ClawSweeper assist:` followed by the direct answer.",
      "- Include short `Evidence:` bullets when evidence exists.",
      "- Include one `Suggested next action:` line.",
      "",
      "Request metadata:",
      `- Repository: ${options.item.repo}`,
      `- Item: #${options.item.number}`,
      `- Type: ${options.item.kind}`,
      `- Title: ${options.item.title}`,
      `- URL: ${options.item.url}`,
      `- Request author: ${options.author || "unknown"}`,
      `- Source comment: ${options.sourceCommentUrl || "unknown"}`,
      "",
      "Maintainer question:",
      options.question,
      "",
      "GitHub context JSON:",
      "```json",
      JSON.stringify(assistPromptContext(options.context), null, 2),
      "```",
    ].join("\n");
  }

  function buildVisualPrompt(options: {
    item: Item;
    context: ItemContext;
    question: string;
    sourceCommentUrl: string;
    author: string;
    lens?: string;
  }): string {
    const requestedLens = normalizeVisualLens(options.lens);
    return [
      "You are ClawSweeper visual brief, a read-only maintainer judgment helper for GitHub issues and pull requests.",
      "",
      "Hard safety contract:",
      "- Create a compact GitHub-comment-friendly ASCII/text visual brief only from supplied context.",
      "- Advisory only: maintainers remain the final judges.",
      "- Do not recommend closing, merging, labeling, pushing, rebasing, or repairing as an executed action.",
      "- Do not emit hidden ClawSweeper verdict, action, security, or review markers.",
      "- Avoid Mermaid and generated images. Use ASCII boxes, arrows, split screens, state tables, and checklists.",
      "- Use glyphs only in public markdown when they clarify states or transitions; include a legend when more than three glyphs appear.",
      "- Standard glyph meanings: ✅ expected/preserved/working/proven; ❌ broken/dropped/failing/rejected path; ⚠️ maintainer risk/unresolved concern/tradeoff; 🐛 confirmed bug path or pre-fix broken behavior; 🔒 credential/security/privacy/trust boundary; 💾 persisted disk state/storage/file output; 🧠 runtime/in-memory/session/active process state; 🧑‍⚖️ maintainer judgment point.",
      "- Do not decorate every noun. Prefer glyphs on important states, transitions, risks, proof markers, and maintainer judgment points.",
      "",
      "Lens guidance:",
      "- ux: user/operator visible behavior.",
      "- flow: routing, delivery, queues, providers, tools, or pipelines.",
      "- state: sessions, locks, auth, config, identity, lifecycle, flags, or modes.",
      "- data: payloads, protocol responses, redaction, projection, storage, schemas, or migrations.",
      "- proof: missing, stale, disputed, or confusing behavior proof.",
      "- risk: compatibility, operator impact, security boundary, availability, automation, or session-state tradeoff.",
      "- maintainer: product, policy, API, UX, or architecture judgment.",
      "",
      "Response format:",
      "- Start with `# Visual brief`.",
      `- Requested lens: ${requestedLens}. If it is auto, choose the strongest lens and name it near the top.`,
      "- Prefer compact visuals over long prose.",
      "- Show before/after or current/proposed behavior when applicable.",
      "- Show remaining risk or maintainer judgment when applicable.",
      "- Clearly state that this is advisory and maintainers remain the final judges.",
      "- End with this footer only when it has concrete content. Omit empty fields.",
      "",
      "## Maintainer ruling",
      "",
      "Benefit:",
      "Risk:",
      "Proof needed:",
      "Recommended next action:",
      "Question presented:",
      "",
      "Request metadata:",
      `- Repository: ${options.item.repo}`,
      `- Item: #${options.item.number}`,
      `- Type: ${options.item.kind}`,
      `- Title: ${options.item.title}`,
      `- URL: ${options.item.url}`,
      `- Request author: ${options.author || "unknown"}`,
      `- Source comment: ${options.sourceCommentUrl || "unknown"}`,
      `- Maintainer request: ${options.question || `visualize ${requestedLens}`}`,
      "",
      "GitHub context JSON:",
      "```json",
      JSON.stringify(assistPromptContext(options.context), null, 2),
      "```",
    ].join("\n");
  }

  function runCodexAssist(options: {
    item: Item;
    context: ItemContext;
    question: string;
    sourceCommentUrl: string;
    author: string;
    model: string;
    reasoningEffort: string;
    sandboxMode: string;
    timeoutMs: number;
    workDir: string;
    mode?: string;
    lens?: string;
  }): string {
    ensureDir(options.workDir);
    rmSync(join(options.workDir, `${options.item.number}.assist.prompt.md`), { force: true });
    const outputPath = join(options.workDir, `${options.item.number}.assist.md`);
    const prompt = buildAssistPrompt({
      item: options.item,
      context: options.context,
      question: options.question,
      sourceCommentUrl: options.sourceCommentUrl,
      author: options.author,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.lens === undefined ? {} : { lens: options.lens }),
    });
    const codexConfig = [
      codexLoginConfig(),
      'approval_policy="never"',
      `service_tier=${JSON.stringify(DEFAULT_SERVICE_TIER)}`,
    ];
    const emptyGitHubConfigDir = join(options.workDir, ".gh-empty");
    ensureDir(emptyGitHubConfigDir);
    const result = runAgentProcess({
      scanSource: { kind: "prompt" },
      label: `assist-${options.item.number}`,
      prompt,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      codexExtraArgs: [
        ...codexConfig.flatMap((config) => ["-c", config]),
        "--output-last-message",
        outputPath,
        "--sandbox",
        options.sandboxMode,
        "-",
      ],
      cwd: root,
      env: { ...untrustedCodexEnv(), GH_CONFIG_DIR: emptyGitHubConfigDir },
      timeoutMs: options.timeoutMs,
    });
    if (result.error || result.status !== 0 || !existsSync(outputPath)) {
      const detail =
        result.error instanceof Error
          ? result.error.message
          : `exit ${result.status ?? "unknown"}: ${
              safeOutputTail(result.stderr) || safeOutputTail(result.stdout) || "No output."
            }`;
      throw new Error(`Codex assist failed for #${options.item.number}: ${detail}`);
    }
    return stripTextFence(
      readBoundedUtf8File(outputPath, ASSIST_ANSWER_MAX_BYTES + 4_096, "Codex assist output"),
    );
  }

  function readBoundedUtf8File(path: string, maxBytes: number, label: string): string {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
      }
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const bytesRead = readSync(fd, buffer, offset, size - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const extra = Buffer.alloc(1);
      if (readSync(fd, extra, 0, 1, null) > 0) {
        throw new Error(`${label} changed while being read`);
      }
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }

  function assistCommentMarker(idempotencyKey: string): string {
    return `<!-- clawsweeper-assist:${idempotencyKey} -->`;
  }

  const VISUAL_LENSES = new Set(["ux", "flow", "state", "data", "proof", "risk", "maintainer"]);

  function normalizeVisualLens(value: unknown): string {
    const lens = typeof value === "string" ? value.trim().toLowerCase() : "auto";
    return VISUAL_LENSES.has(lens) ? lens : "auto";
  }

  function visualCommentMarker(number: number, lens: string, headSha: string): string {
    return `<!-- clawsweeper-visual item=${number} lens=${normalizeVisualLens(lens)} sha=${headSha || "na"} -->`;
  }

  const MAINTAINER_RULING_FIELDS = new Set([
    "Benefit",
    "Risk",
    "Proof needed",
    "Recommended next action",
    "Question presented",
  ]);

  function stripEmptyMaintainerRulingFieldsForTest(body: string): string {
    const lines = body.split(/\r?\n/);
    const headingIndex = lines.findIndex((line) =>
      /^##\s+Maintainer ruling\s*$/i.test(line.trim()),
    );
    if (headingIndex === -1) return body;

    let endIndex = lines.length;
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      if (/^##\s+\S/.test(lines[index]?.trim() ?? "")) {
        endIndex = index;
        break;
      }
    }

    const sectionLines = lines.slice(headingIndex + 1, endIndex);
    const keptSectionLines = sectionLines.filter((line) => {
      const match = line.trim().match(/^([^:]+):\s*$/);
      return !match || !MAINTAINER_RULING_FIELDS.has(match[1]?.trim() ?? "");
    });
    const hasConcreteContent = keptSectionLines.some((line) => line.trim().length > 0);
    const replacement = hasConcreteContent ? [lines[headingIndex]!, ...keptSectionLines] : [];

    return [...lines.slice(0, headingIndex), ...replacement, ...lines.slice(endIndex)]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function renderAssistComment(options: {
    body: string;
    model: string;
    reasoningEffort: string;
    sourceCommentUrl: string;
    sourceCommentId: string;
    idempotencyKey: string;
  }): string {
    const body = options.body.trim() || "ClawSweeper assist: I could not produce an answer.";
    const sourceLine = options.sourceCommentUrl
      ? `Source: ${options.sourceCommentUrl}`
      : `Source comment: ${options.sourceCommentId || "unknown"}`;
    return [
      body,
      "",
      "---",
      `${sourceLine}`,
      `Assist reasoning: ${options.reasoningEffort}.`,
      assistCommentMarker(options.idempotencyKey),
    ].join("\n");
  }

  function renderVisualComment(options: {
    body: string;
    item: Item;
    context: ItemContext;
    lens: string;
    model: string;
    reasoningEffort: string;
    sourceCommentUrl: string;
    sourceCommentId: string;
  }): string {
    const body =
      stripEmptyMaintainerRulingFieldsForTest(options.body).trim() ||
      "# Visual brief\n\nNo visual brief could be produced.";
    const headSha = itemHeadSha(options.item, options.context);
    const sourceLine = options.sourceCommentUrl
      ? `Source: ${options.sourceCommentUrl}`
      : `Source comment: ${options.sourceCommentId || "unknown"}`;
    return [
      visualCommentMarker(options.item.number, options.lens, headSha),
      `${sourceLine}`,
      `Visual reasoning: ${options.reasoningEffort}.`,
      "",
      body,
    ].join("\n");
  }

  function itemHeadSha(item: Item, context: ItemContext): string {
    if (item.kind !== "pull_request") return "na";
    const pull = asRecord(context.pullRequest);
    const head = asRecord(pull.head);
    return typeof head.sha === "string" ? head.sha.trim() || "na" : "na";
  }

  function findOwnedCommentByMarker(
    number: number,
    marker: string,
  ): Record<string, unknown> | null {
    const owned = ghPaged<unknown>(`repos/${targetRepo()}/issues/${number}/comments?per_page=100`)
      .map(asRecord)
      .filter(
        (comment) =>
          typeof comment.body === "string" &&
          comment.body.includes(marker) &&
          canPatchReviewComment(comment),
      );
    return owned.at(-1) ?? null;
  }

  function publishIdempotentAssistComment(
    number: number,
    existing: Record<string, unknown> | null,
    body: string,
  ): "posted" | "updated" | "unchanged" {
    if (existing && existing.body === body) return "unchanged";
    const payload = writeCommentPayload(number, body);
    const existingId =
      typeof existing?.id === "number" || typeof existing?.id === "string" ? existing.id : null;
    if (existingId) {
      ghWithRetry([
        "api",
        `repos/${targetRepo()}/issues/comments/${existingId}`,
        "--method",
        "PATCH",
        "--input",
        payload,
      ]);
      return "updated";
    }
    ghWithRetry([
      "api",
      `repos/${targetRepo()}/issues/${number}/comments`,
      "--method",
      "POST",
      "--input",
      payload,
    ]);
    return "posted";
  }

  function assistResolveTargetCommand(args: Args): void {
    const profile = repoFromArgs(args);
    const [owner, repository, ...extra] = profile.targetRepo.split("/");
    if (!owner || !repository || extra.length > 0) {
      throw new Error("assist target repository must be an owner/repository slug");
    }
    console.log(JSON.stringify({ repo: profile.targetRepo, owner, repository }));
  }

  function assistRequestFromArgs(args: Args): AssistRequestBinding {
    const itemNumber = numberArg(args.item_number, 0);
    if (!Number.isSafeInteger(itemNumber) || itemNumber <= 0) {
      throw new Error("--item-number is required for assist");
    }
    const question = stringArg(args.question, "").trim();
    if (!question) throw new Error("--question is required for assist");
    if (Buffer.byteLength(question, "utf8") > 10_000) {
      throw new Error("--question exceeds the 10000-byte assist limit");
    }
    const mode = stringArg(args.mode, "assist").trim();
    if (mode !== "assist" && mode !== "visual") {
      throw new Error("--mode must be assist or visual");
    }
    const requestedLens = stringArg(args.lens, "auto").trim().toLowerCase();
    if (requestedLens !== "auto" && !VISUAL_LENSES.has(requestedLens)) {
      throw new Error("--lens is invalid for assist");
    }
    const request: AssistRequestBinding = {
      targetRepo: targetRepo(),
      itemNumber,
      question,
      mode,
      lens: requestedLens,
      sourceCommentId: stringArg(args.comment_id, "").trim(),
      sourceCommentUrl: stringArg(args.comment_url, "").trim(),
      author: stringArg(args.author, "").trim(),
      reasoningEffort: stringArg(args.codex_reasoning_effort, "high").trim(),
    };
    if (Buffer.byteLength(request.sourceCommentUrl, "utf8") > 1_000) {
      throw new Error("--comment-url exceeds the 1000-byte assist limit");
    }
    if (Buffer.byteLength(request.author, "utf8") > 100) {
      throw new Error("--author exceeds the 100-byte assist limit");
    }
    if (!/^(?:low|medium|high|xhigh)$/.test(request.reasoningEffort)) {
      throw new Error("--codex-reasoning-effort is invalid for assist");
    }
    return request;
  }

  function assistWorkflowIdentity(args: Args): { runId: string; runAttempt: number } {
    const runId = stringArg(args.run_id, process.env.GITHUB_RUN_ID ?? "").trim();
    const runAttempt = numberArg(
      args.run_attempt,
      Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? "", 10),
    );
    if (!/^\d{1,30}$/.test(runId)) throw new Error("--run-id is required for assist artifacts");
    if (!Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
      throw new Error("--run-attempt is required for assist artifacts");
    }
    return { runId, runAttempt };
  }

  function assistArtifactPath(args: Args): string {
    const value = stringArg(args.artifact, "").trim();
    if (!value) throw new Error("--artifact is required for assist generation and publishing");
    return resolve(value);
  }

  function fetchAssistSourceComment(
    request: AssistRequestBinding,
  ): AssistSourceCommentSnapshot | null {
    if (!request.sourceCommentId) return null;
    if (!/^\d{1,30}$/.test(request.sourceCommentId)) {
      throw new Error("assist source comment id is invalid");
    }
    const comment = ghJson<Record<string, unknown>>([
      "api",
      `repos/${targetRepo()}/issues/comments/${request.sourceCommentId}`,
    ]);
    const user = asRecord(comment.user);
    const id = comment.id;
    const snapshot: AssistSourceCommentSnapshot = {
      id: typeof id === "string" || typeof id === "number" ? String(id) : "",
      issueUrl: typeof comment.issue_url === "string" ? comment.issue_url : "",
      htmlUrl: typeof comment.html_url === "string" ? comment.html_url : "",
      author: typeof user.login === "string" ? user.login : "",
      body: typeof comment.body === "string" ? comment.body : "",
      updatedAt:
        typeof comment.updated_at === "string"
          ? comment.updated_at
          : typeof comment.created_at === "string"
            ? comment.created_at
            : "",
    };
    if (
      snapshot.id !== request.sourceCommentId ||
      !assistIssueUrlMatches(snapshot.issueUrl, targetRepo(), request.itemNumber) ||
      !snapshot.htmlUrl
    ) {
      throw new Error("assist source comment does not belong to the requested repository and item");
    }
    if (request.author && snapshot.author.toLowerCase() !== request.author.toLowerCase()) {
      throw new Error("assist source comment author changed or does not match the request");
    }
    if (request.sourceCommentUrl && snapshot.htmlUrl !== request.sourceCommentUrl) {
      throw new Error("assist source comment URL does not match the request");
    }
    return snapshot;
  }

  function assistIssueUrlMatches(issueUrl: string, repo: string, itemNumber: number): boolean {
    const expectedIssuePath = `/repos/${repo}/issues/${itemNumber}`.toLowerCase();
    return issueUrl.toLowerCase().endsWith(expectedIssuePath);
  }

  function assistIssueUrlMatchesForTest(
    issueUrl: string,
    repo: string,
    itemNumber: number,
  ): boolean {
    return assistIssueUrlMatches(issueUrl, repo, itemNumber);
  }

  function assistSourceDigest(source: AssistSourceCommentSnapshot | null): string | null {
    return source ? assistSourceCommentSha256(source) : null;
  }

  function assistPromptContextDigest(item: Item, context: ItemContext): string {
    return sha256(
      stableJson({
        item: {
          repo: item.repo,
          number: item.number,
          kind: item.kind,
          title: item.title,
          url: item.url,
        },
        context: assistPromptContext(context),
      }),
    );
  }

  function captureLiveAssistBinding(request: AssistRequestBinding): LiveAssistBinding {
    const { item, state } = fetchItem(request.itemNumber);
    if (state.toLowerCase() !== "open") {
      throw new Error(`assist requires an open issue or PR; #${request.itemNumber} is ${state}`);
    }
    const context = collectItemContext(item);
    if (!/^[0-9a-f]{64}$/.test(String(context.sourceRevision ?? ""))) {
      throw new Error("assist could not compute the live item source revision");
    }
    return {
      item,
      context,
      sourceComment: fetchAssistSourceComment(request),
    };
  }

  function validateLiveAssistArtifact(
    artifact: AssistArtifact,
    request: AssistRequestBinding,
  ): LiveAssistBinding {
    const live = captureLiveAssistBinding(request);
    const liveHead =
      live.item.kind === "pull_request" ? itemHeadSha(live.item, live.context) : null;
    assertAssistArtifactLiveRevision(artifact, {
      itemKind: live.item.kind,
      sourceRevision: live.context.sourceRevision!,
      contextDigest: assistPromptContextDigest(live.item, live.context),
      pullHeadSha: liveHead,
      sourceDigest: assistSourceDigest(live.sourceComment),
    });
    return live;
  }

  function assistGenerateCommand(args: Args): void {
    repoFromArgs(args);
    const request = assistRequestFromArgs(args);
    const workflow = assistWorkflowIdentity(args);
    const artifactPath = assistArtifactPath(args);
    const model = stringArg(args.codex_model, PUBLIC_CODEX_MODEL);
    const sandboxMode = stringArg(args.codex_sandbox, "read-only");
    const timeoutMs = numberArg(args.codex_timeout_ms, 120_000);
    const workDir = resolve(stringArg(args.work_dir, join(root, ".artifacts", "assist-codex")));
    const live = captureLiveAssistBinding(request);
    const answer = runCodexAssist({
      item: live.item,
      context: live.context,
      question: request.question,
      sourceCommentUrl: live.sourceComment?.htmlUrl ?? request.sourceCommentUrl,
      author: live.sourceComment?.author ?? request.author,
      model,
      reasoningEffort: request.reasoningEffort,
      sandboxMode,
      timeoutMs,
      workDir,
      mode: request.mode,
      lens: request.lens,
    });
    const pullHeadSha =
      live.item.kind === "pull_request" ? itemHeadSha(live.item, live.context) : null;
    const artifact = createAssistArtifact({
      generatedAt: new Date().toISOString(),
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
      itemKind: live.item.kind,
      sourceRevision: live.context.sourceRevision!,
      contextDigest: assistPromptContextDigest(live.item, live.context),
      pullHeadSha,
      sourceDigest: assistSourceDigest(live.sourceComment),
      request,
      answer,
    });
    ensureDir(dirname(artifactPath));
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify({
        generated: true,
        posted: false,
        artifact: artifactPath,
        idempotency_key: artifact.idempotency_key,
        mode: request.mode,
        item: request.itemNumber,
        model: PUBLIC_CODEX_MODEL,
        reasoningEffort: request.reasoningEffort,
      }),
    );
  }

  function assistPublishCommand(args: Args): void {
    repoFromArgs(args);
    const request = assistRequestFromArgs(args);
    const workflow = assistWorkflowIdentity(args);
    const artifact = parseAssistArtifact(
      readBoundedUtf8File(assistArtifactPath(args), ASSIST_ARTIFACT_MAX_BYTES, "assist artifact"),
      {
        runId: workflow.runId,
        runAttempt: workflow.runAttempt,
        request,
      },
    );

    const initialLive = validateLiveAssistArtifact(artifact, request);
    const initialHead =
      initialLive.item.kind === "pull_request"
        ? itemHeadSha(initialLive.item, initialLive.context)
        : "na";
    const marker =
      request.mode === "visual"
        ? visualCommentMarker(request.itemNumber, request.lens, initialHead)
        : assistCommentMarker(artifact.idempotency_key);
    const existing = findOwnedCommentByMarker(request.itemNumber, marker);

    // Re-fetch after idempotency discovery so target/source drift during artifact handling wins
    // immediately before the only GitHub mutation in this process.
    const live = validateLiveAssistArtifact(artifact, request);
    const sourceCommentUrl = live.sourceComment?.htmlUrl ?? request.sourceCommentUrl;
    const body =
      request.mode === "visual"
        ? renderVisualComment({
            body: artifact.output.answer,
            item: live.item,
            context: live.context,
            lens: request.lens,
            model: PUBLIC_CODEX_MODEL,
            reasoningEffort: request.reasoningEffort,
            sourceCommentUrl,
            sourceCommentId: request.sourceCommentId,
          })
        : renderAssistComment({
            body: artifact.output.answer,
            model: PUBLIC_CODEX_MODEL,
            reasoningEffort: request.reasoningEffort,
            sourceCommentUrl,
            sourceCommentId: request.sourceCommentId,
            idempotencyKey: artifact.idempotency_key,
          });
    const action = publishIdempotentAssistComment(request.itemNumber, existing, body);
    console.log(
      JSON.stringify({
        posted: action === "posted",
        action,
        mode: request.mode,
        item: request.itemNumber,
        idempotency_key: artifact.idempotency_key,
      }),
    );
  }

  function assistValidateArtifactCommand(args: Args): void {
    repoFromArgs(args);
    const request = assistRequestFromArgs(args);
    const workflow = assistWorkflowIdentity(args);
    const artifact = parseAssistArtifact(
      readBoundedUtf8File(assistArtifactPath(args), ASSIST_ARTIFACT_MAX_BYTES, "assist artifact"),
      {
        runId: workflow.runId,
        runAttempt: workflow.runAttempt,
        request,
      },
    );
    console.log(
      JSON.stringify({
        valid: true,
        item: artifact.target.item_number,
        mode: artifact.request.mode,
        idempotency_key: artifact.idempotency_key,
      }),
    );
  }

  return {
    assistIssueUrlMatchesForTest,
    assistPromptContextForTest,
    stripEmptyMaintainerRulingFieldsForTest,
    assistGenerateCommand,
    assistPublishCommand,
    assistResolveTargetCommand,
    assistValidateArtifactCommand,
  };
}
