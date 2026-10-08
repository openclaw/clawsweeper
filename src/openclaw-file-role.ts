// Explicit naming facts only; callers own normalization and surface precedence.
export function isOpenClawTestRolePath(path: string): boolean {
  return (
    path.endsWith("_test.go") ||
    /(?:^|\/)(?:__tests__|tests?|test-(?:support|helpers|utils|harness|fixtures))\//.test(path) ||
    /(?:^|[/.])(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(?:^|[/.-])test-(?:support|helpers|utils|harness|fixtures)\.[cm]?[jt]sx?$/.test(path) ||
    // Native app test targets: Swift `Tests/`, `UITests/`, `WatchTests/`; Gradle `src/test*/`, `src/androidTest*/`.
    /(?:^|\/)(?:[A-Za-z]*Tests|src\/(?:test|androidTest)(?:[A-Z][A-Za-z]*)?)\//.test(path)
  );
}
