import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { useFakeScanner } from "./agent-input-scan-helpers.ts";
import { changelogReviewDecision, reviewFinding } from "./helpers.ts";
import { readReviewRecord } from "../dist/review-record.js";
import { renderReviewCommentFromReport } from "../dist/clawsweeper-report-comment-presentation.js";
import { prStatusLabelKindFromReport } from "../dist/clawsweeper-label-policy.js";

const cli = fileURLToPath(new URL("../dist/clawsweeper.js", import.meta.url));
const models = ["openrouter/anthropic/claude-opus-5.5", "openrouter/openai/gpt-6-astra"];
const ambient = "openrouter/ambient-model";
const native = process.env.CLAWSWEEPER_NATIVE_OPENCLAW_BIN;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// The normal test captures native argv/config and supplies deterministic responses.
// Opt-in proof delegates unchanged argv to the real installed OpenClaw CLI.
function launcher(root: string): string {
  const script = join(root, "openclaw-fixture.mjs");
  writeFileSync(
    script,
    String.raw`import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2), config=JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH,'utf8'));
const model=args[args.indexOf('--model')+1], prompt=fs.readFileSync(args[args.indexOf('--message-file')+1],'utf8');
const inspection=Array.isArray(config.tools?.allow);
fs.appendFileSync(process.env.OPENCLAW_TEST_TRACE,JSON.stringify({model,inspection,timeout:Number(args[args.indexOf('--timeout')+1]),thinking:args.includes('--thinking')?args[args.indexOf('--thinking')+1]:null,providers:config.models?.providers,hasPeerAnswer:prompt.includes('Claude original recommendation'),hasWorkflowToken:Boolean(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)})+'\n');
if(process.env.OPENCLAW_TEST_NATIVE_BIN){const r=spawnSync(process.env.OPENCLAW_TEST_NATIVE_BIN,args,{stdio:'inherit',env:process.env});process.exit(r.status??1);}
if(!inspection&&model===${JSON.stringify(models[0])})Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);
let text;
if(inspection){
 const match=prompt.match(/Path: ("[^"\n]+")\nReturn exactly line (\d+)/), path=JSON.parse(match[1]);
 text=fs.readFileSync(path,'utf8').split(/\r?\n/)[Number(match[2])-1].trim();
 const entries=[{message:{role:'assistant',content:[{type:'toolCall',id:'read',name:'read',arguments:{path}}]}},{message:{role:'toolResult',toolCallId:'read',toolName:'read',isError:false,content:[{type:'text',text}]}}];
 fs.writeFileSync(process.env.CLAWSWEEPER_OPENCLAW_RECEIPT_PATH,entries.map(x=>JSON.stringify(x)).join('\n')+'\n');
}else{
 const index=model===${JSON.stringify(models[1])}?1:0;
 if(index===1&&process.env.OPENCLAW_TEST_FAIL_SECOND==='1')process.exit(1);
 text=JSON.stringify(JSON.parse(fs.readFileSync(process.env.OPENCLAW_TEST_RESPONSES,'utf8'))[index]);
}
console.log(JSON.stringify({payloads:[{text}],meta:{stopReason:'stop'}}));
`,
  );
  const binary = join(
    root,
    process.platform === "win32" ? "openclaw-fixture.cmd" : "openclaw-fixture",
  );
  writeFileSync(
    binary,
    process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  return binary;
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { code, stdout, stderr };
}

test(
  "compiled CLI binds separate OpenClaw models to inspection, config and high-thinking reviews",
  { timeout: 180_000 },
  async (t) => {
    if (process.env.CLAWSWEEPER_REAL_SCANNER !== "1") useFakeScanner(t);
    const root = mkdtempSync(join(tmpdir(), "independent-openclaw-")),
      target = join(root, "target");
    mkdirSync(target);
    const replies = [
      changelogReviewDecision({
        summary: "Claude original recommendation",
        bestSolution: "Claude reasoning remains intact.",
        reviewFindings: [reviewFinding({ title: "Claude finding", priority: 1 })],
      }),
      changelogReviewDecision({
        summary: "Astra original recommendation",
        bestSolution: "Astra reasoning remains intact.",
        reviewFindings: [reviewFinding({ title: "Astra finding", priority: 2 })],
        realBehaviorProof: {
          status: "missing",
          summary: "Runtime proof is missing.",
          evidenceKind: "none",
          needsContributorAction: true,
        },
      }),
    ];
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      const user = messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      const inspection = user.match(/Path: ("[^"\n]+")\nReturn exactly line (\d+)/);
      let delta: Record<string, unknown>,
        finish = "stop";
      if (inspection && !messages.some((m) => m.role === "tool")) {
        delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "read-checkout",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: JSON.parse(inspection[1]!) }),
              },
            },
          ],
        };
        finish = "tool_calls";
      } else {
        const content = inspection
          ? readFileSync(resolve(target, JSON.parse(inspection[1]!)), "utf8")
              .split(/\r?\n/)
              [Number(inspection[2]) - 1]!.trim()
          : JSON.stringify(replies[body.model === models[1]!.slice("openrouter/".length) ? 1 : 0]);
        delta = { role: "assistant", content };
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: finish },
      ])
        res.write(
          "data: " +
            JSON.stringify({
              id: "fixture-response",
              object: "chat.completion.chunk",
              created: 1,
              model: body.model,
              choices: [choice],
            }) +
            "\n\n",
        );
      res.end("data: [DONE]\n\n");
    });
    try {
      git(target, "init", "-q");
      git(target, "config", "user.name", "Controlled Reviewer");
      git(target, "config", "user.email", "fixture@example.invalid");
      writeFileSync(
        join(target, "AGENTS.md"),
        "Inspect this tracked repository and keep both original opinions.\n",
      );
      writeFileSync(
        join(target, "feature.txt"),
        "The original runtime behavior remains observable here.\n",
      );
      git(target, "add", ".");
      git(target, "commit", "-qm", "base");
      git(target, "branch", "base-ref");
      writeFileSync(
        join(target, "feature.txt"),
        "The changed runtime behavior remains observable here.\n",
      );
      git(target, "add", ".");
      git(target, "commit", "-qm", "change");
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const providers = {
        openrouter: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "public-controlled-boundary-only",
          models: [...models, ambient].map((m) => ({
            id: m.slice("openrouter/".length),
            name: m,
            reasoning: true,
            contextWindow: 128000,
            maxTokens: 16000,
          })),
        },
      };
      const trace = join(root, "trace.jsonl"),
        response = join(root, "responses.json");
      writeFileSync(response, JSON.stringify(replies));
      const env = { ...process.env };
      for (const name of Object.keys(env))
        if (/(?:API_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY)$/.test(name)) delete env[name];
      delete env.CLAWSWEEPER_MULTI_REVIEW_CONFIG;
      const home = join(root, "home");
      mkdirSync(home);
      Object.assign(env, {
        HOME: home,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        CLAWSWEEPER_RUNNER: "openclaw",
        CLAWSWEEPER_OPENCLAW_MODEL: ambient,
        CLAWSWEEPER_OPENCLAW_BIN: launcher(root),
        CLAWSWEEPER_OPENCLAW_PROVIDERS_JSON: JSON.stringify(providers),
        OPENCLAW_TEST_TRACE: trace,
        OPENCLAW_TEST_RESPONSES: response,
        ...(native ? { OPENCLAW_TEST_NATIVE_BIN: native } : {}),
      });
      // No inherited provider/proxy grant enters the controlled, loopback-only run.
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[key];
      for (const mode of native ? ["pair"] : ["pair", "failed-second", "single"]) {
        writeFileSync(trace, "");
        env.OPENCLAW_TEST_FAIL_SECOND = mode === "failed-second" ? "1" : "0";
        const result = await run(
          [
            "review",
            "--local-range",
            "--target-dir",
            target,
            "--target-repo",
            "openclaw/clawsweeper",
            "--base",
            "base-ref",
            "--output-retention",
            "none",
            "--result-format",
            "json",
            "--codex-timeout-ms",
            "120000",
            ...(mode === "single" ? [] : ["--review-models", models.join(",")]),
          ],
          env,
        );
        assert.equal(result.code, mode === "failed-second" ? 1 : 0, result.stderr + result.stdout);
        const report = JSON.parse(result.stdout).reports[0].report,
          stored = readReviewRecord(report)!.decision;
        const calls = readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.ok(calls.every((c) => !c.hasWorkflowToken && !c.hasPeerAnswer));
        for (const call of calls) assert.deepEqual(call.providers, providers);
        assert.deepEqual(
          calls.map((c) => c.model),
          mode === "single" ? [ambient, ambient] : [models[0], models[0], models[1], models[1]],
        );
        const reviews = calls.filter((c) => !c.inspection);
        assert.equal(reviews.length, mode === "single" ? 1 : 2);
        assert.ok(calls.every((call) => call.timeout > 0 && call.timeout <= 120));
        if (mode !== "single")
          assert.ok(
            reviews[1].timeout < reviews[0].timeout,
            "second review receives the remaining item deadline",
          );
        assert.ok(reviews.every((c) => c.thinking === (mode === "single" ? "medium" : "high")));
        assert.ok(
          calls.every((c) =>
            c.providers.openrouter.models.some(
              (m: { id: string }) => m.id === c.model.slice("openrouter/".length),
            ),
          ),
        );
        if (mode !== "single") {
          assert.deepEqual(
            stored.independentReviews!.map((r) => r.requestedModel),
            models,
          );
          assert.equal(stored.independentReviews![0]!.decision.summary, replies[0]!.summary);
          if (mode === "failed-second")
            assert.equal(stored.independentReviews![1]!.status, "failed");
          else {
            assert.equal(
              stored.independentReviews![1]!.decision.bestSolution,
              replies[1]!.bestSolution,
            );
            const comment = renderReviewCommentFromReport(report, "none");
            assert.match(comment, /Claude finding/);
            assert.match(comment, /Astra finding/);
            assert.equal(
              prStatusLabelKindFromReport(report, { comments: [], timeline: [] }, []),
              "needs_proof",
            );
            if (process.env.CLAWSWEEPER_NATIVE_PROOF_ARTIFACT_DIR) {
              const out = process.env.CLAWSWEEPER_NATIVE_PROOF_ARTIFACT_DIR;
              mkdirSync(out, { recursive: true });
              writeFileSync(join(out, "report.md"), report);
              writeFileSync(join(out, "comment.md"), comment);
              writeFileSync(
                join(out, "calls.json"),
                JSON.stringify(
                  {
                    calls,
                    requests: requests.map((r) => ({
                      model: r.model,
                      reasoning: r.reasoning,
                      reasoning_effort: r.reasoning_effort,
                    })),
                    limits:
                      "Controlled loopback responses; native reader/client binding only, not real Claude/Astra reasoning.",
                  },
                  null,
                  2,
                ),
              );
            }
          }
        } else assert.equal(stored.independentReviews, undefined);
        assert.equal(git(target, "status", "--porcelain"), "");
      }
      if (native) {
        assert.deepEqual(
          [...new Set(requests.map((r) => r.model))].sort(),
          models.map((m) => m.slice("openrouter/".length)).sort(),
        );
        const full = requests.filter((r) =>
          JSON.stringify(r.messages).includes("## Repository State"),
        );
        assert.deepEqual(
          full.map((r) => r.model),
          models.map((m) => m.slice("openrouter/".length)),
        );
        assert.ok(
          full.every(
            (r) =>
              (r.reasoning as { effort?: string })?.effort === "high" ||
              r.reasoning_effort === "high",
          ),
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
