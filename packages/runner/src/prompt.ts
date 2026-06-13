import type { PromptInput } from "./types";

export function buildTaskPrompt(input: PromptInput) {
  return [
    "# Ouroboros Task",
    "",
    `Run Goal: ${input.run.goal}`,
    "",
    "## Run Context",
    fencedJson(input.run.context),
    "",
    "## Task",
    `Task ID: ${input.task.id}`,
    `Role: ${input.task.role}`,
    `Goal: ${input.task.goal}`,
    "",
    "## Instructions",
    input.task.prompt,
    "",
    "## Done When",
    ...input.task.doneWhen.map((item) => `- ${item}`),
    "",
    "## Dependency Attempts",
    fencedJson(input.dependencyAttempts),
    "",
    "## Run Lessons",
    fencedJson(
      (input.lessons ?? []).map((lesson) => ({
        kind: lesson.kind,
        summary: lesson.summary,
        taskId: lesson.taskId,
        attemptId: lesson.attemptId,
        evidence: lesson.evidence,
      })),
    ),
    "",
    "## Required Output",
    "Return only JSON with this shape:",
    fencedJson({
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
  ].join("\n");
}

function fencedJson(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
