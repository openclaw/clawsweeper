import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createLabelMutationOperations } from "../dist/clawsweeper-label-mutations.js";
import { normalizeLabelName } from "../dist/clawsweeper-item-policy.js";

type ObservedMutation = {
  identity: string;
  args: string[];
  onMutation?: (() => void) | undefined;
};

function createOperations(options?: {
  catalog?: unknown[];
  mutate?: (mutation: ObservedMutation) => void;
}) {
  const reads: string[][] = [];
  const mutations: ObservedMutation[] = [];
  const operations = createLabelMutationOperations({
    ghJson: <T>(args: string[]): T => {
      reads.push(args);
      return (options?.catalog ?? []) as T;
    },
    ghObservedMutationCommand: (mutation: ObservedMutation): void => {
      mutations.push(mutation);
      options?.mutate?.(mutation);
      mutation.onMutation?.();
    },
    normalizeLabelName,
    prStatusLabelForKind: () => ({
      name: "status:ready",
      color: "1F883D",
      description: "Ready for maintainer review.",
    }),
  } as never);
  return { mutations, operations, reads };
}

test("an exact-publication label batch emits one combined deterministic issue edit", () => {
  const { mutations, operations, reads } = createOperations();
  let mutationCount = 0;

  operations.beginIssueLabelMutationBatch(321);
  operations.addIssueLabel(321, "P2", () => {
    mutationCount += 1;
  });
  operations.addIssueLabel(321, "impact:message-loss");
  operations.addIssueLabel(321, "maturity:stable");
  operations.removeIssueLabel(321, "P1");
  operations.removeIssueLabel(321, "impact:data-loss");
  operations.removeIssueLabel(321, "status:stale");

  assert.equal(operations.flushIssueLabelMutationBatch(321).itemMutationPublished, true);
  assert.equal(mutationCount, 1);
  assert.deepEqual(reads, [
    ["label", "list", "--limit", "1000", "--json", "name,color,description"],
  ]);
  assert.deepEqual(
    mutations.map(({ args }) => args),
    [
      [
        "issue",
        "edit",
        "321",
        "--add-label",
        "P2,impact:message-loss,maturity:stable",
        "--remove-label",
        "P1,impact:data-loss,status:stale",
      ],
    ],
  );
});

test("label definition discovery is cached across item batches", () => {
  const { mutations, operations, reads } = createOperations({
    catalog: [
      {
        name: "impact:message-loss",
        color: "D93F0B",
        description:
          "This issue is about lost, duplicated, misrouted, or suppressed channel messages.",
      },
    ],
  });

  operations.beginIssueLabelMutationBatch(321);
  operations.ensureImpactLabel("impact:message-loss");
  operations.addIssueLabel(321, "impact:message-loss");
  operations.ensurePriorityLabel({
    name: "P2",
    color: "FBCA04",
    description: "Important but bounded work with a practical workaround or moderate scope.",
  });
  operations.addIssueLabel(321, "P2");
  operations.flushIssueLabelMutationBatch(321);

  operations.beginIssueLabelMutationBatch(322);
  operations.ensurePriorityLabel({
    name: "P2",
    color: "FBCA04",
    description: "Important but bounded work with a practical workaround or moderate scope.",
  });
  operations.addIssueLabel(322, "P2");
  operations.flushIssueLabelMutationBatch(322);

  assert.equal(reads.length, 1);
  assert.deepEqual(
    mutations.map(({ args }) => args),
    [
      [
        "label",
        "create",
        "P2",
        "--color",
        "FBCA04",
        "--description",
        "Important but bounded work with a practical workaround or moderate scope.",
      ],
      ["issue", "edit", "321", "--add-label", "P2,impact:message-loss"],
      ["issue", "edit", "322", "--add-label", "P2"],
    ],
  );
});

test("managed label definitions are upserted only when the catalog differs", () => {
  const matching = createOperations({
    catalog: [
      {
        name: "maturity:stable",
        color: "1F883D",
        description: "Broken existing behavior primarily owned by an M4/M5 scorecard surface.",
      },
    ],
  });
  matching.operations.beginIssueLabelMutationBatch(321);
  matching.operations.ensureMaturityLabel("maturity:stable");
  matching.operations.addIssueLabel(321, "maturity:stable");
  matching.operations.flushIssueLabelMutationBatch(321);
  assert.deepEqual(
    matching.mutations.map(({ args }) => args),
    [["issue", "edit", "321", "--add-label", "maturity:stable"]],
  );

  const stale = createOperations({
    catalog: [{ name: "maturity:stable", color: "000000", description: "Old definition" }],
  });
  stale.operations.beginIssueLabelMutationBatch(322);
  stale.operations.ensureMaturityLabel("maturity:stable");
  stale.operations.addIssueLabel(322, "maturity:stable");
  stale.operations.flushIssueLabelMutationBatch(322);
  assert.deepEqual(
    stale.mutations.map(({ args }) => args),
    [
      [
        "label",
        "create",
        "maturity:stable",
        "--force",
        "--color",
        "1F883D",
        "--description",
        "Broken existing behavior primarily owned by an M4/M5 scorecard surface.",
      ],
      ["issue", "edit", "322", "--add-label", "maturity:stable"],
    ],
  );
});

test("forced definitions are repaired even when no item-label addition survives", () => {
  const { mutations, operations } = createOperations({
    catalog: [{ name: "maturity:stable", color: "000000", description: "Old definition" }],
  });

  operations.beginIssueLabelMutationBatch(321);
  operations.ensureMaturityLabel("maturity:stable");

  const result = operations.flushIssueLabelMutationBatch(321);
  assert.equal(result.repositoryDefinitionMutated, true);
  assert.equal(result.itemMutationPublished, false);
  assert.deepEqual(
    mutations.map(({ args }) => args),
    [
      [
        "label",
        "create",
        "maturity:stable",
        "--force",
        "--color",
        "1F883D",
        "--description",
        "Broken existing behavior primarily owned by an M4/M5 scorecard surface.",
      ],
    ],
  );
});

test("empty batches do nothing and ordinary apply retains immediate label commands", () => {
  const { mutations, operations, reads } = createOperations();

  operations.beginIssueLabelMutationBatch(321);
  assert.equal(operations.flushIssueLabelMutationBatch(321).itemMutationPublished, false);

  operations.addIssueLabel(322, "P2");
  operations.removeIssueLabel(322, "P1");

  assert.equal(reads.length, 0);
  assert.deepEqual(
    mutations.map(({ args }) => args),
    [
      ["issue", "edit", "322", "--add-label", "P2"],
      ["issue", "edit", "322", "--remove-label", "P1"],
    ],
  );
});

test("the last queued operation wins for each normalized label", () => {
  const { mutations, operations } = createOperations();

  operations.beginIssueLabelMutationBatch(321);
  operations.addIssueLabel(321, "P2");
  operations.removeIssueLabel(321, "p2");
  assert.equal(operations.flushIssueLabelMutationBatch(321).itemMutationPublished, true);

  operations.beginIssueLabelMutationBatch(322);
  operations.removeIssueLabel(322, "P2");
  operations.addIssueLabel(322, "p2");
  assert.equal(operations.flushIssueLabelMutationBatch(322).itemMutationPublished, true);

  assert.deepEqual(
    mutations.map(({ args }) => args),
    [
      ["issue", "edit", "321", "--remove-label", "p2"],
      ["issue", "edit", "322", "--add-label", "p2"],
    ],
  );
});

test("discarded batches cannot mutate after publication is skipped", () => {
  const { mutations, operations, reads } = createOperations();

  operations.beginIssueLabelMutationBatch(321);
  operations.ensurePriorityLabel({
    name: "P2",
    color: "FBCA04",
    description: "Important but bounded work with a practical workaround or moderate scope.",
  });
  operations.addIssueLabel(321, "P2");
  operations.removeIssueLabel(321, "P1");
  operations.discardIssueLabelMutationBatch(321);

  assert.equal(operations.flushIssueLabelMutationBatch(321).itemMutationPublished, false);
  assert.deepEqual(reads, []);
  assert.deepEqual(mutations, []);
});

test("optional batch failures retain successful final operations and report skipped additions", () => {
  const capacityFailure = new Error("labels can have a maximum of 100 labels");
  const events: string[] = [];
  const { mutations, operations } = createOperations({
    mutate: ({ args }) => {
      events.push(args.join(" "));
      const additions = args.includes("--add-label")
        ? args[args.indexOf("--add-label") + 1]
        : undefined;
      if ((args.includes("--remove-label") && additions) || additions === "P2") {
        throw capacityFailure;
      }
    },
  });

  operations.beginIssueLabelMutationBatch(321);
  operations.tryAddOptionalLabel({ number: 321, label: "P2", currentLabels: [] });
  operations.tryAddOptionalLabel({
    number: 321,
    label: "impact:message-loss",
    currentLabels: ["P2"],
  });
  operations.removeIssueLabel(321, "P1");
  const result = operations.flushIssueLabelMutationBatch(
    321,
    () => events.push("freshness"),
    (confirmed) => events.push(confirmed ? "receipt" : "possible mutation"),
  );

  assert.equal(result.itemMutationPublished, true);
  assert.deepEqual(result.skippedAdditions, ["P2"]);
  assert.deepEqual(
    mutations.map(({ args }) => args),
    [
      ["issue", "edit", "321", "--add-label", "P2,impact:message-loss", "--remove-label", "P1"],
      ["issue", "edit", "321", "--remove-label", "P1"],
      ["issue", "edit", "321", "--add-label", "P2"],
      ["issue", "edit", "321", "--add-label", "impact:message-loss"],
    ],
  );
  assert.deepEqual(events, [
    "freshness",
    "issue edit 321 --add-label P2,impact:message-loss --remove-label P1",
    "possible mutation",
    "freshness",
    "issue edit 321 --remove-label P1",
    "receipt",
    "freshness",
    // The optional P2 retry is the one the fixture rejects, so it draws no receipt;
    // code unit order simply makes it the first per-label retry instead of the second.
    "issue edit 321 --add-label P2",
    "freshness",
    "issue edit 321 --add-label impact:message-loss",
    "receipt",
  ]);
});

test("a rejected optional-only batch does not publish a label-sync receipt", () => {
  const capacityFailure = new Error("labels can have a maximum of 100 labels");
  let labelsSyncedAt: string | undefined;
  const receiptCertainty: boolean[] = [];
  const { operations } = createOperations({
    mutate: ({ args }) => {
      if (args.includes("--add-label")) throw capacityFailure;
    },
  });

  operations.beginIssueLabelMutationBatch(321);
  operations.tryAddOptionalLabel({ number: 321, label: "P2", currentLabels: [] });
  const result = operations.flushIssueLabelMutationBatch(321, undefined, (confirmed) => {
    receiptCertainty.push(confirmed);
    if (confirmed) labelsSyncedAt = new Date().toISOString();
  });

  assert.equal(result.itemMutationPublished, false);
  assert.deepEqual(result.skippedAdditions, ["P2"]);
  assert.deepEqual(receiptCertainty, [false]);
  assert.equal(labelsSyncedAt, undefined);
});

test("capacity fallback publishes required additions before optional additions", () => {
  const capacityFailure = new Error("labels can have a maximum of 100 labels");
  let individualAdditionPublished = false;
  const { mutations, operations } = createOperations({
    mutate: ({ args }) => {
      const additions = args.includes("--add-label")
        ? args[args.indexOf("--add-label") + 1]
        : undefined;
      if (additions?.includes(",")) throw capacityFailure;
      if (!additions) return;
      if (individualAdditionPublished) throw capacityFailure;
      individualAdditionPublished = true;
    },
  });

  operations.beginIssueLabelMutationBatch(321);
  operations.tryAddOptionalLabel({
    number: 321,
    label: "proof: sufficient",
    currentLabels: [],
  });
  operations.addIssueLabel(321, "status: ready for maintainer look");
  const result = operations.flushIssueLabelMutationBatch(321);

  assert.equal(result.itemMutationPublished, true);
  assert.deepEqual(result.skippedAdditions, ["proof: sufficient"]);
  assert.deepEqual(
    mutations.map(({ args }) => args),
    [
      [
        "issue",
        "edit",
        "321",
        "--add-label",
        "proof: sufficient,status: ready for maintainer look",
      ],
      ["issue", "edit", "321", "--add-label", "status: ready for maintainer look"],
      ["issue", "edit", "321", "--add-label", "proof: sufficient"],
    ],
  );
});

test("optional definition creation failures omit only the affected addition", () => {
  const definitionFailure = new Error("resource not accessible by integration");
  const { mutations, operations } = createOperations({
    mutate: ({ args }) => {
      if (args[0] === "label" && args[2] === "proof: sufficient") throw definitionFailure;
    },
  });

  operations.beginIssueLabelMutationBatch(321);
  assert.equal(operations.ensureRealBehaviorProofSufficientLabel(), true);
  operations.tryAddOptionalLabel({
    number: 321,
    label: "proof: sufficient",
    currentLabels: [],
  });
  operations.addIssueLabel(321, "impact:message-loss");
  const result = operations.flushIssueLabelMutationBatch(321);

  assert.equal(result.itemMutationPublished, true);
  assert.deepEqual(result.skippedAdditions, ["proof: sufficient"]);
  assert.deepEqual(
    mutations.map(({ args }) => args),
    [
      [
        "label",
        "create",
        "proof: sufficient",
        "--color",
        "1A7F37",
        "--description",
        "Contributor real behavior proof is sufficient.",
      ],
      ["issue", "edit", "321", "--add-label", "impact:message-loss"],
    ],
  );
});

test("optional definition failures do not swallow freshness guard rejections", () => {
  const guardFailure = new Error("the item changed after review");
  guardFailure.name = "ApplyMutationReviewGuardError";
  const { mutations, operations } = createOperations({
    mutate: ({ args }) => {
      if (args[0] === "label" && args[2] === "proof: sufficient") throw guardFailure;
    },
  });

  operations.beginIssueLabelMutationBatch(321);
  operations.ensureRealBehaviorProofSufficientLabel();
  operations.tryAddOptionalLabel({
    number: 321,
    label: "proof: sufficient",
    currentLabels: [],
  });

  assert.throws(() => operations.flushIssueLabelMutationBatch(321), guardFailure);
  assert.equal(mutations.length, 1);
});

test("a failed combined mutation has no same-attempt per-label fallback", () => {
  const failure = new Error("partial GitHub label mutation failure");
  const { mutations, operations } = createOperations({
    mutate: (mutation) => {
      if (mutation.args.includes("--add-label") && mutation.args.includes("--remove-label")) {
        throw failure;
      }
    },
  });

  operations.beginIssueLabelMutationBatch(321);
  operations.addIssueLabel(321, "P2");
  operations.removeIssueLabel(321, "P1");
  assert.throws(() => operations.flushIssueLabelMutationBatch(321), failure);
  assert.deepEqual(
    mutations.map(({ args }) => args),
    [["issue", "edit", "321", "--add-label", "P2", "--remove-label", "P1"]],
  );

  operations.beginIssueLabelMutationBatch(321);
  operations.removeIssueLabel(321, "P1");
  operations.flushIssueLabelMutationBatch(321);
  assert.deepEqual(mutations.at(-1)?.args, ["issue", "edit", "321", "--remove-label", "P1"]);
});

test("the issue label sync identity does not depend on insertion order or runner locale", () => {
  const additions = ["P2", "impact:message-loss", "maturity:stable", "proof: sufficient"];
  const removals = ["P1", "impact:data-loss", "status:stale"];

  const identityFor = (addOrder: string[], removeOrder: string[]): string => {
    const { mutations, operations } = createOperations();
    operations.beginIssueLabelMutationBatch(321);
    for (const label of addOrder) operations.addIssueLabel(321, label);
    for (const label of removeOrder) operations.removeIssueLabel(321, label);
    operations.flushIssueLabelMutationBatch(321);
    const identity = mutations.find((mutation) =>
      mutation.identity.startsWith("issue_labels_sync:"),
    )?.identity;
    assert.ok(identity, "the batch must publish an issue_labels_sync mutation");
    return identity;
  };

  const baseline = identityFor(additions, removals);
  assert.equal(identityFor([...additions].reverse(), [...removals].reverse()), baseline);
  assert.equal(identityFor([...additions].sort(), [...removals].sort()), baseline);

  // Labels a collator calls equal but that are distinct strings must still get a total
  // order, otherwise `Array.prototype.sort` may leave them in input order.
  const tied = ["status: \u{1F440}‍ ready", "status: \u{1F440} ready"];
  assert.notEqual(tied[0], tied[1]);
  assert.equal(tied[0]?.localeCompare(tied[1] ?? "") ?? 1, 0, "precondition: collator ties these");
  const tiedIdentity = identityFor(tied, []);
  assert.equal(identityFor([...tied].reverse(), []), tiedIdentity);

  const child = spawnSync(
    process.execPath,
    ["docs/proof/label-sync-identity-determinism/run-proof.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).candidate.verified, true);
});
