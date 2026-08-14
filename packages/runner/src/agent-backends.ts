import type { Run, Task } from "@ouroboros/harness";
import type { AcpxBuiltInAgent, ApprovalMode } from "./executors/types";

export type AgentBackendKind = "acpx" | "codex-cli" | "codex-resumable" | "dsh-cli" | "noop";
export type AgentBackendSource = "task" | "role-default" | "run-default" | "cli-agent-backend" | "cli-executor";

export interface ResolvedAgentBackend {
  id: string;
  kind: AgentBackendKind;
  source: AgentBackendSource;
  agent?: AcpxBuiltInAgent;
  agentCommand?: string;
  approval?: ApprovalMode;
  format?: string;
  command?: string;
  profile?: "headless";
  env?: Record<string, string>;
}

const CODEX_ONLY_AGENT_ROLES = [
  "designer",
  "planner",
  "worker",
  "verifier",
  "goal-review",
  "outcome-review",
  "repair",
] as const;

// Self-iteration is a Codex-owned control loop. Normalize both known roles and
// any configured extension roles so a stale run or local config cannot route a
// newly derived cycle back to an unapproved backend. The explicit Worker
// exception is deliberately checked through the same resolver used at runtime.
export function codexOnlyAgentDefaults(value: unknown, backendDefinitions?: unknown) {
  const defaults = objectOrNull(value) ?? {};
  const configuredRoles = objectOrNull(defaults.roles) ?? {};
  const configuredWorker = stringOrNull(configuredRoles.worker);
  const workerBackend = isDshWorkerBackend(configuredWorker, backendDefinitions)
    ? configuredWorker
    : "codex-resumable";
  const roles = Object.fromEntries(
    [...new Set([...CODEX_ONLY_AGENT_ROLES, ...Object.keys(configuredRoles)])]
      .map((role) => [role, role === "worker" ? workerBackend : "codex-resumable"]),
  );
  return {
    global: "codex-resumable",
    roles,
  };
}

function isDshWorkerBackend(id: string | null, backendDefinitions: unknown) {
  if (!id) {
    return false;
  }
  return backendById({ agentBackends: backendDefinitions }, id, "role-default")?.kind === "dsh-cli";
}

export function resolveAgentBackend(input: {
  run: Run;
  task: Task;
  cliAgentBackend?: string | null;
  cliExecutor?: string | null;
}): ResolvedAgentBackend {
  const frozenCodexExecutor = input.cliExecutor === "codex-resumable";
  const candidates: Array<{ id: string | null; source: AgentBackendSource }> = [
    { id: stringOrNull(input.task.config?.agentBackend), source: "task" },
    { id: roleDefault(input.run.context, input.task.role), source: "role-default" },
    // A daemon started with the frozen Codex executor must not inherit a stale
    // run-wide Claude fallback. Task and role selections remain explicit, but
    // legacy global defaults are migrated to the daemon's executor boundary.
    { id: frozenCodexExecutor ? null : runDefault(input.run.context), source: "run-default" },
    { id: stringOrNull(input.cliAgentBackend), source: "cli-agent-backend" },
    { id: stringOrNull(input.cliExecutor), source: "cli-executor" },
  ];

  for (const candidate of candidates) {
    if (!candidate.id) {
      continue;
    }
    const resolved = backendById(input.run.context, candidate.id, candidate.source);
    if (resolved) {
      return resolved;
    }
  }

  return {
    id: "noop",
    kind: "noop",
    source: "cli-executor",
  };
}

function backendById(context: Record<string, unknown>, id: string, source: AgentBackendSource): ResolvedAgentBackend | null {
  const definition = objectOrNull(objectOrNull(context.agentBackends)?.[id]);
  if (definition) {
    return normalizeBackendDefinition(id, source, definition);
  }
  return builtInBackend(id, source);
}

function normalizeBackendDefinition(
  id: string,
  source: AgentBackendSource,
  definition: Record<string, unknown>,
): ResolvedAgentBackend | null {
  const kind = stringOrNull(definition.kind);
  if (kind !== "acpx" && kind !== "codex-cli" && kind !== "codex-resumable" && kind !== "dsh-cli" && kind !== "noop") {
    return null;
  }
  const backend: ResolvedAgentBackend = { id, kind, source };
  if (kind === "acpx") {
    const agent = acpxAgent(stringOrNull(definition.agent)) ?? builtInAcpxAgent(id);
    const agentCommand = stringOrNull(definition.agentCommand);
    if (agent) {
      backend.agent = agent;
    }
    if (agentCommand) {
      backend.agentCommand = agentCommand;
    }
    if (!agent && !agentCommand) {
      return null;
    }
    const approval = approvalMode(stringOrNull(definition.approval));
    if (approval) {
      backend.approval = approval;
    }
    const format = stringOrNull(definition.format);
    if (format) {
      backend.format = format;
    }
    const env = stringRecordOrNull(definition.env);
    if (env) {
      backend.env = env;
    }
  }
  if (kind === "dsh-cli") {
    const profile = stringOrNull(definition.profile) ?? "headless";
    if (profile !== "headless") {
      return null;
    }
    backend.command = stringOrNull(definition.command) ?? "dsh";
    backend.profile = profile;
    const env = stringRecordOrNull(definition.env);
    if (env) {
      backend.env = env;
    }
  }
  return backend;
}

function builtInBackend(id: string, source: AgentBackendSource): ResolvedAgentBackend | null {
  if (id === "noop" || id === "codex-cli" || id === "codex-resumable") {
    return { id, kind: id, source };
  }
  if (id === "acpx-codex" || id === "codex") {
    return { id, kind: "acpx", agent: "codex", source };
  }
  if (id === "claude-code") {
    return { id, kind: "acpx", agent: "claude", source };
  }
  if (id === "dsh-cli") {
    return { id, kind: "dsh-cli", command: "dsh", profile: "headless", source };
  }
  const agent = acpxAgent(id);
  return agent ? { id, kind: "acpx", agent, source } : null;
}

function roleDefault(context: Record<string, unknown>, role: string) {
  const defaults = objectOrNull(context.agentDefaults) ?? {};
  return stringOrNull(objectOrNull(defaults.roles)?.[role]);
}

function runDefault(context: Record<string, unknown>) {
  const defaults = objectOrNull(context.agentDefaults) ?? {};
  return stringOrNull(defaults.global);
}

function acpxAgent(value: string | null): AcpxBuiltInAgent | null {
  return value === "codex" || value === "claude" ? value : null;
}

function builtInAcpxAgent(id: string): AcpxBuiltInAgent | null {
  if (id === "claude-code" || id === "claude") {
    return "claude";
  }
  if (id === "acpx-codex" || id === "codex") {
    return "codex";
  }
  return null;
}

function approvalMode(value: string | null): ApprovalMode | null {
  return value === "approve-all" || value === "approve-reads" || value === "deny-all" ? value : null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringRecordOrNull(value: unknown) {
  const record = objectOrNull(value);
  if (!record) {
    return null;
  }
  const entries = Object.entries(record).flatMap(([key, raw]) => {
    const value = stringOrNull(raw);
    return value ? [[key, value] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}
