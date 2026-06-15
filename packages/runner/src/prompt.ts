import { DEFAULT_TASK_PROMPT_TEMPLATE } from "@ouroboros/harness";
import type { Lesson } from "@ouroboros/harness";
import type { PromptInput } from "./types";
import { prettyJson, renderPromptTemplate } from "./template";

const MAX_PROMPT_LESSONS = 12;
const MAX_LESSON_SUMMARY_CHARS = 320;

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
    runLessonsJson: prettyJson(compactLessons(input.lessons ?? [])),
    requiredOutputJson: prettyJson({
      status: "done",
      summary: "Short completion summary",
      changedFiles: [],
      checks: [],
      artifacts: [],
      problems: [],
      actions: [
        {
          type: "createTasks",
          payload: {
            tasks: [
              {
                role: "worker",
                goal: "Optional next task goal",
                prompt: "Optional next task instructions",
                dependsOn: [],
                doneWhen: [],
              },
            ],
          },
        },
      ],
    }),
  });
}

function compactLessons(lessons: Lesson[]) {
  return lessons.slice(-MAX_PROMPT_LESSONS).map((lesson) => ({
    kind: lesson.kind,
    summary: compactText(lesson.summary, MAX_LESSON_SUMMARY_CHARS),
    taskId: lesson.taskId,
    attemptId: lesson.attemptId,
  }));
}

function compactText(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}
