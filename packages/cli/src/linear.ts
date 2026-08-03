import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
    $projectId: String!
    $teamKey: String!
    $pageSize: Int!
    $after: String
    $overlapStart: DateTime
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
        exhausted: false,
        retryAfterMs: null,
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
          overlapStart: input.overlapStart,
        },
      }),
    });
  } catch (error) {
    return {
      kind: "transient_failure",
      error: `Linear fetch network error: ${(error as Error).message}`,
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
  } catch (error) {
    if (response.status >= 500 || rateLimitedByStatus) {
      return {
        kind: rateLimitedByStatus ? "rate_limited" : "transient_failure",
        retryAfterMs: parseRetryAfterMs(retryAfterHeader),
        error: `Linear fetch non-JSON response: ${(error as Error).message}`,
      };
    }
    return {
      kind: "transient_failure",
      error: `Linear fetch non-JSON response: ${(error as Error).message}`,
    };
  }

  if (rateLimitedByStatus || isRateLimitedGraphql(body)) {
    return {
      kind: "rate_limited",
      retryAfterMs: parseRetryAfterMs(retryAfterHeader),
      error: extractFirstError(body),
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
        error: extractFirstError(body),
      };
    }
    return {
      kind: "scope_error",
      error: extractFirstError(body),
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

function extractFirstError(body: LinearGraphqlResponse<unknown>): string {
  if (body.errors && body.errors.length > 0) {
    return JSON.stringify(body.errors[0]);
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
    throw new Error(`Linear GraphQL request failed: ${JSON.stringify(body.errors ?? { status: response.status })}`);
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
