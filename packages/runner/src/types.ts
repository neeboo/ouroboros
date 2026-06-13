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
}

export type TaskExecutor = (input: ExecutorInput) => Promise<AttemptOutput>;

export interface RunNextReadyTaskInput {
  harness: Harness;
  runId: string;
  executor: TaskExecutor;
}

export interface RunNextReadyTaskResult {
  taskId: string;
  attemptId: string;
}
