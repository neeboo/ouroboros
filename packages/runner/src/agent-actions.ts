import type { AttemptOutput, PlannedRun, PlannedTask } from "@ouroboros/harness";

export type AgentAction = CreateTasksAction | CreateRunsAction | SetRunDecisionAction;

export interface CreateTasksAction {
  type: "createTasks";
  payload: {
    tasks: PlannedTask[];
  };
}

export interface CreateRunsAction {
  type: "createRuns";
  payload: {
    runs: PlannedRun[];
  };
}

export interface SetRunDecisionAction {
  type: "setRunDecision";
  payload: {
    decision: NonNullable<AttemptOutput["runDecision"]>;
  };
}

export interface AgentOutputInput {
  summary: string;
  changedFiles?: string[];
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: string[];
  actions?: AgentAction[];
}

export type AgentOutput = Omit<AttemptOutput, "nextTasks" | "nextRuns" | "runDecision"> & {
  actions?: AgentAction[];
};

export function createTasksAction(tasks: PlannedTask[]): CreateTasksAction {
  requireArray(tasks, "createTasksAction tasks");
  return { type: "createTasks", payload: { tasks } };
}

export function createRunsAction(runs: PlannedRun[]): CreateRunsAction {
  requireArray(runs, "createRunsAction runs");
  return { type: "createRuns", payload: { runs } };
}

export function setRunDecisionAction(decision: NonNullable<AttemptOutput["runDecision"]>): SetRunDecisionAction {
  if (decision !== "complete" && decision !== "continue" && decision !== "verify") {
    throw new Error("setRunDecisionAction decision must be complete, continue, or verify");
  }
  return { type: "setRunDecision", payload: { decision } };
}

export function doneOutput(input: AgentOutputInput): AgentOutput {
  return agentOutput("done", input);
}

export function blockedOutput(input: AgentOutputInput): AgentOutput {
  return agentOutput("blocked", input);
}

function agentOutput(status: AttemptOutput["status"], input: AgentOutputInput): AgentOutput {
  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    throw new Error("agent output summary must be a non-empty string");
  }
  if (input.actions !== undefined) {
    requireArray(input.actions, "agent output actions");
  }
  return {
    status,
    summary: input.summary,
    changedFiles: input.changedFiles ?? [],
    checks: input.checks ?? [],
    artifacts: input.artifacts ?? [],
    problems: input.problems ?? [],
    actions: input.actions,
  };
}

function requireArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}
