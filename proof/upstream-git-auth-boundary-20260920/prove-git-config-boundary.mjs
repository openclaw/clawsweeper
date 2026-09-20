import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url);
const distReviewEnv = new URL("../../dist/codex-env.js", import.meta.url);
const distRepairEnv = new URL("../../dist/repair/process-env.js", import.meta.url);
const sentinel = {
  count: "2",
  key0: "user.name",
  value0: "synthetic-git-config-boundary",
  key1: "user.email",
  value1: "synthetic-git-config-boundary@invalid.example",
  parameters: "'user.email=synthetic-git-config-parameters@invalid.example'",
};
const gitKeys = [
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_KEY_1",
  "GIT_CONFIG_VALUE_1",
];
const caseVariantGitKeys = ["git_config_count", "git_config_key_0", "git_config_value_0"];
const overlay = {
  GIT_CONFIG_COUNT: sentinel.count,
  GIT_CONFIG_PARAMETERS: sentinel.parameters,
  GIT_CONFIG_KEY_0: sentinel.key0,
  GIT_CONFIG_VALUE_0: sentinel.value0,
  GIT_CONFIG_KEY_1: sentinel.key1,
  GIT_CONFIG_VALUE_1: sentinel.value1,
  git_config_count: "1",
  git_config_key_0: "user.name",
  git_config_value_0: "synthetic-lowercase-name",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GH_TOKEN: "synthetic-negative-control",
  CLAWSWEEPER_GIT_USER_NAME: "clawsweeper-repair",
  CLAWSWEEPER_GIT_USER_EMAIL: "bot@example.invalid",
};

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: fileURLToPath(root),
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    error: result.error?.code ?? null,
  };
}

function inspectChild(modelEnv) {
  const child = run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { spawnSync } from "node:child_process";
    const name = spawnSync("git", ["config", "--get", "user.name"], { encoding: "utf8" });
    const email = spawnSync("git", ["config", "--get", "user.email"], { encoding: "utf8" });
    console.log(JSON.stringify({
      presentGitKeys: ${JSON.stringify(gitKeys)}.filter((key) => process.env[key] !== undefined),
      presentCaseVariantGitKeys: ${JSON.stringify(caseVariantGitKeys)}.filter(
        (key) => process.env[key] !== undefined,
      ),
      nameStatus: name.status,
      emailStatus: email.status,
      nameMatchesSentinel: (name.stdout ?? "").trim() === ${JSON.stringify(sentinel.value0)},
      emailMatchesSentinel: (email.stdout ?? "").trim() === ${JSON.stringify(sentinel.parameters.slice(1, -1).split("=")[1])},
    }));
  `,
    ],
    modelEnv,
  );
  return JSON.parse(child.stdout);
}

function summarizeBuilder(modelEnv, child) {
  return {
    retainedGitKeys: gitKeys.filter((key) => modelEnv[key] !== undefined),
    retainedCaseVariantGitKeys: caseVariantGitKeys.filter((key) => modelEnv[key] !== undefined),
    ghTokenStripped: modelEnv.GH_TOKEN === undefined,
    gitConfigGlobalPreserved: modelEnv.GIT_CONFIG_GLOBAL === "/dev/null",
    gitOptionalLocks: modelEnv.GIT_OPTIONAL_LOCKS ?? null,
    child,
  };
}

const original = { ...process.env };
Object.assign(process.env, overlay);
const tempRoot = mkdtempSync(join(tmpdir(), "clawsweeper-proof space %"));
try {
  mkdirSync(join(tempRoot, "dist", "repair"), { recursive: true });
  copyFileSync(fileURLToPath(distReviewEnv), join(tempRoot, "dist", "codex-env.js"));
  copyFileSync(fileURLToPath(distRepairEnv), join(tempRoot, "dist", "repair", "process-env.js"));
  const encodedRoot = pathToFileURL(`${tempRoot}/`);
  const encodedReview = new URL("./dist/codex-env.js", encodedRoot);
  const encodedRepair = new URL("./dist/repair/process-env.js", encodedRoot);
  let oldEncodedImportCode = null;
  try {
    await import(pathToFileURL(encodedReview.pathname).href);
  } catch (error) {
    oldEncodedImportCode = error.code ?? String(error);
  }
  let oldNormalImportFailed = false;
  try {
    await import(pathToFileURL(distReviewEnv.pathname).href);
  } catch {
    oldNormalImportFailed = true;
  }
  const { codexEnv } = await import(distReviewEnv.href);
  const { codexSubprocessEnv } = await import(distRepairEnv.href);
  const encodedReviewMod = await import(encodedReview.href);
  const encodedRepairMod = await import(encodedRepair.href);
  const reviewEnv = codexEnv();
  const repairEnv = codexSubprocessEnv();
  const encodedReviewEnv = encodedReviewMod.codexEnv();
  const encodedRepairEnv = encodedRepairMod.codexSubprocessEnv();
  const reviewChild = inspectChild(reviewEnv);
  const repairChild = inspectChild(repairEnv);
  const gitStatus = run("git", ["status", "--porcelain"], reviewEnv);
  const cliOverride = run(
    "git",
    ["-c", "user.name=legitimate-cli-override", "config", "--get", "user.name"],
    reviewEnv,
  );
  const report = {
    sourceHead: run("git", ["rev-parse", "HEAD"], original).stdout,
    base: "a09e6cefb31adcd12bba10e1658cae5fced08c80",
    node: process.version,
    claim:
      "Synthetic process-local Git config overrides are absent from both constructed model environments.",
    review: summarizeBuilder(reviewEnv, reviewChild),
    repair: {
      ...summarizeBuilder(repairEnv, repairChild),
      authorName: repairEnv.GIT_AUTHOR_NAME ?? null,
      authorEmailMatchesConfigured: repairEnv.GIT_AUTHOR_EMAIL === "bot@example.invalid",
      committerName: repairEnv.GIT_COMMITTER_NAME ?? null,
      committerEmailMatchesConfigured: repairEnv.GIT_COMMITTER_EMAIL === "bot@example.invalid",
    },
    pathCases: {
      normal: {
        containsSpace: fileURLToPath(root).includes(" "),
        containsPercent: fileURLToPath(root).includes("%"),
        oldCwdExists: existsSync(root.pathname),
        candidateCwdExists: existsSync(fileURLToPath(root)),
        oldImportSucceeded: !oldNormalImportFailed,
        candidateImportSucceeded: true,
      },
      tempEncoded: {
        containsSpace: fileURLToPath(encodedRoot).includes(" "),
        containsPercent: fileURLToPath(encodedRoot).includes("%"),
        oldCwdExists: existsSync(encodedRoot.pathname),
        candidateCwdExists: existsSync(fileURLToPath(encodedRoot)),
        oldImportCode: oldEncodedImportCode,
        candidateImportSucceeded: true,
        compiledHelpersExercised: true,
        encodedReviewRetainedGitKeys: gitKeys.filter((key) => encodedReviewEnv[key] !== undefined),
        encodedRepairRetainedGitKeys: gitKeys.filter((key) => encodedRepairEnv[key] !== undefined),
      },
    },
    repositoryGitStatusExit: gitStatus.status,
    explicitCliOverrideWorks: cliOverride.stdout === "legitimate-cli-override",
    limits: [
      "Synthetic sentinels only; no credential stores, .env files, auth logs, private keys, or real tokens were read.",
      "The children are Node stand-ins using the same environment handoff; no Codex/OpenClaw model was started.",
      "This does not claim comprehensive Git authentication isolation or production secret exposure.",
      "Only the numbered/parameter Git config override mechanism is filtered; isolation keys such as GIT_CONFIG_GLOBAL remain.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
  process.env = original;
}
