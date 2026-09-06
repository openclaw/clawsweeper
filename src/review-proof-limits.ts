/** Shared ceiling from the first plan; the original review deadline and decision reserve may end it earlier. */
export const REVIEW_PROOF_LIFETIME_MS = 20 * 60_000;
/** Serialized result budget enforced by the durable queue; observations retain their smaller cap. */
export const REVIEW_PROOF_RESULT_MAX_BYTES = 256 * 1024;
/** Only transport headroom for state, requestId, planSha256 and expiresAt around that result. */
export const REVIEW_PROOF_RESPONSE_MAX_BYTES = REVIEW_PROOF_RESULT_MAX_BYTES + 1024;
