import assert from "node:assert/strict";
import test from "node:test";

import { dispatchCommand } from "../dist/clawsweeper-command-dispatch.js";
import { UserFacingCommandError } from "../dist/command.js";

test("command dispatcher runs synchronous and asynchronous registered handlers", async () => {
  const executed: string[] = [];
  const handlers = {
    sync: (value: string) => {
      executed.push(`sync:${value}`);
    },
    async: async (value: string) => {
      await Promise.resolve();
      executed.push(`async:${value}`);
    },
  };

  await dispatchCommand("sync", "first", handlers);
  await dispatchCommand("async", "second", handlers);

  assert.deepEqual(executed, ["sync:first", "async:second"]);
});

test("command dispatcher rejects unknown commands and inherited object properties", async () => {
  const handlers = { check: () => undefined };

  for (const command of ["unknown", "toString", "__proto__"]) {
    await assert.rejects(
      dispatchCommand(command, undefined, handlers),
      (error: unknown) =>
        error instanceof UserFacingCommandError && error.message === `Unknown command: ${command}`,
    );
  }
});

test("command dispatcher preserves a handler failure", async () => {
  const failure = new Error("handler failed");

  await assert.rejects(
    dispatchCommand("broken", undefined, {
      broken: () => {
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
});
