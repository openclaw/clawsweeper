// GraphQL queries for the Linear read-only item source.
// All queries use cursor-based pagination via pageInfo { hasNextPage endCursor }.

export const TEAMS_QUERY = `
  query ListTeams($first: Int!, $after: String) {
    teams(first: $first, after: $after) {
      nodes {
        id
        key
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const PROJECTS_QUERY = `
  query ListProjects($teamId: String!, $first: Int!, $after: String) {
    team(id: $teamId) {
      projects(first: $first, after: $after) {
        nodes {
          id
          name
          state
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// Issues are filtered by team and optionally by updatedAt, ordered by updatedAt
// for efficient incremental sweeps (only process what changed since last run).
export const ISSUES_QUERY = `
  query ListIssues($teamId: ID!, $updatedAfter: DateComparator, $first: Int!, $after: String) {
    issues(
      first: $first
      after: $after
      orderBy: updatedAt
      filter: {
        team: { id: { eq: $teamId } }
        updatedAt: $updatedAfter
      }
    ) {
      nodes {
        id
        identifier
        title
        url
        createdAt
        updatedAt
        priority
        team {
          id
        }
        project {
          id
        }
        state {
          id
          name
          type
        }
        labels(first: 250) {
          nodes {
            id
            name
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Fetch a single issue by its human identifier (team key + number, e.g. "PAR-244"),
// scoped to one team. Hydrates comments plus analysis context in the SAME read pass so a
// comment upsert or source analysis can be planned without pagination drift. Returns at most
// one node. Attachments are bounded; the source fails closed rather than analyze truncation.
export const ISSUE_BY_IDENTIFIER_QUERY = `
  query IssueByIdentifier(
    $teamKey: String!
    $number: Float!
    $first: Int!
    $after: String
    $commentFirst: Int!
    $commentAfter: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        team: { key: { eq: $teamKey } }
        number: { eq: $number }
      }
    ) {
      nodes {
        id
        identifier
        title
        description
        url
        createdAt
        updatedAt
        priority
        creator {
          id
          name
          admin
          owner
        }
        team {
          id
          key
          name
        }
        project {
          id
          name
          state
        }
        state {
          id
          name
          type
        }
        labels(first: 250) {
          nodes {
            id
            name
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        attachments(first: 250) {
          nodes {
            id
            url
            title
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        comments(first: $commentFirst, after: $commentAfter, orderBy: createdAt) {
          nodes {
            id
            body
            createdAt
            botActor {
              id
              name
            }
            user {
              id
              name
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// --- Label read + write surface (additive label application) -----------------------------
// These power the label-application path: a paginated workspace-label lookup (resolve a
// routing-label NAME to its id), a create for a missing label, and an additive labelIds
// write. All writes are gated in authority.ts; these are just the GraphQL strings.

// Paginated list of every workspace label (id + name), for name→id resolution.
export const ISSUE_LABELS_QUERY = `
  query ($after: String) {
    issueLabels(first: 250, after: $after) {
      nodes {
        id
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// Creates a workspace label by name (used only to mint a missing clawsweeper:* routing label
// on a live --apply-labels run). Returns the created label's id + name.
export const ISSUE_LABEL_CREATE_MUTATION = `
  mutation ($name: String!) {
    issueLabelCreate(input: { name: $name }) {
      success
      issueLabel {
        id
        name
      }
    }
  }
`;

// Additive label write. Linear's issueUpdate replaces the full labelIds array, so the caller
// must send the union of existing ∪ additions (read-merge-write); authority.ts rejects any
// write that would drop an existing label.
export const ISSUE_SET_LABELS_MUTATION = `
  mutation ($id: String!, $labelIds: [String!]!) {
    issueUpdate(id: $id, input: { labelIds: $labelIds }) {
      success
      issue {
        id
        labels(first: 250) {
          nodes {
            id
            name
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;
