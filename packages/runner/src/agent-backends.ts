import type { Run, Task } from "@ouroboros/harness";
import type { AcpxBuiltInAgent, ApprovalMode } from "./executors/types";

export type AgentBackendKind = "acpx" | "codex-cli" | "codex-resumable" | "noop";
export type AgentBackendSource = "task" | "role-default" | "run-default" | "cli-agent-backend" | "cli-executor";

export interface ResolvedAgentBackend {
  id: string;
  kind: AgentBackendKind;
  source: AgentBackendSource;
  agent?: AcpxBuiltInAgent;
  agentCommand?: string;
  approval?: ApprovalMode;
  format?: string;
}

export function resolveAgentBackend(input: {
  run: Run;
  task: Task;
  cliAgentBackend?: string | null;
  cliExecutor?: string | null;
}): ResolvedAgentBackend {
  const candidates: Array<{ id: string | null; source: AgentBackendSource }> = [
    { id: stringOrNull(input.task.config?.agentBackend), source: "task" },
    { id: roleDefault(input.run.context, input.task.role), source: "role-default" },
    { id: runDefault(input.run.context), source: "run-default" },
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
  if (kind !== "acpx" && kind !== "codex-cli" && kind !== "codex-resumable" && kind !== "noop") {
    return null;
  }
  const backend: ResolvedAgentBackend = { id, kind, source };
  if (kind === "acpx") {
    const agent = acpxAgent(stringOrNull(definition.agent));
    const agentCommand = stringOrNull(definition.agentCommand);
    if (agent) {
      backend.agent = agent;
    } else if (agentCommand) {
      backend.agentCommand = agentCommand;
    } else {
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
  return value === "codex" || value === "claude" || value === "opencode" || value === "openclaw" ? value : null;
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
