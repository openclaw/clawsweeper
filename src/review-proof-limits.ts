/** Serialized result budget enforced by the durable queue; observations retain their smaller cap. */
export const REVIEW_PROOF_RESULT_MAX_BYTES = 256 * 1024;
/** Only transport headroom for state, requestId and planSha256 around that result. */
export const REVIEW_PROOF_RESPONSE_MAX_BYTES = REVIEW_PROOF_RESULT_MAX_BYTES + 1024;
