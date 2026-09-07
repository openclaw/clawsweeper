// Test-only transport entry. Every state transition belongs to the actual Worker.
// The driver writes the loopback URL into this temporary copy before Wrangler starts.
import worker, { ExactReviewQueue, StatusStore } from "../../dashboard/worker.ts";
export { ExactReviewQueue, StatusStore };
const upstream = "MANUAL_PUBLICATION_SYNTHETIC_UPSTREAM";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  try {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.href ===
      "https://raw.githubusercontent.com/openclaw/clawsweeper/main/config/target-repositories.json"
    ) {
      return await realFetch(new Request(`${upstream}/registry`, request));
    }
    if (url.hostname !== "api.github.com")
      throw new Error(`proof refused outbound host: ${url.hostname}`);
    return await realFetch(new Request(`${upstream}${url.pathname}${url.search}`, request));
  } catch (error) {
    console.error(
      "synthetic transport failure",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
};
export default worker;
