export type PrSurfaceBucket = "source" | "tests" | "docs" | "config" | "generated" | "other";

export interface PrSurfaceFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrSurfaceStatsRow {
  bucket: PrSurfaceBucket;
  label: string;
  files: number;
  additions: number;
  deletions: number;
  net: number;
}

const BUCKETS: readonly { bucket: PrSurfaceBucket; label: string }[] = [
  { bucket: "source", label: "Source" },
  { bucket: "tests", label: "Tests" },
  { bucket: "docs", label: "Docs" },
  { bucket: "config", label: "Config" },
  { bucket: "generated", label: "Generated" },
  { bucket: "other", label: "Other" },
];

export function buildOpenClawPrSurfaceStats(files: readonly PrSurfaceFile[]): PrSurfaceStatsRow[] {
  const rows = BUCKETS.map(({ bucket, label }) => ({
    bucket,
    label,
    files: 0,
    additions: 0,
    deletions: 0,
    net: 0,
  }));
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));

  for (const file of files) {
    const bucket = openClawPrSurfaceBucket(file.path);
    const row = byBucket.get(bucket);
    if (!row) continue;
    row.files += 1;
    row.additions += file.additions;
    row.deletions += file.deletions;
    row.net += file.additions - file.deletions;
  }

  return rows;
}

export function openClawPrSurfaceBucket(file: string): PrSurfaceBucket {
  const normalized = file.trim().replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? normalized;

  if (isOpenClawGeneratedPath(normalized, basename)) return "generated";
  if (isOpenClawTestPath(normalized)) return "tests";
  if (isOpenClawDocsPath(normalized, basename)) return "docs";
  if (isOpenClawConfigPath(normalized, basename)) return "config";
  if (isOpenClawSourcePath(normalized)) return "source";
  return "other";
}

export function renderOpenClawPrSurfaceSummary(stats: readonly PrSurfaceStatsRow[]): string {
  const total = totalPrSurfaceStats(stats);
  if (total.files === 0) return "";
  const parts = stats
    .filter((row) => row.files > 0 || row.additions > 0 || row.deletions > 0)
    .map((row) => `${row.label} ${formatNet(row.net)}`);
  return `${parts.join(", ")}. Total ${formatNet(total.net)} across ${total.files} ${pluralize("file", total.files)}.`;
}

export function renderOpenClawPrSurfaceTable(stats: readonly PrSurfaceStatsRow[]): string {
  const total = totalPrSurfaceStats(stats);
  return [
    "| Area | Files | Added | Removed | Net |",
    "|---|---:|---:|---:|---:|",
    ...stats.map(
      (row) =>
        `| ${row.label} | ${row.files} | ${row.additions} | ${row.deletions} | ${formatNet(row.net)} |`,
    ),
    `| **Total** | **${total.files}** | **${total.additions}** | **${total.deletions}** | **${formatNet(total.net)}** |`,
  ].join("\n");
}

function totalPrSurfaceStats(
  stats: readonly PrSurfaceStatsRow[],
): Omit<PrSurfaceStatsRow, "bucket" | "label"> {
  return stats.reduce(
    (total, row) => ({
      files: total.files + row.files,
      additions: total.additions + row.additions,
      deletions: total.deletions + row.deletions,
      net: total.net + row.net,
    }),
    { files: 0, additions: 0, deletions: 0, net: 0 },
  );
}

function isOpenClawSourcePath(file: string): boolean {
  return /^(?:src|ui|packages|extensions)\//.test(file);
}

function isOpenClawTestPath(file: string): boolean {
  return (
    /(?:^|\/)__tests__\//.test(file) ||
    /^(?:test|tests)\//.test(file) ||
    /\.(?:test|spec|e2e\.test)\.[cm]?[jt]sx?$/.test(file)
  );
}

function isOpenClawDocsPath(file: string, basename: string): boolean {
  return (
    file.startsWith("docs/") ||
    /^README(?:\.[A-Za-z0-9_-]+)?$/i.test(basename) ||
    basename === "CHANGELOG.md" ||
    /\.(?:md|mdx)$/i.test(file)
  );
}

function isOpenClawConfigPath(file: string, basename: string): boolean {
  return (
    file.startsWith(".github/") ||
    basename === "package.json" ||
    basename === "pnpm-workspace.yaml" ||
    /^tsconfig(?:\.[^.]+)?\.json$/i.test(basename)
  );
}

function isOpenClawGeneratedPath(file: string, basename: string): boolean {
  return (
    file.startsWith("protocol-generated/") ||
    file.startsWith("docs/.generated/") ||
    basename.includes(".generated.") ||
    /(?:^|\/)__snapshots__\//.test(file) ||
    /\.(?:snap|snapshot)$/i.test(basename)
  );
}

function formatNet(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
