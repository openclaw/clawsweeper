import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const referenceRoots = [".github", "docs"];
const appTokenRef =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0";

function referenceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return referenceFiles(path);
    return /\.(?:md|ya?ml)$/.test(entry.name) ? [path] : [];
  });
}

test("GitHub App token creation uses the approved immutable action pin everywhere", () => {
  const references = referenceRoots.flatMap(referenceFiles).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("actions/create-github-app-token@"))
      .map((line) => ({ path, reference: line.trim().replace(/^uses:\s*/, "") })),
  );

  assert.ok(references.length > 0, "expected GitHub App token action references");
  assert.deepEqual(
    [...new Set(references.map(({ reference }) => reference))],
    [appTokenRef],
    references.map(({ path, reference }) => `${path}: ${reference}`).join("\n"),
  );
});

test("GitHub App token owner inputs do not consume the multi-owner repair policy", () => {
  const invalidOwnerInputs = referenceFiles(".github/workflows").flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => /^\s*owner:.*CLAWSWEEPER_ALLOWED_OWNER/.test(line))
      .map((line) => `${path}: ${line.trim()}`),
  );

  assert.deepEqual(invalidOwnerInputs, []);
});

test("cache actions use one runtime generation everywhere", () => {
  const references = referenceRoots.flatMap(referenceFiles).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => line.match(/actions\/cache(?:\/(?:restore|save))?@v\d+/g) ?? []),
  );

  assert.deepEqual(
    [...new Set(references)].sort(),
    ["actions/cache@v6", "actions/cache/restore@v6", "actions/cache/save@v6"].sort(),
  );
});

test("App mint actions name repositories and stay within the minimal permission ceiling", async () => {
  const { default: YAML } = await import("yaml");
  const maximum = {
    metadata: "read",
    actions: "write",
    checks: "read",
    contents: "write",
    issues: "write",
    "pull-requests": "write",
    statuses: "read",
  };
  const inventoryExceptions = new Set([
    "openclaw-inventory-token",
    "steipete-inventory-token",
    "openclaw-coverage-token",
    "steipete-coverage-token",
  ]);
  for (const path of referenceFiles(".github").filter((path) => /\.ya?ml$/.test(path))) {
    const workflow = YAML.parse(readFileSync(path, "utf8"));
    for (const job of Object.values(workflow.jobs || { composite: workflow.runs })) {
      for (const step of (job as { steps?: any[] } | undefined)?.steps || []) {
        if (!step.uses?.startsWith("actions/create-github-app-token@")) continue;
        const inputs = step.with;
        const permissions = Object.entries(inputs).filter(([key]) => key.startsWith("permission-"));
        assert.ok(permissions.length, path);
        if (path === ".github/workflows/target-fanout.yml" && inventoryExceptions.has(step.id)) {
          assert.deepEqual(permissions, [["permission-metadata", "read"]]);
          inventoryExceptions.delete(step.id);
        } else assert.ok(inputs.repositories, `${path}:${step.id} must name its repositories`);
        for (const [key, value] of permissions) {
          const permission = key.slice("permission-".length);
          assert.ok(Object.hasOwn(maximum, permission), `${path}: unexpected ${key}`);
          if (path.endsWith("create-state-token/action.yml") && permission !== "metadata") {
            assert.equal(value, `\${{ inputs.${permission}-permission }}`);
            assert.ok(
              ["read", "write"].includes(workflow.inputs[`${permission}-permission`].default),
            );
          } else
            assert.ok(
              value === "read" || value === maximum[permission],
              `${path}: excessive ${key}`,
            );
        }
      }
    }
  }
  assert.equal(inventoryExceptions.size, 0);
});

test("target publication tokens cannot write contents and state jobs omit unused grants", async () => {
  const { default: YAML } = await import("yaml");
  const stateAction = YAML.parse(
    readFileSync(".github/actions/create-state-token/action.yml", "utf8"),
  );
  const stateMint = stateAction.runs.steps[0].with;
  assert.equal(
    stateMint["permission-metadata"],
    "read",
    "empty optional grants must still downscope the token",
  );
  const stateRequests = [];
  for (const path of referenceFiles(".github/workflows").filter((path) => /\.ya?ml$/.test(path))) {
    const workflow = YAML.parse(readFileSync(path, "utf8"));
    for (const job of Object.values(workflow.jobs || {})) {
      for (const step of (job as { steps?: any[] }).steps || []) {
        if (step.uses?.endsWith("/.github/actions/create-state-token")) {
          const permission = (name) => step.with[name] ?? stateAction.inputs[name].default;
          stateRequests.push(path);
          assert.equal(
            permission("actions-permission"),
            path.endsWith("/audit.yml") ? "write" : "",
            path,
          );
          assert.equal(
            permission("contents-permission"),
            path.endsWith("/exact-review-reconcile.yml") ? "" : "write",
            path,
          );
        }
        if (!step.uses?.startsWith("actions/create-github-app-token@")) continue;
        if (
          step.id === "target-write-token" ||
          step.id === "target-token" ||
          step.id === "app_token"
        ) {
          assert.ok([undefined, "read"].includes(step.with["permission-contents"]), path);
        }
        if (path.endsWith("/repair-comment-router.yml") && step.id === "app_token") {
          assert.equal(step.with["permission-actions"], undefined);
        }
        if (path.endsWith("/repair-comment-router.yml") && step.id === "dispatch-token") {
          assert.equal(step.with["permission-metadata"], "read");
          assert.equal(step.with["permission-actions"], undefined);
          assert.equal(step.with["permission-contents"], undefined);
        }
      }
    }
  }
  assert.equal(stateRequests.length, 6);
  const targetAction = YAML.parse(
    readFileSync(".github/actions/create-target-write-token/action.yml", "utf8"),
  );
  assert.equal(targetAction.runs.steps[0].with["permission-contents"], "read");
});
