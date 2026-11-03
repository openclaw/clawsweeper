import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const source = readFileSync("dashboard-site/src/components/Layout.astro", "utf8");
const script = source.slice(
  source.indexOf("      const tip ="),
  source.indexOf("      const dialog ="),
);

function harness() {
  const listeners: Record<string, (event: any) => void> = {};
  const tip = {
    textContent: "",
    style: {} as Record<string, string>,
    on: false,
    classList: {
      add: () => {
        tip.on = true;
      },
      remove: () => {
        tip.on = false;
      },
    },
    getBoundingClientRect: () => ({ width: 280, height: 70 }),
  };
  const listen = (name: string, callback: (event: any) => void) => {
    listeners[name] = callback;
  };
  runInNewContext(script, {
    document: { getElementById: () => tip, addEventListener: listen },
    window: { innerWidth: 320, addEventListener: listen },
  });
  const info = {
    dataset: { tip: "Status explanation" },
    closest: () => info,
    getBoundingClientRect: () => ({ left: 260, top: 200 }),
  };
  const outside = { closest: () => null };
  const ordinary = {
    ...info,
    closest: (selector: string) => (selector === "[data-tip]" ? ordinary : null),
  };
  const fire = (name: string, target: unknown = info, extra = {}) =>
    listeners[name]({ target, ...extra });
  return { tip, info, outside, ordinary, fire };
}

test("legend info tips show on focus and dismiss on blur, Escape, scroll and resize", () => {
  const h = harness();
  for (const dismiss of ["focusout", "keydown", "scroll", "resize"]) {
    h.fire("focusin");
    assert.equal(h.tip.on, true);
    assert.equal(h.tip.textContent, "Status explanation");
    assert.equal(h.tip.style.left, "8px");
    h.fire(dismiss, h.info, { key: "Escape" });
    assert.equal(h.tip.on, false, dismiss);
  }
});

test("touch tap pins a tip, a second tap or outside input dismisses it", () => {
  const h = harness();
  h.fire("click");
  assert.equal(h.tip.on, true);
  h.fire("pointerover", h.outside);
  assert.equal(h.tip.on, true);
  h.fire("click");
  assert.equal(h.tip.on, false);
  h.fire("click");
  h.fire("pointerdown", h.outside);
  assert.equal(h.tip.on, false);
  h.fire("click");
  h.fire("focusout");
  assert.equal(h.tip.on, false);
});

test("ordinary pointer tips retain hover and pointer-follow behavior", () => {
  const h = harness();
  h.fire("pointerover", h.ordinary, { clientX: 20, clientY: 100, pointerType: "touch" });
  h.fire("pointerdown", h.ordinary, { clientX: 20, clientY: 100, pointerType: "touch" });
  assert.equal(h.tip.on, true);
  h.fire("click");
  h.fire("pointerdown", h.ordinary, { clientX: 20, clientY: 100, pointerType: "touch" });
  assert.equal(h.tip.on, true);
  h.fire("pointerover", h.outside);
  h.fire("pointerover", h.info, { clientX: 20, clientY: 100, pointerType: "mouse" });
  assert.equal(h.tip.on, true);
  h.fire("pointermove", h.info, { clientX: 10, clientY: 150, pointerType: "mouse" });
  assert.equal(h.tip.style.top, "68px");
  h.fire("pointerover", h.outside);
  assert.equal(h.tip.on, false);
});

test("coverage explanations preserve the five ordered counts and colors", () => {
  // Read the actual Coverage presentation owner, not its removed legacy model.
  const page = readFileSync("dashboard-site/src/pages/coverage.astro", "utf8");
  const start = page.indexOf("const segments =");
  assert.ok(start >= 0, "locate the actual segment presentation owner");
  const definition = page.slice(start, page.indexOf("];", start) + 2);
  const cover = {
    reviewed_recent: 10,
    stale: 20,
    expired: 30,
    failed: 5,
    unreviewed_records: 15,
    untracked_open: 20,
  };
  const segments = JSON.parse(
    JSON.stringify(runInNewContext(stripTypeScriptTypes(definition) + "; segments;", { cover })),
  );
  assert.deepEqual(
    segments.map((s: any) => [s.label, s.value, s.color]),
    [
      ["Fresh", 10, "var(--ok)"],
      ["Marked stale / changed", 20, "var(--warn)"],
      ["Expired", 30, "var(--accent)"],
      ["Failed", 5, "var(--bad)"],
      ["Missing usable evidence", 35, "var(--fg-faint)"],
    ],
  );
  assert.match(segments[0].tip, /Matching live identity and PR head/);
  assert.match(segments[0].tip, /valid review date within the window/);
  assert.match(segments[0].tip, /no later observed reopen/);
  assert.doesNotMatch(segments[0].tip, /no later observed activity/);
  assert.match(segments[1].tip, /Not the same as age expiry/);
  assert.match(segments[2].tip, /outside the freshness window/);
  assert.match(segments[3].tip, /attempt failed/);
  assert.match(segments[4].tip, /Earlier attempts may exist/);
});
