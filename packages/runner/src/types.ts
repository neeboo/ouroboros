import type { AttemptOutput, Harness, Run, Task } from "@ouroboros/harness";

export interface PromptInput {
  run: Run;
  task: Task;
  dependencyAttempts: unknown[];
}

export interface ExecutorInput {
  prompt: string;
  run: Run;
  task: Task;
  sessionName: string;
}

export type TaskExecutor = (input: ExecutorInput) => Promise<AttemptOutput>;

export interface RunNextReadyTaskInput {
  harness: Harness;
  runId: string;
  executor: TaskExecutor;
  stopHooks?: StopHook[];
}

export interface RunNextReadyTaskResult {
  taskId: string;
  attemptId: string;
}

export interface ExecutorFactoryInput {
  run: Run;
  task: Task;
  sessionName: string;
}

export type TaskExecutorFactory = (input: ExecutorFactoryInput) => TaskExecutor;

export interface RunReadyTasksInput {
  harness: Harness;
  runId: string;
  limit: number;
  sessionForTask?: (task: Task) => string;
  executorFactory: TaskExecutorFactory;
  stopHooks?: StopHook[];
}

export interface RunReadyTasksResult {
  taskId: string;
  attemptId: string;
  sessionName: string;
}

export type StopDecision = "continue" | "retry" | "exit";

export interface StopHookInput {
  run: Run;
  task: Task;
  sessionName: string;
  prompt: string;
  output: AttemptOutput;
}

export interface StopHookResult {
  decision?: StopDecision;
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: string[];
}

export type StopHook = (input: StopHookInput) => Promise<StopHookResult> | StopHookResult;
