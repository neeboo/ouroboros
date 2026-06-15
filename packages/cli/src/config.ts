import { readFile } from "node:fs/promises";

export interface OuroborosConfig {
  linear?: LinearConfig;
}

export interface LinearConfig {
  apiUrl?: string;
  tokenEnv?: string;
  tokenFile?: string;
  projectUrl?: string;
  projectId?: string;
  teamKey?: string;
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
  };
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
