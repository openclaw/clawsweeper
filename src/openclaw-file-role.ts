// Explicit naming facts only; callers own normalization and surface precedence.
export function isOpenClawTestRolePath(path: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|tests?|test-(?:support|helpers|utils|harness|fixtures))\//.test(path) ||
    /(?:^|[/.])(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|[/.-])test-(?:support|helpers|utils|harness|fixtures)\.[cm]?[jt]sx?$/.test(path)
  );
}
