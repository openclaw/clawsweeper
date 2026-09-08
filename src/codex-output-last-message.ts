export class OutputLastMessageParser {
  readonly maxLineBytes: number;
  private pending = Buffer.alloc(0);
  private failed: Error | undefined;
  private finalText: string | undefined;
  private finished = false;

  constructor(private readonly maxTextBytes: number) {
    this.maxLineBytes = maxTextBytes * 6 + 64 * 1024;
  }

  append(chunk: Buffer): void {
    if (this.failed || this.finished) return;
    let offset = 0;
    let newline = chunk.indexOf(0x0a, offset);
    while (newline >= 0) {
      const segment = chunk.subarray(offset, newline);
      if (!this.withinLineLimit(segment.length)) return;
      const line = this.pending.length === 0 ? segment : Buffer.concat([this.pending, segment]);
      this.pending = Buffer.alloc(0);
      this.consume(line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line);
      if (this.failed) return;
      offset = newline + 1;
      newline = chunk.indexOf(0x0a, offset);
    }

    const tail = chunk.subarray(offset);
    if (tail.length === 0 || !this.withinLineLimit(tail.length)) return;
    this.pending =
      this.pending.length === 0 ? Buffer.from(tail) : Buffer.concat([this.pending, tail]);
  }

  finish(): { text?: string; error?: Error } {
    if (!this.finished) {
      this.finished = true;
      if (!this.failed && this.pending.length > 0) {
        this.fail("Codex JSONL output ended with a partial line.");
      }
      if (!this.failed && this.finalText === undefined) {
        this.fail("Codex JSONL output did not contain a final agent message.");
      }
    }
    if (this.failed) return { error: this.failed };
    return this.finalText === undefined ? {} : { text: this.finalText };
  }

  private withinLineLimit(segmentBytes: number): boolean {
    if (this.pending.length + segmentBytes <= this.maxLineBytes) return true;
    this.fail(`Codex JSONL line exceeded its ${this.maxLineBytes}-byte limit.`);
    return false;
  }

  private fail(message: string): void {
    this.failed = new Error(message);
    this.pending = Buffer.alloc(0);
  }

  private consume(line: Buffer): void {
    if (line.length === 0) {
      this.fail("Codex JSONL output contained an empty line.");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    } catch {
      this.fail("Codex JSONL output contained a malformed line.");
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const event = value as Record<string, unknown>;
    if (event.type !== "item.completed") return;
    const item = event.item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    if (record.type !== "agent_message" || typeof record.text !== "string") return;
    if (Buffer.byteLength(record.text) > this.maxTextBytes) {
      this.fail(`Codex result exceeded its ${this.maxTextBytes}-byte limit.`);
      return;
    }
    this.finalText = record.text;
  }
}
