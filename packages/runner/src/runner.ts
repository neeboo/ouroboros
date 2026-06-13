import { buildTaskPrompt } from "./prompt";
import type { RunNextReadyTaskInput, RunReadyTasksInput } from "./types";

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
  const output = await input.executor({ prompt, run, task, sessionName });
  const attemptId = input.harness.recordAttempt({
    taskId: task.id,
    input: { prompt },
    output,
  });

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
      const output = await executor({ prompt, run, task, sessionName });
      const attemptId = input.harness.recordAttempt({
        taskId: task.id,
        input: { prompt, sessionName },
        output,
      });

      return { taskId: task.id, attemptId, sessionName };
    }),
  );
}

function defaultSessionName(taskId: string) {
  return `task-${taskId}`;
}
