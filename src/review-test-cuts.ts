import type { LowValueTest, TestCutRange } from "./clawsweeper-types.js";
import { readReviewGit, reviewObjectId, safeReviewPath } from "./pr-review-evidence.js";

/** Match each cut to the reviewed head, then check that its witnesses survive all removals. */
export function verifyTestCutSources(
  cuts: LowValueTest[],
  checkoutDir: string,
  headSha: string | undefined,
): LowValueTest[] {
  const sha = reviewObjectId(headSha);
  if (!cuts.length || !sha) return [];
  const files = new Map<string, string[]>();
  const deadlineAt = Date.now() + 5_000;
  function lines(file: string): string[] {
    if (!safeReviewPath(file)) return [];
    let content = files.get(file);
    if (!content) {
      const blob = readReviewGit(checkoutDir, ["cat-file", "blob", `${sha}:${file}`], {
        deadlineAt,
      });
      content = blob?.toString("utf8").split(/\r?\n/) ?? [];
      if (content.at(-1) === "") content.pop();
      files.set(file, content);
    }
    return content;
  }
  const present = cuts
    .filter((cut) => "behaviors" in cut)
    .filter(
      (cut) =>
        cut.sourceLines?.length === cut.lineEnd - cut.lineStart + 1 &&
        cut.lineEnd <= lines(cut.file).length &&
        cut.sourceLines.every(
          (line, index) => lines(cut.file)[cut.lineStart - 1 + index] === line,
        ) &&
        cut.behaviors.every(
          ({ survivor }) =>
            lines(survivor.file)[survivor.line - 1]?.trim() === survivor.assertion &&
            survivor.inputs.every(
              (input) =>
                input.lineEnd <= lines(input.file).length &&
                lines(input.file)[input.lineStart - 1]?.trim() === input.sourceLine,
            ),
        ),
    );
  function remains({ file, lineStart, lineEnd }: TestCutRange): boolean {
    return !present.some(
      (cut) => cut.file === file && cut.lineStart <= lineEnd && lineStart <= cut.lineEnd,
    );
  }
  return present.filter((cut) =>
    cut.behaviors.every(
      ({ survivor }) =>
        remains({ file: survivor.file, lineStart: survivor.line, lineEnd: survivor.line }) &&
        survivor.inputs.every(remains),
    ),
  );
}
