export class OutputLastMessageParser {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private failed: Error | undefined;
  private finalText: string | undefined;
  private finished = false;

  constructor(private readonly maxTextBytes: number) {}

  append(chunk: Buffer): void {
    if (this.failed || this.finished) return;
    // Piped human-mode stdout contains only Codex's authoritative final answer,
    // including terminal recovery, followed by the one LF added by println!.
    if (this.bytes + chunk.length > this.maxTextBytes + 1) {
      this.fail(`Codex result exceeded its ${this.maxTextBytes}-byte limit.`);
      return;
    }
    if (chunk.length === 0) return;
    this.chunks.push(Buffer.from(chunk));
    this.bytes += chunk.length;
  }

  finish(): { text?: string; error?: Error } {
    if (!this.finished) {
      this.finished = true;
      if (!this.failed) {
        const output = Buffer.concat(this.chunks, this.bytes);
        this.chunks = [];
        if (output.at(-1) !== 0x0a) {
          this.fail("Codex final output did not end with its newline frame.");
        } else {
          try {
            this.finalText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              output.subarray(0, -1),
            );
          } catch {
            this.fail("Codex final output contained invalid UTF-8.");
          }
        }
      }
    }
    if (this.failed) return { error: this.failed };
    return this.finalText === undefined ? {} : { text: this.finalText };
  }

  private fail(message: string): void {
    this.failed = new Error(message);
    this.chunks = [];
    this.finalText = undefined;
  }
}
