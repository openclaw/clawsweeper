import test from "node:test";
import { runReadScopeProof } from "../../scripts/e2e/exact-review-noop-read-scope.mjs";

test("compiled live admission preserves decisions and scopes its single public-read fallback", () => {
  runReadScopeProof();
});
