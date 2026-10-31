// Controlled real record -> production corpus -> Astro -> Chromium proof.
// No live stores, tokens, GitHub calls, queue actions or publication.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { writeAssessmentScenario } from '../../../dashboard-site/fixtures/assessment-records.ts';

const root = process.cwd();
const output = resolve(process.env.PROOF_OUTPUT_DIR ?? '.artifacts/historical-assessments');
mkdirSync(output, { recursive: true });
const base = process.env.PROOF_BASE ?? 'c1c4dd7bef083590d0a76b2dfcdf43d3922827ca';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard',
  'dashboard-site', 'docs/proof/historical-assessments', 'scripts/dashboard-corpus.ts'], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).filter(file => !/^docs\/proof\/historical-assessments\/.*\.png$/.test(file)).sort();
const sourceIdentity = () => createHash('sha256').update(sourceFiles.map(file =>
  file + ':' + createHash('sha256').update(readFileSync(file)).digest('hex')).join('\n')).digest('hex');
const sourceDigest = sourceIdentity();
const now = Date.parse('2026-10-30T23:00:00Z');
const date = new Date(now).toISOString();
const baseline = join(output, 'baseline-source');
mkdirSync(baseline, { recursive: true });
execFileSync('tar', ['-xf', '-', '-C', baseline], { input: execFileSync('git', [
  'archive', base, 'dashboard-site', 'src/maintainer-review-policy.ts',
]) });
if (!existsSync(join(baseline, 'dashboard-site/node_modules')))
  symlinkSync(join(root, 'dashboard-site/node_modules'), join(baseline, 'dashboard-site/node_modules'));
const envelope = JSON.parse(readFileSync('dashboard-site/fixtures/dashboard.json', 'utf8'));
const records = join(output, 'records');
const { visibility, expected } = writeAssessmentScenario(records, now);
const candidateProducer = await import(pathToFileURL(join(root, 'dashboard-site/scripts/records.ts')));
const baselineProducer = await import(pathToFileURL(join(baseline, 'dashboard-site/scripts/records.ts')));
const snapshots = {};
for (const [name, producer] of [['before', baselineProducer], ['after', candidateProducer]]) {
  const cache = await producer.aggregateRecords(records, structuredClone(visibility), undefined, now);
  const corpus = producer.combineCorpus(cache, () => true);
  assert(!JSON.stringify(corpus).includes('PRIVATE_'));
  assert(!JSON.stringify(corpus).includes('BODY_SENTINEL'));
  writeFileSync(join(output, name + '-corpus.json'), JSON.stringify(corpus, null, 2));
  snapshots[name] = { ...envelope, generatedAt: date, corpus };
}
for (const [group, total] of Object.entries(expected)) for (const concern of ['security', 'maintainer'])
  assert.equal(snapshots.after.corpus.assessments.groups[group][concern].total, total);
assert.equal(snapshots.after.corpus.repositoryAssessments['fixture-assessments'].groups.open.security.total, 2);
// Prove bounded semantic selection separately from the curated screenshot dataset.
const largeRoot = join(output, 'large-records');
const large = writeAssessmentScenario(largeRoot, now, 240);
const largeCache = await candidateProducer.aggregateRecords(largeRoot, large.visibility, undefined, now);
const bounded = candidateProducer.combineCorpus(largeCache, () => true);
assert.equal(bounded.assessments.groups.open.security.total, 243);
assert.equal(bounded.assessments.groups.open.security.items.length, 100);
assert.equal(bounded.repositoryAssessments['fixture-assessments'].groups.open.security.items.length, 20);
assert.equal(bounded.assessments.groups.open.security.items[0].number, 2);
writeFileSync(join(output, 'bounded-corpus.json'), JSON.stringify(bounded, null, 2));
// Real producer on a record with no concern establishes true recorded zero.
const emptyRoot = join(output, 'empty-records');
mkdirSync(join(emptyRoot, 'fixture-assessments/items'), { recursive: true });
copyFileSync(join(records, 'fixture-assessments/items/8.md'), join(emptyRoot, 'fixture-assessments/items/8.md'));
const emptyCache = await candidateProducer.aggregateRecords(emptyRoot, visibility, undefined, now);
snapshots.empty = { ...envelope, generatedAt: date, corpus: candidateProducer.combineCorpus(emptyCache, () => true) };
for (const group of ['open', 'changed', 'unknown', 'historical'])
  assert.equal(snapshots.empty.corpus.assessments.groups[group].security.total, 0);
const legacyCache = await candidateProducer.aggregateRecords(records, visibility, undefined, now);
for (const part of legacyCache.repositories) delete part.assessments;
snapshots.legacy = { ...envelope, generatedAt: date, corpus: candidateProducer.combineCorpus(legacyCache, () => true) };
assert.equal(snapshots.legacy.corpus.assessments, null);
// An older classifier can coexist with the landed scoped collection transport.
// Hide the primary repo from legacy global flags only: scoped fallback must win.
snapshots.scoped = structuredClone(snapshots.legacy);
for (const concern of ['security', 'maintainer'])
  snapshots.scoped.corpus.lists[concern] = snapshots.scoped.corpus.lists[concern].filter(row => row.repo !== 'fixture/assessments');
assert(snapshots.scoped.corpus.repositoryCollections['fixture-assessments'].security.items.some(row => row.number === 2));
assert(!snapshots.scoped.corpus.lists.security.some(row => row.repo === 'fixture/assessments'));

const savedData = existsSync('dashboard-site/src/data/dashboard.json')
  ? readFileSync('dashboard-site/src/data/dashboard.json') : null;
async function build(name, source) {
  const site = join(source, 'dashboard-site');
  mkdirSync(join(site, 'src/data'), { recursive: true });
  writeFileSync(join(site, 'src/data/dashboard.json'), JSON.stringify(snapshots[name]));
  const log = execFileSync('pnpm', ['exec', 'astro', 'build', '--outDir', join(output, name + '-site')], {
    cwd: site, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  writeFileSync(join(output, name + '-build.log'), log);
}
try {
  await build('before', baseline);
  for (const name of ['after', 'empty', 'legacy', 'scoped']) await build(name, root);
} finally {
  if (savedData) writeFileSync('dashboard-site/src/data/dashboard.json', savedData);
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const [name, ...parts] = pathname.slice(1).split('/');
  if (!['before', 'after', 'empty', 'legacy', 'scoped'].includes(name)) { response.writeHead(404).end(); return; }
  // Astro assets and root links resolve at /, so referer selects the active build.
  let relative = parts.join('/');
  if (!relative || relative.endsWith('/')) relative += 'index.html';
  const file = resolve(output, name + '-site', relative);
  if (!file.startsWith(join(output, name + '-site') + '/') || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
const origin = 'http://127.0.0.1:' + server.address().port;
let executable = process.env.CHROMIUM_PATH;
if (!executable) {
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome'])
    if (existsSync(candidate)) { executable = candidate; break; }
}
if (!executable) {
  const cache = join(process.env.HOME, '.cache/ms-playwright');
  if (existsSync(cache)) for (const directory of readdirSync(cache).sort().reverse()) {
    const candidate = join(cache, directory, 'chrome-linux64/chrome');
    if (existsSync(candidate)) { executable = candidate; break; }
  }
}
assert(executable, 'No Chromium executable available; set CHROMIUM_PATH');
const browser = await chromium.launch({ executablePath: executable, headless: true, args: ['--no-sandbox'] });
const requests = [];
const results = [];
let tooltipCompatibility = false;
try {
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 768, 1440]) for (const name of ['before', 'after', 'empty', 'legacy', 'scoped']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, hasTouch: width < 768, isMobile: width < 768 });
    await context.addInitScript(({ theme, now }) => { localStorage.setItem('clawsweeper-theme', theme); Date.now = () => now; }, { theme, now });
    // Root-relative site navigation/assets retain the selected real static build.
    await context.route(origin + '/**', async route => {
      const url = new URL(route.request().url());
      if (!/^\/(before|after|empty|legacy|scoped)\//.test(url.pathname))
        url.pathname = '/' + name + url.pathname;
      const response = await route.fetch({ url: url.href });
      await route.fulfill({ response });
    });
    context.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const route of name === 'scoped' ? ['/repos/fixture-assessments/'] : ['/', '/quality/', '/repos/fixture-assessments/']) {
      await page.goto(origin + '/' + name + route, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const text = await page.locator('main').innerText();
      assert(!text.includes('PRIVATE_'));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No page-wide overflow: ' + name + route + width + theme);
      if (name === 'after') {
        const row = page.locator('[data-attention-group="open"] [data-assessment-concern="security"] tbody tr').first();
        const geometry = await row.evaluate(row => {
          const title = row.querySelector('.item-title'), identity = row.querySelector('.item-identity'), meta = row.querySelector('.item-assessment');
          return { title: title.textContent, titleFits: title.scrollWidth <= title.clientWidth + 1, identityFits: identity.scrollWidth <= identity.clientWidth + 1, width: title.getBoundingClientRect().width, metaFits: meta.scrollWidth <= meta.clientWidth + 1, evidenceInMetadata: !!meta.querySelector('[data-assessment-evidence]'), review: row.querySelector('.item-review').textContent };
        });
        assert(geometry.title.includes('old unresolved security concern'));
        assert(geometry.titleFits && geometry.identityFits && geometry.metaFits && geometry.evidenceInMetadata, JSON.stringify({name,route,width,theme,geometry}));
        assert(geometry.width >= 100);
        assert(geometry.review.includes('ago'));
        const unknownReview = page.locator('[data-attention-group="unknown"] .item-review').first();
        assert((await unknownReview.innerText()).includes('Unknown'));
      }
      if (name !== 'before') {
        const freshness = page.locator('.snapshot-freshness');
        assert((await freshness.locator('summary').innerText()).includes('Reviews'));
        await freshness.locator('summary').click();
        assert(await freshness.getAttribute('open') !== null);
        await freshness.locator('summary').click();
      }
      if (name === 'after') {
        assert(text.includes('Current source-valid attention: unavailable'));
        assert(text.includes('old unresolved security concern'));
        const expectedOpen = route.startsWith('/repos/') ? 2 : 3;
        for (const [group, total] of Object.entries({ open: expectedOpen, changed: 2, unknown: 1, historical: 2 })) {
          const card = page.locator('[data-attention-group="' + group + '"] [data-assessment-concern="security"]');
          assert.equal(await card.getAttribute('data-assessment-total'), String(total));
        }
        assert(await page.locator('[data-attention-group="historical"] a[href$="/pull/3"]').count());
        assert.equal(await page.locator('[data-attention-group="open"] a[href$="/pull/3"]').count(), 0);
        await page.locator('details[data-attention-group="historical"] summary').focus();
        await page.keyboard.press('Enter');
        assert(await page.locator('details[data-attention-group="historical"]').getAttribute('open') !== null);
        if (route === '/quality/') {
          await page.locator('[data-assessment-attention]').evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - document.querySelector('.site-header').getBoundingClientRect().height - 16));
          await page.screenshot({ path: join(output, 'after-' + width + '-' + theme + '.png'), animations: 'disabled' });
          if (width === 1440 && theme === 'dark') await page.screenshot({ path: join(output, 'after.png'), animations: 'disabled' });
          if (width === 390 && theme === 'dark') await page.screenshot({ path: join(output, 'after-mobile.png'), animations: 'disabled' });
        }
      } else if ((name === 'legacy' || name === 'scoped')) {
        assert(text.includes('Classification and group totals unavailable'));
        assert(text.includes('old unresolved security concern'), 'Legacy recorded flags must remain visible on every scope');
        assert.equal(await page.locator('[data-attention-group="open"]').count(), 0);
      } else if (name === 'empty') {
        assert(text.includes('No recorded flags in this group. Current concerns are not verified.'));
        assert(text.includes('Current source-valid attention: unavailable'));
      } else if (route === '/quality/') {
        assert(text.includes('old unresolved security concern'));
        assert.equal(await page.locator('[data-assessment-attention]').count(), 0);
        await page.locator('#maintainer').evaluate(el => window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top - document.querySelector('.site-header').getBoundingClientRect().height - 16));
        await page.screenshot({ path: join(output, 'before-' + width + '-' + theme + '.png'), animations: 'disabled' });
        if (width === 1440 && theme === 'dark') await page.screenshot({ path: join(output, 'before.png'), animations: 'disabled' });
      }
      if (name === 'scoped') {
        assert.equal(await page.locator('[data-attention-group="legacy"] a[href="https://github.com/fixture/assessments/pull/2"]').count(), 2, 'Both scoped legacy concern cards retain the old flag');
        assert(text.includes('No recorded closes in the stored corpus.'));
        assert(!text.includes('No stale open items in the stored corpus.'));
      }
      results.push({ build: name, route, width, theme, passed: true });
    }
    if (name === 'after') {
      await page.goto(origin + '/' + name + '/quality/', { waitUntil: 'networkidle' });
      await page.getByRole('button', {name: 'Jump to repository', exact: true}).isVisible().then(async visible => {
        if (visible) await page.getByRole('button', {name: 'Jump to repository', exact: true}).click();
        else await page.keyboard.press('Control+k');
      });
      const search = page.getByRole('textbox', {name:'Search repositories', exact:true});
      await search.fill('other-repo');
      assert.equal(await page.locator('#cmd-list a').count(), 1);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#cmd[open]').count(), 0);
      if (width < 768) {
        await page.locator('.mobile-sections summary').click();
        assert(await page.locator('.mobile-sections a[aria-current="page"]').isVisible());
        await page.locator('.mobile-sections summary').click();
      }
      await page.goto(origin + '/' + name + '/coverage/', { waitUntil: 'networkidle' });
      assert.equal(await page.locator('[data-info-tip]').count(), 5);
      const info = page.getByRole('button', { name: 'About Reviewed recently', exact: true });
      const tip = page.locator('#tip');
      await info.focus();
      assert((await tip.getAttribute('class') ?? '').includes('on'));
      assert.match(await tip.innerText(), /Reviewable items with a completed review dated/);
      await page.keyboard.press('Escape');
      assert(!(await tip.getAttribute('class') ?? '').includes('on'));
      await info.click();
      assert((await tip.getAttribute('class') ?? '').includes('on'));
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width, height: 1000 });
      await info.click();
      assert((await tip.getAttribute('class') ?? '').includes('on'));
      await page.locator('h1').click();
      assert(!(await tip.getAttribute('class') ?? '').includes('on'));
      tooltipCompatibility = true;
      results.push({ build: name, route: '/coverage/', width, theme, tooltipCompatibility: true, passed: true });
    }
    assert.deepEqual(errors, []);
    await context.unrouteAll({ behavior: 'wait' });
    await context.close();
  }
  assert(!requests.some(request => new URL(request.url).hostname === 'api.github.com'));
  assert(requests.every(request => request.method === 'GET'));
} finally {
  await browser.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
assert.equal(sourceIdentity(), sourceDigest, "Source changed during proof");
const artifacts = ['before.png', 'after.png', 'after-mobile.png'].map(name => ({
  name, sha256: createHash('sha256').update(readFileSync(join(output, name))).digest('hex'),
}));
const receipt = {
  base, head, sourceStatus: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }),
  node: process.version, browser: executable, scenarioAt: date, sourceDigest, sourceFiles,
  expected, results, bounded: { total: 243, globalRows: 100, repositoryRows: 20 },
  browserRequests: requests, noBrowserGitHubApi: true, observerOnly: true, tooltipCompatibility, artifacts,
  limits: 'Controlled canonical-record fixtures and repository preview envelope; real corpus producers and Astro/browser, no live source-validity receipt, store hydration, visibility API, deployment, queue mutation, or GitHub mutation. Not a complete review-event history.',
};
writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ output, results: results.length, passed: true, artifacts }));
