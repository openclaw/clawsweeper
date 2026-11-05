// Test-only decoder for generated inline count/inventory queries. No variables,
// named fragments or directives. Only the generated ReopenedEvent inline fragment
// is supported; unknown shapes fail instead of awarding extra fields.
export type FixtureField = {
  name: string;
  alias: string;
  args: Record<string, unknown>;
  children: FixtureField[];
};
export function fixtureQuery(query: string) {
  const tokens: string[] = [],
    token =
      /\s+|#[^\r\n]*|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|[_A-Za-z][_0-9A-Za-z]*|\.\.\.|[{}()[\]:,]/y;
  let offset = 0;
  while (offset < query.length) {
    token.lastIndex = offset;
    const m = token.exec(query);
    if (!m) throw new Error("unsupported fixture query token");
    offset = token.lastIndex;
    if (!/^\s|^#|^,$/.test(m[0])) tokens.push(m[0]);
  }
  let at = 0;
  const take = (expected?: string) => {
    const v = tokens[at++];
    if (v === undefined || (expected !== undefined && v !== expected))
      throw new Error("unexpected fixture selection");
    return v;
  };
  const value = (): unknown => {
    if (tokens[at] === "{") {
      take("{");
      const out: Record<string, unknown> = {};
      while (tokens[at] !== "}") {
        const k = take();
        take(":");
        if (k in out) throw new Error("duplicate fixture object key");
        out[k] = value();
      }
      take("}");
      return out;
    }
    if (tokens[at] === "[") {
      take("[");
      const out: unknown[] = [];
      while (tokens[at] !== "]") out.push(value());
      take("]");
      return out;
    }
    const v = take();
    if (v.startsWith('"')) return JSON.parse(v);
    if (v === "null") return null;
    if (v === "true" || v === "false") return v === "true";
    if (/^-?\d/.test(v)) return Number(v);
    return v;
  };
  const fields = (): FixtureField[] => {
    take("{");
    const out: FixtureField[] = [];
    while (tokens[at] !== "}") {
      if (tokens[at] === "...") {
        take("...");
        take("on");
        take("ReopenedEvent");
        out.push(...fields());
        continue;
      }
      let name = take(),
        alias = name;
      if (tokens[at] === ":") {
        take(":");
        name = take();
      }
      const args: Record<string, unknown> = {};
      if (tokens[at] === "(") {
        take("(");
        while (tokens[at] !== ")") {
          const k = take();
          take(":");
          if (k in args) throw new Error("duplicate fixture argument");
          args[k] = value();
        }
        take(")");
      }
      out.push({ name, alias, args, children: tokens[at] === "{" ? fields() : [] });
    }
    take("}");
    return out;
  };
  take("query");
  const operation = take(),
    selection = fields();
  if (at !== tokens.length) throw new Error("trailing fixture query");
  return { operation, selection };
}
export function projectFixtureFields(fields: FixtureField[], source: unknown): unknown {
  if (source === null) return null;
  if (Array.isArray(source)) return source.map((x) => projectFixtureFields(fields, x));
  if (typeof source !== "object" || source === null)
    throw new Error("fixture object selection mismatch");
  const record = source as Record<string, unknown>,
    out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!(f.name in record)) throw new Error("unknown fixture field: " + f.name);
    out[f.alias] = f.children.length
      ? projectFixtureFields(f.children, record[f.name])
      : record[f.name];
  }
  return out;
}
export function fleetCoverageSelections(query: string) {
  const q = fixtureQuery(query);
  if (q.operation !== "FleetCoverage") throw new Error("not a FleetCoverage count query");
  const aliases = new Set<string>();
  return q.selection.map((root) => {
    if (
      root.name !== "repository" ||
      aliases.has(root.alias) ||
      Object.keys(root.args).sort().join(",") !== "name,owner" ||
      typeof root.args.owner !== "string" ||
      typeof root.args.name !== "string"
    )
      throw new Error("unsupported FleetCoverage repository selection");
    aliases.add(root.alias);
    const selected = new Set<string>();
    for (const f of root.children) {
      if (selected.has(f.name) || f.alias !== f.name)
        throw new Error("duplicate or aliased FleetCoverage child");
      selected.add(f.name);
      if (f.name === "id") {
        if (Object.keys(f.args).length || f.children.length)
          throw new Error("non-scalar repository id");
      } else if (f.name === "issues" || f.name === "pullRequests") {
        if (
          Object.keys(f.args).join(",") !== "states" ||
          f.args.states !== "OPEN" ||
          f.children.length !== 1 ||
          f.children[0]!.name !== "totalCount" ||
          f.children[0]!.alias !== "totalCount" ||
          f.children[0]!.children.length ||
          Object.keys(f.children[0]!.args).length
        )
          throw new Error("unsupported FleetCoverage count selection");
      } else throw new Error("unrecognized FleetCoverage child");
    }
    return {
      alias: root.alias,
      owner: root.args.owner,
      name: root.args.name,
      fields: [...selected],
    };
  });
}
export function fleetCoverageResponse(
  query: string,
  lookup: (owner: string, name: string) => { id?: unknown; issues: number; pulls: number } | null,
) {
  return {
    data: Object.fromEntries(
      fleetCoverageSelections(query).map((s) => {
        const r = lookup(s.owner, s.name);
        if (!r) return [s.alias, null];
        const value: Record<string, unknown> = {};
        for (const f of s.fields) {
          if (f === "id") value.id = r.id;
          else if (f === "issues") value.issues = { totalCount: r.issues };
          else if (f === "pullRequests") value.pullRequests = { totalCount: r.pulls };
        }
        return [s.alias, value];
      }),
    ),
  };
}
