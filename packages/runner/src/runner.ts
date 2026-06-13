import { buildTaskPrompt } from "./prompt";
import type { RunNextReadyTaskInput, RunReadyTasksInput, StopHook } from "./types";

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
    dependencyAttempts: [],
  });
  const sessionName = task.sessionRef ?? defaultSessionName(task.id);
  const rawOutput = await input.executor({ prompt, run, task, sessionName });
  const { output, decision } = await applyStopHooks({
    hooks: input.stopHooks ?? [],
    run,
    task,
    sessionName,
    prompt,
    output: rawOutput,
  });
  const attemptId = input.harness.recordAttempt({
    taskId: task.id,
    input: { prompt },
    output,
  });
  if (decision === "retry") {
    input.harness.retryTask({ taskId: task.id });
  }

  return { taskId: task.id, attemptId };
}

export async function runReadyTasks(input: RunReadyTasksInput) {
  const run = input.harness.getRun(input.runId);
  if (!run) {
    throw new Error(`run not found: ${input.runId}`);
  }

  const tasks = input.harness.leaseReadyTasks({
    runId: input.runId,
    limit: input.limit,
    sessionForTask: input.sessionForTask ?? ((task) => defaultSessionName(task.id)),
  });

  return Promise.all(
    tasks.map(async (task) => {
      const sessionName = task.sessionRef ?? defaultSessionName(task.id);
      const prompt = buildTaskPrompt({
        run,
        task,
        dependencyAttempts: [],
      });
      const executor = input.executorFactory({ run, task, sessionName });
      const rawOutput = await executor({ prompt, run, task, sessionName });
      const { output, decision } = await applyStopHooks({
        hooks: input.stopHooks ?? [],
        run,
        task,
        sessionName,
        prompt,
        output: rawOutput,
      });
      const attemptId = input.harness.recordAttempt({
        taskId: task.id,
        input: { prompt, sessionName },
        output,
      });
      if (decision === "retry") {
        input.harness.retryTask({ taskId: task.id });
      }

      return { taskId: task.id, attemptId, sessionName };
    }),
  );
}

function defaultSessionName(taskId: string) {
  return `task-${taskId}`;
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
