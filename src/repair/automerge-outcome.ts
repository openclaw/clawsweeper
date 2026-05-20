import type { JsonValue, LooseRecord } from "./json-types.js";
import { parsePullRequestUrl } from "./github-ref.js";

export function automergeOutcomeReviewedShaFromResult({
  result,
  repo,
  target,
  targetView = null,
}: {
  result: LooseRecord;
  repo: JsonValue;
  target?: JsonValue;
  targetView?: LooseRecord | null;
}) {
  const direct =
    result.reviewed_sha ??
    result.head_sha ??
    result.canonical?.pull_request?.head_sha ??
    result.canonical_item?.pull_request?.head_sha ??
    null;
  if (direct) return direct;

  const canonicalPr = parsePullRequestUrl(result.canonical_pr);
  if (!canonicalPr || canonicalPr.repo !== String(repo)) return null;
  if (target !== undefined && Number(canonicalPr.number) !== Number(target)) return null;

  return (
    targetView?.headRefOid ?? targetView?.head_sha ?? targetView?.pull_request?.head_sha ?? null
  );
}
