import { describeIntegrationReadiness } from "@ouroboros/harness";
import type { Harness, Task } from "@ouroboros/harness";
import { buildTaskPrompt } from "./prompt";
import { resolveExecutionRoute } from "./execution-routing";
import type {
  RunNextReadyTaskInput,
  RunReadyTasksInput,
  RunUntilIdleInput,
  StartHook,
  StartHookResult,
  StopHook,
} from "./types";

export async function runNextReadyTask(input: RunNextReadyTaskInput) {
  const task = input.harness.nextReadyTask(input.runId);
  if (!task) {
    return null;
  }

  const run = input.harness.getRun(input.runId);
  if (!run) {
    throw new Error(`run not found: ${input.runId}`);
  }

  const prompt = buildTaskPrompt({
    run,
    task,
    dependencyAttempts: latestDependencyAttempts(input.harness, task),
    lessons: input.harness.listLessons({ runId: input.runId }),
    template: input.harness.getPromptTemplate("task")?.contentMd,
  });
  const sessionName = task.sessionRef ?? defaultSessionName(task.id);
  const route = resolveExecutionRoute({ run, task });
  const rawOutput = await input.executor({ prompt, run, task, sessionName, route });
  const { output, decision } = await applyStopHooks({
    hooks: hooksForTask(input.stopHooks, input.stopHooksByRole, task),
    run,
    task,
    sessionName,
    prompt,
    output: rawOutput,
  });
  const attemptId = input.harness.recordAttempt({
    taskId: task.id,
    input: { prompt, route, model: route.model },
    output,
  });
  applyPostAttemptRunEffects(input.harness, input.runId, task, output);
  if (decision === "retry") {
    input.harness.retryTask({ taskId: task.id });
  }

  return { taskId: task.id, attemptId, stopDecision: decision };
}

export async function runReadyTasks(input: RunReadyTasksInput) {
  const run = input.harness.getRun(input.runId);
  if (!run) {
    throw new Error(`run not found: ${input.runId}`);
  }

  input.harness.reclaimRunningTasksWithoutAttempts({ runId: input.runId });
  const tasks = input.harness.leaseReadyTasks({
    runId: input.runId,
    limit: input.limit,
    sessionForTask: input.sessionForTask ?? ((task) => defaultSessionName(task.id)),
    worktreeForTask: input.worktreeForTask,
  });

  return Promise.all(
    tasks.map(async (task) => {
      const sessionName = task.sessionRef ?? defaultSessionName(task.id);
      const cwd = task.worktreePath ?? input.cwd ?? process.cwd();
      const startResult = await applyStartHooks({
        hooks: input.startHooks ?? [],
        run,
        task,
        sessionName,
        cwd,
      });
      if ((startResult.problems ?? []).length > 0) {
        const attemptId = input.harness.recordAttempt({
          taskId: task.id,
          input: { sessionName, cwd, startHooks: true },
          output: {
            status: "blocked",
            summary: "start hooks blocked task execution",
            checks: startResult.checks ?? [],
            artifacts: startResult.artifacts ?? [],
            problems: startResult.problems ?? [],
          },
        });
        return { taskId: task.id, attemptId, sessionName, stopDecision: "exit" as const };
      }
      const prompt = buildTaskPrompt({
        run,
        task,
        dependencyAttempts: latestDependencyAttempts(input.harness, task),
        lessons: input.harness.listLessons({ runId: input.runId }),
        template: input.harness.getPromptTemplate("task")?.contentMd,
      });
      const route = resolveExecutionRoute({
        run,
        task,
        cliAgentBackend: input.cliAgentBackend,
        cliExecutor: input.cliExecutor,
        globalModel: input.model,
      });
      const factoryInput = { run, task, sessionName, cwd, route };
      const executor = input.executorFactory(factoryInput);
      const rawOutput = await executor({ prompt, run, task, sessionName, route });
      const { output, decision } = await applyStopHooks({
        hooks: hooksForTask(input.stopHooks, input.stopHooksByRole, task),
        run,
        task,
        sessionName,
        prompt,
        output: rawOutput,
      });
      output.checks = [...(startResult.checks ?? []), ...(output.checks ?? [])];
      output.artifacts = [...(startResult.artifacts ?? []), ...(output.artifacts ?? [])];
      const attemptId = input.harness.recordAttempt({
        taskId: task.id,
        input: { prompt, sessionName, route, model: route.model, ...(input.attemptInput?.(factoryInput) ?? {}) },
        output,
      });
      applyPostAttemptRunEffects(input.harness, input.runId, task, output);
      if (decision === "retry") {
        input.harness.retryTask({ taskId: task.id });
      }

      return { taskId: task.id, attemptId, sessionName, stopDecision: decision };
    }),
  );
}

export async function runUntilIdle(input: RunUntilIdleInput) {
  const rounds = [];
  for (let index = 0; index < input.maxRounds; index += 1) {
    const tasks = await runReadyTasks(input);
    if (tasks.length === 0) {
      break;
    }
    rounds.push({ index, tasks });
  }
  return { rounds };
}

export async function applyStartHooks(input: {
  hooks: StartHook[];
  run: Parameters<StartHook>[0]["run"];
  task: Parameters<StartHook>[0]["task"];
  sessionName: string;
  cwd: string;
}): Promise<StartHookResult> {
  const combined: StartHookResult = {
    checks: [],
    artifacts: [],
    problems: [],
  };
  for (const hook of input.hooks) {
    const result = await hook(input);
    combined.checks = [...(combined.checks ?? []), ...(result.checks ?? [])];
    combined.artifacts = [...(combined.artifacts ?? []), ...(result.artifacts ?? [])];
    combined.problems = [...(combined.problems ?? []), ...(result.problems ?? [])];
  }
  return combined;
}

function defaultSessionName(taskId: string) {
  return `task-${taskId}`;
}

function latestDependencyAttempts(harness: Pick<Harness, "listLatestAttemptsForTasks">, task: Pick<Task, "dependsOn">) {
  if (task.dependsOn.length === 0) {
    return [];
  }
  return harness.listLatestAttemptsForTasks(task.dependsOn);
}

function applyPostAttemptRunEffects(
  harness: Harness,
  runId: string,
  task: Pick<Task, "role">,
  output: { status: string; runDecision?: string },
) {
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "complete") {
    const readiness = describeIntegrationReadiness(harness, runId);
    if (readiness.unintegrated.length > 0) {
      harness.updateRun({
        runId,
        status: "blocked",
        contextPatch: {
          pendingIntegrationWorkerTaskIds: readiness.unintegrated.map((worker) => worker.taskId),
          pendingIntegrationReason: "verified worker changes are not integrated yet",
        },
      });
    } else {
      harness.updateRunStatus({ runId, status: "done" });
    }
  }
  if (task.role === "goal-review" && output.status === "done" && output.runDecision === "defer") {
    harness.updateRunStatus({ runId, status: "blocked" });
  }
}

function hooksForTask(globalHooks: StopHook[] | undefined, hooksByRole: Record<string, StopHook[]> | undefined, task: Task) {
  return [...(globalHooks ?? []), ...(hooksByRole?.[task.role] ?? [])];
}

async function applyStopHooks(input: {
  hooks: StopHook[];
  run: Parameters<StopHook>[0]["run"];
  task: Parameters<StopHook>[0]["task"];
  sessionName: string;
  prompt: string;
  output: Parameters<StopHook>[0]["output"];
}) {
  let output = {
    ...input.output,
    checks: [...(input.output.checks ?? [])],
    artifacts: [...(input.output.artifacts ?? [])],
    problems: [...(input.output.problems ?? [])],
  };
  let decision: "continue" | "retry" | "exit" = "exit";

  for (const hook of input.hooks) {
    const result = await hook({ ...input, output });
    if (result.checks) {
      output.checks = [...(output.checks ?? []), ...result.checks];
    }
    if (result.artifacts) {
      output.artifacts = [...(output.artifacts ?? []), ...result.artifacts];
    }
    if (result.outputPatch) {
      output = { ...output, ...result.outputPatch };
    }
    if (result.problems && result.problems.length > 0) {
      output.problems = [...(output.problems ?? []), ...result.problems];
      output.status = "blocked";
    }
    if (result.decision === "retry") {
      decision = "retry";
      output.status = "blocked";
    } else if (result.decision === "continue" && decision !== "retry") {
      decision = "continue";
    } else if (result.decision === "exit" && decision !== "retry") {
      decision = "exit";
    }
  }

  return { output, decision };
}
