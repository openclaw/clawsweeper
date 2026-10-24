# Incremental dashboard corpus proof

- Status: active controlled proof fixture
- Owner: ClawSweeper maintainers
- Source of truth: `scripts/dashboard-corpus.ts`, `dashboard-site/scripts/build-corpus.ts`,
  `.github/workflows/dashboard-corpus.yml` and `.github/workflows/dashboard-site.yml`
- Update when: the corpus refresh, the sealed tree, the corpus aggregate or either workflow changes

Prepare once: `pnpm run build` (the fixture writes records with
`dist/repair/state-append-client.js`) and `pnpm --dir dashboard-site install --frozen-lockfile`
(the pinned Wrangler and Astro).

- `node docs/proof/dashboard-incremental-corpus/run-proof.mjs` starts the production Worker and
  exact-review queue Durable Object under the dashboard site's pinned Wrangler (`wrangler dev
  --local`: workerd, SQLite, local R2; outbound fetches and alarms blocked), writes synthetic
  canonical records through the production tuple-write API, stores an R2 snapshot with the real
  `snapshot-upload` CLI, then drives the real corpus CLIs: full rebuild, aggregate, seal, unseal,
  an idle refresh, a busy hour (updates, archive and reopen moves, deletions, plans-only edits, a
  new repository, a non-public repository), a failing refresh, and a comparison full rebuild. It
  counts every Worker request per phase and builds the static site from the produced corpus.
- `run-workflow-proof.mjs` runs `dashboard-corpus.yml` and the publish job of
  `dashboard-site.yml` under [act](https://github.com/nektos/act) against the same Worker: real
  `actions/cache` restore and save through act's cache server, the workflows' own conditions and
  shell, in a container with Node and jq. It covers a full dispatch, a site build from its
  aggregate, an incremental dispatch from the restored sealed tree, a refresh failing with a
  rotated secret, a site build that still shows the last good corpus, a scheduled retry that
  catches up, and the prune step's shell against a stub `gh`. The site job swaps
  `build-data.ts` (live GitHub and production reads) for `site-proof.mjs` and drops the Pages
  step, so nothing is published.
- `bench.mjs [--baseline <checkout>]` times the local phases of an hourly run (unseal,
  aggregate, seal) on a 100,000-record tree, interleaving baseline and candidate.

Limits: synthetic records on loopback. No production Cloudflare, GitHub-hosted runner, Actions
cache service, caches API or Pages deployment is exercised, and timings are not production
throughput claims. The visibility check in the workflow proof reads api.github.com anonymously
for the public fixture repository names.
