import type { AttemptOutput, PlannedRun, PlannedTask } from "@ouroboros/harness";

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
    nextRuns: validatePlannedRuns(parsed.nextRuns),
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

export function validatePlannedRuns(nextRuns: unknown): PlannedRun[] {
  if (nextRuns === undefined) {
    return [];
  }
  if (!Array.isArray(nextRuns)) {
    throw new Error("planned run nextRuns must be an array");
  }

  return nextRuns.map((run, index) => validatePlannedRun(run, index));
}

function validatePlannedRun(run: unknown, index: number): PlannedRun {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new Error(`planned run ${index} must be an object`);
  }

  const record = run as Record<string, unknown>;
  const plannedRun: PlannedRun = {
    goal: requiredPlannedRunString(record, "goal", index),
    prompt: requiredPlannedRunString(record, "prompt", index),
    doneWhen: optionalRunStringArray(record, "doneWhen", index),
    context: optionalRunContext(record, index),
    modelPreference: optionalModelPreference(record, index, "planned run"),
  };
  return plannedRun;
}

function requiredPlannedRunString(run: Record<string, unknown>, key: "goal" | "prompt", index: number) {
  const value = run[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`planned run ${index} must include a non-empty ${key}`);
  }
  return value;
}

function optionalRunStringArray(run: Record<string, unknown>, key: "doneWhen", index: number) {
  const value = run[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`planned run ${index} ${key} must be an array of strings`);
  }
  return value;
}

function optionalRunContext(run: Record<string, unknown>, index: number) {
  const value = run.context;
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`planned run ${index} context must be an object`);
  }
  return value as Record<string, unknown>;
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
    modelPreference: optionalModelPreference(record, index, "planned task"),
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

function optionalModelPreference(record: Record<string, unknown>, index: number, label: "planned task" | "planned run") {
  const value = record.modelPreference;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    const model = value.trim();
    if (!looksLikeModelId(model)) {
      return undefined;
    }
    return { model };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} ${index} modelPreference must be an object`);
  }
  const preferenceRecord = value as Record<string, unknown>;
  if (typeof preferenceRecord.model !== "string" || preferenceRecord.model.trim().length === 0) {
    throw new Error(`${label} ${index} modelPreference must include a non-empty model`);
  }
  const preference: { model: string; reason?: string } = {
    model: preferenceRecord.model,
  };
  if (preferenceRecord.reason !== undefined) {
    if (typeof preferenceRecord.reason !== "string") {
      throw new Error(`${label} ${index} modelPreference reason must be a string`);
    }
    preference.reason = preferenceRecord.reason;
  }
  return preference;
}

function looksLikeModelId(value: string) {
  return /^(gpt-|o\d|claude|gemini|deepseek|codex)/i.test(value);
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
