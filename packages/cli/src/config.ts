import { readFile } from "node:fs/promises";

export interface OuroborosConfig {
  linear?: LinearConfig;
  modelDefaults?: ModelDefaultsConfig;
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
  reason?: string;
  provider?: string;
  profile?: string;
  base_url?: string;
  env_key?: string;
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
  };
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
    ...optionalStringField(record, "reason"),
    ...optionalStringField(record, "provider"),
    ...optionalStringField(record, "profile"),
    ...optionalStringField(record, "base_url"),
    ...optionalStringField(record, "env_key"),
  };
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
