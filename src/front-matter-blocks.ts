const FRONT_MATTER_KEY_LINE = /^[A-Za-z0-9_.-]+:/;
const CODE_FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Collect every *complete* front matter block in a record body.
 *
 * A report body is model-authored review text, so `key:` at the start of a line is
 * ordinary prose (a quoted PR field, a findings row) far more often than a competing
 * record. What makes a field genuinely ambiguous is a complete second metadata block:
 * a run of `key: value` lines closed by a `---` delimiter.
 *
 * The scan covers the whole body, not just its opening lines. A block appended after
 * paragraphs of prose impersonates a record exactly as well as one concatenated
 * directly onto the leading block, so stopping at the first prose line would reopen
 * the spoofing gap this guard exists to close. Fenced code is skipped: a ```yaml
 * sample is quoted illustration, and no reader treats it as record state.
 *
 * Deliberately NOT used by `repair/workflow-utils.ts`. That reader gates
 * close-promotion, where the conservative reading is the safe one: a spoofed
 * `pr_rating_overall:` line in a body must not enable a close, and
 * `test/repair/workflow-utils.test.ts` pins exactly that. Failing closed there costs
 * a promotion; failing closed here costs the whole record. Same shape, opposite
 * risk, so the two readers stay separate on purpose.
 */
export function competingFrontMatterBlocks(remainder: string): string[] {
  const lines = remainder.split(/\r?\n/);
  const blocks: string[] = [];

  // Returns the block starting at `start`, or null when the run is interrupted by
  // prose or never reaches a closing delimiter — an unterminated run is not a record.
  const readBlock = (start: number): { body: string; end: number } | null => {
    const body: string[] = [];
    let index = start;
    for (; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line === "---") break;
      if (!FRONT_MATTER_KEY_LINE.test(line)) return null;
      body.push(line);
    }
    if (index >= lines.length || body.length === 0) return null;
    return { body: body.join("\n"), end: index };
  };

  // The leading block's closing `---` doubles as the opener of a record pasted
  // straight onto it, so the remainder can begin part-way through one.
  let index = 0;
  const leading = readBlock(0);
  if (leading) {
    blocks.push(leading.body);
    index = leading.end;
  }

  let fence: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = CODE_FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch && (fenceMatch[1] ?? "").startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] ?? "";
      continue;
    }
    if (line !== "---") continue;
    const block = readBlock(index + 1);
    if (block) {
      blocks.push(block.body);
      index = block.end;
    }
  }
  return blocks;
}
