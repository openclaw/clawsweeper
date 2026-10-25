// Build the review-corpus aggregate from an incrementally refreshed record tree.
//
//   node dashboard-site/scripts/build-corpus.ts --records <records dir> --out <dir>
//
// Run by the Dashboard corpus workflow after scripts/dashboard-corpus.ts refreshed the tree. It
// writes <out>/corpus.json, which the 15-minute Dashboard site build picks up, and keeps
// <out>/visibility.json between runs so a public repository's visibility is checked at most once
// a day. Both land in an Actions cache, so neither names a non-public repository: the aggregate
// leaves those out, and only public answers are kept (non-public ones are checked again).
// GITHUB_TOKEN raises the visibility-check rate limit.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { aggregateRecords, type Visibility } from './records.ts';

const { values } = parseArgs({ options: { records: { type: 'string' }, out: { type: 'string' } } });
if (!values.records || !values.out) throw new Error('usage: build-corpus.ts --records <dir> --out <dir>');
const out = values.out;
await mkdir(out, { recursive: true });

const visibilityPath = join(out, 'visibility.json');
let visibility: Visibility = {};
try {
  visibility = JSON.parse(await readFile(visibilityPath, 'utf8')) as Visibility;
} catch {
  visibility = {};
}
const startedAt = Date.now();
const cache = await aggregateRecords(values.records, visibility, process.env.GITHUB_TOKEN);
await writeFile(
  visibilityPath,
  JSON.stringify(Object.fromEntries(Object.entries(visibility).filter(([, entry]) => entry.public === true))),
);
await writeFile(join(out, 'corpus.json'), JSON.stringify(cache));
console.log(
  JSON.stringify({
    generatedAt: cache.generatedAt,
    repositories: cache.repositories.length,
    excludedRepositories: cache.excludedRepositories,
    records: cache.repositories.reduce((total, part) => total + part.totals.records, 0),
    durationMs: Date.now() - startedAt,
  }),
);
