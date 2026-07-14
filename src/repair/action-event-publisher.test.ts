import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  actionEventPublishCoordination,
  actionEventPublishPaths,
  publishActionEventPaths,
} from "./action-event-publisher.js";
import type { GitPublishOptions } from "./git-publish.js";

const EVENT_PATH =
  "ledger/v1/events/2026/07/14/openclaw-clawsweeper/github-activity/run-part-1-of-1.jsonl";

test("action event publisher admits sorted canonical paths through immutable coordination", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-action-publisher-"));
  const manifest = join(root, "paths.txt");
  mkdirSync(dirname(join(root, EVENT_PATH)), { recursive: true });
  writeFileSync(join(root, EVENT_PATH), "{}\n");
  writeFileSync(manifest, `${EVENT_PATH}\n`);
  let published: GitPublishOptions | undefined;

  const result = publishActionEventPaths({
    pathsFile: manifest,
    message: "chore: append action ledger",
    workspaceRoot: root,
    env: { CLAWSWEEPER_ACTION_LEDGER_IMMUTABLE_PUBLISH: "1" },
    publish: (options) => {
      published = options;
      return "committed";
    },
  });

  assert.deepEqual(result, {
    result: "committed",
    pathCount: 1,
    coordination: "immutable",
  });
  assert.deepEqual(published, {
    message: "chore: append action ledger",
    paths: [EVENT_PATH],
    coordination: "immutable",
    rebaseStrategy: "normal",
  });
});

test("action event publisher keeps exclusive coordination as the default", () => {
  assert.equal(actionEventPublishCoordination({}), "exclusive");
  assert.equal(
    actionEventPublishCoordination({
      CLAWSWEEPER_ACTION_LEDGER_IMMUTABLE_PUBLISH: "1",
    }),
    "immutable",
  );
  assert.equal(
    actionEventPublishCoordination({
      CLAWSWEEPER_ACTION_LEDGER_IMMUTABLE_PUBLISH: "true",
    }),
    "exclusive",
  );
});

test("action event publisher rejects unsorted and non-ledger manifests", () => {
  const binding = `ledger/v1/import-bindings/events/${"a".repeat(64)}.json`;
  assert.throws(() => actionEventPublishPaths(`${binding}\n${EVENT_PATH}\n`), /sorted and unique/);
  assert.throws(
    () => actionEventPublishPaths("ledger/v1/import-bindings/private/raw.json\n"),
    /invalid action event publish path/,
  );
});

test(
  "action event publisher rejects symlink manifests and sources",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-action-publisher-links-"));
    const realManifest = join(root, "real-paths.txt");
    const manifestLink = join(root, "paths.txt");
    const realEvent = join(root, "real-event.jsonl");
    mkdirSync(dirname(join(root, EVENT_PATH)), { recursive: true });
    writeFileSync(realManifest, `${EVENT_PATH}\n`);
    writeFileSync(realEvent, "{}\n");
    symlinkSync(realManifest, manifestLink);
    symlinkSync(realEvent, join(root, EVENT_PATH));

    assert.throws(
      () =>
        publishActionEventPaths({
          pathsFile: manifestLink,
          message: "chore: append action ledger",
          workspaceRoot: root,
          publish: () => "committed",
        }),
      /manifest is not a regular file/,
    );
    assert.throws(
      () =>
        publishActionEventPaths({
          pathsFile: realManifest,
          message: "chore: append action ledger",
          workspaceRoot: root,
          publish: () => "committed",
        }),
      /publish path is not a regular file/,
    );
  },
);

test("repair-native publisher CLI is emitted and accepts the package-manager separator", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./publish-action-event-paths.js", import.meta.url)),
      "--",
      "--paths-file",
      "missing.txt",
      "--message",
      "chore: append action ledger",
    ],
    { encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT|no such file/i);
  assert.doesNotMatch(result.stderr, /Unknown argument/);
});
