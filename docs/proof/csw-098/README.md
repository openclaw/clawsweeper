# CSW-098 Live Activity proof

`run-proof.sh` runs a controlled Linux/Wrangler/Playwright proof. It verifies
the real local Worker endpoint fails closed without its GitHub status source,
then uses the built Bay page with controlled redacted activity payloads to show
active display, stale-to-Unknown expiry, unchanged durable Kanban cards, and
GET-only browser traffic. Generated artifacts are retained in `artifacts/`.
