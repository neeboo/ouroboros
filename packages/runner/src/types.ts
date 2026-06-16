import type { AttemptOutput, Harness, Lesson, Run, Task } from "@ouroboros/harness";
import type { ResolvedExecutionRoute } from "./execution-routing";
import type { ResolvedModelPreference } from "./model-preferences";

export interface PromptInput {
  run: Run;
  task: Task;
  dependencyAttempts: unknown[];
  lessons?: Lesson[];
  template?: string;
}

export interface ExecutorInput {
  prompt: string;
  run: Run;
  task: Task;
  sessionName: string;
  route?: ResolvedExecutionRoute;
  resolvedModel?: ResolvedModelPreference | null;
}

export type TaskExecutor = (input: ExecutorInput) => Promise<AttemptOutput>;

export interface RunNextReadyTaskInput {
  harness: Harness;
  runId: string;
  executor: TaskExecutor;
  stopHooks?: StopHook[];
  stopHooksByRole?: StopHooksByRole;
}

export interface RunNextReadyTaskResult {
  taskId: string;
  attemptId: string;
  stopDecision: StopDecision;
}

export interface ExecutorFactoryInput {
  run: Run;
  task: Task;
  sessionName: string;
  cwd: string;
  route: ResolvedExecutionRoute;
  resolvedModel: ResolvedModelPreference | null;
}

export type TaskExecutorFactory = (input: ExecutorFactoryInput) => TaskExecutor;

export type AttemptInputFactory = (input: ExecutorFactoryInput) => Record<string, unknown>;

export interface RunReadyTasksInput {
  harness: Harness;
  runId: string;
  limit: number;
  cwd?: string;
  sessionForTask?: (task: Task) => string;
  worktreeForTask?: (task: Task) => string | null;
  executorFactory: TaskExecutorFactory;
  attemptInput?: AttemptInputFactory;
  model?: string | null;
  cliAgentBackend?: string | null;
  cliExecutor?: string | null;
  startHooks?: StartHook[];
  stopHooks?: StopHook[];
  stopHooksByRole?: StopHooksByRole;
}

export interface RunReadyTasksResult {
  taskId: string;
  attemptId: string;
  sessionName: string;
  stopDecision: StopDecision;
}

export interface RunUntilIdleInput extends RunReadyTasksInput {
  maxRounds: number;
}

export interface RunUntilIdleResult {
  rounds: Array<{
    index: number;
    tasks: RunReadyTasksResult[];
  }>;
}

export type StopDecision = "continue" | "retry" | "exit";

export interface StartHookInput {
  run: Run;
  task: Task;
  sessionName: string;
  cwd: string;
}

export interface StartHookResult {
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: string[];
}

export type StartHook = (input: StartHookInput) => Promise<StartHookResult> | StartHookResult;

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
  outputPatch?: StopHookOutputPatch;
}

export type StopHook = (input: StopHookInput) => Promise<StopHookResult> | StopHookResult;

export type StopHooksByRole = Record<string, StopHook[]>;

export type StopHookOutputPatch = Partial<
  Pick<AttemptOutput, "summary" | "changedFiles" | "problems" | "nextTasks" | "runDecision">
>;

export interface ContextSubagentEntry {
  summary: string;
  evidence?: Record<string, unknown>;
}

export interface ContextSubagentOutput {
  experience: ContextSubagentEntry;
  lesson: ContextSubagentEntry;
}

export type ContextSubagent = (input: StopHookInput) => Promise<ContextSubagentOutput> | ContextSubagentOutput;
