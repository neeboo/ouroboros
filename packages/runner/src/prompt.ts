import { DEFAULT_TASK_PROMPT_TEMPLATE } from "@ouroboros/harness";
import type { PromptInput } from "./types";
import { prettyJson, renderPromptTemplate } from "./template";

export function buildTaskPrompt(input: PromptInput) {
  return renderPromptTemplate(input.template ?? DEFAULT_TASK_PROMPT_TEMPLATE, {
    runGoal: input.run.goal,
    runContextJson: prettyJson(input.run.context),
    taskId: input.task.id,
    taskRole: input.task.role,
    taskGoal: input.task.goal,
    taskPrompt: input.task.prompt,
    doneWhenMarkdown: input.task.doneWhen.map((item) => `- ${item}`).join("\n"),
    dependencyAttemptsJson: prettyJson(input.dependencyAttempts),
    runLessonsJson: prettyJson(
      (input.lessons ?? []).map((lesson) => ({
        kind: lesson.kind,
        summary: lesson.summary,
        taskId: lesson.taskId,
        attemptId: lesson.attemptId,
        evidence: lesson.evidence,
      })),
    ),
    requiredOutputJson: prettyJson({
      status: "done",
      summary: "Short completion summary",
      changedFiles: [],
      checks: [],
      artifacts: [],
      problems: [],
      nextTasks: [
        {
          role: "worker",
          goal: "Optional next task goal",
          prompt: "Optional next task instructions",
          dependsOn: [],
          doneWhen: [],
        },
      ],
    }),
  });
}
