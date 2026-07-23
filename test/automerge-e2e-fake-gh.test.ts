import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fakeGhPath = fileURLToPath(new URL("./e2e/automerge/fake-gh.mjs", import.meta.url));

test("fake GitHub serializes concurrent state updates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-fake-gh-state-"));
  const statePath = path.join(root, "github-state.json");
  const processCount = 32;
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({
      tokens: { read: "read-token", write: "write-token", post: "post-token" },
      calls: [],
    })}\n`,
  );

  try {
    await Promise.all(
      Array.from({ length: processCount }, () =>
        runFakeGh(statePath, ["auth", "token"], "read-token"),
      ),
    );
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.calls.length, processCount);
    assert.ok(state.calls.every((call: { token: string }) => call.token === "read"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runFakeGh(statePath: string, args: string[], token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fakeGhPath, ...args], {
      env: {
        ...process.env,
        CLAWSWEEPER_E2E_GITHUB_STATE: statePath,
        GH_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`fake gh exited with code ${code} signal ${signal}: ${stderr}`));
    });
  });
}
