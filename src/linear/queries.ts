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

// Deterministic label-settlement primitives retained for future reviewed settlement work.
// The production Linear transport is read-only and rejects these mutations before fetch.
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
