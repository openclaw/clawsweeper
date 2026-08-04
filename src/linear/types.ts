export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearProject {
  id: string;
  name: string;
  teamId: string;
  state: string | null;
}

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearAttachment {
  id: string;
  url: string;
  title: string;
}

export interface LinearCreator {
  id: string;
  name: string;
  admin: boolean;
  owner: boolean;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  teamId: string;
  projectId: string | null;
  stateId: string | null;
  stateName: string | null;
  stateType: string | null;
  priority: number;
  labels: LinearLabel[];
}

export interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface LinearConnection<T> {
  nodes: T[];
  pageInfo: LinearPageInfo;
}

export interface ListIssuesOptions {
  teamId: string;
  updatedAfter?: string;
  pageSize?: number;
}

export interface WorkspaceSweepOptions {
  updatedAfter?: string;
  pageSize?: number;
}

export interface WorkspaceItem {
  team: LinearTeam;
  project: LinearProject | null;
  issue: LinearIssue;
}

/**
 * A single workspace item hydrated with the issue's current comments and analysis context —
 * produced by the by-identifier fetch so comment planning and analysis share one consistent
 * read (no separate source-context fetch and no pagination drift).
 */
export interface HydratedWorkspaceItem extends WorkspaceItem {
  comments: Array<{
    id: string;
    body: string;
    authorId: string | null;
    authorName: string | null;
  }>;
  description: string;
  attachments: LinearAttachment[];
  creator: LinearCreator | null;
}
