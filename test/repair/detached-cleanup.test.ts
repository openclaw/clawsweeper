import assert from "node:assert/strict";
import test from "node:test";

import { finishDetachedCleanupProcess } from "../../dist/repair/detached-cleanup.js";

test("successful ownership release terminates the detached recovery helper", () => {
  const calls: string[] = [];
  finishDetachedCleanupProcess(
    {
      killed: false,
      kill() {
        calls.push("kill");
        return true;
      },
      stdin: {
        destroy() {
          calls.push("destroy");
        },
        end() {
          calls.push("end");
        },
      },
    },
    true,
  );
  assert.deepEqual(calls, ["destroy", "kill"]);
});

test("ambiguous ownership release preserves the detached recovery attempt", () => {
  const calls: string[] = [];
  finishDetachedCleanupProcess(
    {
      killed: false,
      kill() {
        calls.push("kill");
        return true;
      },
      stdin: {
        destroy() {
          calls.push("destroy");
        },
        end() {
          calls.push("end");
        },
      },
    },
    false,
  );
  assert.deepEqual(calls, ["end"]);
});
