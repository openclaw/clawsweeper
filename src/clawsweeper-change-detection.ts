import { isOpenClawTestRolePath } from "./openclaw-file-role.js";
import type {
  ConfigSurfaceChange,
  DataModelChange,
  ItemContext,
  SqliteSchemaChange,
} from "./clawsweeper-types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function configSurfaceChangeFromContext(
  repo: string,
  context: ItemContext,
): ConfigSurfaceChange {
  if (repo !== "openclaw/openclaw") {
    return { change: false, keys: [] };
  }

  const keys = new Set<string>();
  for (const entry of context.pullFiles ?? []) {
    const file = asRecord(entry);
    const path = typeof file.filename === "string" ? file.filename.trim() : "";
    const previousPath =
      typeof file.previous_filename === "string" ? file.previous_filename.trim() : "";
    const configSurfacePath = [path, previousPath].find(isOpenClawConfigSurfacePath);
    if (!configSurfacePath) continue;
    const patch = typeof file.patch === "string" ? file.patch : null;
    if (patch !== null && configSurfacePatchIsTruncated(patch)) {
      keys.add("unknown-config-surface-change");
    }
    const lines = patch === null ? [] : changedPatchLines(patch);
    if (patch === null || lines.length === 0) {
      keys.add("unknown-config-surface-change");
    }
    for (const line of lines) {
      const lineKeys = configSurfaceKeysFromPatchLine(configSurfacePath, line);
      if (
        lineKeys.length === 0 &&
        !isMarkdownConfigSurfacePath(configSurfacePath) &&
        configSurfaceLineNeedsUnknownMarker(line)
      ) {
        keys.add("unknown-config-surface-change");
      }
      for (const key of lineKeys) {
        keys.add(key);
      }
    }
  }

  if (context.counts?.pullFilesTruncated) {
    keys.add("unknown-truncated-pull-files");
  }

  return { change: keys.size > 0, keys: [...keys].sort() };
}

export function configSurfaceChangeFromPullFilesForTest(options: {
  repo?: string;
  pullFiles?: unknown[];
  pullFilesTruncated?: boolean;
}): ConfigSurfaceChange {
  const counts: ItemContext["counts"] = { comments: 0, timeline: 0 };
  if (options.pullFilesTruncated !== undefined)
    counts.pullFilesTruncated = options.pullFilesTruncated;
  const context: ItemContext = {
    issue: {},
    comments: [],
    timeline: [],
    counts,
  };
  if (options.pullFiles !== undefined) context.pullFiles = options.pullFiles;
  return configSurfaceChangeFromContext(options.repo ?? "openclaw/openclaw", context);
}

export function dataModelChangeFromContext(repo: string, context: ItemContext): DataModelChange {
  if (repo !== "openclaw/openclaw") {
    return { change: false, surfaces: [] };
  }

  const surfaces = new Set<string>();
  for (const entry of context.pullFiles ?? []) {
    const file = asRecord(entry);
    const path = typeof file.filename === "string" ? file.filename.trim() : "";
    const previousPath =
      typeof file.previous_filename === "string" ? file.previous_filename.trim() : "";
    // Scope each rename side before unknown handling, retaining semantic docs
    // while excluding CI definitions that cannot define an OpenClaw data model.
    const candidates = [path, previousPath].filter(isDataModelCandidatePath);
    const patch = typeof file.patch === "string" ? file.patch : null;
    const lines = patch === null ? [] : changedPatchLines(patch);
    const storageContext = dataModelStorageContext(patch ?? "");
    const likelyPath =
      candidates.find(
        (candidate) =>
          isLikelyOpenClawDataModelPath(candidate) ||
          (!isDataModelDocumentationPath(candidate) && storageContext.length > 0),
      ) ?? "";

    if (
      likelyPath &&
      (patch === null || lines.length === 0 || configSurfacePatchIsTruncated(patch))
    ) {
      surfaces.add(dataModelSurfaceLabel(likelyPath, "unknown-data-model-change"));
    }

    for (const candidate of candidates) {
      if (isDataModelDocumentationPath(candidate)) {
        if (patch !== null && !configSurfacePatchIsTruncated(patch)) {
          dataModelSurfacesFromPatch(candidate, lines, { docsOnly: true }).forEach((surface) =>
            surfaces.add(surface),
          );
        }
        continue;
      }
      dataModelSurfacesFromPatch(candidate, lines, { docsOnly: false, patch: patch ?? "" }).forEach(
        (surface) => surfaces.add(surface),
      );
    }
  }

  if (context.counts?.pullFilesTruncated) {
    surfaces.add("unknown-truncated-pull-files");
  }

  return { change: surfaces.size > 0, surfaces: [...surfaces].sort() };
}

export function dataModelChangeFromPullFilesForTest(options: {
  repo?: string;
  pullFiles?: unknown[];
  pullFilesTruncated?: boolean;
}): DataModelChange {
  const counts: ItemContext["counts"] = { comments: 0, timeline: 0 };
  if (options.pullFilesTruncated !== undefined)
    counts.pullFilesTruncated = options.pullFilesTruncated;
  const context: ItemContext = {
    issue: {},
    comments: [],
    timeline: [],
    counts,
  };
  if (options.pullFiles !== undefined) context.pullFiles = options.pullFiles;
  return dataModelChangeFromContext(options.repo ?? "openclaw/openclaw", context);
}

export function sqliteSchemaChangeFromContext(
  repo: string,
  context: ItemContext,
): SqliteSchemaChange {
  if (repo !== "openclaw/openclaw") {
    return { change: false, files: [] };
  }

  const files = new Set<string>();
  for (const entry of context.pullFiles ?? []) {
    const file = asRecord(entry);
    const path = typeof file.filename === "string" ? file.filename.trim() : "";
    const previousPath =
      typeof file.previous_filename === "string" ? file.previous_filename.trim() : "";
    const productionPaths = [path, previousPath].filter(isProductionSourcePath);
    if (productionPaths.length === 0) continue;

    const patch = typeof file.patch === "string" ? file.patch : null;
    const likelySchemaPath = productionPaths.find(isLikelySqliteSchemaPath);
    if (patch === null) {
      if (likelySchemaPath) files.add(path || likelySchemaPath);
      continue;
    }

    const changedLines = changedPatchLines(patch);
    if (
      sqliteSchemaPatchChangesTables(patch, changedLines) ||
      (likelySchemaPath &&
        (configSurfacePatchIsTruncated(patch) || changedLines.some(sqliteSchemaDeclarationLine)))
    ) {
      files.add(path || likelySchemaPath || productionPaths[0]!);
    }
  }

  return { change: files.size > 0, files: [...files].sort() };
}

export function sqliteSchemaChangeFromPullFilesForTest(options: {
  repo?: string;
  pullFiles?: unknown[];
  pullFilesTruncated?: boolean;
}): SqliteSchemaChange {
  const counts: ItemContext["counts"] = { comments: 0, timeline: 0 };
  if (options.pullFilesTruncated !== undefined)
    counts.pullFilesTruncated = options.pullFilesTruncated;
  const context: ItemContext = {
    issue: {},
    comments: [],
    timeline: [],
    counts,
  };
  if (options.pullFiles !== undefined) context.pullFiles = options.pullFiles;
  return sqliteSchemaChangeFromContext(options.repo ?? "openclaw/openclaw", context);
}

function isProductionSourcePath(path: string): boolean {
  if (!path || isDocsPath(path)) return false;
  const segments = path.toLowerCase().split("/");
  if (
    segments.some((segment) =>
      ["__tests__", "example", "examples", "fixture", "fixtures", "test", "tests"].includes(
        segment,
      ),
    )
  ) {
    return false;
  }
  const basename = segments.at(-1) ?? "";
  if (isOpenClawTestRolePath(basename)) return false;
  return ![".spec.", ".test.", ".test-support."].some((marker) => {
    const markerIndex = basename.indexOf(marker);
    return markerIndex >= 0 && markerIndex + marker.length < basename.length;
  });
}

function isDataModelCandidatePath(path: string): boolean {
  return (
    !/^\.github\/workflows\//i.test(path) && (isProductionSourcePath(path) || isDocsPath(path))
  );
}

function sqlitePathOwnerRole(path: string): string {
  return (
    /(?:^|\/)sqlite(?:[-_.][a-z0-9]+)*[-_.](store|schema|codec|user-version)\.[cm]?[jt]sx?$/i
      .exec(path)?.[1]
      ?.toLowerCase() ?? ""
  );
}

function isLikelySqliteSchemaPath(path: string): boolean {
  const role = sqlitePathOwnerRole(path);
  if (role === "codec" || role === "user-version") return false;
  if (role === "store" || role === "schema") return true;
  // A sqlite directory or standalone owner is evidence; sqlite-prefixed
  // diagnostic/helper leaves need a schema/store name or actual patch evidence.
  return /(?:^|\/)migrations?(?:\/|[-_.])|(?:^|\/)sqlite(?:\/|\.[^/.]+$)|(?:sqlite|memory|database|db)[-_.]?schema|schema[-_.]?sqlite|sqlite[-_.]?store|\.sql$/i.test(
    path,
  );
}

function sqliteSchemaPatchChangesTables(patch: string, changedLines: readonly string[]): boolean {
  const changedText = changedLines.join("\n");
  if (
    /\b(?:CREATE|ALTER|DROP)\s+(?:VIRTUAL\s+)?TABLE\b|\bRENAME\s+TABLE\b|\bsqliteTable\s*\(/i.test(
      changedText,
    )
  ) {
    return true;
  }

  // Unchanged table context only applies to declarations changed in its hunk.
  return patch.split(/^@@.*$/m).some((hunk) => {
    const hunkText = hunk
      .split("\n")
      .filter((line) => /^[ +-]/.test(line) && !/^(?:\+\+\+|---)/.test(line))
      .map((line) => line.slice(1))
      .join("\n");
    return (
      /\b(?:CREATE|ALTER)\s+(?:VIRTUAL\s+)?TABLE\b|\bsqliteTable\s*\(/i.test(hunkText) &&
      changedPatchLines(hunk).some(sqliteSchemaDeclarationLine)
    );
  });
}

function sqliteSchemaDeclarationLine(line: string): boolean {
  const text = line.replace(/^[+-]/, "").trim();
  return (
    /\b(?:CREATE|ALTER|DROP)\s+(?:VIRTUAL\s+)?TABLE\b|\bRENAME\s+TABLE\b|\bsqliteTable\s*\(/i.test(
      text,
    ) ||
    /^[`"']?[A-Za-z_][\w$]*[`"']?\s+(?:BLOB|INTEGER|NULL|REAL|TEXT|ANY|NUMERIC)\b/i.test(text) ||
    /^[A-Za-z_$][\w$]*\s*:\s*(?:blob|integer|numeric|real|text)\s*\(/i.test(text)
  );
}

function isOpenClawConfigSurfacePath(path: string): boolean {
  if (isOpenClawTestRolePath(path)) return false;
  return (
    /^src\/config\/(?:zod-schema[^/]*|types[^/]*|schema(?:[-.][^/]*)?)\.ts$/.test(path) ||
    /^src\/plugins\/manifest(?:-registry)?\.ts$/.test(path) ||
    /^docs\/gateway\/configuration[^/]*\.md$/.test(path) ||
    path === "docs/plugins/manifest.md"
  );
}

function changedPatchLines(patch: string): string[] {
  return patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    )
    .map((line) => line.slice(1).trim());
}

function configSurfaceLineNeedsUnknownMarker(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && !/^\/\/|^\/\*|^\*/.test(trimmed);
}

function configSurfacePatchIsTruncated(patch: string): boolean {
  return /\n\n\[truncated \d+ chars\]$/.test(patch);
}

function configSurfaceKeysFromPatchLine(path: string, line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed || /^\/\/|^\/\*|^\*|^<!--/.test(trimmed)) return [];

  const keys = new Set<string>();
  for (const match of trimmed.matchAll(/`([^`]+)`/g)) {
    const token = match[1]?.trim();
    if (token && markdownConfigSurfaceTokenLooksSemantic(path, trimmed, token)) keys.add(token);
  }

  if (!isMarkdownConfigSurfacePath(path)) {
    const property = trimmed.match(
      /^(?:readonly\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$.-]*))\??\s*:/,
    );
    const key = property?.[1] ?? property?.[2] ?? property?.[3];
    if (key && isConfigSurfaceToken(key)) {
      keys.add(pluginManifestConfigSurfaceKey(path, key));
    }

    if (/\b(?:z\.enum|Type\.Literal|enum)\b/.test(trimmed)) {
      for (const match of trimmed.matchAll(/["']([A-Za-z0-9_.-]+)["']/g)) {
        const token = match[1]?.trim();
        if (token && isConfigSurfaceToken(token)) keys.add(token);
      }
    }
  }

  return [...keys];
}

function isMarkdownConfigSurfacePath(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

function markdownConfigSurfaceTokenLooksSemantic(
  path: string,
  line: string,
  token: string,
): boolean {
  if (!isConfigSurfaceToken(token)) return false;
  if (!isMarkdownConfigSurfacePath(path)) return true;
  return /[.[\]]/.test(token) || /^[A-Z0-9_]{3,}$/.test(token) || /^\s*(?:\||[-*]\s+`)/.test(line);
}

function isConfigSurfaceToken(token: string): boolean {
  return (
    token.length >= 2 &&
    token.length <= 120 &&
    /^[A-Za-z0-9_.[\]-]+$/.test(token) &&
    /[A-Za-z]/.test(token)
  );
}

function pluginManifestConfigSurfaceKey(path: string, key: string): string {
  if (!path.startsWith("src/plugins/manifest") || key.includes(".") || key === "contracts") {
    return key;
  }
  return `contracts.${key}`;
}

export function hasDataModelUpgradeProof(text: string): boolean {
  const noMigrationRequiredPattern =
    /\bno\s+(?:data\s+)?migrations?\s+(?:(?:is|are)\s+)?(?:required|needed|necessary)\b/i;
  const negativeProofText = text.replace(
    new RegExp(noMigrationRequiredPattern.source, "gi"),
    "migration unnecessary",
  );
  if (
    /\b(?:missing|lacks?|without|no)\b[^.]{0,120}\b(?:migration|upgrade|backfill|compatibility)\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    /\b(?:migration|upgrade|backfill|compatibility)\b[^.]{0,160}\b(?:proof|test(?:ed|s|ing)?|cover(?:ed|age)?|verif(?:y|ied|ication)|compatib(?:le|ility))\b[^.]{0,120}\b(?:required|needed|missing|todo|before merge)\b/i.test(
      negativeProofText,
    ) ||
    /\b(?:must|should|needs?|requires?|required|needed|todo)\b[^.]{0,120}\b(?:migration|upgrade|backfill|compatibility)\b[^.]{0,160}\b(?:proof|test(?:ed|s|ing)?|cover(?:ed|age)?|verif(?:y|ied|ication)|compatib(?:le|ility))\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    /\b(?:migration|upgrade|backfill|schema version|existing data|existing database|existing cache|existing state)\b[^.]{0,180}\b(?:not|never)\b[^.]{0,80}\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|compatib(?:le|ility)|preserv(?:e|ed|es)|migrat(?:e|ed|es)|backfill(?:ed|s)?)\b/i.test(
      negativeProofText,
    ) ||
    /\b(?:not|never)\b[^.]{0,80}\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|compatib(?:le|ility)|preserv(?:e|ed|es))\b[^.]{0,180}\b(?:migration|upgrade|backfill|schema version|existing data|existing database|existing cache|existing state)\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    /\b(?:should|would|will|expected|intend(?:ed)?|designed|aims?|plans?|promises?)\b[^.]{0,120}\b(?:preserv(?:e|ed|es)|remain(?:s)? compatible|compatib(?:le|ility)|migration|upgrade|backfill)\b/i.test(
      negativeProofText,
    ) ||
    /\b(?:migration|upgrade|backfill|existing data|existing database|existing cache|existing state)\b[^.]{0,120}\b(?:should|would|will|expected|intend(?:ed)?|designed|aims?|plans?|promises?|planned|pending|unimplemented)\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    /\b(?:migration|upgrade|backfill|compatibility)\b[^.]{0,160}\b(?:proof|test(?:ed|s|ing)?|cover(?:ed|age)?|verif(?:y|ied|ication)|compatib(?:le|ility))\b[^.]{0,120}\b(?:is|are|remains?)?\s*(?:planned|pending|future|unimplemented|incomplete|todo|not yet|to be (?:added|done|implemented|verified|tested))\b/i.test(
      negativeProofText,
    ) ||
    /\b(?:planned|pending|future|unimplemented|incomplete|todo|not yet|to be (?:added|done|implemented|verified|tested))\b[^.]{0,120}\b(?:migration|upgrade|backfill|compatibility)\b[^.]{0,160}\b(?:proof|test(?:ed|s|ing)?|cover(?:ed|age)?|verif(?:y|ied|ication)|compatib(?:le|ility))\b/i.test(
      negativeProofText,
    )
  ) {
    return false;
  }
  if (
    noMigrationRequiredPattern.test(text) &&
    /\b(?:existing data|existing database|existing cache|existing state|upgrade compatibility|compatibility)\b[^.]{0,160}\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|compatib(?:le|ility)|preserv(?:e|ed|es))\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return (
    /\b(?:migration|upgrade|backfill|schema version|existing data|existing database|existing cache|existing state)\b[^.]{0,180}\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|compatib(?:le|ility)|preserv(?:e|ed|es)|migrat(?:e|ed|es)|backfill(?:ed|s)?)\b/i.test(
      text,
    ) ||
    /\b(?:test(?:ed|s)?|cover(?:ed|age)?|prov(?:e|ed|en)|verif(?:y|ied)|preserv(?:e|ed|es))\b[^.]{0,180}\b(?:migration|upgrade|backfill|schema version|existing data|existing database|existing cache|existing state)\b/i.test(
      text,
    )
  );
}

function dataModelSurfacesFromPatch(
  path: string,
  lines: readonly string[],
  options: { docsOnly: boolean; patch?: string },
): string[] {
  const text = lines.filter((line) => dataModelLineLooksSemantic(line, options)).join("\n");
  if (!text) return [];

  const surfaces = new Set<string>();
  const add = (surface: string) => surfaces.add(dataModelSurfaceLabel(path, surface));
  const pathHint = dataModelPathHint(path);
  if (
    pathHint &&
    (dataModelTextMatchesPathHint(text, pathHint) || dataModelTextHasJsonConversion(text))
  )
    add(pathHint);
  if (pathHint && dataModelTextLooksLikePersistedShapeField(text, pathHint)) add(pathHint);
  // Storage context establishes changed fields or JSON conversion only within
  // the same hunk, including formatting/argument edits with no field declaration.
  for (const hunk of (options.patch ?? "").split(/^@@.*$/m)) {
    const changedText = changedPatchLines(hunk)
      .filter((line) => dataModelLineLooksSemantic(line, options))
      .join("\n");
    for (const surface of dataModelStorageContext(hunk, Boolean(pathHint))) {
      if (
        dataModelTextLooksLikePersistedShapeField(changedText, surface) ||
        dataModelTextHasJsonConversion(changedText)
      )
        add(surface);
    }
  }
  if (
    /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|COLUMN)\b|\bADD\s+COLUMN\b|\bPRAGMA\s+user_version\b|\bschema[_-]?version\b/i.test(
      text,
    )
  ) {
    add("database schema");
  }
  if (/\b(?:migration|migrate|upgrade|backfill|doctor|repair|reindex|rehydrat\w*)\b/i.test(text)) {
    add("migration/backfill/repair");
  }
  if (
    /\b(?:DurableObject|state\.storage|storage\.(?:get|put|delete|list)|blockConcurrencyWhile)\b/i.test(
      text,
    )
  ) {
    add("durable storage schema");
  }
  if (dataModelTextHasSerializedStateBoundary(text)) {
    add("serialized state");
  }
  if (dataModelTextHasCacheSchema(text)) add("persistent cache schema");
  // Generic metadata and IDs need the storage path or hunk evidence above;
  // those names alone also occur in diagnostics and in-memory values.
  if (
    /\b(?:(?:embedding|vector)[_-]?dimension|similarity[_-]?index|(?:vector|embedding)\s+(?:data\s+)?(?:format|schema|layout|identity|namespace))\b/i.test(
      text,
    )
  ) {
    add("vector/embedding metadata");
  }
  return [...surfaces];
}

function dataModelTextHasJsonConversion(text: string): boolean {
  return /\bJSON\.(?:parse|stringify)\b/i.test(text);
}

function dataModelTextHasSerializedStateBoundary(text: string): boolean {
  // JSON conversion and a variable named "serialized" also occur in transient
  // diagnostics and IPC; neither supplies a storage boundary on its own.
  return (
    /\b(?:readFile(?:Sync)?|writeFile(?:Sync)?|localStorage|sessionStorage|indexedDB|IDBObjectStore|workspaceState|globalState|persisted?|statePath)\b/i.test(
      text,
    ) || /\bserialized\s+(?:data\s+)?(?:format|schema|layout|identity|namespace)\b/i.test(text)
  );
}

function dataModelTextHasCacheSchema(text: string): boolean {
  return /\bcache[_-]?schema\b|\bcache\s+(?:data\s+)?(?:format|schema|layout)\b/i.test(text);
}

function dataModelStorageContext(patch: string, hasPersistenceOwner = false): string[] {
  // Retain nearby storage evidence when only the stored fields change. Hunk
  // headers and comments cannot establish a persistence boundary on their own.
  const text = patch
    .split("\n")
    .filter((line) => /^[ +-]/.test(line) && !/^(?:\+\+\+|---)/.test(line))
    .map((line) => line.slice(1).trim())
    .filter((line) => dataModelLineLooksSemantic(line, { docsOnly: false }))
    .join("\n");
  const surfaces: string[] = [];
  if (
    dataModelTextHasSerializedStateBoundary(text) ||
    (hasPersistenceOwner && dataModelTextHasJsonConversion(text))
  ) {
    surfaces.push("serialized state");
  }
  if (dataModelTextHasCacheSchema(text)) surfaces.push("persistent cache schema");
  if (/\b(?:DurableObject|state\.storage|storage\.(?:get|put|delete|list))\b/i.test(text)) {
    surfaces.push("durable storage schema");
  }
  if (/\b(?:CREATE|ALTER)\s+(?:VIRTUAL\s+)?TABLE\b|\bsqliteTable\s*\(/i.test(text)) {
    surfaces.push("database schema");
  }
  return surfaces;
}

function dataModelLineLooksSemantic(line: string, options: { docsOnly: boolean }): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^\/\/|^\/\*|^\*|^<!--/.test(trimmed)) return false;
  if (!options.docsOnly) return true;
  // Markdown lives beside runtime code too. Words such as "session" or
  // "metadata" describe behavior, not necessarily a changed stored contract.
  return (
    /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|COLUMN)\b|\bPRAGMA\s+user_version\b/i.test(
      trimmed,
    ) ||
    /^["'`]?(?:schema[_-]?version|cache[_-]?(?:key|version|schema|namespace)|embedding[_-]?dimension|vector[_-]?dimension|row[_-]?id|document[_-]?id|chunk[_-]?id)["'`]?\s*:/i.test(
      trimmed,
    ) ||
    /\b(?:serialized|persisted|storage|database|cache|vector|embedding)\s+(?:data\s+)?(?:format|schema|layout|identity|namespace)\b/i.test(
      trimmed,
    )
  );
}

function isLikelyOpenClawDataModelPath(path: string): boolean {
  if (!path || isDocsPath(path)) return false;
  if (isMarkdownConfigSurfacePath(path)) return /(?:^|\/)HOOK\.md$/.test(path);
  return Boolean(dataModelPathHint(path)) || /\.(?:sql|sqlite|db|prisma)$/.test(path);
}

function isDataModelDocumentationPath(path: string): boolean {
  return isDocsPath(path) || isMarkdownConfigSurfacePath(path);
}

function dataModelPathHint(path: string): string {
  const sqliteRole = sqlitePathOwnerRole(path);
  if (sqliteRole === "codec") return "serialized state";
  if (sqliteRole === "user-version") return "database schema";
  if (/(^|\/)(?:durable-?objects?|storage)(?:\/|[-_.])|durable-?object|state-storage/i.test(path)) {
    return "durable storage schema";
  }
  if (/(?:^|\/)caches?\/schema(?:\/|[-_.])|cache[-_.]schema/i.test(path)) {
    return "persistent cache schema";
  }
  if (/(^|\/)persistence(?:\/|[-_.])|(?:serialized|persisted?)[-_.]?(?:state|json)/i.test(path)) {
    return "serialized state";
  }
  if (/vector|embedding|(?:^|\/)memory(?:\/|[-_.])/i.test(path)) {
    return "vector/embedding metadata";
  }
  if (
    /(^|\/)(?:migrations?|backfill|doctor|repair|upgrade)(?:\/|[-_.])|(?:migration|backfill|doctor|repair|upgrade)\.(?:ts|js)$/i.test(
      path,
    )
  ) {
    return "migration/backfill/repair";
  }
  if (
    isLikelySqliteSchemaPath(path) ||
    /(^|\/)(?:migrations?|schema|database|db|sql)(?:\/|[-_.])|(?:schema|migration|ddl|prisma)\.(?:ts|js|sql|prisma)$/i.test(
      path,
    )
  ) {
    return "database schema";
  }
  return "";
}

function dataModelTextMatchesPathHint(text: string, pathHint: string): boolean {
  switch (pathHint) {
    case "database schema":
      return (
        /\b(?:migration|migrate|schema[_-]?version|user_version|CREATE|ALTER|DROP)\b/i.test(text) ||
        /\b(?:sqliteTable|pgTable|mysqlTable|defineTable|createTable|createIndex|table|column|index|primaryKey|foreignKey|uniqueIndex)\b/i.test(
          text,
        )
      );
    case "durable storage schema":
      return /\b(?:DurableObject|storage|schema|migration|state)\b/i.test(text);
    case "persistent cache schema":
      return /\b(?:cache|schema|key|version|namespace|ttl)\b/i.test(text);
    case "serialized state":
      return /\b(?:JSON|serialized|persisted?|state|session|history|schema|version)\b/i.test(text);
    case "vector/embedding metadata":
      return /\b(?:embedding|vector|collection|dimension|metadata|row[_-]?id|document[_-]?id|chunk[_-]?id|schema|version)\b/i.test(
        text,
      );
    case "migration/backfill/repair":
      return /\b(?:migration|migrate|upgrade|backfill\w*|doctor|repair|schema|version|existing data|INSERT|UPDATE|DELETE)\b/i.test(
        text,
      );
    default:
      return false;
  }
}

function dataModelTextLooksLikePersistedShapeField(text: string, pathHint: string): boolean {
  if (pathHint === "database schema") {
    return (
      text.split("\n").some(sqliteSchemaDeclarationLine) ||
      /\b[$A-Z_a-z][$\w]*\??\s*:\s*(?:bigint|blob|boolean|bool|datetime|integer|int|jsonb?|numeric|real|serial|sqliteTable|text|timestamp|uuid|varchar)\s*\(/i.test(
        text,
      ) ||
      /\b(?:bigint|blob|boolean|bool|datetime|integer|int|jsonb?|numeric|real|serial|text|timestamp|uuid|varchar)\s*\(\s*["'`][^"'`]+["'`]/i.test(
        text,
      )
    );
  }

  return /(?:^|[{};,]\s*)(?:readonly\s+)?(?:["'][^"']+["']|[$A-Z_a-z][$\w]*)\??\s*:\s*\S/m.test(
    text,
  );
}

function dataModelSurfaceLabel(path: string, surface: string): string {
  return `${surface}: ${path}`;
}

export function isDocsPath(file: string): boolean {
  return file.startsWith("docs/");
}
