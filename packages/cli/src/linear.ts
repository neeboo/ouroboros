import { readFile } from "node:fs/promises";
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
