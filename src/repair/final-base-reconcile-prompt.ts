export const NORMAL_REBASE_COMPLETION_RULE =
  "- when git conflicts exist, resolve every conflict marker and leave the checkout in a normal non-rebasing state;";
export const FINAL_REBASE_HANDOFF_RULE =
  "- for this final base reconciliation, resolve every conflict marker and stage the resolved files, but do not run git rebase --continue, git rebase --skip, or git rebase --abort; leave the rebase pending so ClawSweeper can continue it through isolated Git plumbing;";

export function rewriteFinalBaseReconcilePrompt(prompt: string): string {
  if (!prompt.includes(NORMAL_REBASE_COMPLETION_RULE)) {
    throw new Error("final base reconcile prompt no longer exposes the expected rebase contract");
  }
  return prompt.replace(NORMAL_REBASE_COMPLETION_RULE, FINAL_REBASE_HANDOFF_RULE);
}
