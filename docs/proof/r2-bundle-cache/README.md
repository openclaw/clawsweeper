# R2 exact-review bundle cache proof

The controlled behavior proof runs the production signed cache client against
`wrangler dev --local`, including the real Miniflare R2 and Durable Object
bindings, while a loopback HTTP server counts authoritative artifact requests.

Run it through the explicitly requested Docker-backed Crabbox provider:

```sh
proof_head="$(git rev-parse HEAD)"
proof_tree="$(git rev-parse HEAD^{tree})"
git cat-file -e "${proof_head}^{commit}"
git cat-file -e "${proof_tree}^{tree}"
../crabbox/bin/crabbox run \
  --provider local-container \
  --local-container-image node:24-bookworm \
  --no-hydrate \
  --timing-json \
  --script scripts/e2e/r2-bundle-cache-crabbox.sh \
  -- "$proof_head" "$proof_tree"
```

The script writes `.artifacts/r2-bundle-cache/proof.json`. Its static verifier
is:

```sh
jq -e '
  .r2.semantics == "wrangler-dev-local" and
  .first.source == "github" and .first.githubArtifactRequests == 1 and
  .second.source == "r2" and .second.githubArtifactRequests == 0 and
  .first.digest == .second.digest and
  .missingFallback.source == "github" and .missingFallback.githubArtifactRequests == 1 and
  .leaseMismatch.source == "github" and .leaseMismatch.githubArtifactRequests == 1 and
  .counted.repeatBefore == 1 and .counted.repeatAfter == 0 and
  .git.catFileCrossCheck == true
' .artifacts/r2-bundle-cache/proof.json
```

This proves the changed acquisition/cache protocol locally, including an
object-missing fallback and a lease-revision mismatch. It does not exercise the
deployed Cloudflare network or GitHub's hosted artifact service. OpenClaw Bay is
unaffected: this cache is internal data-plane state and exposes no observer or
control contract.
