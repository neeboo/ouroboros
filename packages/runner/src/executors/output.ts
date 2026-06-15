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
  const actionOutput = validateActions(parsed.actions);
  return {
    status: parsed.status,
    runDecision: mergeRunDecision(validateRunDecision(parsed.runDecision), actionOutput.runDecision),
    summary: String(parsed.summary ?? ""),
    changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.map(String) : [],
    checks: Array.isArray(parsed.checks) ? parsed.checks : [],
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    problems: Array.isArray(parsed.problems) ? parsed.problems.map(String) : [],
    nextTasks: [...validatePlannedTasks(parsed.nextTasks), ...actionOutput.nextTasks],
    nextRuns: [...validatePlannedRuns(parsed.nextRuns), ...actionOutput.nextRuns],
  };
}

function validateActions(actions: unknown): {
  runDecision?: AttemptOutput["runDecision"];
  nextTasks: PlannedTask[];
  nextRuns: PlannedRun[];
} {
  if (actions === undefined) {
    return { nextTasks: [], nextRuns: [] };
  }
  if (!Array.isArray(actions)) {
    throw new Error("agent output actions must be an array");
  }

  const output: {
    runDecision?: AttemptOutput["runDecision"];
    nextTasks: PlannedTask[];
    nextRuns: PlannedRun[];
  } = { nextTasks: [], nextRuns: [] };

  actions.forEach((action, index) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(`agent output action ${index} must be an object`);
    }
    const record = action as Record<string, unknown>;
    const type = normalizeActionType(record.type);
    const payload = requiredActionPayload(record.payload, index);

    if (type === "createTasks") {
      output.nextTasks.push(...validatePlannedTasks(requiredPayloadArray(payload, "tasks", index, type)));
      return;
    }
    if (type === "createRuns") {
      output.nextRuns.push(...validatePlannedRuns(requiredPayloadArray(payload, "runs", index, type)));
      return;
    }

    const decision = validateRunDecision(payload.decision);
    if (output.runDecision !== undefined && output.runDecision !== decision) {
      throw new Error("agent output actions contain conflicting run decisions");
    }
    output.runDecision = decision;
  });

  return output;
}

function normalizeActionType(type: unknown): "createTasks" | "createRuns" | "setRunDecision" {
  if (type === "createTasks" || type === "create_tasks") {
    return "createTasks";
  }
  if (type === "createRuns" || type === "create_runs") {
    return "createRuns";
  }
  if (type === "setRunDecision" || type === "set_run_decision" || type === "runDecision" || type === "run_decision") {
    return "setRunDecision";
  }
  throw new Error("agent output action type must be createTasks, createRuns, or setRunDecision");
}

function requiredActionPayload(payload: unknown, index: number) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`agent output action ${index} payload must be an object`);
  }
  return payload as Record<string, unknown>;
}

function requiredPayloadArray(
  payload: Record<string, unknown>,
  key: "tasks" | "runs",
  index: number,
  type: "createTasks" | "createRuns",
) {
  const value = payload[key];
  if (!Array.isArray(value)) {
    throw new Error(`agent output action ${index} ${type} payload.${key} must be an array`);
  }
  return value;
}

function mergeRunDecision(
  direct: AttemptOutput["runDecision"] | undefined,
  fromActions: AttemptOutput["runDecision"] | undefined,
) {
  if (direct !== undefined && fromActions !== undefined && direct !== fromActions) {
    throw new Error("agent output runDecision conflicts with actions run decision");
  }
  return direct ?? fromActions;
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
    verifierContract: optionalVerifierContract(record, index),
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

function optionalVerifierContract(task: Record<string, unknown>, index: number) {
  const value = task.verifierContract;
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`planned task ${index} verifierContract must be an object`);
  }

  const contract = value as Record<string, unknown>;
  requireContractArray(contract, "successCriteria", index);
  requireContractArray(contract, "deterministicChecks", index);
  requireContractArray(contract, "agentReviewRubric", index);
  return contract;
}

function requireContractArray(contract: Record<string, unknown>, key: string, index: number) {
  if (!Array.isArray(contract[key])) {
    throw new Error(`planned task ${index} verifierContract.${key} must be an array`);
  }
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
    return undefined;
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
