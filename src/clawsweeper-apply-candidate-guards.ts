import type { CreateApplyDecisionWorkflowDependencies } from "./clawsweeper-apply-dependencies.js";
import type {
  AuthorPrBudgetApplyGate,
  CloseReason,
  Item,
  ItemContext,
  PrCloseCoverageProofGateBlock,
  PrCloseCoverageProofGateResult,
} from "./clawsweeper-types.js";
import type { PrCloseCoverageProofRuntime } from "./pr-close-coverage-proof.js";

type ApplyCandidateGuardDependencies = Pick<
  CreateApplyDecisionWorkflowDependencies,
  | "authorPrBudgetApplyGateSafe"
  | "authorPrBudgetMaxClosesPerRun"
  | "coverageProofRetryExhaustedRuntimeBudget"
  | "frontMatterValue"
  | "obsoleteFixPrApplyBlockReasonSafe"
  | "prCloseCoverageProofGateResult"
  | "staleVersionBugApplyBlockReasonSafe"
  | "timeoutWithinRuntimeBudget"
>;

interface ApplyCandidateGuardOptions {
  authorPrBudgetClosesThisRun: ReadonlyMap<string, number>;
  authorPrClosesThisRun: ReadonlyMap<string, number>;
  currentDecisionState: () => { closeReason: CloseReason | undefined; markdown: string };
  currentItemContext: () => ItemContext;
  item: Item;
  maxRuntimeMs: number;
  number: number;
  prCloseCoverageProofRuntime: PrCloseCoverageProofRuntime;
  requirePrecomputedPrCloseCoverageProof: boolean;
  startedAtMs: number;
}

export function createApplyCandidateGuards(
  dependencies: ApplyCandidateGuardDependencies,
  options: ApplyCandidateGuardOptions,
) {
  const {
    authorPrBudgetApplyGateSafe,
    authorPrBudgetMaxClosesPerRun,
    coverageProofRetryExhaustedRuntimeBudget,
    frontMatterValue,
    obsoleteFixPrApplyBlockReasonSafe,
    prCloseCoverageProofGateResult,
    staleVersionBugApplyBlockReasonSafe,
    timeoutWithinRuntimeBudget,
  } = dependencies;
  const {
    authorPrBudgetClosesThisRun,
    authorPrClosesThisRun,
    currentDecisionState,
    currentItemContext,
    item,
    maxRuntimeMs,
    number,
    prCloseCoverageProofRuntime,
    requirePrecomputedPrCloseCoverageProof,
    startedAtMs,
  } = options;
  let cachedAuthorPrBudgetApplyGate: AuthorPrBudgetApplyGate | undefined;
  let cachedStaleVersionBugBlockReason: string | null | undefined;
  let cachedObsoleteFixPrBlockReason: string | null | undefined;
  const coverageProofState: {
    cachedPrCloseCoverageProofGateResult: PrCloseCoverageProofGateResult | undefined;
    prCloseCoverageProofGateChecked: boolean;
    prCloseCoverageProofStartedAtMs: number | null;
  } = {
    cachedPrCloseCoverageProofGateResult: undefined,
    prCloseCoverageProofGateChecked: false,
    prCloseCoverageProofStartedAtMs: null,
  };

  const currentStaleVersionBugBlockReason = (): string | null => {
    if (cachedStaleVersionBugBlockReason === undefined) {
      cachedStaleVersionBugBlockReason = staleVersionBugApplyBlockReasonSafe(number, item);
    }
    return cachedStaleVersionBugBlockReason;
  };
  const currentObsoleteFixPrBlockReason = (): string | null => {
    if (cachedObsoleteFixPrBlockReason === undefined) {
      cachedObsoleteFixPrBlockReason = obsoleteFixPrApplyBlockReasonSafe(number, item);
    }
    return cachedObsoleteFixPrBlockReason;
  };
  const currentAuthorPrBudgetApplyGate = (): AuthorPrBudgetApplyGate => {
    const authorKey = item.author.trim().toLowerCase();
    const closedForAuthor = authorPrBudgetClosesThisRun.get(authorKey) ?? 0;
    const maxCloses = authorPrBudgetMaxClosesPerRun();
    if (closedForAuthor >= maxCloses) {
      return {
        allowed: false,
        reason: `author PR-budget per-run close cap of ${maxCloses} reached for @${item.author.replace(/^@/, "")}`,
      };
    }
    cachedAuthorPrBudgetApplyGate ??= authorPrBudgetApplyGateSafe(
      number,
      item,
      currentDecisionState().markdown,
    );
    if (!cachedAuthorPrBudgetApplyGate.allowed) return cachedAuthorPrBudgetApplyGate;
    // Search can lag same-run closes of any kind, so project every prior close.
    const projectedOpenPrCount =
      cachedAuthorPrBudgetApplyGate.state.openPrCount - (authorPrClosesThisRun.get(authorKey) ?? 0);
    if (projectedOpenPrCount <= cachedAuthorPrBudgetApplyGate.state.budget) {
      return {
        allowed: false,
        reason: `author is projected at ${projectedOpenPrCount} open PRs after this run's closes; author PR budget is ${cachedAuthorPrBudgetApplyGate.state.budget}`,
      };
    }
    return cachedAuthorPrBudgetApplyGate;
  };
  const runtimeBudgetProofBlock = (
    phase = "before",
  ): Extract<NonNullable<PrCloseCoverageProofGateResult>, { status: "blocked" }> => ({
    status: "blocked",
    block: {
      actionTaken: "skipped_runtime_budget",
      reason: `max runtime ${maxRuntimeMs}ms reached ${phase} PR close coverage proof`,
    },
  });
  const currentPrCloseCoverageProofGateBlock = (): PrCloseCoverageProofGateBlock | null => {
    if (coverageProofState.cachedPrCloseCoverageProofGateResult !== undefined) {
      return coverageProofState.cachedPrCloseCoverageProofGateResult?.status === "blocked"
        ? coverageProofState.cachedPrCloseCoverageProofGateResult.block
        : null;
    }
    coverageProofState.prCloseCoverageProofGateChecked = true;
    const { closeReason, markdown } = currentDecisionState();
    if (
      frontMatterValue(markdown, "decision") !== "close" ||
      closeReason !== "duplicate_or_superseded"
    ) {
      coverageProofState.cachedPrCloseCoverageProofGateResult = null;
      return null;
    }
    let proofTimeoutMs = timeoutWithinRuntimeBudget(
      startedAtMs,
      maxRuntimeMs,
      prCloseCoverageProofRuntime.timeoutMs,
      Date.now(),
    );
    if (proofTimeoutMs === null) {
      const blocked = runtimeBudgetProofBlock();
      coverageProofState.cachedPrCloseCoverageProofGateResult = blocked;
      return blocked.block;
    }
    const context = currentItemContext();
    proofTimeoutMs = timeoutWithinRuntimeBudget(
      startedAtMs,
      maxRuntimeMs,
      prCloseCoverageProofRuntime.timeoutMs,
      Date.now(),
    );
    if (proofTimeoutMs === null) {
      const blocked = runtimeBudgetProofBlock();
      coverageProofState.cachedPrCloseCoverageProofGateResult = blocked;
      return blocked.block;
    }
    const proof = prCloseCoverageProofGateResult({
      markdown,
      item,
      context,
      runtime: { ...prCloseCoverageProofRuntime, timeoutMs: proofTimeoutMs },
      requirePrecomputedProof: requirePrecomputedPrCloseCoverageProof,
      runtimeBudget: { startedAtMs, maxRuntimeMs },
    });
    coverageProofState.cachedPrCloseCoverageProofGateResult =
      proof?.status === "blocked" &&
      coverageProofRetryExhaustedRuntimeBudget(
        startedAtMs,
        maxRuntimeMs,
        proof.block.actionTaken,
        Date.now(),
      )
        ? runtimeBudgetProofBlock("during")
        : proof;
    if (coverageProofState.cachedPrCloseCoverageProofGateResult?.status === "allowed") {
      coverageProofState.prCloseCoverageProofStartedAtMs =
        coverageProofState.cachedPrCloseCoverageProofGateResult.covering.provedAtMs;
    }
    return coverageProofState.cachedPrCloseCoverageProofGateResult?.status === "blocked"
      ? coverageProofState.cachedPrCloseCoverageProofGateResult.block
      : null;
  };

  return {
    coverageProofState,
    currentAuthorPrBudgetApplyGate,
    currentObsoleteFixPrBlockReason,
    currentPrCloseCoverageProofGateBlock,
    currentStaleVersionBugBlockReason,
    resetCoverageProof: () => {
      coverageProofState.cachedPrCloseCoverageProofGateResult = undefined;
    },
  };
}
