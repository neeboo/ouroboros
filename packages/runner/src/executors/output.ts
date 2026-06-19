import { readableList, readableValue } from "@ouroboros/harness";
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
  const candidates = extractJsonObjectCandidates(raw);
  const errors: Error[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[index]);
    } catch {
      continue;
    }
    if (!looksLikeAttemptOutput(parsed)) {
      continue;
    }
    try {
      return normalizeAttemptOutput(parsed);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (errors.length > 0) {
    throw errors[0];
  }
  throw new Error(candidates.length > 0 ? "agent output did not contain an attempt output JSON object" : "agent output did not contain a JSON object");
}

function normalizeAttemptOutput(parsed: unknown): AttemptOutput {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("agent output must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.status !== "done" && record.status !== "blocked") {
    throw new Error("agent output status must be 'done' or 'blocked'");
  }
  const actionOutput = validateActions(record.actions);
  return {
    status: record.status,
    runDecision: mergeRunDecision(validateRunDecision(record.runDecision), actionOutput.runDecision),
    summary: readableValue(record.summary),
    changedFiles: Array.isArray(record.changedFiles) ? record.changedFiles.map(String) : [],
    checks: Array.isArray(record.checks) ? record.checks : [],
    artifacts: Array.isArray(record.artifacts) ? record.artifacts : [],
    problems: readableList(record.problems),
    nextTasks: [...validatePlannedTasks(record.nextTasks), ...actionOutput.nextTasks],
    nextRuns: [...validatePlannedRuns(record.nextRuns), ...actionOutput.nextRuns],
  };
}

function looksLikeAttemptOutput(parsed: unknown) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  if (record.status !== "done" && record.status !== "blocked") {
    return false;
  }
  return (
    "summary" in record ||
    "changedFiles" in record ||
    "checks" in record ||
    "artifacts" in record ||
    "problems" in record ||
    "actions" in record ||
    "nextTasks" in record ||
    "nextRuns" in record ||
    "runDecision" in record
  );
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
  if (value === "done") {
    return "complete";
  }
  if (value !== "complete" && value !== "continue" && value !== "verify" && value !== "defer") {
    throw new Error("agent output runDecision must be 'complete', 'continue', 'verify', or 'defer'");
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

function extractJsonObjectCandidates(raw: string) {
  const trimmed = raw.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    candidates.push(trimmed);
  }

  for (const fenced of trimmed.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)) {
    candidates.push(fenced[1]);
  }

  candidates.push(...jsonObjectCandidates(trimmed));
  return [...new Set(candidates)];
}

function jsonObjectCandidates(raw: string) {
  const candidates: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "{") {
      continue;
    }
    const candidate = balancedJsonObjectFrom(raw, index);
    if (candidate) {
      candidates.push(candidate);
      index += candidate.length - 1;
    }
  }
  return candidates;
}

function balancedJsonObjectFrom(raw: string, start: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
}
