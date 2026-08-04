import type { LinearTransport } from "./client.js";
import { ISSUE_BY_IDENTIFIER_QUERY, ISSUES_QUERY, PROJECTS_QUERY, TEAMS_QUERY } from "./queries.js";
import type {
  LinearAttachment,
  HydratedWorkspaceItem,
  LinearConnection,
  LinearIssue,
  LinearLabel,
  LinearProject,
  LinearTeam,
  ListIssuesOptions,
  WorkspaceItem,
  WorkspaceSweepOptions,
} from "./types.js";

/** Parsed pieces of a Linear human identifier such as "PAR-244". */
export interface ParsedIdentifier {
  teamKey: string;
  number: number;
}

/**
 * Parses a Linear human identifier "TEAM-123" into its team key and issue number.
 * Throws a clear error for anything that is not a `<KEY>-<number>` shape.
 */
export function parseLinearIdentifier(identifier: string): ParsedIdentifier {
  const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(identifier.trim());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(
      `invalid Linear identifier "${identifier}" — expected a "<TEAM>-<number>" form like "PAR-244"`,
    );
  }
  return { teamKey: match[1].toUpperCase(), number: Number(match[2]) };
}

// Narrowing helpers — Linear GraphQL data is untyped `unknown` from the transport.

function asConnection<T>(value: unknown, queryName: string): LinearConnection<T> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Malformed connection from ${queryName}: expected { nodes, pageInfo }`);
  }
  const connection = value as Record<string, unknown>;
  const pageInfo = connection["pageInfo"];
  if (!Array.isArray(connection["nodes"]) || typeof pageInfo !== "object" || pageInfo === null) {
    throw new Error(`Malformed connection from ${queryName}: expected { nodes, pageInfo }`);
  }
  const page = pageInfo as Record<string, unknown>;
  if (
    typeof page["hasNextPage"] !== "boolean" ||
    (page["endCursor"] !== null && typeof page["endCursor"] !== "string")
  ) {
    throw new Error(
      `Malformed connection from ${queryName}: expected pageInfo { hasNextPage, endCursor }`,
    );
  }
  return {
    nodes: connection["nodes"] as T[],
    pageInfo: {
      hasNextPage: page["hasNextPage"],
      endCursor: page["endCursor"],
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) return {};
  return value as Record<string, unknown>;
}

function requiredRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Malformed ${context}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  context: string,
  nonEmpty = false,
): string {
  const value = record[key];
  if (typeof value !== "string" || (nonEmpty && value.trim() === "")) {
    throw new Error(`Malformed ${context}: expected ${nonEmpty ? "non-empty " : ""}string ${key}`);
  }
  return value;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function nextPageCursor(
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
  seen: Set<string>,
  context: string,
): string | null {
  if (!pageInfo.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== "string" || cursor.trim() === "") {
    throw new Error(`${context} returned hasNextPage without a usable endCursor`);
  }
  if (seen.has(cursor)) {
    throw new Error(`${context} repeated endCursor "${cursor}"`);
  }
  seen.add(cursor);
  return cursor;
}

// Shared cursor-based pagination loop. Calls `extract` on each page's data object
// to get the connection, maps each node with `map`, and yields results.
async function* paginate<TRaw, TOut>(
  transport: LinearTransport,
  query: string,
  baseVars: Record<string, unknown>,
  extract: (data: unknown) => LinearConnection<TRaw>,
  map: (raw: TRaw) => TOut,
  pageSize: number,
): AsyncGenerator<TOut> {
  let after: string | undefined;
  const seenCursors = new Set<string>();

  while (true) {
    const vars: Record<string, unknown> = { ...baseVars, first: pageSize };
    if (after != null) vars["after"] = after;

    const data = await transport(query, vars);
    const connection = extract(data);

    for (const node of connection.nodes) {
      yield map(node);
    }

    const nextCursor = nextPageCursor(connection.pageInfo, seenCursors, "Linear pagination");
    if (nextCursor === null) break;
    after = nextCursor;
  }
}

function mapTeam(raw: unknown): LinearTeam {
  const r = asRecord(raw);
  return { id: str(r["id"]), key: str(r["key"]), name: str(r["name"]) };
}

function mapProject(raw: unknown, teamId: string): LinearProject {
  const r = asRecord(raw);
  return {
    id: str(r["id"]),
    name: str(r["name"]),
    teamId,
    state: strOrNull(r["state"]),
  };
}

function mapLabels(raw: unknown): LinearLabel[] {
  const labels = asConnection<unknown>(raw, "Issue labels");
  if (labels.pageInfo.hasNextPage) {
    throw new Error("issue has more than 250 labels; refusing to use a truncated label set");
  }
  return labels.nodes.map((n) => {
    const ln = requiredRecord(n, "Issue labels node");
    return {
      id: requiredString(ln, "id", "Issue labels node", true),
      name: requiredString(ln, "name", "Issue labels node", true),
    };
  });
}

function mapComments(raw: unknown): Array<{
  id: string;
  body: string;
  createdAt: string;
  authorId: string | null;
  authorName: string | null;
}> {
  const comments = asConnection<unknown>(raw, "IssueByIdentifier.comments");
  return comments.nodes.map((n) => {
    const cn = requiredRecord(n, "Issue comments node");
    const botActor =
      cn["botActor"] == null ? null : requiredRecord(cn["botActor"], "Issue comment botActor");
    const user = cn["user"] == null ? null : requiredRecord(cn["user"], "Issue comment user");
    const actor = botActor ?? user;
    return {
      id: requiredString(cn, "id", "Issue comments node", true),
      body: requiredString(cn, "body", "Issue comments node"),
      createdAt: requiredString(cn, "createdAt", "Issue comments node", true),
      authorId: actor === null ? null : requiredString(actor, "id", "Issue comment actor", true),
      authorName:
        actor === null ? null : requiredString(actor, "name", "Issue comment actor", true),
    };
  });
}

function mapAttachments(raw: unknown): LinearAttachment[] {
  const attachments = asConnection<unknown>(raw, "IssueByIdentifier.attachments");
  if (attachments.pageInfo.hasNextPage) {
    throw new Error(
      "IssueByIdentifier returned more than 250 attachments — refusing to analyze incomplete context",
    );
  }
  return attachments.nodes.map((node) => {
    const attachment = requiredRecord(node, "Issue attachments node");
    return {
      id: requiredString(attachment, "id", "Issue attachments node", true),
      url: requiredString(attachment, "url", "Issue attachments node", true),
      title: requiredString(attachment, "title", "Issue attachments node"),
    };
  });
}

function commentPageInfo(raw: unknown): { hasNextPage: boolean; endCursor: string | null } {
  return asConnection<unknown>(raw, "IssueByIdentifier.comments").pageInfo;
}

function hydratedIssueFingerprint(item: HydratedWorkspaceItem): string {
  return JSON.stringify({
    team: item.team,
    project: item.project,
    issue: item.issue,
    description: item.description,
    attachments: item.attachments,
    creator: item.creator,
  });
}

function mapIssue(raw: unknown): LinearIssue {
  const r = asRecord(raw);
  const team = asRecord(r["team"]);
  const project = r["project"] != null ? asRecord(r["project"]) : null;
  const state = r["state"] != null ? asRecord(r["state"]) : null;
  return {
    id: str(r["id"]),
    identifier: str(r["identifier"]),
    title: str(r["title"]),
    url: str(r["url"]),
    createdAt: str(r["createdAt"]),
    updatedAt: str(r["updatedAt"]),
    priority: num(r["priority"]),
    teamId: str(team["id"]),
    projectId: project != null ? strOrNull(project["id"]) : null,
    stateId: state != null ? strOrNull(state["id"]) : null,
    stateName: state != null ? strOrNull(state["name"]) : null,
    stateType: state != null ? strOrNull(state["type"]) : null,
    labels: mapLabels(r["labels"]),
  };
}

// Maps the hydrated issue node from ISSUE_BY_IDENTIFIER_QUERY into a WorkspaceItem plus
// its current comments. Unlike mapIssue, this node carries full team and project fields.
function mapHydratedItem(raw: unknown): HydratedWorkspaceItem {
  const r = asRecord(raw);
  const issue = mapIssue(raw);

  const teamRaw = asRecord(r["team"]);
  const team: LinearTeam = {
    id: str(teamRaw["id"]),
    key: str(teamRaw["key"]),
    name: str(teamRaw["name"]),
  };

  const project = r["project"] != null ? mapProject(r["project"], team.id) : null;

  const comments = mapComments(r["comments"]);
  const creatorRaw = r["creator"] != null ? asRecord(r["creator"]) : null;
  const creator =
    creatorRaw === null
      ? null
      : {
          id: str(creatorRaw["id"]),
          name: str(creatorRaw["name"]),
          admin: creatorRaw["admin"] === true,
          owner: creatorRaw["owner"] === true,
        };

  return {
    team,
    project,
    issue,
    comments,
    description: str(r["description"]),
    attachments: mapAttachments(r["attachments"]),
    creator,
  };
}

export class LinearItemSource {
  constructor(private transport: LinearTransport) {}

  async *iterateTeams(pageSize = 250): AsyncGenerator<LinearTeam> {
    yield* paginate(
      this.transport,
      TEAMS_QUERY,
      {},
      (data) => asConnection<unknown>(asRecord(data)["teams"], "ListTeams"),
      mapTeam,
      pageSize,
    );
  }

  async *iterateProjects(teamId: string, pageSize = 250): AsyncGenerator<LinearProject> {
    yield* paginate(
      this.transport,
      PROJECTS_QUERY,
      { teamId },
      (data) => {
        const team = asRecord(asRecord(data)["team"]);
        return asConnection<unknown>(team["projects"], "ListProjects");
      },
      (raw) => mapProject(raw, teamId),
      pageSize,
    );
  }

  async *iterateIssues(options: ListIssuesOptions): AsyncGenerator<LinearIssue> {
    const { teamId, updatedAfter, pageSize = 250 } = options;
    // Build the updatedAt filter only when a date is provided.
    const vars: Record<string, unknown> = { teamId };
    if (updatedAfter != null) {
      vars["updatedAfter"] = { gt: updatedAfter };
    }
    yield* paginate(
      this.transport,
      ISSUES_QUERY,
      vars,
      (data) => asConnection<unknown>(asRecord(data)["issues"], "ListIssues"),
      mapIssue,
      pageSize,
    );
  }

  async listTeams(pageSize?: number): Promise<LinearTeam[]> {
    const results: LinearTeam[] = [];
    for await (const team of this.iterateTeams(pageSize)) results.push(team);
    return results;
  }

  async listProjects(teamId: string, pageSize?: number): Promise<LinearProject[]> {
    const results: LinearProject[] = [];
    for await (const project of this.iterateProjects(teamId, pageSize)) results.push(project);
    return results;
  }

  async listIssues(options: ListIssuesOptions): Promise<LinearIssue[]> {
    const results: LinearIssue[] = [];
    for await (const issue of this.iterateIssues(options)) results.push(issue);
    return results;
  }

  async *iterateWorkspaceItems(options?: WorkspaceSweepOptions): AsyncGenerator<WorkspaceItem> {
    const { updatedAfter, pageSize } = options ?? {};
    for await (const team of this.iterateTeams(pageSize)) {
      const projects = await this.listProjects(team.id, pageSize);
      const projectMap = new Map<string, LinearProject>(projects.map((p) => [p.id, p]));
      // Build issue options, omitting optional keys when undefined (exactOptionalPropertyTypes).
      const issueOpts: ListIssuesOptions = { teamId: team.id };
      if (updatedAfter !== undefined) issueOpts.updatedAfter = updatedAfter;
      if (pageSize !== undefined) issueOpts.pageSize = pageSize;
      for await (const issue of this.iterateIssues(issueOpts)) {
        const project = issue.projectId != null ? (projectMap.get(issue.projectId) ?? null) : null;
        yield { team, project, issue };
      }
    }
  }

  async listWorkspaceItems(options?: WorkspaceSweepOptions): Promise<WorkspaceItem[]> {
    const results: WorkspaceItem[] = [];
    for await (const item of this.iterateWorkspaceItems(options)) results.push(item);
    return results;
  }

  /**
   * Fetches exactly one issue by its human identifier (e.g. "PAR-244"), hydrated with the
   * issue's current comments in the same read pass. Returns null when no issue matches.
   * Used by the single-item comment-apply path so plan + drift are computed against one
   * consistent read (no comment/snapshot drift).
   */
  async fetchIssueByIdentifier(
    identifier: string,
    commentPageSize = 100,
  ): Promise<HydratedWorkspaceItem | null> {
    const { teamKey, number } = parseLinearIdentifier(identifier);
    let commentAfter: string | undefined;
    let hydrated: HydratedWorkspaceItem | null = null;
    let issueFingerprint: string | null = null;
    const comments: HydratedWorkspaceItem["comments"] = [];
    const seenCommentCursors = new Set<string>();

    while (true) {
      const vars: Record<string, unknown> = {
        teamKey,
        number,
        first: 1,
        commentFirst: commentPageSize,
      };
      if (commentAfter != null) vars["commentAfter"] = commentAfter;

      const data = await this.transport(ISSUE_BY_IDENTIFIER_QUERY, vars);
      const connection = asConnection<unknown>(asRecord(data)["issues"], "IssueByIdentifier");
      const [node] = connection.nodes;
      if (node === undefined) return null;

      const issue = asRecord(node);
      comments.push(...mapComments(issue["comments"]));
      const pageHydrated = mapHydratedItem(node);
      const pageIssueFingerprint = hydratedIssueFingerprint(pageHydrated);
      if (hydrated === null) {
        hydrated = pageHydrated;
        issueFingerprint = pageIssueFingerprint;
      } else if (pageIssueFingerprint !== issueFingerprint) {
        throw new Error(
          `IssueByIdentifier ${identifier} changed while paginating comments — retry from a fresh snapshot`,
        );
      }

      const pageInfo = commentPageInfo(issue["comments"]);
      const nextCursor = nextPageCursor(
        pageInfo,
        seenCommentCursors,
        `IssueByIdentifier ${identifier} comment pagination`,
      );
      if (nextCursor === null) break;
      commentAfter = nextCursor;
    }

    return hydrated === null ? null : { ...hydrated, comments };
  }
}
