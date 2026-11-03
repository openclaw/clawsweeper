// Proof-only bridge through the ACTUAL private client and current metadata owner.
// Metadata services are explicit controlled fixtures, never inferred permission
// from persisted census visibility and never a replacement live GitHub read.
import {
  readCoverageForBuild,
  verifyPublicRepositories,
  publicCoverageForBuild,
} from "../../../dashboard-site/scripts/coverage.ts";

export async function verifiedCoverageBuildRead(fetchImpl, secret, github) {
  const candidates = await readCoverageForBuild(secret, fetchImpl, "https://local.invalid");
  const verified = await verifyPublicRepositories(
    candidates.fleets.map((row) => row.repo),
    github,
  );
  return publicCoverageForBuild(candidates, verified.names);
}

export function syntheticPublicMetadata(...names) {
  return async (path) => {
    if (path.startsWith("users/"))
      return Response.json(
        names
          .filter((name) => name.split("/")[0] === path.split("/")[1])
          .map((full_name) => ({ full_name, visibility: "public" })),
      );
    const name = path.slice("repos/".length);
    return names.includes(name)
      ? Response.json({ full_name: name, visibility: "public" })
      : new Response(null, { status: 404 });
  };
}
