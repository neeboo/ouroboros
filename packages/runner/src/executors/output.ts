import type { AttemptOutput, PlannedTask } from "@ouroboros/harness";

export function parseAttemptOutputOrBlocked(input: {
  raw: string;
  summary: string;
  checkName: string;
}): AttemptOutput {
  try {
    return parseAttemptOutput(input.raw);
  } catch (error) {
    return {
      status: "blocked",
      summary: input.summary,
      changedFiles: [],
      checks: [{ name: input.checkName, status: "failed" }],
      artifacts: [],
      problems: [`${error instanceof Error ? error.message : String(error)}\n\nOutput:\n${input.raw}`],
    };
  }
}

export function parseAttemptOutput(raw: string): AttemptOutput {
  const parsed = JSON.parse(extractJsonObject(raw));
  if (parsed.status !== "done" && parsed.status !== "blocked") {
    throw new Error("agent output status must be 'done' or 'blocked'");
  }
  return {
    status: parsed.status,
    runDecision: validateRunDecision(parsed.runDecision),
    summary: String(parsed.summary ?? ""),
    changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.map(String) : [],
    checks: Array.isArray(parsed.checks) ? parsed.checks : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    problems: Array.isArray(parsed.problems) ? parsed.problems.map(String) : [],
    nextTasks: validatePlannedTasks(parsed.nextTasks),
  };
}

function validateRunDecision(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (value !== "complete" && value !== "continue" && value !== "verify") {
    throw new Error("agent output runDecision must be 'complete', 'continue', or 'verify'");
  }
  return value;
}

export function validatePlannedTasks(nextTasks: unknown): PlannedTask[] {
  if (nextTasks === undefined) {
    return [];
  }
  if (!Array.isArray(nextTasks)) {
    throw new Error("planned task nextTasks must be an array");
  }

  return nextTasks.map((task, index) => validatePlannedTask(task, index));
}

function validatePlannedTask(task: unknown, index: number): PlannedTask {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error(`planned task ${index} must be an object`);
  }

  const record = task as Record<string, unknown>;
  return {
    role: requiredPlannedTaskString(record, "role", index),
    goal: requiredPlannedTaskString(record, "goal", index),
    prompt: requiredPlannedTaskString(record, "prompt", index),
    dependsOn: optionalStringArray(record, "dependsOn", index),
    doneWhen: optionalStringArray(record, "doneWhen", index),
    modelPreference: optionalModelPreference(record, index),
  };
}

function requiredPlannedTaskString(task: Record<string, unknown>, key: "role" | "goal" | "prompt", index: number) {
  const value = task[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`planned task ${index} must include a non-empty ${key}`);
  }
  return value;
}

function optionalStringArray(task: Record<string, unknown>, key: "dependsOn" | "doneWhen", index: number) {
  const value = task[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`planned task ${index} ${key} must be an array of strings`);
  }
  return value;
}

function optionalModelPreference(task: Record<string, unknown>, index: number) {
  const value = task.modelPreference;
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`planned task ${index} modelPreference must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model.trim().length === 0) {
    throw new Error(`planned task ${index} modelPreference must include a non-empty model`);
  }
  const preference: { model: string; reason?: string } = {
    model: record.model,
  };
  if (record.reason !== undefined) {
    if (typeof record.reason !== "string") {
      throw new Error(`planned task ${index} modelPreference reason must be a string`);
    }
    preference.reason = record.reason;
  }
  return preference;
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    return fenced[1];
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  throw new Error("agent output did not contain a JSON object");
}
