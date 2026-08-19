# Dashboard page extraction behavior contract

## User-visible goal

Moving the server-side page renderers out of `dashboard/worker.ts` must not change any rendered
dashboard page bytes or HTTP behavior.

## Target

- Type: web app
- Access: a real local Wrangler Worker
- Allowed fixtures and credentials: no fixtures or credentials; page-shell routes only

## User tasks

1. Open `/` and receive the ClawSweeper live dashboard HTML.
2. Open `/triage` and receive the issue-triage HTML.
3. Open `/pr-proof-triage` and receive the pull-request proof-triage HTML.

## Expected observable behavior

- Each route returns HTTP 200, `text/html; charset=utf-8`, and `cache-control: no-store`.
- The base and extracted-renderer Workers return byte-identical bodies after normalizing ISO
  timestamps and generated 40-character hexadecimal SHAs.
- Each route remains distinct and exposes its expected page title and client API endpoint.

## Anti-cheat probes

- Fetch every route twice and require byte-identical repeat responses.
- Require the three page bodies to have distinct SHA-256 hashes.
- Request an unknown route and require HTTP 404.

## Evidence required

- Base/head response hashes and byte counts
- Empty normalized unified diff
- Source-blind behavior-validation report
- Worker logs and base/head/runtime provenance

## Out of scope

- JSON API payloads, production data, queue/state mutations, browser interactions, and `/bay-demo`,
  whose renderer already lives in `dashboard/bay-page.ts` and is not part of this extraction
