import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const wrapper = fs.readFileSync("scripts/e2e/automerge-container.mjs", "utf8");
const dockerfile = fs.readFileSync("test/e2e/automerge/Dockerfile", "utf8");
const baseDockerfile = fs.readFileSync("test/e2e/automerge/Dockerfile.base", "utf8");

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

test("automerge E2E runs on OpenClaw's supported Node 24 floor", () => {
  assert.match(
    baseDockerfile,
    /^FROM node:24\.15\.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d/m,
  );
  assert.match(wrapper, /const fixture = String\(args\.fixture \?\? "all"\)/);
  assert.match(wrapper, /"--fixture",\s*fixture/);
});
