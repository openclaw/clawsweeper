// Write public-safe synthetic presentation data to an isolated site build.
// node scripts/dashboard-mobile-fixture.mjs <target-dashboard-json>
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const target = process.argv[2];
if (!target) throw new Error("Pass the isolated site src/data/dashboard.json path");
const data = JSON.parse(await readFile("dashboard-site/fixtures/dashboard.json", "utf8"));
for (const rows of Object.values(data.corpus.lists)) {
  for (const item of rows) {
    item.title =
      "Preserve repository access and long-running review evidence when the mobile triage screen is narrow — investigate source freshness before deciding";
    item.maintainerKind = "product";
    item.security = "needs_attention";
    item.closeReason = "implemented_on_main";
  }
}
data.corpus.repos.push({
  ...data.corpus.repos[0],
  repo: "example/long-public-repository-name-for-responsive-triage",
  slug: "example-long-public-repository-name-for-responsive-triage",
});
if (process.argv.includes("--edge-cases")) {
  const item = data.corpus.lists.maintainer[0];
  item.repo = "example/long-public-repository-name-for-responsive-triage";
  item.url = `https://github.com/${item.repo}/issues/${item.number}`;
  item.reviewedAt = null;
}
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(data));
