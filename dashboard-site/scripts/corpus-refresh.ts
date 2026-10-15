import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isRecord } from "./guards.ts";

export const CORPUS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function corpusNeedsRefresh(corpus: unknown, force = false, now = Date.now()): boolean {
  if (force || !isRecord(corpus) || corpus.version !== 2) return true;
  const generatedAt = typeof corpus.generatedAt === "string" ? Date.parse(corpus.generatedAt) : NaN;
  // A future timestamp cannot extend freshness indefinitely after clock drift.
  return (
    !Number.isFinite(generatedAt) ||
    generatedAt > now ||
    now - generatedAt >= CORPUS_REFRESH_INTERVAL_MS
  );
}

export async function selectCorpusRefresh(path: string, force = false, now = Date.now()) {
  let corpus: unknown;
  try {
    corpus = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
  }
  return corpusNeedsRefresh(corpus, force, now);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, force] = process.argv.slice(2);
  if (!path || (force !== "true" && force !== "false"))
    throw new Error("usage: corpus-refresh.ts <corpus.json> <true|false>");
  console.log(`refresh=${await selectCorpusRefresh(path, force === "true")}`);
}
