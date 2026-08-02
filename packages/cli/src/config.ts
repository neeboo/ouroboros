import { readFile } from "node:fs/promises";

export interface OuroborosConfig {
  linear?: LinearConfig;
  modelDefaults?: ModelDefaultsConfig;
  agentDefaults?: AgentDefaultsConfig;
  agentBackends?: Record<string, AgentBackendConfig>;
  integrationBoundary?: IntegrationBoundaryConfig;
}

export interface IntegrationBoundaryConfig {
  targetBranch?: string;
  push?: boolean;
  allowedFiles?: string[];
  forbiddenPaths?: string[];
}

export interface LinearConfig {
  apiUrl?: string;
  tokenEnv?: string;
  tokenFile?: string;
  projectUrl?: string;
  projectId?: string;
  teamKey?: string;
}

export interface ModelDefaultsConfig {
  global?: ModelPreferenceConfig;
  roles?: Record<string, ModelPreferenceConfig>;
}

export interface ModelPreferenceConfig {
  model: string;
  reasoning_effort?: string;
  reason?: string;
  provider?: string;
  profile?: string;
  base_url?: string;
  env_key?: string;
}

export interface AgentDefaultsConfig {
  global?: string;
  roles?: Record<string, string>;
}

export interface AgentBackendConfig {
  kind: string;
  agent?: string;
  agentCommand?: string;
  approval?: string;
  format?: string;
  env?: Record<string, string>;
}

export async function loadOuroborosConfig(path: string) {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
    return normalizeConfig(parsed);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function normalizeConfig(input: Record<string, unknown>): OuroborosConfig {
  const linear = objectValue(input.linear);
  const modelDefaults = modelDefaultsValue(input.models);
  const agentDefaults = agentDefaultsValue(input.agentDefaults);
  const agentBackends = agentBackendsValue(input.agentBackends);
  const integrationBoundary = integrationBoundaryValue(input.integrationBoundary);
  return {
    linear: linear
      ? {
          apiUrl: stringValue(linear.api_url),
          tokenEnv: stringValue(linear.token_env),
          tokenFile: stringValue(linear.token_file),
          projectUrl: stringValue(linear.project_url),
          projectId: stringValue(linear.project_id),
          teamKey: stringValue(linear.team_key),
        }
      : undefined,
    modelDefaults,
    agentDefaults,
    agentBackends,
    integrationBoundary,
  };
}

function integrationBoundaryValue(value: unknown): IntegrationBoundaryConfig | undefined {
  const record = objectValue(value);
  if (!record) {
    return undefined;
  }
  const targetBranch = stringValue(record.targetBranch) ?? stringValue(record.target_branch);
  const pushValue = record.push;
  const allowedFiles = stringArrayValue(record.allowedFiles) ?? stringArrayValue(record.allowed_files);
  const forbiddenPaths = stringArrayValue(record.forbiddenPaths) ?? stringArrayValue(record.forbidden_paths);
  const hasAny =
    targetBranch !== undefined ||
    pushValue !== undefined ||
    allowedFiles !== undefined ||
    forbiddenPaths !== undefined;
  if (!hasAny) {
    return undefined;
  }
  return {
    ...(targetBranch !== undefined ? { targetBranch } : {}),
    ...(pushValue !== undefined ? { push: Boolean(pushValue) } : {}),
    ...(allowedFiles !== undefined ? { allowedFiles } : {}),
    ...(forbiddenPaths !== undefined ? { forbiddenPaths } : {}),
  };
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function modelDefaultsValue(value: unknown): ModelDefaultsConfig | undefined {
  const models = objectValue(value);
  if (!models) {
    return undefined;
  }
  const global = modelPreferenceValue(models.global) ?? modelPreferenceValue(models.default) ?? modelPreferenceValue(models);
  const roles = roleModelDefaultsValue(models.roles);
  if (!global && !roles) {
    return undefined;
  }
  return {
    ...(global ? { global } : {}),
    ...(roles ? { roles } : {}),
  };
}

function roleModelDefaultsValue(value: unknown) {
  const roles = objectValue(value);
  if (!roles) {
    return undefined;
  }
  const entries = Object.entries(roles).flatMap(([role, preference]) => {
    const normalized = modelPreferenceValue(preference);
    return normalized ? [[role, normalized] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function modelPreferenceValue(value: unknown): ModelPreferenceConfig | undefined {
  if (typeof value === "string") {
    const model = stringValue(value);
    return model ? { model } : undefined;
  }
  const record = objectValue(value);
  if (!record) {
    return undefined;
  }
  const model = stringValue(record.model);
  if (!model) {
    return undefined;
  }
  return {
    model,
    ...optionalStringField(record, "reasoning_effort"),
    ...optionalStringField(record, "reason"),
    ...optionalStringField(record, "provider"),
    ...optionalStringField(record, "profile"),
    ...optionalStringField(record, "base_url"),
    ...optionalStringField(record, "env_key"),
  };
}

function agentDefaultsValue(value: unknown): AgentDefaultsConfig | undefined {
  const defaults = objectValue(value);
  const global = stringValue(defaults?.global) ?? stringValue(defaults?.default);
  const roles = stringRecordValue(defaults?.roles);
  if (!global && !roles) {
    return undefined;
  }
  return {
    ...(global ? { global } : {}),
    ...(roles ? { roles } : {}),
  };
}

function agentBackendsValue(value: unknown): Record<string, AgentBackendConfig> | undefined {
  const backends = objectValue(value);
  if (!backends) {
    return undefined;
  }
  const entries = Object.entries(backends).flatMap(([id, backend]) => {
    const normalized = agentBackendValue(backend);
    return normalized ? [[id, normalized] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function agentBackendValue(value: unknown): AgentBackendConfig | undefined {
  const record = objectValue(value);
  if (!record) {
    return undefined;
  }
  const kind = stringValue(record.kind);
  if (!kind) {
    return undefined;
  }
  return {
    kind,
    ...optionalStringField(record, "agent"),
    ...optionalStringField(record, "agentCommand"),
    ...optionalStringField(record, "approval"),
    ...optionalStringField(record, "format"),
    ...optionalStringRecordField(record, "env"),
  };
}

function stringRecordValue(value: unknown) {
  const record = objectValue(value);
  if (!record) {
    return undefined;
  }
  const entries = Object.entries(record).flatMap(([key, raw]) => {
    const value = stringValue(raw);
    return value ? [[key, value] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringField(record: Record<string, unknown>, key: string) {
  const value = stringValue(record[key]);
  return value ? { [key]: value } : {};
}

function optionalStringRecordField(record: Record<string, unknown>, key: string) {
  const value = stringRecordValue(record[key]);
  return value ? { [key]: value } : {};
}
