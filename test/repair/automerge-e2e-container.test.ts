import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const wrapper = fs.readFileSync("scripts/e2e/automerge-container.mjs", "utf8");
const dockerfile = fs.readFileSync("test/e2e/automerge/Dockerfile", "utf8");

test("automerge E2E container preserves nested production containment", () => {
  assert.doesNotMatch(wrapper, /"--user"/);
  assert.doesNotMatch(wrapper, /"(?:--privileged|--cap-add|SYS_ADMIN)"/);
  assert.match(wrapper, /"--memory",\s*"8g"/);
  assert.match(wrapper, /"--memory-swap",\s*"8g"/);
  assert.match(wrapper, /"--pids-limit",\s*"1024"/);
});

test("automerge E2E container is readable by the runtime and restores output ownership", () => {
  assert.match(dockerfile, /RUN chmod -R a\+rX \/workspace/);
  assert.match(wrapper, /"chown",\s*"-R",\s*hostOwner/);
});

test("automerge E2E builds the default base from repository-controlled source", () => {
  assert.match(dockerfile, /ARG AUTOMERGE_E2E_BASE_IMAGE=clawsweeper-automerge-e2e-base:local/);
  assert.match(
    wrapper,
    /if \(!args\.baseImage\) \{[\s\S]*"test\/e2e\/automerge\/Dockerfile\.base"[\s\S]*baseImage/,
  );
  assert.match(wrapper, /`AUTOMERGE_E2E_BASE_IMAGE=\$\{baseImage\}`/);
  assert.doesNotMatch(`${wrapper}\n${dockerfile}`, /masonxhuang\//);
});
