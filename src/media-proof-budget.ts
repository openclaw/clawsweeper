// The time budget for preparing media proof before a review. The exact-review
// workflow imports this source file before the build, so it has no imports.

// Review preparation downloads and inspects at most this many media proof URLs.
export const MAX_MEDIA_PROOF_URLS = 4;
// Each media proof URL gets this long to download and inspect.
export const MEDIA_PROOF_TIMEOUT_MS = 120_000;
// The largest media proof allowance a review can need.
export const MAX_MEDIA_PROOF_TIMEOUT_MS = MAX_MEDIA_PROOF_URLS * MEDIA_PROOF_TIMEOUT_MS;
