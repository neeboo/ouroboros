import { readFile } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import type { Harness } from "@ouroboros/harness";

export interface LinearCheckInput {
  harness: Harness;
  runId?: string | null;
  projectUrl?: string | null;
  projectId?: string | null;
  teamKey?: string | null;
  tokenFile?: string | null;
  tokenEnv?: string | null;
  apiUrl?: string | null;
}

export interface LinearIssueLinkInput {
  harness: Harness;
  localType: string;
  localId: string;
  issueId?: string | null;
  issueKey?: string | null;
  issueUrl?: string | null;
}

export interface LinearIngestEventInput {
  harness: Harness;
  eventType: string;
  externalId: string;
  payloadJson: string;
}

export interface LinearCreateIssueInput extends LinearCheckInput {
  title: string;
  description?: string | null;
}

interface LinearProject {
  id: string;
  name: string;
  slugId: string | null;
  url: string | null;
  teams: {
    nodes: Array<{
      id: string;
      key: string;
      name: string;
    }>;
  };
}

interface LinearGraphqlResponse<T> {
  data?: T;
  errors?: unknown[];
}

export async function checkLinearAccess(input: LinearCheckInput) {
  const tokenSource = await readLinearToken({ tokenFile: input.tokenFile, tokenEnv: input.tokenEnv });
  const apiUrl = input.apiUrl ?? "https://api.linear.app/graphql";
  const data = await linearGraphql<{ viewer: { id: string; name: string; email: string }; projects: { nodes: LinearProject[] } }>({
    apiUrl,
    token: tokenSource.token,
    query: `
      query OuroborosLinearAccess {
        viewer { id name email }
        projects(first: 100) {
          nodes {
            id
            name
            slugId
            url
            teams { nodes { id key name } }
          }
        }
      }
    `,
  });
  const project = findProject(data.projects.nodes, {
    projectId: input.projectId,
    projectUrl: input.projectUrl,
  });
  if (!project) {
    throw new Error(`Linear project not found: ${input.projectUrl ?? input.projectId ?? "missing project selector"}`);
  }
  const team = input.teamKey
    ? (project.teams.nodes.find((candidate) => candidate.key === input.teamKey) ?? null)
    : (project.teams.nodes[0] ?? null);
  if (!team) {
    throw new Error(`Linear project has no matching team: ${input.teamKey ?? project.name}`);
  }

  let externalRef = null;
  if (input.runId) {
    if (!input.harness.getRun(input.runId)) {
      throw new Error(`run not found: ${input.runId}`);
    }
    externalRef = ensureRunProjectRef(input.harness, {
      runId: input.runId,
      project,
      projectExternalId: input.projectId ?? project.slugId ?? project.id,
    });
  }

  return {
    status: "ok",
    tokenSource: tokenSource.source,
    viewer: {
      id: data.viewer.id,
      name: data.viewer.name,
      email: data.viewer.email,
    },
    project: {
      id: project.id,
      name: project.name,
      slugId: project.slugId,
      url: project.url,
    },
    team: {
      id: team.id,
      key: team.key,
      name: team.name,
    },
    externalRef,
  };
}

export async function createLinearIssue(input: LinearCreateIssueInput) {
  const title = input.title.trim();
  if (!title) {
    throw new Error("Linear issue title is required");
  }
  const scope = await checkLinearAccess({ ...input, runId: null });
  const tokenSource = await readLinearToken({ tokenFile: input.tokenFile, tokenEnv: input.tokenEnv });
  const apiUrl = input.apiUrl ?? "https://api.linear.app/graphql";
  const data = await linearGraphql<{
    issueCreate: {
      success: boolean;
      issue: {
        id: string;
        identifier: string;
        title: string;
        url: string | null;
        createdAt: string;
        project: { id: string } | null;
        team: { id: string; key: string };
      } | null;
    };
  }>({
    apiUrl,
    token: tokenSource.token,
    query: `
      mutation CreateOuroborosDogfoodIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            identifier
            title
            url
            createdAt
            project { id }
            team { id key }
          }
        }
      }
    `,
    variables: {
      input: {
        title,
        description: input.description?.trim() || null,
        teamId: scope.team.id,
        projectId: scope.project.id,
      },
    },
  });
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error("Linear issue creation returned no issue");
  }
  return {
    status: "created" as const,
    tokenSource: tokenSource.source,
    project: scope.project,
    team: scope.team,
    issue: data.issueCreate.issue,
  };
}

type LinearWriteFailureStatus =
  | "config_error"
  | "auth_failure"
  | "permission_denied"
  | "graphql_error"
  | "transient_failure"
  | "issue_not_found"
  | "scope_mismatch"
  | "mutation_failed"
  | "readback_mismatch"
  | "idempotency_conflict"
  | "pagination_limit"
  | "state_name_unknown"
  | "state_name_ambiguous";

const LINEAR_STATE_NAME_MAX_CHARS = 200;

interface LinearWriteRequestResult<T> {
  ok: boolean;
  data: T | null;
  status: LinearWriteFailureStatus | null;
  error: string | null;
}

export interface LinearUpdateStatusInput {
  issueId: string;
  stateId?: string | null;
  stateName?: string | null;
  teamKey?: string | null;
  tokenFile?: string | null;
  tokenEnv?: string | null;
  apiUrl?: string | null;
  fetchImpl?: typeof fetch;
}

interface LinearWritebackTeamRef {
  id: string;
  key: string;
}

interface LinearWritebackStateRef {
  id: string;
  name: string;
  type?: string | null;
}

interface LinearWritebackIssueRef {
  id: string;
  identifier: string;
  team: LinearWritebackTeamRef;
  state: LinearWritebackStateRef | null;
}

const LINEAR_STATUS_SCOPE_QUERY = `
  query OuroborosLinearStatusScope($issueId: String!, $stateId: String!) {
    issue(id: $issueId) {
      id
      identifier
      team { id key }
      state { id name type }
    }
    workflowState(id: $stateId) {
      id
      name
      type
      team { id key }
    }
  }
`;

const LINEAR_STATUS_NAME_SCOPE_QUERY = `
  query OuroborosLinearStatusNameResolve($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      team {
        id
        key
        states(first: 100) {
          nodes { id name type }
        }
      }
      state { id name type }
    }
  }
`;

const LINEAR_STATUS_UPDATE_MUTATION = `
  mutation OuroborosLinearStatusUpdate($issueId: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $issueId, input: $input) {
      success
      issue {
        id
        identifier
        team { id key }
        state { id name type }
      }
    }
  }
`;

const LINEAR_STATUS_READBACK_QUERY = `
  query OuroborosLinearStatusReadback($issueId: String!) {
    issue(id: $issueId) {
      id
      identifier
      team { id key }
      state { id name type }
    }
  }
`;

export async function updateLinearIssueStatus(input: LinearUpdateStatusInput) {
  const issueId = input.issueId.trim();
  const requestedStateId = input.stateId?.trim() ?? "";
  const requestedStateName = input.stateName?.trim() ?? "";
  const teamKey = input.teamKey?.trim() ?? "";
  const failureBase = {
    outcome: "failed" as const,
    status: "config_error" as LinearWriteFailureStatus | "verified",
    issue: null as LinearWritebackIssueRef | null,
    state: null as LinearWritebackStateRef | null,
    readback: { issue: null as LinearWritebackIssueRef | null },
  };
  if (!isLinearUuid(issueId)) {
    return { ...failureBase, error: "--issue-id must be an immutable Linear issue UUID" };
  }
  if (requestedStateId && requestedStateName) {
    return { ...failureBase, error: "--state-id and --state-name are mutually exclusive" };
  }
  if (!requestedStateId && !requestedStateName) {
    return { ...failureBase, error: "Provide exactly one of --state-id or --state-name" };
  }
  if (requestedStateId && !isLinearUuid(requestedStateId)) {
    return { ...failureBase, error: "--state-id must be an exact Linear workflow state UUID" };
  }
  if (requestedStateName && requestedStateName.length > LINEAR_STATE_NAME_MAX_CHARS) {
    return {
      ...failureBase,
      error: `--state-name must be 1-${LINEAR_STATE_NAME_MAX_CHARS} characters`,
    };
  }
  if (!teamKey) {
    return { ...failureBase, error: "Linear team_key is required for status update" };
  }
  const credential = await safeReadLinearToken(input);
  if (!credential.ok) {
    return { ...failureBase, status: credential.status, error: credential.error };
  }
  const apiUrl = input.apiUrl?.trim() || "https://api.linear.app/graphql";
  const fetchImpl = input.fetchImpl ?? fetch;
  let resolvedStateId: string;
  let scopedState: LinearWritebackStateRef;
  let issue: LinearWritebackIssueRef;

  if (requestedStateName) {
    const nameScope = await safeLinearWriteRequest<{
      issue: {
        id: string;
        identifier: string;
        team: {
          id: string;
          key: string;
          states: { nodes: Array<{ id: string; name: string; type?: string | null }> };
        } | null;
        state: { id: string; name: string; type?: string | null } | null;
      } | null;
    }>({
      apiUrl,
      token: credential.token,
      query: LINEAR_STATUS_NAME_SCOPE_QUERY,
      variables: { issueId },
      fetchImpl,
    });
    if (!nameScope.ok) {
      return { ...failureBase, status: nameScope.status!, error: nameScope.error! };
    }
    const rawIssue = nameScope.data?.issue ?? null;
    if (!rawIssue) {
      return {
        ...failureBase,
        status: "issue_not_found" as const,
        error: "Linear issue was not found",
      };
    }
    const safeIssue = safeLinearIssueRef(rawIssue, credential.token);
    if (!safeIssue || safeIssue.id !== issueId || safeIssue.team.key !== teamKey) {
      return {
        ...failureBase,
        status: "scope_mismatch" as const,
        error: "Linear issue and team scope did not match the requested identifiers",
      };
    }
    issue = safeIssue;
    const rawStates = rawIssue.team?.states?.nodes;
    if (!Array.isArray(rawStates)) {
      return {
        ...failureBase,
        issue,
        status: "graphql_error" as const,
        error: "Linear team workflow states were not returned",
      };
    }
    const sanitizedStates: LinearWritebackStateRef[] = [];
    for (const candidate of rawStates) {
      const sanitized = safeLinearStateRef(candidate, credential.token);
      if (sanitized) {
        sanitizedStates.push(sanitized);
      }
    }
    const matches = sanitizedStates.filter((candidate) => candidate.name === requestedStateName);
    if (matches.length === 0) {
      return {
        ...failureBase,
        issue,
        status: "state_name_unknown" as const,
        error: `Linear team ${teamKey} has no workflow state named "${requestedStateName}"`,
      };
    }
    if (matches.length > 1) {
      return {
        ...failureBase,
        issue,
        status: "state_name_ambiguous" as const,
        error: `Linear team ${teamKey} has multiple workflow states named "${requestedStateName}"`,
      };
    }
    resolvedStateId = matches[0]!.id;
    scopedState = matches[0]!;
  } else {
    const stateId = requestedStateId;
    const scope = await safeLinearWriteRequest<{
      issue: LinearWritebackIssueRef | null;
      workflowState: (LinearWritebackStateRef & { team: LinearWritebackTeamRef }) | null;
    }>({
      apiUrl,
      token: credential.token,
      query: LINEAR_STATUS_SCOPE_QUERY,
      variables: { issueId, stateId },
      fetchImpl,
    });
    if (!scope.ok) {
      return { ...failureBase, status: scope.status!, error: scope.error! };
    }
    const rawIssue = scope.data?.issue ?? null;
    const rawState = scope.data?.workflowState ?? null;
    if (!rawIssue || !rawState) {
      return {
        ...failureBase,
        status: "issue_not_found" as const,
        error: "Linear issue or workflow state was not found",
      };
    }
    const safeIssue = safeLinearIssueRef(rawIssue, credential.token);
    const stateTeam = safeLinearTeamRef(isRecord(rawState) ? rawState.team : null, credential.token);
    const sanitizedState = safeLinearStateRef(rawState, credential.token);
    if (!safeIssue || !stateTeam || !sanitizedState) {
      return {
        ...failureBase,
        status: "scope_mismatch" as const,
        error: "Linear scope contained invalid or sensitive fields",
      };
    }
    if (
      safeIssue.id !== issueId ||
      safeIssue.team.id !== stateTeam.id ||
      safeIssue.team.key !== stateTeam.key ||
      safeIssue.team.key !== teamKey ||
      sanitizedState.id !== stateId
    ) {
      return {
        ...failureBase,
        issue: safeIssue,
        state: sanitizedState,
        status: "scope_mismatch" as const,
        error: "Linear issue, team, and workflow state scope did not match the requested UUIDs",
      };
    }
    issue = safeIssue;
    resolvedStateId = stateId;
    scopedState = sanitizedState;
  }

  const scopedFailure = { ...failureBase, issue, state: scopedState };

  const mutation = await safeLinearWriteRequest<{
    issueUpdate: { success: boolean; issue: LinearWritebackIssueRef | null } | null;
  }>({
    apiUrl,
    token: credential.token,
    query: LINEAR_STATUS_UPDATE_MUTATION,
    variables: { issueId, input: { stateId: resolvedStateId } },
    fetchImpl,
  });
  if (!mutation.ok) {
    return { ...scopedFailure, status: mutation.status!, error: mutation.error! };
  }
  if (!mutation.data?.issueUpdate?.success) {
    return {
      ...scopedFailure,
      status: "mutation_failed" as const,
      error: "Linear issueUpdate did not report success",
    };
  }

  const readback = await safeLinearWriteRequest<{ issue: LinearWritebackIssueRef | null }>({
    apiUrl,
    token: credential.token,
    query: LINEAR_STATUS_READBACK_QUERY,
    variables: { issueId },
    fetchImpl,
  });
  if (!readback.ok) {
    return { ...scopedFailure, status: readback.status!, error: readback.error! };
  }
  const readbackIssue = readback.data?.issue
    ? safeLinearIssueRef(readback.data.issue, credential.token)
    : null;
  const withReadback = { ...scopedFailure, readback: { issue: readbackIssue } };
  if (
    !readbackIssue ||
    readbackIssue.id !== issueId ||
    readbackIssue.team.id !== issue.team.id ||
    readbackIssue.team.key !== teamKey ||
    readbackIssue.state?.id !== resolvedStateId ||
    readbackIssue.state.name !== scopedState.name ||
    (scopedState.type !== null && readbackIssue.state.type !== scopedState.type)
  ) {
    return {
      ...withReadback,
      status: "readback_mismatch" as const,
      error: "Independent Linear readback did not confirm the requested issue, team, and state UUIDs",
    };
  }
  return {
    outcome: "verified" as const,
    status: "verified" as const,
    issue: readbackIssue,
    state: scopedState,
    readback: { issue: readbackIssue },
    verifiedBy: "independent_readback" as const,
  };
}

export interface LinearWriteEvidenceCommentInput {
  issueId: string;
  idempotencyKey: string;
  evidenceSummary: string;
  idempotencySecretFile?: string | null;
  tokenFile?: string | null;
  tokenEnv?: string | null;
  apiUrl?: string | null;
  fetchImpl?: typeof fetch;
}

const LINEAR_COMMENT_PAGE_SIZE = 50;
const LINEAR_COMMENT_MAX_PAGES = 10;
const LINEAR_COMMENT_KEY_MAX_CHARS = 200;
const LINEAR_COMMENT_SUMMARY_MAX_CHARS = 4000;
const LINEAR_COMMENT_BODY_MAX_CHARS = 6000;
const LINEAR_WRITE_REQUEST_TIMEOUT_MS = 30_000;
const LINEAR_WRITE_RESPONSE_MAX_BYTES = 1_000_000;

const LINEAR_COMMENT_LIST_QUERY = `
  query OuroborosLinearEvidenceCommentList($issueId: String!, $first: Int!, $after: String) {
    issue(id: $issueId) {
      id
      comments(first: $first, after: $after, orderBy: createdAt) {
        nodes { id body issue { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const LINEAR_COMMENT_CREATE_MUTATION = `
  mutation OuroborosLinearEvidenceCommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id body issue { id } }
    }
  }
`;

const LINEAR_COMMENT_READBACK_QUERY = `
  query OuroborosLinearEvidenceCommentReadback($commentId: String!) {
    comment(id: $commentId) { id body issue { id } }
  }
`;

interface LinearEvidenceCommentNode {
  id: string;
  body: string | null;
  issue?: { id: string | null } | null;
}

interface LinearCommentScanResult {
  ok: boolean;
  status: LinearWriteFailureStatus | null;
  error: string | null;
  matches: LinearEvidenceCommentNode[];
}

export async function writeLinearEvidenceComment(input: LinearWriteEvidenceCommentInput) {
  const issueId = input.issueId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const normalizedSummary = normalizeEvidenceSummary(input.evidenceSummary);
  const failureBase = {
    outcome: "failed" as const,
    status: "config_error" as LinearWriteFailureStatus | "created" | "reused",
    issueId: null as string | null,
    marker: "",
    summaryDigest: "",
    comment: null as { id: string } | null,
    recovery: { retry: "comment-only" as const, rollbackStatus: false },
  };
  if (!isLinearUuid(issueId)) {
    return { ...failureBase, error: "--issue-id must be an immutable Linear issue UUID" };
  }
  const validatedFailureBase = { ...failureBase, issueId };
  if (!idempotencyKey || idempotencyKey.length > LINEAR_COMMENT_KEY_MAX_CHARS) {
    return { ...validatedFailureBase, error: `--idempotency-key must be 1-${LINEAR_COMMENT_KEY_MAX_CHARS} characters` };
  }
  if (!normalizedSummary || normalizedSummary.length > LINEAR_COMMENT_SUMMARY_MAX_CHARS) {
    return { ...validatedFailureBase, error: `--evidence-summary must be 1-${LINEAR_COMMENT_SUMMARY_MAX_CHARS} characters` };
  }
  const idempotencySecret = await safeReadLinearIdempotencySecret(input.idempotencySecretFile);
  if (!idempotencySecret.ok) {
    return { ...validatedFailureBase, error: idempotencySecret.error };
  }
  const credential = await safeReadLinearToken(input);
  if (!credential.ok) {
    return { ...validatedFailureBase, status: credential.status, error: credential.error };
  }
  const summaryWithoutIdempotencySecret = normalizedSummary
    .split(idempotencySecret.secret)
    .join("[REDACTED]");
  const safeSummary = redactLinearSensitiveText(summaryWithoutIdempotencySecret, credential.token);
  const marker = `<!-- ouroboros-linear-evidence:v1:key:${sha256Hex(`${issueId}|${idempotencyKey}`)} -->`;
  const summaryDigest = createHmac("sha256", idempotencySecret.secret).update(normalizedSummary).digest("hex");
  const expectedBody = `${marker}\n<!-- summary-hmac-sha256:${summaryDigest} -->\n${safeSummary}`;
  const scopedFailure = { ...validatedFailureBase, marker, summaryDigest };
  if (expectedBody.length > LINEAR_COMMENT_BODY_MAX_CHARS) {
    return { ...scopedFailure, error: `Evidence comment body exceeds ${LINEAR_COMMENT_BODY_MAX_CHARS} characters` };
  }
  const apiUrl = input.apiUrl?.trim() || "https://api.linear.app/graphql";
  const fetchImpl = input.fetchImpl ?? fetch;
  const scanInput = { apiUrl, token: credential.token, issueId, marker, fetchImpl };
  const existing = await scanLinearEvidenceComments(scanInput);
  if (!existing.ok) {
    return { ...scopedFailure, status: existing.status!, error: existing.error! };
  }
  const classified = await classifyExistingLinearComment({
    matches: existing.matches,
    expectedBody,
    issueId,
    marker,
    summaryDigest,
    apiUrl,
    token: credential.token,
    fetchImpl,
  });
  if (classified) {
    return classified.ok
      ? {
          outcome: "verified" as const,
          status: "reused" as const,
          issueId,
          marker,
          summaryDigest,
          comment: { id: classified.commentId! },
          verifiedBy: "independent_readback" as const,
        }
      : { ...scopedFailure, status: classified.status!, error: classified.error! };
  }

  const created = await safeLinearWriteRequest<{
    commentCreate: { success: boolean; comment: LinearEvidenceCommentNode | null } | null;
  }>({
    apiUrl,
    token: credential.token,
    query: LINEAR_COMMENT_CREATE_MUTATION,
    variables: { input: { issueId, body: expectedBody } },
    fetchImpl,
  });
  if (!created.ok) {
    const recovered = await scanLinearEvidenceComments(scanInput);
    if (recovered.ok) {
      const recoveryMatch = await classifyExistingLinearComment({
        matches: recovered.matches,
        expectedBody,
        issueId,
        marker,
        summaryDigest,
        apiUrl,
        token: credential.token,
        fetchImpl,
      });
      if (recoveryMatch?.ok) {
        return {
          outcome: "verified" as const,
          status: "reused" as const,
          issueId,
          marker,
          summaryDigest,
          comment: { id: recoveryMatch.commentId! },
          verifiedBy: "independent_readback" as const,
          recovery: { mutationResponseLost: true, retry: "comment-only" as const, rollbackStatus: false },
        };
      }
      if (recoveryMatch && !recoveryMatch.ok) {
        return { ...scopedFailure, status: recoveryMatch.status!, error: recoveryMatch.error! };
      }
    }
    return { ...scopedFailure, status: created.status!, error: created.error! };
  }
  const createPayload = created.data?.commentCreate ?? null;
  if (!createPayload?.success || !createPayload.comment) {
    return { ...scopedFailure, status: "mutation_failed" as const, error: "Linear commentCreate did not report success" };
  }
  const createdCommentId = safeLinearOutputField(createPayload.comment.id, 200, credential.token);
  if (!createdCommentId) {
    return {
      ...scopedFailure,
      status: "readback_mismatch" as const,
      error: "Linear commentCreate returned an invalid comment id",
    };
  }
  const readback = await readbackLinearEvidenceComment({
    apiUrl,
    token: credential.token,
    commentId: createdCommentId,
    expectedBody,
    issueId,
    fetchImpl,
  });
  if (!readback.ok) {
    return { ...scopedFailure, status: readback.status!, error: readback.error! };
  }
  return {
    outcome: "verified" as const,
    status: "created" as const,
    issueId,
    marker,
    summaryDigest,
    comment: { id: createdCommentId },
    verifiedBy: "independent_readback" as const,
  };
}

async function scanLinearEvidenceComments(input: {
  apiUrl: string;
  token: string;
  issueId: string;
  marker: string;
  fetchImpl: typeof fetch;
}): Promise<LinearCommentScanResult> {
  const matches: LinearEvidenceCommentNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < LINEAR_COMMENT_MAX_PAGES; page += 1) {
    const result: LinearWriteRequestResult<{
      issue: {
        id: string;
        comments: {
          nodes: LinearEvidenceCommentNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    }> = await safeLinearWriteRequest({
      apiUrl: input.apiUrl,
      token: input.token,
      query: LINEAR_COMMENT_LIST_QUERY,
      variables: { issueId: input.issueId, first: LINEAR_COMMENT_PAGE_SIZE, after },
      fetchImpl: input.fetchImpl,
    });
    if (!result.ok) {
      return { ok: false, status: result.status, error: result.error, matches: [] };
    }
    const issue = result.data?.issue ?? null;
    if (!isRecord(issue)) {
      return { ok: false, status: "issue_not_found", error: "Linear issue was not found", matches: [] };
    }
    const comments = isRecord(issue.comments) ? issue.comments : null;
    const nodes = comments?.nodes;
    const pageInfo = isRecord(comments?.pageInfo) ? comments.pageInfo : null;
    if (
      issue.id !== input.issueId ||
      !Array.isArray(nodes) ||
      !pageInfo ||
      typeof pageInfo.hasNextPage !== "boolean" ||
      (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string")
    ) {
      return { ok: false, status: "readback_mismatch", error: "Comment scan returned a different issue UUID", matches: [] };
    }
    for (const rawComment of nodes) {
      const comment = parseLinearEvidenceCommentNode(rawComment);
      if (!comment) {
        return { ok: false, status: "readback_mismatch", error: "Comment scan returned malformed comment data", matches: [] };
      }
      if (typeof comment.body === "string" && comment.body.includes(input.marker)) {
        matches.push(comment);
      }
    }
    if (!pageInfo.hasNextPage) {
      return { ok: true, status: null, error: null, matches };
    }
    after = pageInfo.endCursor as string | null;
    if (!after) {
      return { ok: false, status: "pagination_limit", error: "Linear comment pagination returned no continuation cursor", matches: [] };
    }
  }
  return {
    ok: false,
    status: "pagination_limit",
    error: `Linear comment scan exceeded ${LINEAR_COMMENT_MAX_PAGES} pages`,
    matches: [],
  };
}

async function classifyExistingLinearComment(input: {
  matches: LinearEvidenceCommentNode[];
  expectedBody: string;
  issueId: string;
  marker: string;
  summaryDigest: string;
  apiUrl: string;
  token: string;
  fetchImpl: typeof fetch;
}) {
  if (input.matches.length === 0) {
    return null;
  }
  if (input.matches.length !== 1) {
    return { ok: false, status: "idempotency_conflict" as const, error: "Multiple comments carry the same idempotency marker" };
  }
  const existing = input.matches[0]!;
  const existingCommentId = safeLinearOutputField(existing.id, 200, input.token);
  if (!existingCommentId) {
    return { ok: false, status: "readback_mismatch" as const, error: "Linear returned an invalid comment id" };
  }
  if (existing.body !== input.expectedBody || existing.issue?.id !== input.issueId) {
    return { ok: false, status: "idempotency_conflict" as const, error: "The idempotency key already exists with different evidence" };
  }
  const readback = await readbackLinearEvidenceComment({
    apiUrl: input.apiUrl,
    token: input.token,
    commentId: existingCommentId,
    expectedBody: input.expectedBody,
    issueId: input.issueId,
    fetchImpl: input.fetchImpl,
  });
  return readback.ok
    ? { ok: true, status: null, error: null, commentId: existingCommentId }
    : { ok: false, status: readback.status, error: readback.error };
}

async function readbackLinearEvidenceComment(input: {
  apiUrl: string;
  token: string;
  commentId: string;
  expectedBody: string;
  issueId: string;
  fetchImpl: typeof fetch;
}) {
  const result = await safeLinearWriteRequest<{ comment: LinearEvidenceCommentNode | null }>({
    apiUrl: input.apiUrl,
    token: input.token,
    query: LINEAR_COMMENT_READBACK_QUERY,
    variables: { commentId: input.commentId },
    fetchImpl: input.fetchImpl,
  });
  if (!result.ok) {
    return result;
  }
  const comment = parseLinearEvidenceCommentNode(result.data?.comment ?? null);
  if (
    !comment ||
    comment.id !== input.commentId ||
    comment.issue?.id !== input.issueId ||
    comment.body !== input.expectedBody
  ) {
    return {
      ok: false,
      data: null,
      status: "readback_mismatch" as const,
      error: "Independent Linear comment readback did not match the expected issue, marker, digest, and body",
    };
  }
  return { ok: true, data: { comment }, status: null, error: null };
}

async function safeReadLinearToken(input: { tokenFile?: string | null; tokenEnv?: string | null }) {
  try {
    const source = await readLinearToken(input);
    return { ok: true as const, token: source.token, source: source.source, status: null, error: null };
  } catch {
    return {
      ok: false as const,
      token: "",
      source: "none",
      status: "config_error" as const,
      error: "Linear credential could not be loaded",
    };
  }
}

async function safeReadLinearIdempotencySecret(path: string | null | undefined) {
  if (!path?.trim()) {
    return {
      ok: false as const,
      secret: "",
      error: "--idempotency-secret-file is required for stable evidence fingerprints",
    };
  }
  try {
    const secret = (await readFile(path.trim(), "utf8")).trim();
    if (secret.length < 32 || secret.length > 4096) {
      throw new Error("invalid secret length");
    }
    return { ok: true as const, secret, error: null };
  } catch {
    return {
      ok: false as const,
      secret: "",
      error: "Linear writeback idempotency secret could not be loaded",
    };
  }
}

async function safeLinearWriteRequest<T>(input: {
  apiUrl: string;
  token: string;
  query: string;
  variables: Record<string, unknown>;
  fetchImpl: typeof fetch;
}): Promise<LinearWriteRequestResult<T>> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.apiUrl, {
      method: "POST",
      headers: { authorization: input.token, "content-type": "application/json" },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
      signal: AbortSignal.timeout(LINEAR_WRITE_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, data: null, status: "transient_failure", error: "Linear network request failed" };
  }
  if (response.status === 401) {
    return { ok: false, data: null, status: "auth_failure", error: "Linear authentication failed" };
  }
  if (response.status === 403) {
    return { ok: false, data: null, status: "permission_denied", error: "Linear permission denied" };
  }
  if (!response.ok) {
    return {
      ok: false,
      data: null,
      status: response.status === 429 || response.status >= 500 ? "transient_failure" : "graphql_error",
      error: "Linear request failed",
    };
  }
  let body: LinearGraphqlResponse<T>;
  try {
    body = JSON.parse(await readLinearResponseText(response, LINEAR_WRITE_RESPONSE_MAX_BYTES)) as LinearGraphqlResponse<T>;
  } catch {
    return { ok: false, data: null, status: "graphql_error", error: "Linear returned an invalid response" };
  }
  if (body.errors?.length) {
    return { ok: false, data: null, status: "graphql_error", error: "Linear GraphQL operation failed" };
  }
  if (!body.data) {
    return { ok: false, data: null, status: "graphql_error", error: "Linear GraphQL operation returned no data" };
  }
  return { ok: true, data: body.data, status: null, error: null };
}

async function readLinearResponseText(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("response too large");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function safeLinearIssueRef(value: unknown, token: string): LinearWritebackIssueRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = safeLinearOutputField(value.id, 64, token);
  const identifier = safeLinearOutputField(value.identifier, 100, token);
  const team = safeLinearTeamRef(value.team, token);
  const state = value.state ? safeLinearStateRef(value.state, token) : null;
  if (!id || !identifier || !team || (value.state && !state)) {
    return null;
  }
  return { id, identifier, team, state };
}

function safeLinearTeamRef(value: unknown, token: string): LinearWritebackTeamRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = safeLinearOutputField(value.id, 64, token);
  const key = safeLinearOutputField(value.key, 32, token);
  return id && key ? { id, key } : null;
}

function safeLinearStateRef(value: unknown, token: string): LinearWritebackStateRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = safeLinearOutputField(value.id, 64, token);
  const name = safeLinearOutputField(value.name, 200, token);
  const type = value.type === null || value.type === undefined
    ? null
    : safeLinearOutputField(value.type, 64, token);
  if (!id || !name || (value.type !== null && value.type !== undefined && !type)) {
    return null;
  }
  return { id, name, type };
}

function safeLinearOutputField(value: unknown, maxChars: number, token: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    return null;
  }
  return redactLinearSensitiveText(value, token) === value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLinearEvidenceCommentNode(value: unknown): LinearEvidenceCommentNode | null {
  if (!isRecord(value) || typeof value.id !== "string" || (value.body !== null && typeof value.body !== "string")) {
    return null;
  }
  if (value.issue !== null && value.issue !== undefined) {
    if (!isRecord(value.issue) || (value.issue.id !== null && typeof value.issue.id !== "string")) {
      return null;
    }
  }
  return {
    id: value.id,
    body: value.body as string | null,
    issue: isRecord(value.issue) ? { id: value.issue.id as string | null } : null,
  };
}

function isLinearUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeEvidenceSummary(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function redactLinearSensitiveText(value: string, token: string) {
  const exactRedacted = token ? value.split(token).join("[REDACTED]") : value;
  try {
    const parsed = JSON.parse(exactRedacted) as unknown;
    return JSON.stringify(redactLinearSensitiveJson(parsed, token));
  } catch {
    if (
      /["']?[\w.-]*(?:authorization|token|api[_-]?key|secret|password|credential)[\w.-]*["']?\s*[:=]/i
        .test(exactRedacted)
    ) {
      return "[REDACTED]";
    }
    return exactRedacted
      .split("\n")
      .map((line) => redactLinearSensitiveLine(line, token))
      .join("\n");
  }
}

function redactLinearSensitiveLine(value: string, token: string) {
  const exactRedacted = token ? value.split(token).join("[REDACTED]") : value;
  try {
    const parsed = JSON.parse(exactRedacted) as unknown;
    return JSON.stringify(redactLinearSensitiveJson(parsed, token));
  } catch {
    return redactLinearSensitivePlainText(exactRedacted);
  }
}

function redactLinearSensitiveJson(value: unknown, token: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactLinearSensitiveJson(entry, token));
  }
  if (isRecord(value)) {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isLinearSensitiveKey(key)) {
        redacted["[REDACTED]"] = "[REDACTED]";
      } else {
        redacted[key] = redactLinearSensitiveJson(child, token);
      }
    }
    return redacted;
  }
  if (typeof value === "string") {
    const exactRedacted = token ? value.split(token).join("[REDACTED]") : value;
    return redactLinearSensitivePlainText(exactRedacted);
  }
  return value;
}

function isLinearSensitiveKey(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ["authorization", "token", "apikey", "secret", "password", "credential"]
    .some((part) => normalized.includes(part));
}

function redactLinearSensitivePlainText(value: string) {
  return value
    .replace(/\b(?:lin_api|lin_oauth)_[A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "[REDACTED]")
    .replace(
      /["']?[\w.-]*(?:authorization|token|api[_-]?key|secret|password|credential)[\w.-]*["']?\s*[:=]\s*[^\r\n]*/gi,
      "[REDACTED]",
    );
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function linkLinearIssue(input: LinearIssueLinkInput) {
  const localType = input.localType.trim();
  if (localType !== "run" && localType !== "task") {
    throw new Error("--local-type must be run or task");
  }
  const localId = input.localId.trim();
  if (!localId) {
    throw new Error("--local-id is required");
  }
  if (localType === "run" && !input.harness.getRun(localId)) {
    throw new Error(`run not found: ${localId}`);
  }
  if (localType === "task" && !input.harness.getTask(localId)) {
    throw new Error(`task not found: ${localId}`);
  }

  const issueId = issueIdentifier(input);
  const issueUrl = stringOrNull(input.issueUrl);
  const existing = input.harness
    .listExternalRefs({ localType, localId })
    .find(
      (ref) =>
        ref.provider === "linear" &&
        ref.externalType === "issue" &&
        ref.externalId === issueId,
    );
  if (existing) {
    return { ...existing, created: false };
  }

  const id = input.harness.createExternalRef({
    localType,
    localId,
    provider: "linear",
    externalType: "issue",
    externalId: issueId,
    externalUrl: issueUrl,
  });
  return {
    id,
    localType,
    localId,
    provider: "linear",
    externalType: "issue",
    externalId: issueId,
    externalUrl: issueUrl,
    created: true,
  };
}

export function ingestLinearEvent(input: LinearIngestEventInput) {
  const eventType = input.eventType.trim();
  if (!eventType) {
    throw new Error("--event-type is required");
  }
  const externalId = input.externalId.trim();
  if (!externalId) {
    throw new Error("--external-id is required");
  }
  const trimmedPayload = input.payloadJson.trim();
  if (!trimmedPayload) {
    throw new Error("--payload-json is required");
  }
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(trimmedPayload);
  } catch {
    throw new Error("--payload-json must be valid JSON");
  }
  if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) {
    throw new Error("--payload-json must be a JSON object");
  }
  const payload = parsedPayload as Record<string, unknown>;

  const deterministicId = deterministicLinearInboxId({
    eventType,
    externalId,
  });
  const ensured = input.harness.ensureInboxEvent({
    id: deterministicId,
    provider: "linear",
    eventType,
    externalId,
    payload,
  });
  const stored = ensured.event;
  return {
    id: stored.id,
    provider: stored.provider,
    eventType: stored.eventType,
    externalId: stored.externalId,
    status: stored.status,
    payload: stored.payload,
    createdAt: stored.createdAt,
    created: ensured.created,
  };
}

export function deterministicLinearInboxId(input: { eventType: string; externalId: string }) {
  const eventType = input.eventType.trim();
  const externalId = input.externalId.trim();
  if (!eventType) {
    throw new Error("eventType is required for deterministic Linear inbox id");
  }
  if (!externalId) {
    throw new Error("externalId is required for deterministic Linear inbox id");
  }
  const material = `linear|${eventType}|${externalId}`;
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `inbox_linear_${digest}`;
}

export interface LinearPollingIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string | null;
  createdAt: string;
  updatedAt: string | null;
  projectId: string | null;
  teamId: string | null;
  teamKey: string | null;
}

export interface LinearPollingConfig {
  pageSize: number;
  maxPagesPerCycle: number;
  maxIssuesPerCycle: number;
  overlapMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface LinearPollingState {
  /** Relay cursor pointing past the last durably ingested page. Null on first cycle. */
  cursor: string | null;
  /** createdAt watermark of the last durably ingested issue. Drives overlap replay. Null on first cycle. */
  overlapBoundary: string | null;
  /**
   * Durable intra-page continuation key. Set when a page is truncated by the per-cycle issue cap so
   * the next cycle can resume from this (createdAt, issueId) tuple without reprocessing earlier
   * nodes on the same page. Null when no intra-page resume is needed.
   */
  intraPageContinuation?: { createdAt: string; issueId: string } | null;
}

export type LinearPollingStatus =
  | "ok"
  | "rate_limited"
  | "transient_failure"
  | "auth_failure"
  | "config_error"
  | "scope_error"
  | "ingestion_failure";

export interface LinearPollingCycleResult {
  status: LinearPollingStatus;
  state: LinearPollingState;
  pagesProcessed: number;
  issuesIngested: number;
  issuesDeduplicated: number;
  issuesRejected: number;
  /** Nodes returned by Linear that could not be normalized (missing id or createdAt). */
  issuesMalformed: number;
  /** True when the next retry attempt would exceed the configured retry budget. */
  exhausted: boolean;
  /** Milliseconds the caller should wait before invoking again. Null when no retry is expected. */
  retryAfterMs: number | null;
  error?: string;
}

interface LinearGraphqlPage {
  nodes: Array<{
    id: string;
    identifier?: string | null;
    title?: string | null;
    description?: string | null;
    url?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    project?: { id: string | null } | null;
    team?: { id: string | null; key?: string | null } | null;
  }>;
  pageInfo: { hasNextPage: boolean | null; endCursor: string | null };
}

interface LinearFetchOutcome {
  kind: "ok" | "rate_limited" | "transient_failure" | "auth_failure" | "scope_error";
  page?: LinearGraphqlPage;
  retryAfterMs?: number | null;
  error?: string;
}

const LINEAR_ISSUES_QUERY = `
  query OuroborosLinearPollIssues(
    $projectId: ID!
    $teamKey: String!
    $pageSize: Int!
    $after: String
    $overlapStart: DateTimeOrDuration
  ) {
    issues(
      first: $pageSize
      after: $after
      orderBy: createdAt
      filter: {
        project: { id: { eq: $projectId } }
        team: { key: { eq: $teamKey } }
        createdAt: { gte: $overlapStart }
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
        project { id }
        team { id key }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const LINEAR_INITIAL_OVERLAP_START = "1970-01-01T00:00:00.000Z";

/**
 * Poll Linear for issues in the configured project and team. Each call performs one bounded cycle
 * (up to maxPagesPerCycle pages and maxIssuesPerCycle nodes) and updates durable state only after
 * every node on a page has passed through the shared ensure path. Every node returned by Linear —
 * accepted, deduplicated, rejected, or malformed — consumes the per-cycle budget, and each request
 * is bounded by the remaining capacity. When a page is truncated by the cap, the cycle saves a
 * durable intra-page continuation keyed by (createdAt, immutable issue id) so the next cycle and
 * Harness reconstruction can resume from the truncation point without starving the tail of an
 * equal-timestamp page. Fetch failures are classified and returned with bounded exponential-backoff
 * metadata; the function never sleeps and never advances durable state past an ingestion failure.
 */
export async function pollLinearIssues(input: {
  harness: Harness;
  apiUrl: string;
  token: string;
  projectId: string;
  teamKey: string;
  config: LinearPollingConfig;
  state: LinearPollingState;
  retryAttempt?: number;
  fetchImpl?: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): Promise<LinearPollingCycleResult> {
  const projectId = input.projectId.trim();
  const teamKey = input.teamKey.trim();
  if (!projectId) {
    return permanentFailure("config_error", "Linear polling requires a resolved project id");
  }
  if (!teamKey) {
    return permanentFailure("config_error", "Linear polling requires a resolved team key");
  }
  const retryAttempt = Math.max(0, input.retryAttempt ?? 0);
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxRetries = Math.max(0, input.config.maxRetries);
  const initialOverlapBoundary = input.state.overlapBoundary;
  const fetchOverlapStart = computeOverlapStart(initialOverlapBoundary, input.config.overlapMs);
  const initialContinuation = input.state.intraPageContinuation ?? null;

  let pagesProcessed = 0;
  let issuesIngested = 0;
  let issuesDeduplicated = 0;
  let issuesRejected = 0;
  let issuesMalformed = 0;
  let overlapBoundary = initialOverlapBoundary;
  let relayCursor: string | null = input.state.cursor ?? null;
  let continuation: LinearPollingState["intraPageContinuation"] = initialContinuation;
  let cycleFullyDrained = false;

  // The Relay cursor is only consistent with the overlapStart that produced it. When the overlap
  // boundary advances during this cycle, the next cycle will compute a different overlapStart, so
  // we must drop the cursor (and any intra-page continuation captured under the prior overlap
  // window) and rely on the overlap filter plus deterministic deduplication. The cursor and
  // continuation are also dropped when a page is terminal because there is nothing left to paginate.
  const durableAtInitialBoundary = (): boolean => overlapBoundary === initialOverlapBoundary;
  const computeReturnedCursor = (): string | null => {
    if (cycleFullyDrained) {
      return null;
    }
    return durableAtInitialBoundary() ? relayCursor : null;
  };
  const computeReturnedContinuation = (): LinearPollingState["intraPageContinuation"] => {
    if (cycleFullyDrained) {
      return null;
    }
    return durableAtInitialBoundary() ? continuation : null;
  };

  while (pagesProcessed < input.config.maxPagesPerCycle) {
    const issuesProcessed = issuesIngested + issuesDeduplicated + issuesRejected + issuesMalformed;
    if (issuesProcessed >= input.config.maxIssuesPerCycle) {
      break;
    }
    // Bound each request by the remaining per-cycle capacity so Linear cannot return more nodes than
    // we have budget to account for in this cycle.
    const remainingCapacity = input.config.maxIssuesPerCycle - issuesProcessed;
    const requestSize = Math.max(0, Math.min(input.config.pageSize, remainingCapacity));
    if (requestSize <= 0) {
      break;
    }
    const fetchOutcome = await fetchIssuePage({
      apiUrl: input.apiUrl,
      token: input.token,
      projectId,
      teamKey,
      pageSize: requestSize,
      after: relayCursor,
      overlapStart: fetchOverlapStart,
      fetchImpl,
    });
    if (fetchOutcome.kind !== "ok" || !fetchOutcome.page) {
      const terminal = fetchOutcome.kind === "auth_failure" || fetchOutcome.kind === "scope_error";
      const exhausted = terminal || retryAttempt + 1 >= maxRetries;
      const retryAfterMs = terminal
        ? null
        : computeRetryAfterMs({
            kind: fetchOutcome.kind,
            retryAfter: fetchOutcome.retryAfterMs ?? null,
            retryAttempt,
            config: input.config,
          });
      return {
        status: fetchOutcome.kind,
        state: {
          cursor: computeReturnedCursor(),
          overlapBoundary,
          intraPageContinuation: computeReturnedContinuation(),
        },
        pagesProcessed,
        issuesIngested,
        issuesDeduplicated,
        issuesRejected,
        issuesMalformed,
        exhausted,
        retryAfterMs,
        error: fetchOutcome.error,
      };
    }
    const page = fetchOutcome.page;
    const sorted = stableSortIssues(page.nodes);

    let ingestionFailed: { error: string } | null = null;
    let pageTruncatedByCap = false;
    let latestAcceptedBoundary = overlapBoundary;
    let lastProcessedKey: { createdAt: string; issueId: string } | null = null;
    let processedOnPage = 0;

    for (const issue of sorted) {
      // Resume from the durable intra-page continuation captured on the previous cycle. The filter
      // skips nodes at or before the continuation key so equal-timestamp tails are not reprocessed.
      if (continuation && !isAfterContinuationKey(issue, continuation)) {
        continue;
      }
      const issuesProcessedNow = issuesIngested + issuesDeduplicated + issuesRejected + issuesMalformed;
      if (issuesProcessedNow >= input.config.maxIssuesPerCycle) {
        pageTruncatedByCap = true;
        break;
      }
      // Malformed nodes (missing id or createdAt) consume the budget but cannot be ingested.
      if (!isWellFormedIssue(issue)) {
        issuesMalformed += 1;
        lastProcessedKey = { createdAt: issue.createdAt, issueId: issue.id };
        processedOnPage += 1;
        continue;
      }
      // Out-of-scope nodes consume the budget and are rejected before ingestion.
      if (issue.projectId !== projectId || issue.teamKey !== teamKey) {
        issuesRejected += 1;
        lastProcessedKey = { createdAt: issue.createdAt, issueId: issue.id };
        processedOnPage += 1;
        continue;
      }
      try {
        const result = ensureIssue(input.harness, issue);
        if (result.created) {
          issuesIngested += 1;
        } else {
          issuesDeduplicated += 1;
        }
        latestAcceptedBoundary =
          latestAcceptedBoundary === null || issue.createdAt > latestAcceptedBoundary
            ? issue.createdAt
            : latestAcceptedBoundary;
        lastProcessedKey = { createdAt: issue.createdAt, issueId: issue.id };
        processedOnPage += 1;
      } catch (error) {
        ingestionFailed = { error: (error as Error).message };
        break;
      }
    }

    if (ingestionFailed) {
      // Never advance durable state past an ingestion failure. Counters reflect the work attempted
      // before the failure; cursor, overlap boundary, and continuation remain at the input state.
      // Persistent ingestion failures obey the same retry budget as fetch failures so the
      // supervisor can flip to terminal blocked intake once the budget is exhausted.
      const exhausted = retryAttempt + 1 >= maxRetries;
      const exponent = Math.min(retryAttempt, 16);
      const retryAfterMs = Math.max(
        0,
        Math.floor(
          Math.min(
            input.config.backoffBaseMs * 2 ** exponent,
            input.config.backoffMaxMs,
          ),
        ),
      );
      return {
        status: "ingestion_failure",
        state: {
          cursor: computeReturnedCursor(),
          overlapBoundary,
          intraPageContinuation: computeReturnedContinuation(),
        },
        pagesProcessed,
        issuesIngested,
        issuesDeduplicated,
        issuesRejected,
        issuesMalformed,
        exhausted,
        retryAfterMs,
        error: ingestionFailed.error,
      };
    }

    if (pageTruncatedByCap) {
      // The page was bounded by the per-cycle cap. Save the durable continuation so the next cycle
      // resumes after the last durably accounted node. Cursor and overlap boundary do not advance.
      if (lastProcessedKey) {
        continuation = lastProcessedKey;
      }
      break;
    }

    // The page was fully covered: every returned node consumed budget. Advance durable state.
    overlapBoundary = latestAcceptedBoundary;
    relayCursor = page.pageInfo.endCursor ?? null;
    continuation = null;
    pagesProcessed += 1;
    if (!page.pageInfo.hasNextPage) {
      cycleFullyDrained = true;
      break;
    }
  }

  return {
    status: "ok",
    state: {
      cursor: computeReturnedCursor(),
      overlapBoundary,
      intraPageContinuation: computeReturnedContinuation(),
    },
    pagesProcessed,
    issuesIngested,
    issuesDeduplicated,
    issuesRejected,
    issuesMalformed,
    exhausted: false,
    retryAfterMs: null,
    error: cycleFullyDrained ? undefined : "cycle limit reached",
  };
}

function permanentFailure(status: LinearPollingStatus, message: string): LinearPollingCycleResult {
  return {
    status,
    state: { cursor: null, overlapBoundary: null, intraPageContinuation: null },
    pagesProcessed: 0,
    issuesIngested: 0,
    issuesDeduplicated: 0,
    issuesRejected: 0,
    issuesMalformed: 0,
    exhausted: false,
    retryAfterMs: null,
    error: message,
  };
}

function isWellFormedIssue(issue: LinearPollingIssue): boolean {
  return Boolean(issue.id && issue.createdAt);
}

function isAfterContinuationKey(
  issue: LinearPollingIssue,
  continuation: { createdAt: string; issueId: string },
): boolean {
  if (issue.createdAt !== continuation.createdAt) {
    return issue.createdAt > continuation.createdAt;
  }
  return issue.id > continuation.issueId;
}

function ensureIssue(harness: Harness, issue: LinearPollingIssue) {
  const externalId = issue.id;
  const payload: Record<string, unknown> = {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    projectId: issue.projectId,
    teamId: issue.teamId,
    teamKey: issue.teamKey,
  };
  const deterministicId = deterministicLinearInboxId({
    eventType: "issue.created",
    externalId,
  });
  return harness.ensureInboxEvent({
    id: deterministicId,
    provider: "linear",
    eventType: "issue.created",
    externalId,
    payload,
  });
}

function stableSortIssues(nodes: LinearGraphqlPage["nodes"]): LinearPollingIssue[] {
  const mapped = nodes.map((node) => normalizeIssue(node));
  mapped.sort((a, b) => {
    const timeA = a.createdAt ?? "";
    const timeB = b.createdAt ?? "";
    if (timeA !== timeB) {
      return timeA < timeB ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return mapped;
}

function normalizeIssue(node: LinearGraphqlPage["nodes"][number]): LinearPollingIssue {
  const createdAt = node.createdAt ?? "";
  return {
    id: node.id,
    identifier: node.identifier ?? "",
    title: node.title ?? "",
    description: node.description ?? null,
    url: node.url ?? null,
    createdAt,
    updatedAt: node.updatedAt ?? null,
    projectId: node.project?.id ?? null,
    teamId: node.team?.id ?? null,
    teamKey: node.team?.key ?? null,
  };
}

function computeOverlapStart(overlapBoundary: string | null, overlapMs: number): string | null {
  if (!overlapBoundary) {
    return null;
  }
  const parsed = Date.parse(overlapBoundary);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const adjusted = parsed - Math.max(0, overlapMs);
  return new Date(adjusted).toISOString();
}

function computeRetryAfterMs(input: {
  kind: LinearFetchOutcome["kind"];
  retryAfter: number | null;
  retryAttempt: number;
  config: LinearPollingConfig;
}): number | null {
  if (input.kind === "rate_limited" && input.retryAfter !== null && input.retryAfter > 0) {
    return Math.min(input.retryAfter, input.config.backoffMaxMs);
  }
  const exponent = Math.min(input.retryAttempt, 16);
  const backoff = Math.min(
    input.config.backoffBaseMs * 2 ** exponent,
    input.config.backoffMaxMs,
  );
  return Math.max(0, Math.floor(backoff));
}

async function fetchIssuePage(input: {
  apiUrl: string;
  token: string;
  projectId: string;
  teamKey: string;
  pageSize: number;
  after: string | null;
  overlapStart: string | null;
  fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): Promise<LinearFetchOutcome> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.apiUrl, {
      method: "POST",
      headers: {
        authorization: input.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: LINEAR_ISSUES_QUERY,
        variables: {
          projectId: input.projectId,
          teamKey: input.teamKey,
          pageSize: input.pageSize,
          after: input.after,
          overlapStart: input.overlapStart ?? LINEAR_INITIAL_OVERLAP_START,
        },
      }),
    });
  } catch {
    return {
      kind: "transient_failure",
      error: "Linear fetch network error",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      kind: "auth_failure",
      error: `Linear authentication failed with status ${response.status}`,
    };
  }

  const retryAfterHeader = response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset");
  const remainingHeader = response.headers.get("x-ratelimit-remaining");
  const rateLimitedByStatus = response.status === 429 || response.status === 503;

  let body: LinearGraphqlResponse<{ issues: LinearGraphqlPage }> | null = null;
  try {
    body = (await response.json()) as LinearGraphqlResponse<{ issues: LinearGraphqlPage }>;
  } catch {
    if (response.status >= 500 || rateLimitedByStatus) {
      return {
        kind: rateLimitedByStatus ? "rate_limited" : "transient_failure",
        retryAfterMs: parseRetryAfterMs(retryAfterHeader),
        error: "Linear fetch returned a non-JSON response",
      };
    }
    return {
      kind: "transient_failure",
      error: "Linear fetch returned a non-JSON response",
    };
  }

  if (rateLimitedByStatus || isRateLimitedGraphql(body)) {
    return {
      kind: "rate_limited",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader),
      error: extractFirstError(body, input.token),
    };
  }

  if (!response.ok) {
    if (response.status >= 500) {
      return {
        kind: "transient_failure",
        error: `Linear fetch failed with status ${response.status}`,
      };
    }
    return {
      kind: "auth_failure",
      error: `Linear fetch rejected with status ${response.status}`,
    };
  }

  if (body.errors && body.errors.length > 0) {
    if (response.status >= 500) {
      return {
        kind: "transient_failure",
        error: extractFirstError(body, input.token),
      };
    }
    return {
      kind: "scope_error",
      error: extractFirstError(body, input.token),
    };
  }

  if (!body.data || !body.data.issues) {
    return {
      kind: "transient_failure",
      error: "Linear fetch returned no issues data",
    };
  }

  if (remainingHeader !== null && Number(remainingHeader) <= 0) {
    return {
      kind: "rate_limited",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader),
      page: body.data.issues,
      error: "Linear rate-limit remaining header is zero",
    };
  }

  return {
    kind: "ok",
    page: body.data.issues,
  };
}

function isRateLimitedGraphql(body: LinearGraphqlResponse<unknown>): boolean {
  if (!body.errors) {
    return false;
  }
  for (const error of body.errors) {
    const code = (error as { extensions?: { code?: string } | null } | null)?.extensions?.code;
    if (typeof code === "string" && code.toUpperCase() === "RATELIMITED") {
      return true;
    }
    const message = (error as { message?: string } | null)?.message ?? "";
    if (typeof message === "string" && /rate limit/i.test(message)) {
      return true;
    }
  }
  return false;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.floor(seconds * 1000));
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return Math.max(0, Math.floor(parsed - Date.now()));
  }
  return null;
}

function extractFirstError(body: LinearGraphqlResponse<unknown>, token: string): string {
  if (body.errors && body.errors.length > 0) {
    return redactLinearSensitiveText(JSON.stringify(body.errors[0]), token).slice(0, 500);
  }
  return "Linear GraphQL request failed";
}

async function readLinearToken(input: { tokenFile?: string | null; tokenEnv?: string | null }) {
  const tokenEnv = input.tokenEnv ?? "LINEAR_API_KEY";
  if (process.env[tokenEnv]?.trim()) {
    return { token: process.env[tokenEnv]!.trim(), source: tokenEnv };
  }
  const path = input.tokenFile ?? join(process.cwd(), ".linear");
  const token = (await readFile(path, "utf8")).trim();
  if (!token) {
    throw new Error(`Linear token file is empty: ${path}`);
  }
  return { token, source: path };
}

async function linearGraphql<T>(input: { apiUrl: string; token: string; query: string; variables?: Record<string, unknown> }) {
  const response = await fetch(input.apiUrl, {
    method: "POST",
    headers: {
      authorization: input.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: input.query, variables: input.variables ?? {} }),
  });
  const body = (await response.json()) as LinearGraphqlResponse<T>;
  if (!response.ok || body.errors) {
    const safeDetail = redactLinearSensitiveText(
      JSON.stringify(body.errors ?? { status: response.status }),
      input.token,
    ).slice(0, 500);
    throw new Error(`Linear GraphQL request failed: ${safeDetail}`);
  }
  if (!body.data) {
    throw new Error("Linear GraphQL request returned no data");
  }
  return body.data;
}

function findProject(projects: LinearProject[], input: { projectId?: string | null; projectUrl?: string | null }) {
  return projects.find((project) => {
    if (input.projectId && (project.id === input.projectId || project.slugId === input.projectId)) {
      return true;
    }
    if (input.projectUrl && project.url === input.projectUrl) {
      return true;
    }
    return input.projectUrl && project.slugId ? input.projectUrl.includes(project.slugId) : false;
  });
}

function issueIdentifier(input: { issueId?: string | null; issueKey?: string | null; issueUrl?: string | null }) {
  const issueId = stringOrNull(input.issueId);
  if (issueId) {
    return issueId;
  }
  const issueKey = stringOrNull(input.issueKey);
  if (issueKey) {
    return issueKey;
  }
  const issueUrl = stringOrNull(input.issueUrl);
  if (issueUrl) {
    return issueUrl;
  }
  throw new Error("Linear issue identifier is required: pass --issue-id, --issue-key, or --issue-url");
}

function stringOrNull(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function ensureRunProjectRef(
  harness: Harness,
  input: { runId: string; project: LinearProject; projectExternalId: string },
) {
  const existing = harness
    .listExternalRefs({ localType: "run", localId: input.runId })
    .find(
      (ref) =>
        ref.provider === "linear" &&
        ref.externalType === "project" &&
        ref.externalId === input.projectExternalId,
    );
  if (existing) {
    return { id: existing.id, created: false };
  }
  const id = harness.createExternalRef({
    localType: "run",
    localId: input.runId,
    provider: "linear",
    externalType: "project",
    externalId: input.projectExternalId,
    externalUrl: input.project.url,
  });
  return { id, created: true };
}
