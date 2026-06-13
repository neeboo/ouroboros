import { buildTaskPrompt } from "./prompt";
import type { RunNextReadyTaskInput } from "./types";

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
  const output = await input.executor({ prompt, run, task });
  const attemptId = input.harness.recordAttempt({
    taskId: task.id,
    input: { prompt },
    output,
  });

  return { taskId: task.id, attemptId };
}
