import type { ModelPreference, Run, Task } from "@ouroboros/harness";

export type ResolvedModelPreferenceSource = "task" | "role-default" | "run-default" | "global";

export interface ResolvedModelPreference extends ModelPreference {
  source: ResolvedModelPreferenceSource;
  role: string;
}

export function resolveModelPreference(input: {
  run: Run;
  task: Task;
  globalModel?: string | null;
}): ResolvedModelPreference | null {
  const taskPreference = normalizeModelPreference(input.task.config?.modelPreference);
  if (taskPreference) {
    return { ...taskPreference, source: "task", role: input.task.role };
  }

  const defaults = modelDefaults(input.run.context);
  const rolePreference = normalizeModelPreference(defaults.roles?.[input.task.role]);
  if (rolePreference) {
    return { ...rolePreference, source: "role-default", role: input.task.role };
  }

  const runPreference = normalizeModelPreference(defaults.global);
  if (runPreference) {
    return { ...runPreference, source: "run-default", role: input.task.role };
  }

  const globalModel = stringOrNull(input.globalModel);
  return globalModel ? { model: globalModel, source: "global", role: input.task.role } : null;
}

function modelDefaults(context: Record<string, unknown>): {
  global?: unknown;
  roles?: Record<string, unknown>;
} {
  const candidate = objectOrNull(context.modelDefaults) ?? objectOrNull(context.models) ?? {};
  return {
    global: candidate.global ?? candidate.default ?? candidate.model,
    roles: objectOrNull(candidate.roles) ?? objectOrNull(candidate.roleDefaults) ?? {},
  };
}

function normalizeModelPreference(value: unknown): ModelPreference | null {
  if (typeof value === "string") {
    const model = stringOrNull(value);
    return model ? { model } : null;
  }
  const record = objectOrNull(value);
  if (!record) {
    return null;
  }
  const model = stringOrNull(record.model);
  if (!model) {
    return null;
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

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalStringField(record: Record<string, unknown>, key: string) {
  const value = stringOrNull(record[key]);
  return value ? { [key]: value } : {};
}
